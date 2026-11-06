/**
 * Settings → Agents → CLI sign-ins shows which account each Claude Code sign-in is: a masked e-mail and a plan, read on the AgEnD host from the
 * same `claude auth status` answer authCheck uses. Fixtures only (example.com); the full address must appear nowhere AgEnD answers, logs or keeps.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { credentialProfileHome } from "../src/backend/credential-profile.js";
import { setAuthCheckRunnerForTests, checkAuthIdentity, authIdentitySupported } from "../src/login-flows.js";
import { WebBackendLogins } from "../src/web-backend-login.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { GUEST_ROUTES } from "../src/web-guest-access.js";

const RAW = "alice.fixture@example.com";
const status = (over: Record<string, unknown> = {}) => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: RAW, orgName: "Fixture Org", subscriptionType: "team", ...over });
const dirs: string[] = [], servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); setAuthCheckRunnerForTests(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); })));
});
function makeFleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-host-identity-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  fm.fleetConfig = { defaults: {}, instances: {
    a: { working_directory: "/w", backend: "claude-code", backend_options: { "claude-code": { credential_profile: "work" } } },
    b: { working_directory: "/w", backend: "claude-code", backend_options: { "claude-code": { credential_profile: "constructor" } } },
    c: { working_directory: "/w", backend: "claude-code", backend_options: { "claude-code": { credential_profile: "expired" } } },
    d: { working_directory: "/w", backend: "codex" },
  } };
  // A profile is "usable" when its folder holds a sign-in (the token's shape; no value of it is read): `work` and `constructor` do, `expired` does not.
  for (const name of ["work", "constructor"]) { const home = credentialProfileHome(dir, "claude-code", name); mkdirSync(home, { recursive: true }); writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token-not-real" } })); }
  vi.spyOn(fm, "backendAvailabilityRows").mockReturnValue([{ backend: "claude-code", state: "usable" }, { backend: "codex", state: "usable" }]);
  vi.spyOn(fm, "backendNameForInstance").mockImplementation((name: unknown) => name === "d" ? "codex" : "claude-code");
  const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
  const answers = new Map<string, string>();      // by CLAUDE_CONFIG_DIR's last path segment ("" = the default sign-in)
  setAuthCheckRunnerForTests(async (argv, _timeout, env) => { calls.push({ argv, env }); const key = env?.CLAUDE_CONFIG_DIR?.split("/").pop() ?? ""; return { code: 0, output: answers.get(key) ?? status() }; });
  const logs: unknown[][] = [];
  for (const level of ["debug", "info", "warn", "error"] as const) vi.spyOn(fm.logger, level).mockImplementation((...args: unknown[]) => { logs.push(args); });
  return { fm, dir, calls, answers, logs };
}
const text = (value: unknown) => JSON.stringify(value);
/** Reads run in the background now: wait for the ones in flight (never part of a request). */
const reads = async (fm: any): Promise<void> => { await vi.waitFor(() => expect(fm.signInIdentityReads.size).toBe(0)); };
const read = async (fm: any): Promise<void> => { fm.refreshSignInIdentities(); await reads(fm); };

describe("the host's own sign-in list: which account is each Claude Code sign-in", () => {
  it("shows the masked e-mail and plan of the default sign-in and of every profile an agent uses, from one `auth status` each", async () => {
    const f = makeFleet(); f.answers.set("work", status({ email: "bob.fixture@example.org", subscriptionType: "max" })); f.answers.set("constructor", status({ subscriptionType: "something-new" }));
    expect(f.fm.backendSignInTargets().some((target: any) => target.identity)).toBe(false);       // nothing read yet: nothing shown
    await read(f.fm);
    const targets = f.fm.backendSignInTargets();
    const byName = (profile?: string) => targets.find((target: any) => target.backend === "claude-code" && target.profile === profile);
    expect(byName(undefined).identity).toEqual({ maskedEmail: "al***@example.com", plan: "team" });
    expect(byName("work").identity).toEqual({ maskedEmail: "bo***@example.org", plan: "max" });
    expect(byName("constructor").identity).toEqual({ maskedEmail: "al***@example.com", plan: "unknown" });
    expect(targets.find((target: any) => target.backend === "codex").identity).toBeUndefined();
    // A profile is read with its own folder; the default with the host's environment. Codex and a signed-out profile are not asked.
    expect(f.calls.map(call => call.env?.CLAUDE_CONFIG_DIR?.split("/").pop() ?? "default").sort()).toEqual(["constructor", "default", "work"]);
    for (const call of f.calls) expect(call.argv).toEqual(["claude", "auth", "status"]);
  });
  it("is the masked form only: the full address is in no answer, no kept state and no log", async () => {
    const f = makeFleet(); await read(f.fm);
    expect(text(f.fm.backendSignInTargets())).not.toContain("alice.fixture"); expect(text(f.logs)).not.toContain("alice.fixture");
    const files = (dir: string): string => readdirSync(dir, { withFileTypes: true }).map(entry => entry.isDirectory() ? files(join(dir, entry.name)) : statSync(join(dir, entry.name)).size < 1e6 ? readFileSync(join(dir, entry.name), "utf8") : "").join("");
    expect(files(f.dir)).not.toContain("alice.fixture");
  });
  it("asks at most once in five minutes, again after a sign-in changed, and never starts a second login or a network request of its own", async () => {
    const f = makeFleet(); await read(f.fm); const first = f.calls.length; await read(f.fm);
    expect(f.calls).toHaveLength(first);
    f.fm.forgetSignInIdentities(); await read(f.fm); expect(f.calls.length).toBe(first * 2);
    for (const call of f.calls) expect(call.argv.join(" ")).not.toMatch(/login|logout|http/);
  });
  it("shows nothing for a sign-in that cannot be read: a failing or unreadable answer, an API key keeps only its kind", async () => {
    const f = makeFleet(); f.answers.set("work", "not json"); f.answers.set("constructor", JSON.stringify({ loggedIn: true, authMethod: "api_key" }));
    await read(f.fm);
    const targets = f.fm.backendSignInTargets(), find = (profile: string) => targets.find((target: any) => target.profile === profile);
    expect(find("work").identity).toBeUndefined(); expect(find("constructor").identity).toEqual({ apiKey: true });
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: status() })); expect(await checkAuthIdentity("claude-code")).toBeUndefined();
    setAuthCheckRunnerForTests(async () => { throw new Error(`boom ${RAW}`); }); expect(await checkAuthIdentity("claude-code")).toBeUndefined();
    setAuthCheckRunnerForTests(async () => ({ code: null, output: "" })); expect(await checkAuthIdentity("claude-code")).toBeUndefined();
  });
  it("only Claude Code has an account to show; another backend is never run for it", async () => {
    expect(authIdentitySupported("claude-code")).toBe(true);
    for (const backend of ["codex", "kiro-cli", "opencode", "constructor", "__proto__"]) { expect(authIdentitySupported(backend)).toBe(false); expect(await checkAuthIdentity(backend)).toBeUndefined(); }
  });
  it("never waits: the request that asks starts the read and returns at once, and the answer is there for the next one (with a re-read signal to the pages)", async () => {
    const f = makeFleet(); const gates: Array<() => void> = []; const sse = vi.spyOn(f.fm, "emitSseEvent" as never).mockImplementation(() => {});
    const broadcast: string[] = []; f.fm.sseClients = new Set([{ write: (chunk: string) => { broadcast.push(chunk); return true; }, on() {}, once() {}, removeListener() {}, writableEnded: false, destroyed: false }]);
    setAuthCheckRunnerForTests(async () => { await new Promise<void>(done => { gates.push(done); }); return { code: 0, output: status() }; });
    f.fm.refreshSignInIdentities();
    expect(f.fm.backendSignInTargets().some((target: any) => target.identity)).toBe(false);          // answered with what is known, at once
    await vi.waitFor(() => expect(f.fm.signInIdentitySlots).toBe(3));
    gates.splice(0).forEach(open => open()); await vi.waitFor(() => expect(f.fm.backendSignInTargets().some((target: any) => target.identity)).toBe(true));
    await reads(f.fm); expect(broadcast.join("")).toContain("backend_login"); sse.mockRestore();
  });
  it("a sign-in that is already being read is joined, not read twice; across all requests no more than three run at once", async () => {
    const f = makeFleet();
    for (const name of ["p1", "p2", "p3", "p4", "p5"]) {
      const home = credentialProfileHome(f.dir, "claude-code", name); mkdirSync(home, { recursive: true }); writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token-not-real" } }));
      f.fm.fleetConfig.instances[`i-${name}`] = { working_directory: "/w", backend: "claude-code", backend_options: { "claude-code": { credential_profile: name } } };
    }
    let running = 0, peak = 0, launched = 0; const gates: Array<() => void> = [];
    setAuthCheckRunnerForTests(async () => { launched++; running++; peak = Math.max(peak, running); await new Promise<void>(done => gates.push(done)); running--; return { code: 0, output: status() }; });
    for (let request = 0; request < 12; request++) f.fm.refreshSignInIdentities();      // twelve requests, in a burst
    await vi.waitFor(() => expect(launched).toBe(3));
    expect(peak).toBe(3); expect(f.fm.signInIdentityReads.size).toBe(8);                  // default + work + constructor + p1..p5 are wanted; each has ONE read
    while (f.fm.signInIdentityReads.size) { gates.splice(0).forEach(open => open()); await new Promise(r => setTimeout(r, 5)); }
    expect(launched).toBe(8); expect(peak).toBe(3);
  });
  it("a read that began before a sign-in finished never writes its answer back: the next read sees the new account", async () => {
    const f = makeFleet(); let answer = RAW; const gates: Array<() => void> = [];
    setAuthCheckRunnerForTests(async () => { const mine = answer; await new Promise<void>(done => gates.push(done)); return { code: 0, output: status({ email: mine }) }; });
    f.fm.refreshSignInIdentities(); await vi.waitFor(() => expect(gates).toHaveLength(3));
    f.fm.forgetSignInIdentities(); answer = "bob.fixture@example.org";         // the sign-in finished: another account now
    gates.splice(0).forEach(open => open()); await vi.waitFor(() => expect(f.fm.signInIdentitySlots).toBe(0));
    expect(f.fm.backendSignInTargets().some((target: any) => target.identity)).toBe(false);          // the old answers were dropped, not kept for five minutes
    f.fm.refreshSignInIdentities(); await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
    while (f.fm.signInIdentityReads.size) { gates.splice(0).forEach(open => open()); await new Promise(r => setTimeout(r, 5)); }
    expect(f.fm.backendSignInTargets().find((target: any) => target.backend === "claude-code" && !target.profile).identity).toEqual({ maskedEmail: "bo***@example.org", plan: "team" });
  });
  it("the accounts are forgotten when a sign-in ENDS (any one), not at every step of one that is running", async () => {
    const f = makeFleet(); await read(f.fm); const first = f.calls.length;
    const deps = (f.fm.webBackendLogins as any).deps as { changed: (phase?: string) => void; loginEnded: () => void };
    deps.changed("running"); deps.changed(undefined); deps.changed("ended"); await read(f.fm); expect(f.calls).toHaveLength(first);   // telling the pages to read again forgets nothing
    deps.loginEnded(); await read(f.fm); expect(f.calls.length).toBe(first * 2);
    f.fm.webBackendLogins.dispose();
  });
});

describe("who is served the list with the accounts in it: a local administrator session only", () => {
  async function fixture() {
    const token = "host-identity-scratch-token", sessions = new WebSessionStore({});
    const identity = { maskedEmail: "al***@example.com", plan: "team" };
    const refresh = vi.fn(() => {});
    const logins = new WebBackendLogins({ isLocalAdmin: handle => { const r = sessions.findByHandle(handle); return !!r && r.tier === "admin" && r.surface === "local"; },
      start: async () => null, accessToken: () => null, isActiveFor: () => false, cancelFor: async () => false, cancel: async () => "", notice() {}, changed() {} });
    const ctx = { webToken: token, webSessions: sessions, webBackendLogins: logins, refreshSignInIdentities: refresh,
      backendSignInTargets: () => [{ backend: "claude-code", state: "usable", signIn: true, identity }, { backend: "claude-code", profile: "work", state: "usable", signIn: true, identity }] } as unknown as WebApiContext;
    const server = createServer((req, res) => { if (!handleWebRequest(req, res, new URL(req.url!, "http://localhost"), ctx)) { res.writeHead(404); res.end(); } });
    servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const session = (tier: "admin" | "read" | "guest") => { const made = sessions.create({ tier, surface: "local", label: "Firefox on Linux", tokenEpoch: tokenEpoch(token), ...(tier === "guest" ? { owner: { adapterId: "discord", userId: "g1" } } : {}) });
      return { made, headers: { cookie: `agend_session=${made.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(made.sessionId) } as Record<string, string> }; };
    const get = (headers: Record<string, string>) => new Promise<{ status: number; raw: string }>((resolveCall, reject) => {
      const r = request(`${origin}/ui/backend-login`, { method: "GET", headers }, res => { const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolveCall({ status: res.statusCode!, raw: Buffer.concat(chunks).toString() })); });
      r.on("error", reject); r.end();
    });
    return { token, sessions, refresh, ctx, origin, session, get };
  }
  it("a local admin gets the accounts that are known", async () => {
    const f = await fixture(), admin = f.session("admin"), answer = await f.get(admin.headers);
    expect(answer.status).toBe(200); expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(JSON.parse(answer.raw).targets.map((target: any) => target.identity)).toEqual([{ maskedEmail: "al***@example.com", plan: "team" }, { maskedEmail: "al***@example.com", plan: "team" }]);
  });
  it("no credential, an agent's header token, a read session and a guest get nothing of it, and nothing is read on their behalf", async () => {
    const f = await fixture();
    const answers = [await f.get({ origin: f.origin }), await f.get({ "x-agend-token": f.token, origin: f.origin }), await f.get(f.session("read").headers), await f.get(f.session("guest").headers)];
    expect(answers.map(answer => answer.status)).toEqual([401, 403, 403, 403]);
    for (const answer of answers) expect(answer.raw).not.toMatch(/al\*\*\*@|maskedEmail|identity/);
    expect(f.refresh).not.toHaveBeenCalled();
  });
  it("the public link and the gateway: the route is in neither manifest, and a bound gateway request is refused even as an admin, reading nothing", async () => {
    const f = await fixture();
    expect(isPublicWebRoute("GET", "/ui/backend-login")).toBe(false);
    expect(GUEST_ROUTES.some(r => (r.methods as readonly string[]).includes("GET") && r.pattern.test("/ui/backend-login"))).toBe(false);
    const made = f.sessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "gateway", tokenEpoch: tokenEpoch(f.token) });
    let status = 0, body = "";
    const res: any = { headersSent: false, setHeader() {}, writeHead(n: number) { status = n; this.headersSent = true; }, end(chunk?: string) { body += chunk ?? ""; } };
    const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/backend-login", headers: { host: "x.trycloudflare.com", origin: "https://x.trycloudflare.com", cookie: `__Host-agend_session=${made.sessionId}` }, socket: {} });
    bindGatewayRequest(req as never, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
    expect(handleWebRequest(req as never, res, new URL("https://x.trycloudflare.com/ui/backend-login"), f.ctx)).toBe(true);
    expect(status).toBe(404); expect(body).not.toMatch(/al\*\*\*@|maskedEmail/); expect(f.refresh).not.toHaveBeenCalled();
  });
  it("the answer never waits for a read: a read that never finishes, or one that throws, changes nothing about it (and the sign-in view is still in it)", async () => {
    const f = await fixture(), admin = f.session("admin");
    (f.refresh as any).mockImplementation(() => new Promise(() => {}));            // a hung read: the route must not even look at it
    const first = await f.get(admin.headers); expect(first.status).toBe(200); expect(JSON.parse(first.raw)).toHaveProperty("login");
    (f.refresh as any).mockImplementation(() => { throw new Error(`boom ${RAW}`); });
    const second = await f.get(admin.headers); expect(second.status).toBe(200); expect(second.raw).not.toContain("alice.fixture");
    (f.ctx as any).backendSignInTargets = () => { throw new Error("targets failed"); };
    expect((await f.get(admin.headers)).status).toBe(503);                            // an error is an answer, not an unhandled rejection
  });
  it("while a sign-in is running, a burst of reads of the list starts at most three `auth status` in all and every answer is immediate", async () => {
    const f = makeFleet();
    const sessions = new WebSessionStore({}), token = "burst-scratch-token";
    const logins = new WebBackendLogins({ isLocalAdmin: handle => !!sessions.findByHandle(handle), start: async () => null, accessToken: () => "CODE", isActiveFor: () => true, cancelFor: async () => false, cancel: async () => "", notice() {}, changed() {} });
    const ctx = { webToken: token, webSessions: sessions, webBackendLogins: logins, refreshSignInIdentities: () => f.fm.refreshSignInIdentities(), backendSignInTargets: () => f.fm.backendSignInTargets() } as unknown as WebApiContext;
    const server = createServer((req, res) => { if (!handleWebRequest(req, res, new URL(req.url!, "http://localhost"), ctx)) { res.writeHead(404); res.end(); } });
    servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, made = sessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: tokenEpoch(token) });
    let running = 0, peak = 0, launched = 0; const gates: Array<() => void> = [];
    setAuthCheckRunnerForTests(async () => { launched++; running++; peak = Math.max(peak, running); await new Promise<void>(done => gates.push(done)); running--; return { code: 0, output: status() }; });
    const get = () => new Promise<number>((resolveCall, reject) => { const r = request(`${origin}/ui/backend-login`, { method: "GET", headers: { cookie: `agend_session=${made.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(made.sessionId) } }, res => { res.resume(); res.on("end", () => resolveCall(res.statusCode!)); }); r.on("error", reject); r.end(); });
    const started = Date.now(), statuses = await Promise.all(Array.from({ length: 10 }, get));
    expect(statuses).toEqual(Array(10).fill(200)); expect(Date.now() - started).toBeLessThan(2000);       // none waited for a pending `auth status`
    await vi.waitFor(() => expect(launched).toBe(3)); expect(peak).toBe(3);
    while (f.fm.signInIdentityReads.size) { gates.splice(0).forEach(open => open()); await new Promise(r => setTimeout(r, 5)); }
    expect(peak).toBeLessThanOrEqual(3); expect(launched).toBe(3);                                         // one read per sign-in (default, work, constructor), however many requests
  });
});
