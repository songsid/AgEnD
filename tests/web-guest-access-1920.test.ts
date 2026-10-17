/**
 * #1920 phase 1a: guest web sessions are default-deny. Nothing issues one yet (phase 2); this proves the groundwork with
 * a synthetic guest session on a real FleetManager, on the local listener and through the public link's gateway path.
 * - GUEST_ROUTES: an `on` route with its instance in scope → served as for anyone; out of scope (or not a name) → 404;
 *   a `later` route or any other → 403 `guest_forbidden`, before any handler.
 * - Admin sessions and the header token are unchanged.
 * - /auth/sessions: a non-admin sees and ends only its own sessions (itself and its account's); an admin, everyone's.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-1920-home-"));
process.env.AGEND_HOME = home;                         // before the fleet's modules load (pino's daemon.log)

const { FleetManager } = await import("../src/fleet-manager.js");
const { GUEST_ROUTES, guestRouteDecision, sameAccount } = await import("../src/web-guest-access.js");
const { WEB_CSRF_HEADER, WEB_SESSION_COOKIE, WEB_SESSION_COOKIE_SECURE } = await import("../src/web-auth.js");
const { csrfTokenFor, tokenEpoch, WebSessionStore } = await import("../src/web-session.js");
const { bindGatewayRequest } = await import("../src/web-request-context.js");

const ALICE = { adapterId: "discord", userId: "111111111111111111" };
const BOB = { adapterId: "discord", userId: "222222222222222222" };
const u = (p: string) => new URL(p, "http://127.0.0.1:1");

describe("guestRouteDecision (the table)", () => {
  const scope = new Set(["a"]);
  it("an `on` route: in scope → allow; out of scope, or not a name → 404", () => {
    for (const p of ["/ui", "/ui/chat/a", "/ui/js/panel-chat.js", "/ui/history?instance=a", "/api/profile/a", "/api/avatar/a", "/api/card/a", "/api/card/a/banner",
      "/ui/img/avatar/a", "/ui/img/bot/a", `/ui/img/theme/a/${"f".repeat(32)}`, "/ui/effect-posters?instance=a"]) {
      expect(guestRouteDecision("GET", u(p), scope).kind, p).toBe("allow");
    }
    expect(guestRouteDecision("HEAD", u("/ui/chat/a"), scope).kind).toBe("allow");
    for (const p of ["/ui/chat/b", "/ui/history?instance=b", "/ui/history", "/api/profile/b", "/api/card/b/portrait", "/ui/img/bot/b", "/ui/effect-posters?instance=b", "/ui/effect-posters",
      "/ui/chat/a%2Fb", "/api/profile/a%2Fb", "/ui/chat/%E0%A4%A", "/api/card/%ZZ"]) {
      expect(guestRouteDecision("GET", u(p), scope), p).toEqual({ kind: "deny", status: 404, error: "not found" });
    }
    expect(guestRouteDecision("GET", u("/api/profile/a"), new Set()).kind, "an empty scope reaches nothing").toBe("deny");
  });
  it("a `later` route and anything else → 403 guest_forbidden; a method not listed → 403", () => {
    // Phase 1b opened the stream, the poll and a file (answered per recipient: web-guest-stream-1920.test.ts).
    const later = [`/ui/effect-posters/${"a".repeat(32)}.png`, "/ui/prefs", "/ui/profile"];
    const admin = ["/status", "/api/fleet", "/api/profiles", "/api/pane/a", "/ui/org", "/ui/traffic", "/ui/cache", "/ui/teams", "/ui/tasks", "/ui/steps",
      "/ui/instance/a", "/ui/instances", "/ui/config", "/ui/themes", "/ui/emojis", "/ui/mentions", "/api/settings/fleet", "/api/ai-usage", "/ui/fleet", "/ui/needs",
      "/ui/fleet/agent/a", "/ui/log/a", "/settings", "/ui/img/emoji/x", "/ui/preview-status"];
    for (const p of [...later, ...admin]) expect(guestRouteDecision("GET", u(p), new Set(["a"])), p).toEqual({ kind: "deny", status: 403, error: "guest_forbidden" });
    for (const [m, p] of [["POST", "/ui/send"], ["POST", "/ui/upload?instance=a"], ["POST", "/ui/reply-button"], ["POST", "/ui/cancel/a"], ["POST", "/ui/command"],
      ["POST", "/ui/prompt"], ["POST", "/api/profile/a"], ["POST", "/api/card/a/banner"], ["DELETE", "/api/avatar/a"], ["POST", "/ui/chat/a"], ["PUT", "/api/settings/fleet/web"]]) {
      expect(guestRouteDecision(m!, u(p!), new Set(["a"])), `${m} ${p}`).toEqual({ kind: "deny", status: 403, error: "guest_forbidden" });
    }
  });
  it("every entry says why it is open or which phase opens it; the `later` ones are the design's (#1920 §4)", () => {
    for (const r of GUEST_ROUTES) expect(r.note.length, r.pattern.source).toBeGreaterThan(10);
    expect(GUEST_ROUTES.filter((r) => r.state === "later").every((r) => /^phase (1b|2):/.test(r.note))).toBe(true);
  });
  it("sameAccount: both name one account; a missing one is nobody's", () => {
    expect([sameAccount(ALICE, { ...ALICE }), sameAccount(ALICE, BOB), sameAccount(ALICE, undefined), sameAccount(undefined, undefined)]).toEqual([true, false, false, false]);
    expect(sameAccount(ALICE, { adapterId: "telegram", userId: ALICE.userId }), "the same number on another platform is someone else").toBe(false);
  });
});

describe("the session store: a guest always has its owner", () => {
  it("no guest of nobody; a stored guest without one is not read back", () => {
    const s = new WebSessionStore();
    expect(() => s.create({ tier: "guest", surface: "local", label: "g", tokenEpoch: "e".repeat(64) })).toThrow(/owner/);
    const ok = s.create({ tier: "guest", surface: "local", label: "g", tokenEpoch: "e".repeat(64), owner: ALICE });
    expect(ok.record.tier).toBe("guest");
    const dir = mkdtempSync(join(tmpdir(), "agend-1920-sess-")), path = join(dir, "web-sessions.json");
    try {
      const a = new WebSessionStore({ dataDir: dir });
      const { record } = a.create({ tier: "guest", surface: "local", label: "g", tokenEpoch: "e".repeat(64), owner: ALICE });
      const raw = JSON.parse(readFileSync(path, "utf8"));
      expect(new WebSessionStore({ dataDir: dir }).list().map((x) => x.handle)).toEqual([record.handle]);
      for (const r of raw.sessions) delete r.owner;
      writeFileSync(path, JSON.stringify(raw));
      expect(new WebSessionStore({ dataDir: dir }).list()).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── Live: the real listener and the gateway path ──
interface Raw { status: number; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = ""; res.on("data", (c: Buffer) => { b += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject); r.end(body);
  });
}
let fm: any, port = 0, gwPort = 0, gw: Server, dir: string;
const cookieOf = (sid: string) => `${WEB_SESSION_COOKIE}=${sid}`;
const write = (sid: string, p: number, gateway = false) => ({ cookie: cookieOf(sid), origin: gateway ? "https://guest.example" : `http://127.0.0.1:${p}`, [WEB_CSRF_HEADER]: csrfTokenFor(sid), "content-type": "application/json" });
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-1920-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  a:\n    working_directory: ${dir}\n    backend: claude-code\n  b:\n    working_directory: ${dir}\n    backend: claude-code\n`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
  // The public link's gateway path: a listener that binds gateway provenance, then the same dispatcher.
  gw = createServer((req, res) => { bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://guest.example", isCurrent: () => true }); fm.dispatchWebHttp(req, res, port); });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", () => r()));
  gwPort = (gw.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => gw.close(() => r()));
  await new Promise<void>((r) => fm.healthServer?.close(() => r()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});
afterEach(() => { vi.restoreAllMocks(); });
const epoch = () => tokenEpoch(fm.getDashboardAccess().token!);
const session = (tier: "admin" | "guest" | "read", owner?: typeof ALICE, surface: "local" | "gateway" = "local") =>
  fm.webSessions.create({ tier, surface, label: tier, tokenEpoch: epoch(), owner, ...(surface === "gateway" ? { exposureId: "e".repeat(32) } : {}) }).sessionId as string;

describe("the gate, live: a guest scoped to `a`", () => {
  // /view's reads (profile, avatar, card, pane, roster) are public by default — to anyone, a guest included (#1920
  // decision 3: /view stays as it is). With web.view_access: session they go through the gate like the rest.
  beforeAll(() => { fm.fleetConfig.web = { ...(fm.fleetConfig.web ?? {}), view_access: "session" }; });
  afterAll(() => { delete fm.fleetConfig.web.view_access; });
  it("served as for an admin on its routes in scope; 404 out of scope; 403 elsewhere — before any handler; the admin and the header token unchanged", async () => {
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    const guest = session("guest", ALICE), admin = session("admin");
    const token = fm.getDashboardAccess().token!;
    for (const p of ["/ui/chat/a", "/api/profile/a", "/api/card/a", "/ui/effect-posters?instance=a"]) {
      const [g, ad] = [await raw(port, "GET", p, { cookie: cookieOf(guest) }), await raw(port, "GET", p, { cookie: cookieOf(admin) })];
      expect([g.status, g.body.includes("guest_forbidden")], p).toEqual([ad.status, false]);
    }
    for (const p of ["/ui/chat/b", "/ui/history?instance=b", "/api/profile/b", "/api/card/b"]) {
      expect(await raw(port, "GET", p, { cookie: cookieOf(guest) }), p).toEqual({ status: 404, body: JSON.stringify({ error: "not found" }) });
      expect((await raw(port, "GET", p, { cookie: cookieOf(admin) })).status, `admin ${p}`).not.toBe(404);
    }
    for (const p of ["/status", "/api/fleet", "/ui/org", "/ui/traffic", "/api/settings/fleet", "/ui/instance/a"]) {
      expect(await raw(port, "GET", p, { cookie: cookieOf(guest) }), p).toEqual({ status: 403, body: JSON.stringify({ error: "guest_forbidden" }) });
    }
    const send = await raw(port, "POST", "/ui/send", write(guest, port), JSON.stringify({ instance: "a", text: "hi" }));
    expect(send).toEqual({ status: 403, body: JSON.stringify({ error: "guest_forbidden" }) });
    expect((await raw(port, "POST", "/ui/command", write(guest, port), JSON.stringify({ instance: "a", command: "clear" }))).status).toBe(403);
    // Unchanged: an admin session and the header token reach the admin routes.
    expect((await raw(port, "GET", "/status", { cookie: cookieOf(admin) })).status).toBe(200);
    expect((await raw(port, "GET", "/status", { "x-agend-token": token })).status).toBe(200);
  });
  it("the scope is asked on every request (it is never stored): narrowed, the next request is 404", async () => {
    const scope = vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    const guest = session("guest", ALICE);
    expect((await raw(port, "GET", "/api/profile/a", { cookie: cookieOf(guest) })).status).toBe(200);
    scope.mockReturnValue(new Set(["b"]));
    expect((await raw(port, "GET", "/api/profile/a", { cookie: cookieOf(guest) })).status).toBe(404);
    expect(scope.mock.calls.every(([owner]) => sameAccount(owner as typeof ALICE, ALICE))).toBe(true);
  });
  it("#1920 §3.5: a scope that became empty ends the session — 401, and it stays gone when the scope comes back", async () => {
    const scope = vi.spyOn(fm, "guestScope").mockReturnValue(new Set());
    const guest = session("guest", ALICE);
    const first = await raw(port, "GET", "/api/profile/a", { cookie: cookieOf(guest) });
    expect([first.status, JSON.parse(first.body).error]).toEqual([401, "guest_scope_empty"]);
    scope.mockReturnValue(new Set(["a"]));
    expect((await raw(port, "GET", "/api/profile/a", { cookie: cookieOf(guest) })).status, "revoked, not paused").toBe(401);
  });
  it("#2082 review: /auth/session tells a guest its own idle window (2 h), not an admin's", async () => {
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    const g = JSON.parse((await raw(port, "GET", "/auth/session", { cookie: cookieOf(session("guest", ALICE)) })).body);
    const a = JSON.parse((await raw(port, "GET", "/auth/session", { cookie: cookieOf(session("admin")) })).body);
    expect([g.tier, g.idleMs, a.idleMs]).toEqual(["guest", 2 * 3_600_000, 48 * 3_600_000]);
  });
  it("guest sign-in off (the default): a guest's scope is empty, so its session ends", async () => {
    const guest = session("guest", ALICE);
    expect(fm.fleetConfig.web?.guests?.enabled).not.toBe(true);
    expect(fm.guestScope(ALICE).size).toBe(0);
    expect((await raw(port, "GET", "/api/profile/a", { cookie: cookieOf(guest) })).status).toBe(401);
  });
  it("/view's terminal, roster and page are not a guest's (view_access: session)", async () => {
    const guest = session("guest", ALICE);
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    for (const p of ["/api/pane/a", "/api/profiles", "/view/a"]) expect((await raw(port, "GET", p, { cookie: cookieOf(guest) })).status, p).toBe(403);
  });
  it("the public link's gateway path: the same gate", async () => {
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    const guest = session("guest", ALICE, "gateway");
    const g = (p: string) => raw(gwPort, "GET", p, { cookie: `${WEB_SESSION_COOKIE_SECURE}=${guest}`, host: "guest.example" });
    expect((await g("/api/card/a")).status, "in scope: served").not.toBe(403);
    expect((await g("/api/fleet")).status).toBe(403);
    expect((await g("/ui/chat/b")).status).toBe(404);
  });
});

describe("/auth/sessions: a non-admin's own sessions only", () => {
  it("a guest lists and ends only its own (itself and its account's other devices); an admin, everyone's", async () => {
    for (const r of fm.webSessions.list()) fm.webSessions.revokeByHandle(r.handle);
    const admin = session("admin"), alice1 = session("guest", ALICE), alice2 = session("guest", ALICE), bob = session("guest", BOB);
    const handles = () => fm.webSessions.list().map((r: { label: string }) => r.label).sort();
    const listed = JSON.parse((await raw(port, "GET", "/auth/sessions", { cookie: cookieOf(alice1) })).body).sessions;
    expect(listed.length).toBe(2);
    const adminHandle = JSON.parse((await raw(port, "GET", "/auth/sessions", { cookie: cookieOf(admin) })).body).sessions.find((s: { tier: string }) => s.tier === "admin").handle;
    // Someone else's handle: not found (never another's device).
    expect((await raw(port, "DELETE", `/auth/sessions/${adminHandle}`, write(alice1, port))).status).toBe(404);
    // End all: only alice's two.
    const all = await raw(port, "DELETE", "/auth/sessions", write(alice1, port));
    expect([all.status, JSON.parse(all.body).revoked]).toEqual([200, 2]);
    expect(handles()).toEqual(["admin", "guest"]);
    expect((await raw(port, "GET", "/auth/session", { cookie: cookieOf(bob) })).status).toBe(200);
    expect((await raw(port, "GET", "/auth/session", { cookie: cookieOf(alice2) })).status).toBe(401);
    // An admin still ends everyone's.
    const adminAll = await raw(port, "DELETE", "/auth/sessions", write(admin, port));
    expect([adminAll.status, JSON.parse(adminAll.body).revoked]).toEqual([200, 2]);
  });
  it("a read-tier session with no account: its own, itself only", async () => {
    for (const r of fm.webSessions.list()) fm.webSessions.revokeByHandle(r.handle);
    const admin = session("admin"), reader = session("read");
    expect(JSON.parse((await raw(port, "GET", "/auth/sessions", { cookie: cookieOf(reader) })).body).sessions.map((s: { tier: string }) => s.tier)).toEqual(["read"]);
    const r = await raw(port, "DELETE", "/auth/sessions", write(reader, port));
    expect(JSON.parse(r.body).revoked).toBe(1);
    expect((await raw(port, "GET", "/auth/session", { cookie: cookieOf(admin) })).status).toBe(200);
  });
});
