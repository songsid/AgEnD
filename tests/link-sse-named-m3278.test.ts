/**
 * M-3278 (decision 7933bf90, the user's 「全開（只留技術限制）」) part 5: the live stream over the public link.
 * - The fixed (named) link only: a quick tunnel buffers a stream, so its page polls as before (the gateway refuses
 *   /ui/events there before anything is dispatched).
 * - An admin session only: a read-only session and a guest keep polling (404), and the page they load says "poll".
 * - At most LINK_STREAMS_MAX streams over the link at once (the gateway holds 32 connections in all): a page past it polls.
 * - A stream over the link ends at the next heartbeat once its link is no longer the current one, or its session ended.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { EventEmitter } from "node:events";
const { handleWebRequest, LINK_STREAMS_MAX } = await import("../src/web-api.js");
const { bindGatewayRequest } = await import("../src/web-request-context.js");
const { createPublicWebGateway, isPublicWebRoute } = await import("../src/public-web-gateway.js");
const { tokenEpoch, WebSessionStore } = await import("../src/web-session.js");
const { bindGuestRequest } = await import("../src/web-guest-access.js");

const TOKEN = "c".repeat(48), TICK = 10_000, HOST = "dash.example.org", EXPOSURE = "e".repeat(32);
let ctx: any, sessions: InstanceType<typeof WebSessionStore>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  sessions = new WebSessionStore();
  ctx = { webToken: TOKEN, webSessions: sessions, logger: { info() {}, debug() {}, warn() {}, error() {} }, sseClients: new Set(), sseHeartbeatMs: TICK,
    getUiStatus: () => ({ instances: [] }) };
});
afterEach(() => { vi.useRealTimers(); });

const session = (tier: "admin" | "read" | "guest") => sessions.create({ tier, surface: "gateway", exposureId: EXPOSURE, label: "t", tokenEpoch: tokenEpoch(TOKEN),
  ...(tier === "guest" ? { owner: { adapterId: "discord", userId: "111111111111111111" } } : {}) }).sessionId;

let lastRes: EventEmitter | null = null;
/** /ui/events as the gateway hands it to web-api: its context bound, the session's cookie. */
function open(sid: string, link: { named: boolean; current?: () => boolean } = { named: true }, guest = false) {
  const frames: string[] = [];
  let status = 0, ended = false, destroyed = false;
  const res = lastRes = Object.assign(new EventEmitter(), { headersSent: false, setHeader() {}, writeHead(c: number) { status = c; (res as any).headersSent = true; },
    write: (s: string) => { frames.push(s); return true; }, end: (a?: unknown) => { if (typeof a === "string") frames.push(a); ended = true; if (typeof a === "function") (a as () => void)(); } });
  const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/events", headers: { host: HOST, cookie: `__Host-agend_session=${sid}`, "sec-fetch-site": "same-origin" },
    socket: { remoteAddress: "127.0.0.1", destroy: () => { destroyed = true; } } });
  bindGatewayRequest(req, { surface: "gateway", named: link.named, exposureId: EXPOSURE, expectedOrigin: `https://${HOST}`, isCurrent: link.current ?? (() => true) });
  if (guest) bindGuestRequest(req, { owner: { adapterId: "discord", userId: "111111111111111111" }, scope: () => new Set(["a"]), current: () => true });
  expect(handleWebRequest(req as never, res as never, new URL("/ui/events", `https://${HOST}`), ctx)).toBe(true);
  return { res, frames, status: () => status, ended: () => ended, destroyed: () => destroyed };
}

describe("M-3278 5/5: the live stream on the fixed link, for an admin session", () => {
  it("an admin session on the fixed link gets the stream, as on this computer", () => {
    const s = open(session("admin"));
    expect(s.status()).toBe(200);
    expect(s.frames[0]).toMatch(/^event: status\n/);
    expect(ctx.sseClients.size).toBe(1);
  });
  it("a quick tunnel, a read-only session and a guest still poll: refused before any stream exists", () => {
    for (const [name, s] of [["quick tunnel", open(session("admin"), { named: false })], ["read-only", open(session("read"))], ["guest", open(session("guest"), { named: true }, true)]] as const) {
      expect([name, s.status()]).toEqual([name, 404]);
    }
    expect(ctx.sseClients.size).toBe(0);
  });
  it(`at most ${LINK_STREAMS_MAX} streams over the link at once; one that closes frees its place`, () => {
    const sid = session("admin");
    const streams = Array.from({ length: LINK_STREAMS_MAX }, () => open(sid));
    expect(streams.every(s => s.status() === 200)).toBe(true);
    expect(open(sid).status()).toBe(503);
    streams[0]!.res.emit("close");
    expect(open(sid).status()).toBe(200);
  });
  it("a stream whose setup throws still frees its place when its response closes (Fable on #4116)", () => {
    const sid = session("admin");
    ctx.getUiStatus = () => { throw new Error("boom"); };
    for (let n = 0; n < LINK_STREAMS_MAX + 2; n++) {
      lastRes = null;
      let threw = false;
      try { open(sid); } catch { threw = true; }
      expect(threw).toBe(true);
      lastRes!.emit("close");
    }
    ctx.getUiStatus = () => ({ instances: [] });
    expect(open(sid).status()).toBe(200);
  });
  it("ends at the next heartbeat once the link is no longer current, or the session is revoked", () => {
    let current = true;
    const a = open(session("admin"), { named: true, current: () => current });
    const sid = session("admin");
    const b = open(sid);
    vi.advanceTimersByTime(TICK);
    expect([a.ended(), b.ended()]).toEqual([false, false]);
    current = false;
    sessions.revokeById(sid);
    vi.advanceTimersByTime(TICK);
    expect([a.ended(), a.destroyed(), b.ended(), b.destroyed()]).toEqual([true, true, true, true]);
    expect(ctx.sseClients.size).toBe(0);
  });
});

describe("M-3278 5/5: the gateway passes /ui/events on the fixed link only", () => {
  it("routed for GET only", () => {
    expect(isPublicWebRoute("GET", "/ui/events")).toBe(true);
    for (const m of ["POST", "PUT", "DELETE"]) expect(isPublicWebRoute(m, "/ui/events"), m).toBe(false);
  });
  it("the quick tunnel's host: 404 before dispatch; the fixed hostname: dispatched", async () => {
    let callback!: (req: any, res: any) => void;
    const server: any = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), listen: (_p: number, _h: string, cb: () => void) => cb(), address: () => ({ port: 1 }), close() {}, closeAllConnections() {} });
    const dispatch = vi.fn();
    const g = createPublicWebGateway({ hostname: HOST, exposureId: EXPOSURE, isCurrent: () => true, isOpen: () => true, dispatch, create: ((cb: any) => { callback = cb; return server; }) as never });
    await g.listen();
    const call = (host: string) => {
      let status = 0;
      const res: any = { headersSent: false, setHeader() {}, writeHead(c: number) { status = c; }, end() {} };
      callback(Object.assign(new EventEmitter(), { method: "GET", url: "/ui/events", headers: { host } }), res);
      return status;
    };
    g.setHost("sample.trycloudflare.com");
    expect(call("sample.trycloudflare.com")).toBe(404);
    expect(dispatch).not.toHaveBeenCalled();
    g.setHost(HOST);
    call(HOST);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
