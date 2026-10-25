/**
 * #2598 B2 + B3: moving a kiro instance from classic to the TUI carries its conversation, is one-way, and asks a fleet
 * admin first.
 *
 *  - B2: a classic instance switched by editing kiro_ui alone started an empty TUI conversation (no TUI record → fresh).
 *    The move arms its classic conversation as the TUI adoption, so the real resolver resumes exactly it, once.
 *  - B3: nothing stopped a launch back on classic after the move (it resumes the frozen copy and loses the work done
 *    since); and a TUI launch without its per-instance plan used kiro's bare `--resume`, which takes the directory's
 *    newest conversation from either engine.
 *
 * The identity files are real (a scratch AGEND_HOME); kiro is never run.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KiroBackend } from "../src/backend/kiro.js";
import {
  armKiroTuiMigration, disarmKiroTuiMigration, inspectKiroTuiMigration, kiroEngineFloor, resolveKiroIdentity,
  type KiroStoreRead,
} from "../src/backend/kiro-identity.js";
import { UnsupportedCliError, type CliBackendConfig } from "../src/backend/types.js";
import { applyKiroMigration, kiroMigrationPrompt, planKiroMigration, type KiroMigrateDeps } from "../src/kiro-migrate.js";
import { kiroEngineStatus } from "../src/kiro-engine-status.js";
import { t } from "../src/locale.js";
import type { FleetConfig } from "../src/types.js";

let home: string, cwd: string;
const savedHome = process.env.AGEND_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kiro-mig-"));
  cwd = join(home, "work"); mkdirSync(cwd);
  process.env.AGEND_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const store = (ids: string[]): KiroStoreRead => ({
  kind: "ok", sessions: ids.map((id, i) => ({ id, updatedAt: 1000 + i })), createdAt: () => 1,
});
/** The real resolver, as a launch on `engine` calls it. */
function launch(engine: "v1" | "v2", ids: string[] = [], opts: { launchedBefore?: boolean; instance?: string } = {}) {
  return resolveKiroIdentity({
    instance: opts.instance ?? "wiki", engine, workingDirectory: cwd, credentialProfile: null, agendHome: home,
    readStore: () => store(ids), launchedBefore: () => opts.launchedBefore ?? true,
  });
}
const ident = (instance = "wiki") => ({ agendHome: home, instance, workingDirectory: cwd, credentialProfile: null });

describe("identity: arming the move (B2)", () => {
  it("a classic instance holding its conversation is ready to carry it", () => {
    expect(launch("v1", ["classic-1"])).toMatchObject({ mode: "resume", id: "classic-1" });
    expect(inspectKiroTuiMigration(ident())).toEqual({ kind: "ready", classicId: "classic-1" });
    expect(kiroEngineFloor(home, "wiki")).toBeNull();
  });

  it("armed, the real TUI resolver resumes exactly the classic id — and records it, which sets the floor", () => {
    launch("v1", ["classic-1"]);
    expect(armKiroTuiMigration(ident())).toEqual({ kind: "ready", classicId: "classic-1" });
    expect(kiroEngineFloor(home, "wiki"), "armed is not moved: nothing happened under the TUI yet").toBeNull();
    // The TUI store has newer sessions of its own in the directory; the armed id wins, not the newest.
    expect(launch("v2", ["tui-sibling", "tui-newer"], { launchedBefore: false })).toMatchObject({ mode: "resume", id: "classic-1" });
    expect(kiroEngineFloor(home, "wiki")).toBe("v2");
    // …and the next TUI launch resumes it again by its record.
    expect(launch("v2", [])).toMatchObject({ mode: "resume", id: "classic-1" });
    expect(inspectKiroTuiMigration(ident())).toEqual({ kind: "refused", reason: "already-tui" });
  });

  it("without arming (kiro_ui edited by hand), the first TUI launch starts fresh — the loss this fixes", () => {
    launch("v1", ["classic-1"]);
    expect(launch("v2", ["classic-1"], { launchedBefore: false })).toMatchObject({ mode: "fresh" });
  });

  it("a recorded classic id whose claim this instance no longer holds is not carried", () => {
    launch("v1", ["classic-1"]);
    writeFileSync(join(home, "kiro-identity", "claims", "v1", "classic-1"), "someone-else\n");
    expect(inspectKiroTuiMigration(ident())).toEqual({ kind: "ready", classicId: null });
  });

  it("no classic conversation: ready with nothing to carry; arming writes nothing", () => {
    expect(inspectKiroTuiMigration(ident())).toEqual({ kind: "ready", classicId: null });
    armKiroTuiMigration(ident());
    expect(launch("v2", ["someone-elses"], { launchedBefore: false })).toMatchObject({ mode: "fresh" });
  });

  it("a move under way is not armed twice; disarm undoes it before any TUI launch", () => {
    launch("v1", ["classic-1"]);
    armKiroTuiMigration(ident());
    expect(inspectKiroTuiMigration(ident())).toEqual({ kind: "refused", reason: "already-tui" });
    disarmKiroTuiMigration(ident());
    expect(inspectKiroTuiMigration(ident())).toEqual({ kind: "ready", classicId: "classic-1" });
    expect(launch("v2", ["classic-1"], { launchedBefore: false })).toMatchObject({ mode: "fresh" });
  });

  it("an unreadable adoption file refuses — never a guess", () => {
    launch("v1", ["classic-1"]);
    const dir = join(home, "kiro-identity", "instances");
    const pending = readdirPending(dir);
    writeFileSync(join(dir, pending), "{not json");
    expect(inspectKiroTuiMigration(ident())).toEqual({ kind: "refused", reason: "unreadable" });
  });
});
/** The instance's adoption file name (its state file's, with .adopting). */
function readdirPending(dir: string): string {
  const state = readdirSync(dir).find((n: string) => n.endsWith(".json") && !n.endsWith(".adopting.json"));
  if (!state) throw new Error(`no state file in ${dir}`);
  return state.replace(/\.json$/, ".adopting.json");
}

const compat = (extra: Record<string, unknown> = {}) => ({
  supportsLegacyUi: true, supportsTui: true, supportsV3: true, agentEngines: ["v2", "v1", "v3"], supportsEffortFlag: false,
  supportsInstanceAgent: true, version: "2.30.0", source: "table", ...extra,
}) as never;
function config(kiroUi: "legacy" | "tui", instanceName = "wiki"): CliBackendConfig {
  return { workingDirectory: cwd, instanceDir: join(home, "inst"), instanceName, mcpServers: {}, kiroUi } as CliBackendConfig;
}

describe("the engine floor (B3)", () => {
  it("once the instance ran under the TUI, a classic launch is refused with the reason", () => {
    launch("v1", ["classic-1"]);
    armKiroTuiMigration(ident());
    launch("v2", [], { launchedBefore: false });
    const b = new KiroBackend(join(home, "inst"), compat());
    expect(() => b.buildCommand(config("legacy"))).toThrow(UnsupportedCliError);
    expect(() => b.buildCommand(config("legacy"))).toThrow(t("kiro.engine_floor", "wiki", "legacy", "tui"));
  });

  it("a never-moved instance launches classic as before; another instance's floor is not its own", () => {
    launch("v2", [], { launchedBefore: false, instance: "other" });
    expect(kiroEngineFloor(home, "other")).toBe("v2");
    const b = new KiroBackend(join(home, "inst"), compat());
    expect(b.buildCommand(config("legacy"))).toContain("--legacy-ui");
  });

  it("kiro_engine_status shows the floor and the refusal", () => {
    launch("v2", [], { launchedBefore: false });
    const status = kiroEngineStatus([{ name: "wiki", classic: false, kiroUi: "legacy", credentialProfile: null }], {
      agendHome: home, snapshot: () => ({ binaryPath: "/k", at: "x", compatibility: compat() }) as never,
    });
    expect(status.instances[0]).toMatchObject({ engine_floor: "tui", next_launch: { refused: t("kiro.engine_floor", "wiki", "legacy", "tui") } });
  });
});

describe("no bare --resume under the TUI (B3)", () => {
  // Without the per-instance plan (a kiro-cli that cannot isolate instances): legacy mode.
  const noPlan = () => new KiroBackend(join(home, "inst"), compat({ supportsInstanceAgent: false }));

  it("a TUI launch without its plan starts fresh, and says so", () => {
    const b = noPlan();
    const cmd = b.buildCommand(config("tui"));
    expect(cmd).toContain("--tui");
    expect(cmd).not.toMatch(/--resume(\s|$)/);
    expect(b.consumeLaunchWarning?.() ?? "").toContain(t("kiro.tui_no_plan_fresh"));
  });

  it("a classic launch without its plan keeps the boolean --resume (its only way back)", () => {
    expect(noPlan().buildCommand(config("legacy"))).toMatch(/--resume(\s|$)/);
  });
});

describe("migrate_kiro_instance: judge, then apply on the admin's Confirm", () => {
  function deps(over: Partial<KiroMigrateDeps> & { inst?: Record<string, unknown>; running?: boolean } = {}) {
    const fleet = { defaults: {}, instances: { wiki: { backend: "kiro-cli", working_directory: cwd, ...(over.inst ?? {}) } } } as unknown as FleetConfig;
    const saved: string[] = [];
    const restart = vi.fn(async () => {});
    const d: KiroMigrateDeps = {
      agendHome: home,
      fleetConfig: () => fleet,
      saveFleetConfig: () => { saved.push(String(fleet.instances.wiki.kiro_ui)); },
      status: () => over.running === false ? "stopped" : "running",
      restart,
      ...over,
    };
    return { d, fleet, saved, restart };
  }

  it("refuses what it must not move", () => {
    expect(planKiroMigration(deps().d, "nope", false)).toEqual({ ok: false, error: t("kiro_migrate.not_fleet_instance", "nope") });
    expect(planKiroMigration(deps({ inst: { backend: "codex" } }).d, "wiki", false)).toEqual({ ok: false, error: t("kiro_migrate.not_kiro", "wiki", "codex") });
    expect(planKiroMigration(deps({ inst: { kiro_ui: "tui" } }).d, "wiki", false)).toEqual({ ok: false, error: t("kiro_migrate.not_legacy", "wiki", "tui") });
    expect(planKiroMigration(deps().d, "wiki", false), "nothing to carry").toEqual({ ok: false, error: t("kiro_migrate.no_classic", "wiki") });
    expect(planKiroMigration(deps().d, "wiki", true)).toMatchObject({ ok: true, plan: { classicId: null } });
  });

  it("a running instance: kiro_ui saved as tui, the classic conversation armed, restarted; the prompt says what happens", async () => {
    launch("v1", ["classic-1"]);
    const { d, fleet, saved, restart } = deps();
    const judged = planKiroMigration(d, "wiki", false);
    if (!judged.ok) throw new Error(judged.error);
    expect(kiroMigrationPrompt(judged.plan, true)).toContain("classic-1");
    const out = await applyKiroMigration(d, judged.plan);
    expect(out).toEqual({ ok: true, text: `${t("kiro_migrate.done", "wiki")} ${t("kiro_migrate.done_carry", "classic-1")}` });
    expect(fleet.instances.wiki.kiro_ui).toBe("tui");
    expect(saved).toEqual(["tui"]);
    expect(restart).toHaveBeenCalledWith("wiki");
    // What the restart's TUI launch then resolves to:
    expect(launch("v2", ["tui-newer"], { launchedBefore: false })).toMatchObject({ mode: "resume", id: "classic-1" });
  });

  it("a stopped instance is not started: the move happens at its next start", async () => {
    launch("v1", ["classic-1"]);
    const { d, restart } = deps({ running: false });
    const judged = planKiroMigration(d, "wiki", false);
    if (!judged.ok) throw new Error(judged.error);
    expect((await applyKiroMigration(d, judged.plan)).text).toContain(t("kiro_migrate.done_next_start", "wiki"));
    expect(restart).not.toHaveBeenCalled();
  });

  it("fleet.yaml cannot be saved: nothing changes, nothing is armed", async () => {
    launch("v1", ["classic-1"]);
    const { d, fleet } = deps({ saveFleetConfig: () => { throw new Error("disk full"); } });
    const judged = planKiroMigration(d, "wiki", false);
    if (!judged.ok) throw new Error(judged.error);
    expect(await applyKiroMigration(d, judged.plan)).toEqual({ ok: false, text: t("kiro_migrate.save_failed", "wiki", "disk full") });
    expect(fleet.instances.wiki.kiro_ui).toBeUndefined();
    expect(inspectKiroTuiMigration(ident())).toEqual({ kind: "ready", classicId: "classic-1" });
  });

  it("the instance changed between the request and the Confirm: refused, untouched", async () => {
    launch("v1", ["classic-1"]);
    const { d, fleet, saved } = deps();
    const judged = planKiroMigration(d, "wiki", false);
    if (!judged.ok) throw new Error(judged.error);
    fleet.instances.wiki.kiro_ui = "tui";
    expect(await applyKiroMigration(d, judged.plan)).toEqual({ ok: false, text: t("kiro_migrate.not_legacy", "wiki", "tui") });
    fleet.instances.wiki.kiro_ui = "legacy";
    expect(await applyKiroMigration(d, { ...judged.plan, classicId: "another" })).toEqual({ ok: false, text: t("kiro_migrate.changed", "wiki") });
    expect(fleet.instances.wiki.kiro_ui).toBe("legacy");
    expect(saved, "refused before anything was written").toEqual([]);
  });

  it("the adoption cannot be written: the config is put back and saved again", async () => {
    launch("v1", ["classic-1"]);
    const { d, fleet, saved } = deps();
    const judged = planKiroMigration(d, "wiki", false);
    if (!judged.ok) throw new Error(judged.error);
    // The records stay readable; only the adoption cannot be written next to them.
    const dir = join(home, "kiro-identity", "instances");
    chmodSync(dir, 0o500);
    let out;
    try { out = await applyKiroMigration(d, judged.plan); } finally { chmodSync(dir, 0o700); }
    expect(out).toEqual({ ok: false, text: t("kiro_migrate.refused_unreadable", "wiki") });
    expect(fleet.instances.wiki.kiro_ui).toBeUndefined();
    expect(saved).toEqual(["tui", "undefined"]);
  });
});

it("the state file is the real one (sanity: the floor reads what the resolver wrote)", () => {
  launch("v2", [], { launchedBefore: false });
  const dir = join(home, "kiro-identity", "instances");
  const file = readdirSync(dir).find((n: string) => !n.includes("adopting"));
  if (!file) throw new Error("no state file");
  expect(JSON.parse(readFileSync(join(dir, file), "utf8")).instance).toBe("wiki");
});

describe("FleetManager glue: the request posts a Confirm in General; only the click moves", () => {
  async function fm() {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const f = Object.create(FleetManager.prototype) as Record<string, any>;
    const fleet = { defaults: {}, instances: { wiki: { backend: "kiro-cli", working_directory: cwd }, general: { general_topic: true, topic_id: 7 } } };
    const posted: any[] = [];
    Object.assign(f, {
      fleetConfig: fleet,
      pendingKiroMigrations: new Map(),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      eventLog: { insert: vi.fn() },
      findGeneralInstance: () => "general",
      getInstanceAdapterId: () => "tg",
      getAdapterForInstance: () => ({ id: "tg" }),
      getGroupIdForInstance: () => "-100",
      getInstanceStatus: () => "running",
      saveFleetConfig: vi.fn(),
      restartSingleInstance: vi.fn(async () => {}),
      notifyFleetError: vi.fn(),
      notifyInstanceTopic: vi.fn(),
      retireNonceButtons: vi.fn(async () => {}),
      postNonceButtonPromptOrThrow: vi.fn(async (opts: any) => { posted.push(opts); return "a".repeat(32); }),
    });
    return { f, fleet, posted };
  }
  const click = (action: string) => ({ callbackData: `kiro-migrate:${"a".repeat(32)}:${action}`, userId: "admin", chatId: "-100", messageId: "m" });

  it("request: judged, posted in General's topic, nothing changed", async () => {
    launch("v1", ["classic-1"]);
    const { f, fleet, posted } = await fm();
    expect(await f.requestKiroMigration("wiki", false)).toEqual({ ok: true, text: t("kiro_migrate.requested"), classic_conversation: "classic-1" });
    expect(posted[0]).toMatchObject({ prefix: "kiro-migrate:", instanceName: "wiki", chatId: "-100", threadId: "7" });
    expect(posted[0].message).toContain("classic-1");
    expect(fleet.instances.wiki).not.toHaveProperty("kiro_ui");
    expect(f.saveFleetConfig).not.toHaveBeenCalled();
    expect(await f.requestKiroMigration("wiki", false)).toMatchObject({ ok: true }); // asking again still changes nothing
    expect(inspectKiroTuiMigration(ident())).toEqual({ kind: "ready", classicId: "classic-1" });
  });

  it("Confirm (claimed by the nonce check): the move runs and is announced in General and the topic", async () => {
    launch("v1", ["classic-1"]);
    const { f, fleet } = await fm();
    await f.requestKiroMigration("wiki", false);
    f.consumeNonceCallback = vi.fn(() => ({ entry: { instanceName: "wiki", messageId: "m" }, action: "confirm" }));
    expect(await f.handleKiroMigrateCallback(click("confirm"), "tg")).toBe(true);
    expect(fleet.instances.wiki).toHaveProperty("kiro_ui", "tui");
    expect(f.restartSingleInstance).toHaveBeenCalledWith("wiki", { explicit: true });
    const text = `${t("kiro_migrate.done", "wiki")} ${t("kiro_migrate.done_carry", "classic-1")}`;
    expect(f.notifyFleetError).toHaveBeenCalledWith(text);
    expect(f.notifyInstanceTopic).toHaveBeenCalledWith("wiki", text);
  });

  it("Cancel, or a click the nonce check refuses (not a fleet admin): nothing changes", async () => {
    launch("v1", ["classic-1"]);
    const { f, fleet } = await fm();
    await f.requestKiroMigration("wiki", false);
    f.consumeNonceCallback = vi.fn(() => "consumed");
    expect(await f.handleKiroMigrateCallback(click("confirm"), "tg")).toBe(true);
    f.consumeNonceCallback = vi.fn(() => ({ entry: { instanceName: "wiki", messageId: "m" }, action: "cancel" }));
    expect(await f.handleKiroMigrateCallback(click("cancel"), "tg")).toBe(true);
    expect(fleet.instances.wiki).not.toHaveProperty("kiro_ui");
    expect(f.restartSingleInstance).not.toHaveBeenCalled();
    expect(f.retireNonceButtons).toHaveBeenCalledWith(expect.anything(), "m", t("kiro_migrate.cancelled", "wiki"));
  });

  it("other callbacks are not taken", async () => {
    const { f } = await fm();
    f.consumeNonceCallback = vi.fn(() => null);
    expect(await f.handleKiroMigrateCallback({ callbackData: "clear-confirm:x:confirm" }, "tg")).toBe(false);
  });
});
