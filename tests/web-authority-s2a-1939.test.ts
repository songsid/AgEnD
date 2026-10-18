/**
 * #1939 S2a: the server switch and the revocation epoch (§10), sessions authorized once (§0), and how delivery_status
 * reads a receipt's authority now. docs/design/1939-verified-web-sessions.md.
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
import { SessionAuthorizations, SESSION_AUTHORIZATIONS_MAX, type SessionAuthorizationsIo } from "../src/authority/session-authorizations.js";
import { AuthorityStateStore, type AuthorityStateIo } from "../src/authority/authority-state.js";
import { authorityNow, evaluateWebAuthority, type HumanAuthority } from "../src/authority/web-authority.js";
import Database from "better-sqlite3";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-1939-s2a-")); dirs.push(d); return d; };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const webSession = (epoch: number, peer: "loopback" | "lan" = "loopback"): HumanAuthority => ({ kind: "web-verified", actor: { adapter_id: "owner", user_id: "admin" },
  session: { handle: "a1b2c3d4e5f60718", peer, signed_in_at: "2026-10-18T09:00:00.000Z", authorized_at: "2026-10-18T09:05:00.000Z" }, authority_epoch: epoch });

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
  it("a fresh fleet: on by default (§0.1) — the first read records it and moves the epoch past 0", () => {
    const m = memIo(); const s = new AuthorityStateStore("/s.json", log(), m.io);
    expect(s.current(undefined)).toEqual({ enabled: true, loopbackOnly: false, epoch: 1 });
    expect(m.stored()).toEqual({ v: 1, epoch: 1, enabled: true, loopback_only: false });
    expect(s.current({ enabled: false })).toEqual({ enabled: false, loopbackOnly: false, epoch: 2 });
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
    expect(new AuthorityStateStore("/s.json", log(), memIo().io, () => 1_000, () => 40).current({ enabled: false }).epoch).toBe(41);
    // A file at epoch 2 while a receipt carries 5.
    const behind = memIo(JSON.stringify({ v: 1, epoch: 2, enabled: true, loopback_only: false }));
    expect(new AuthorityStateStore("/s.json", log(), behind.io, () => 1_000, () => 5).current({ enabled: true }).epoch).toBe(7);   // 6, then on: 7
    // At the receipts' epoch: trusted as written.
    const level = memIo(JSON.stringify({ v: 1, epoch: 5, enabled: true, loopback_only: false }));
    expect(new AuthorityStateStore("/s.json", log(), level.io, () => 1_000, () => 5).current({ enabled: true }).epoch).toBe(5);
    // Missing with no receipts: a fresh fleet.
    expect(new AuthorityStateStore("/s.json", log(), memIo().io, () => 1_000, () => 0).current({ enabled: false }).epoch).toBe(0);
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
  it("web-verified stays while on, at the current epoch", () => {
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
    expect(authorityNow(webSession(3), { ...on, loopbackOnly: true }).kind).toBe("web-verified");
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
    const r = evaluateWebAuthority({ session: null, gateway: true, peer: "lan", tokenEpoch: null, isAdmin: () => true, authorization: null,
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
  it("the switch off: admission refuses; on: the first read moves the epoch, and a receipt reads web-verified", () => {
    const h = fm({ verified_authority: { enabled: false } });
    expect(h.s.webAuthority({ session: null, gateway: false, peer: "loopback" }).refusal).toBe("disabled");
    h.s.fleetConfig.web = { verified_authority: { enabled: true } };
    expect(h.s.webAuthorityState()).toEqual({ enabled: true, loopbackOnly: false, epoch: 1 });
    expect(h.s.webAuthority({ session: null, gateway: false, peer: "loopback" }).refusal).toBe("not_session");
    const id = h.receive(webHumanOrigin(false, webSession(1)));
    const item = h.status(id);
    expect(item.authority).toEqual(webSession(1));
    expect(item.source_instance).toBe("human:web:owner:admin");
    expect(item).not.toHaveProperty("step_up_policy");                                 // §0: no step-up list any more
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
    expect(h.status(local).authority.kind).toBe("web-verified");
    h.outbox.close();
  });
  it("Revoke web authority: every earlier web-verified receipt reads revoked; the switch stays on", () => {
    const h = fm({ verified_authority: { enabled: true } });
    h.s.webAuthorityState();
    const id = h.receive(webHumanOrigin(false, webSession(1)));
    expect(h.s.revokeWebAuthority()).toEqual({ epoch: 2, durable: true });
    expect(h.status(id).authority.downgraded).toBe("revoked");
    expect(h.s.webAuthorityState().enabled).toBe(true);
    expect(JSON.parse(readFileSync(join(h.dir, "web-authority.json"), "utf8")).epoch).toBe(2);
    h.outbox.close();
  });
  it("a platform receipt: unchanged, whatever the switch", () => {
    const h = fm({ verified_authority: { enabled: false } });
    const item = h.status(h.receive(nativeHumanOrigin("telegram", "owner", "7", "bo", false, "1")!));
    expect(item.authority).toEqual({ kind: "platform", actor: { adapter_id: "owner", user_id: "7" }, authority_epoch: 0 });
    expect(item.source_instance).toBe("human:telegram:7");
    h.outbox.close();
  });
  it("#2112 review: while the state cannot be written, admission refuses (no web-verified receipt to revive later)", async () => {
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
    expect(h.status(id).authority.kind).toBe("web-verified");
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

const HOUR_MS = 3_600_000;
describe("§0 sessions authorized once: the store", () => {
  const H = "a1b2c3d4e5f60718", OWNER = { adapterId: "owner", userId: "admin" };
  function mem(initial?: string) {
    const files = new Map<string, string>(initial === undefined ? [] : [["/a.json", initial]]);
    const io: SessionAuthorizationsIo & { fail: boolean } = { fail: false,
      read: p => { const v = files.get(p); if (v === undefined) throw Object.assign(new Error("no"), { code: "ENOENT" }); return v; },
      write: (p, d) => { if (io.fail) throw new Error("EROFS"); files.set(p, d); } };
    return { io, files, stored: () => JSON.parse(files.get("/a.json")!) };
  }
  it("authorize, get, kept across a restart (the file)", () => {
    const m = mem(); const s = new SessionAuthorizations("/a.json", log(), m.io);
    expect(s.get(H)).toBeNull();
    expect(s.authorize(H, OWNER, 1_000, 3, 1_000 + HOUR_MS)).toEqual({ authorization: { handle: H, owner: OWNER, authorizedAt: 1_000, until: 1_000 + HOUR_MS, epoch: 3 }, durable: true });
    expect(m.stored()).toEqual({ v: 1, authorizations: [{ handle: H, owner: OWNER, authorizedAt: 1_000, until: 1_000 + HOUR_MS, epoch: 3 }] });
    expect(new SessionAuthorizations("/a.json", log(), m.io).get(H)).toEqual({ handle: H, owner: OWNER, authorizedAt: 1_000, until: 1_000 + HOUR_MS, epoch: 3 });
  });
  it("a second authorization replaces the first; a bad one is refused", () => {
    const s = new SessionAuthorizations("/a.json", log(), mem().io);
    s.authorize(H, OWNER, 1_000, 1, 1_000 + HOUR_MS); s.authorize(H, OWNER, 2_000, 2, 2_000 + HOUR_MS);
    expect(s.list()).toEqual([{ handle: H, owner: OWNER, authorizedAt: 2_000, until: 2_000 + HOUR_MS, epoch: 2 }]);
    expect(() => s.authorize("not-a-handle", OWNER, 1, 1, 1 + HOUR_MS)).toThrow(/invalid/);
    expect(() => s.authorize(H, { adapterId: "", userId: "x" }, 1, 1, 1 + HOUR_MS)).toThrow(/invalid/);
  });
  it("#2112 review: a file of another version keeps none; a record with a negative epoch is skipped", () => {
    expect(new SessionAuthorizations("/a.json", log(), mem(JSON.stringify({ v: 2, authorizations: [{ handle: H, owner: OWNER, authorizedAt: 5, until: 5 + HOUR_MS, epoch: 1 }] })).io).list()).toEqual([]);
    expect(new SessionAuthorizations("/a.json", log(), mem(JSON.stringify({ v: 1, authorizations: [{ handle: H, owner: OWNER, authorizedAt: 5, epoch: -1 }] })).io).list()).toEqual([]);
  });
  it("S2c: a stored record must say until when — none, not a number, or not after it was given: skipped", () => {
    const load = (rec: Record<string, unknown>) => new SessionAuthorizations("/a.json", log(), mem(JSON.stringify({ v: 1, authorizations: [{ handle: H, owner: OWNER, authorizedAt: 5, epoch: 1, ...rec }] })).io).list();
    expect(load({})).toEqual([]);
    expect(load({ until: "later" })).toEqual([]);
    expect(load({ until: 5 })).toEqual([]);
    expect(load({ until: 5 + HOUR_MS }).map(a => a.until), "the positive control").toEqual([5 + HOUR_MS]);
  });
  it("unreadable or malformed: none kept (losing them never grants one); a malformed entry is skipped", () => {
    const l = log();
    expect(new SessionAuthorizations("/a.json", l, mem("{broken").io).list()).toEqual([]);
    expect(l.warn).toHaveBeenCalledTimes(1);
    const mixed = JSON.stringify({ v: 1, authorizations: [{ handle: H, owner: OWNER, authorizedAt: 5, until: 5 + HOUR_MS, epoch: 1 }, { handle: "x", owner: OWNER, authorizedAt: 5, until: 5 + HOUR_MS, epoch: 1 }, { handle: "b".repeat(16), owner: {}, authorizedAt: 5, until: 5 + HOUR_MS, epoch: 1 }] });
    expect(new SessionAuthorizations("/a.json", log(), mem(mixed).io).list().map(a => a.handle)).toEqual([H]);
  });
  it("not saved: it holds for now (only a restart forgets it), said once", () => {
    const l = log(); const m = mem(); const s = new SessionAuthorizations("/a.json", l, m.io);
    m.io.fail = true;
    expect(s.authorize(H, OWNER, 1, 1, 1 + HOUR_MS).durable).toBe(false);
    s.authorize("b".repeat(16), OWNER, 1, 1, 1 + HOUR_MS);
    expect(s.get(H)).not.toBeNull();
    expect(l.warn).toHaveBeenCalledTimes(1);
  });
  it("prune drops what fails the test and saves; capped, oldest out", () => {
    const m = mem(); const s = new SessionAuthorizations("/a.json", log(), m.io);
    s.authorize(H, OWNER, 1, 1, 1 + HOUR_MS); s.authorize("b".repeat(16), OWNER, 2, 2, 2 + HOUR_MS);
    expect(s.prune(a => a.epoch === 2)).toBe(1);
    expect(m.stored().authorizations.map((a: any) => a.handle)).toEqual(["b".repeat(16)]);
    for (let i = 0; i <= SESSION_AUTHORIZATIONS_MAX; i++) s.authorize(i.toString(16).padStart(16, "0"), OWNER, 10 + i, 2, 10 + i + HOUR_MS);
    expect(s.list().length).toBe(SESSION_AUTHORIZATIONS_MAX);
    expect(s.get("b".repeat(16))).toBeNull();
  });
  it("authorizing a session again moves it to the back: at the cap the oldest authorization goes first", () => {
    const s = new SessionAuthorizations("/a.json", log(), mem().io);
    const h = (i: number) => i.toString(16).padStart(16, "0");
    for (let i = 0; i < SESSION_AUTHORIZATIONS_MAX; i++) s.authorize(h(i), OWNER, 10 + i, 1, 10 + i + HOUR_MS);
    s.authorize(h(0), OWNER, 99_999, 1, 99_999 + HOUR_MS);                                                 // the first, given again
    s.authorize("e".repeat(16), OWNER, 100_000, 1, 100_000 + HOUR_MS);                                      // over the cap: one goes
    expect(s.get(h(0)), "renewed: kept").not.toBeNull();
    expect(s.get(h(1)), "now the oldest: dropped").toBeNull();
  });
  it("on disk: web-authorizations.json, owner-only", () => {
    const dir = tmp(); const s = new SessionAuthorizations(join(dir, "web-authorizations.json"), log());
    s.authorize(H, OWNER, 1, 1, 1 + HOUR_MS);
    expect(statSync(join(dir, "web-authorizations.json")).mode & 0o777).toBe(0o600);
  });
});

describe("§0 the FleetManager: a session is authorized once, then web-verified until it runs out or is revoked", () => {
  const TOKEN = "c".repeat(48);
  function rig() {
    const dir = tmp();
    const fm = new FleetManager(dir), s = fm as any;
    const owner = { id: "owner", type: "telegram", group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
    fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner], instances: { general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" } },
      web: { verified_authority: { enabled: true } } } as never;
    writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); s.initializeWebSessions();
    const session = (userId = "admin") => s.webSessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "owner", userId } }).record;
    const judge = (record: any, peer: "loopback" | "lan" = "loopback") => s.webAuthority({ session: record, gateway: false, peer, instance: "general" });
    return { s, dir, session, judge, close: () => { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); } };
  }
  it("not authorized: none (a qualifying session is still only recognition); authorized: web-verified, saying when", () => {
    const h = rig(); const r = h.session();
    expect(h.judge(r)).toMatchObject({ refusal: "not_authorized", authority: { kind: "none" } });
    const a = h.s.authorizeWebSession(r, "loopback", false);
    expect(a).toMatchObject({ ok: true, durable: true, authorization: { handle: r.handle, owner: { adapterId: "owner", userId: "admin" }, epoch: 1 } });
    const v = h.judge(r);
    expect(v.refusal).toBeNull();
    expect(v.authority).toMatchObject({ kind: "web-verified", actor: { adapter_id: "owner", user_id: "admin" }, session: { handle: r.handle, authorized_at: new Date(a.authorization.authorizedAt).toISOString() }, authority_epoch: 1 });
    h.close();
  });
  it("#2112 review: authorizing judges the request too — over the public link it is refused, whatever the session", () => {
    const h = rig();
    expect(h.s.authorizeWebSession(h.session(), "loopback", true)).toEqual({ ok: false, refusal: "public_link" });
    h.close();
  });
  it("authorizing refuses a session that does not qualify now, saying why", () => {
    const h = rig();
    expect(h.s.authorizeWebSession(h.session("stranger"), "loopback")).toEqual({ ok: false, refusal: "not_admin" });
    h.s.fleetConfig.web = { verified_authority: { enabled: true, loopback_only: true } };
    expect(h.s.authorizeWebSession(h.session(), "lan")).toEqual({ ok: false, refusal: "loopback_only" });
    h.s.fleetConfig.web = { verified_authority: { enabled: false } };
    expect(h.s.authorizeWebSession(h.session(), "loopback")).toEqual({ ok: false, refusal: "disabled" });
    const noAccount = h.s.webSessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: tokenEpoch(TOKEN) }).record;
    expect(h.s.authorizeWebSession(noAccount, "loopback", false)).toEqual({ ok: false, refusal: "no_account" });
    h.close();
  });
  it("one session's authorization is never another's, even the same account's", () => {
    const h = rig(); const a = h.session(), b = h.session();
    h.s.authorizeWebSession(a, "loopback", false);
    expect(h.judge(a).refusal).toBeNull();
    expect(h.judge(b).refusal).toBe("not_authorized");
    h.close();
  });
  it("ends: max_session_hours after the authorization (not after sign-in)", () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 18, 9, 0, 0));
    const h = rig(); const r = h.session();
    h.s.fleetConfig.web = { verified_authority: { enabled: true, max_session_hours: 2 } };
    vi.setSystemTime(Date.UTC(2026, 9, 18, 10, 30, 0));                                  // signed in 1.5 h ago
    h.s.authorizeWebSession(r, "loopback", false);
    vi.setSystemTime(Date.UTC(2026, 9, 18, 12, 30, 0));                                  // 3.5 h after sign-in, 2 h after authorizing
    expect(h.judge(r).refusal).toBeNull();
    vi.setSystemTime(Date.UTC(2026, 9, 18, 12, 30, 1));
    expect(h.judge(r).refusal).toBe("authorization_expired");
    h.close();
  });
  it("§0.1: a longer max_session_hours never stretches an authorization already given; a shorter one shortens it", () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 18, 9, 0, 0));
    const h = rig(); const r = h.session();
    h.s.fleetConfig.web = { verified_authority: { max_session_hours: 2 } };
    h.s.authorizeWebSession(r, "loopback", false);                                       // until 11:00
    h.s.fleetConfig.web = { verified_authority: { max_session_hours: 24 } };             // raised later
    vi.setSystemTime(Date.UTC(2026, 9, 18, 11, 0, 1));
    expect(h.judge(r).refusal, "the end it was given with").toBe("authorization_expired");
    vi.setSystemTime(Date.UTC(2026, 9, 18, 9, 0, 0));
    h.s.authorizeWebSession(r, "loopback", false);                                       // until 09:00 + 24 h
    h.s.fleetConfig.web = { verified_authority: { max_session_hours: 1 } };              // lowered later
    vi.setSystemTime(Date.UTC(2026, 9, 18, 10, 0, 1));
    expect(h.judge(r).refusal, "a shorter setting shortens it").toBe("authorization_expired");
    h.close();
  });
  it("ends: a revocation (epoch bump) — and authorizing again works under the new epoch", () => {
    const h = rig(); const r = h.session();
    h.s.authorizeWebSession(r, "loopback", false);
    h.s.revokeWebAuthority();
    expect(h.judge(r).refusal).toBe("not_authorized");
    expect(h.s.authorizeWebSession(r, "loopback", false)).toMatchObject({ ok: true, authorization: { epoch: 2 } });
    expect(h.judge(r).refusal).toBeNull();
    h.close();
  });
  it("ends: the switch off (and back on: a new epoch, so authorize again)", () => {
    const h = rig(); const r = h.session();
    h.s.authorizeWebSession(r, "loopback", false);
    h.s.fleetConfig.web = { verified_authority: { enabled: false } };
    expect(h.judge(r).refusal).toBe("disabled");
    h.s.fleetConfig.web = { verified_authority: { enabled: true } };
    expect(h.judge(r).refusal).toBe("not_authorized");
    h.close();
  });
  it("kept across a restart while its session lives (the file is read again)", () => {
    const h = rig(); const r = h.session();
    h.s.authorizeWebSession(r, "loopback", false);
    h.s.sessionAuthorizations = null;                                                     // as a restart reads the file again
    expect(h.judge(r).refusal).toBeNull();
    h.close();
  });
  it("stale authorizations are dropped when another is given: an old epoch; a session that is gone", () => {
    const h = rig(); const a = h.session(), b = h.session();
    h.s.authorizeWebSession(a, "loopback", false);
    h.s.revokeWebAuthority();
    h.s.authorizeWebSession(b, "loopback", false);
    expect(h.s.sessionAuthorizationStore().list().map((x: any) => x.handle), "a: an old epoch").toEqual([b.handle]);
    h.s.webSessions.revokeAll();                                                          // b's session is gone
    const c = h.session();
    h.s.authorizeWebSession(c, "loopback", false);
    expect(h.s.sessionAuthorizationStore().list().map((x: any) => x.handle), "b: its session gone").toEqual([c.handle]);
    h.close();
  });
});

describe("the configuration docs", () => {
  it("name the switch, only-this-computer and the hours, and no step-up list (§0)", () => {
    for (const file of ["docs/configuration.md", "docs/configuration.zh-TW.md"]) {
      const text = readFileSync(join(import.meta.dirname, "..", file), "utf8");
      const at = text.indexOf("verified_authority`"), part = text.slice(at, text.indexOf(" |", at));
      expect(at, file).toBeGreaterThan(0);
      for (const key of ["enabled", "loopback_only", "max_session_hours", "web-verified", "/web revoke"]) expect(part, `${file}: ${key}`).toContain(key);
      expect(part, file).not.toMatch(/step_up|enforce|custom/);
    }
  });
  it("fleet.yaml takes the three keys; a step_up left over is warned about and ignored", () => {
    const r = validateFleetConfig({ instances: {}, web: { verified_authority: { enabled: true, loopback_only: false, max_session_hours: 12, step_up: { enforce: ["merge"] } } } } as never);
    expect(r.errors.map(e => e.path).filter(p => p.startsWith("web."))).toEqual([]);
    expect(r.warnings.map(e => e.path).filter(p => p.startsWith("web."))).toEqual(["web.verified_authority.step_up"]);
  });
});
