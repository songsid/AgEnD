/**
 * #1920 phase 1b: the stream, the poll and a file, answered per recipient. An admin's stream is byte-for-byte unchanged;
 * a guest's (synthetic: nothing issues one until phase 2) gets default-deny projections:
 * - status: only in-scope instances, only who they are, how they look and their state — nothing of the fleet;
 * - activity for an in-scope instance; nothing else (chat waits for phase 2's §5.2 rule; prompts, Needs you, the Log's
 *   ticks, traffic and apply progress are never a guest's);
 * - the poll: the projected status alone; a file: only when its stored instance is in scope.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// #2095 CI: pino's worker opens daemon.log in the scratch home late — an afterAll rmSync walking it met ENOTEMPTY (as
// #1778/#1779). This file has no use for the log: the logger is silent, so nothing writes there once the work is done.
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { request, type ClientRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-1920b-home-"));
process.env.AGEND_HOME = home;                          // before the fleet's modules load (pino's daemon.log)

const { FleetManager } = await import("../src/fleet-manager.js");
const { guestFrameData, guestPollBody, guestStatus, bindGuestRequest, guestRequestOf, GUEST_ROUTES } = await import("../src/web-guest-access.js");
const { broadcastSseEvent, sseFrame } = await import("../src/web-api.js");
const { WEB_SESSION_COOKIE, WEB_SESSION_COOKIE_SECURE } = await import("../src/web-auth.js");
const { tokenEpoch, WebSessionStore } = await import("../src/web-session.js");
const BOB = { adapterId: "discord", userId: "222222222222222222" };

const ALICE = { adapterId: "discord", userId: "111111111111111111" };
const FULL = {
  instances: [
    { name: "a", display_name: "Atlas", avatar: { kind: "initial", text: "A" }, accent: "#123456", card_v: "v1", color: { auto: "auto:sea" }, color_show: {}, status: "running",
      state: "working", execution_state: "working", interaction: { kind: "prompt", text: "Allow rm -rf?" }, interaction_summary: "Allow rm -rf?", model: "opus", backend: "claude-code",
      effort: "high", cost: 1.5, context_pct: 40, description: "secret role", tags: ["x"], role: "lead", compact: { state: "running" } },
    { name: "b", display_name: "Bea", status: "running", state: "idle" },
  ],
  publicLink: { url: "https://x" }, uptime: 9, connections: 2, prefs_rev: 3, themes_rev: 4, host_memory: { level: "high" }, host_memory_top: [{ pid: 1 }],
};

describe("the projections (pure)", () => {
  it("guestStatus: in-scope instances only; who, how they look, their state — nothing else, nothing of the fleet", () => {
    expect(guestStatus(FULL, new Set(["a"]))).toEqual({ instances: [{ name: "a", display_name: "Atlas", avatar: { kind: "initial", text: "A" }, accent: "#123456", card_v: "v1",
      color: { auto: "auto:sea" }, color_show: {}, status: "running", state: "working", execution_state: "working" }] });
    expect(guestStatus(FULL, new Set())).toEqual({ instances: [] });
    expect(guestStatus(null, new Set(["a"]))).toEqual({ instances: [] });
    expect(guestStatus({ instances: [null, 7, { name: 1 }, { name: "a" }] }, new Set(["a"]))).toEqual({ instances: [{ name: "a" }] });
  });
  it("guestFrameData: status projected; an in-scope instance's activity; every other event is not sent", () => {
    const scope = new Set(["a"]);
    expect(guestFrameData("status", FULL, scope)).toEqual(guestStatus(FULL, scope));
    expect(guestFrameData("activity", { instance: "a", state: "working", extra: 1 }, scope)).toEqual({ instance: "a", state: "working" });
    expect(guestFrameData("activity", { instance: "a" }, scope)).toEqual({ instance: "a", state: null });
    expect(guestFrameData("activity", { instance: "b", state: "idle" }, scope)).toBeUndefined();
    for (const event of ["message", "agent_reply_live", "delivery", "deliveries", "reply_buttons", "prompt", "prompts", "prompt_resolved", "needs", "steps_tick", "traffic", "apply_progress", "clock", "anything"]) {
      expect(guestFrameData(event, { instance: "a", text: "hi" }, scope), event).toBeUndefined();
    }
  });
  it("guestPollBody: the projected status; no messages, ticks, buttons, prompts, Needs you or cursor", () => {
    expect(guestPollBody(FULL, new Set(["a"]), 42)).toEqual({ status: guestStatus(FULL, new Set(["a"])), messages: [], deliveries: [], reply_buttons: [], reactions: [], prompts: [], needs: [], cursor: null, now: 42 });
  });
  it("the stream, the poll and a file are now on the guest table", () => {
    for (const p of ["/ui/events", "/ui/poll", "/ui/file/x"]) expect(GUEST_ROUTES.find((r) => r.pattern.test(p))?.state, p).toBe("on");
  });
  it("a request's guest context: bound once, read by the handlers", () => {
    const req = {}, guest = { owner: ALICE, scope: () => new Set(["a"]), current: () => true };
    expect(guestRequestOf(req)).toBeUndefined();
    bindGuestRequest(req, guest);
    expect(guestRequestOf(req)).toBe(guest);
  });
});

describe("broadcastSseEvent: an admin's bytes unchanged; a guest's projected for its scope at that moment", () => {
  it("each client gets its own; a narrowed scope stops what it covered", async () => {
    // Register the guest stream the way /ui/events does: through a real request handled by web-api.
    const { handleWebRequest } = await import("../src/web-api.js");
    const { EventEmitter } = await import("node:events");
    const written: Record<string, string[]> = { admin: [], guest: [] };
    const res = (who: string) => Object.assign(new EventEmitter(), { writeHead() {}, setHeader() {}, write: (s: string) => { written[who]!.push(s); return true; }, end() {} });
    const adminRes = res("admin"), guestRes = res("guest");
    let scope = new Set(["a"]);
    const clients = new Set<any>();
    const ctx = { webToken: "c".repeat(48), webSessions: null, logger: { info() {}, debug() {}, warn() {}, error() {} }, sseClients: clients, getUiStatus: () => FULL, sseHeartbeatMs: 3_600_000 } as any;
    const reqOf = () => Object.assign(new EventEmitter(), { method: "GET", url: "/ui/events", headers: { host: "127.0.0.1:19280", "x-agend-token": "c".repeat(48) }, socket: null });
    const greq = reqOf(); bindGuestRequest(greq, { owner: ALICE, scope: () => scope, current: () => true });
    handleWebRequest(reqOf() as never, adminRes as never, new URL("/ui/events", "http://127.0.0.1:19280"), ctx);
    handleWebRequest(greq as never, guestRes as never, new URL("/ui/events", "http://127.0.0.1:19280"), ctx);
    try {
      expect(clients.size).toBe(2);
      // On connecting: the admin, the full status; the guest, its projection — no prompts or Needs you; (#1920 phase 2)
      // only its own ticks, which here are none.
      expect(written.admin![0]).toContain(JSON.stringify(FULL));
      expect(written.guest!.join("")).toContain(`event: status\ndata: ${JSON.stringify(guestStatus(FULL, scope))}`);
      expect(written.guest!.join("")).not.toMatch(/event: (prompts|needs)\n/);
      if (/event: deliveries\n/.test(written.guest!.join(""))) expect(written.guest!.join("")).toContain("event: deliveries\ndata: []\n");
      written.admin = []; written.guest = [];
      const msg = { instance: "a", sender: "a", text: "hello", role: "agent" };
      broadcastSseEvent(clients, "message", msg, undefined, "boot-7");
      broadcastSseEvent(clients, "activity", { instance: "a", state: "working" });
      broadcastSseEvent(clients, "activity", { instance: "b", state: "idle" });
      broadcastSseEvent(clients, "prompt", { instance: "a", nonce: "secret-nonce" });
      expect(written.admin).toEqual([sseFrame("message", msg, "boot-7"), sseFrame("activity", { instance: "a", state: "working" }), sseFrame("activity", { instance: "b", state: "idle" }),
        sseFrame("prompt", { instance: "a", nonce: "secret-nonce" })]);
      expect(written.guest).toEqual([sseFrame("activity", { instance: "a", state: "working" })]);
      scope = new Set();                                        // narrowed: the next event follows it
      written.guest = [];
      broadcastSseEvent(clients, "activity", { instance: "a", state: "idle" });
      broadcastSseEvent(clients, "status", FULL);
      expect(written.guest).toEqual([sseFrame("status", { instances: [] })]);
    } finally { adminRes.emit("close"); guestRes.emit("close"); }
  });
});

describe("#2049 review: a guest stream lives only as long as the exact session that opened it", () => {
  // One request with two local cookies: __Host-agend_session=A (guest Alice, scope {a}) and agend_session=B (guest Bob).
  async function open(revoke: "none" | "revoke" | "expire") {
    const { handleWebRequest } = await import("../src/web-api.js");
    const { EventEmitter } = await import("node:events");
    const token = "c".repeat(48), epoch = tokenEpoch(token), store = new WebSessionStore();
    const a = store.create({ tier: "guest", surface: "local", label: "a", tokenEpoch: epoch, owner: ALICE });
    const b = store.create({ tier: "guest", surface: "local", label: "b", tokenEpoch: epoch, owner: BOB });
    const writes: string[] = [];
    let ended = false;
    const res = Object.assign(new EventEmitter(), { writeHead() {}, setHeader() {}, write: (x: string) => { writes.push(x); return true; }, end: (cb?: () => void) => { ended = true; cb?.(); } });
    const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/events", socket: { destroy() {} },
      headers: { host: "127.0.0.1:19280", cookie: `${WEB_SESSION_COOKIE_SECURE}=${a.sessionId}; ${WEB_SESSION_COOKIE}=${b.sessionId}` } });
    bindGuestRequest(req, { owner: ALICE, scope: () => new Set(["a"]), current: () => store.isCurrent(a.record, epoch) });
    const clients = new Set<any>();
    const ctx = { webToken: token, webSessions: store, logger: { info() {}, debug() {}, warn() {}, error() {} }, sseClients: clients, getUiStatus: () => FULL, sseHeartbeatMs: 15 } as any;
    handleWebRequest(req as never, res as never, new URL("/ui/events", "http://127.0.0.1:19280"), ctx);
    expect(clients.has(res)).toBe(true);
    if (revoke === "revoke") store.revokeByHandle(a.record.handle);
    if (revoke === "expire") (a.record as { idleExpiry: number }).idleExpiry = 0;
    return { store, a, b, res, req, clients, writes, ended: () => ended };
  }
  it("A revoked while B still authenticates: the next event is not sent, and the stream goes", async () => {
    const h = await open("revoke");
    try {
      expect(h.store.authenticate(h.b.sessionId, h.b.record.tokenEpoch, { touch: false }), "B still signs in").not.toBeNull();
      h.writes.length = 0;
      broadcastSseEvent(h.clients, "activity", { instance: "a", state: "working" });
      expect([h.writes, h.clients.has(h.res), h.ended()]).toEqual([[], false, true]);
    } finally { h.res.emit("close"); }
  });
  it("A expired: the heartbeat closes it, though B still authenticates", async () => {
    const h = await open("expire");
    try {
      await vi.waitFor(() => expect(h.ended()).toBe(true));
      expect(h.clients.has(h.res)).toBe(false);
    } finally { h.res.emit("close"); }
  });
  it("A unchanged: the stream stays, its heartbeats keep coming, and its events still follow A's scope", async () => {
    const h = await open("none");
    try {
      h.writes.length = 0;
      await vi.waitFor(() => expect(h.writes.filter((w) => w.startsWith("event: status")).length).toBeGreaterThanOrEqual(2));
      broadcastSseEvent(h.clients, "activity", { instance: "a", state: "working" });
      broadcastSseEvent(h.clients, "activity", { instance: "b", state: "working" });
      expect(h.writes.filter((w) => w.startsWith("event: activity"))).toEqual([sseFrame("activity", { instance: "a", state: "working" })]);
      expect([h.clients.has(h.res), h.ended()]).toEqual([true, false]);
    } finally { h.res.emit("close"); }
  });
});

// ── Live: a real FleetManager, a guest and an admin ──
let fm: any, port = 0, dir: string;
const cookieOf = (sid: string) => `${WEB_SESSION_COOKIE}=${sid}`;
function get(path: string, cookie: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}`, cookie } }, (res) => {
      let b = ""; res.on("data", (c: Buffer) => { b += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject); r.end();
  });
}
/** Open a stream; collect what arrives. */
function stream(cookie: string, lastEventId?: string): { chunks: string[]; req: ClientRequest; ready: Promise<void>; ended: () => boolean } {
  const chunks: string[] = [];
  let ended = false;
  let ready!: () => void;
  const readyP = new Promise<void>((r) => { ready = r; });
  const req = request({ host: "127.0.0.1", port, method: "GET", path: "/ui/events", headers: { host: `127.0.0.1:${port}`, cookie, accept: "text/event-stream", ...(lastEventId ? { "last-event-id": lastEventId } : {}) } }, (res) => {
    res.on("data", (c: Buffer) => { chunks.push(c.toString()); ready(); });
    res.on("end", () => { ended = true; });
  });
  req.on("error", () => {}); req.end();
  return { chunks, req, ready: readyP, ended: () => ended };
}
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-1920b-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  a:\n    working_directory: ${dir}\n    backend: claude-code\n  b:\n    working_directory: ${dir}\n    backend: claude-code\n`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => fm.healthServer?.close(() => r()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});
afterEach(() => { vi.restoreAllMocks(); });
const session = (tier: "admin" | "guest", owner?: typeof ALICE) =>
  fm.webSessions.create({ tier, surface: "local", label: tier, tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!), owner }).sessionId as string;

describe("live: the stream, the poll and a file for a guest scoped to `a`", () => {
  it("#1920 §3.5 (#2082 review): a scope that empties while the stream is open ends the session and closes the stream", async () => {
    const scope = vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    const sid = session("guest", ALICE), epoch = tokenEpoch(fm.getDashboardAccess().token!);
    const g = stream(cookieOf(sid));
    await g.ready;
    expect(fm.webSessions.authenticate(sid, epoch, { touch: false })).not.toBeNull();
    scope.mockReturnValue(new Set());
    fm.emitSseEvent("activity", { instance: "a", state: "working" });   // the next event asks the stream's current()
    await vi.waitFor(() => expect(g.ended()).toBe(true));
    expect(fm.webSessions.authenticate(sid, epoch, { touch: false }), "revoked, not just quiet").toBeNull();
    scope.mockReturnValue(new Set(["a"]));
    expect((await get("/ui/poll", cookieOf(sid))).status, "and it stays gone").toBe(401);
  });
  it("the stream: projected status on connect; an in-scope activity; no chat, no prompts, nothing of `b` — the admin's stream gets everything", async () => {
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    const g = stream(cookieOf(session("guest", ALICE))), ad = stream(cookieOf(session("admin")));
    try {
      await Promise.all([g.ready, ad.ready]);
      await vi.waitFor(() => expect(fm.sseClients.size).toBe(2));
      const first = g.chunks.join("");
      const status = JSON.parse(/event: status\ndata: (.*)\n/.exec(first)![1]!);
      expect(Object.keys(status)).toEqual(["instances"]);
      expect(status.instances.map((i: { name: string }) => i.name)).toEqual(["a"]);
      expect(Object.keys(status.instances[0]).filter((k) => ["model", "backend", "effort", "cost", "context_pct", "interaction", "description", "tags"].includes(k))).toEqual([]);
      expect(first).not.toMatch(/event: (prompts|needs)\n/);
      expect(first, "#1920 phase 2: its own ticks only (none yet)").toContain("event: deliveries\ndata: []\n");
      g.chunks.length = 0; ad.chunks.length = 0;
      fm.emitSseEvent("message", { instance: "a", sender: "a", text: "a private note", ts: new Date().toISOString(), role: "agent" });
      fm.emitSseEvent("activity", { instance: "a", state: "working" });
      fm.emitSseEvent("activity", { instance: "b", state: "working" });
      fm.emitSseEvent("prompt", { instance: "a", id: "p1", nonce: "n".repeat(32) });
      fm.emitSseEvent("traffic", { id: "f".repeat(16), from: "a", to: "b", kind: "task", state: "queued", at: "now" });
      await vi.waitFor(() => expect(ad.chunks.join("")).toContain("event: traffic"));
      await new Promise((r) => setTimeout(r, 30));
      const got = g.chunks.join("");
      expect(got).toBe(sseFrame("activity", { instance: "a", state: "working" }));
      expect(ad.chunks.join("")).toContain("a private note");
    } finally { g.req.destroy(); ad.req.destroy(); }
  });
  it("a reconnecting stream that says what it last saw: the admin's is caught up on chat; the guest's is not", async () => {
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    fm.emitSseEvent("message", { instance: "a", sender: "a", text: "said while away", ts: new Date().toISOString(), role: "agent" });
    const since = `${fm.webChatHistory.boot}-0`;
    const g = stream(cookieOf(session("guest", ALICE)), since), ad = stream(cookieOf(session("admin")), since);
    try {
      await Promise.all([g.ready, ad.ready]);
      await vi.waitFor(() => expect(ad.chunks.join("")).toContain("said while away"));
      await new Promise((r) => setTimeout(r, 30));
      expect(g.chunks.join("")).not.toContain("event: message");
    } finally { g.req.destroy(); ad.req.destroy(); }
  });
  it("two cookies on one stream: it is bound to the session that admitted it (A); revoking A ends it though B (Bob) still signs in", async () => {
    vi.spyOn(fm, "guestScope").mockImplementation((owner: any) => new Set(owner?.userId === ALICE.userId ? ["a"] : ["b"]));
    const a = fm.webSessions.create({ tier: "guest", surface: "local", label: "a", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!), owner: ALICE });
    const b = session("guest", BOB);
    const s = stream(`${WEB_SESSION_COOKIE_SECURE}=${a.sessionId}; ${WEB_SESSION_COOKIE}=${b}`);
    try {
      await s.ready;
      s.chunks.length = 0;
      fm.emitSseEvent("activity", { instance: "a", state: "working" });
      fm.emitSseEvent("activity", { instance: "b", state: "working" });
      await vi.waitFor(() => expect(s.chunks.join("")).toBe(sseFrame("activity", { instance: "a", state: "working" })));
      fm.webSessions.revokeByHandle(a.record.handle);
      s.chunks.length = 0;
      fm.emitSseEvent("activity", { instance: "a", state: "idle" });
      fm.emitSseEvent("activity", { instance: "b", state: "idle" });
      await vi.waitFor(() => expect(s.ended(), "the server ended A's stream").toBe(true));
      expect(s.chunks.join("")).toBe("");
      expect((await get("/auth/session", cookieOf(b))).status, "B still signs in").toBe(200);
    } finally { s.req.destroy(); }
  });
  it("#1920 §5.2: /ui/history and the stream's catch-up ticks show a guest what it may see — its own and the channel's", async () => {
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    const me = `${ALICE.adapterId}:${ALICE.userId}`, someone = `${BOB.adapterId}:${BOB.userId}`;
    fm.emitSseEvent("message", { instance: "a", sender: "bob", role: "user", text: "said in the topic", ts: new Date().toISOString(), channel: true, from: someone });
    fm.emitSseEvent("message", { instance: "a", sender: "alice", role: "user", text: "alice on the web", ts: new Date().toISOString(), messageId: "web-alice", from: me });
    fm.emitSseEvent("message", { instance: "a", sender: "bob", role: "user", text: "bob's web-only note", ts: new Date().toISOString(), messageId: "web-bob", from: someone });
    fm.webChatHistory.setDelivery("a", "web-alice", "delivered"); fm.webChatHistory.setDelivery("a", "web-bob", "delivered");
    const cookie = cookieOf(session("guest", ALICE));
    const h = JSON.parse((await get("/ui/history?instance=a", cookie)).body);
    const texts = h.messages.map((m: { text: string }) => m.text);
    expect(texts).toContain("said in the topic");
    expect(texts).toContain("alice on the web");
    expect(texts).not.toContain("bob's web-only note");
    expect(JSON.stringify(h)).not.toContain(someone);
    const g = stream(cookie);
    try {
      await g.ready;
      await vi.waitFor(() => expect(g.chunks.join("")).toMatch(/event: deliveries\n/));
      const ticks = JSON.parse(/event: deliveries\ndata: (.*)\n/.exec(g.chunks.join(""))![1]!);
      expect(ticks).toEqual([{ instance: "a", messageId: "web-alice", delivery: "delivered" }]);
    } finally { g.req.destroy(); }
  });
  it("#1920 §5.2: a guest's own Telegram private room shows it everything there (the gate binds it)", async () => {
    const TG = { adapterId: "tg", userId: "5550001" };
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    const rooms = fm.classicChannels;
    fm.classicChannels = { getAll: () => [{ instanceName: "a", adapterId: "tg", channelId: "5550001" }], getChannelIdByInstance: () => undefined, getAdapterIdByInstance: () => undefined };
    try {
      fm.emitSseEvent("message", { instance: "a", sender: "a", role: "agent", text: "a reply only the web saw", ts: new Date().toISOString() });
      const own = JSON.parse((await get("/ui/history?instance=a", cookieOf(session("guest", TG)))).body).messages.map((m: { text: string }) => m.text);
      const other = JSON.parse((await get("/ui/history?instance=a", cookieOf(session("guest", ALICE)))).body).messages.map((m: { text: string }) => m.text);
      expect([own.includes("a reply only the web saw"), other.includes("a reply only the web saw")]).toEqual([true, false]);
    } finally { fm.classicChannels = rooms; }
  });
  it("#2085 review, live: a web message whose copy is sent after a guest's poll reaches its next poll (after=<cursor>), once", async () => {
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    const cookie = cookieOf(session("guest", ALICE));
    fm.emitSseEvent("message", { instance: "a", sender: "bob", role: "user", text: "held echo note", ts: new Date().toISOString(), messageId: "web-held", from: `${BOB.adapterId}:${BOB.userId}` });
    const first = JSON.parse((await get("/ui/poll", cookie)).body);
    expect(first.messages.map((m: { text: string }) => m.text)).not.toContain("held echo note");
    fm.webMessageInChannel("a", "web-held");
    const next = JSON.parse((await get(`/ui/poll?after=${encodeURIComponent(first.cursor)}`, cookie)).body);
    expect(next.messages.map((m: { text: string }) => m.text)).toEqual(["held echo note"]);
    const again = JSON.parse((await get(`/ui/poll?after=${encodeURIComponent(next.cursor)}`, cookie)).body);
    expect(again.messages.map((m: { text: string }) => m.text), "not sent twice").not.toContain("held echo note");
  });
  it("the poll: the projected status, and only the chat it may see (an agent's web-only note is not); an admin's poll unchanged", async () => {
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    fm.emitSseEvent("message", { instance: "a", sender: "a", text: "another private note", ts: new Date().toISOString(), role: "agent" });
    // #2305: the agent reacted to alice's own message — in her poll and the admin's (a reaction is no new message).
    const reacted = fm.webChatHistory.addReaction("a", "web-alice", "👍");
    expect(reacted?.added).toBe(true);
    const g = JSON.parse((await get("/ui/poll", cookieOf(session("guest", ALICE)))).body);
    expect(Object.keys(g).sort()).toEqual(["cursor", "deliveries", "messages", "needs", "now", "prompts", "reactions", "reply_buttons", "status"]);
    expect(g.reactions).toEqual([{ instance: "a", boot: reacted!.message.boot, id: reacted!.message.id, reactions: ["👍"] }]);
    expect([g.prompts, g.needs, g.status.instances.map((i: { name: string }) => i.name)]).toEqual([[], [], ["a"]]);
    // Only what it may see: never the agent's web-only note, never another person's web message or its tick.
    const texts = g.messages.map((m: { text: string }) => m.text);
    expect(texts).not.toContain("another private note");
    expect(texts).not.toContain("bob's web-only note");
    expect(g.deliveries.every((t: { messageId: string }) => t.messageId === "web-alice")).toBe(true);
    expect(g.cursor, "#1920 phase 2: the poll's cursor, as everyone's").toBe(fm.webChatHistory.pollCursor());
    const a = JSON.parse((await get("/ui/poll", cookieOf(session("admin")))).body);
    expect(a.messages.some((m: { text: string }) => m.text === "another private note")).toBe(true);
    expect(a.reactions).toEqual(g.reactions);
    expect(a.status).toHaveProperty("uptime");
  });
  it("a file: served when its stored instance is in scope; another instance's id is 'no such file' for the guest, served for the admin", async () => {
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    const pa = join(dir, "a.txt"), pb = join(dir, "b.txt");
    writeFileSync(pa, "for a"); writeFileSync(pb, "for b");
    const fa = fm.webFiles.registerServed({ path: pa, instance: "a" }), fb = fm.webFiles.registerServed({ path: pb, instance: "b" });
    const guest = cookieOf(session("guest", ALICE)), admin = cookieOf(session("admin"));
    expect(await get(`/ui/file/${fa.id}`, guest)).toEqual({ status: 200, body: "for a" });
    expect(await get(`/ui/file/${fb.id}`, guest)).toEqual({ status: 404, body: JSON.stringify({ error: "No such file" }) });
    expect(await get(`/ui/file/${"0".repeat(32)}`, guest)).toEqual({ status: 404, body: JSON.stringify({ error: "No such file" }) });
    expect(await get(`/ui/file/${fb.id}`, admin)).toEqual({ status: 200, body: "for b" });
  });
});
