/**
 * #3212 PR 2: Settings → Accounts — + Add account and Remove (accounts-profiles.ts), on a real scratch disk.
 * Remove's safeguards (issuecomment-6684192752), one test per refusal, each deleting nothing: in use (agent, ClassicBot
 * room, fleet default), a wrong or missing typed name, a link at the root / backend / profile level, a way out of the
 * root, not owned, not a directory, the default sign-in's home, a sign-in running, an invalid name, a profile that does
 * not exist; and the positive case — an unused profile's folder is gone (a link inside is removed, its target kept) and
 * the fleet log names who removed which backend's profile. Add: the name rule (Windows-safe), exists, a case clash with
 * a folder or a configured name, a linked root; the folder is private.
 * The routes: the local admin session only (no session, the CLI's token, a read or guest session, the public link:
 * refused, nothing called), the CSRF header, strict bodies, each refusal's status.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, request, type Server } from "node:http";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAccountProfile, removeAccountProfile, type ProfileFs, type ProfileUsers } from "../src/accounts-profiles.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { GUEST_ROUTES } from "../src/web-guest-access.js";
import { FleetManager } from "../src/fleet-manager.js";
import { LoginController } from "../src/login-controller.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-acct-")); dirs.push(d); return d; };
const NOBODY: ProfileUsers = { agents: [], classic: [], fleetDefault: false };
const me = (over: Partial<ProfileFs> = {}): ProfileFs => ({ uid: process.getuid!(), defaultHome: () => null, ...over });
/** A data dir with claude-code profile `name` holding a file; returns the dir and the profile's path. */
function withProfile(name = "spare") {
  const data = scratch(), home = join(data, "credential-profiles", "claude-code", name);
  mkdirSync(home, { recursive: true }); writeFileSync(join(home, ".credentials.json"), "{}");
  return { data, home };
}
const remove = (data: string, over: Partial<Parameters<typeof removeAccountProfile>[1]> = {}, fs = me(), opts: Parameters<typeof removeAccountProfile>[3] = {}) =>
  removeAccountProfile(data, { backend: "claude-code", name: "spare", confirm: "spare", users: NOBODY, signingIn: false, ...over }, fs, opts);

describe("Remove: every refusal deletes nothing", () => {
  it("in use by an agent, a ClassicBot room or the fleet default: refused, and who uses it is named", () => {
    const { data, home } = withProfile();
    for (const users of [{ ...NOBODY, agents: ["dev"] }, { ...NOBODY, classic: ["discord:1:2"] }, { ...NOBODY, fleetDefault: true }]) {
      expect(remove(data, { users })).toEqual({ ok: false, error: "in_use", users });
    }
    expect(existsSync(join(home, ".credentials.json"))).toBe(true);
  });
  it("the typed name must be the profile's own: wrong, other case or missing is refused", () => {
    const { data, home } = withProfile();
    for (const confirm of ["spar", "SPARE", "", undefined, null]) expect(remove(data, { confirm })).toEqual({ ok: false, error: "confirm" });
    expect(existsSync(home)).toBe(true);
  });
  it("a sign-in for it running: refused", () => {
    const { data, home } = withProfile();
    expect(remove(data, { signingIn: true })).toEqual({ ok: false, error: "signing_in" });
    expect(existsSync(home)).toBe(true);
  });
  it("an invalid name or backend: refused before the disk is looked at", () => {
    const { data } = withProfile();
    for (const name of ["", "../spare", "a/b", ".hidden", "CON", "nul.txt", "spare.", "x".repeat(65), 7]) {
      expect(remove(data, { name, confirm: name }), String(name)).toEqual({ ok: false, error: "name" });
    }
    for (const backend of ["antigravity", "grok", "muse", "claude", ""]) expect(remove(data, { backend })).toEqual({ ok: false, error: "backend" });
  });
  it("a profile that does not exist: refused", () => {
    const { data } = withProfile();
    expect(remove(data, { name: "other", confirm: "other" })).toEqual({ ok: false, error: "missing" });
  });
  it("a link at the root, the backend or the profile level: refused, and the link's target is untouched", () => {
    for (const level of ["root", "backend", "profile"] as const) {
      const data = scratch(), elsewhere = scratch();
      const target = join(elsewhere, "credential-profiles", "claude-code", "spare");
      mkdirSync(target, { recursive: true }); writeFileSync(join(target, "keep"), "x");
      const root = join(data, "credential-profiles");
      if (level === "root") symlinkSync(join(elsewhere, "credential-profiles"), root);
      if (level === "backend") { mkdirSync(root); symlinkSync(join(elsewhere, "credential-profiles", "claude-code"), join(root, "claude-code")); }
      if (level === "profile") { mkdirSync(join(root, "claude-code"), { recursive: true }); symlinkSync(target, join(root, "claude-code", "spare")); }
      expect(remove(data), level).toEqual({ ok: false, error: "unsafe" });
      expect(existsSync(join(target, "keep")), level).toBe(true);
    }
  });
  it("not owned by the account running AgEnD: refused", () => {
    const { data, home } = withProfile();
    expect(remove(data, {}, me({ uid: process.getuid!() + 1 }))).toEqual({ ok: false, error: "unsafe" });
    expect(existsSync(home)).toBe(true);
  });
  it("not a directory: refused", () => {
    const data = scratch(); mkdirSync(join(data, "credential-profiles", "claude-code"), { recursive: true });
    writeFileSync(join(data, "credential-profiles", "claude-code", "spare"), "a file");
    expect(remove(data)).toEqual({ ok: false, error: "unsafe" });
    expect(statSync(join(data, "credential-profiles", "claude-code", "spare")).isFile()).toBe(true);
  });
  it("the default sign-in's home — the profile itself, inside it, or containing it: refused", () => {
    const { data, home } = withProfile();
    for (const dflt of [home, join(data, "credential-profiles"), join(home, "inner")]) {
      expect(remove(data, {}, me({ defaultHome: () => dflt })), dflt).toEqual({ ok: false, error: "default_home" });
    }
    expect(existsSync(join(home, ".credentials.json"))).toBe(true);
  });
  it("the real-path check follows the real root: AGEND_HOME reached through a link still removes its own profile", () => {
    // Every way out of the root this host can make without a mount is a link, refused at its level above. The real-path
    // comparison (the profile's real path must be its place under the root's real path) is the backstop for a mount;
    // it must compare against the root's REAL path, so a data dir reached through a link is not refused by it.
    const real = scratch(), linked = join(scratch(), "home-link");
    symlinkSync(real, linked);
    mkdirSync(join(real, "credential-profiles", "claude-code", "spare"), { recursive: true });
    expect(remove(linked)).toEqual({ ok: true });                       // AGEND_HOME through a link: fine
    expect(existsSync(join(real, "credential-profiles", "claude-code", "spare"))).toBe(false);
  });
});

describe("Remove after a wait (#3305 review P2-2)", () => {
  it("a dry run proves everything and changes nothing; the real removal must find the same folder", () => {
    const { data, home } = withProfile();
    const dry = remove(data, {}, me(), { dryRun: true });
    expect([dry.ok, existsSync(home)]).toEqual([true, true]);
    const identity = (dry as any).identity;
    expect(remove(data, {}, me(), { expect: { ...identity, ino: identity.ino + 1 } })).toEqual({ ok: false, error: "unsafe" });
    expect(existsSync(home)).toBe(true);
    expect(remove(data, {}, me(), { expect: identity })).toEqual({ ok: true });
  });
});

describe("Remove: the positive case", () => {
  it("an unused profile's folder is gone; a link inside is removed, never followed; nothing hidden is left", () => {
    const { data, home } = withProfile();
    const shared = scratch(); writeFileSync(join(shared, "projects.jsonl"), "shared conversation");
    symlinkSync(shared, join(home, "projects"));                        // a relocated home links shared parts back
    expect(remove(data)).toEqual({ ok: true });
    expect(existsSync(home)).toBe(false);
    expect(readdirSync(join(data, "credential-profiles", "claude-code"))).toEqual([]);
    expect(existsSync(join(shared, "projects.jsonl"))).toBe(true);
  });
  it("FleetManager: who uses it comes from the configuration; the fleet log names who removed which profile", async () => {
    const { data } = withProfile();
    const info = vi.fn();
    const self: any = {
      dataDir: data, logger: { info },
      accountUses: () => ({ agents: [{ name: "dev", backend: "claude-code", profile: "spare" }, { name: "ops", backend: "codex", profile: "spare" }],
        classic: [], fleetDefaults: new Map([["codex", "spare"]]) }),
      loginWindow: { current: null }, loginController: { signingIn: () => false, activeBackend: null },
      removalRequest: (FleetManager.prototype as any).removalRequest, withAccountWriter: (FleetManager.prototype as any).withAccountWriter, accountWriters: new Set(),
    };
    const call = (fm: any, ...a: unknown[]): Promise<any> => (FleetManager.prototype as any).removeAccountProfile.call(fm, ...a);
    expect(await call(self, "claude-code", "spare", "spare", "Firefox on Linux")).toEqual({ ok: false, error: "in_use", users: { agents: ["dev"], classic: [], fleetDefault: false } });
    // A sign-in for this backend whose profile is not known yet (the window held, no active entry): refused too.
    self.accountUses = () => ({ agents: [], classic: [], fleetDefaults: new Map() });
    self.loginWindow = { current: { id: 1, kind: "web", backend: "claude-code" } };
    expect(await call(self, "claude-code", "spare", "spare", "x")).toEqual({ ok: false, error: "signing_in" });
    self.loginWindow = { current: null };
    self.loginController = { signingIn: (b: string, p: string) => b === "claude-code" && p === "spare", activeBackend: "claude-code" };
    expect(await call(self, "claude-code", "spare", "spare", "x")).toEqual({ ok: false, error: "signing_in" });
    self.loginController = { signingIn: () => false, activeBackend: null };
    info.mockClear();
    expect(await call(self, "claude-code", "spare", "spare", "Firefox on Linux")).toEqual({ ok: true });
    expect(info).toHaveBeenCalledWith({ backend: "claude-code", profile: "spare", by: "Firefox on Linux" }, "Credential profile removed from Settings → Accounts");
    expect(JSON.stringify(info.mock.calls)).not.toContain(data);        // never a path
  });
});

describe("#3291 review (Prism): who uses it is never under-counted", () => {
  const call = (fm: any, ...a: unknown[]): Promise<any> => (FleetManager.prototype as any).removeAccountProfile.call(fm, ...a);
  const fm = (data: string, over: Record<string, unknown> = {}) => ({
    dataDir: data, logger: { info: vi.fn() }, fleetConfig: { defaults: {}, instances: {} },
    accountUses: () => ({ agents: [], classic: [], fleetDefaults: new Map() }),
    loginWindow: { current: null }, loginController: { signingIn: () => false, activeBackend: null },
    removalRequest: (FleetManager.prototype as any).removalRequest, withAccountWriter: (FleetManager.prototype as any).withAccountWriter, accountWriters: new Set(), ...over,
  });
  const daemon = (cfg: Record<string, unknown>) => ({ getConfigSnapshot: () => cfg });
  it("P2-1: a running CLI launched on it is a user, though the configuration has moved off it", async () => {
    const { data, home } = withProfile();
    const daemons = new Map<string, unknown>([
      ["moved", daemon({ backend: "claude-code", backend_options: { "claude-code": { credential_profile: "spare" } } })],
      ["other", daemon({ backend: "claude-code", backend_options: { "claude-code": { credential_profile: "work" } } })],
      ["win", daemon({ backend: "claude-code", runtime: "windows", backend_options: { "claude-code": { credential_profile: "spare" } } })],
      ["cx", daemon({ backend: "codex", backend_options: { codex: { credential_profile: "spare" } } })],
    ]);
    expect(await call(fm(data, { daemons }), "claude-code", "spare", "spare", "x")).toEqual({ ok: false, error: "in_use", users: { agents: ["moved"], classic: [], fleetDefault: false } });
    expect(existsSync(home)).toBe(true);
    daemons.delete("moved");                                             // it stopped: nothing launched on it is left
    expect(await call(fm(data, { daemons }), "claude-code", "spare", "spare", "x")).toEqual({ ok: true });
  });
  it("P2-2: an unreadable or malformed classicBot.yaml refuses (nothing proves no room uses it); an absent one does not", async () => {
    for (const body of ["channels: [1, 2]\n", "channels:\n  a: [\n", "- a list\n"]) {
      const { data, home } = withProfile();
      writeFileSync(join(data, "classicBot.yaml"), body);
      expect(await call(fm(data), "claude-code", "spare", "spare", "x"), body).toEqual({ ok: false, error: "users_unknown" });
      expect(existsSync(home)).toBe(true);
    }
    const { data, home } = withProfile();
    writeFileSync(join(data, "classicBot.yaml"), "channels: {}\n"); chmodSync(join(data, "classicBot.yaml"), 0o000);
    expect(await call(fm(data), "claude-code", "spare", "spare", "x")).toEqual({ ok: false, error: "users_unknown" });
    chmodSync(join(data, "classicBot.yaml"), 0o600);
    // A room that uses it, read from the file, is named; with no file there are no rooms.
    writeFileSync(join(data, "classicBot.yaml"), "channels:\n  room1:\n    backend: claude-code\n    backend_options:\n      claude-code:\n        credential_profile: Spare\n");
    expect(await call(fm(data), "claude-code", "spare", "spare", "x")).toEqual({ ok: false, error: "in_use", users: { agents: [], classic: ["room1"], fleetDefault: false } });
    rmSync(join(data, "classicBot.yaml"));
    expect(await call(fm(data), "claude-code", "spare", "spare", "x")).toEqual({ ok: true });
    expect(existsSync(home)).toBe(false);
  });
  it("P2-3: a case variant is the same account — configured, launched, the fleet default, and a sign-in", async () => {
    const { data } = withProfile("Work");
    const uses = (agents: unknown[], fd?: string) => () => ({ agents, classic: [], fleetDefaults: new Map(fd ? [["claude-code", fd]] : []) });
    expect((await call(fm(data, { accountUses: uses([{ name: "dev", backend: "claude-code", profile: "work" }]) }), "claude-code", "Work", "Work", "x")).error).toBe("in_use");
    expect((await call(fm(data, { accountUses: uses([], "WORK") }), "claude-code", "Work", "Work", "x")).users.fleetDefault).toBe(true);
    const daemons = new Map([["d", daemon({ backend: "claude-code", backend_options: { "claude-code": { credential_profile: "work" } } })]]);
    expect((await call(fm(data, { daemons }), "claude-code", "Work", "Work", "x")).users.agents).toEqual(["d"]);
    const signingIn = (LoginController.prototype as any).signingIn;
    expect(signingIn.call({ active: { backend: "claude-code", profile: "work" }, pendingTunnelStart: null }, "claude-code", "Work")).toBe(true);
    expect(signingIn.call({ active: { backend: "claude-code", profile: "other" }, pendingTunnelStart: null }, "claude-code", "Work")).toBe(false);
    expect(signingIn.call({ active: { backend: "claude-code" }, pendingTunnelStart: null }, "claude-code", null)).toBe(true);
  });
});

describe("Add", () => {
  it("creates the folder, private to this account", () => {
    const data = scratch();
    expect(addAccountProfile(data, "codex", "work")).toEqual({ ok: true });
    const st = lstatSync(join(data, "credential-profiles", "codex", "work"));
    expect([st.isDirectory(), st.mode & 0o777]).toEqual([true, 0o700]);
  });
  it("refuses an invalid name or backend, an existing one, and a case clash with a folder or a configured name", () => {
    const data = scratch();
    for (const name of ["", "../x", "CON", "a.", ".x", "x".repeat(65), 3]) expect(addAccountProfile(data, "codex", name), String(name)).toEqual({ ok: false, error: "name" });
    expect(addAccountProfile(data, "grok", "work")).toEqual({ ok: false, error: "backend" });
    expect(addAccountProfile(data, "codex", "work")).toEqual({ ok: true });
    expect(addAccountProfile(data, "codex", "work")).toEqual({ ok: false, error: "exists" });
    expect(addAccountProfile(data, "codex", "Work")).toEqual({ ok: false, error: "case_clash", clash: "work" });
    expect(addAccountProfile(data, "codex", "team", ["Team"])).toEqual({ ok: false, error: "case_clash", clash: "Team" });
    expect(readdirSync(join(data, "credential-profiles", "codex"))).toEqual(["work"]);
  });
  it("a linked root or backend folder: refused, nothing made through it", () => {
    const data = scratch(), elsewhere = scratch();
    symlinkSync(elsewhere, join(data, "credential-profiles"));
    expect(addAccountProfile(data, "codex", "work")).toEqual({ ok: false, error: "unsafe_root" });
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("the routes", () => {
  const servers: Server[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r())); });
  async function fixture() {
    const token = "accounts-scratch-token";
    const sessions = new WebSessionStore({});
    const add = vi.fn((_b: string, _n: unknown, _by: string) => ({ ok: true } as any));
    const rm = vi.fn((_b: string, _n: unknown, _c: unknown, _by: string) => ({ ok: true } as any));
    const ctx = { webToken: token, webSessions: sessions, addAccountProfile: add, removeAccountProfile: rm } as unknown as WebApiContext;
    const server = createServer((req, res) => { if (!handleWebRequest(req, res, new URL(req.url!, "http://localhost"), ctx)) { res.writeHead(404); res.end(); } });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const session = (tier: "admin" | "read" | "guest" = "admin") => {
      const made = sessions.create({ tier, surface: "local", label: "Firefox on Linux", tokenEpoch: tokenEpoch(token), ...(tier === "guest" ? { owner: { adapterId: "discord", userId: "g1" } } : {}) });
      return { cookie: `agend_session=${made.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(made.sessionId), "content-type": "application/json" } as Record<string, string>;
    };
    const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      // A body's length is always sent (as a browser's fetch does): Node's own client sends a DELETE body without one.
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = request(`${origin}${path}`, { method, headers: { ...headers, ...(data ? { "content-length": String(data.length) } : {}) } }, res => {
        const chunks: Buffer[] = []; res.on("data", c => chunks.push(c));
        res.on("end", () => { const raw = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); });
      });
      r.on("error", reject); r.end(data);
    });
    return { add, rm, sessions, token, origin, session, call, ctx };
  }

  it("the local admin session: add and remove reach the fleet, with the session's label", async () => {
    const f = await fixture(), a = f.session();
    expect(await f.call("POST", "/ui/accounts/codex", a, { name: "work" })).toEqual({ status: 200, body: { added: "work" } });
    expect(f.add).toHaveBeenCalledWith("codex", "work", "Firefox on Linux");
    expect(await f.call("DELETE", "/ui/accounts/claude-code/spare", a, { confirm: "spare" })).toEqual({ status: 200, body: { removed: "spare" } });
    expect(f.rm).toHaveBeenCalledWith("claude-code", "spare", "spare", "Firefox on Linux");
  });
  it("no session, the CLI's token, a read or guest session, or no CSRF header: refused, nothing called", async () => {
    const f = await fixture();
    expect((await f.call("POST", "/ui/accounts/codex", { origin: f.origin, "content-type": "application/json" }, { name: "w" })).status).toBe(401);
    expect((await f.call("DELETE", "/ui/accounts/codex/w", { "x-agend-token": f.token, origin: f.origin, "content-type": "application/json" }, { confirm: "w" })))
      .toMatchObject({ status: 403, body: { error: "accounts_need_a_local_admin" } });
    for (const tier of ["read", "guest"] as const) {
      expect((await f.call("DELETE", "/ui/accounts/codex/w", f.session(tier), { confirm: "w" })).status, tier).toBe(403);
    }
    const { "x-agend-csrf": _c, ...noCsrf } = f.session();
    expect((await f.call("DELETE", "/ui/accounts/codex/w", noCsrf, { confirm: "w" })).status).toBe(401);
    expect([f.add.mock.calls.length, f.rm.mock.calls.length]).toEqual([0, 0]);
  });
  it("the public link: not in its manifest or the guest table; a bound gateway request is refused even as an admin", async () => {
    const f = await fixture();
    for (const [method, path] of [["POST", "/ui/accounts/codex"], ["DELETE", "/ui/accounts/codex/w"]] as const) {
      expect(isPublicWebRoute(method, path)).toBe(false);
      expect(GUEST_ROUTES.some(r => (r.methods as readonly string[]).includes(method) && r.pattern.test(path))).toBe(false);
      const made = f.sessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "gateway", tokenEpoch: tokenEpoch(f.token) });
      let status = 0;
      const res: any = { headersSent: false, setHeader() {}, writeHead(n: number) { status = n; this.headersSent = true; return this; }, end() {} };
      const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "x.trycloudflare.com", origin: "https://x.trycloudflare.com", cookie: `__Host-agend_session=${made.sessionId}`, "x-agend-csrf": csrfTokenFor(made.sessionId) }, destroy() {}, resume() {} });
      bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
      let sent = "";
      res.end = (chunk?: unknown) => { sent = String(chunk ?? ""); };
      expect(handleWebRequest(req as never, res, new URL(`https://x.trycloudflare.com${path}`), f.ctx)).toBe(true);
      expect([status, JSON.parse(sent).error]).toEqual([403, "accounts_not_over_public_link"]);
    }
    expect([f.add.mock.calls.length, f.rm.mock.calls.length]).toEqual([0, 0]);
  });
  it("strict bodies and paths; each refusal keeps its code and status, and in-use names who uses it", async () => {
    const f = await fixture(), a = f.session();
    expect((await f.call("POST", "/ui/accounts/codex", a, { name: "w", extra: 1 })).status).toBe(400);
    expect((await f.call("DELETE", "/ui/accounts/codex/w", a, { name: "w" })).status).toBe(400);
    expect((await f.call("POST", "/ui/accounts/codex/w", a, { name: "w" })).status).toBe(404);
    expect((await f.call("PUT", "/ui/accounts/codex", a, { name: "w" })).status).toBe(404);
    const users = { agents: ["dev"], classic: [], fleetDefault: true };
    const cases: Array<[string, number]> = [["confirm", 400], ["name", 400], ["in_use", 409], ["signing_in", 409], ["missing", 404], ["unsafe", 409], ["default_home", 409], ["failed", 500]];
    for (const [error, status] of cases) {
      f.rm.mockReturnValueOnce({ ok: false, error, ...(error === "in_use" ? { users } : {}) });
      expect(await f.call("DELETE", "/ui/accounts/claude-code/spare", a, { confirm: "spare" }), error).toEqual({ status, body: { error, ...(error === "in_use" ? { users } : {}) } });
    }
    f.add.mockReturnValueOnce({ ok: false, error: "case_clash", clash: "Work" });
    expect(await f.call("POST", "/ui/accounts/codex", a, { name: "work" })).toEqual({ status: 409, body: { error: "case_clash", clash: "Work" } });
    // An encoded name reaches the fleet decoded (and the fleet's rule refuses it).
    await f.call("DELETE", "/ui/accounts/claude-code/..%2Fx", a, { confirm: "../x" });
    expect(f.rm).toHaveBeenLastCalledWith("claude-code", "../x", "../x", "Firefox on Linux");
  });
});
