import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyKiroReconciliation, planKiroReconciliation, type KiroReconcileDeps } from "../src/kiro-reconcile.js";
import { FleetManager } from "../src/fleet-manager.js";
import { ReconcileKiroInstanceArgs } from "../src/outbound-schemas.js";
import { TOOL_PROFILES } from "../src/tool-permissions.js";
import { LogService } from "../src/log-service.js";
import { getLocale, setLocale, t } from "../src/locale.js";
import type { FleetConfig } from "../src/types.js";

const roots: string[] = [];
const originalLocale = getLocale();
afterEach(() => { setLocale(originalLocale); vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const receipt = "a".repeat(64);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "reconcile-workflow-")); roots.push(root);
  vi.stubEnv("AGEND_HOME", root); vi.stubEnv("KIRO_HOME", join(root, "kiro")); vi.stubEnv("XDG_DATA_HOME", join(root, "xdg"));
  const fleet = { defaults: { backend: "kiro-cli" }, instances: {
    wiki: { backend: "kiro-cli", kiro_ui: "tui", working_directory: join(root, "work"), model: "claude-sonnet-4.6" }, general: { topic_id: "7" },
  } } as unknown as FleetConfig;
  let current = true, status = "stopped";
  const d: KiroReconcileDeps = {
    agendHome: root, fleetConfig: () => fleet, saveFleetConfig: vi.fn(), status: () => status,
    reserve: vi.fn(() => ({ current: () => current, release: vi.fn() })),
    preflight: vi.fn(async () => "claude-sonnet-4.6"),
    store: vi.fn(async (_input, plan, _actor, rollback) => plan ? { receipt } : { plan: { digest: "b".repeat(64), ...(rollback ? { rollbackReceipt: rollback } : {}) } }),
    restart: vi.fn(async () => { status = "running"; }), verify: vi.fn(async () => ({ forensic: "clean" })),
    stop: vi.fn(async () => { status = "stopped"; }), readClassicStore: vi.fn(async () => ({ kind: "unreadable" as const, detail: "unused" })),
  };
  return { d, fleet, supersede: () => { current = false; }, setStatus: (s: string) => { status = s; } };
}
const plan = (x: ReturnType<typeof fixture>, rollback?: string) => planKiroReconciliation(x.d, "wiki", "original", "newer", rollback);

describe("confirmed reconciliation workflow with inert lifecycle", () => {
  it("plans read-only; confirms storage and two same-id/model plain-start verifications", async () => {
    const x = fixture(), p = await plan(x); expect(x.d.reserve).not.toHaveBeenCalled(); expect(x.d.restart).not.toHaveBeenCalled();
    expect(await applyKiroReconciliation(x.d, p, "discord:admin")).toMatchObject({ ok: true, receipt });
    expect(x.d.store).toHaveBeenLastCalledWith(p.input, p.plan, "discord:admin"); expect(x.d.restart).toHaveBeenCalledTimes(2);
    expect(x.d.verify).toHaveBeenNthCalledWith(1, "wiki", "original", "claude-sonnet-4.6", true);
    expect(x.d.verify).toHaveBeenNthCalledWith(2, "wiki", "original", "claude-sonnet-4.6", true);
    expect(x.d.stop).not.toHaveBeenCalled();
  });
  it("rollback remains stopped and never invokes restart or verification", async () => {
    const x = fixture(), p = await plan(x, receipt);
    expect((await applyKiroReconciliation(x.d, p, "admin")).ok).toBe(true);
    expect(x.d.restart).not.toHaveBeenCalled(); expect(x.d.verify).not.toHaveBeenCalled();
  });
  it("a running instance cannot even request a confirmation", async () => {
    const x = fixture(); x.setStatus("running"); await expect(plan(x)).rejects.toThrow(); expect(x.d.store).not.toHaveBeenCalled();
  });
  it.each(["model", "directory", "backend"])("a changed %s at confirmation cannot reach storage mutation", async field => {
    const x = fixture(), p = await plan(x); x.d.store = vi.fn();
    if (field === "model") x.fleet.instances.wiki!.model = "changed";
    if (field === "directory") x.fleet.instances.wiki!.working_directory = "/changed";
    if (field === "backend") x.fleet.instances.wiki!.backend = "codex";
    expect((await applyKiroReconciliation(x.d, p, "admin")).ok).toBe(false); expect(x.d.store).not.toHaveBeenCalled(); expect(x.d.restart).not.toHaveBeenCalled();
  });
  it.each([1, 2])("verification %i failure stops/pause path without a success claim", async failing => {
    const x = fixture(); let n = 0; x.d.verify = vi.fn(async () => { if (++n === failing) throw new Error("wrong model/id"); return { forensic: "clean" }; });
    expect((await applyKiroReconciliation(x.d, await plan(x), "admin")).ok).toBe(false); expect(x.d.stop).toHaveBeenCalledOnce(); expect(x.d.restart).toHaveBeenCalledTimes(failing);
  });
  it("a user's stop during storage never starts or cleans up over the newer owner", async () => {
    const x = fixture(), p = await plan(x); x.d.store = vi.fn(async () => { x.supersede(); return { receipt }; });
    expect((await applyKiroReconciliation(x.d, p, "admin")).ok).toBe(false); expect(x.d.restart).not.toHaveBeenCalled(); expect(x.d.stop).not.toHaveBeenCalled();
  });
  it("a changed preflight model cannot mutate storage", async () => {
    const x = fixture(), p = await plan(x); x.d.store = vi.fn(); x.d.preflight = vi.fn(async () => "other-model");
    expect((await applyKiroReconciliation(x.d, p, "admin")).ok).toBe(false); expect(x.d.store).not.toHaveBeenCalled(); expect(x.d.stop).not.toHaveBeenCalled();
  });
  it.each(["en", "zh-TW"] as const)("preflight refusal keeps the pause reason and reports no issued receipt (%s)", async locale => {
    setLocale(locale);
    const x = fixture(), p = await plan(x), before = JSON.stringify(x.fleet);
    x.d.preflight = vi.fn(async () => { throw new Error(t("kiro_migrate.version_required")); });
    x.d.store = vi.fn();
    const out = await applyKiroReconciliation(x.d, p, "admin");
    expect(out).toMatchObject({ ok: false }); expect(out.receipt).toBeUndefined();
    expect(x.d.store).not.toHaveBeenCalled(); expect(x.d.restart).not.toHaveBeenCalled(); expect(x.d.stop).not.toHaveBeenCalled();
    expect(JSON.stringify(x.fleet)).toBe(before);
    expect(out.text).toBe(t("kiro_reconcile.failed_no_receipt", "wiki", t("kiro_migrate.version_required").replace(/[.。]+$/, "")));
    expect(out.text).not.toMatch(/\.\.|。。/);
    expect(out.text).not.toContain(locale === "en" ? "Inspect the receipt" : "檢查收據");
  });
  it("a storage failure without a returned receipt still stops conservatively", async () => {
    const x = fixture(), p = await plan(x); x.d.store = vi.fn(async () => { throw new Error("partial storage write."); });
    const out = await applyKiroReconciliation(x.d, p, "admin");
    expect(out.ok).toBe(false); expect(out.receipt).toBeUndefined(); expect(x.d.stop).toHaveBeenCalledOnce();
    expect(out.text).toContain("partial storage write."); expect(out.text).not.toContain("..");
    expect(x.d.restart).not.toHaveBeenCalled();
  });
  it("a failed cleanup reports that the stop could not be confirmed", async () => {
    const x = fixture(), p = await plan(x); x.d.verify = vi.fn(async () => { throw new Error("verify failed"); }); x.d.stop = vi.fn(async () => { throw new Error("stop failed"); });
    expect((await applyKiroReconciliation(x.d, p, "admin")).text).toContain(t("kiro_migrate.stop_unconfirmed"));
  });
});

function manager(x: ReturnType<typeof fixture>) {
  const f = Object.create(FleetManager.prototype) as any, posted: any[] = [];
  Object.assign(f, { fleetConfig: x.fleet, pendingKiroReconciliations: new Map(), kiroReconcileDeps: () => x.d,
    findGeneralInstance: () => "general", getInstanceAdapterId: () => "discord", getAdapterForInstance: () => ({ id: "discord" }), getGroupIdForInstance: () => "1",
    getInstanceStatus: x.d.status, eventLog: { insert: vi.fn() }, logger: { info: vi.fn(), error: vi.fn() },
    postNonceButtonPromptOrThrow: vi.fn(async (opts: any) => { posted.push(opts); return "c".repeat(32); }), retireNonceButtons: vi.fn(async () => {}),
    notifyFleetError: vi.fn(), notifyInstanceTopic: vi.fn(),
  }); return { f, posted };
}
const click = { callbackData: `kiro-reconcile:${"c".repeat(32)}:confirm`, userId: "admin", chatId: "1", messageId: "message" };
describe("General confirmation and Log boundary", () => {
  it.each(["en", "zh-TW"] as const)("posts exact IDs and reconciliation progress, writes a request audit, and consumes Confirm once (%s)", async locale => {
    setLocale(locale);
    const x = fixture(), { f, posted } = manager(x);
    expect(await f.requestKiroReconciliation("wiki", "original", "newer")).toMatchObject({ ok: true });
    expect(posted[0]).toMatchObject({ prefix: "kiro-reconcile:", instanceName: "wiki", chatId: "1", threadId: "7" });
    expect(posted[0].message).toContain("original"); expect(posted[0].message).toContain("newer"); expect(x.d.restart).not.toHaveBeenCalled();
    f.consumeNonceCallback = vi.fn(() => ({ entry: { instanceName: "wiki", messageId: "message" }, action: "confirm" }));
    await f.handleKiroReconcileCallback(click, "discord"); await f.handleKiroReconcileCallback(click, "discord");
    expect(f.retireNonceButtons).toHaveBeenCalledWith(expect.anything(), "message", t("kiro_reconcile.applying", "wiki"));
    expect(t("kiro_reconcile.applying", "wiki")).not.toContain("TUI");
    expect(t("kiro_reconcile.applying", "wiki")).not.toBe("kiro_reconcile.applying");
    expect(x.d.restart).toHaveBeenCalledTimes(2); expect(f.eventLog.insert).toHaveBeenCalledWith("wiki", "kiro_reconcile", expect.objectContaining({ phase: "completed", receipt }));
    expect(f.notifyFleetError).toHaveBeenCalledWith(expect.stringContaining(receipt)); expect(f.notifyInstanceTopic).toHaveBeenCalledWith("wiki", expect.stringContaining(receipt));
  });
  it.each(["cancel", "denied", "expired"])("%s cannot mutate stores or run lifecycle handlers", async mode => {
    const x = fixture(), { f } = manager(x); await f.requestKiroReconciliation("wiki", "original", "newer");
    if (mode === "expired") f.pendingKiroReconciliations.clear();
    f.consumeNonceCallback = vi.fn(() => mode === "denied" ? "consumed" : { entry: { instanceName: "wiki" }, action: mode === "cancel" ? "cancel" : "confirm" });
    await f.handleKiroReconcileCallback(click, "discord"); expect(x.d.reserve).not.toHaveBeenCalled(); expect(x.d.restart).not.toHaveBeenCalled();
  });
  it("missing/failing audit refuses mutation even after Confirm", async () => {
    const x = fixture(), { f } = manager(x); f.eventLog = undefined;
    expect(await f.requestKiroReconciliation("wiki", "original", "newer")).toMatchObject({ ok: false });
    f.eventLog = { insert: vi.fn() }; await f.requestKiroReconciliation("wiki", "original", "newer");
    f.eventLog.insert = () => { throw new Error("audit down"); };
    f.consumeNonceCallback = vi.fn(() => ({ entry: { instanceName: "wiki" }, action: "confirm" }));
    await f.handleKiroReconcileCallback(click, "discord"); expect(x.d.reserve).not.toHaveBeenCalled();
  });
  it("reconciliation is visible with the raw Kiro history gate still closed", async () => {
    const svc = new LogService({ enabled: () => true, known: () => true, source: () => ({ backend: "kiro-cli", path: null, format: null, reason: "kiro_v2_root" }),
      events: () => [{ id: 1, event_type: "kiro_reconcile", created_at: "2026-10-27 05:00:00", payload: { message: "Original selected; newer archived intact" } }], emit: () => {} });
    expect((await svc.steps("wiki", {}) as any).events).toEqual([expect.objectContaining({ type: "kiro_reconcile", detail: "Original selected; newer archived intact" })]);
  });
  it("the public schema requires explicit different IDs and does not grant worker lifecycle authority", () => {
    expect(ReconcileKiroInstanceArgs.safeParse({ name: "wiki", keep_session_id: "same", archive_session_id: "same" }).success).toBe(false);
    expect(ReconcileKiroInstanceArgs.safeParse({ name: "wiki", keep_session_id: "original", archive_session_id: "../newer" }).success).toBe(false);
    expect(ReconcileKiroInstanceArgs.safeParse({ name: "wiki", keep_session_id: "original", archive_session_id: "newer", confirm: true }).success).toBe(false);
    expect(TOOL_PROFILES.worker).not.toContain("reconcile_kiro_instance"); expect(TOOL_PROFILES.coordinator).toContain("reconcile_kiro_instance");
  });
  it("a competing cold start cannot bypass the instance lease", async () => {
    const x = fixture(), f = Object.create(FleetManager.prototype) as any;
    f.kiroMigrationRuns = new Map([["wiki", { token: Symbol("owner"), stopGeneration: 0 }]]);
    await expect(f.startInstance("wiki", x.fleet.instances.wiki, true)).rejects.toThrow(t("kiro_migrate.in_progress"));
  });
});
