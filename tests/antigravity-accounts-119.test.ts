/**
 * AGEND-119: Antigravity gets several accounts on this host, a sign-out, and a Keep sign-in alive run.
 *
 * What was measured on the real agy 1.5.3 (Linux, and agy.exe on Windows; the evidence is in the issue) and is held here against drift:
 *  - agy takes the account's folder as `--app_data_dir <path relative to ~/.gemini>`, a `..` path included, and keeps the sign-in in `<folder>/antigravity-oauth-token`;
 *  - its keyring is shared by every folder, so every launch of a named account also carries `SSH_CONNECTION` (the registry's `pin`), which makes agy keep the sign-in in that file;
 *  - it has no logout command: deleting the file signs the account out, and `agy models` then says "Please sign in";
 *  - `agy models` renews the access token when it is within about five minutes of lapsing or past it, and says "Please sign in" when the login cannot be used.
 * The rest is AgEnD's own: folders that never share a login, a sign-in that never starts where the folder would not be isolated, a sign-out that is checked, and runs that read dates and booleans only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  credentialHomeSpec, credentialProfileArgs, credentialProfileEnv, credentialProfileHome, credentialProfileLaunch, credentialProfileLogin, credentialProfileLoginCommand, prepareCredentialProfileHome,
} from "../src/backend/credential-profile.js";
import { antigravityStoreHasLogin, antigravityTokenMeta, readAntigravityStoreMeta } from "../src/antigravity-store.js";
import { readAntigravityIdentityIn } from "../src/antigravity-identity.js";
import { signOutAccount } from "../src/accounts-signout.js";
import { createStructuredSignInTransport } from "../src/structured-signin-transport.js";
import { StructuredSignIn, type StructuredSignInTransport } from "../src/structured-signin.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { proveFolderIsolation } from "../src/account-isolation.js";
import { AGY_BACKOFF_MS, AGY_DUE_AHEAD_MS, AGY_WAKE_MS, TRANSIENT_MS, SignInKeepAlive, attentionOf, type KeepAliveDeps, type KeepAliveRunners } from "../src/signin-keepalive.js";
import { fetchAntigravityUsage, providersForConfig } from "../src/usage/providers.js";
import { checkAuthIdentity, checkAuthStatus, setAuthCheckRunnerForTests, withProfileArgs } from "../src/login-flows.js";
import { AntigravityBackend } from "../src/backend/antigravity.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-119-")); dirs.push(d); return d; };
const savedHome = process.env.GEMINI_HOME, savedAgend = process.env.AGEND_HOME;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedHome;
  if (savedAgend === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = savedAgend;
  setAuthCheckRunnerForTests(null);
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

const NOW = Date.UTC(2026, 10, 9, 6, 0, 0), MIN = 60_000;
const SECRET_AT = "ya29.SECRETACCESS", SECRET_RT = "1//SECRETREFRESH";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** agy's token file as 1.5.3 writes it (nested `token`, the id token's e-mail beside it). */
function tokenFile(folder: string, o: { expiresAt?: number; refresh?: string | null; access?: string | null; email?: string } = {}) {
  mkdirSync(folder, { recursive: true });
  const token: Record<string, unknown> = { token_type: "Bearer", expires_in: 3599 };
  if (o.access !== null) token.access_token = o.access ?? SECRET_AT;
  if (o.refresh !== null) token.refresh_token = o.refresh ?? SECRET_RT;
  if (o.expiresAt !== undefined) token.expiry = new Date(o.expiresAt).toISOString();
  writeFileSync(join(folder, "antigravity-oauth-token"), JSON.stringify({ token, auth_method: "oauth", id_token_email: o.email ?? "person@example.com" }), { mode: 0o600 });
}
/** A scratch AgEnD data dir with a default agy home (GEMINI_HOME) and an account's folder. */
function world(profiles: string[] = ["work"]) {
  const data = scratch(), gemini = join(scratch(), "gemini"), def = join(gemini, "antigravity-cli");
  mkdirSync(def, { recursive: true });
  process.env.GEMINI_HOME = gemini; process.env.AGEND_HOME = data;
  const home = (p: string) => credentialProfileHome(data, "antigravity", p);
  for (const p of profiles) mkdirSync(home(p), { recursive: true, mode: 0o700 });
  return { data, gemini, def, home };
}

describe("an account's launch: the folder as an argument, the pin as its environment", () => {
  it("agy is handed the folder relative to ~/.gemini (agy refuses an absolute path), and that path finds the account's folder again", () => {
    const data = scratch(), launch = credentialProfileLaunch(data, "antigravity", "work")!;
    expect(launch.args[0]).toBe("--app_data_dir");
    expect(isAbsolute(launch.args[1]!)).toBe(false);
    expect(resolve(homedir(), ".gemini", launch.args[1]!)).toBe(credentialProfileHome(data, "antigravity", "work"));
    expect(launch.env).toEqual({ SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" });
    expect(credentialProfileArgs(data, "antigravity", "work")).toEqual(launch.args);
    expect(credentialProfileEnv(data, "antigravity", "work")).toEqual(launch.env);
  });
  it("two accounts never share a folder, and neither is the default sign-in's", () => {
    const w = world(["a", "b"]);
    const [a, b] = ["a", "b"].map(p => credentialProfileLaunch(w.data, "antigravity", p)!.args[1]);
    expect(new Set([a, b, w.def]).size).toBe(3);
    expect(credentialProfileHome(w.data, "antigravity", "a")).not.toBe(credentialProfileHome(w.data, "antigravity", "b"));
    expect(credentialHomeSpec("antigravity")!.sharedRoot()).toBe(w.def);
  });
  it("a CLI that moves its home with a variable is launched exactly as before: its variable, no argument", () => {
    const data = scratch();
    expect(credentialProfileLaunch(data, "claude-code", "work")).toEqual({ env: { CLAUDE_CONFIG_DIR: credentialProfileHome(data, "claude-code", "work") }, args: [] });
    expect(credentialProfileLaunch(data, "grok", "work")).toBeNull();
  });
  it("the line a person runs on the host to sign the account in carries both", () => {
    const data = scratch(), line = credentialProfileLoginCommand(data, "antigravity", "work")!;
    expect(line).toMatch(/^SSH_CONNECTION="127\.0\.0\.1 0 127\.0\.0\.1 0" agy "--app_data_dir" "[^"]+" acp --login$/);
  });
  it("a probe of the account is `agy <folder argument> models` (the argument goes right after the binary)", () => {
    expect(withProfileArgs(["agy", "models"], ["--app_data_dir", "x"])).toEqual(["agy", "--app_data_dir", "x", "models"]);
    expect(withProfileArgs(["agy", "models"], undefined)).toEqual(["agy", "models"]);
    expect(withProfileArgs(["claude", "auth", "status"], [])).toEqual(["claude", "auth", "status"]);
  });
  it("the sign-in probe runs with the account's arguments and variables, and the default's with neither", async () => {
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    setAuthCheckRunnerForTests(async (argv, _t, env) => { calls.push({ argv, env }); return { code: 0, output: "models" }; });
    const w = world(), launch = credentialProfileLaunch(w.data, "antigravity", "work")!;
    expect(await checkAuthStatus({ argv: ["agy", "models"] }, launch.env, launch.args)).toBe("valid");
    expect(await checkAuthStatus({ argv: ["agy", "models"] })).toBe("valid");
    expect(calls[0]).toEqual({ argv: ["agy", ...launch.args, "models"], env: launch.env });
    expect(calls[1]).toEqual({ argv: ["agy", "models"], env: undefined });
  });
});

describe("a new account's folder", () => {
  const spec = () => credentialHomeSpec("antigravity")!;
  it("copies NOTHING from the default sign-in's folder, whatever is there (upstream #3330: first-run files are generated, see antigravity-first-run-224)", () => {
    const w = world();
    writeFileSync(join(w.def, "settings.json"), JSON.stringify({ trustedWorkspaces: ["/default-only"] }));
    mkdirSync(join(w.def, "cache"), { recursive: true });
    writeFileSync(join(w.def, "cache", "onboarding.json"), JSON.stringify({ onboardingComplete: true }));
    tokenFile(w.def);
    prepareCredentialProfileHome(spec(), w.home("work"));
    expect(readdirSync(w.home("work"))).toEqual([]);
    expect(spec().seed).toBeUndefined();
  });
  it("prepares an empty folder and nothing else (the account shows agy's own first run until an agent launch generates the first-run files)", () => {
    const w = world();
    prepareCredentialProfileHome(spec(), w.home("work"));
    expect(readdirSync(w.home("work"))).toEqual([]);
  });
  it("refuses a folder that is a link, or a token file that is one: that would be the login it exists to separate", () => {
    const w = world(), elsewhere = scratch();
    rmSync(w.home("work"), { recursive: true }); symlinkSync(elsewhere, w.home("work"));
    expect(() => prepareCredentialProfileHome(spec(), w.home("work"))).toThrow(/symlink/);
    rmSync(w.home("work")); mkdirSync(w.home("work"));
    symlinkSync(join(elsewhere, "token"), join(w.home("work"), "antigravity-oauth-token"));
    expect(() => prepareCredentialProfileHome(spec(), w.home("work"))).toThrow(/symlink/);
  });
  it("is signed in when its own folder holds a token: signed out with none, and unknown (not signed out) when the file cannot be read", () => {
    const w = world();
    expect(credentialProfileLogin(w.data, "antigravity", "work").state).toBe("signed-out");
    tokenFile(w.home("work"));
    expect(credentialProfileLogin(w.data, "antigravity", "work").state).toBe("logged-in");
    writeFileSync(join(w.home("work"), "antigravity-oauth-token"), "{not json");
    expect(credentialProfileLogin(w.data, "antigravity", "work").state).toBe("unknown");
    expect(antigravityStoreHasLogin(join(w.home("work"), "nope"))).toBe(false);
  });
  it("the default sign-in's token does not make an account signed in (each folder answers for itself)", () => {
    const w = world(["a", "b"]);
    tokenFile(w.def); tokenFile(w.home("a"));
    expect([credentialProfileLogin(w.data, "antigravity", "a").state, credentialProfileLogin(w.data, "antigravity", "b").state]).toEqual(["logged-in", "signed-out"]);
  });
});

describe("what a token file says: dates and booleans, never a token", () => {
  it("reads the expiry and whether there is a refresh token, in agy's nested shape and in a flat one", () => {
    const w = world();
    tokenFile(w.home("work"), { expiresAt: NOW + 30 * MIN });
    const m = readAntigravityStoreMeta(w.home("work"));
    expect(m).toEqual({ state: "ok", hasRefresh: true, expiresAt: NOW + 30 * MIN });
    expect(JSON.stringify(m)).not.toMatch(/SECRET|example\.com/);
    expect(antigravityTokenMeta(JSON.stringify({ access_token: "a", refresh_token: "r", expiry_date: NOW }))).toEqual({ state: "ok", hasRefresh: true, expiresAt: NOW });
    expect(antigravityTokenMeta(JSON.stringify({ token: { access_token: "a" } }))).toEqual({ state: "ok", hasRefresh: false });
    expect(antigravityTokenMeta(JSON.stringify({ token: {} }))).toEqual({ state: "missing" });
    expect(antigravityTokenMeta("[]")).toEqual({ state: "unreadable" });
  });
  it("an account's identity is its own token's e-mail (the whole address); another account's e-mail is never read for it", () => {
    const w = world(["a", "b"]);
    tokenFile(w.home("a"), { email: "alpha.person@example.com" }); tokenFile(w.home("b"), { email: "beta.person@example.com" }); tokenFile(w.def, { email: "default.person@example.com" });
    const shown = (f: string) => JSON.stringify(readAntigravityIdentityIn(f));
    expect(shown(w.home("a"))).toContain("alpha.person@example.com"); expect(shown(w.home("a"))).not.toMatch(/beta|default/);
    expect(shown(w.home("a"))).not.toBe(shown(w.home("b")));
    expect(readAntigravityIdentityIn(join(w.data, "none"))).toBeUndefined();
  });
  it("checkAuthIdentity reads the folder it is given (the account's), not the default's", async () => {
    const w = world();
    tokenFile(w.def, { email: "default.person@example.com" }); tokenFile(w.home("work"), { email: "work.person@example.com" });
    const own = await checkAuthIdentity("antigravity", {}, { folder: w.home("work") }), def = await checkAuthIdentity("antigravity", {});
    expect(JSON.stringify(own)).toContain("wo"); expect(JSON.stringify(def)).toContain("de");
    expect(JSON.stringify(own)).not.toBe(JSON.stringify(def));
  });
});

describe("Sign out: agy has no logout command, so AgEnD removes the account's token file and then asks agy", () => {
  const deps = (verify?: (backend: string, profile: string | null) => Promise<"valid" | "invalid" | "unknown">) => ({
    run: vi.fn(async () => ({ code: 0 })), keychainHas: vi.fn(async () => false), platform: "linux" as NodeJS.Platform, verify,
  });
  const req = (profile: string | null, over: Record<string, unknown> = {}) => ({ backend: "antigravity", profile, confirm: true, signingIn: false, ...over });

  it("a named account: its token file goes, nothing else in its folder or any other account's, and agy is asked afterwards for that account", async () => {
    const w = world(["a", "b"]);
    tokenFile(w.home("a")); tokenFile(w.home("b")); tokenFile(w.def);
    mkdirSync(join(w.home("a"), "conversations")); writeFileSync(join(w.home("a"), "conversations", "c.db"), "x");
    const verify = vi.fn(async () => "invalid" as const), d = deps(verify);
    expect(await signOutAccount(w.data, req("a"), d)).toEqual({ ok: true });
    expect(existsSync(join(w.home("a"), "antigravity-oauth-token"))).toBe(false);
    expect(existsSync(join(w.home("a"), "conversations", "c.db"))).toBe(true);
    expect(existsSync(join(w.home("b"), "antigravity-oauth-token")) && existsSync(join(w.def, "antigravity-oauth-token"))).toBe(true);
    expect(verify).toHaveBeenCalledWith("antigravity", "a");
    expect(d.run).not.toHaveBeenCalled();                         // no logout command exists, so none was run
  });
  it("the default sign-in: its token file in the CLI's home goes, the accounts' stay", async () => {
    const w = world(["a"]);
    tokenFile(w.def); tokenFile(w.home("a"));
    const verify = vi.fn(async () => "invalid" as const);
    expect(await signOutAccount(w.data, req(null), deps(verify))).toEqual({ ok: true });
    expect(existsSync(join(w.def, "antigravity-oauth-token"))).toBe(false);
    expect(existsSync(join(w.home("a"), "antigravity-oauth-token"))).toBe(true);
    expect(verify).toHaveBeenCalledWith("antigravity", null);
  });
  it("agy still says it is signed in (the sign-in is kept in the system's keyring): reported as that, not as signed out", async () => {
    const w = world(); tokenFile(w.home("work"));
    expect(await signOutAccount(w.data, req("work"), deps(async () => "valid"))).toEqual({ ok: false, error: "still_signed_in" });
  });
  it("agy could not answer: signed out is not claimed as proven", async () => {
    const w = world(); tokenFile(w.home("work"));
    expect(await signOutAccount(w.data, req("work"), deps(async () => "unknown"))).toEqual({ ok: true, unverified: true });
    tokenFile(w.home("work"));
    expect(await signOutAccount(w.data, req("work"), deps(async () => { throw new Error("spawn failed"); }))).toEqual({ ok: true, unverified: true });
    expect(await signOutAccount(w.data, req("work"), deps())).toEqual({ ok: true, unverified: true });      // nobody asked
  });
  it("is idempotent: an account with no token file is signed out already", async () => {
    const w = world();
    expect(await signOutAccount(w.data, req("work"), deps(async () => "invalid"))).toEqual({ ok: true });
  });
  it("refuses, removing nothing: no confirmation, a name that is not a name, a folder that is not AgEnD's own, a sign-in running", async () => {
    const w = world(); tokenFile(w.home("work")); tokenFile(w.def);
    const left = () => existsSync(join(w.home("work"), "antigravity-oauth-token")) && existsSync(join(w.def, "antigravity-oauth-token"));
    expect(await signOutAccount(w.data, req("work", { confirm: false }), deps(async () => "invalid"))).toEqual({ ok: false, error: "confirm" });
    expect(await signOutAccount(w.data, req("../escape"), deps(async () => "invalid"))).toEqual({ ok: false, error: "name" });
    expect(await signOutAccount(w.data, req("nobody"), deps(async () => "invalid"))).toMatchObject({ ok: false, error: "missing" });
    expect(await signOutAccount(w.data, req("work", { signingIn: true }), deps(async () => "invalid"))).toEqual({ ok: false, error: "signing_in" });
    expect(left()).toBe(true);
  });
  it("every check is made BEFORE the first removal: an owner that has lost the writer window (stillOwner false) leaves the token where it was", async () => {
    const w = world(); tokenFile(w.home("work"));
    const d = { ...deps(async () => "invalid"), stillOwner: () => false };
    expect(await signOutAccount(w.data, req("work"), d)).toEqual({ ok: false, error: "failed" });
    expect(existsSync(join(w.home("work"), "antigravity-oauth-token"))).toBe(true);
  });
  it("a token file that is a link is only unlinked: what it points at is never touched", async () => {
    const w = world(), target = join(scratch(), "real-token");
    writeFileSync(target, "keep");
    symlinkSync(target, join(w.home("work"), "antigravity-oauth-token"));
    expect(await signOutAccount(w.data, req("work"), deps(async () => "invalid"))).toEqual({ ok: true });
    expect(lstatSyncOrNull(join(w.home("work"), "antigravity-oauth-token"))).toBeNull();
    expect(readFileSync(target, "utf8")).toBe("keep");
  });
  it("a folder that is a link to another is refused (it would remove the other's login)", async () => {
    const w = world(["a"]); tokenFile(w.home("a"));
    rmSync(w.home("work"), { recursive: true, force: true }); symlinkSync(w.home("a"), w.home("work"));
    expect(await signOutAccount(w.data, req("work"), deps(async () => "invalid"))).toMatchObject({ ok: false });
    expect(existsSync(join(w.home("a"), "antigravity-oauth-token"))).toBe(true);
  });
});
const lstatSyncOrNull = (p: string) => { try { return lstatSync(p); } catch { return null; } };

describe("signing an account in: the folder is proved first, and the command carries the folder and the pin", () => {
  it("the login command is `agy --app_data_dir <folder> acp --login`, run with the pin — and the default's is `agy acp --login`, with neither", async () => {
    const w = world();
    const started: string[] = [];
    const native = { start: async (o: { command: string }) => { started.push(o.command); }, capture: async () => "", paneStatus: async () => ({ alive: true }), sendInput: async () => {}, kill: async () => {} };
    const env = { HOME: "/home/x", PATH: "/usr/bin" };
    const named = createStructuredSignInTransport({ native: native as never, env, backend: "antigravity", dataDir: w.data });
    await named.start({ argv: ["agy", "acp", "--login"], profile: "work" }, new AbortController().signal);
    const rel = credentialProfileArgs(w.data, "antigravity", "work")[1]!;
    expect(started[0]).toContain("SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0");
    const plainText = (command: string) => command.replace(/['\\]/g, "");                    // the shell's quoting, not the words
    expect(plainText(started[0]!)).toContain(`exec agy --app_data_dir ${rel} acp --login`);
    await named.close();
    const plain = createStructuredSignInTransport({ native: native as never, env });
    await plain.start({ argv: ["agy", "acp", "--login"] }, new AbortController().signal);
    expect(plainText(started[1]!)).toContain("exec agy acp --login");
    expect(started[1]).not.toMatch(/SSH_CONNECTION|app_data_dir/);
    await plain.close();
  });
  it("a name with no folder (Add makes it) and a CLI whose login was not checked under a folder are refused: nothing started", async () => {
    const w = world([]);
    const native = { start: vi.fn(), capture: async () => "", paneStatus: async () => ({ alive: true }), sendInput: async () => {}, kill: async () => {} };
    const t = createStructuredSignInTransport({ native: native as never, env: { HOME: "/h", PATH: "/p" }, backend: "antigravity", dataDir: w.data });
    await expect(t.start({ argv: ["agy", "acp", "--login"], profile: "ghost" }, new AbortController().signal)).rejects.toThrow("signin_profile_unknown");
    const codex = createStructuredSignInTransport({ native: native as never, env: { HOME: "/h", PATH: "/p" }, backend: "codex", dataDir: w.data });
    await expect(codex.start({ argv: ["codex", "login"], profile: "x" }, new AbortController().signal)).rejects.toThrow("signin_profile_unsupported");
    expect(native.start).not.toHaveBeenCalled();
  });

  /** A transport that records whether a command was ever started. */
  function fakeTransport(): { transport: StructuredSignInTransport; started: () => number } {
    let n = 0;
    return { started: () => n, transport: { start: async () => { n++; }, capture: async () => "", status: async () => ({ alive: false, exitCode: 1 }), write: async () => {}, close: async () => {} } };
  }
  it("a folder that is not isolated (agy answers \"signed in\" for a folder with nothing in it) ends as not_isolated, and no login command runs", async () => {
    const { transport, started } = fakeTransport(), owner = {};
    const checkAuth = vi.fn(async () => "valid" as const);
    const run = new StructuredSignIn("antigravity", owner, { transport, lock: new LoginWindowLock(), current: () => true, profile: "work", checkAuth, isolated: async () => false });
    await run.start();
    expect(run.view(owner)).toMatchObject({ phase: "failed", reason: "not_isolated" });
    expect(started()).toBe(0);
    expect(checkAuth).not.toHaveBeenCalled();
  });
  it("an isolation check that cannot be made is not isolation: it fails the same way", async () => {
    const { transport, started } = fakeTransport(), owner = {};
    const run = new StructuredSignIn("antigravity", owner, { transport, lock: new LoginWindowLock(), current: () => true, profile: "work", checkAuth: async () => "invalid", isolated: async () => { throw new Error("boom"); } });
    await run.start();
    expect(run.view(owner)).toMatchObject({ phase: "failed", reason: "not_isolated" });
    expect(started()).toBe(0);
  });
  it("the proof asks about an EMPTY SCRATCH folder under the account's launch (never the account's own), deletes it, and only \"signed out\" proves it", async () => {
    const w = world(); tokenFile(w.home("work"));
    const seen: Array<{ args: string[]; env: Record<string, string> }> = [];
    const folderOf = (args: string[]) => resolve(homedir(), ".gemini", args[1]!);
    const proof = async (answer: "valid" | "invalid" | "unknown") => proveFolderIsolation("antigravity", async launch => { seen.push(launch); expect(existsSync(folderOf(launch.args))).toBe(true); expect(readdirSync(folderOf(launch.args))).toEqual([]); return answer; });
    expect(await proof("invalid")).toBe(true);
    expect(await proof("valid")).toBe(false);
    expect(await proof("unknown")).toBe(false);                                       // asked twice, still no answer: not proven
    expect(seen.length).toBe(4);
    for (const l of seen) {
      expect(l.args[0]).toBe("--app_data_dir"); expect(l.env).toEqual({ SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" });
      expect(folderOf(l.args)).not.toBe(w.home("work")); expect(existsSync(folderOf(l.args))).toBe(false);   // not the account's, and gone
    }
    expect(await proveFolderIsolation("antigravity", async () => { throw new Error("boom"); })).toBe(false);
    expect(await proveFolderIsolation("grok", async () => "invalid")).toBe(false);     // a CLI with no such launch: nothing is proven
  });
  it("Sign in again on an account whose folder ALREADY has a token file, with the pin no longer isolating (agy answers \"signed in\" for the scratch folder): not_isolated, nothing started", async () => {
    const w = world(); tokenFile(w.home("work"));
    expect(credentialProfileLogin(w.data, "antigravity", "work").state).toBe("logged-in");
    const { transport, started } = fakeTransport(), owner = {};
    const checkAuth = vi.fn(async () => "valid" as const);
    const run = new StructuredSignIn("antigravity", owner, { transport, lock: new LoginWindowLock(), current: () => true, profile: "work", checkAuth,
      isolated: () => proveFolderIsolation("antigravity", async () => "valid") });
    await run.start(true);                                                            // the person confirmed a re-login
    expect(run.view(owner)).toMatchObject({ phase: "failed", reason: "not_isolated" });
    expect(started()).toBe(0);
  });
  it("an isolated folder goes on to the login command as always", async () => {
    const { transport, started } = fakeTransport(), owner = {};
    const run = new StructuredSignIn("antigravity", owner, { transport, lock: new LoginWindowLock(), current: () => true, profile: "work", checkAuth: async () => "invalid", isolated: async () => true });
    await run.start();
    expect(started()).toBe(1);
    await run.cancel();
  });
});

describe("Keep sign-in alive for Antigravity", () => {
  interface Fx { ka: SignInKeepAlive; w: ReturnType<typeof world>; models: ReturnType<typeof vi.fn>; released: number[]; inUse: { v: boolean } }
  function fx(profile: string | null, opts: { now?: () => number } = {}): Fx {
    const w = world(profile ? [profile] : []);
    const home = profile ? w.home(profile) : w.def;
    const models = vi.fn(async () => ({ code: 0, signedOut: false }));
    const released: number[] = [], inUse = { v: false };
    const runners = { claudeStatus: vi.fn(), claudeFallback: vi.fn(), codexRefresh: vi.fn(), antigravityModels: models };
    const deps: KeepAliveDeps = { dataDir: w.data, now: opts.now ?? (() => NOW), log: () => {}, homeOf: () => home, acquire: () => inUse.v ? "in_use" : { release: () => { released.push(1); } }, changed: () => {}, runners: runners as unknown as KeepAliveRunners };
    const ka = new SignInKeepAlive(deps);
    expect(ka.set("antigravity", profile, true)).toEqual({ ok: true });
    return { ka, w, models, released, inUse };
  }
  const record = (f: Fx) => f.ka.list()[0]!.record;

  it("a token that has more than six minutes left runs nothing (agy renews inside its own five-minute margin): still valid", async () => {
    const f = fx("work"); tokenFile(f.w.home("work"), { expiresAt: NOW + AGY_DUE_AHEAD_MS + MIN });
    await f.ka.tick({ force: false, only: { backend: "antigravity", profile: "work" } });
    expect(f.models).not.toHaveBeenCalled();
    expect(record(f)).toMatchObject({ outcome: "not_needed", expiresAt: NOW + AGY_DUE_AHEAD_MS + MIN });
  });
  it("a token about to lapse: `agy models` runs for THIS account (its folder argument and the pin), and the expiry that moved is a renewal", async () => {
    const f = fx("work"); tokenFile(f.w.home("work"), { expiresAt: NOW + 3 * MIN });
    f.models.mockImplementation(async (launch: { args: string[]; env: Record<string, string> } | null) => {
      expect(launch).toEqual({ args: credentialProfileArgs(f.w.data, "antigravity", "work"), env: { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" } });
      tokenFile(f.w.home("work"), { expiresAt: NOW + 60 * MIN });
      return { code: 0, signedOut: false };
    });
    await f.ka.tick({ only: { backend: "antigravity", profile: "work" } });
    expect(record(f)).toMatchObject({ outcome: "refreshed", expiresAt: NOW + 60 * MIN });
    expect(f.released).toEqual([1]);
  });
  it("the default sign-in runs `agy models` with no folder argument and no pin", async () => {
    const f = fx(null); tokenFile(f.w.def, { expiresAt: NOW - MIN });
    f.models.mockImplementation(async (launch: unknown) => { expect(launch).toBeNull(); tokenFile(f.w.def, { expiresAt: NOW + 60 * MIN }); return { code: 0, signedOut: false }; });
    await f.ka.tick({ only: { backend: "antigravity", profile: null } });
    expect(record(f)).toMatchObject({ outcome: "refreshed" });
  });
  it("agy says \"Please sign in\" (the refresh token was refused): the account needs signing in again", async () => {
    const f = fx("work"); tokenFile(f.w.home("work"), { expiresAt: NOW - MIN });
    f.models.mockResolvedValue({ code: 1, signedOut: true });
    await f.ka.tick({ only: { backend: "antigravity", profile: "work" } });
    expect(record(f)).toMatchObject({ outcome: "needs_sign_in", attentionSince: NOW });
  });
  it("a run that timed out or failed otherwise is transient (it counts into Needs you only on its second run in a row)", async () => {
    const f = fx("work"); tokenFile(f.w.home("work"), { expiresAt: NOW - MIN });
    f.models.mockResolvedValue({ code: null, signedOut: false });
    await f.ka.tick({ only: { backend: "antigravity", profile: "work" } });
    expect(record(f)).toMatchObject({ outcome: "transient", failCount: 1 });
    expect(record(f)!.attentionSince).toBeUndefined();
  });
  it("no token file, or one with no refresh token: signing in again; nothing is run", async () => {
    const f = fx("work");
    await f.ka.tick({ only: { backend: "antigravity", profile: "work" } });
    expect(record(f)).toMatchObject({ outcome: "needs_sign_in" });
    tokenFile(f.w.home("work"), { refresh: null, expiresAt: NOW - MIN });
    await f.ka.tick({ only: { backend: "antigravity", profile: "work" } });
    expect(record(f)).toMatchObject({ outcome: "needs_sign_in" });
    expect(f.models).not.toHaveBeenCalled();
  });
  it("a sign-in in use is left alone (its agent keeps it alive); the sign-in window held by another writer waits", async () => {
    const f = fx("work"); tokenFile(f.w.home("work"), { expiresAt: NOW - MIN });
    f.inUse.v = true;
    await f.ka.tick({ only: { backend: "antigravity", profile: "work" } });
    expect(record(f)).toMatchObject({ outcome: "in_use" });
    expect(f.models).not.toHaveBeenCalled();
  });
  it("the five-minute look reads the token file and nothing else when it is not due: no run, no hold, no record, no page update", async () => {
    let changes = 0;
    const w = world(["work"]), models = vi.fn(async () => ({ code: 0, signedOut: false })), acquire = vi.fn(() => ({ release() {} }));
    const runners = { claudeStatus: vi.fn(), claudeFallback: vi.fn(), codexRefresh: vi.fn(), antigravityModels: models };
    const ka = new SignInKeepAlive({ dataDir: w.data, now: () => NOW, log: () => {}, homeOf: () => w.home("work"), acquire, changed: () => { changes++; }, runners: runners as unknown as KeepAliveRunners });
    tokenFile(w.home("work"), { expiresAt: NOW + 40 * MIN });
    ka.set("antigravity", "work", true);
    await ka.tick({ only: { backend: "antigravity", profile: "work" } });          // the first look records once
    const before = { changes, acquired: acquire.mock.calls.length };
    await ka.tick({ backend: "antigravity" }); await ka.tick({ backend: "antigravity" });
    expect({ changes, acquired: acquire.mock.calls.length, ran: models.mock.calls.length }).toEqual({ ...before, ran: 0 });
  });
  it("the same look runs the account once its token is within six minutes of lapsing", async () => {
    const f = fx("work"); tokenFile(f.w.home("work"), { expiresAt: NOW + 40 * MIN });
    await f.ka.tick({ only: { backend: "antigravity", profile: "work" } });
    tokenFile(f.w.home("work"), { expiresAt: NOW + 5 * MIN });
    f.models.mockImplementation(async () => { tokenFile(f.w.home("work"), { expiresAt: NOW + 60 * MIN }); return { code: 0, signedOut: false }; });
    await f.ka.tick({ backend: "antigravity" });
    expect(f.models).toHaveBeenCalledTimes(1);
    expect(record(f)).toMatchObject({ outcome: "refreshed" });
  });
  it("only Antigravity's entries are looked at by its own wake; the daily CLIs keep their own pace", async () => {
    const f = fx("work");
    expect(f.ka.set("claude-code", null, true)).toEqual({ ok: true });
    tokenFile(f.w.home("work"), { expiresAt: NOW - MIN });
    f.models.mockImplementation(async () => { tokenFile(f.w.home("work"), { expiresAt: NOW + 60 * MIN }); return { code: 0, signedOut: false }; });
    await f.ka.tick({ backend: "antigravity" });
    expect(f.ka.list().find(e => e.backend === "claude-code")!.record).toBeUndefined();
    expect(f.ka.list().find(e => e.backend === "antigravity")!.record).toMatchObject({ outcome: "refreshed" });
  });
  it("failures count by TIME, not by runs: two five-minute looks that both fail do NOT make a Needs you item; 48 hours of failing do", async () => {
    let clock = NOW;
    const f = fx("work", { now: () => clock }); tokenFile(f.w.home("work"), { expiresAt: NOW - MIN });
    f.models.mockResolvedValue({ code: null, signedOut: false });
    await f.ka.tick({ only: { backend: "antigravity", profile: "work" } });
    clock += AGY_WAKE_MS; await f.ka.tick({ backend: "antigravity" });
    clock += AGY_WAKE_MS; await f.ka.tick({ backend: "antigravity" });
    expect(attentionOf(f.ka.list(), clock)).toEqual([]);
    expect(record(f)!.attentionSince).toBeUndefined();
    // …it keeps trying, but only after the back-off, and the failure's own date is the first one's
    clock = NOW + AGY_BACKOFF_MS; await f.ka.tick({ backend: "antigravity" });
    expect(record(f)).toMatchObject({ outcome: "transient", failSince: NOW });
    expect(attentionOf(f.ka.list(), clock)).toEqual([]);
    clock = NOW + TRANSIENT_MS + MIN; await f.ka.tick({ backend: "antigravity" });
    expect(attentionOf(f.ka.list(), clock).map(a => a.kind)).toEqual(["transient"]);
  });
  it("after a failed run agy is not started again for 30 minutes, however often it is looked at", async () => {
    let clock = NOW;
    const f = fx("work", { now: () => clock }); tokenFile(f.w.home("work"), { expiresAt: NOW - MIN });
    f.models.mockResolvedValue({ code: null, signedOut: false });
    await f.ka.tick({ only: { backend: "antigravity", profile: "work" } });
    for (let i = 1; i < AGY_BACKOFF_MS / AGY_WAKE_MS; i++) { clock += AGY_WAKE_MS; await f.ka.tick({ backend: "antigravity" }); }
    expect(f.models).toHaveBeenCalledTimes(1);
    clock += AGY_WAKE_MS; await f.ka.tick({ backend: "antigravity" });
    expect(f.models).toHaveBeenCalledTimes(2);
  });
  it("a look that finds the same state again does not tell the pages or Needs you again (saved, not announced)", async () => {
    let clock = NOW, changes = 0;
    const w = world(["work"]), models = vi.fn(async () => ({ code: null, signedOut: false }));
    const runners = { claudeStatus: vi.fn(), claudeFallback: vi.fn(), codexRefresh: vi.fn(), antigravityModels: models };
    const ka = new SignInKeepAlive({ dataDir: w.data, now: () => clock, log: () => {}, homeOf: () => w.home("work"), acquire: () => ({ release() {} }), changed: () => { changes++; }, runners: runners as unknown as KeepAliveRunners });
    tokenFile(w.home("work"), { expiresAt: NOW - MIN }); ka.set("antigravity", "work", true);
    const afterSet = changes;
    await ka.tick({ only: { backend: "antigravity", profile: "work" } });
    const afterFirst = changes; expect(afterFirst).toBeGreaterThan(afterSet);          // the first failure is news
    clock += AGY_BACKOFF_MS; await ka.tick({ backend: "antigravity" });
    clock += AGY_BACKOFF_MS; await ka.tick({ backend: "antigravity" });
    expect(models).toHaveBeenCalledTimes(3);
    expect(changes).toBe(afterFirst);                                                  // the same failure again: nothing new
  });
  it("\"Please sign in\" is not asked again every five minutes either (the back-off holds for it too)", async () => {
    let clock = NOW;
    const f = fx("work", { now: () => clock }); tokenFile(f.w.home("work"), { expiresAt: NOW - MIN });
    f.models.mockResolvedValue({ code: 1, signedOut: true });
    await f.ka.tick({ only: { backend: "antigravity", profile: "work" } });
    clock += AGY_WAKE_MS; await f.ka.tick({ backend: "antigravity" });
    expect(f.models).toHaveBeenCalledTimes(1);
  });
  it("the DEFAULT sign-in with no token file (kept in the system keyring) is never \"sign in again\": no Needs you item, and no switch is offered for it", async () => {
    const f = fx(null);
    expect(existsSync(join(f.w.def, "antigravity-oauth-token"))).toBe(false);
    f.ka.set("antigravity", null, false);
    expect(f.ka.view("antigravity", null)).toBeUndefined();                           // no switch for it
    f.ka.set("antigravity", null, true);                                               // one that was already on keeps its switch (so it can be turned off) …
    expect(f.ka.view("antigravity", null)).toMatchObject({ enabled: true });
    await f.ka.tick({ only: { backend: "antigravity", profile: null } });
    expect(record(f)).toMatchObject({ outcome: "keyring" });                          // … and says why nothing is renewed
    expect(attentionOf(f.ka.list(), NOW)).toEqual([]);
    expect(f.models).not.toHaveBeenCalled();
  });
  it("a NAMED account with no token file still needs signing in (its login is only ever in its file)", async () => {
    const f = fx("work");
    await f.ka.tick({ only: { backend: "antigravity", profile: "work" } });
    expect(attentionOf(f.ka.list(), NOW).map(a => a.kind)).toEqual(["needs_sign_in"]);
  });
  it("a run records dates and outcomes only: no token value reaches the saved settings or the view", async () => {
    const f = fx("work"); tokenFile(f.w.home("work"), { expiresAt: NOW - MIN });
    f.models.mockImplementation(async () => { tokenFile(f.w.home("work"), { expiresAt: NOW + 60 * MIN }); return { code: 0, signedOut: false }; });
    await f.ka.tick({ only: { backend: "antigravity", profile: "work" } });
    const saved = readFileSync(join(f.w.data, "signin-keepalive.json"), "utf8");
    expect(saved + JSON.stringify(f.ka.view("antigravity", "work"))).not.toMatch(/SECRET|example\.com/);
    expect(f.ka.view("antigravity", "work")).toMatchObject({ enabled: true, lastOutcome: "refreshed", expiresAt: new Date(NOW + 60 * MIN).toISOString() });
  });
});

describe("usage: each account reads its own token", () => {
  const quota = () => ({ ok: true, status: 200, json: async () => ({ groups: [{ displayName: "Gemini Models", buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.5, resetTime: "2026-11-09T09:00:00Z" }] }] }) });
  it("a named account's numbers are asked with ITS access token, the default's with the default's", async () => {
    const w = world();
    tokenFile(w.def, { access: "ya29.DEFAULT", expiresAt: Date.now() + 40 * MIN }); tokenFile(w.home("work"), { access: "ya29.WORK", expiresAt: Date.now() + 40 * MIN });
    const used: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { headers: Record<string, string> }) => { used.push(init.headers.Authorization!); return quota(); });
    await fetchAntigravityUsage(w.home("work"));
    expect(used.every(a => a === "Bearer ya29.WORK") && used.length > 0).toBe(true);
    used.length = 0;
    await fetchAntigravityUsage();
    expect(used.every(a => a === "Bearer ya29.DEFAULT") && used.length > 0).toBe(true);
  });
  it("an account with no token file says to log in, and no request is made for it", async () => {
    const w = world(); const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    expect(await fetchAntigravityUsage(w.home("work"))).toMatchObject({ status: "no-credentials", metrics: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("an account whose token has lapsed says so (and the default's cached token is never used for it)", async () => {
    const w = world();
    tokenFile(w.def, { access: "ya29.DEFAULT", expiresAt: Date.now() + 40 * MIN }); tokenFile(w.home("work"), { access: "ya29.WORK", expiresAt: Date.now() - 5 * MIN, refresh: null });
    vi.stubGlobal("fetch", async () => quota());
    await fetchAntigravityUsage();                                                // the default's token is now cached
    const r = await fetchAntigravityUsage(w.home("work"));
    expect(r).toMatchObject({ status: "error", errorI18n: { key: "usage.error.agy_token_expired" } });
  });
  it("the usage rows are the default's and one for each account on the host, used by an agent or not", () => {
    const w = world(["a", "b"]);
    const rows = providersForConfig({ instances: {} } as never, [{ id: "antigravity", name: "Antigravity", fetch: async () => ({ status: "ok", metrics: [] }) }]);
    expect(rows.map(r => [r.id, r.name, r.profile ?? null, r.defaultLogin ?? false])).toEqual([
      ["antigravity", "Antigravity (default)", null, true], ["antigravity:a", "Antigravity (a)", "a", false], ["antigravity:b", "Antigravity (b)", "b", false],
    ]);
    void w;
  });
  it("with no account on the host the row is the one it always was", () => {
    world([]);
    const rows = providersForConfig({ instances: {} } as never, [{ id: "antigravity", name: "Antigravity", fetch: async () => ({ status: "ok", metrics: [] }) }]);
    expect(rows.map(r => [r.id, r.name])).toEqual([["antigravity", "Antigravity"]]);
  });
  it("each row reads its own folder", async () => {
    const w = world(["a"]);
    const seen: Array<string | undefined> = [];
    const rows = providersForConfig({ instances: {} } as never, [{ id: "antigravity", name: "Antigravity", fetch: async (home?: string) => { seen.push(home); return { status: "ok", metrics: [] }; } }]);
    for (const r of rows) await r.fetch();
    expect(seen).toEqual([undefined, w.home("a")]);
  });
});

describe("an agent on a named account", () => {
  function launch(options: Record<string, unknown> | undefined, w = world()) {
    const dir = join(w.data, "instances", "worker"); mkdirSync(dir, { recursive: true });
    const be = new AntigravityBackend(dir, scratch(), w.data);
    (be as unknown as { binaryPath: string }).binaryPath = "/usr/bin/agy";
    return { cmd: be.buildCommand({ workingDirectory: dir, instanceDir: dir, instanceName: "worker", mcpServers: {}, ...(options ? { backendOptions: options } : {}) } as never), w, be };
  }
  it("without an account the command is exactly what it was: no variable, no folder argument, nothing made", () => {
    const { cmd, w } = launch(undefined, world([]));
    expect(cmd).toBe("/usr/bin/agy --dangerously-skip-permissions --continue");
    expect(existsSync(join(w.data, "credential-profiles"))).toBe(false);
  });
  it("on an account: the pin before the command, the folder right after the binary, and the folder is made as a sign-in makes it", () => {
    const { cmd, w } = launch({ credential_profile: "work" }, world([]));
    const rel = credentialProfileArgs(w.data, "antigravity", "work")[1]!;
    expect(cmd).toBe(`SSH_CONNECTION='127.0.0.1 0 127.0.0.1 0' /usr/bin/agy '--app_data_dir' '${rel}' --dangerously-skip-permissions --continue`);
    expect(lstatSync(w.home("work")).isDirectory()).toBe(true);
  });
  it("the account's own settings (the status line) are written in ITS folder, never in the default's", () => {
    const w = world(["work"]);
    const dir = join(w.data, "instances", "worker"); mkdirSync(dir, { recursive: true });
    const be = new AntigravityBackend(dir, scratch(), w.data);
    be.writeConfig({ workingDirectory: dir, instanceDir: dir, instanceName: "worker", mcpServers: {}, backendOptions: { credential_profile: "work" } } as never);
    expect(JSON.parse(readFileSync(join(w.home("work"), "settings.json"), "utf8")).statusLine).toMatchObject({ enabled: true });
    expect(existsSync(join(w.def, "settings.json"))).toBe(false);
  });
  it("the settings are never written through a folder that is a link (it would be another account's): refused before anything is written", () => {
    const w = world(["work"]), other = scratch();
    rmSync(w.home("work"), { recursive: true }); symlinkSync(other, w.home("work"));
    const dir = join(w.data, "instances", "worker"); mkdirSync(dir, { recursive: true });
    const be = new AntigravityBackend(dir, scratch(), w.data);
    expect(() => be.writeConfig({ workingDirectory: dir, instanceDir: dir, instanceName: "worker", mcpServers: {}, backendOptions: { credential_profile: "work" } } as never)).toThrow(/symlink/);
    expect(readdirSync(other)).toEqual([]);
  });
  it("a name that is not a name is refused where the launch is built", () => {
    expect(() => launch({ credential_profile: "../escape" })).toThrow(/credential_profile/);
  });
});

describe("the Accounts view names an account that has no agent yet", () => {
  it("a named Antigravity account that is signed in on disk and used by NO agent shows its e-mail, as the default's does (the identity read covers the accounts on disk, not only the ones an agent uses)", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const w = world(["second", "spare"]);
    tokenFile(w.home("second"), { email: "julia@gmail.com", expiresAt: Date.now() + 40 * MIN });        // signed in, no agent
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: "" }));                                     // no CLI is run for anything else
    const work = join(w.data, "w"); mkdirSync(work, { recursive: true });
    const path = join(w.data, "fleet.yaml");
    writeFileSync(path, `defaults:\n  backend: claude-code\ninstances:\n  dev:\n    working_directory: ${work}\n`);
    const fm = new FleetManager(w.data); fm.loadConfig(path);
    const rowOf = async () => (await fm.accountsView(1)).clis.find(c => c.backend === "antigravity")!.rows.find(r => r.profile === "second")!;
    await rowOf();                                                                  // the first look starts the read (it never waits)…
    await new Promise(r => setTimeout(r, 150));
    const row = await rowOf();                                                      // …and the next one has it
    expect(row.state).toBe("usable");
    expect(row.usedBy.agents).toEqual([]);
    expect(row.identity).toEqual({ maskedEmail: "julia@gmail.com" });
    const signedOut = (await fm.accountsView(1)).clis.find(c => c.backend === "antigravity")!.rows.find(r => r.profile === "spare")!;
    expect([signedOut.state, signedOut.identity]).toEqual(["not_signed_in", undefined]);
    expect(JSON.stringify(row)).not.toMatch(/SECRET/);
  });
});
