/**
 * #3190 Part 3c: the Accounts routes with a `machine` scope. No new route: `POST /ui/accounts/<cli>`, `DELETE /ui/accounts/<cli>/<name>` and
 * `POST /ui/accounts/<cli>/signout` take an optional `machine` (a paired computer's id), and `/ui/browser-backend-signins` takes `?machine=&profile=`.
 * The same guard as the host's (the fleet's local admin session; never a guest, a read session, the CLI's token or the public link), the person's audit name
 * is the session's opaque handle, and a stale tab's old requests (no `machine`) reach the fleet exactly as before. Fixtures only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { GUEST_ROUTES } from "../src/web-guest-access.js";

const ID = "11111111-2222-3333-4444-555555555555";
const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } });

async function fixture(extra: Record<string, unknown> = {}) {
  const token = "machine-accounts-scratch-token", sessions = new WebSessionStore({});
  const add = vi.fn((..._a: unknown[]) => ({ ok: true } as any)), rm = vi.fn(async (..._a: unknown[]) => ({ ok: true } as any)), out = vi.fn(async (..._a: unknown[]) => ({ ok: true } as any));
  const snapshot = vi.fn((..._a: unknown[]) => ({ selected: ["claude-code"], pending: ["claude-code"], skipped: [], states: { "claude-code": "invalid" }, login: null, ready: true, target: { machine: ID, profile: "work" } }));
  const machineSignIns = { snapshot, begin: vi.fn(async (..._a: unknown[]) => snapshot()), input: vi.fn(async (..._a: unknown[]) => snapshot()), cancel: vi.fn(async (..._a: unknown[]) => snapshot()) };
  const ctx = { webToken: token, webSessions: sessions, addAccountProfile: add, removeAccountProfile: rm, signOutAccount: out, machineSignIns, ...extra } as unknown as WebApiContext;
  const server = createServer((req, res) => { if (!handleWebRequest(req, res, new URL(req.url!, "http://localhost"), ctx)) { res.writeHead(404); res.end(); } });
  servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session = (tier: "admin" | "read" | "guest" = "admin", surface: "local" | "gateway" = "local") => {
    const made = sessions.create({ tier, surface, label: "Firefox on Linux", tokenEpoch: tokenEpoch(token), ...(surface === "gateway" ? { exposureId: "e".repeat(32) } : {}), ...(tier === "guest" ? { owner: { adapterId: "discord", userId: "g1" } } : {}) });
    return { handle: made.record.handle, headers: { cookie: `agend_session=${made.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(made.sessionId), "content-type": "application/json" } as Record<string, string> };
  };
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = request(`${origin}${path}`, { method, headers: { ...headers, ...(data ? { "content-length": String(data.length) } : {}) } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c));
      res.on("end", () => { const raw = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); });
    });
    r.on("error", reject); r.end(data);
  });
  return { add, rm, out, machineSignIns, snapshot, sessions, token, origin, session, call, ctx };
}
const Q = (profile = "work", machine = ID) => `/ui/browser-backend-signins?machine=${machine}&profile=${profile}`;

describe("accounts writes with a machine", () => {
  it("add, remove and sign out reach the fleet with the computer and the session's opaque audit name (never its label); without `machine` the calls are exactly as before", async () => {
    const f = await fixture(), a = f.session(), who = { id: ID, actor: `admin:${a.handle}` };
    expect(a.handle).toMatch(/^[a-f0-9]{16}$/);
    expect(await f.call("POST", "/ui/accounts/claude-code", a.headers, { name: "work", machine: ID })).toEqual({ status: 200, body: { added: "work", machine: ID } });
    expect(f.add).toHaveBeenLastCalledWith("claude-code", "work", "Firefox on Linux", who);
    expect(await f.call("DELETE", "/ui/accounts/claude-code/work", a.headers, { confirm: "work", machine: ID })).toEqual({ status: 200, body: { removed: "work" } });
    expect(f.rm).toHaveBeenLastCalledWith("claude-code", "work", "work", "Firefox on Linux", who);
    expect(await f.call("POST", "/ui/accounts/claude-code/signout", a.headers, { profile: "work", confirm: true, machine: ID })).toEqual({ status: 200, body: { signedOut: "work" } });
    expect(f.out).toHaveBeenLastCalledWith("claude-code", "work", true, "Firefox on Linux", who);
    // A tab that does not know about computers sends the old bodies, and the fleet is called with the old arguments.
    await f.call("POST", "/ui/accounts/claude-code", a.headers, { name: "w" }); expect(f.add).toHaveBeenLastCalledWith("claude-code", "w", "Firefox on Linux");
    await f.call("DELETE", "/ui/accounts/claude-code/w", a.headers, { confirm: "w" }); expect(f.rm).toHaveBeenLastCalledWith("claude-code", "w", "w", "Firefox on Linux");
    await f.call("POST", "/ui/accounts/claude-code/signout", a.headers, { profile: null, confirm: true }); expect(f.out).toHaveBeenLastCalledWith("claude-code", null, true, "Firefox on Linux");
  });
  it("`machine` is a computer's id and nothing else; bodies stay strict", async () => {
    const f = await fixture(), a = f.session();
    for (const machine of ["", "C:\\x", "../x", "11111111-2222-3333-4444-55555555555", 7, null, "11111111-2222-3333-4444-55555555555G"]) {
      expect((await f.call("POST", "/ui/accounts/claude-code", a.headers, { name: "w", machine })).status, JSON.stringify(machine)).toBe(400);
    }
    expect((await f.call("DELETE", "/ui/accounts/claude-code/w", a.headers, { confirm: "w", machine: ID, extra: 1 })).status).toBe(400);
    expect((await f.call("POST", "/ui/accounts/claude-code/signout", a.headers, { profile: "w", confirm: false, machine: ID })).status).toBe(400);
    expect([f.add.mock.calls.length, f.rm.mock.calls.length, f.out.mock.calls.length]).toEqual([0, 0, 0]);
  });
  it("a refusal keeps its code and status; the computer's own sentence and the users come through, and nothing else of the fleet's answer does", async () => {
    const f = await fixture(), a = f.session();
    const cases: Array<[string, number]> = [["machine_unknown", 404], ["machine_offline", 409], ["machine_unsupported", 409], ["machine_accounts_off", 409], ["machine_unreachable", 502], ["machine_profile_not_owned", 409], ["machine_refused", 409], ["machine_default_login", 409], ["signing_in", 409], ["in_use", 409]];
    const users = { agents: ["w1"], classic: [], fleetDefault: true };
    for (const [error, status] of cases) {
      f.rm.mockResolvedValueOnce({ ok: false, error, ...(error === "machine_refused" ? { message: "The computer says no" } : {}), ...(error === "in_use" ? { users } : {}), secret: "x" } as any);
      expect(await f.call("DELETE", "/ui/accounts/claude-code/work", a.headers, { confirm: "work", machine: ID }), error)
        .toEqual({ status, body: { error, ...(error === "machine_refused" ? { message: "The computer says no" } : {}), ...(error === "in_use" ? { users } : {}) } });
    }
    f.add.mockReturnValueOnce({ ok: false, error: "case_clash", clash: "Work" } as any);
    expect(await f.call("POST", "/ui/accounts/claude-code", a.headers, { name: "work", machine: ID })).toEqual({ status: 409, body: { error: "case_clash", clash: "Work" } });
  });
  it("only the local admin session: not the CLI's token, a read or guest session, a gateway session, or a request without CSRF", async () => {
    const f = await fixture();
    expect((await f.call("POST", "/ui/accounts/claude-code", { origin: f.origin, "content-type": "application/json" }, { name: "w", machine: ID })).status).toBe(401);
    expect(await f.call("DELETE", "/ui/accounts/claude-code/w", { "x-agend-token": f.token, origin: f.origin, "content-type": "application/json" }, { confirm: "w", machine: ID })).toMatchObject({ status: 403, body: { error: "accounts_need_a_local_admin" } });
    for (const tier of ["read", "guest"] as const) expect((await f.call("POST", "/ui/accounts/claude-code/signout", f.session(tier).headers, { profile: "w", confirm: true, machine: ID })).status, tier).toBe(403);
    expect((await f.call("POST", "/ui/accounts/claude-code", f.session("admin", "gateway").headers, { name: "w", machine: ID })).status).toBeGreaterThanOrEqual(401);
    const { "x-agend-csrf": _c, ...noCsrf } = f.session().headers;
    expect((await f.call("POST", "/ui/accounts/claude-code", noCsrf, { name: "w", machine: ID })).status).toBe(401);
    expect([f.add.mock.calls.length, f.rm.mock.calls.length, f.out.mock.calls.length]).toEqual([0, 0, 0]);
    for (const [method, path] of [["POST", "/ui/accounts/claude-code"], ["DELETE", "/ui/accounts/claude-code/w"], ["POST", "/ui/accounts/claude-code/signout"], ["GET", "/ui/browser-backend-signins"]] as const) {
      expect(isPublicWebRoute(method, path)).toBe(false);
      expect(GUEST_ROUTES.some(r => (r.methods as readonly string[]).includes(method) && r.pattern.test(path))).toBe(false);
    }
  });
});

describe("the sign-in route for a computer's profile", () => {
  it("GET reads that computer's profile (a snapshot in the same shape as the host's), as the local admin session that asked", async () => {
    const f = await fixture(), a = f.session();
    const r = await f.call("GET", Q(), a.headers);
    expect(r).toMatchObject({ status: 200, body: { selected: ["claude-code"], states: { "claude-code": "invalid" }, target: { machine: ID, profile: "work" } } });
    expect(f.snapshot.mock.calls[0]![1]).toEqual({ machine: ID, profile: "work" });
    expect(f.machineSignIns.begin).not.toHaveBeenCalled();
  });
  it("start, input, cancel and refresh are the whole of it; a start is Claude Code only and takes no method, command or path", async () => {
    const f = await fixture(), a = f.session();
    expect((await f.call("POST", Q(), a.headers, { operation: "start", backend: "claude-code" })).status).toBe(200);
    expect(f.machineSignIns.begin.mock.calls.at(-1)!.slice(1)).toEqual([{ machine: ID, profile: "work" }, false]);
    expect((await f.call("POST", Q(), a.headers, { operation: "start", backend: "claude-code", relogin: true })).status).toBe(200);
    expect(f.machineSignIns.begin.mock.calls.at(-1)!.slice(1)).toEqual([{ machine: ID, profile: "work" }, true]);
    const id = "a".repeat(32);
    expect((await f.call("POST", Q(), a.headers, { operation: "input", id, revision: 3, action: { kind: "code", value: "CODE-1" } })).status).toBe(200);
    expect(f.machineSignIns.input.mock.calls.at(-1)!.slice(1)).toEqual([{ machine: ID, profile: "work" }, id, 3, { kind: "code", value: "CODE-1" }]);
    expect((await f.call("POST", Q(), a.headers, { operation: "cancel" })).status).toBe(200); expect(f.machineSignIns.cancel).toHaveBeenCalledTimes(1);
    expect((await f.call("POST", Q(), a.headers, { operation: "refresh" })).status).toBe(200);
    const before = f.machineSignIns.begin.mock.calls.length;
    for (const body of [{ operation: "start", backend: "codex" }, { operation: "start", backend: "kiro-cli" }, { operation: "start", backend: "claude-code", method: "console" }, { operation: "start", backend: "claude-code", argv: ["sh"] },
      { operation: "start", backend: "claude-code", command: "calc" }, { operation: "select", backends: ["claude-code"] }, { operation: "skip", backend: "claude-code" }, { operation: "nope" }]) {
      expect((await f.call("POST", Q(), a.headers, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(f.machineSignIns.begin.mock.calls.length).toBe(before);
  });
  it("the query is exactly a computer's id and a profile name; anything else is not found, and nothing is called", async () => {
    const f = await fixture(), a = f.session();
    for (const path of [`/ui/browser-backend-signins?machine=${ID}`, `/ui/browser-backend-signins?profile=work`, `/ui/browser-backend-signins?machine=${ID}&profile=work&x=1`, Q("../x"), Q("con"), Q("work", "not-an-id"),
      Q("a%20b"), `/ui/browser-backend-signins?machine=${ID}&profile=`, `/ui/browser-backend-signins?machine=${ID}&profile=work&profile=home`]) {
      expect((await f.call("GET", path, a.headers)).status, path).toBe(404);
    }
    expect(f.snapshot).not.toHaveBeenCalled(); expect(f.machineSignIns.begin).not.toHaveBeenCalled();
  });
  it("a refusal is a code the page words (the computer's reason: offline, a switch off, not one its Runtime made, busy); any other failure is one fixed code", async () => {
    const f = await fixture(), a = f.session();
    for (const code of ["machine_unknown", "machine_offline", "machine_unsupported", "machine_accounts_off", "machine_unreachable", "machine_profile_not_owned", "machine_busy", "invalid_machine_target", "signin_session_expired"]) {
      f.machineSignIns.begin.mockRejectedValueOnce(new Error(code));
      expect(await f.call("POST", Q(), a.headers, { operation: "start", backend: "claude-code" }), code).toEqual({ status: 409, body: { error: code } });
    }
    f.machineSignIns.begin.mockRejectedValueOnce(new Error("signin_cleanup_failed")); expect(await f.call("POST", Q(), a.headers, { operation: "start", backend: "claude-code" })).toEqual({ status: 503, body: { error: "signin_cleanup_failed" } });
    f.machineSignIns.begin.mockRejectedValueOnce(new Error(`Error: C:\\Users\\x\\secret ${"https://claude.com/?code=1"}`));
    expect(await f.call("POST", Q(), a.headers, { operation: "start", backend: "claude-code" })).toEqual({ status: 503, body: { error: "signin_failed" } });
  });
  it("only the local admin session, and not without the service (404)", async () => {
    const f = await fixture();
    for (const headers of [{ origin: f.origin }, { "x-agend-token": f.token }, f.session("read").headers, f.session("guest").headers, f.session("admin", "gateway").headers]) {
      expect([401, 403], JSON.stringify(Object.keys(headers))).toContain((await f.call("GET", Q(), headers)).status);
    }
    expect(f.snapshot).not.toHaveBeenCalled();
    const none = await fixture({ machineSignIns: undefined });
    expect((await none.call("GET", Q(), none.session().headers)).status).toBe(404);
  });
  it("the host's own sign-in route is unchanged: no query reaches it, a query it does not know is not found", async () => {
    const host = vi.fn(async () => ({ selected: [], pending: [], states: {}, skipped: [], login: null, ready: true }));
    const f = await fixture({ browserBackendSignIns: { refresh: host } });
    expect((await f.call("GET", "/ui/browser-backend-signins", f.session().headers)).status).toBe(200); expect(host).toHaveBeenCalledTimes(1);
    expect((await f.call("GET", "/ui/browser-backend-signins?x=1", f.session().headers)).status).toBe(404);
    expect(f.snapshot).not.toHaveBeenCalled();
  });
});
