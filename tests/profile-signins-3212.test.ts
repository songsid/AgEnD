/**
 * #3212: a NAMED account's sign-in on this host uses #2599's structured controls (Sign in → provider's page → paste the code), not the web-terminal flow.
 *  - the transport: which folder and variable a profile launch gets, and the closed name check;
 *  - `ProfileSignIns`: one sign-in per host under the host's login window, the account's own state, owner-only views, cancel/close that leave nothing running;
 *  - the HTTP route (`?backend=&profile=`): the closed shapes;
 *  - FleetManager: events, recovery of the agents on THAT account, `/login cancel`, Remove/Sign out refusals, shutdown.
 * Fixtures only; every CLI/native effect is a stub.
 */
import { createServer, request, type Server } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileSignIns, type ProfileSignInDeps } from "../src/profile-signins.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { createStructuredSignInTransport, structuredSignInProfileEnvironment } from "../src/structured-signin-transport.js";
import { CHAT_PROFILE_LOGIN_BACKENDS } from "../src/backend/credential-profile.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { FleetManager } from "../src/fleet-manager.js";
import { readPendingBackendSignIns, writePendingBackendSignIns } from "../src/backend-signin-pending.js";
import type { TerminalBackend } from "../src/web-terminal.js";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "agend-profile-signin-")); dirs.push(dir); return dir; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
const profileHome = (dataDir: string, name: string) => resolve(dataDir, "credential-profiles", "claude-code", name);
/** What Settings → Accounts → + Add account does (accounts-profiles.ts addAccountProfile): the account's own private folder. A sign-in never makes one. */
const addAccount = (dataDir: string, name: string) => { mkdirSync(profileHome(dataDir, name), { recursive: true, mode: 0o700 }); return profileHome(dataDir, name); };

const URL_OK = "https://claude.com/cai/oauth/authorize?state=test";
const CLAUDE_CODE_PANE = `Browser didn't open? Use the url below to sign in\n${URL_OK}\nPaste code here if prompted >\n`;
const CODE = "AbCd-1234_xyz";

describe("the transport: which folder and variable a named account's sign-in gets", () => {
  it("the profile's own folder: CLAUDE_CONFIG_DIR=<data dir>/credential-profiles/claude-code/<name> (the folder Add made, kept private); nothing else is added", () => {
    const dir = temp(); addAccount(dir, "CHY");
    expect(structuredSignInProfileEnvironment(dir, "claude-code", "CHY")).toEqual({ CLAUDE_CONFIG_DIR: profileHome(dir, "CHY") });
    expect(statSync(profileHome(dir, "CHY")).mode & 0o777).toBe(0o700);
    // Idempotent: a second sign-in of the same account finds its folder and keeps what is in it.
    expect(structuredSignInProfileEnvironment(dir, "claude-code", "CHY")).toEqual({ CLAUDE_CONFIG_DIR: profileHome(dir, "CHY") });
  });
  it.each(["", " CHY", "CHY ", "../x", "a/b", "a\\b", "-x", ".x", "a b", "x".repeat(65), "a\0b", "$(id)", "C:\\x", "a;b", "a\nb"])(
    "refuses %j as a name, and makes no folder", (bad) => {
      const dir = temp();
      expect(() => structuredSignInProfileEnvironment(dir, "claude-code", bad)).toThrow("signin_profile_invalid");
      expect(existsSync(join(dir, "credential-profiles"))).toBe(false);
    });
  it("refuses a name that is not a string", () => {
    const dir = temp();
    for (const bad of [5, null, undefined, {}, ["CHY"]]) expect(() => structuredSignInProfileEnvironment(dir, "claude-code", bad as never)).toThrow("signin_profile_invalid");
  });
  it("what chat's `/login <backend> <profile>` can sign in does not decide what these controls launch (#3307 adds codex and kiro-cli to that set)", () => {
    const widened = CHAT_PROFILE_LOGIN_BACKENDS as Set<string>, before = [...widened];
    try {
      widened.add("codex"); widened.add("kiro-cli");
      const dir = temp();
      for (const backend of ["codex", "kiro-cli"]) expect(() => structuredSignInProfileEnvironment(dir, backend, "CHY"), backend).toThrow("signin_profile_unsupported");
      expect(existsSync(join(dir, "credential-profiles"))).toBe(false);
      expect(() => new ProfileSignIns({ lock: new LoginWindowLock(), current: () => true, installed: async () => true, known: () => true, checkAuth: async () => "invalid", transport: () => { throw new Error("no"); } })
        .snapshot({}, { backend: "codex", profile: "CHY" })).toThrow("invalid_signin_target");
    } finally { widened.clear(); for (const b of before) widened.add(b); }
  });
  it.each(["kiro-cli", "codex", "antigravity", "nope", ""])("%j: a backend whose login screen was not checked under a relocated home is refused, and makes no folder", (backend) => {
    const dir = temp();
    expect(() => structuredSignInProfileEnvironment(dir, backend, "CHY")).toThrow("signin_profile_unsupported");
    expect(existsSync(join(dir, "credential-profiles"))).toBe(false);
  });
  it("a profile folder that is a link to somewhere else is not an account: the login would be written to the shared one", () => {
    const dir = temp(), shared = temp();
    mkdirSync(join(dir, "credential-profiles", "claude-code"), { recursive: true });
    symlinkSync(shared, profileHome(dir, "CHY"));
    expect(() => structuredSignInProfileEnvironment(dir, "claude-code", "CHY")).toThrow("signin_profile_unknown");
    expect(lstatSync(profileHome(dir, "CHY")).isSymbolicLink()).toBe(true);
  });
  it("a sign-in never makes an account (#3418 review): a name with no folder, or one spelled differently from the folder, is refused and nothing is created — Add stays the only way", () => {
    const dir = temp();
    expect(() => structuredSignInProfileEnvironment(dir, "claude-code", "CHY")).toThrow("signin_profile_unknown");
    expect(existsSync(join(dir, "credential-profiles"))).toBe(false);
    addAccount(dir, "CHY");
    for (const other of ["chy", "Chy", "cHY"]) {
      expect(() => structuredSignInProfileEnvironment(dir, "claude-code", other), other).toThrow("signin_profile_unknown");
      expect(readdirSync(join(dir, "credential-profiles", "claude-code"))).toEqual(["CHY"]);   // no second folder, on a case-sensitive disk
    }
    expect(structuredSignInProfileEnvironment(dir, "claude-code", "CHY")).toEqual({ CLAUDE_CONFIG_DIR: profileHome(dir, "CHY") });
  });

  function nativeRig(options: { backend?: string; dataDir?: string } = {}) {
    const native: TerminalBackend = { start: vi.fn(async () => {}), sendInput: vi.fn(async () => {}), resize: vi.fn(async () => {}), capture: vi.fn(async () => "pane"),
      paneStatus: vi.fn(async () => ({ alive: true })), kill: vi.fn(async () => {}) };
    const env = { HOME: temp(), PATH: "/stub/bin", CLAUDE_CONFIG_DIR: "/host/default-claude-home", ANTHROPIC_API_KEY: "synthetic-no-credential" };
    return { native, env, transport: createStructuredSignInTransport({ native, env, ...options }) };
  }
  const launched = (h: ReturnType<typeof nativeRig>) => vi.mocked(h.native.start).mock.calls[0]![0].command;
  it("a profile launch carries the PROFILE's variable and not the host's own; a launch with no profile still carries the host's (the default account is unchanged)", async () => {
    const dir = temp(); addAccount(dir, "CHY");
    const named = nativeRig({ backend: "claude-code", dataDir: dir });
    await named.transport.start({ argv: ["claude", "auth", "login"], profile: "CHY" }, new AbortController().signal);
    expect(launched(named)).toContain(`'CLAUDE_CONFIG_DIR=${profileHome(dir, "CHY")}'`);
    expect(launched(named)).not.toContain("/host/default-claude-home");
    expect(launched(named)).not.toContain("synthetic-no-credential");
    expect(launched(named).match(/CLAUDE_CONFIG_DIR=/g)).toHaveLength(1);
    expect(launched(named)).toMatch(/sh -c .*exec .*claude.*auth.*login/);   // the fixed login command, unchanged by the profile
    await named.transport.close();
    const plain = nativeRig({ backend: "claude-code", dataDir: dir });
    await plain.transport.start({ argv: ["claude", "auth", "login"] }, new AbortController().signal);
    expect(launched(plain)).toContain("'CLAUDE_CONFIG_DIR=/host/default-claude-home'");
    expect(launched(plain)).not.toContain(profileHome(dir, "CHY"));
    await plain.transport.close();
  });
  it("a transport that was not told its backend and data directory refuses a profile — it never signs the DEFAULT account in instead", async () => {
    const h = nativeRig();
    await expect(h.transport.start({ argv: ["claude", "auth", "login"], profile: "CHY" }, new AbortController().signal)).rejects.toThrow("signin_profile_unsupported");
    expect(h.native.start).not.toHaveBeenCalled();
  });
  it("a bad name, an unsupported backend or an unsafe folder never reaches the CLI", async () => {
    const dir = temp();
    for (const [backend, profile, why] of [["claude-code", "../x", "signin_profile_invalid"], ["codex", "CHY", "signin_profile_unsupported"], ["kiro-cli", "CHY", "signin_profile_unsupported"]] as const) {
      const h = nativeRig({ backend, dataDir: dir });
      await expect(h.transport.start({ argv: [backend], profile }, new AbortController().signal)).rejects.toThrow(why);
      expect(h.native.start).not.toHaveBeenCalled();
      await h.transport.close();
    }
  });
});

function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
function rig(extra: Partial<ProfileSignInDeps> = {}) {
  vi.useFakeTimers();
  const owner = {}, other = {};
  const lock = new LoginWindowLock();
  const state = { current: true, pane: CLAUDE_CODE_PANE, auth: "invalid" as "valid" | "invalid" | "unknown", installed: true, alive: true };
  const transport = { start: vi.fn(async (..._a: unknown[]) => {}), capture: vi.fn(async () => state.pane), status: vi.fn(async () => ({ alive: state.alive })), write: vi.fn(async (..._a: unknown[]) => {}), close: vi.fn(async () => {}) };
  const checkAuth = vi.fn(async (_backend: string, _profile: string) => state.auth);
  const installed = vi.fn(async () => state.installed);
  const transportFor = vi.fn((_target: unknown) => transport);
  const events: unknown[] = [];
  const c = new ProfileSignIns({ lock, current: who => who === owner && state.current, installed, known: () => true, checkAuth, transport: transportFor, changed: (e, _o, launched) => events.push({ ...e, launched }), ...extra });
  return { c, owner, other, lock, state, transport, checkAuth, installed, transportFor, events, target: (profile = "CHY") => ({ backend: "claude-code", profile }) };
}
const login = (h: ReturnType<typeof rig>) => h.c.snapshot(h.owner, h.target()).login!;

describe("ProfileSignIns", () => {
  it("reads the account's own state (its profile, never the default's), once until asked again; not the default account's checklist", async () => {
    const h = rig();
    const first = await h.c.refresh(h.owner, h.target());
    expect(first).toEqual({ selected: ["claude-code"], pending: ["claude-code"], skipped: [], states: { "claude-code": "invalid" }, login: null, ready: false, target: { backend: "claude-code", profile: "CHY" } });
    await h.c.refresh(h.owner, h.target());
    expect(h.checkAuth).toHaveBeenCalledTimes(1); expect(h.checkAuth).toHaveBeenCalledWith("claude-code", "CHY");
    h.state.auth = "valid";
    const signedIn = await h.c.refresh(h.owner, h.target(), true);
    expect(signedIn.pending).toEqual([]); expect(signedIn.ready, "signed in and nothing running: the cards may say so").toBe(true);
    expect(h.checkAuth).toHaveBeenCalledTimes(2);
    // Another account is read separately.
    await h.c.refresh(h.owner, h.target("home")); expect(h.checkAuth).toHaveBeenLastCalledWith("claude-code", "home");
    expect(h.transport.start).not.toHaveBeenCalled();
  });
  it("not installed: said, and nothing starts", async () => {
    const h = rig(); h.state.installed = false;
    expect((await h.c.refresh(h.owner, h.target())).states["claude-code"]).toBe("not_installed");
    const snapshot = await h.c.begin(h.owner, h.target());
    expect(snapshot.states["claude-code"]).toBe("not_installed"); expect(h.transport.start).not.toHaveBeenCalled(); expect(h.lock.isHeld).toBe(false);
  });
  it("Sign in: the CLI is started FOR THAT PROFILE; the link and a code box come back; the code goes in raw; success is read from the account's own status; the lock is freed and the child reaped", async () => {
    const h = rig();
    await h.c.begin(h.owner, h.target());
    expect(h.transportFor).toHaveBeenCalledWith({ backend: "claude-code", profile: "CHY" });
    expect(h.transport.start).toHaveBeenCalledTimes(1);
    expect(h.transport.start.mock.calls[0]![0]).toEqual({ argv: ["claude", "auth", "login"], profile: "CHY" });
    expect(h.lock.current).toMatchObject({ kind: "web", backend: "claude-code" });
    expect(login(h)).toMatchObject({ backend: "claude-code", phase: "code", mine: true, canAct: true, url: URL_OK });
    const v = login(h);
    await h.c.input(h.owner, h.target(), v.id, v.revision, { kind: "code", value: CODE });
    expect(h.transport.write).toHaveBeenCalledTimes(1);
    expect(h.transport.write.mock.calls[0]![0]).toBe(`${CODE}\r`);   // raw: no Ctrl+U in front of a pasted authorization code
    h.state.auth = "valid"; h.state.alive = false; h.state.pane = "Login successful. Logged in as ad***@example.com";
    await vi.advanceTimersByTimeAsync(600);
    const done = h.c.snapshot(h.owner, h.target());
    expect(done).toMatchObject({ pending: [], states: { "claude-code": "valid" }, ready: true });
    expect(done.login).toMatchObject({ phase: "done" });
    expect(h.checkAuth).toHaveBeenLastCalledWith("claude-code", "CHY");
    expect(h.transport.close).toHaveBeenCalledTimes(1); expect(h.lock.isHeld).toBe(false);
    expect(h.events.at(-1)).toEqual({ backend: "claude-code", profile: "CHY", phase: "done", launched: true });
    // Safe fields only: a backend, the profile NAME, a phase — never the link, the code or an address.
    expect(JSON.stringify(h.events)).not.toMatch(/oauth|claude\.com|AbCd|example\.com/);
  });
  it("a code the provider refuses ends the attempt as provider_rejected, with no retry of our own, and the account can be tried again", async () => {
    const h = rig();
    await h.c.begin(h.owner, h.target());
    const v = login(h); await h.c.input(h.owner, h.target(), v.id, v.revision, { kind: "code", value: CODE });
    h.state.pane = "Paste code here if prompted > Login failed: That code wasn't accepted\nPane is dead (status 1)";
    await vi.advanceTimersByTimeAsync(600);
    expect(login(h)).toMatchObject({ phase: "failed", reason: "provider_rejected" });
    expect(h.transport.close).toHaveBeenCalledTimes(1); expect(h.lock.isHeld).toBe(false);
    expect(h.c.signingIn("claude-code", "CHY")).toBe(false);
    h.state.pane = CLAUDE_CODE_PANE; h.state.alive = true;
    await h.c.begin(h.owner, h.target()); expect(h.transport.start).toHaveBeenCalledTimes(2);
  });
  it("relogin on a signed-in account is the user's explicit choice: without it a valid account is left alone", async () => {
    const h = rig(); h.state.auth = "valid";
    await h.c.begin(h.owner, h.target());
    expect(h.transport.start).not.toHaveBeenCalled(); expect(login(h)).toMatchObject({ phase: "done" });
    await h.c.begin(h.owner, h.target(), true);
    expect(h.transport.start).toHaveBeenCalledTimes(1); expect(h.transport.start.mock.calls[0]![0]).toEqual({ argv: ["claude", "auth", "login"], profile: "CHY" });
  });
  it("the same account joins (a refresh or a double click, any case), another account is refused as busy", async () => {
    const h = rig();
    const a = await h.c.begin(h.owner, h.target()), b = await h.c.begin(h.owner, h.target("chy"));
    expect(b.login!.id).toBe(a.login!.id); expect(h.transport.start).toHaveBeenCalledTimes(1);
    await expect(h.c.begin(h.owner, h.target("home"))).rejects.toThrow("signin_busy");
    expect(h.c.signingIn("claude-code", "CHY")).toBe(true); expect(h.c.signingIn("claude-code", "chy")).toBe(true); expect(h.c.signingIn("claude-code", "home")).toBe(false);
    expect(h.c.signingIn("codex", "CHY")).toBe(false);
    expect(h.c.active).toEqual({ backend: "claude-code", profile: "CHY" });
    // The snapshot of another account shows no login of this one.
    expect(h.c.snapshot(h.owner, h.target("home")).login).toBeNull();
  });
  it("the host's login window is shared: a sign-in anywhere else on the host (the default account, chat, an install) makes this one busy and starts nothing", async () => {
    const h = rig(); const claim = h.lock.tryClaim("install", "codex");
    const snapshot = await h.c.begin(h.owner, h.target());
    expect(snapshot.login).toMatchObject({ phase: "failed", reason: "busy" }); expect(h.transport.start).not.toHaveBeenCalled();
    h.lock.release(claim);
    // …and the other way round: while this one runs nobody else gets the window.
    await h.c.begin(h.owner, h.target()); expect(h.lock.tryClaim("web", "claude-code")).toBeNull();
  });
  it("Cancel ends exactly that sign-in: the child is reaped, the window is free, no `auth login` is left; a new one can start", async () => {
    const h = rig(); await h.c.begin(h.owner, h.target());
    const snapshot = await h.c.cancel(h.owner, h.target());
    expect(snapshot.login).toMatchObject({ phase: "failed", reason: "cancelled" });
    expect(h.transport.close).toHaveBeenCalledTimes(1); expect(h.lock.isHeld).toBe(false); expect(h.c.signingIn("claude-code", "CHY")).toBe(false); expect(h.c.active).toBeNull();
    // A cancel for an account that is not running changes nothing.
    await h.c.begin(h.owner, h.target()); expect(h.transport.start).toHaveBeenCalledTimes(2);
    await h.c.cancel(h.owner, h.target("home")); expect(h.c.signingIn("claude-code", "CHY")).toBe(true);
    await h.c.cancel(h.owner, h.target()); expect(h.transport.close).toHaveBeenCalledTimes(2);
    // Cancelling again is harmless: the child is reaped once.
    await h.c.cancel(h.owner, h.target()); expect(h.transport.close).toHaveBeenCalledTimes(2);
  });
  it("cancelActive ends whatever runs, whoever asked (Remove's \"Cancel sign-in and remove\", /login cancel); null when nothing runs", async () => {
    const h = rig();
    expect(await h.c.cancelActive()).toBeNull();
    await h.c.begin(h.owner, h.target());
    expect(await h.c.cancelActive()).toEqual({ target: { backend: "claude-code", profile: "CHY" }, confirmed: true });
    expect(h.transport.close).toHaveBeenCalledTimes(1); expect(h.lock.isHeld).toBe(false);
    expect(await h.c.cancelActive()).toBeNull();
  });
  it("cancelAccount (Remove's \"Cancel sign-in and remove\", #3321 review) ends the sign-in of exactly that account — the profile compared case-insensitively — and no other; false when there was none", async () => {
    const h = rig();
    expect(await h.c.cancelAccount("claude-code", "CHY")).toBe(false);
    await h.c.begin(h.owner, h.target());
    expect(await h.c.cancelAccount("claude-code", "home")).toBe(false);   // another account's
    expect(await h.c.cancelAccount("codex", "CHY")).toBe(false);          // another backend's
    expect(h.c.signingIn("claude-code", "CHY")).toBe(true); expect(h.transport.close).not.toHaveBeenCalled();
    expect(await h.c.cancelAccount("claude-code", "chy")).toBe(true);
    expect(h.transport.close).toHaveBeenCalledTimes(1); expect(h.lock.isHeld).toBe(false); expect(h.c.signingIn("claude-code", "CHY")).toBe(false);
    expect(await h.c.cancelAccount("claude-code", "CHY")).toBe(false);    // already over: nothing to end, the child is not reaped twice
    expect(h.transport.close).toHaveBeenCalledTimes(1);
  });
  it("cancel ends only this session's own run, and — with the run's id — only that exact run (#3418 review): another session's close, or a stale id, leaves it running", async () => {
    let h!: ReturnType<typeof rig>;
    h = rig({ current: who => who === h.owner || who === h.other });   // two admin sessions are both current
    const run = await h.c.begin(h.owner, h.target()); const id = run.login!.id;
    // The other session's dialog closing: not its run.
    await h.c.cancel(h.other, h.target()); await h.c.cancel(h.other, h.target(), id);
    expect(h.c.signingIn("claude-code", "CHY")).toBe(true); expect(h.transport.close).not.toHaveBeenCalled();
    // A stale or foreign id from the right session: not that run.
    await h.c.cancel(h.owner, h.target(), "f".repeat(32));
    expect(h.c.signingIn("claude-code", "CHY")).toBe(true); expect(h.transport.close).not.toHaveBeenCalled();
    // The run's own id ends it; a second one sent late finds nothing to end.
    await h.c.cancel(h.owner, h.target(), id);
    expect(h.c.signingIn("claude-code", "CHY")).toBe(false); expect(h.transport.close).toHaveBeenCalledTimes(1); expect(h.lock.isHeld).toBe(false);
    await h.c.cancel(h.owner, h.target(), id); expect(h.transport.close).toHaveBeenCalledTimes(1);
    // Without an id the session's own cancel (the card's Cancel sign-in) still ends its run.
    await h.c.begin(h.owner, h.target()); await h.c.cancel(h.owner, h.target());
    expect(h.c.signingIn("claude-code", "CHY")).toBe(false); expect(h.transport.close).toHaveBeenCalledTimes(2);
  });
  it("a run that is not an account (no folder with exactly this name) is refused before the window is claimed, the probe runs or a child starts; a read is refused the same (#3418 review)", async () => {
    const h = rig({ known: (_backend, profile) => profile === "CHY" });
    for (const profile of ["chy", "Chy", "NEW"]) {
      await expect(h.c.begin(h.owner, h.target(profile))).rejects.toThrow("signin_profile_unknown");
      await expect(h.c.refresh(h.owner, h.target(profile))).rejects.toThrow("signin_profile_unknown");
    }
    expect(h.lock.isHeld).toBe(false); expect(h.checkAuth).not.toHaveBeenCalled(); expect(h.transport.start).not.toHaveBeenCalled(); expect(h.installed).not.toHaveBeenCalled();
    await h.c.begin(h.owner, h.target("CHY")); expect(h.transport.start).toHaveBeenCalledTimes(1);
  });
  it("a child that cannot be shown gone keeps the window reserved and blocks the next attempt (the account still counts as signing in)", async () => {
    const h = rig(); await h.c.begin(h.owner, h.target());
    h.transport.close.mockRejectedValue(new Error("private vendor text"));
    await expect(h.c.cancel(h.owner, h.target())).rejects.toThrow("signin_cleanup_failed");
    expect(h.lock.isHeld).toBe(true); expect(h.c.signingIn("claude-code", "CHY")).toBe(true);
    await expect(h.c.begin(h.owner, h.target("home"))).rejects.toThrow("signin_cleanup_failed");
    expect((await h.c.cancelActive())?.confirmed).toBe(false);
    expect(await h.c.close()).toBe(false); expect(h.transport.start).toHaveBeenCalledTimes(1);
  });
  it("only the admin session that started it sees the link, answers or cancels it; once that session is gone nothing is accepted", async () => {
    const h = rig(); await h.c.begin(h.owner, h.target());
    const v = login(h);
    expect(() => h.c.snapshot(h.other, h.target())).toThrow("signin_session_expired");
    await expect(h.c.input(h.other, h.target(), v.id, v.revision, { kind: "code", value: CODE })).rejects.toThrow("signin_session_expired");
    await expect(h.c.cancel(h.other, h.target())).rejects.toThrow("signin_session_expired");
    await expect(h.c.begin(h.other, h.target("home"))).rejects.toThrow("signin_session_expired");
    await expect(h.c.refresh(h.other, h.target())).rejects.toThrow("signin_session_expired");
    expect(h.transport.write).not.toHaveBeenCalled();
    h.state.current = false;
    expect(() => h.c.snapshot(h.owner, h.target())).toThrow("signin_session_expired");
  });
  it("an answer for another account, a stale revision or a second answer is not sent", async () => {
    const h = rig(); await h.c.begin(h.owner, h.target());
    const v = login(h);
    await expect(h.c.input(h.owner, h.target("home"), v.id, v.revision, { kind: "code", value: CODE })).rejects.toThrow("signin_session_expired");
    await expect(h.c.input(h.owner, h.target(), v.id, v.revision + 7, { kind: "code", value: CODE })).rejects.toThrow("signin_action_stale");
    await h.c.input(h.owner, h.target(), v.id, v.revision, { kind: "code", value: CODE });
    await expect(h.c.input(h.owner, h.target(), v.id, v.revision, { kind: "code", value: CODE })).rejects.toThrow(/signin_action_stale/);
    expect(h.transport.write).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ backend: "kiro-cli", profile: "CHY" }], [{ backend: "codex", profile: "CHY" }], [{ backend: "claude-code", profile: "../x" }], [{ backend: "claude-code", profile: "" }],
    [{ backend: "claude-code", profile: " x" }], [{ backend: "claude-code", profile: "a b" }], [{ backend: "nope", profile: "CHY" }], [{ backend: "claude-code" }], [null],
  ])("a target that is not a named Claude account is refused before anything happens: %j", async (target) => {
    const h = rig();
    await expect(h.c.begin(h.owner, target as never)).rejects.toThrow("invalid_signin_target");
    await expect(h.c.refresh(h.owner, target as never)).rejects.toThrow("invalid_signin_target");
    expect(() => h.c.snapshot(h.owner, target as never)).toThrow("invalid_signin_target");
    await expect(h.c.cancel(h.owner, target as never)).rejects.toThrow("invalid_signin_target");
    expect(h.installed).not.toHaveBeenCalled(); expect(h.transport.start).not.toHaveBeenCalled(); expect(h.lock.isHeld).toBe(false);
  });
  it("a session revoked while the install probe is out starts no CLI and frees the window", async () => {
    const probe = deferred<boolean>(); const h = rig({ installed: () => probe.promise });
    const begin = h.c.begin(h.owner, h.target()); h.state.current = false; probe.resolve(true);
    await expect(begin).rejects.toThrow("signin_session_expired"); expect(h.transport.start).not.toHaveBeenCalled(); expect(h.lock.isHeld).toBe(false);
  });
  it("a probe that throws is 'not known', never a dead end", async () => {
    const h = rig(); h.checkAuth.mockRejectedValue(new Error("boom"));
    expect((await h.c.refresh(h.owner, h.target())).states["claude-code"]).toBe("unknown");
  });
  it("close() ends a running sign-in and says whether the child is gone; afterwards nothing is accepted", async () => {
    const h = rig(); await h.c.begin(h.owner, h.target());
    expect(await h.c.close()).toBe(true); expect(h.transport.close).toHaveBeenCalledTimes(1); expect(h.lock.isHeld).toBe(false);
    expect(() => h.c.snapshot(h.owner, h.target())).toThrow("signin_session_expired");
  });
});

describe("the route: ?backend=claude-code&profile=<name>", () => {
  const rigs: { server: Server; service: ProfileSignIns }[] = [];
  afterEach(async () => { for (const r of rigs.splice(0)) { await r.service.close(); r.server.closeAllConnections(); await new Promise<void>(res => r.server.close(() => res())); } });
  async function http(extra: Partial<ProfileSignInDeps> = {}) {
    const token = "scratch-fleet-token", sessions = new WebSessionStore({});
    const h = rig({ current: owner => { const r = owner as { handle: string }; return sessions.findByHandle(r.handle) === owner && (owner as any).tier === "admin" && (owner as any).surface === "local" && sessions.isCurrent(owner as any, tokenEpoch(token)); }, ...extra });
    const service = h.c;
    const defaultService = { refresh: vi.fn(async () => ({})) };
    const context = { webToken: token, webSessions: sessions, profileSignIns: service, browserBackendSignIns: defaultService } as unknown as WebApiContext;
    const server = createServer((req, res) => { if (!handleWebRequest(req, res, new URL(req.url!, origin), context)) { res.writeHead(404); res.end(); } });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    rigs.push({ server, service });
    const made = sessions.create({ tier: "admin", surface: "local", label: "scratch browser", tokenEpoch: tokenEpoch(token) });
    const headers = { cookie: `agend_session=${made.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(made.sessionId), "content-type": "application/json" } as Record<string, string>;
    // The coordinator's `current(owner)` is the session record: make the rig's owner that record.
    const call = (query: string, body?: unknown) => new Promise<{ status: number; body: any; raw: string }>((resolveCall, reject) => {
      const req = request(origin + "/ui/browser-backend-signins" + query, { method: body ? "POST" : "GET", headers }, res => {
        let raw = ""; res.on("data", c => { raw += c; }); res.on("end", () => { try { resolveCall({ status: res.statusCode!, body: JSON.parse(raw), raw }); } catch (e) { reject(e); } });
      }); req.on("error", reject); req.setTimeout(5_000, () => req.destroy(Error("private HTTP deadline"))); req.end(body ? JSON.stringify(body) : undefined);
    });
    return { ...h, call, defaultService, service };
  }
  const Q = "?backend=claude-code&profile=CHY";
  it("reads and starts the NAMED account only: the default account's controls are not used, and the answer has the same shape plus its target", async () => {
    const h = await http();
    const read = await h.call(Q);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ selected: ["claude-code"], pending: ["claude-code"], skipped: [], ready: false, target: { backend: "claude-code", profile: "CHY" } });
    const started = await h.call(Q, { operation: "start", backend: "claude-code" });
    expect(started.status).toBe(200); expect(started.body.login).toMatchObject({ phase: "code", mine: true, url: URL_OK, canAct: true });
    expect(h.transport.start.mock.calls[0]![0]).toEqual({ argv: ["claude", "auth", "login"], profile: "CHY" });
    expect(h.defaultService.refresh).not.toHaveBeenCalled();
    const answered = await h.call(Q, { operation: "input", id: started.body.login.id, revision: started.body.login.revision, action: { kind: "code", value: CODE } });
    expect(answered.status).toBe(200); expect(h.transport.write.mock.calls[0]![0]).toBe(`${CODE}\r`);
    const cancelled = await h.call(Q, { operation: "cancel" });
    expect(cancelled.body.login).toMatchObject({ phase: "failed", reason: "cancelled" });
    expect(h.lock.isHeld).toBe(false);
  });
  it.each([
    ["?backend=claude-code"], ["?profile=CHY"], ["?backend=kiro-cli&profile=CHY"], ["?backend=codex&profile=CHY"], ["?backend=claude-code&profile=..%2Fx"], ["?backend=claude-code&profile="],
    ["?backend=claude-code&profile=CHY&x=1"], ["?backend=claude-code&backend=claude-code"], ["?backend=claude-code&machine=3f2b6e0a-1111-4222-8333-444455556666&profile=CHY"],
    ["?machine=3f2b6e0a-1111-4222-8333-444455556666&backend=claude-code"], ["?profile=CHY&profile=CHY"],
  ])("%s is not an address: 404, nothing starts", async (query) => {
    const h = await http();
    expect((await h.call(query)).status).toBe(404);
    expect((await h.call(query, { operation: "start", backend: "claude-code" })).status).toBe(404);
    expect(h.transport.start).not.toHaveBeenCalled();
  });
  it("a start for another backend than the address's, an unknown operation and a select/skip (no checklist here) are refused", async () => {
    const h = await http();
    for (const body of [{ operation: "start", backend: "codex" }, { operation: "start", backend: "kiro-cli" }, { operation: "select", backends: ["claude-code"] }, { operation: "skip", backend: "claude-code" },
      { operation: "start", backend: "claude-code", extra: 1 }, { operation: "start" }]) {
      expect((await h.call(Q, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.transport.start).not.toHaveBeenCalled();
  });
  it("another account while one runs: 409 signin_busy", async () => {
    const h = await http();
    await h.call(Q, { operation: "start", backend: "claude-code" });
    const second = await h.call("?backend=claude-code&profile=home", { operation: "start", backend: "claude-code" });
    expect(second.status).toBe(409); expect(second.body).toEqual({ error: "signin_busy" });
    expect(h.transport.start).toHaveBeenCalledTimes(1);
  });
  it("cancel may carry the run's id (32 hex): that run is ended; another id is accepted but ends nothing; anything else is a 400 (#3418 review)", async () => {
    const h = await http();
    const started = await h.call(Q, { operation: "start", backend: "claude-code" });
    for (const bad of ["x", "A".repeat(32), "a".repeat(31), 5, null]) expect((await h.call(Q, { operation: "cancel", id: bad })).status, JSON.stringify(bad)).toBe(400);
    const stale = await h.call(Q, { operation: "cancel", id: "f".repeat(32) });
    expect(stale.status).toBe(200); expect(stale.body.login).toMatchObject({ phase: "code" }); expect(h.transport.close).not.toHaveBeenCalled();
    const ended = await h.call(Q, { operation: "cancel", id: started.body.login.id });
    expect(ended.body.login).toMatchObject({ phase: "failed", reason: "cancelled" }); expect(h.transport.close).toHaveBeenCalledTimes(1); expect(h.lock.isHeld).toBe(false);
  });
  it("a name that is not an existing account is refused before anything is read or reserved: 409 signin_profile_unknown, no probe, no CLI, no folder (#3418 review)", async () => {
    const h = await http({ known: (_backend, profile) => profile === "CHY" });
    for (const query of ["?backend=claude-code&profile=chy", "?backend=claude-code&profile=NEW"]) {
      expect(await h.call(query)).toMatchObject({ status: 409, body: { error: "signin_profile_unknown" } });
      expect(await h.call(query, { operation: "start", backend: "claude-code" })).toMatchObject({ status: 409, body: { error: "signin_profile_unknown" } });
      expect(await h.call(query, { operation: "refresh" })).toMatchObject({ status: 409, body: { error: "signin_profile_unknown" } });
    }
    expect(h.checkAuth).not.toHaveBeenCalled(); expect(h.transport.start).not.toHaveBeenCalled(); expect(h.lock.isHeld).toBe(false);
    expect((await h.call(Q)).status).toBe(200);   // the account that exists reads as before
  });
  it("an error never carries a vendor's words or a path", async () => {
    const h = await http(); h.transport.start.mockRejectedValue(new Error("/home/x/.claude secret"));
    const started = await h.call(Q, { operation: "start", backend: "claude-code" });
    expect(started.raw).not.toMatch(/secret|\/home/);
    expect(started.body.login).toMatchObject({ phase: "failed", reason: "transport_failed" });
  });
});

describe("FleetManager", () => {
  function fleet() {
    vi.useFakeTimers();
    const dir = temp(); addAccount(dir, "CHY");   // the account exists: Add made it
    writePendingBackendSignIns(dir, { version: 1, selected: ["claude-code"], pending: ["claude-code"] });
    const fm = new FleetManager(dir) as any; fm.fleetConfig = { defaults: {}, instances: {} };
    const sessions = new WebSessionStore({}); fm.webSessions = sessions; Object.defineProperty(fm, "webToken", { get: () => "scratch-token" });
    const owner = sessions.create({ tier: "admin", surface: "local", label: "Scratch browser", tokenEpoch: tokenEpoch("scratch-token") }).record;
    vi.spyOn(fm, "isCliInstalledOffLoop").mockResolvedValue(true);
    const notice = vi.spyOn(fm, "notifyFleetError").mockImplementation(() => {});
    const recovery = vi.spyOn(fm, "recoverBackendInstances").mockResolvedValue({ woken: [], restarted: [], pending: [] });
    const keepAlive = vi.spyOn(fm, "keepAliveAfterSignIn").mockImplementation(() => {});
    const state = { auth: "invalid" as "valid" | "invalid", alive: true };
    const transport = { start: vi.fn(async (..._a: unknown[]) => {}), capture: vi.fn(async () => CLAUDE_CODE_PANE), status: vi.fn(async () => ({ alive: state.alive })), write: vi.fn(async (..._a: unknown[]) => {}), close: vi.fn(async () => {}) };
    const service = fm.profileSignIns as ProfileSignIns, deps = (service as unknown as { deps: any }).deps;
    deps.checkAuth = vi.fn(async () => state.auth); deps.transport = () => transport;
    return { fm, dir, owner, state, service, deps, transport, notice, recovery, keepAlive };
  }
  const target = { backend: "claude-code", profile: "CHY" };

  it("it shares the host's login window and is a coordinator of its own (not the default account's)", () => {
    const h = fleet();
    expect(h.deps.lock).toBe(h.fm.loginWindow); expect(h.service).not.toBe(h.fm.browserBackendSignIns);
    expect(h.fm.profileSignIns).toBe(h.service);
  });
  it("done: only the agents on THAT account are recovered, its keep-alive is checked, the default account's pending list is untouched, and the event log has no secrets", async () => {
    const h = fleet(); const events: unknown[] = [];
    h.fm.eventLog = { insert: (...args: unknown[]) => { events.push(args); } };
    await h.service.begin(h.owner, target);
    expect(h.notice).toHaveBeenCalledTimes(1); expect(h.notice.mock.calls[0]![0]).toContain("CHY"); expect(h.recovery).not.toHaveBeenCalled();
    const v = h.service.snapshot(h.owner, target).login!;
    await h.service.input(h.owner, target, v.id, v.revision, { kind: "code", value: CODE });
    h.state.auth = "valid"; h.state.alive = false;
    await vi.advanceTimersByTimeAsync(600);
    expect(h.service.snapshot(h.owner, target).login).toMatchObject({ phase: "done" });
    expect(h.recovery).toHaveBeenCalledTimes(1); expect(h.recovery).toHaveBeenCalledWith("claude-code", undefined, "CHY");
    expect(h.keepAlive).toHaveBeenCalledWith("claude-code", "CHY");
    expect(readPendingBackendSignIns(h.dir)).toEqual({ version: 1, selected: ["claude-code"], pending: ["claude-code"] });
    expect(JSON.stringify(events)).not.toMatch(/oauth|claude\.com|AbCd/);
    expect(events.some(e => (e as unknown[])[1] === "browser_profile_signin")).toBe(true);
    expect(h.fm.loginWindow.isHeld).toBe(false);
  });
  it("a sign-in that reuses an already valid login changes nothing, so nothing is restarted", async () => {
    const h = fleet(); h.state.auth = "valid";
    await h.service.begin(h.owner, target);
    expect(h.transport.start).not.toHaveBeenCalled(); expect(h.recovery).not.toHaveBeenCalled();
  });
  it("Remove and Sign out refuse that account while its sign-in runs (and only that account); once it ends they do not", async () => {
    const h = fleet(); await h.service.begin(h.owner, target);
    expect(h.fm.removalRequest("claude-code", "CHY", "CHY", null).signingIn).toBe(true);
    expect(h.fm.removalRequest("claude-code", "chy", "chy", null).signingIn).toBe(true);
    expect(h.fm.removalRequest("claude-code", "home", "home", null).signingIn, "another account's own sign-in does not stop it being removed").toBe(false);
    expect(h.fm.removalRequest("codex", "CHY", "CHY", null).signingIn).toBe(false);
    const out = await h.fm.signOutAccount("claude-code", "CHY", true, "admin:test");
    expect(out).toMatchObject({ ok: false, error: "signing_in" });
    await h.service.cancel(h.owner, target);
    expect(h.fm.removalRequest("claude-code", "CHY", "CHY", null).signingIn).toBe(false);
  });
  it("`/login cancel` ends it: the child is reaped and the window is free", async () => {
    const h = fleet(); await h.service.begin(h.owner, target);
    const message = await h.fm.cancelLoginSession();
    expect(message).toContain("CHY"); expect(h.transport.close).toHaveBeenCalledTimes(1);
    expect(h.fm.loginWindow.isHeld).toBe(false); expect(h.service.signingIn("claude-code", "CHY")).toBe(false);
    expect(h.service.snapshot(h.owner, target).login).toMatchObject({ phase: "failed", reason: "cancelled" });
  });
  it("Remove with cancelSignIn (\"Cancel sign-in and remove\", #3321 review) ends THIS account's structured sign-in and then removes it; another account's keeps running; without cancelSignIn Remove still refuses", async () => {
    const h = fleet();
    for (const name of ["CHY", "WORK"]) { mkdirSync(profileHome(h.dir, name), { recursive: true }); }
    await h.service.begin(h.owner, target);
    expect(await h.fm.removeAccountProfile("claude-code", "CHY", "CHY", "Scratch browser")).toEqual({ ok: false, error: "signing_in" });
    expect(h.transport.close).not.toHaveBeenCalled();
    // Another account is removed with the flag: this account's sign-in is not its business.
    expect(await h.fm.removeAccountProfile("claude-code", "WORK", "WORK", "Scratch browser", undefined, { cancelSignIn: true })).toEqual({ ok: true });
    expect(h.service.signingIn("claude-code", "CHY")).toBe(true); expect(h.transport.close).not.toHaveBeenCalled(); expect(existsSync(profileHome(h.dir, "CHY"))).toBe(true);
    // This one: the sign-in is ended (the child reaped, the window free), then the usual checks pass and the folder goes.
    expect(await h.fm.removeAccountProfile("claude-code", "CHY", "CHY", "Scratch browser", undefined, { cancelSignIn: true })).toEqual({ ok: true });
    expect(h.transport.close).toHaveBeenCalledTimes(1); expect(h.fm.loginWindow.isHeld).toBe(false); expect(existsSync(profileHome(h.dir, "CHY"))).toBe(false);
  });
  it("shutdown ends it and awaits the reap; a child that cannot be shown gone keeps sign-in admission closed", async () => {
    const h = fleet(); await h.service.begin(h.owner, target);
    h.fm.shuttingDown = true; await h.fm.shutdownLoginWindows();
    expect(h.transport.close).toHaveBeenCalledTimes(1); expect(h.fm.profileSignInsInstance).toBeNull();
    const bad = fleet(); await bad.service.begin(bad.owner, target);
    bad.transport.close.mockRejectedValue(new Error("private vendor data")); bad.fm.shuttingDown = true;
    await bad.fm.shutdownLoginWindows();
    expect(bad.fm.loginWindow.isClosed).toBe(true); expect(bad.fm.structuredLoginCleanupFailed).toBe(true); expect(bad.fm.profileSignInsInstance).toBe(bad.service);
  });
});
