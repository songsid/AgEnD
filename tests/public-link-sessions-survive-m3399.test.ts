/**
 * M-3399 (the user: "after an update or a restart the dashboard asks me to sign in again"): a session made over the FIXED
 * public link (a named tunnel: the same hostname and token every time) outlives a fleet restart or update.
 * - PublicWebLink: a close because the fleet stops ({ keepNamedSessions }) tells revoke to keep a fixed link's sessions; any
 *   other close (Close, /web revoke, expiry, a policy/hostname/token change) revokes as before; a quick link always revokes
 *   (its next hostname is a new one). Open again, the fixed link reports its identity (opened) — and keyOf names it.
 * - WebSessionStore: a session over the fixed link carries that identity (linkKey), persisted; after a restart the link's
 *   next exposure takes it back (adoptLink) — it authenticates there, keeps its own expiry; sessions kept for another
 *   hostname/token end; a quick link's and local sessions are untouched.
 * - The fleet's wiring (the link's deps): kept on the fleet stop (with their verified authority), revoked otherwise; on the
 *   reopen the kept sessions rejoin and another identity's end with their authorizations.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syntheticTunnelToken } from "./helpers/named-tunnel-token.js";
import { PublicWebLink } from "../src/public-web-link.js";
import { PUBLIC_TUNNEL_TOKEN_ENV as ENV } from "../src/public-tunnel-config.js";
import { WebSessionStore } from "../src/web-session.js";
import { FleetManager } from "../src/fleet-manager.js";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: () => { throw Error("no processes"); } }));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env[ENV]; });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "m3399-")); dirs.push(d); return d; };
const HOST = "agend.example.com";
const named = { public_link: { allow_public: true, hostname: HOST, tunnel_token_env: ENV, ttl_minutes: 0 } };
const quick = { public_link: { allow_public: true, ttl_minutes: 30 } };
const owner = { adapterId: "discord", userId: "admin", chatId: "G", threadId: "T", binding: {} };
const EPOCH = "e".repeat(64), KEY = "a".repeat(64), OTHER = "b".repeat(64);
const E1 = "1".repeat(32), E2 = "2".repeat(32);

function link(web: any) {
  process.env[ENV] = syntheticTunnelToken();
  const gateway = { listen: vi.fn(async () => new URL("http://127.0.0.1:19282")), setHost: vi.fn(), close: vi.fn(), readinessMarker: "m", server: {} };
  const handle = { pageUrl: `https://${web.public_link.hostname ?? "random.trycloudflare.com"}/signin`, onUnexpectedExit: () => () => {} };
  const reservation = { start: vi.fn(async () => ({ ok: true, handle })), stop: vi.fn(async () => ({ confirmed: true })) };
  const revoke = vi.fn(), opened = vi.fn();
  const l = new PublicWebLink({ dataDir: "/fixture", web: () => web, permitted: () => true, reserve: () => reservation as any,
    createGateway: (() => gateway) as any, provider: () => ({}) as any, ensure: async () => ({ path: "/inert", source: "agend" }), log: vi.fn(),
    revoke, opened, now: () => 0, wallNow: () => 1_000_000 } as any);
  return { l, revoke, opened };
}

describe("M-3399: PublicWebLink — the fleet stopping keeps a fixed link's sessions; nothing else does", () => {
  it("fixed link: opened reports its identity; a fleet-stop close keeps; Close revokes", async () => {
    const a = link(named); let id = "";
    expect(await a.l.deliver(owner, async d => { id = d.exposureId; return true; })).toBe(true);
    const key = a.l.keyOf(id);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(a.opened).toHaveBeenCalledWith(id, key);
    await a.l.close("fleet shutdown", undefined, { keepNamedSessions: true });
    expect(a.revoke.mock.calls).toEqual([[id, { keepSessions: true, configuration: key }]]);
    const b = link(named); let id2 = "";
    await b.l.deliver(owner, async d => { id2 = d.exposureId; return true; });
    await b.l.close("admin close");
    expect(b.revoke.mock.calls).toEqual([[id2]]);
  });
  it("quick link: no identity, never reported, and a fleet-stop close still revokes", async () => {
    const q = link(quick); let id = "";
    await q.l.deliver(owner, async d => { id = d.exposureId; return true; });
    expect([q.l.keyOf(id), q.opened.mock.calls.length]).toEqual([null, 0]);
    await q.l.close("fleet shutdown", undefined, { keepNamedSessions: true });
    expect(q.revoke.mock.calls).toEqual([[id]]);
  });
});

describe("M-3399: WebSessionStore — a fixed link's session outlives a restart and rejoins the link", () => {
  const store = (dataDir: string, keys: Record<string, string> = {}) =>
    new WebSessionStore({ dataDir, linkKeyOf: id => keys[id] ?? null, exposureEnd: () => null });
  it("carries the link's identity, persisted; after a restart the next exposure takes it back; another identity's end", () => {
    const dir = tmp();
    const s1 = store(dir, { [E1]: KEY });
    const fixed = s1.create({ tier: "admin", surface: "gateway", label: "phone", tokenEpoch: EPOCH, exposureId: E1 });
    const local = s1.create({ tier: "admin", surface: "local", label: "desk", tokenEpoch: EPOCH });
    expect(fixed.record.linkKey).toBe(KEY);
    s1.flush?.();
    // Restart: a new store reads the file. Until the link opens again, nothing over it answers.
    const s2 = store(dir);
    expect(s2.authenticate(fixed.sessionId, EPOCH, { surface: "gateway", exposureId: E2 })).toBeNull();
    const r = s2.adoptLink(KEY, E2);
    expect([r.adopted, r.ended]).toEqual([1, []]);
    expect(s2.authenticate(fixed.sessionId, EPOCH, { surface: "gateway", exposureId: E2 })?.handle).toBe(fixed.record.handle);
    expect(s2.authenticate(fixed.sessionId, EPOCH, { surface: "gateway", exposureId: E1 })).toBeNull();
    expect(s2.authenticate(local.sessionId, EPOCH)?.handle).toBe(local.record.handle);
    // The hostname or token changed while it was down: another identity — the kept session ends.
    const s3 = store(dir);
    const r3 = s3.adoptLink(OTHER, "3".repeat(32));
    expect([r3.adopted, r3.ended]).toEqual([0, [fixed.record.handle]]);
    expect(store(dir).authenticate(fixed.sessionId, EPOCH, { surface: "gateway", exposureId: E2 })).toBeNull();
  });
  it("a quick link's session has no identity and is never taken back", () => {
    const dir = tmp(), s = store(dir);
    const q = s.create({ tier: "admin", surface: "gateway", label: "phone", tokenEpoch: EPOCH, exposureId: E1 });
    expect(q.record.linkKey).toBeUndefined();
    expect(s.adoptLink(KEY, E2)).toMatchObject({ adopted: 0, ended: [] });
    expect(s.authenticate(q.sessionId, EPOCH, { surface: "gateway", exposureId: E2 })).toBeNull();
  });
});

describe("M-3399: the fleet's wiring (the link's deps)", () => {
  function fleet() {
    const dir = tmp();
    const sessions = new WebSessionStore({ dataDir: dir, linkKeyOf: id => (id === E1 ? KEY : null) });
    const prune = vi.fn();
    const m = Object.assign(Object.create(FleetManager.prototype), {
      dataDir: dir, fleetConfig: { web: named, instances: {} }, webSessions: sessions,
      webLoginCodes: { revokeAudience: vi.fn() }, webGuestLoginCodes: { revokeAudience: vi.fn() },
      sessionAuthorizationStore: () => ({ prune }), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      initializeWebSessions: () => {},
    });
    // 2.3.x builds the link's wiring inline in getPublicWebLink() (the dev branch: publicWebLinkDeps()).
    return { deps: (m as any).getPublicWebLink().deps, sessions, prune };
  }
  it("the fleet stop keeps the fixed link's sessions (and their authorizations); a close revokes them", () => {
    const f = fleet();
    const s = f.sessions.create({ tier: "admin", surface: "gateway", label: "phone", tokenEpoch: EPOCH, exposureId: E1 });
    f.deps.revoke(E1, { keepSessions: true, configuration: KEY });
    expect([f.sessions.list().map(r => r.handle), f.prune.mock.calls.length]).toEqual([[s.record.handle], 0]);
    f.deps.revoke(E1);
    expect(f.sessions.list()).toEqual([]);
  });
  it("open again: the kept session rejoins; one kept for another identity ends with its authorizations", () => {
    const f = fleet();
    const kept = f.sessions.create({ tier: "admin", surface: "gateway", label: "phone", tokenEpoch: EPOCH, exposureId: E1 });
    f.deps.opened(E2, KEY);
    expect(f.sessions.authenticate(kept.sessionId, EPOCH, { surface: "gateway", exposureId: E2 })?.handle).toBe(kept.record.handle);
    f.deps.opened("3".repeat(32), OTHER);
    expect(f.sessions.list()).toEqual([]);
    expect(f.prune).toHaveBeenCalledTimes(1);
    const keep = f.prune.mock.calls[0]![0] as (a: { handle: string }) => boolean;
    expect([keep({ handle: kept.record.handle }), keep({ handle: "other" })]).toEqual([false, true]);
  });
});

describe("M-3399: the fleet stop asks the link to keep a fixed link's sessions", () => {
  it("doStopAll closes the public link as \"fleet shutdown\" with keepNamedSessions", async () => {
    const close = vi.fn(async () => ({ confirmed: true }));
    const m = Object.assign(Object.create(FleetManager.prototype), {
      lifecycle: { daemons: new Map() }, adapterState: new Map(), adapters: new Map(), publicWebLink: { close },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    // The rest of the stop is not this test's: it runs as far as the stubs carry it.
    await Promise.race([(m as any).doStopAll().catch(() => undefined), new Promise(r => setTimeout(r, 300))]);
    expect(close).toHaveBeenCalledWith("fleet shutdown", undefined, { keepNamedSessions: true });
  });
});
