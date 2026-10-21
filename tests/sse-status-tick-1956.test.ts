/**
 * #1956 item 1, step 2: the SSE heartbeat's status is built once per tick for every open stream, not once per stream.
 * - T streams, one build per tick: every admin stream gets the whole status; every guest stream gets its own scope's
 *   projection of that build — never the admin frame, nothing out of scope, nothing of the fleet.
 * - Each stream's own check still runs at the tick: one whose session ended is closed and gets nothing; with none left,
 *   nothing is built. The last stream to close stops the timer.
 * - A build that throws sends nothing that tick; the next one is sent.
 * - The temporary public link has no stream (it polls), as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { EventEmitter } from "node:events";
const { handleWebRequest } = await import("../src/web-api.js");
const { bindGuestRequest, guestStatus } = await import("../src/web-guest-access.js");
const { bindGatewayRequest } = await import("../src/web-request-context.js");

const TOKEN = "c".repeat(48), TICK = 10_000;
const FULL = {
  instances: [
    { name: "a", display_name: "Atlas", status: "running", state: "working", model: "opus", backend: "claude-code", cost: 1.5, description: "secret role", interaction: { kind: "prompt", text: "Allow rm -rf?" } },
    { name: "b", display_name: "Bea", status: "running", state: "idle", model: "gpt", backend: "codex" },
  ],
  publicLink: { url: "https://x" }, uptime: 9, connections: 2, host_memory: { level: "high" },
};
let builds = 0, fail = false, clients: Set<unknown>, ctx: any;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  builds = 0; fail = false; clients = new Set();
  ctx = { webToken: TOKEN, webSessions: null, logger: { info() {}, debug() {}, warn() {}, error() {} }, sseClients: clients, sseHeartbeatMs: TICK,
    getUiStatus: () => { builds++; if (fail) throw new Error("boom"); return FULL; } };
});
afterEach(() => { vi.useRealTimers(); });

/** A stream opened the way a page opens it: a real /ui/events request through web-api. */
function open(guest?: { scope: () => ReadonlySet<string>; current: () => boolean }) {
  const frames: string[] = [];
  let ended = false;
  const res = Object.assign(new EventEmitter(), { writeHead() {}, setHeader() {}, write: (s: string) => { frames.push(s); return true; }, end: (cb?: () => void) => { ended = true; cb?.(); } });
  const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/events", headers: { host: "127.0.0.1:19280", "x-agend-token": TOKEN }, socket: null });
  if (guest) bindGuestRequest(req, { owner: { adapterId: "discord", userId: "111111111111111111" }, ...guest });
  expect(handleWebRequest(req as never, res as never, new URL("/ui/events", "http://127.0.0.1:19280"), ctx)).toBe(true);
  return { res, req, frames, ended: () => ended, statuses: () => frames.filter((f) => f.startsWith("event: status\n")).map((f) => JSON.parse(f.split("\n")[1]!.slice(6))) };
}

describe("one status build per tick for every open stream", () => {
  it("five streams, one build a tick; the admins the whole status, each guest only its scope's projection", () => {
    const admins = [open(), open(), open()];
    const ga = open({ scope: () => new Set(["a"]), current: () => true });
    const gb = open({ scope: () => new Set(["b"]), current: () => true });
    expect(builds).toBe(5);                                                               // each stream's first frame: its own
    for (const s of [...admins, ga, gb]) s.frames.length = 0;
    vi.advanceTimersByTime(TICK);
    expect(builds).toBe(6);                                                               // one more for all five
    vi.advanceTimersByTime(TICK * 2);
    expect(builds).toBe(8);
    for (const s of admins) expect(s.statuses()).toEqual([FULL, FULL, FULL]);
    expect(ga.statuses()).toEqual([guestStatus(FULL, new Set(["a"])), guestStatus(FULL, new Set(["a"])), guestStatus(FULL, new Set(["a"]))]);
    expect(gb.statuses()).toEqual([guestStatus(FULL, new Set(["b"])), guestStatus(FULL, new Set(["b"])), guestStatus(FULL, new Set(["b"]))]);
    // Nothing admin-only reaches a guest from the shared build: no fleet fields, no other instance, no model, cost, prompt.
    for (const g of [ga, gb]) for (const st of g.statuses()) {
      expect(Object.keys(st)).toEqual(["instances", "canvas_worker"]);
      expect(st.canvas_worker).toBe(false);
      expect(st.instances).toHaveLength(1);
      expect(JSON.stringify(st)).not.toMatch(/publicLink|host_memory|uptime|opus|gpt|cost|secret role|rm -rf/);
    }
  });
  it("two guests with the same scope share a projection; a scope narrowed between ticks is read at the tick", () => {
    let scope = new Set(["a", "b"]);
    const g = open({ scope: () => scope, current: () => true });
    g.frames.length = 0;
    vi.advanceTimersByTime(TICK);
    scope = new Set(["b"]);
    vi.advanceTimersByTime(TICK);
    expect(g.statuses()).toEqual([guestStatus(FULL, new Set(["a", "b"])), guestStatus(FULL, new Set(["b"]))]);
  });
  it("a stream whose session ended is closed at the tick and gets nothing; the others still get theirs", () => {
    let current = true;
    const admin = open(), g = open({ scope: () => new Set(["a"]), current: () => current });
    admin.frames.length = 0; g.frames.length = 0;
    current = false;
    vi.advanceTimersByTime(TICK);
    expect([g.ended(), g.frames.length, clients.has(g.res), admin.statuses()]).toEqual([true, 0, false, [FULL]]);
  });
  it("with every stream closed at the tick, nothing is built; the last one to close stops the timer", () => {
    let current = true;
    const g = open({ scope: () => new Set(["a"]), current: () => current });
    current = false;
    const before = builds;
    vi.advanceTimersByTime(TICK);
    expect([g.ended(), builds]).toEqual([true, before]);
    expect(vi.getTimerCount()).toBe(0);
    const a = open(); a.res.emit("close");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a build that throws sends nothing that tick; the next tick is sent", () => {
    const a = open(); a.frames.length = 0;
    fail = true; vi.advanceTimersByTime(TICK);
    expect(a.frames).toEqual([]);
    fail = false; vi.advanceTimersByTime(TICK);
    expect(a.statuses()).toEqual([FULL]);
  });
  it("the temporary public link has no stream (it polls), as before", () => {
    const res = Object.assign(new EventEmitter(), { writeHead() {}, setHeader() {}, write() { return true; }, end() {} });
    const out: { status?: number } = {};
    (res as any).writeHead = (code: number) => { out.status = code; };
    const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/events", headers: { host: "127.0.0.1:19280", "x-agend-token": TOKEN }, socket: null });
    bindGatewayRequest(req, { surface: "public", exposureId: "e1", expectedOrigin: "https://x.example", isCurrent: () => true } as any);
    handleWebRequest(req as never, res as never, new URL("/ui/events", "http://127.0.0.1:19280"), ctx);
    // Refused before any stream exists (the public link takes no header token, and polls /ui/poll for its status).
    expect([(out.status ?? 0) >= 400, clients.size, builds]).toEqual([true, 0, 0]);
  });
});
