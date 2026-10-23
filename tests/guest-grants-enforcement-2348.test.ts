/**
 * #2348: guest grants are enforced by the server on every read path a guest could reach — not by the Settings UI. A
 * real FleetManager and listener, real guest sessions, and fleet.yaml's `web.guests.grants` (no mocked scope):
 * - chat (the shell, history, send, a file's instance, the poll), the event stream (projected per guest);
 * - search, the task board, the org chart, usage — refused outright (403 guest_forbidden), granted agent or not;
 * - a grant is the whole scope: connection access, rooms and open_instances give nothing once `grants` exists;
 * - narrowed, the next request sees less; taken away, the session ends; a fleet admin is never a guest.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-2348-home-"));
process.env.AGEND_HOME = home;

const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");

const ALICE = { adapterId: "discord", userId: "111111111111111111" };
const BOB = { adapterId: "discord", userId: "222222222222222222" };     // allowed on the connection, but not granted

interface Raw { status: number; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = ""; res.on("data", (c: Buffer) => { b += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject); r.end(body);
  });
}
/** The event stream for `ms`: what it sent (then the connection is closed). */
function stream(port: number, cookie: string, during: () => void, ms = 400): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = "";
    const r = request({ host: "127.0.0.1", port, method: "GET", path: "/ui/events", headers: { host: `127.0.0.1:${port}`, cookie, accept: "text/event-stream" } }, (res) => {
      res.on("data", (c: Buffer) => { b += c.toString(); });
      setTimeout(during, 100);
      setTimeout(() => { r.destroy(); resolve(b); }, ms);
    });
    r.on("error", (e) => (b ? resolve(b) : reject(e))); r.end();
  });
}

let fm: any, port = 0, dir: string;
const cookieOf = (sid: string) => `${WEB_SESSION_COOKIE}=${sid}`;
const write = (sid: string) => ({ cookie: cookieOf(sid), origin: `http://127.0.0.1:${port}`, [WEB_CSRF_HEADER]: csrfTokenFor(sid), "content-type": "application/json" });
const epoch = () => tokenEpoch(fm.getDashboardAccess().token!);
const guestSession = (owner = ALICE) => fm.webSessions.create({ tier: "guest", surface: "local", label: "guest", tokenEpoch: epoch(), owner }).sessionId as string;
const grants = (g: Record<string, { instances: string[] }>) => { fm.fleetConfig.web.guests.grants = g; };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-2348-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  a:\n    working_directory: ${dir}\n    backend: claude-code\n  b:\n    working_directory: ${dir}\n    backend: claude-code\n`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  // The connection lets BOB in (the derived scope would give him everything): grants must override it.
  fm.worlds.set("discord", { id: "discord", adapter: { type: "discord" }, accessManager: { getMode: () => "pairing", isAllowed: (u: string) => u === BOB.userId || u === ALICE.userId } });
  fm.fleetConfig.web = { view_access: "session", guests: { enabled: true, grants: { [`${ALICE.adapterId}:${ALICE.userId}`]: { instances: ["a"] } } } };
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
  // Two channel messages, one in each agent's chat: what a member of each channel saw.
  for (const [instance, text] of [["a", "GRANTED_A_MESSAGE"], ["b", "SECRET_B_MESSAGE"]]) {
    fm.emitSseEvent("message", { instance, sender: instance, role: "agent", text, ts: new Date().toISOString(), channel: true });
  }
});
afterAll(async () => {
  await new Promise<void>((r) => fm.healthServer?.close(() => r()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});

describe("the scope is the grant, read from fleet.yaml on every request", () => {
  it("alice: her granted agent only; bob (let in by the connection, granted nothing): nothing at all", () => {
    expect([...fm.guestScope(ALICE)]).toEqual(["a"]);
    expect(fm.guestScope(BOB).size).toBe(0);
    // Without grants the old derived scope would have given both agents to both.
    const saved = fm.fleetConfig.web.guests.grants;
    delete fm.fleetConfig.web.guests.grants;
    try { expect([...fm.guestScope(BOB)].sort()).toEqual(["a", "b"]); } finally { fm.fleetConfig.web.guests.grants = saved; }
  });
  it("a fleet admin is never a guest: guest sign-in is not offered to them whatever a grant says", () => {
    grants({ [`${ALICE.adapterId}:${ALICE.userId}`]: { instances: ["a"] }, "discord:333": { instances: ["a"] } });
    vi.spyOn(fm, "isFleetAdmin").mockImplementation((u: unknown) => u === "333");
    try { expect([fm.guestSignInAllowed({ adapterId: "discord", userId: "333" }), fm.guestSignInAllowed(ALICE)]).toEqual([false, true]); }
    finally { vi.restoreAllMocks(); grants({ [`${ALICE.adapterId}:${ALICE.userId}`]: { instances: ["a"] } }); }
  });
});

describe("every read path a guest could reach, refused by the server", () => {
  it("chat: the granted agent is served; the other is 404 — its shell, history, send and upload", async () => {
    const g = guestSession(), admin = fm.webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: epoch() }).sessionId as string;
    // The shell for the granted agent: as an admin gets it (this checkout serves the page from source).
    expect((await raw(port, "GET", "/ui/chat/a", { cookie: cookieOf(g) })).status).toBe((await raw(port, "GET", "/ui/chat/a", { cookie: cookieOf(admin) })).status);
    expect((await raw(port, "GET", "/api/profile/a", { cookie: cookieOf(g) })).status).toBe(200);
    const mine = await raw(port, "GET", "/ui/history?instance=a", { cookie: cookieOf(g) });
    expect([mine.status, mine.body.includes("GRANTED_A_MESSAGE")]).toEqual([200, true]);
    for (const p of ["/ui/chat/b", "/ui/history?instance=b", "/api/profile/b", "/api/card/b"]) {
      const r = await raw(port, "GET", p, { cookie: cookieOf(g) });
      expect([r.status, r.body.includes("SECRET_B_MESSAGE")], p).toEqual([404, false]);
    }
    expect((await raw(port, "POST", "/ui/send", write(g), JSON.stringify({ instance: "b", message: "hi" }))).status).toBe(404);
    expect((await raw(port, "POST", "/ui/upload?instance=b", write(g), "x")).status).toBe(404);
  });
  it("the poll: only the granted agent's messages", async () => {
    const r = await raw(port, "GET", "/ui/poll", { cookie: cookieOf(guestSession()) });
    expect(r.status).toBe(200);
    expect([r.body.includes("GRANTED_A_MESSAGE"), r.body.includes("SECRET_B_MESSAGE")]).toEqual([true, false]);
  });
  it("the event stream: a new message in the other agent's chat never reaches the guest; one in hers does", async () => {
    const got = await stream(port, cookieOf(guestSession()), () => {
      fm.emitSseEvent("message", { instance: "b", sender: "b", role: "agent", text: "LIVE_SECRET_B", ts: new Date().toISOString(), channel: true });
      fm.emitSseEvent("message", { instance: "a", sender: "a", role: "agent", text: "LIVE_GRANTED_A", ts: new Date().toISOString(), channel: true });
    });
    expect([got.includes("LIVE_GRANTED_A"), got.includes("LIVE_SECRET_B")]).toEqual([true, false]);
  });
  it("search, the task board, the org chart and usage: 403 guest_forbidden, whatever is granted", async () => {
    const g = guestSession();
    for (const p of ["/ui/search?q=GRANTED", "/ui/search/context?instance=a&id=1", "/ui/tasks/board", "/ui/tasks/work", "/ui/tasks/search?q=x", "/ui/tasks/cards/M-1",
      "/ui/org", "/ui/traffic", "/ui/usage-report", "/api/ai-usage", "/api/fleet", "/status",
      "/api/settings/guests", "/api/settings/guests/people"]) {   // #2499 review: the guest audit (Recent changes) rides on the first
      expect(await raw(port, "GET", p, { cookie: cookieOf(g) }), p).toEqual({ status: 403, body: JSON.stringify({ error: "guest_forbidden" }) });
    }
    expect((await raw(port, "POST", "/ui/tasks/cards", write(g), JSON.stringify({ title: "x" }))).status).toBe(403);
  });
  it("bob, allowed by the connection but granted nothing: his session ends at its first request", async () => {
    const b = guestSession(BOB);
    const r = await raw(port, "GET", "/ui/chat/a", { cookie: cookieOf(b) });
    expect([r.status, JSON.parse(r.body).error]).toEqual([401, "guest_scope_empty"]);
  });
});

describe("a grant changed: the next request follows it", () => {
  it("narrowed to b: a is 404 now, b is served; taken away: the session ends and stays ended", async () => {
    const g = guestSession();
    expect((await raw(port, "GET", "/api/profile/a", { cookie: cookieOf(g) })).status).toBe(200);
    grants({ [`${ALICE.adapterId}:${ALICE.userId}`]: { instances: ["b"] } });
    expect((await raw(port, "GET", "/api/profile/a", { cookie: cookieOf(g) })).status).toBe(404);
    expect((await raw(port, "GET", "/api/profile/b", { cookie: cookieOf(g) })).status).toBe(200);
    grants({});
    expect((await raw(port, "GET", "/api/profile/b", { cookie: cookieOf(g) })).status).toBe(401);
    grants({ [`${ALICE.adapterId}:${ALICE.userId}`]: { instances: ["a"] } });
    expect((await raw(port, "GET", "/api/profile/a", { cookie: cookieOf(g) })).status, "revoked, not paused").toBe(401);
  });
  it("a grant is exact: an old #1920 narrowing for the same account takes nothing from it (nor adds)", () => {
    fm.fleetConfig.web.guests.narrow = { [`${ALICE.adapterId}:${ALICE.userId}`]: ["b"] };
    try { expect([...fm.guestScope(ALICE)]).toEqual(["a"]); } finally { delete fm.fleetConfig.web.guests.narrow; }
  });
  it("a granted agent that no longer exists gives nothing", () => {
    grants({ [`${ALICE.adapterId}:${ALICE.userId}`]: { instances: ["gone"] } });
    try { expect(fm.guestScope(ALICE).size).toBe(0); } finally { grants({ [`${ALICE.adapterId}:${ALICE.userId}`]: { instances: ["a"] } }); }
  });
});
