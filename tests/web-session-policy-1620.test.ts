/**
 * #1620 (baseline: the maintainer's comment on the issue): the LOCAL web session limits are configurable —
 * `web.session.local.absolute_hours` / `idle_hours`, defaults 12 / 2, 1 ≤ idle ≤ absolute ≤ 720 — and the public
 * link's stay fixed. The store reads the policy at every check: shortening ends the sessions it now outlives;
 * lengthening gives new sessions the new windows (and an existing one's idle window on its next use) but never
 * revives or raises an existing session's absolute limit. The real WebSessionStore on a fake clock; the real
 * validator; the fleet's wiring.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateFleetConfig } from "../src/config-validator.js";
import { DEFAULT_SESSION_POLICY, localSessionPolicy, tokenEpoch, WebSessionStore, type SessionPolicy } from "../src/web-session.js";

const H = 3_600_000, M = 60_000;
const EPOCH = tokenEpoch("t".repeat(48));
const homes: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const h of homes.splice(0)) { try { rmSync(h, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a late log line */ } } });
const home = () => { const h = mkdtempSync(join(tmpdir(), "agend-test-1620-")); homes.push(h); return h; };

/** A store whose local policy is `policy.current`, on a clock the test moves. */
function world(local: SessionPolicy, dataDir?: string) {
  const clock = { now: Date.UTC(2026, 9, 11) };
  const policy = { current: local };
  const store = new WebSessionStore({ now: () => clock.now, localPolicy: () => policy.current, ...(dataDir ? { dataDir } : {}) });
  const signIn = (surface: "local" | "gateway" = "local") => store.create({ tier: "admin", surface, label: "t", tokenEpoch: EPOCH, ...(surface === "gateway" ? { exposureId: "e".repeat(32) } : {}) });
  const auth = (id: string, touch = false, surface: "local" | "gateway" = "local") => store.authenticate(id, EPOCH, { touch, surface, ...(surface === "gateway" ? { exposureId: "e".repeat(32) } : {}) });
  return { clock, policy, store, signIn, auth };
}
const errorsOf = (web: unknown) => validateFleetConfig({ instances: {}, web }).errors.map(e => `${e.path}: ${e.message}`);

describe("the setting: web.session.local", () => {
  it("defaults stay 12 / 2: nothing set, nothing changes", () => {
    expect(localSessionPolicy(undefined)).toEqual(DEFAULT_SESSION_POLICY.local);
    expect(DEFAULT_SESSION_POLICY.local).toEqual({ absoluteMs: 12 * H, idleMs: 2 * H });
    expect(errorsOf({})).toEqual([]);
  });
  it("the validator: 1 ≤ idle ≤ absolute ≤ 720 hours, decimals allowed; one left out compares against its default", () => {
    expect(errorsOf({ session: { local: { absolute_hours: 720, idle_hours: 720 } } })).toEqual([]);
    expect(errorsOf({ session: { local: { absolute_hours: 24, idle_hours: 1.5 } } })).toEqual([]);
    expect(errorsOf({ session: { local: { idle_hours: 8 } } })).toEqual([]);
    expect(errorsOf({ session: { local: { idle_hours: 24 } } })).toEqual(["web.session.local.idle_hours: must not exceed absolute_hours (24 > 12, the default)"]);
    expect(errorsOf({ session: { local: { absolute_hours: 1 } } })).toEqual(["web.session.local.idle_hours: must not exceed absolute_hours (2 > 1; idle_hours is the default)"]);
    expect(errorsOf({ session: { local: { absolute_hours: 721 } } })).toEqual(["web.session.local.absolute_hours: must be a number of hours from 1 to 720"]);
    expect(errorsOf({ session: { local: { idle_hours: 0.5 } } })).toEqual(["web.session.local.idle_hours: must be a number of hours from 1 to 720"]);
    expect(errorsOf({ session: { local: { idle_hours: "24" } } })).toEqual(["web.session.local.idle_hours: must be a number of hours from 1 to 720"]);
    expect(errorsOf({ session: { local: { absolute_hours: 10, idle_hours: 20 } } })).toEqual(["web.session.local.idle_hours: must not exceed absolute_hours (20 > 10)"]);
  });
  it("the public link's limits are not configurable; unknown keys are named", () => {
    expect(errorsOf({ session: { gateway: { idle_hours: 24 } } })).toEqual(["web.session.gateway: is not configurable: a public-link session's limits are fixed"]);
    expect(errorsOf({ session: { local: { absolute: 24 } } })).toEqual(["web.session.local.absolute: unknown key (absolute_hours, idle_hours)"]);
    expect(errorsOf({ session: 24 })).toEqual(["web.session: must be a mapping"]);
  });
  it("defensive: a value the validator would refuse never gives a looser policy than the default", () => {
    expect(localSessionPolicy({ absolute_hours: 9999, idle_hours: 9999 })).toEqual(DEFAULT_SESSION_POLICY.local);
    expect(localSessionPolicy({ absolute_hours: 10, idle_hours: 20 })).toEqual(DEFAULT_SESSION_POLICY.local);
    expect(localSessionPolicy({ absolute_hours: 720, idle_hours: 720 })).toEqual({ absoluteMs: 720 * H, idleMs: 720 * H });
  });
});

describe("the store keeps the configured limits", () => {
  it("a session ends at the configured idle time, and at the configured absolute time however it is used", () => {
    const w = world({ absoluteMs: 30 * H, idleMs: 6 * H });
    const a = w.signIn();
    w.clock.now += 6 * H - 1;
    expect(w.auth(a.sessionId)).not.toBeNull();
    w.clock.now += 1;
    expect(w.auth(a.sessionId), "6 h unused").toBeNull();
    const b = w.signIn();
    for (let t = 0; t < 29; t++) { w.clock.now += H; expect(w.auth(b.sessionId, true), `used every hour, ${t + 1} h`).not.toBeNull(); }
    w.clock.now += H;
    expect(w.auth(b.sessionId, true), "30 h after sign-in, used or not").toBeNull();
  });
  it("the public link's sessions keep their fixed 4 h / 30 min, whatever the local policy says", () => {
    const w = world({ absoluteMs: 720 * H, idleMs: 720 * H });
    const g = w.signIn("gateway");
    w.clock.now += 30 * M;
    expect(w.auth(g.sessionId, false, "gateway")).toBeNull();
    expect([w.store.idleWindowMs("gateway"), w.store.idleWindowMs("local")]).toEqual([30 * M, 720 * H]);
  });
  it("shortening ends the sessions it now outlives — idle and absolute", () => {
    const w = world({ absoluteMs: 12 * H, idleMs: 2 * H });
    const idle = w.signIn(), absolute = w.signIn();
    w.clock.now += 90 * M;
    w.auth(absolute.sessionId, true);
    w.policy.current = { absoluteMs: 12 * H, idleMs: 1 * H };          // idle cut to 1 h: `idle` was unused for 90 min
    expect([w.auth(idle.sessionId), !!w.auth(absolute.sessionId, true)]).toEqual([null, true]);
    w.clock.now += 50 * M;                                            // 2 h 20 min after sign-in, used 50 min ago
    w.policy.current = { absoluteMs: 2 * H, idleMs: 1 * H };          // absolute cut to 2 h
    expect(w.auth(absolute.sessionId), "older than the new absolute limit").toBeNull();
  });
  it("what the page is told follows a shortened policy (list, the record's own limits)", () => {
    const w = world({ absoluteMs: 12 * H, idleMs: 2 * H });
    const s = w.signIn();
    w.policy.current = { absoluteMs: 3 * H, idleMs: 1 * H };
    const r = w.auth(s.sessionId)!;
    expect([r.absoluteExpiry - r.created, r.idleExpiry - r.created]).toEqual([3 * H, 1 * H]);
    expect(w.store.list().map(x => [x.absoluteExpiry - x.created, x.idleExpiry - x.created])).toEqual([[3 * H, 1 * H]]);
  });
  it("lengthening: new sessions get the new windows; an existing one's idle window moves on its next use, its absolute limit never", () => {
    const w = world({ absoluteMs: 12 * H, idleMs: 2 * H });
    const old = w.signIn();
    w.policy.current = { absoluteMs: 48 * H, idleMs: 6 * H };
    w.clock.now += H;
    expect(w.auth(old.sessionId, true)).not.toBeNull();               // used: idle limit now +6 h
    w.clock.now += 5 * H;
    expect(w.auth(old.sessionId, true), "6 h window after the lengthening").not.toBeNull();
    const fresh = w.signIn();
    expect(fresh.record.absoluteExpiry - fresh.record.created, "a new session: 48 h").toBe(48 * H);
    w.clock.now += 5 * H;                                             // 11 h after old's sign-in: used, so not idle
    expect(w.auth(old.sessionId, true)).not.toBeNull();
    w.clock.now += H + 1;                                             // 12 h after sign-in, used 1 h ago
    expect(w.auth(old.sessionId), "its 12 h absolute limit was not raised (it was used an hour ago)").toBeNull();
  });
  it("a policy shortened while the fleet was down applies when the sessions are read back", () => {
    const dir = home();
    const before = world({ absoluteMs: 12 * H, idleMs: 2 * H }, dir);
    const s = before.signIn();
    before.clock.now += 90 * M;
    before.store.flush();
    const after = new WebSessionStore({ dataDir: dir, now: () => before.clock.now, localPolicy: () => ({ absoluteMs: 12 * H, idleMs: 1 * H }) });
    expect(after.size, "not even read back").toBe(0);
    expect(after.authenticate(s.sessionId, EPOCH, { touch: false })).toBeNull();
  });
  it("sign-out, sign out everywhere and a rotated token still end sessions", () => {
    const w = world({ absoluteMs: 720 * H, idleMs: 720 * H });
    const a = w.signIn(), b = w.signIn(), c = w.signIn();
    w.store.revokeById(a.sessionId);
    expect(w.auth(a.sessionId)).toBeNull();
    expect(w.store.authenticate(b.sessionId, tokenEpoch("u".repeat(48)), { touch: false })).toBeNull();
    w.store.revokeAll();
    expect(w.auth(c.sessionId)).toBeNull();
  });
});

describe("the fleet reads fleet.yaml's setting at every check", () => {
  it("initializeWebSessions wires web.session.local; a change to the config applies at once; the gateway stays fixed", async () => {
    const h = home();
    vi.stubEnv("AGEND_HOME", h);
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(h) as any;
    clearInterval(fm.sessionPruneTimer);
    fm.fleetConfig = { defaults: {}, instances: {}, web: { session: { local: { absolute_hours: 72, idle_hours: 24 } } } };
    fm.initializeWebSessions();
    expect([fm.webSessions.idleWindowMs("local"), fm.webSessions.idleWindowMs("gateway")]).toEqual([24 * H, 30 * M]);
    fm.fleetConfig.web.session.local.idle_hours = 3;                  // a Settings save or a reload
    expect(fm.webSessions.idleWindowMs("local")).toBe(3 * H);
    delete fm.fleetConfig.web;
    expect(fm.webSessions.idleWindowMs("local")).toBe(2 * H);
  });
});
