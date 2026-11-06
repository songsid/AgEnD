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

describe("the host's own sign-in list: which account is each Claude Code sign-in", () => {
  it("shows the masked e-mail and plan of the default sign-in and of every profile an agent uses, from one `auth status` each", async () => {
    const f = makeFleet(); f.answers.set("work", status({ email: "bob.fixture@example.org", subscriptionType: "max" })); f.answers.set("constructor", status({ subscriptionType: "something-new" }));
    expect(f.fm.backendSignInTargets().some((target: any) => target.identity)).toBe(false);       // nothing read yet: nothing shown
    await f.fm.refreshSignInIdentities();
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
    const f = makeFleet(); await f.fm.refreshSignInIdentities();
    expect(text(f.fm.backendSignInTargets())).not.toContain("alice.fixture"); expect(text(f.logs)).not.toContain("alice.fixture");
    const files = (dir: string): string => readdirSync(dir, { withFileTypes: true }).map(entry => entry.isDirectory() ? files(join(dir, entry.name)) : statSync(join(dir, entry.name)).size < 1e6 ? readFileSync(join(dir, entry.name), "utf8") : "").join("");
    expect(files(f.dir)).not.toContain("alice.fixture");
  });
  it("asks at most once in five minutes, again after a sign-in changed, and never starts a second login or a network request of its own", async () => {
    const f = makeFleet(); await f.fm.refreshSignInIdentities(); const first = f.calls.length; await f.fm.refreshSignInIdentities();
    expect(f.calls).toHaveLength(first);
    f.fm.signInIdentities.clear(); await f.fm.refreshSignInIdentities(); expect(f.calls.length).toBe(first * 2);
    for (const call of f.calls) expect(call.argv.join(" ")).not.toMatch(/login|logout|http/);
  });
  it("shows nothing for a sign-in that cannot be read: a failing or unreadable answer, an API key keeps only its kind", async () => {
    const f = makeFleet(); f.answers.set("work", "not json"); f.answers.set("constructor", JSON.stringify({ loggedIn: true, authMethod: "api_key" }));
    await f.fm.refreshSignInIdentities();
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
  it("is bounded: a slow check does not hold the list for more than the cap, and its answer lands for the next read", async () => {
    vi.useFakeTimers();
    try {
      const f = makeFleet(); let release!: () => void;
      setAuthCheckRunnerForTests(async () => { await new Promise<void>(done => { release = done; }); return { code: 0, output: status() }; });
      const waiting = f.fm.refreshSignInIdentities(); await vi.advanceTimersByTimeAsync(4100); await waiting;
      expect(f.fm.backendSignInTargets().some((target: any) => target.identity)).toBe(false);
      release(); await vi.advanceTimersByTimeAsync(10);
    } finally { vi.useRealTimers(); }
  });
});

describe("who is served the list with the accounts in it: a local administrator session only", () => {
  async function fixture() {
    const token = "host-identity-scratch-token", sessions = new WebSessionStore({});
    const identity = { maskedEmail: "al***@example.com", plan: "team" };
    const refresh = vi.fn(async () => {});
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
  it("a local admin gets the accounts, after the bounded read", async () => {
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
  it("a session revoked while the accounts were being read gets nothing", async () => {
    const f = await fixture(), admin = f.session("admin");
    f.refresh.mockImplementation(async () => { f.sessions.revokeByHandle(admin.made.record.handle); });
    const answer = await f.get(admin.headers);
    expect([401, 403]).toContain(answer.status); expect(answer.raw).not.toMatch(/al\*\*\*@|maskedEmail/);
  });
});
