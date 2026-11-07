/**
 * #3212 PR 3: Settings → Accounts → Sign out (accounts-signout.ts), on a real scratch disk with the CLI stood in.
 * - Each CLI's own logout, run as a launch runs it: Claude Code `auth logout`, Codex `logout`, Kiro `logout`, with the
 *   profile's variable (CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_DATA_HOME) for a named account and none for the default;
 *   a CLI with no logout is refused, as is an unconfirmed request, an invalid name, a folder that is not AgEnD's own and
 *   a sign-in running — none of them runs anything. A logout that fails (non-zero, killed, not found) is said.
 * - Claude Code's backups that still name the account: every one in a named profile's folder; in the default sign-in's
 *   folder only the ones this logout wrote. Never a link.
 * - macOS: AgEnD never deletes a Keychain item; one still found after the logout (named profile: the service named after
 *   its folder; default: the unsuffixed one) is reported. Elsewhere the Keychain is never asked.
 * - FleetManager: refused while a sign-in for it runs (case-insensitive, and the window held for its backend); the log
 *   says who signed out which account, then the sign-ins are read again. Remove on macOS runs Claude Code's logout first,
 *   only after every Remove check passed (a refused Remove logs nobody out), and reports an item left.
 * - The route: the local admin session only; strict body ({ profile, confirm: true }).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signOutAccount, removeClaudeBackups, SIGN_OUT, CLAUDE_DEFAULT_KEYCHAIN_SERVICE } from "../src/accounts-signout.js";
import { claudeKeychainService } from "../src/backend/claude-code.js";
import { credentialProfileHome } from "../src/backend/credential-profile.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-signout-")); dirs.push(d); return d; };
const fsMine = { uid: process.getuid!(), defaultHome: () => null };
function profileDir(backend = "claude-code", name = "work") {
  const data = scratch(), home = join(data, "credential-profiles", backend, name);
  mkdirSync(home, { recursive: true });
  return { data, home };
}
function runner(code: number | null = 0, onRun?: () => void) {
  const runs: Array<{ binary: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  return { runs, run: async (binary: string, args: readonly string[], env: NodeJS.ProcessEnv) => { runs.push({ binary, args, env }); onRun?.(); return { code }; } };
}
const noKeychain = async () => { throw new Error("the Keychain is asked only on macOS"); };

describe("Sign out: refusals run nothing", () => {
  it("a CLI with no logout, no confirmation, an invalid name, a folder that isn't AgEnD's own, a sign-in running", async () => {
    const { data } = profileDir();
    const r = runner();
    const go = (over: Record<string, unknown>) => signOutAccount(data, { backend: "claude-code", profile: "work", confirm: true, signingIn: false, ...over } as any, { run: r.run, keychainHas: noKeychain, platform: "linux", fs: fsMine });
    for (const backend of ["grok", "antigravity", "muse", "nope", "__proto__"]) expect(await go({ backend }), backend).toEqual({ ok: false, error: "unsupported" });
    for (const confirm of [false, "yes", 1, undefined]) expect(await go({ confirm }), String(confirm)).toEqual({ ok: false, error: "confirm" });
    for (const profile of ["../x", "CON", "a.", ""]) expect(await go({ profile }), profile).toEqual({ ok: false, error: "name" });
    expect(await go({ profile: "missing" })).toEqual({ ok: false, error: "missing" });
    expect(await go({ signingIn: true })).toEqual({ ok: false, error: "signing_in" });
    const other = scratch(); mkdirSync(join(other, "x"), { recursive: true });
    const linked = scratch(); mkdirSync(join(linked, "credential-profiles", "claude-code"), { recursive: true });
    symlinkSync(join(other, "x"), join(linked, "credential-profiles", "claude-code", "work"));
    expect(await signOutAccount(linked, { backend: "claude-code", profile: "work", confirm: true, signingIn: false }, { run: r.run, keychainHas: noKeychain, platform: "linux", fs: fsMine })).toEqual({ ok: false, error: "unsafe" });
    expect(r.runs).toEqual([]);
  });
});

describe("Sign out: each CLI's own logout, with the account's variable", () => {
  it("named accounts: claude auth logout / codex logout / kiro-cli logout, each with its profile's folder", async () => {
    for (const [backend, variable] of [["claude-code", "CLAUDE_CONFIG_DIR"], ["codex", "CODEX_HOME"], ["kiro-cli", "XDG_DATA_HOME"]] as const) {
      const { data } = profileDir(backend);
      const r = runner();
      expect(await signOutAccount(data, { backend, profile: "work", confirm: true, signingIn: false }, { run: r.run, keychainHas: noKeychain, platform: "linux", env: { PATH: "/bin" }, fs: fsMine })).toEqual({ ok: true });
      expect(r.runs.map((x) => [x.binary, x.args, x.env[variable], x.env.PATH])).toEqual([[SIGN_OUT[backend]!.binary, SIGN_OUT[backend]!.args, credentialProfileHome(data, backend, "work"), "/bin"]]);
    }
    expect(SIGN_OUT["claude-code"]).toEqual({ binary: "claude", args: ["auth", "logout"] });
    expect([SIGN_OUT.codex!.args, SIGN_OUT["kiro-cli"]!.args]).toEqual([["logout"], ["logout"]]);
  });
  it("the default sign-in: the fleet's own environment, no profile variable added", async () => {
    const data = scratch(), r = runner();
    expect(await signOutAccount(data, { backend: "codex", profile: null, confirm: true, signingIn: false }, { run: r.run, keychainHas: noKeychain, platform: "linux", env: { PATH: "/bin" }, fs: fsMine })).toEqual({ ok: true });
    expect(r.runs[0]!.env).toEqual({ PATH: "/bin" });
  });
  it("a logout that fails — non-zero, killed, not found, throws — is said", async () => {
    for (const run of [runner(1).run, runner(null).run, async () => { throw new Error("spawn ENOENT"); }]) {
      const { data } = profileDir("codex");
      expect(await signOutAccount(data, { backend: "codex", profile: "work", confirm: true, signingIn: false }, { run, keychainHas: noKeychain, platform: "linux", fs: fsMine })).toEqual({ ok: false, error: "failed" });
    }
  });
});

describe("Claude Code's backups that still name the account", () => {
  it("named profile: every .claude.json backup goes; a link is never followed; other files stay", async () => {
    const { data, home } = profileDir();
    const backups = join(home, "backups"); mkdirSync(backups);
    const outside = scratch(); writeFileSync(join(outside, "keep"), "x");
    writeFileSync(join(backups, ".claude.json.backup.1"), "{}"); writeFileSync(join(backups, ".claude.json.backup.2"), "{}");
    writeFileSync(join(backups, "notes.txt"), "mine"); symlinkSync(join(outside, "keep"), join(backups, ".claude.json.backup.link"));
    const r = runner(0, () => writeFileSync(join(backups, ".claude.json.backup.3"), "{\"oauthAccount\":{}}"));
    expect(await signOutAccount(data, { backend: "claude-code", profile: "work", confirm: true, signingIn: false }, { run: r.run, keychainHas: noKeychain, platform: "linux", fs: fsMine })).toEqual({ ok: true });
    expect(readdirSync(backups).sort()).toEqual([".claude.json.backup.link", "notes.txt"]);
    expect(existsSync(join(outside, "keep"))).toBe(true);
  });
  it("the default sign-in's folder: only the backups this logout wrote (older ones are the person's own)", async () => {
    const cfg = scratch(), backups = join(cfg, "backups"); mkdirSync(backups);
    writeFileSync(join(backups, ".claude.json.backup.old"), "{}");
    const past = new Date(Date.now() - 3_600_000); utimesSync(join(backups, ".claude.json.backup.old"), past, past);
    const saved = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      const r = runner(0, () => writeFileSync(join(backups, ".claude.json.backup.new"), "{}"));
      expect(await signOutAccount(scratch(), { backend: "claude-code", profile: null, confirm: true, signingIn: false }, { run: r.run, keychainHas: noKeychain, platform: "linux", fs: fsMine })).toEqual({ ok: true });
      expect(readdirSync(backups)).toEqual([".claude.json.backup.old"]);
    } finally { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; }
  });
  it("removeClaudeBackups: no backups folder, or a linked one, removes nothing", () => {
    const cfg = scratch(), outside = scratch(); writeFileSync(join(outside, ".claude.json.backup.1"), "{}");
    expect(removeClaudeBackups(cfg, { all: true })).toBe(0);
    symlinkSync(outside, join(cfg, "backups"));
    expect(removeClaudeBackups(cfg, { all: true })).toBe(0);
    expect(existsSync(join(outside, ".claude.json.backup.1"))).toBe(true);
  });
});

describe("macOS Keychain: never deleted by AgEnD, reported when one is left", () => {
  it("named profile: the service named after its folder; default: the unsuffixed one; elsewhere never asked", async () => {
    const { data, home } = profileDir();
    const asked: string[] = [];
    const has = (left: boolean) => async (service: string) => { asked.push(service); return left; };
    expect(await signOutAccount(data, { backend: "claude-code", profile: "work", confirm: true, signingIn: false }, { run: runner().run, keychainHas: has(false), platform: "darwin", fs: fsMine })).toEqual({ ok: true });
    expect(await signOutAccount(data, { backend: "claude-code", profile: "work", confirm: true, signingIn: false }, { run: runner().run, keychainHas: has(true), platform: "darwin", fs: fsMine })).toEqual({ ok: true, keychainLeft: true });
    expect(await signOutAccount(data, { backend: "claude-code", profile: null, confirm: true, signingIn: false }, { run: runner().run, keychainHas: has(true), platform: "darwin", fs: fsMine })).toEqual({ ok: true, keychainLeft: true });
    expect(asked).toEqual([claudeKeychainService(home), claudeKeychainService(home), CLAUDE_DEFAULT_KEYCHAIN_SERVICE]);
    expect(claudeKeychainService(home)).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(await signOutAccount(data, { backend: "codex", profile: null, confirm: true, signingIn: false }, { run: runner().run, keychainHas: noKeychain, platform: "darwin", fs: fsMine })).toEqual({ ok: true });
  });
});

describe("FleetManager", () => {
  const signOut = (fm: any, ...a: unknown[]): Promise<any> => (FleetManager.prototype as any).signOutAccount.call(fm, ...a);
  const remove = (fm: any, ...a: unknown[]): Promise<any> => (FleetManager.prototype as any).removeAccountProfile.call(fm, ...a);
  const self = (data: string, over: Record<string, unknown> = {}) => {
    const info = vi.fn(), events: unknown[] = [];
    return { info, events, fm: <any>{
      dataDir: data, logger: { info, debug: vi.fn() }, fleetConfig: { defaults: {}, instances: {} }, sseClients: new Set(),
      accountUses: () => ({ agents: [], classic: [], fleetDefaults: new Map() }),
      loginWindow: { current: null }, loginController: { signingIn: () => false, activeBackend: null },
      forgetSignInIdentities: () => events.push("forget"), backendAvailability: { refresh: async (b: string[]) => { events.push(["refresh", b]); } },
      accountSignOutDeps: { platform: "linux", run: runner().run, keychainHas: noKeychain }, ...over,
    } };
  };
  it("signs out, logs who signed out which account (no path), reads the sign-ins again", async () => {
    const { data } = profileDir();
    const s = self(data);
    expect(await signOut(s.fm, "claude-code", "work", true, "Firefox on Linux")).toEqual({ ok: true });
    expect(s.info).toHaveBeenCalledWith({ backend: "claude-code", profile: "work", by: "Firefox on Linux" }, "Account signed out from Settings → Accounts");
    expect(JSON.stringify(s.info.mock.calls)).not.toContain(data);
    expect(s.events).toEqual(["forget", ["refresh", ["claude-code"]]]);
    expect(await signOut(s.fm, "claude-code", null, true, "x")).toEqual({ ok: true });
    expect(s.info).toHaveBeenLastCalledWith({ backend: "claude-code", profile: "(default)", by: "x" }, "Account signed out from Settings → Accounts");
  });
  it("refused while a sign-in for it runs: the controller (any letter case), or the window held for its backend", async () => {
    const { data } = profileDir();
    const r = runner();
    const s = self(data, { loginController: { signingIn: (b: string, p: string | null) => b === "claude-code" && (p ?? "").toLowerCase() === "work", activeBackend: "claude-code" },
      accountSignOutDeps: { platform: "linux", run: r.run, keychainHas: noKeychain } });
    expect(await signOut(s.fm, "claude-code", "work", true, "x")).toEqual({ ok: false, error: "signing_in" });
    s.fm.loginController = { signingIn: () => false, activeBackend: null };
    s.fm.loginWindow = { current: { id: 1, kind: "web", backend: "claude-code" } };
    expect(await signOut(s.fm, "claude-code", "work", true, "x")).toEqual({ ok: false, error: "signing_in" });
    expect(r.runs).toEqual([]);
  });
  it("Remove on macOS: Claude Code's own logout first — only once every Remove check passed; an item left is reported", async () => {
    const { data, home } = profileDir("claude-code", "spare");
    const r = runner();
    const s = self(data, { accountSignOutDeps: { platform: "darwin", run: r.run, keychainHas: async () => true },
      accountUses: () => ({ agents: [{ name: "dev", backend: "claude-code", profile: "spare" }], classic: [], fleetDefaults: new Map() }) });
    expect((await remove(s.fm, "claude-code", "spare", "spare", "x")).error).toBe("in_use");
    expect(await remove(s.fm, "claude-code", "spare", "wrong", "x")).toEqual({ ok: false, error: "confirm" });
    expect([r.runs.length, existsSync(home)]).toEqual([0, true]);               // a refused Remove logs nobody out
    s.fm.accountUses = () => ({ agents: [], classic: [], fleetDefaults: new Map() });
    expect(await remove(s.fm, "claude-code", "spare", "spare", "x")).toEqual({ ok: true, keychainLeft: true });
    expect(r.runs.map((x) => [x.binary, x.args, x.env.CLAUDE_CONFIG_DIR])).toEqual([["claude", ["auth", "logout"], credentialProfileHome(data, "claude-code", "spare")]]);
    expect(existsSync(home)).toBe(false);
  });
  it("Remove on macOS: a logout that fails deletes nothing; elsewhere no logout runs", async () => {
    const { data, home } = profileDir("claude-code", "spare");
    const failing = self(data, { accountSignOutDeps: { platform: "darwin", run: runner(1).run, keychainHas: noKeychain } });
    expect(await remove(failing.fm, "claude-code", "spare", "spare", "x")).toEqual({ ok: false, error: "failed" });
    expect(existsSync(home)).toBe(true);
    const r = runner();
    const linux = self(data, { accountSignOutDeps: { platform: "linux", run: r.run, keychainHas: noKeychain } });
    expect(await remove(linux.fm, "claude-code", "spare", "spare", "x")).toEqual({ ok: true });
    expect(r.runs).toEqual([]);
  });
});

describe("the route", () => {
  const servers: Server[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r())); });
  it("the local admin session only; { profile, confirm: true }; refusals keep their code; an item left is said", async () => {
    const token = "signout-scratch-token", sessions = new WebSessionStore({});
    const out = vi.fn(async (_b: string, _p: unknown, _c: unknown, _by: string) => ({ ok: true } as any));
    const ctx = { webToken: token, webSessions: sessions, signOutAccount: out } as unknown as WebApiContext;
    const server = createServer((req, res) => { if (!handleWebRequest(req, res, new URL(req.url!, "http://localhost"), ctx)) { res.writeHead(404); res.end(); } });
    servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const as = (tier: "admin" | "read") => { const m = sessions.create({ tier, surface: "local", label: "Firefox", tokenEpoch: tokenEpoch(token) });
      return { cookie: `agend_session=${m.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(m.sessionId), "content-type": "application/json" } as Record<string, string>; };
    const call = (headers: Record<string, string>, body: unknown, path = "/ui/accounts/claude-code/signout") => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body));
      const r = request(`${origin}${path}`, { method: "POST", headers: { ...headers, "content-length": String(data.length) } }, res => {
        const c: Buffer[] = []; res.on("data", x => c.push(x)); res.on("end", () => { const raw = Buffer.concat(c).toString(); resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); });
      }); r.on("error", reject); r.end(data);
    });
    expect((await call(as("read"), { profile: "work", confirm: true })).status).toBe(403);
    expect((await call(as("admin"), { profile: "work", confirm: false })).status).toBe(400);
    expect((await call(as("admin"), { profile: "work" })).status).toBe(400);
    expect(out).not.toHaveBeenCalled();
    expect(await call(as("admin"), { profile: "work", confirm: true })).toEqual({ status: 200, body: { signedOut: "work" } });
    expect(out).toHaveBeenLastCalledWith("claude-code", "work", true, "Firefox");
    out.mockResolvedValueOnce({ ok: true, keychainLeft: true });
    expect(await call(as("admin"), { profile: null, confirm: true })).toEqual({ status: 200, body: { signedOut: null, keychainLeft: true } });
    for (const [error, status] of [["unsupported", 400], ["signing_in", 409], ["failed", 500], ["missing", 404]] as const) {
      out.mockResolvedValueOnce({ ok: false, error });
      expect(await call(as("admin"), { profile: "work", confirm: true }), error).toEqual({ status, body: { error } });
    }
  });
});
