/**
 * #1939 S2a: the step-up policy's one source (§5), the server switch and the revocation epoch (§10), and how
 * delivery_status reads a receipt's authority now. docs/design/1939-verified-web-sessions.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { createHumanReceipt, initializeHumanReceipts, nativeHumanOrigin, webHumanOrigin } from "../src/human-delivery-receipts.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { tokenEpoch } from "../src/web-session.js";
import { DEFAULT_ENFORCED, STEP_UP_CATALOG, enforcedStepUps, stepUpActions, stepUpPolicyProblems } from "../src/authority/step-up-policy.js";
import { AuthorityStateStore, type AuthorityStateIo } from "../src/authority/authority-state.js";
import { authorityNow, evaluateWebAuthority, type HumanAuthority } from "../src/authority/web-authority.js";
import Database from "better-sqlite3";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-1939-s2a-")); dirs.push(d); return d; };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const webSession = (epoch: number, peer: "loopback" | "lan" = "loopback"): HumanAuthority => ({ kind: "web-session", actor: { adapter_id: "owner", user_id: "admin" },
  session: { handle: "a1b2c3d4e5f60718", peer, signed_in_at: "2026-10-18T09:00:00.000Z", age_s: 60 }, authority_epoch: epoch });

describe("§5 the one source: the catalog, the defaults, custom actions, and the enforced list in force", () => {
  it("the catalog is §5's table: ids, target kinds, English and Chinese labels", () => {
    expect(STEP_UP_CATALOG.map(a => [a.id, a.targets.join("|")])).toEqual([
      ["release", "tag"], ["force-push", "branch"], ["delete-instance", "instance"], ["merge", "pr"], ["history-rewrite", "branch"],
      ["real-account", "account"], ["deploy", "text"], ["close", "pr|issue"], ["credential", "instance"], ["fleet-control", "text"],
    ]);
    for (const a of STEP_UP_CATALOG) { expect(a.label.length).toBeGreaterThan(5); expect(a.label_zh.length).toBeGreaterThan(3); expect(a.custom).toBeUndefined(); }
    expect(Object.isFrozen(STEP_UP_CATALOG) && Object.isFrozen(STEP_UP_CATALOG[0]) && Object.isFrozen(STEP_UP_CATALOG[0]!.targets)).toBe(true);
  });
  it("the default list is release, force-push and delete-instance (§11.5)", () => {
    expect(DEFAULT_ENFORCED).toEqual(["release", "force-push", "delete-instance"]);
    expect(enforcedStepUps(undefined).enforced).toEqual(["release", "force-push", "delete-instance"]);
    expect(enforcedStepUps({ step_up: {} }).enforced).toEqual(["release", "force-push", "delete-instance"]);
  });
  it("the user's list is used as written: emptied, extended with merge and a custom action; unknown ids are not enforced", () => {
    const custom = [{ id: "drop-database", label: "Drop a production database", label_zh: "刪除正式資料庫" }];
    expect(enforcedStepUps({ step_up: { enforce: [] } }).enforced).toEqual([]);
    expect(enforcedStepUps({ step_up: { enforce: ["merge", "release", "drop-database"], custom } }).enforced).toEqual(["merge", "release", "drop-database"]);
    expect(enforcedStepUps({ step_up: { enforce: ["release", "drop-database", "nope", "release"] } }).enforced).toEqual(["release"]);
  });
  it("version: informational — the same for the same list, different when the list changes", () => {
    const a = enforcedStepUps(undefined).version, b = enforcedStepUps({ step_up: { enforce: ["release", "force-push", "delete-instance"] } }).version;
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(b).toBe(a);
    expect(enforcedStepUps({ step_up: { enforce: ["release"] } }).version).not.toBe(a);
  });
  it("custom actions join the table with text targets; a bad one is left out (never shadows the catalog)", () => {
    const table = stepUpActions({ step_up: { custom: [
      { id: "drop-database", label: "Drop a production database" },
      { id: "merge", label: "My merge" }, { id: "X1", label: "bad id" }, { id: "rotate-keys", label: "" }, { id: "wipe-disk", label: "a\nb" },
    ] } });
    expect(table.get("drop-database")).toEqual({ id: "drop-database", label: "Drop a production database", label_zh: "Drop a production database", targets: ["text"], custom: true });
    expect(table.get("merge")!.label).toBe("Merge into a protected branch");
    expect([...table.keys()].filter(k => !STEP_UP_CATALOG.some(a => a.id === k))).toEqual(["drop-database"]);
  });
  it("the validator names every problem under step_up", () => {
    const paths = (stepUp: unknown) => stepUpPolicyProblems(stepUp).map(p => `${p.warning ? "warn" : "err"} ${p.path}`);
    expect(paths(undefined)).toEqual([]);
    expect(paths({ enforce: ["release", "drop-database"], custom: [{ id: "drop-database", label: "Drop", label_zh: "刪除" }] })).toEqual([]);
    expect(paths([])).toEqual(["err web.verified_authority.step_up"]);
    expect(paths({ extra: 1 })).toEqual(["warn web.verified_authority.step_up.extra"]);
    expect(paths({ enforce: "release" })).toEqual(["err web.verified_authority.step_up.enforce"]);
    expect(paths({ enforce: ["nope", 7] })).toEqual(["err web.verified_authority.step_up.enforce[0]", "err web.verified_authority.step_up.enforce[1]"]);
    expect(paths({ custom: {} })).toEqual(["err web.verified_authority.step_up.custom"]);
    expect(paths({ custom: ["x"] })).toEqual(["err web.verified_authority.step_up.custom[0]"]);
    expect(paths({ custom: [{ id: "ab", label: "x" }] })).toEqual(["err web.verified_authority.step_up.custom[0].id"]);
    expect(paths({ custom: [{ id: "release", label: "x" }] })).toEqual(["err web.verified_authority.step_up.custom[0].id"]);
    expect(paths({ custom: [{ id: "abc", label: "x" }, { id: "abc", label: "y" }] })).toEqual(["err web.verified_authority.step_up.custom[1].id"]);
    expect(paths({ custom: [{ id: "abc", label: "x".repeat(81) }] })).toEqual(["err web.verified_authority.step_up.custom[0].label"]);
    expect(paths({ custom: [{ id: "abc", label: "x", label_zh: "" }] })).toEqual(["err web.verified_authority.step_up.custom[0].label_zh"]);
    expect(paths({ custom: [{ id: "abc", label: "x", color: "red" }] })).toEqual(["warn web.verified_authority.step_up.custom[0].color"]);
    // A custom id that failed is not one enforce may name.
    expect(paths({ enforce: ["Bad"], custom: [{ id: "Bad", label: "x" }] })).toEqual(["err web.verified_authority.step_up.custom[0].id", "err web.verified_authority.step_up.enforce[0]"]);
  });
  it("…and fleet.yaml validation reports them, with the switch", () => {
    const r = validateFleetConfig({ instances: {}, web: { verified_authority: { enabled: "yes", step_up: { enforce: ["nope"], other: 1 } } } } as never);
    expect(r.errors.map(e => e.path).filter(p => p.startsWith("web."))).toEqual(["web.verified_authority.enabled", "web.verified_authority.step_up.enforce[0]"]);
    expect(r.warnings.map(e => e.path).filter(p => p.startsWith("web."))).toEqual(["web.verified_authority.step_up.other"]);
  });
  it("the configuration docs name the switch and the default list", () => {
    for (const file of ["docs/configuration.md", "docs/configuration.zh-TW.md"]) {
      const text = readFileSync(join(import.meta.dirname, "..", file), "utf8");
      const at = text.indexOf("verified_authority`"), part = text.slice(at, text.indexOf(" |", at));
      expect(at).toBeGreaterThan(0);
      for (const key of ["enabled", "loopback_only", "max_session_hours", "step_up", "enforce", "custom"]) expect(part).toContain(`\`${key}`);
      for (const a of STEP_UP_CATALOG) expect(part).toContain(`\`${a.id}\``);
      // The defaults are named first, in order, before the others to pick from.
      expect(part.indexOf(DEFAULT_ENFORCED.map(id => `\`${id}\``).join(file.endsWith("zh-TW.md") ? "、" : ", "))).toBeGreaterThan(0);
    }
  });
});

/** An in-memory file for the store; `fail` makes writes throw. */
function memIo(initial?: string) {
  const files = new Map<string, string>(initial === undefined ? [] : [["/s.json", initial]]);
  const io: AuthorityStateIo & { fail: boolean; writes: number } = { fail: false, writes: 0,
    read: p => { const v = files.get(p); if (v === undefined) throw Object.assign(new Error("no"), { code: "ENOENT" }); return v; },
    write: (p, d) => { if (io.fail) throw new Error("EROFS"); io.writes++; files.set(p, d); } };
  return { io, files, stored: () => JSON.parse(files.get("/s.json")!) };
}
const log = () => ({ warn: vi.fn() });

describe("§10 the revocation epoch: moved by the switch, by loopback_only going off, and by an explicit revocation", () => {
  it("a fresh fleet: off, epoch 0, nothing written", () => {
    const m = memIo(); const s = new AuthorityStateStore("/s.json", log(), m.io);
    expect(s.current(undefined)).toEqual({ enabled: false, loopbackOnly: false, epoch: 0 });
    expect(m.io.writes).toBe(0);
  });
  it("on, off, on: each moves the epoch, and the positions are written", () => {
    const m = memIo(); const s = new AuthorityStateStore("/s.json", log(), m.io);
    expect(s.current({ enabled: true })).toEqual({ enabled: true, loopbackOnly: false, epoch: 1 });
    expect(m.stored()).toEqual({ v: 1, epoch: 1, enabled: true, loopback_only: false });
    expect(s.current({ enabled: true }).epoch).toBe(1);                                    // unchanged: no move, no write
    expect(m.io.writes).toBe(1);
    expect(s.current({ enabled: false })).toEqual({ enabled: false, loopbackOnly: false, epoch: 2 });
    expect(s.current({ enabled: true }).epoch).toBe(3);
  });
  it("loopback_only on: no move (lan receipts read as none meanwhile); off again: a move", () => {
    const m = memIo(); const s = new AuthorityStateStore("/s.json", log(), m.io);
    s.current({ enabled: true });
    expect(s.current({ enabled: true, loopback_only: true })).toEqual({ enabled: true, loopbackOnly: true, epoch: 1 });
    expect(m.stored().loopback_only).toBe(true);
    expect(s.current({ enabled: true, loopback_only: false })).toEqual({ enabled: true, loopbackOnly: false, epoch: 2 });
  });
  it("a change made while the fleet was stopped still moves it (the last positions are on disk)", () => {
    const m = memIo(JSON.stringify({ v: 1, epoch: 4, enabled: true, loopback_only: true }));
    expect(new AuthorityStateStore("/s.json", log(), m.io).current({ enabled: true, loopback_only: false }).epoch).toBe(5);
    const m2 = memIo(JSON.stringify({ v: 1, epoch: 4, enabled: true, loopback_only: false }));
    expect(new AuthorityStateStore("/s.json", log(), m2.io).current({ enabled: false }).epoch).toBe(5);
    const m3 = memIo(JSON.stringify({ v: 1, epoch: 4, enabled: true, loopback_only: false }));
    expect(new AuthorityStateStore("/s.json", log(), m3.io).current({ enabled: true }).epoch).toBe(4);
  });
  it("an explicit revocation moves it and says whether it is on disk", () => {
    const m = memIo(); const s = new AuthorityStateStore("/s.json", log(), m.io);
    s.current({ enabled: true });
    expect(s.revoke()).toEqual({ epoch: 2, durable: true });
    expect(m.stored().epoch).toBe(2);
    expect(s.current({ enabled: true })).toEqual({ enabled: true, loopbackOnly: false, epoch: 2 });
  });
  it("unreadable: every earlier authority is revoked (the epoch jumps past any counter), and it is said once", () => {
    const l = log(); const m = memIo("{broken");
    const s = new AuthorityStateStore("/s.json", l, m.io, () => 1_792_000_000_123);
    expect(s.current({ enabled: true })).toEqual({ enabled: true, loopbackOnly: false, epoch: 1_792_000_001 });
    expect(l.warn).toHaveBeenCalledTimes(1);
    const m2 = memIo(JSON.stringify({ v: 2, epoch: 1, enabled: true, loopback_only: false }));
    expect(new AuthorityStateStore("/s.json", log(), m2.io, () => 5_000).current({ enabled: false }).epoch).toBe(5);
  });
  it("fail-closed: while the state cannot be written the switch counts as off, and loopback_only stays on; then it recovers", () => {
    const l = log(); const m = memIo(JSON.stringify({ v: 1, epoch: 1, enabled: true, loopback_only: true }));
    const s = new AuthorityStateStore("/s.json", l, m.io);
    m.io.fail = true;
    expect(s.current({ enabled: true, loopback_only: false })).toEqual({ enabled: false, loopbackOnly: true, epoch: 2 });
    expect(s.current({ enabled: true, loopback_only: false })).toEqual({ enabled: false, loopbackOnly: true, epoch: 2 });
    expect(l.warn).toHaveBeenCalledTimes(1);
    m.io.fail = false;
    expect(s.current({ enabled: true, loopback_only: false })).toEqual({ enabled: true, loopbackOnly: false, epoch: 2 });
    expect(m.stored()).toEqual({ v: 1, epoch: 2, enabled: true, loopback_only: false });
  });
  it("a revocation that cannot be written: not durable, and the switch counts as off until it is", () => {
    const m = memIo(); const s = new AuthorityStateStore("/s.json", log(), m.io);
    s.current({ enabled: true });
    m.io.fail = true;
    expect(s.revoke()).toEqual({ epoch: 2, durable: false });
    expect(s.current({ enabled: true }).enabled).toBe(false);
    m.io.fail = false;
    expect(s.current({ enabled: true })).toEqual({ enabled: true, loopbackOnly: false, epoch: 2 });
  });
  it("#2112 review: a file missing, or behind the receipts (deleted, restored from an older copy), is never trusted", () => {
    const l = log();
    // Missing, with receipts at epoch 4: past them and the clock's seconds, and off.
    expect(new AuthorityStateStore("/s.json", l, memIo().io, () => 9_000, () => 4).current({ enabled: true })).toEqual({ enabled: true, loopbackOnly: false, epoch: 10 });
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(new AuthorityStateStore("/s.json", log(), memIo().io, () => 1_000, () => 40).current(undefined).epoch).toBe(41);
    // A file at epoch 2 while a receipt carries 5.
    const behind = memIo(JSON.stringify({ v: 1, epoch: 2, enabled: true, loopback_only: false }));
    expect(new AuthorityStateStore("/s.json", log(), behind.io, () => 1_000, () => 5).current({ enabled: true }).epoch).toBe(7);   // 6, then on: 7
    // At the receipts' epoch: trusted as written.
    const level = memIo(JSON.stringify({ v: 1, epoch: 5, enabled: true, loopback_only: false }));
    expect(new AuthorityStateStore("/s.json", log(), level.io, () => 1_000, () => 5).current({ enabled: true }).epoch).toBe(5);
    // Missing with no receipts: a fresh fleet.
    expect(new AuthorityStateStore("/s.json", log(), memIo().io, () => 1_000, () => 0).current(undefined).epoch).toBe(0);
    // The receipts cannot be read: the file is not trusted either.
    const unknown = memIo(JSON.stringify({ v: 1, epoch: 5, enabled: true, loopback_only: false }));
    expect(new AuthorityStateStore("/s.json", log(), unknown.io, () => 9_000, () => { throw new Error("locked"); }).current({ enabled: true }).epoch).toBe(10);
  });
  it("on disk: web-authority.json, owner-only", () => {
    const dir = tmp(); const s = new AuthorityStateStore(join(dir, "web-authority.json"), log());
    s.current({ enabled: true });
    expect(JSON.parse(readFileSync(join(dir, "web-authority.json"), "utf8"))).toEqual({ v: 1, epoch: 1, enabled: true, loopback_only: false });
    expect(statSync(join(dir, "web-authority.json")).mode & 0o777).toBe(0o600);
    expect(new AuthorityStateStore(join(dir, "web-authority.json"), log()).current({ enabled: true }).epoch).toBe(1);
  });
});

describe("§10 a receipt's authority, read now", () => {
  const on = { enabled: true, loopbackOnly: false, epoch: 3 };
  it("web-session stays while on, at the current epoch", () => {
    expect(authorityNow(webSession(3), on)).toEqual(webSession(3));
    expect(authorityNow(webSession(3, "lan"), on)).toEqual(webSession(3, "lan"));
  });
  it.each([
    ["the switch off", webSession(3), { ...on, enabled: false }, "disabled"],
    ["the switch off, over an old epoch too", webSession(1), { ...on, enabled: false }, "disabled"],
    ["an older epoch", webSession(2), on, "revoked"],
    ["lan under loopback_only", webSession(3, "lan"), { ...on, loopbackOnly: true }, "loopback_only"],
  ] as const)("%s → none, saying why", (_n, stored, state, downgraded) => {
    expect(authorityNow(stored, state)).toEqual({ kind: "none", actor: null, authority_epoch: stored.authority_epoch, downgraded });
  });
  it("loopback under loopback_only stays; platform and none never change", () => {
    expect(authorityNow(webSession(3), { ...on, loopbackOnly: true }).kind).toBe("web-session");
    const platform: HumanAuthority = { kind: "platform", actor: { adapter_id: "owner", user_id: "7" }, authority_epoch: 0 };
    expect(authorityNow(platform, { enabled: false, loopbackOnly: true, epoch: 9 })).toBe(platform);
    const none: HumanAuthority = { kind: "none", actor: null, authority_epoch: 0 };
    expect(authorityNow(none, on)).toBe(none);
  });
  it("a read-now value is never stored", () => {
    const d = new Database(":memory:"); initializeHumanReceipts(d);
    expect(() => createHumanReceipt(d, { targetInstance: "general", originalBody: "x", inputKind: "fleet_inbound", managerBootId: "m",
      origin: webHumanOrigin(false, { kind: "none", actor: null, authority_epoch: 0, downgraded: "revoked" }) })).toThrow(/unavailable/);
  });
  it("admission: the switch off refuses first", () => {
    const r = evaluateWebAuthority({ session: null, gateway: true, peer: "lan", tokenEpoch: null, isAdmin: () => true,
      policy: { enabled: false, loopbackOnly: false, maxSessionMs: 1 }, epoch: 4, now: 0 });
    expect(r).toEqual({ authority: { kind: "none", actor: null, authority_epoch: 4 }, refusal: "disabled" });
  });
});

describe("the FleetManager: admission and delivery_status use the state in force", () => {
  function fm(web: Record<string, unknown> | undefined) {
    const dir = tmp();
    const outbox = new DeliveryOutbox(join(dir, "outbox.db"), "m");
    const s: any = Object.assign(Object.create(FleetManager.prototype), { dataDir: dir, managerBootId: "m", deliveryOutbox: outbox,
      eventLog: { insert: vi.fn() }, logger: { info: vi.fn(), warn: vi.fn() }, fleetConfig: { instances: {}, web },
      lifecycle: { isPaused: () => false, daemons: new Map() } });
    s.ensureDeliveryOutbox = () => {};
    const receive = (origin: any) => s.humanReceiptPayload("general", { type: "fleet_inbound", content: "ship it", meta: {} }, origin, "ship it").meta.verification_id as string;
    const status = (id: string) => s.queryDurableDeliveryStatus("general", { messageId: id }).items[0];
    return { s, dir, outbox, receive, status };
  }
  it("the switch off: admission refuses; on: the first read moves the epoch, and a receipt reads web-session", () => {
    const h = fm(undefined);
    expect(h.s.webAuthority({ session: null, gateway: false, peer: "loopback" }).refusal).toBe("disabled");
    h.s.fleetConfig.web = { verified_authority: { enabled: true } };
    expect(h.s.webAuthorityState()).toEqual({ enabled: true, loopbackOnly: false, epoch: 1 });
    expect(h.s.webAuthority({ session: null, gateway: false, peer: "loopback" }).refusal).toBe("not_session");
    const id = h.receive(webHumanOrigin(false, webSession(1)));
    const item = h.status(id);
    expect(item.authority).toEqual(webSession(1));
    expect(item.source_instance).toBe("human:web:owner:admin");
    expect(item.step_up_policy).toEqual(enforcedStepUps(undefined));
    expect(item.waiting_reason).toBeNull();                                             // #1641 still applies (queued)
    h.outbox.close();
  });
  it("switch off → disabled; on again → revoked (never comes back); source_instance back to unknown", () => {
    const h = fm({ verified_authority: { enabled: true } });
    h.s.webAuthorityState();
    const id = h.receive(webHumanOrigin(false, webSession(1)));
    h.s.fleetConfig.web = { verified_authority: { enabled: false } };
    expect(h.status(id)).toMatchObject({ authority: { kind: "none", downgraded: "disabled" }, source_instance: "human:web:unknown" });
    h.s.fleetConfig.web = { verified_authority: { enabled: true } };
    expect(h.status(id).authority).toEqual({ kind: "none", actor: null, authority_epoch: 1, downgraded: "revoked" });
    h.outbox.close();
  });
  it("loopback_only on: a lan receipt reads none, a loopback one stays", () => {
    const h = fm({ verified_authority: { enabled: true } });
    h.s.webAuthorityState();
    const lan = h.receive(webHumanOrigin(false, webSession(1, "lan"))), local = h.receive(webHumanOrigin(false, webSession(1)));
    h.s.fleetConfig.web = { verified_authority: { enabled: true, loopback_only: true } };
    expect(h.status(lan).authority.downgraded).toBe("loopback_only");
    expect(h.status(local).authority.kind).toBe("web-session");
    h.outbox.close();
  });
  it("Revoke web authority: every earlier web-session receipt reads revoked; the switch stays on", () => {
    const h = fm({ verified_authority: { enabled: true } });
    h.s.webAuthorityState();
    const id = h.receive(webHumanOrigin(false, webSession(1)));
    expect(h.s.revokeWebAuthority()).toEqual({ epoch: 2, durable: true });
    expect(h.status(id).authority.downgraded).toBe("revoked");
    expect(h.s.webAuthorityState().enabled).toBe(true);
    expect(JSON.parse(readFileSync(join(h.dir, "web-authority.json"), "utf8")).epoch).toBe(2);
    h.outbox.close();
  });
  it("a platform receipt: unchanged, with the enforced list in force (the user's)", () => {
    const h = fm({ verified_authority: { step_up: { enforce: ["merge"] } } });
    const item = h.status(h.receive(nativeHumanOrigin("telegram", "owner", "7", "bo", false, "1")!));
    expect(item.authority).toEqual({ kind: "platform", actor: { adapter_id: "owner", user_id: "7" }, authority_epoch: 0 });
    expect(item.step_up_policy.enforced).toEqual(["merge"]);
    expect(item.source_instance).toBe("human:telegram:7");
    h.outbox.close();
  });
  it("#2112 review: while the state cannot be written, admission refuses (no web-session receipt to revive later)", async () => {
    const h = fm({ verified_authority: { enabled: true } });
    expect(h.s.webAuthorityState().enabled).toBe(true);
    h.s.authorityStateStore = new AuthorityStateStore(join(h.dir, "web-authority.json"), { warn: vi.fn() },
      { read: () => JSON.stringify({ v: 1, epoch: 1, enabled: false, loopback_only: false }), write: () => { throw new Error("EROFS"); } });
    const session = { handle: "a1b2c3d4e5f60718", idHash: "x".repeat(64), created: Date.now(), lastSeen: Date.now(), absoluteExpiry: Date.now() + 1e9, idleExpiry: Date.now() + 1e9,
      tier: "admin", surface: "local", label: "x", tokenEpoch: tokenEpoch("c".repeat(48)), owner: { adapterId: "owner", userId: "admin" } };
    h.s.adminGate = () => "ok"; h.s.getInstanceAdapterId = () => "owner";                // were the switch read from config, this would be token_rotated
    expect(h.s.webAuthority({ session, gateway: false, peer: "loopback", instance: "general" }).refusal).toBe("disabled");
    h.outbox.close();
  });
  it("#2112 review: web-authority.json deleted after receipts were written: they read revoked, never back", () => {
    const h = fm({ verified_authority: { enabled: true } });
    h.s.webAuthorityState(); h.s.revokeWebAuthority();                                     // epoch 2
    const id = h.receive(webHumanOrigin(false, webSession(2)));
    expect(h.status(id).authority.kind).toBe("web-session");
    rmSync(join(h.dir, "web-authority.json"));
    h.s.authorityStateStore = null;                                                       // as a restart reads it again
    expect(h.status(id).authority.downgraded).toBe("revoked");
    expect(h.s.webAuthorityState().epoch).toBeGreaterThan(2);
    h.outbox.close();
  });
  it("no data directory: off", () => {
    const s: any = Object.assign(Object.create(FleetManager.prototype), { fleetConfig: { instances: {}, web: { verified_authority: { enabled: true } } } });
    expect(s.webAuthorityState()).toEqual({ enabled: false, loopbackOnly: true, epoch: 0 });
  });
});

describe("/web revoke also revokes web authority", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  it("revokeWebSessions moves the epoch, and says so in durable", () => {
    const fm = new FleetManager(dir), s = fm as any;
    fm.fleetConfig = { defaults: {}, instances: {}, web: { verified_authority: { enabled: true } } } as never;
    writeFileSync(join(dir, "web.token"), "c".repeat(48), { mode: 0o600 }); s.initializeWebSessions();
    s.webSessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: tokenEpoch("c".repeat(48)), owner: { adapterId: "owner", userId: "admin" } });
    expect(s.webAuthorityState().epoch).toBe(1);
    expect(s.revokeWebSessions()).toEqual({ count: 1, durable: true });
    expect(s.webAuthorityState().epoch).toBe(2);
  });
});
