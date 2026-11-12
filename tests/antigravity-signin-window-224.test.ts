/**
 * AGEND-224 (upstream #3330, option A): `agy acp --login` is driven by the dashboard's structured sign-in, in the host's dedicated login window, never an instance pane.
 * What the maintainer's review asks for is pinned here, with the real LoginWindowLock (#3725: one window per backend) and the real StructuredSignIn / ProfileSignIns; every CLI effect is a stub
 * (`agy` is never started):
 *  - the per-backend login window: an Antigravity sign-in holds Antigravity's window only (Claude Code, Grok… beside it), and takes turns with the same backend's other writers;
 *  - credential isolation per profile: each account's sign-in is launched with its own folder and is refused unless the folder was proved isolated (nothing started otherwise);
 *    a sign-in that ended well but left no token in the account's own folder is not a sign-in; the default's login is never an account's;
 *  - cancel, the ten-minute limit, a failure, a refusal and a transport that cannot start leave no process and no held window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StructuredSignIn, type StructuredSignInTransport } from "../src/structured-signin.js";
import { ProfileSignIns, type ProfileSignInDeps } from "../src/profile-signins.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { AGY_SCREEN, AGY_CODE } from "./helpers/machine-runtime.js";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStructuredSignInTransport } from "../src/structured-signin-transport.js";
import { proveFolderIsolation } from "../src/account-isolation.js";
import { LOGIN_FLOWS, checkAuthSignedOut, setAuthCheckRunnerForTests } from "../src/login-flows.js";
import { addAccountProfile } from "../src/accounts-profiles.js";
import { credentialProfileHome } from "../src/backend/credential-profile.js";
import { existsSync } from "node:fs";
import type { TerminalBackend } from "../src/web-terminal.js";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); setAuthCheckRunnerForTests(null); for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmpDirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-224-")); tmpDirs.push(d); return d; };

const TEN_MINUTES = 10 * 60_000;
const WRONG = `couldn't log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."`;

function fakeTransport(over: Partial<{ pane: string; alive: boolean; exitCode: number }> = {}) {
  const state = { pane: AGY_SCREEN, alive: true, exitCode: undefined as number | undefined, ...over };
  const transport = {
    start: vi.fn<StructuredSignInTransport["start"]>().mockResolvedValue(undefined),
    capture: vi.fn(async () => state.pane),
    status: vi.fn(async () => ({ alive: state.alive, ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}) })),
    write: vi.fn<StructuredSignInTransport["write"]>().mockResolvedValue(undefined),
    close: vi.fn<StructuredSignInTransport["close"]>().mockResolvedValue(undefined),
  };
  return { state, transport };
}
function session(lock: LoginWindowLock, owner: object, options: { profile?: string; isolated?: () => Promise<boolean>; checkAuth?: () => Promise<"valid" | "invalid" | "unknown">; transport?: ReturnType<typeof fakeTransport> } = {}) {
  const t = options.transport ?? fakeTransport();
  const s = new StructuredSignIn("antigravity", owner, {
    transport: t.transport, lock, current: () => true, checkAuth: options.checkAuth ?? (async () => "invalid"), now: () => Date.now(),
    ...(options.profile !== undefined ? { profile: options.profile } : {}), ...(options.isolated ? { isolated: options.isolated } : {}),
  });
  return { s, ...t, view: () => s.view(owner) };
}

describe("the dedicated login window is per backend (#3725)", () => {
  it("an Antigravity sign-in holds Antigravity's window only: Claude Code and Grok can still be connected beside it", async () => {
    const lock = new LoginWindowLock(), owner = {};
    const agy = session(lock, owner);
    await agy.s.start();
    expect(lock.heldFor("antigravity")).not.toBeNull();
    expect(lock.heldFor("claude-code")).toBeNull(); expect(lock.heldFor("grok")).toBeNull();
    expect(lock.tryClaim("web", "claude-code")).not.toBeNull();
    expect(lock.tryClaim("web", "grok")).not.toBeNull();
    expect(lock.held.map(claim => claim.backend).sort()).toEqual(["antigravity", "claude-code", "grok"]);
    await agy.s.cancel();
  });
  it("the same backend takes turns: a second Antigravity sign-in (another account, or its keep-alive) is refused as busy and starts nothing; the first is untouched", async () => {
    const lock = new LoginWindowLock(), owner = {};
    const first = session(lock, owner);
    await first.s.start();
    const second = session(lock, owner, { profile: "work", isolated: async () => true });
    await second.s.start();
    expect(second.view()).toMatchObject({ phase: "failed", reason: "busy" });
    expect(second.transport.start).not.toHaveBeenCalled(); expect(second.transport.close).not.toHaveBeenCalled();
    expect(lock.tryClaim("keepalive", "antigravity")).toBeNull(); expect(lock.tryClaim("web", "antigravity")).toBeNull();
    expect(first.view()).toMatchObject({ phase: expect.not.stringMatching(/^(failed|done)$/) });
    expect(lock.isCurrent(lock.heldFor("antigravity"))).toBe(true);
    await first.s.cancel();
    expect(lock.heldFor("antigravity")).toBeNull();
    expect(lock.tryClaim("web", "antigravity")).not.toBeNull();   // free again once the first one ends
  });
});

describe("cancel, time-out and failure leave no process and no window", () => {
  it("cancel: the process is closed once, the window is released, nothing is signed in", async () => {
    const lock = new LoginWindowLock();
    const a = session(lock, {});
    await a.s.start();
    expect(a.transport.start).toHaveBeenCalledWith({ argv: ["agy", "acp", "--login"] }, expect.anything());
    await a.s.cancel();
    expect(a.view()).toMatchObject({ phase: "failed", reason: "cancelled" });
    expect(a.transport.close).toHaveBeenCalledTimes(1);
    expect(lock.isHeld).toBe(false);
    await a.s.cancel();   // idempotent: no second close
    expect(a.transport.close).toHaveBeenCalledTimes(1);
  });
  it("left alone for ten minutes it expires: process closed, window released", async () => {
    const lock = new LoginWindowLock();
    const a = session(lock, {});
    await a.s.start();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES + 1000);
    expect(a.view()).toMatchObject({ phase: "failed", reason: "expired" });
    expect(a.transport.close).toHaveBeenCalledTimes(1);
    expect(lock.isHeld).toBe(false);
  });
  it("a code the provider refuses: the process is reaped and the window released", async () => {
    const lock = new LoginWindowLock(), owner = {};
    const a = session(lock, owner);
    await a.s.start();
    await a.s.action(owner, a.s.id, a.view().revision, { kind: "code", value: AGY_CODE });
    a.state.pane = `${AGY_SCREEN}\n${WRONG}\n`; a.state.alive = false; a.state.exitCode = 1;
    await a.s.poll();
    expect(a.view()).toMatchObject({ phase: "failed", reason: "provider_rejected" });
    expect(a.transport.close).toHaveBeenCalledTimes(1); expect(lock.isHeld).toBe(false);
  });
  it("the command ending without a sign-in (exit 0 but `agy models` still says signed out) fails and frees the window", async () => {
    const lock = new LoginWindowLock(), owner = {};
    const a = session(lock, owner);
    await a.s.start();
    a.state.alive = false; a.state.exitCode = 0;
    await a.s.poll();
    expect(a.view()).toMatchObject({ phase: "failed" });
    expect(a.transport.close).toHaveBeenCalledTimes(1); expect(lock.isHeld).toBe(false);
  });
  it("a transport that cannot start ends as a failure: the window is released and nothing is left to close twice", async () => {
    const lock = new LoginWindowLock();
    const t = fakeTransport(); t.transport.start.mockRejectedValue(new Error("spawn agy ENOENT"));
    const a = session(lock, {}, { transport: t });
    await a.s.start();
    expect(a.view()).toMatchObject({ phase: "failed", reason: "transport_failed" });
    expect(lock.isHeld).toBe(false);
    expect(t.transport.close.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it("shutdown of the window (the daemon stopping) ends the run: its process is closed and no claim survives", async () => {
    const lock = new LoginWindowLock();
    const a = session(lock, {});
    await a.s.start();
    lock.close();
    await a.s.poll();
    expect(lock.isHeld).toBe(false);
    expect(a.view()).toMatchObject({ phase: "failed" });
    expect(a.transport.close).toHaveBeenCalledTimes(1);
  });
});

describe("each profile's credentials are its own (nothing is written to, or read from, another account's folder)", () => {
  function accounts() {
    const lock = new LoginWindowLock(), owner = {};
    const launched: Array<{ profile: string | undefined; argv: readonly string[] }> = [];
    const isolatedFor: string[] = [];
    const answers = { isolated: true as boolean | "throws", auth: "invalid" as "valid" | "invalid" | "unknown" };
    const transports = new Map<string, ReturnType<typeof fakeTransport>>();
    const deps: ProfileSignInDeps = {
      lock, current: o => o === owner, installed: async () => true, known: () => "exists", add: () => true,
      checkAuth: async () => answers.auth,
      isolated: async (backend, profile) => { isolatedFor.push(`${backend}/${profile}`); if (answers.isolated === "throws") throw new Error("probe failed"); return answers.isolated; },
      transport: target => {
        const t = fakeTransport(); transports.set(`${target.backend}/${target.profile}`, t);
        t.transport.start.mockImplementation(async spec => { launched.push({ profile: target.profile, argv: spec.argv }); });
        return t.transport;
      },
    };
    return { lock, owner, service: new ProfileSignIns(deps), launched, isolatedFor, answers, transports };
  }

  it("a named account's sign-in is launched for THAT account's folder (its own transport), after its folder was proved isolated", async () => {
    const r = accounts();
    await r.service.begin(r.owner, { backend: "antigravity", profile: "work" });
    expect(r.isolatedFor).toEqual(["antigravity/work"]);
    expect(r.launched).toEqual([{ profile: "work", argv: ["agy", "acp", "--login"] }]);
    expect([...r.transports.keys()]).toEqual(["antigravity/work"]);
    await r.service.cancel(r.owner, { backend: "antigravity", profile: "work" });
    // The next account gets its own proof and its own transport: nothing is shared between two accounts' launches.
    await r.service.begin(r.owner, { backend: "antigravity", profile: "spare" });
    expect(r.isolatedFor).toEqual(["antigravity/work", "antigravity/spare"]);
    expect(r.launched.map(l => l.profile)).toEqual(["work", "spare"]);
    expect([...r.transports.keys()].sort()).toEqual(["antigravity/spare", "antigravity/work"]);
    await r.service.cancel(r.owner, { backend: "antigravity", profile: "spare" });
  });
  it("a folder that is not isolated (the CLI would keep the login in a store every folder shares) starts nothing and says so; the window is freed", async () => {
    const r = accounts(); r.answers.isolated = false;
    const snap = await r.service.begin(r.owner, { backend: "antigravity", profile: "work" });
    expect(snap.login).toMatchObject({ phase: "failed", reason: "not_isolated" });
    expect(r.launched).toEqual([]);
    expect(r.lock.isHeld).toBe(false);
  });
  it("an isolation check that cannot be made is not isolation: nothing starts", async () => {
    const r = accounts(); r.answers.isolated = "throws";
    const snap = await r.service.begin(r.owner, { backend: "antigravity", profile: "work" });
    expect(snap.login).toMatchObject({ phase: "failed", reason: "not_isolated" });
    expect(r.launched).toEqual([]); expect(r.lock.isHeld).toBe(false);
  });
  it("a sign-in that ended well but left no token in the account's own folder is not a sign-in (it was kept in a shared store): not_isolated, never done, the process reaped", async () => {
    const lock = new LoginWindowLock(), owner = {};
    const t = fakeTransport();
    const a = session(lock, owner, { profile: "work", isolated: async () => true, transport: t, checkAuth: async () => "valid" });
    await a.s.start(true);
    // exit 0 and the host's check says "signed in" (the default's login is there), but the transport says the account's own folder holds none.
    t.transport.status.mockResolvedValue({ alive: false, exitCode: 0, isolated: false } as never);
    await a.s.poll();
    expect(a.view()).toMatchObject({ phase: "failed", reason: "not_isolated" });
    expect(a.transport.close).toHaveBeenCalledTimes(1); expect(lock.isHeld).toBe(false);
  });
  it("two accounts never run together (one window): a second account cannot be signed in over the first, and the first's folder is left as it was", async () => {
    const r = accounts();
    await r.service.begin(r.owner, { backend: "antigravity", profile: "work" });
    await expect(r.service.begin(r.owner, { backend: "antigravity", profile: "spare" })).rejects.toThrow("signin_busy");
    expect(r.launched.map(l => l.profile)).toEqual(["work"]);
    expect(r.isolatedFor).toEqual(["antigravity/work"]);
    await r.service.cancel(r.owner, { backend: "antigravity", profile: "work" });
  });
  it("only a closed table launches: a profile name that is not a name is refused before any proof or process", async () => {
    const r = accounts();
    for (const bad of ["../other", "a/b", "", "x y", "-x"]) await expect(r.service.begin(r.owner, { backend: "antigravity", profile: bad }), bad).rejects.toThrow();
    expect(r.isolatedFor).toEqual([]); expect(r.launched).toEqual([]); expect(r.lock.isHeld).toBe(false);
  });
});

// ── review of AGEND-224: the isolation proof is strict, and the host checks after the command (P1-1, P1-2) ──

/** A fake `agy models`: what it answers for a launch, by how the account's launch reached it. `pin` false = a build that no longer honours the pin (it reads the system keyring: every folder's). */
type FakeAgy = { pinHonoured: boolean; defaultConnected: boolean; offline?: boolean; refusesFlag?: boolean; broken?: boolean };
function fakeAgy(state: FakeAgy) {
  const calls: string[][] = [];
  const run = async (argv: string[], _timeout: number, env?: Record<string, string>): Promise<{ code: number | null; output: string }> => {
    calls.push(argv);
    if (state.broken) return { code: null, output: "" };
    if (state.refusesFlag) return { code: 2, output: "Error: unknown flag: --app_data_dir" };
    if (state.offline) return { code: 1, output: "Fetching available models...\nError: failed to fetch models: Get \"https://cloudcode-pa.googleapis.com\": dial tcp: lookup cloudcode-pa.googleapis.com: no such host" };
    const pinned = !!env?.SSH_CONNECTION && argv.includes("--app_data_dir");
    const connected = pinned && state.pinHonoured ? false : state.defaultConnected;       // an empty folder under a honoured pin is signed out; otherwise the keyring's login answers
    return connected ? { code: 0, output: "gemini-3.5-flash\tGemini 3.5 Flash\n" } : { code: 1, output: "Fetching available models...\nError: Please sign in to view available models. Launch agy to log in." };
  };
  return { run, calls };
}
const strictProof = () => proveFolderIsolation("antigravity", launch => checkAuthSignedOut(LOGIN_FLOWS.antigravity!.authCheck!, launch.env, launch.args), tmp());

describe("the isolation proof only passes on 'signed out' said in words (P1-1)", () => {
  it("a build that honours the pin: the empty scratch folder is signed out, in agy's words → proven", async () => {
    setAuthCheckRunnerForTests(fakeAgy({ pinHonoured: true, defaultConnected: true }).run);
    expect(await strictProof()).toBe(true);
  });
  it("a pin that no longer holds while the default account IS connected: agy answers for the keyring (exit 0) → not proven", async () => {
    setAuthCheckRunnerForTests(fakeAgy({ pinHonoured: false, defaultConnected: true }).run);
    expect(await strictProof()).toBe(false);
  });
  it.each([
    ["offline (agy could not reach Google)", { offline: true }],
    ["a flag the CLI refused", { refusesFlag: true }],
    ["a CLI that cannot run at all (no exit code)", { broken: true }],
  ] as const)("%s is not 'signed out': not proven, however it ends", async (_label, extra) => {
    const agy = fakeAgy({ pinHonoured: true, defaultConnected: false, ...extra });
    setAuthCheckRunnerForTests(agy.run);
    expect(await strictProof()).toBe(false);
    expect(agy.calls.length).toBeLessThanOrEqual(2);   // asked once more at most
  });
  it("the strict reading: non-zero without the words is 'unknown', with them 'invalid', exit 0 is 'valid'", async () => {
    const check = LOGIN_FLOWS.antigravity!.authCheck!;
    for (const [code, output, want] of [[1, "Error: Please sign in to view available models.", "invalid"], [1, "dial tcp: no such host", "unknown"], [127, "agy: not found", "unknown"], [0, "model\tName", "valid"], [null, "", "unknown"]] as const) {
      setAuthCheckRunnerForTests(async () => ({ code, output }));
      expect(await checkAuthSignedOut(check), `${code} ${output}`).toBe(want);
    }
  });
});

describe("the host checks after the command, as the Runtime does (P1-2)", () => {
  function hostRig() {
    const dataDir = tmp();
    expect(addAccountProfile(dataDir, "antigravity", "work").ok).toBe(true);
    const home = credentialProfileHome(dataDir, "antigravity", "work");
    const state = { alive: true, exitCode: undefined as number | undefined };
    const native: TerminalBackend = { start: vi.fn(async () => {}), sendInput: vi.fn(async () => {}), resize: vi.fn(async () => {}), capture: vi.fn(async () => AGY_SCREEN),
      paneStatus: vi.fn(async () => ({ alive: state.alive, ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}) })), kill: vi.fn(async () => {}) };
    const transport = createStructuredSignInTransport({ native, env: { HOME: tmp(), PATH: "/stub/bin" }, backend: "antigravity", dataDir });
    return { dataDir, home, state, native, transport };
  }
  it("exit 0 with no token file in the account's folder (the pin did not hold; the login went elsewhere): the status says isolated:false", async () => {
    const h = hostRig();
    await h.transport.start({ argv: ["agy", "acp", "--login"], profile: "work" }, new AbortController().signal);
    expect(await h.transport.status()).toEqual({ alive: true });                 // still running: nothing to say yet
    h.state.alive = false; h.state.exitCode = 0;
    expect(await h.transport.status()).toMatchObject({ alive: false, exitCode: 0, isolated: false });
    h.state.exitCode = 1;
    expect(await h.transport.status(), "a failed command is the failure it is, not an isolation verdict").toEqual({ alive: false, exitCode: 1 });
  });
  it("a plain token file in the account's own folder is kept; a link, or a folder of that name, is not", async () => {
    const h = hostRig();
    await h.transport.start({ argv: ["agy", "acp", "--login"], profile: "work" }, new AbortController().signal);
    h.state.alive = false; h.state.exitCode = 0;
    writeFileSync(join(h.home, "antigravity-oauth-token"), "{}");
    expect(await h.transport.status()).toEqual({ alive: false, exitCode: 0 });
    rmSync(join(h.home, "antigravity-oauth-token"));
    const elsewhere = join(tmp(), "someone-elses-token"); writeFileSync(elsewhere, "{}");
    symlinkSync(elsewhere, join(h.home, "antigravity-oauth-token"));
    expect(await h.transport.status()).toMatchObject({ isolated: false });
    rmSync(join(h.home, "antigravity-oauth-token"));
    mkdirSync(join(h.home, "antigravity-oauth-token"));
    expect(await h.transport.status()).toMatchObject({ isolated: false });
  });
  it("the default account's sign-in (no profile) has no such check: nothing is added to its status", async () => {
    const h = hostRig();
    await h.transport.start({ argv: ["agy", "acp", "--login"] }, new AbortController().signal);
    h.state.alive = false; h.state.exitCode = 0;
    expect(await h.transport.status()).toEqual({ alive: false, exitCode: 0 });
  });
  it("end to end: the default account is NOT connected and the pin is broken — the proof passes (agy says 'Please sign in' for the empty folder), the login writes its token elsewhere → not_isolated, never connected", async () => {
    const h = hostRig(), owner = {}, lock = new LoginWindowLock();
    const agy = fakeAgy({ pinHonoured: false, defaultConnected: false }); setAuthCheckRunnerForTests(agy.run);
    expect(await strictProof(), "the limit of the proof, which the check after the command closes").toBe(true);
    const s = new StructuredSignIn("antigravity", owner, {
      transport: h.transport, lock, current: () => true, profile: "work", now: () => Date.now(), isolated: strictProof,
      checkAuth: () => checkAuthSignedOut(LOGIN_FLOWS.antigravity!.authCheck!, { SSH_CONNECTION: "x" }, ["--app_data_dir", "x"]).then(r => r === "valid" ? "valid" : "invalid"),
    });
    await s.start();
    expect(h.native.start).toHaveBeenCalledTimes(1);
    h.state.alive = false; h.state.exitCode = 0;                                   // agy ended well; its token is in the keyring, not in the folder
    await s.poll();
    expect(s.view(owner)).toMatchObject({ phase: "failed", reason: "not_isolated" });
    expect(h.native.kill).toHaveBeenCalledTimes(1); expect(lock.isHeld).toBe(false);
  });
  it("end to end, offline: the proof is not given, nothing is started, the window is freed", async () => {
    const h = hostRig(), owner = {}, lock = new LoginWindowLock();
    setAuthCheckRunnerForTests(fakeAgy({ pinHonoured: true, defaultConnected: false, offline: true }).run);
    const s = new StructuredSignIn("antigravity", owner, { transport: h.transport, lock, current: () => true, profile: "work", now: () => Date.now(), isolated: strictProof, checkAuth: async () => "invalid" });
    await s.start();
    expect(s.view(owner)).toMatchObject({ phase: "failed", reason: "not_isolated" });
    expect(h.native.start).not.toHaveBeenCalled(); expect(lock.isHeld).toBe(false);
  });
});

describe("GEMINI_HOME does not move agy's --app_data_dir base (P2-3, checked with the real agy 1.5.6, Linux and Windows)", () => {
  it("the folder argument is relative to the user's ~/.gemini whatever GEMINI_HOME says", async () => {
    const { credentialProfileLaunchAt } = await import("../src/backend/credential-profile.js");
    const { homedir } = await import("node:os");
    const { relative, resolve } = await import("node:path");
    const folder = join(tmp(), "agend-home", "credential-profiles", "antigravity", "work");
    const before = credentialProfileLaunchAt("antigravity", folder)!.args;
    const saved = process.env.GEMINI_HOME; process.env.GEMINI_HOME = join(tmp(), "somewhere", "else");
    try { expect(credentialProfileLaunchAt("antigravity", folder)!.args).toEqual(before); } finally { if (saved === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = saved; }
    expect(before).toEqual(["--app_data_dir", relative(resolve(homedir(), ".gemini"), folder)]);
  });
});

// ── maintainer's five points (#3330 comment 6818646882) ──

describe("a connect never reads or writes another account's folder", () => {
  it("connecting a named account writes nothing into its folder before agy does, and reads nothing of the default's (no copy, no generated first-run file)", async () => {
    const shared = tmp(), saved = process.env.GEMINI_HOME;
    process.env.GEMINI_HOME = shared;
    try {
      mkdirSync(join(shared, "antigravity-cli", "cache"), { recursive: true });
      writeFileSync(join(shared, "antigravity-cli", "settings.json"), JSON.stringify({ trustedWorkspaces: ["/default-only"] }));
      writeFileSync(join(shared, "antigravity-cli", "antigravity-oauth-token"), "{\"default\":\"login\"}");
      const dataDir = tmp(); expect(addAccountProfile(dataDir, "antigravity", "work").ok).toBe(true);
      const home = credentialProfileHome(dataDir, "antigravity", "work");
      const native: TerminalBackend = { start: vi.fn(async () => {}), sendInput: vi.fn(async () => {}), resize: vi.fn(async () => {}), capture: vi.fn(async () => AGY_SCREEN), paneStatus: vi.fn(async () => ({ alive: true })), kill: vi.fn(async () => {}) };
      const transport = createStructuredSignInTransport({ native, env: { HOME: tmp(), PATH: "/stub/bin" }, backend: "antigravity", dataDir });
      await transport.start({ argv: ["agy", "acp", "--login"], profile: "work" }, new AbortController().signal);
      expect(readdirSync(home), "the account's folder is exactly what Add made: empty").toEqual([]);
    } finally { if (saved === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = saved; }
  });
});

describe("only the dedicated login window, no instance pane, no shell escape", () => {
  it("the launch is `exec env -i <allow-listed env> sh -c 'exec agy acp --login'` on a one-off socket in a scratch folder: no fleet env, no browser, no pane of an instance", async () => {
    const native: TerminalBackend = { start: vi.fn(async () => {}), sendInput: vi.fn(async () => {}), resize: vi.fn(async () => {}), capture: vi.fn(async () => AGY_SCREEN), paneStatus: vi.fn(async () => ({ alive: true })), kill: vi.fn(async () => {}) };
    const t = createStructuredSignInTransport({ native, env: { HOME: "/h", PATH: "/bin", ANTHROPIC_API_KEY: "must-not-pass", AGEND_INSTANCE: "dev", ANTIGRAVITY_REMOTE_OOB_AUTH: "1", SSH_AUTH_SOCK: "/s" } });
    await t.start({ argv: ["agy", "acp", "--login"] }, new AbortController().signal);
    const call = vi.mocked(native.start).mock.calls[0]![0];
    expect(call.socket).toMatch(/^agend-signin-[0-9a-f]{32}$/);
    expect(call.cwd).toContain("agend-signin-");
    expect(call.command).toMatch(/^exec env -i /);
    expect(call.command.split("sh -c ")[1]!.replaceAll("'\\''", "").replace(/^'|'$/g, "")).toBe("exec agy acp --login");   // the fixed argv and nothing else; exec: the shell is gone
    expect(call.command).toContain("'BROWSER=false'");
    for (const leaked of ["ANTHROPIC_API_KEY", "AGEND_INSTANCE", "ANTIGRAVITY_REMOTE_OOB_AUTH", "SSH_AUTH_SOCK"]) expect(call.command, leaked).not.toContain(leaked);
    await t.close();
  });
  it("input is only a code, only at the code prompt: a page address, a space, a control byte, or anything before the prompt writes nothing", async () => {
    const lock = new LoginWindowLock(), owner = {};
    const a = session(lock, owner);
    await a.s.start();
    for (const bad of ["https://accounts.google.com/x", "two words", "bad\u0007bell", "line\nbreak", ""]) {
      expect(await a.s.action(owner, a.s.id, a.view().revision, { kind: "code", value: bad }), JSON.stringify(bad)).not.toBe("accepted");
    }
    expect(a.transport.write).not.toHaveBeenCalled();
    await a.s.cancel();
  });
});

describe("an unknown screen fails closed (the screen table) — the 5-second rule", () => {
  const UNKNOWN = "Allow agy to run `rm -rf ~`?  [y/N]\n> ";
  it("a screen that is neither the link, the code prompt nor a known ending is 'waiting'; after 5 s of it the sign-in ends as unsupported_prompt, the process is reaped, the window freed, and nothing was written", async () => {
    const lock = new LoginWindowLock(), owner = {};
    const a = session(lock, owner, { transport: fakeTransport({ pane: UNKNOWN }) });
    await a.s.start();
    expect(a.view().phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(a.view().phase, "not yet: the grace is 5 s").toBe("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(a.view()).toMatchObject({ phase: "failed", reason: "unsupported_prompt" });
    expect(a.transport.close).toHaveBeenCalledTimes(1); expect(a.transport.write).not.toHaveBeenCalled(); expect(lock.isHeld).toBe(false);
  });
  it("a screen that shows the login and then turns into something else is caught the same way, and a code box is never offered for it", async () => {
    const lock = new LoginWindowLock(), owner = {};
    const t = fakeTransport({ pane: AGY_SCREEN });
    const a = session(lock, owner, { transport: t });
    await a.s.start();
    t.state.pane = UNKNOWN;
    await vi.advanceTimersByTimeAsync(7_000);
    expect(a.view()).toMatchObject({ phase: "failed", reason: "unsupported_prompt" });
    expect(a.view().canAct).not.toBe(true);
    expect(t.transport.write).not.toHaveBeenCalled(); expect(lock.isHeld).toBe(false);
  });
  it("an escape sequence or an oversized pane is refused at once, without waiting", async () => {
    const lock = new LoginWindowLock(), owner = {};
    const a = session(lock, owner, { transport: fakeTransport({ pane: `\x1b[2J${AGY_SCREEN}` }) });
    await a.s.start();
    expect(a.view()).toMatchObject({ phase: "failed", reason: "unsupported_prompt" });
    expect(a.transport.close).toHaveBeenCalledTimes(1); expect(lock.isHeld).toBe(false);
  });
});
