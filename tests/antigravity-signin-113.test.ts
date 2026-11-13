/**
 * AGEND-113: Antigravity signs in from Settings → Accounts with `agy acp --login` (agy >= 1.5.0), on this host and on a paired Windows computer.
 *
 * What is pinned here, in the order of the issue:
 *  - the command is fixed (`agy acp --login`) on the host, in the closed table the server maps a launch through, and in what the Runtime builds itself;
 *  - the screen is reduced to a closed vocabulary (the link on `accounts.google.com` only, the code prompt, "Login failed", "Login cancelled") and success is the command ending with
 *    exit 0 AND `agy models` working, never a word on the screen (none has been seen) and never an older login still being there after a failed command;
 *  - on a computer, the only exception to "named profiles only" is Antigravity's own default login: no profile in the frames, none created, behind the same local `accounts`
 *    switch, one sign-in at a time, the start-rate limit, the ten-minute timeout and the audit record; every other CLI is refused exactly as before;
 *  - the server's side: the same `StructuredSignIn`, one target `{ machine, backend: "antigravity" }`, and rows the page reads.
 * Fixtures only (example.com); `agy` is never started.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REDUCED_AGY_CANCELLED, REDUCED_AGY_CODE_PROMPT, REDUCED_AGY_REJECTED, REDUCED_AGY_URL_PREFIX, RuntimeSignIn, checkedSignInInput, reduceAgyLoginScreen, reduceLoginScreen,
} from "../src/runtime-signin.js";
import { RUNTIME_SIGNIN_CLIS, createRuntimeSignInTransport, runtimeDefaultLoginStatus, type AccountCaller } from "../src/runtime-signin-transport.js";
import { StructuredSignIn, structuredSignInPrompt, type StructuredSignInTransport } from "../src/structured-signin.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { parseRuntimeRemotePayload } from "../src/runtime-protocol.js";
import { AUDIT_FILE } from "../src/runtime-remote-setup.js";
import { buildAccountsView } from "../src/accounts-view.js";
import { versionAtLeast } from "../src/backend-availability.js";
import { parseNativeAuthResult } from "../src/windows-cli-providers.js";
import { probeDefaultLogin, probeNativeClis, withAuthenticated, type NativeCliRow } from "../src/windows-cli-worker.js";
import { WindowsCliBridge } from "../src/windows-cli.js";
import { LOGIN_FLOWS } from "../src/login-flows.js";
import { hostFacts } from "../src/cli-registry.js";
import { AGY_CODE, AGY_SCREEN, AGY_URL, ACTOR, FakeChild, ID, cleanScratch, runtimeRig, scratch, waitFor } from "./helpers/machine-runtime.js";

afterEach(cleanScratch);

const HREF = new URL(AGY_URL).href;
const WRONG = `couldn't log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."`;
const CANCELLED = "login cancelled: no authorization code was entered";

describe("the screen of `agy acp --login`", () => {
  it("is reduced to the link and the code prompt, in fixed words, whatever else the CLI wrote", () => {
    expect(reduceAgyLoginScreen(AGY_SCREEN)).toBe(`${REDUCED_AGY_URL_PREFIX}${HREF}\n${REDUCED_AGY_CODE_PROMPT}\n`);
    // Control sequences and carriage returns (a terminal's redraw) change nothing; an account name in some other line never survives.
    const noisy = `\x1b[2K\rWelcome back ada.lovelace@example.com\r\n${AGY_SCREEN.replace(/\n/g, "\r\n")}\x1b[?25h`;
    expect(reduceAgyLoginScreen(noisy)).toBe(`${REDUCED_AGY_URL_PREFIX}${HREF}\n${REDUCED_AGY_CODE_PROMPT}\n`);
    expect(reduceAgyLoginScreen("")).toBe("");
    expect(reduceAgyLoginScreen("Starting…\n")).toBe("");
  });
  it("offers the link only for https on accounts.google.com itself: no other host, subdomain, port, credentials, scheme or control character", () => {
    const only = (url: string) => reduceAgyLoginScreen(`Open this link in a browser to log in with Google:\n\n  ${url}\n`);
    expect(only("https://accounts.google.com/o/oauth2/auth?client_id=x")).toContain(REDUCED_AGY_URL_PREFIX);
    for (const bad of ["http://accounts.google.com/o/oauth2/auth", "https://example.com/o/oauth2/auth", "https://accounts.google.com.evil.example.com/x", "https://evil.accounts.google.com/x",
      "https://google.com/x", "https://user:pw@accounts.google.com/x", "https://accounts.google.com:8443/x", "javascript:alert(1)", "https://accounts.google.com/\x07x", "ftp://accounts.google.com/x",
      `https://accounts.google.com/${"a".repeat(5000)}`]) expect(only(bad), bad).toBe("");
    // A link that is not the line after the sentence is not taken (a page the CLI merely mentions).
    expect(reduceAgyLoginScreen(`See https://accounts.google.com/o/oauth2/auth for details\n`)).toBe("");
    expect(reduceAgyLoginScreen(`Open this link in a browser to log in with Google:\nnot a link\nhttps://accounts.google.com/o/oauth2/auth\n`)).toBe("");
  });
  it("asks for the code only while the prompt is the last line", () => {
    expect(reduceAgyLoginScreen(`Open this link in a browser to log in with Google:\n\n  ${AGY_URL}\n`)).toBe(`${REDUCED_AGY_URL_PREFIX}${HREF}\n`);
    expect(reduceAgyLoginScreen(`${AGY_SCREEN}something else\n`)).toBe(`${REDUCED_AGY_URL_PREFIX}${HREF}\n`);
  });
  it("says only 'Login failed' or 'Login cancelled' for the two endings, never the CLI's own sentence", () => {
    expect(reduceAgyLoginScreen(`${AGY_SCREEN}\n${WRONG}\n`)).toBe(`${REDUCED_AGY_REJECTED}\n`);
    expect(reduceAgyLoginScreen(`${AGY_SCREEN}\n${CANCELLED}\n`)).toBe(`${REDUCED_AGY_CANCELLED}\n`);
    expect(reduceAgyLoginScreen(`${AGY_SCREEN}\n${WRONG}\n`)).not.toMatch(/invalid_grant|Malformed|oauth2/);
    // The CLI's words only count at the start of a line.
    expect(reduceAgyLoginScreen(`${AGY_SCREEN}error: couldn't log in\n`)).toBe(`${REDUCED_AGY_URL_PREFIX}${HREF}\n`);
  });
  it("reducing a reduced screen changes nothing (the server reads what the Runtime already reduced)", () => {
    for (const raw of [AGY_SCREEN, `Open this link in a browser to log in with Google:\n\n  ${AGY_URL}\n`, `${AGY_SCREEN}\n${WRONG}\n`, `${AGY_SCREEN}\n${CANCELLED}\n`, "", "Starting…"]) {
      const once = reduceAgyLoginScreen(raw);
      expect(reduceAgyLoginScreen(once), JSON.stringify(raw.slice(0, 40))).toBe(once);
    }
  });
  it("is the table the server reads for Antigravity, and Claude's is unchanged", () => {
    expect(reduceLoginScreen("antigravity", AGY_SCREEN)).toBe(reduceAgyLoginScreen(AGY_SCREEN));
    expect(reduceLoginScreen("claude-code", "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?x=1\nPaste code here if prompted >\n")).toContain("Paste code here if prompted >");
    expect(reduceLoginScreen("claude-code", AGY_SCREEN)).toBe("");   // the other CLI's words are not understood
  });
  it("is read by the host's driver as: link + prompt = code, a refusal, a cancel; anything else waits; an escape sequence is refused outright", () => {
    expect(structuredSignInPrompt("antigravity", AGY_SCREEN)).toEqual({ phase: "code", url: HREF });
    expect(structuredSignInPrompt("antigravity", `Open this link in a browser to log in with Google:\n\n  ${AGY_URL}\n`)).toEqual({ phase: "authorization", url: HREF, code: null });
    expect(structuredSignInPrompt("antigravity", `${AGY_SCREEN}\n${WRONG}\n`)).toEqual({ phase: "failed", reason: "provider_rejected" });
    expect(structuredSignInPrompt("antigravity", `${AGY_SCREEN}\n${CANCELLED}\n`)).toEqual({ phase: "failed", reason: "cancelled" });
    expect(structuredSignInPrompt("antigravity", "Loading…")).toEqual({ phase: "waiting" });
    expect(structuredSignInPrompt("antigravity", "")).toEqual({ phase: "waiting" });
    expect(structuredSignInPrompt("antigravity", `\x1b[31m${AGY_SCREEN}`)).toEqual({ phase: "failed", reason: "unsupported_prompt" });
    // The prompt without a usable link still asks for the code, with no link to offer.
    expect(structuredSignInPrompt("antigravity", AGY_SCREEN.replace("https://accounts.google.com", "https://example.com"))).toEqual({ phase: "code", url: null });
    // No screen of agy's ever reads as "success": that is the exit code and `agy models`.
    for (const word of ["Login successful", "Logged in as ada@example.com", "Successfully logged in", "? for shortcuts"]) expect(structuredSignInPrompt("antigravity", `${AGY_SCREEN}${word}\n`).phase, word).toBe("authorization");
    expect(structuredSignInPrompt("antigravity", AGY_SCREEN.replace("Then paste", "Then paste")).phase).toBe("code");
  });
});

describe("the code a sign-in takes", () => {
  it("is a code's characters only: a pasted page address, a second line or a control byte is refused (on the Runtime's side as on the host's)", () => {
    expect(checkedSignInInput(`${AGY_CODE}\r`)).toBe(AGY_CODE);
    expect(checkedSignInInput(`\x15${AGY_CODE}\r`)).toBe(AGY_CODE);
    for (const bad of ["https://antigravity.google/oauth-callback?code=4/0A&scope=x", "4/0A code", `${AGY_CODE}\nrm -rf /`, `${AGY_CODE}\x1b[A`, "", "\r", "é", "a".repeat(5000)]) expect(() => checkedSignInInput(bad), JSON.stringify(bad.slice(0, 30))).toThrow("That is not a sign-in code");
  });
});

describe("the host's driver", () => {
  const AGY_PANE = AGY_SCREEN;
  function harness(options: { checkAuth?: "valid" | "invalid" | "unknown" } = {}) {
    const owner = {}, state = { pane: AGY_PANE, alive: true, exitCode: undefined as number | undefined, current: true };
    const transport = {
      start: vi.fn<StructuredSignInTransport["start"]>().mockResolvedValue(undefined), capture: vi.fn(async () => state.pane),
      status: vi.fn(async () => ({ alive: state.alive, ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}) })),
      write: vi.fn<StructuredSignInTransport["write"]>().mockResolvedValue(undefined), close: vi.fn<StructuredSignInTransport["close"]>().mockResolvedValue(undefined),
    };
    const checkAuth = vi.fn(async () => options.checkAuth ?? "invalid" as "valid" | "invalid" | "unknown");
    const session = new StructuredSignIn("antigravity", owner, { transport, lock: new LoginWindowLock(), current: () => state.current, checkAuth, now: () => Date.now() });
    return { owner, state, transport, checkAuth, session, view: () => session.view(owner),
      act: (value: string, revision = session.view(owner).revision) => session.action(owner, session.id, revision, { kind: "code", value }) };
  }
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("launches exactly `agy acp --login`, with no profile and no logout, even for a confirmed re-login", async () => {
    const h = harness({ checkAuth: "valid" });
    await h.session.start(true);
    expect(h.transport.start).toHaveBeenCalledTimes(1);
    expect(h.transport.start.mock.calls[0]![0]).toEqual({ argv: ["agy", "acp", "--login"] });
    expect(h.transport.start.mock.calls[0]![0].argv).toEqual(["agy", "acp", "--login"]);
    await h.session.cancel();
  });
  it("a login that is already valid is reused without starting anything (the page's 'Sign in again' is the explicit re-login)", async () => {
    const h = harness({ checkAuth: "valid" });
    await h.session.start(false);
    expect(h.transport.start).not.toHaveBeenCalled(); expect(h.view()).toMatchObject({ phase: "done" });
  });
  it("shows the link and the code box, takes one code, and writes it as typed (a line), once", async () => {
    const h = harness();
    await h.session.start();
    expect(h.view()).toMatchObject({ backend: "antigravity", phase: "code", url: HREF, canAct: true });
    expect(await h.act(AGY_CODE)).toBe("accepted");
    expect(h.transport.write.mock.calls[0]![0]).toBe(`${AGY_CODE}\r`);
    expect(await h.act(AGY_CODE)).toBe("stale"); expect(h.transport.write).toHaveBeenCalledTimes(1);
    await h.session.cancel();
  });
  it("refuses a pasted page address, a space or a control byte as the code (nothing is written)", async () => {
    const h = harness();
    await h.session.start();
    for (const bad of ["https://antigravity.google/oauth-callback?code=4/0A&scope=x", "4/0A 1", "a\nb", "\x1b[A", ""]) expect(await h.act(bad), JSON.stringify(bad)).toBe("invalid");
    expect(h.transport.write).not.toHaveBeenCalled();
    await h.session.cancel();
  });
  it("signed in = the command ended with exit 0 AND `agy models` works", async () => {
    const h = harness();
    await h.session.start(); await h.act(AGY_CODE);
    h.state.alive = false; h.state.exitCode = 0; h.checkAuth.mockResolvedValue("valid");
    await h.session.poll();
    expect(h.view()).toMatchObject({ phase: "done" }); expect(h.view().reason).toBeUndefined(); expect(h.transport.close).toHaveBeenCalled();
  });
  it("exit 0 without a working `agy models` is not signed in", async () => {
    const h = harness();
    await h.session.start(); await h.act(AGY_CODE);
    h.state.alive = false; h.state.exitCode = 0;
    await h.session.poll();
    expect(h.view()).toMatchObject({ phase: "failed", reason: "auth_unconfirmed" });
  });
  it("a command that ended with a failure is never 'signed in' because an older login is still there", async () => {
    const h = harness({ checkAuth: "valid" });
    await h.session.start(true); await h.act(AGY_CODE);
    const asked = h.checkAuth.mock.calls.length;
    h.state.alive = false; h.state.exitCode = 1; h.state.pane = `${AGY_PANE}\nsomething the reducer does not know\n`;
    await h.session.poll();
    expect(h.view()).toMatchObject({ phase: "failed", reason: "auth_unconfirmed" }); expect(h.checkAuth.mock.calls.length).toBe(asked);
  });
  it("a command that ended with no exit code at all (a signal, a closed window, a pane status that could not be read) is not 'signed in' either, even when an older login passes `agy models`", async () => {
    const h = harness({ checkAuth: "valid" });
    await h.session.start(true); await h.act(AGY_CODE);
    const asked = h.checkAuth.mock.calls.length;
    h.state.alive = false; h.state.exitCode = undefined;
    await h.session.poll();
    expect(h.view()).toMatchObject({ phase: "failed", reason: "auth_unconfirmed" }); expect(h.checkAuth.mock.calls.length).toBe(asked); expect(h.transport.close).toHaveBeenCalled();
  });
  it("while the command still runs nothing is checked, whatever the screen says: it ends by its exit code only", async () => {
    const h = harness({ checkAuth: "valid" });
    await h.session.start(true); await h.act(AGY_CODE);
    const asked = h.checkAuth.mock.calls.length;
    h.state.pane = `${AGY_PANE}\nLogin successful\n`;                 // not a line agy has been seen to print, and not one the reducer reads: even a success-looking line is no end
    await h.session.poll();
    expect(h.view().phase).not.toBe("done"); expect(h.view().phase).not.toBe("failed"); expect(h.checkAuth.mock.calls.length).toBe(asked);
    await h.session.cancel();
  });
  it("a code the provider refuses ends the attempt as the provider's refusal and reaps the process", async () => {
    const h = harness();
    await h.session.start(); await h.act(AGY_CODE);
    h.state.pane = `${AGY_PANE}\n${WRONG}\n`; h.state.alive = false; h.state.exitCode = 1;
    await h.session.poll();
    expect(h.view()).toMatchObject({ phase: "failed", reason: "provider_rejected" }); expect(h.transport.close).toHaveBeenCalledTimes(1);
  });
  it("cancel ends it and closes the transport (no process is left)", async () => {
    const h = harness();
    await h.session.start();
    await h.session.cancel();
    expect(h.view()).toMatchObject({ phase: "failed", reason: "cancelled" }); expect(h.transport.close).toHaveBeenCalledTimes(1);
  });
});

describe("what the Runtime runs for Antigravity", () => {
  const signIn = (cli: "antigravity" | "claude-code" = "antigravity") => {
    const children: FakeChild[] = [], spawned: Array<{ command: string; args: readonly string[]; options: any }> = [];
    const attempt = new RuntimeSignIn({ command: "C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe", args: [], env: { PATH: "p", USERPROFILE: "C:\\Users\\me" }, method: "subscription", cli }, {
      scratchRoot: scratch(), spawn: (command, args, options) => { spawned.push({ command, args, options }); const child = new FakeChild(); children.push(child); return child as never; } });
    return { attempt, child: children[0]!, spawned: spawned[0]! };
  };
  it("reports an exit code only when the command gave one: a signal or a failure to start is `{ alive: false }` alone, so the server cannot take it for exit 0", () => {
    const killed = signIn(); killed.child.emit("close", null, "SIGKILL");
    expect(killed.attempt.status()).toEqual({ alive: false });
    const clean = signIn(); clean.child.end(0);
    expect(clean.attempt.status()).toEqual({ alive: false, exitCode: 0 });
    const failed = signIn(); failed.child.end(1);
    expect(failed.attempt.status()).toEqual({ alive: false, exitCode: 1 });
  });
  it("builds the command itself: `agy.exe acp --login`, pipes (no terminal), no shell, no browser, in a scratch folder — and no Claude flag", () => {
    const { attempt, spawned } = signIn();
    expect(spawned.args).toEqual(["acp", "--login"]); expect(spawned.options).toMatchObject({ shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    expect(spawned.options.env).toMatchObject({ BROWSER: "true", PATH: "p" }); expect(spawned.options.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(spawned.options.cwd).toMatch(/agend-signin-/);
    void attempt.close();
    expect(signIn("claude-code").spawned.args).toEqual(["auth", "login", "--claudeai"]);
  });
  it("shows only the reduced screen, and takes one code, only while the prompt is the last line, written as a line", async () => {
    const { attempt, child } = signIn();
    expect(attempt.capture()).toBe("");
    expect(() => attempt.assertWritable(AGY_CODE)).toThrow(/not asking for a code/);
    child.say(`Open this link in a browser to log in with Google:\n\n  ${AGY_URL}\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n`);
    expect(attempt.capture()).toBe(`${REDUCED_AGY_URL_PREFIX}${HREF}\n${REDUCED_AGY_CODE_PROMPT}\n`);
    for (const bad of ["https://antigravity.google/oauth-callback?code=4/0A", "a b", "\x1b[A", ""]) expect(() => attempt.assertWritable(bad)).toThrow("That is not a sign-in code");
    await attempt.write(`\x15${AGY_CODE}\r`);
    expect(child.written).toBe(`${AGY_CODE}\n`);
    await expect(attempt.write(AGY_CODE)).rejects.toThrow(/takes one code/);
    child.say(`\n${WRONG}\n`);
    expect(attempt.capture()).toBe(`${REDUCED_AGY_REJECTED}\n`);
    child.end(1);
    expect(attempt.status()).toEqual({ alive: false, exitCode: 1 });
    await attempt.close();
  });
  it("a sign-in nobody answers ends and leaves no child: close kills exactly its own process and says so only when it is gone", async () => {
    const { attempt, child } = signIn();
    expect(attempt.status()).toEqual({ alive: true });
    await attempt.close();
    expect(child.killed).toBe(true); expect(attempt.live).toBe(false);
  });
});

describe("the closed table the server maps a launch through", () => {
  it("has exactly the two sign-ins, and `agy acp --login` is the host's command too", () => {
    expect(RUNTIME_SIGNIN_CLIS).toEqual({ "claude-code": ["claude", "auth", "login"], antigravity: ["agy", "acp", "--login"] });
    expect(Object.isFrozen(RUNTIME_SIGNIN_CLIS)).toBe(true);
    expect(["agy", "acp", "--login"]).toEqual(RUNTIME_SIGNIN_CLIS.antigravity);
  });
  it("the chat flow is unchanged: /login agy stays declined, and the flow keeps its own probe", () => {
    expect(LOGIN_FLOWS.antigravity.remoteLogin).toBe("unsupported");
    expect(LOGIN_FLOWS.antigravity.authCheck).toEqual({ argv: ["agy", "models"], signedOutPattern: /\bplease sign in\b/i });   // the command is unchanged; the pattern is only read by the isolation proof (checkAuthSignedOut)
  });
  const make = () => {
    const calls: Array<{ operation: string; payload: any }> = [];
    const call: AccountCaller = async (_id, operation, payload) => { calls.push({ operation, payload: structuredClone(payload) }); return operation === "signin.start" ? { sessionId: "a".repeat(32) } : { screen: AGY_SCREEN, alive: true, accepted: true }; };
    return { calls, transport: createRuntimeSignInTransport({ machineId: ID, actor: ACTOR, call }), withProfile: createRuntimeSignInTransport({ machineId: ID, profile: "work", actor: ACTOR, call }) };
  };
  it("asks the Runtime for `{cli, method, actor}` — no profile, argv, path or environment — and refuses a profile, a logout or another command for it", async () => {
    const { calls, transport, withProfile } = make();
    await transport.start({ argv: ["agy", "acp", "--login"] }, new AbortController().signal);
    expect(calls).toEqual([{ operation: "signin.start", payload: { cli: "antigravity", method: "subscription", actor: ACTOR } }]);
    for (const [bad, t] of [[{ argv: ["agy", "acp", "--login"], profile: "work" }, transport], [{ argv: ["agy", "acp", "--login"] }, withProfile], [{ argv: ["agy"] }, transport], [{ argv: ["agy", "acp", "--login", "--x"] }, transport],
      [{ argv: ["agy", "acp", "--login"], logoutArgv: ["agy", "logout"] }, transport]] as const) {
      const n = calls.length;
      await expect(t.start(bad as never, new AbortController().signal), JSON.stringify(bad)).rejects.toThrow("signin_unsupported"); expect(calls.length).toBe(n);
    }
  });
  it("reads the screen through Antigravity's table (a Claude-looking screen from that Runtime shows nothing), and writes only a code", async () => {
    const { calls, transport } = make();
    await transport.start({ argv: ["agy", "acp", "--login"] }, new AbortController().signal);
    expect(await transport.capture()).toBe(`${REDUCED_AGY_URL_PREFIX}${HREF}\n${REDUCED_AGY_CODE_PROMPT}\n`);
    await transport.write(`${AGY_CODE}\r`, new AbortController().signal);
    expect(calls.at(-1)).toEqual({ operation: "signin.write", payload: { sessionId: "a".repeat(32), input: `\x15${AGY_CODE}\r` } });
    await expect(transport.write("https://antigravity.google/oauth-callback?code=x", new AbortController().signal)).rejects.toThrow("signin_input");
  });
  it("its status is `agy models` by exit code asked of that computer, as `{cli}` only: signed in, signed out or unknown, and never anything else", async () => {
    const seen: any[] = [];
    const answer = (reply: unknown): AccountCaller => async (_id, operation, payload) => { seen.push({ operation, payload }); if (reply instanceof Error) throw reply; return reply; };
    expect(await runtimeDefaultLoginStatus(answer({ loggedIn: true }), ID, "antigravity")).toEqual({ state: "valid" });
    expect(await runtimeDefaultLoginStatus(answer({ loggedIn: false }), ID, "antigravity")).toEqual({ state: "invalid" });
    expect(await runtimeDefaultLoginStatus(answer({ loggedIn: null }), ID, "antigravity")).toEqual({ state: "unknown" });
    expect(await runtimeDefaultLoginStatus(answer({ loggedIn: "yes" }), ID, "antigravity")).toEqual({ state: "unknown" });
    expect(await runtimeDefaultLoginStatus(answer("ok"), ID, "antigravity")).toEqual({ state: "unknown" });
    expect(await runtimeDefaultLoginStatus(answer(new Error("That computer did not answer in time")), ID, "antigravity")).toEqual({ state: "unknown" });
    expect(seen.every(s => s.operation === "accounts.check" && JSON.stringify(s.payload) === '{"cli":"antigravity"}')).toBe(true);
  });
});

describe("the request's closed shape", () => {
  it("the profile may be left out of a sign-in start and of a status check, and of nothing else; leaving it out is not the same as setting it to something", () => {
    expect(parseRuntimeRemotePayload("signin.start", { cli: "antigravity", method: "subscription", actor: ACTOR })).toEqual({ cli: "antigravity", method: "subscription", actor: ACTOR });
    expect(parseRuntimeRemotePayload("signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor: ACTOR })).toMatchObject({ profile: "work" });
    expect(parseRuntimeRemotePayload("accounts.check", { cli: "antigravity" })).toEqual({ cli: "antigravity" });
    for (const bad of [{ cli: "antigravity", profile: undefined, method: "subscription", actor: ACTOR }, { cli: "antigravity", profile: 5, method: "subscription", actor: ACTOR },
      { cli: "antigravity", profile: "a/b", method: "subscription", actor: ACTOR }, { cli: "antigravity", method: "subscription" }, { cli: "antigravity", actor: ACTOR }, { cli: "antigravity", method: "subscription", actor: ACTOR, argv: ["agy"] }]) {
      expect(() => parseRuntimeRemotePayload("signin.start", bad as never), JSON.stringify(bad)).toThrow(/Invalid signin.start request/);
    }
    expect(() => parseRuntimeRemotePayload("accounts.check", { cli: "antigravity", profile: undefined } as never)).toThrow(/profile/);
    // AGEND-124: a sign-out may leave the profile out (the computer's own login); a remove never.
    expect(parseRuntimeRemotePayload("accounts.signout", { cli: "antigravity", actor: ACTOR })).toEqual({ cli: "antigravity", actor: ACTOR });
    expect(() => parseRuntimeRemotePayload("accounts.signout", { cli: "antigravity", profile: undefined, actor: ACTOR } as never)).toThrow(/profile/);
    expect(() => parseRuntimeRemotePayload("accounts.remove", { cli: "antigravity", actor: ACTOR } as never)).toThrow(/profile/);
  });
});

describe("the computer's own Antigravity login, end to end against the Runtime's side", () => {
  const readAudit = (f: ReturnType<typeof runtimeRig>) => (existsSync(join(f.pairing, AUDIT_FILE)) ? readFileSync(join(f.pairing, AUDIT_FILE), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []);

  it("signs in the computer's own login: the link, one code, exit 0 and `agy models` — with no profile anywhere, none created, and the Runtime's own command", async () => {
    const f = runtimeRig({ agy: true });
    await f.signIns.begin(f.owner, f.agyTarget);
    await waitFor(() => expect(f.agyPhase()).toBe("code"));
    expect(f.agyView()).toMatchObject({ backend: "antigravity", mine: true, url: HREF, canAct: true });
    expect(f.spawned).toHaveLength(1); expect(f.spawned[0]!.args).toEqual(["acp", "--login"]);
    expect(f.spawned[0]!.env?.BROWSER).toBe("true"); expect(f.spawned[0]!.env?.CLAUDE_CONFIG_DIR).toBeUndefined(); expect(f.spawned[0]!.env).toEqual({ PATH: "p", BROWSER: "true" });
    expect(f.sent.find(s => s.operation === "signin.start")!.payload).toEqual({ cli: "antigravity", method: "subscription", actor: ACTOR });
    // Nothing of a profile: no folder for Antigravity, nothing recorded as created.
    expect(existsSync(join(f.root, "antigravity"))).toBe(false); expect(existsSync(join(f.root, "created.json"))).toBe(false);
    const v = f.agyView()!;
    await f.signIns.input(f.owner, f.agyTarget, v.id, v.revision, { kind: "code", value: AGY_CODE });
    expect(f.children[0]!.written).toBe(`${AGY_CODE}\n`);
    f.agyAnswer(true); f.children[0]!.end(0);                       // agy printed nothing we know: the exit code and `agy models` are the answer
    await waitFor(() => expect(f.agyPhase()).toBe("done"));
    expect(f.signIns.snapshot(f.owner, f.agyTarget)).toMatchObject({ selected: ["antigravity"], pending: [], states: { antigravity: "valid" }, ready: true, target: { machine: ID, backend: "antigravity" } });
    expect(f.signIns.snapshot(f.owner, f.agyTarget).target).not.toHaveProperty("profile");
    expect(f.events.at(-1)).toMatchObject({ machine: ID, backend: "antigravity", phase: "done", launched: true, mine: true }); expect(f.events.at(-1)).not.toHaveProperty("profile");
    // Every frame the server sent is `{cli, ...}` without a profile; the status check is `{cli}`.
    expect(f.sent.filter(s => s.operation === "accounts.check").map(s => s.payload)).toEqual([{ cli: "antigravity" }, { cli: "antigravity" }]);
    expect(JSON.stringify(f.sent.filter(s => s.operation !== "signin.write"))).not.toMatch(/profile|argv|command|acp|agy\.exe/);
    expect(f.signIns.busy(ID)).toBe(false);
    // The Runtime recorded it: who, which CLI, no profile; never the link or the code.
    expect(readAudit(f).filter(r => r.action === "signin").map(r => [r.outcome, r.cli, "profile" in r])).toEqual([["started", "antigravity", false], ["ok", "antigravity", false]]);
    expect(readAudit(f).filter(r => r.action === "signin.write").map(r => [r.outcome, r.cli])).toEqual([["started", "antigravity"], ["ok", "antigravity"]]);
    expect(JSON.stringify(readAudit(f))).not.toMatch(new RegExp(`${AGY_CODE}|accounts.google|STATE-NEVER-LOGGED`));
    await f.stop();
  });
  it("a wrong code is reported as the provider's refusal and leaves no `agy` behind", async () => {
    const f = runtimeRig({ agy: true });
    await f.signIns.begin(f.owner, f.agyTarget);
    await waitFor(() => expect(f.agyPhase()).toBe("code"));
    const v = f.agyView()!; await f.signIns.input(f.owner, f.agyTarget, v.id, v.revision, { kind: "code", value: "bogus-code" });
    f.children[0]!.say(`\n${WRONG}\n`); f.children[0]!.end(1);
    await waitFor(() => expect(f.agyView()).toMatchObject({ phase: "failed", reason: "provider_rejected" }));
    expect(f.signIns.busy(ID)).toBe(false); expect(JSON.stringify([f.events, f.replies, f.sent])).not.toMatch(/invalid_grant|Malformed/);
    expect(readAudit(f).filter(r => r.action === "signin").map(r => r.outcome)).toEqual(["started", "failed"]);
    await f.stop();
  });
  it("cancelling before any code ends exactly that process (the Runtime's own child, by its handle) and frees the computer", async () => {
    const f = runtimeRig({ agy: true });
    await f.signIns.begin(f.owner, f.agyTarget);
    await waitFor(() => expect(f.agyPhase()).toBe("code"));
    const snapshot = await f.signIns.cancel(f.owner, f.agyTarget);
    expect(snapshot.login).toMatchObject({ phase: "failed", reason: "cancelled" });
    expect(f.children[0]!.killed).toBe(true); expect(f.signIns.busy(ID)).toBe(false); expect(f.runtime.signInProfile()).toBeUndefined();
    expect(f.sent.map(s => s.operation)).toContain("signin.close");
    await f.stop();
  });
  it("a command that ended with a failure is not a sign-in, whatever `agy models` says about an older login; exit 0 without a working login is not one either", async () => {
    const failed = runtimeRig({ agy: true });
    failed.agyAnswer(true);                                          // an older login is there, so the confirmed re-login is what starts it
    await failed.signIns.begin(failed.owner, failed.agyTarget, true);
    await waitFor(() => expect(failed.agyPhase()).toBe("code"));
    const v = failed.agyView()!; await failed.signIns.input(failed.owner, failed.agyTarget, v.id, v.revision, { kind: "code", value: AGY_CODE });
    failed.children[0]!.end(1);
    await waitFor(() => expect(failed.agyView()).toMatchObject({ phase: "failed", reason: "auth_unconfirmed" }));
    await failed.stop();
    const empty = runtimeRig({ agy: true });
    await empty.signIns.begin(empty.owner, empty.agyTarget);
    await waitFor(() => expect(empty.agyPhase()).toBe("code"));
    const w = empty.agyView()!; await empty.signIns.input(empty.owner, empty.agyTarget, w.id, w.revision, { kind: "code", value: AGY_CODE });
    empty.children[0]!.end(0);                                       // exit 0, but `agy models` still says signed out
    await waitFor(() => expect(empty.agyView()).toMatchObject({ phase: "failed", reason: "auth_unconfirmed" }));
    await empty.stop();
  });
  it("a command the system ended without an exit code (killed by a signal, or closed) is not a sign-in either, even though `agy models` passes on an older login", async () => {
    const f = runtimeRig({ agy: true });
    f.agyAnswer(true);                                               // an older login is there, so the confirmed re-login is what starts it
    await f.signIns.begin(f.owner, f.agyTarget, true);
    await waitFor(() => expect(f.agyPhase()).toBe("code"));
    const v = f.agyView()!; await f.signIns.input(f.owner, f.agyTarget, v.id, v.revision, { kind: "code", value: AGY_CODE });
    const asked = f.sent.filter(s => s.operation === "accounts.check").length;
    f.children[0]!.emit("close", null, "SIGKILL");                   // the Runtime's own child, ended by a signal: Node gives no code
    await waitFor(() => expect(f.agyView()).toMatchObject({ phase: "failed", reason: "auth_unconfirmed" }));
    expect(f.sent.filter(s => s.operation === "accounts.check").length).toBe(asked);   // the older login was never asked about
    expect(f.signIns.busy(ID)).toBe(false);
    await f.stop();
  });
  it("a check of the computer's own login that said yes or no is kept in the Runtime's inventory and re-sent before the answer; \"could not be asked\" changes nothing", async () => {
    const noted: Array<[string, boolean]> = [], order: string[] = [];
    const f = runtimeRig({ agy: true, noteLogin: (cli, loggedIn) => { noted.push([cli, loggedIn]); order.push("noted"); }, changed: () => { order.push("reported"); } });
    f.agyAnswer(true);
    expect(await f.call(ID, "accounts.check", { cli: "antigravity" })).toEqual({ loggedIn: true });
    expect(noted).toEqual([["antigravity", true]]); expect(order).toEqual(["noted", "reported"]);   // the inventory carries it before the answer leaves
    f.agyAnswer(false);
    expect(await f.call(ID, "accounts.check", { cli: "antigravity" })).toEqual({ loggedIn: false });
    expect(noted).toEqual([["antigravity", true], ["antigravity", false]]);
    f.agyAnswer(null);
    const before = [noted.length, order.length];
    expect(await f.call(ID, "accounts.check", { cli: "antigravity" })).toEqual({ loggedIn: null });
    expect([noted.length, order.length]).toEqual(before);
    await f.stop();
  });
  it("is refused with a reason before anything starts: the owner's switch off, an older Runtime, an offline computer — and by the Runtime itself, whatever the server asked", async () => {
    const off = runtimeRig({ agy: true, switchOn: false });
    await expect(off.signIns.begin(off.owner, off.agyTarget)).rejects.toThrow("machine_accounts_off"); expect(off.spawned).toHaveLength(0);
    // A request that skips the dashboard's check meets the Runtime's own switch.
    await expect(off.call(ID, "signin.start", { cli: "antigravity", method: "subscription", actor: ACTOR })).rejects.toThrow(/turned off.*agend-runtime remote-setup accounts on/);
    await expect(off.call(ID, "accounts.check", { cli: "antigravity" })).rejects.toThrow(/turned off/);
    expect(off.spawned).toHaveLength(0);
    expect(readAudit(off).filter(r => r.cli === "antigravity").map(r => [r.action, r.outcome, r.reason])).toEqual([["signin", "refused", "switch_off"]]);
    const old = runtimeRig({ agy: { capability: false } });
    await expect(old.signIns.begin(old.owner, old.agyTarget)).rejects.toThrow("machine_unsupported"); expect(old.spawned).toHaveLength(0);
  });
  it("the exception is Antigravity's alone: every other CLI still needs a profile this Runtime created, and a profile or Console method is refused for Antigravity", async () => {
    const f = runtimeRig({ agy: true, created: ["work"] });
    const refused = async (operation: string, payload: Record<string, unknown>, pattern: RegExp) => {
      const spawnedBefore = f.spawned.length;
      await expect(f.runtime.handle(operation, payload), `${operation} ${JSON.stringify(payload)}`).rejects.toThrow(pattern); expect(f.spawned.length).toBe(spawnedBefore);
    };
    await refused("signin.start", { cli: "claude-code", method: "subscription", actor: ACTOR }, /names the credential profile/);
    await refused("signin.start", { cli: "codex", method: "subscription", actor: ACTOR }, /Only Claude Code and Antigravity accounts/);
    await refused("signin.start", { cli: "kiro-cli", method: "subscription", actor: ACTOR }, /Only Claude Code and Antigravity accounts/);
    await refused("signin.start", { cli: "codex", profile: "work", method: "subscription", actor: ACTOR }, /Only Claude Code and Antigravity accounts/);
    // AGEND-124: a named Antigravity account is possible, and refused here only because this Runtime cannot prove the folder keeps its own sign-in (no probe was given).
    await refused("signin.start", { cli: "antigravity", profile: "work", method: "subscription", actor: ACTOR }, /could not be shown to keep this account's sign-in in its own folder/);
    await refused("signin.start", { cli: "antigravity", method: "console", actor: ACTOR }, /Only a subscription sign-in/);
    await refused("signin.start", { cli: "antigravity", method: "subscription", actor: "a b" }, /./);
    await refused("accounts.check", { cli: "claude-code" }, /names the credential profile/);
    await refused("accounts.check", { cli: "codex" }, /Only Claude Code and Antigravity accounts/);
    // A named account of it is this Runtime's own to check, sign out and remove (AGEND-124): one it never created is refused like any other.
    await refused("accounts.check", { cli: "antigravity", profile: "work" }, /does not exist on this computer/);
    await refused("accounts.signout", { cli: "antigravity", profile: "work", actor: ACTOR }, /does not exist on this computer/);
    await refused("accounts.remove", { cli: "antigravity", profile: "work", actor: ACTOR }, /does not exist on this computer/);
    expect(existsSync(join(f.root, "claude-code", "work"))).toBe(true); expect(readdirSync(join(f.root))).not.toContain("antigravity");
    await f.stop();
  });
  it("one sign-in at a time on the computer and at least five seconds between starts, enforced by the Runtime", async () => {
    const f = runtimeRig({ agy: true, created: ["work"] });
    const start = (cli: "antigravity" | "claude-code") => f.runtime.handle("signin.start", cli === "antigravity" ? { cli, method: "subscription", actor: ACTOR } : { cli, profile: "work", method: "subscription", actor: ACTOR });
    const first = await start("antigravity") as { sessionId: string };
    await expect(start("antigravity")).rejects.toThrow(/Another sign-in/);
    await expect(start("claude-code")).rejects.toThrow(/Another sign-in/);
    expect(f.spawned).toHaveLength(1);
    await f.runtime.handle("signin.close", { sessionId: first.sessionId });
    await expect(start("antigravity")).rejects.toThrow(/too quickly/);   // the pace of starts, not the slot
    f.tick(6_000); await start("antigravity"); expect(f.spawned).toHaveLength(2);
    await f.stop();
  });
  it("ends at the ten-minute limit and when the owner turns the switch off, and says so in the record", async () => {
    const f = runtimeRig({ agy: true });
    const { sessionId } = await f.runtime.handle("signin.start", { cli: "antigravity", method: "subscription", actor: ACTOR }) as { sessionId: string };
    const { setRemoteSwitch } = await import("../src/runtime-remote-setup.js");
    setRemoteSwitch(f.pairing, "accounts", false, undefined, Date.now());
    await expect(f.runtime.handle("signin.capture", { sessionId })).rejects.toThrow(/turned off/);
    expect(f.children[0]!.killed).toBe(true);
    expect(readAudit(f).at(-1)).toMatchObject({ action: "signin", cli: "antigravity", outcome: "failed", reason: "switch_off" });
    await f.stop();
  });
  it("the page's state after a sign-in is the new login until that computer's next inventory, and `agy` is never asked to answer a read", async () => {
    const f = runtimeRig({ agy: true });
    expect(f.accounts.reportedDefault(ID, "antigravity")).toBe("unknown");
    f.accounts.noteDefaultLogin(ID, "antigravity", true);
    expect(f.accounts.reportedDefault(ID, "antigravity")).toBe("valid");
    f.report([]);                                                    // a newer inventory is the truth again
    expect(f.accounts.reportedDefault(ID, "antigravity")).toBe("unknown");
    f.accounts.noteDefaultLogin(ID, "claude-code", true); expect(f.accounts.reportedDefault(ID, "antigravity")).toBe("unknown");
    expect(f.sent).toEqual([]);                                      // nothing was sent to the computer for any of it
    await f.stop();
  });
});

describe("the Accounts rows for a computer's Antigravity login", () => {
  const view = async (f: ReturnType<typeof runtimeRig>) => buildAccountsView({ targets: [], diskProfiles: new Map(), agents: [], classic: [], fleetDefaults: new Map(), machines: await f.accounts.list() });
  const rowsOf = (v: ReturnType<typeof buildAccountsView>) => v.clis.find(c => c.backend === "antigravity")?.rows ?? [];
  it("is one row under the computer's name, that can be signed in and out, with no profiles yet", async () => {
    const f = runtimeRig({ agy: true });
    const v = await view(f), cli = v.clis.find(c => c.backend === "antigravity")!;
    // AGEND-119: the HOST has named accounts of Antigravity (+ Add account on the card), a paired Windows computer does not: it has the one row for the computer's own login.
    // AGEND-124: a computer has named accounts too (+ Add account under its name) and its own login can be signed out; with none yet, the card has the one row for the computer's own login.
    expect([cli.profiles, cli.machineProfiles]).toEqual([true, true]);
    expect(cli.rows).toEqual([{ scope: { kind: "machine", id: ID, name: "Desk PC", online: true, namedAccounts: true }, backend: "antigravity", profile: null, state: "unknown", signIn: true, signOutOwn: true, usedBy: { agents: [], classic: [], fleetDefault: false } }]);
    expect(JSON.stringify(v)).not.toMatch(/identity|email/i);
    await f.stop();
  });
  it("shows the last detection's state (signed in / signed out / not checked), and a login just made from here", async () => {
    const yes = runtimeRig({ agy: { authenticated: true } }), no = runtimeRig({ agy: { authenticated: false } });
    expect(rowsOf(await view(yes))[0]).toMatchObject({ state: "usable", signIn: true }); expect(rowsOf(await view(no))[0]).toMatchObject({ state: "not_signed_in", signIn: true });
    no.accounts.noteDefaultLogin(ID, "antigravity", true);
    expect(rowsOf(await view(no))[0]).toMatchObject({ state: "usable" });
    await yes.stop(); await no.stop();
  });
  it("cannot be signed in where the computer says no: an agy older than 1.5.0, an older Runtime, the owner's switch off — each with its code", async () => {
    expect(rowsOf(await view(runtimeRig({ agy: { version: "1.4.9" } })))[0]).toMatchObject({ signIn: false, scope: { readOnlyReason: "cli_old" } });
    expect(rowsOf(await view(runtimeRig({ agy: { version: "1.5.0" } })))[0]).toMatchObject({ signIn: true });
    expect(rowsOf(await view(runtimeRig({ agy: { capability: false } })))[0]).toMatchObject({ signIn: false, scope: { readOnlyReason: "runtime_old" } });
    expect(rowsOf(await view(runtimeRig({ agy: true, switchOn: false })))[0]).toMatchObject({ signIn: false, scope: { readOnlyReason: "accounts_off" } });
  });
  it("is left out for a computer that has no Antigravity and no agent using it, so the card is not noise on every computer", async () => {
    const f = runtimeRig({});
    expect((await view(f)).clis.find(c => c.backend === "antigravity")).toBeUndefined();
    await f.stop();
  });
  it("agy versions: 1.5.0 and newer can sign in from here; older, unknown or not a version cannot", () => {
    // The oldest agy is the registry's `host.structuredSignIn.minVersion`; a CLI with no minimum takes any version.
    const min = hostFacts("antigravity", "structuredSignIn")!.minVersion;
    expect(min).toBe("1.5.0");
    for (const version of ["1.5.0", "1.5.3", "1.10.0", "2.0.0", "agy 1.5.3"]) expect(versionAtLeast(version, min), version).toBe(true);
    for (const version of ["1.4.9", "1.0.10", "0.9", "", null, undefined, "unknown"]) expect(versionAtLeast(version as never, min), String(version)).toBe(false);
    expect(versionAtLeast(null, undefined)).toBe(true);
  });
});

describe("Windows: Antigravity's own login on that computer", () => {
  const exe = { path: "C:\\agy.exe", command: "C:\\agy.exe", args: [] as string[] };
  it("is `agy models`: exit 0 is signed in; a failing exit that says \"Please sign in\" is signed out; any other failure (offline, DNS, a crash), and a command that could not be run or ran out of time, is unknown (AGEND-250 P2-3)", async () => {
    const seen: string[][] = [];
    const SAID = "Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.";
    const ask = async (code: number | null, text = "") => probeDefaultLogin("antigravity", async () => exe, async (_entry, args) => { seen.push(args); return { code, text }; });
    expect(await ask(0, "gemini-3.1-pro-high")).toBe(true); expect(await ask(0)).toBe(true);
    expect(await ask(1, SAID)).toBe(false); expect(await ask(2, SAID)).toBe(false);
    for (const text of ["", "dial tcp: lookup example.com: no such host", "context deadline exceeded", "panic: runtime error"]) { expect(await ask(1, text), text).toBeNull(); expect(await ask(2, text), text).toBeNull(); }
    expect(await ask(null)).toBeNull(); expect(await ask(null, SAID)).toBeNull();
    expect(seen.every(args => args.join(" ") === "models")).toBe(true);
    expect(await probeDefaultLogin("antigravity", async () => null, async () => ({ code: 0, text: "" }))).toBeNull();     // no agy.exe: not "signed out"
  });
  it("the inventory reads the same listing it already asks for: models = signed in, 'Please sign in' = signed out, any other failure = unknown", async () => {
    const detect = async (listing: { ok: boolean; text: string }) => {
      const result = await probeNativeClis({ find: async id => (id === "antigravity" ? { path: "C:\\agy.exe", command: "C:\\agy.exe", args: [] } : null),
        run: async (_entry, args) => args.includes("--help") ? { ok: true, text: "--input-format stream-json --output-format --conversation" } : args.includes("--version") ? { ok: true, text: "1.5.3" } : listing });
      return result.clis.find(row => row.id === "antigravity")!;
    };
    expect(await detect({ ok: true, text: "gemini-3.1-pro-high  Gemini 3.1 Pro (High)" })).toMatchObject({ authenticated: true, runnable: true });
    expect(await detect({ ok: false, text: "Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in." })).toMatchObject({ authenticated: false, runnable: false });
    expect(await detect({ ok: false, text: "dial tcp: lookup example.com: no such host" })).toMatchObject({ authenticated: null, runnable: true });
    expect(parseNativeAuthResult("antigravity", true, "")).toBeNull();
    expect(parseNativeAuthResult("antigravity", false, "")).toBeNull();
  });
});

describe("the Runtime's cached inventory after a check of the computer's own login", () => {
  const row = (over: Partial<NativeCliRow> = {}): NativeCliRow => ({ id: "antigravity", path: "C:\\agy\\agy.exe", version: "1.5.3", authenticated: null, runnable: true,
    supports: { execution: true, resume: false, model: false, mcp: false }, readOnlySupport: false, permissionNote: "", models: [], ...over } as NativeCliRow);
  const bridgeWith = (clis: NativeCliRow[]) => {
    const file = join(scratch(), "windows-cli-inventory.json");
    writeFileSync(file, JSON.stringify({ clis, home: "C:\\Users\\me", probedAt: 1_700_000_000_000 }));
    const bridge = new WindowsCliBridge(async () => { throw new Error("no worker in this test"); }, file);
    return { bridge, file, saved: () => JSON.parse(readFileSync(file, "utf8")) as { clis: NativeCliRow[]; probedAt: number } };
  };
  it("says yes from now on, in memory and in the file: a report of the cached inventory no longer brings back what was true before the sign-in", async () => {
    const { bridge, saved } = bridgeWith([row(), row({ id: "codex", authenticated: true } as never)]);
    bridge.noteAuthenticated("antigravity", true);
    const probe = await bridge.probe();
    expect(probe.clis.map(r => [r.id, r.authenticated])).toEqual([["antigravity", true], ["codex", true]]);
    expect(probe.probedAt).toBe(1_700_000_000_000);                        // when it was detected is not changed
    expect(saved().clis[0]!.authenticated).toBe(true);                     // a restarted Runtime reads the same
  });
  it("derives what follows from it the way a detection does: signed out is not runnable and says to sign in; yes lifts exactly that reason", async () => {
    const { bridge } = bridgeWith([row({ authenticated: true }), row({ id: "codex", authenticated: false, runnable: false, reason: "Sign in to this Windows CLI before running a task" } as never),
      row({ id: "grok", reason: "Update this Windows CLI", runnable: false, supports: { execution: false } as never } as never)]);
    bridge.noteAuthenticated("antigravity", false);
    bridge.noteAuthenticated("codex", true);
    bridge.noteAuthenticated("grok", true);
    const byId = Object.fromEntries((await bridge.probe()).clis.map(r => [r.id, r]));
    expect(byId.antigravity).toMatchObject({ authenticated: false, runnable: false, reason: "Sign in to this Windows CLI before running a task" });
    expect(byId.codex).toMatchObject({ authenticated: true, runnable: true }); expect(byId.codex).not.toHaveProperty("reason");
    expect(byId.grok).toMatchObject({ authenticated: true, runnable: false, reason: "Update this Windows CLI" });   // another reason stays, and it is still not runnable
  });
  it("changes nothing for a CLI that was never detected, for no cache at all, or for the same answer (and writes no file for them)", async () => {
    const same = bridgeWith([row({ authenticated: true })]);
    const stamp = readFileSync(same.file, "utf8");
    same.bridge.noteAuthenticated("antigravity", true); same.bridge.noteAuthenticated("grok", true);
    expect(readFileSync(same.file, "utf8")).toBe(stamp);
    const neverFile = join(scratch(), "never.json");
    const never = new WindowsCliBridge(async () => { throw new Error("x"); }, neverFile);
    never.noteAuthenticated("antigravity", true);
    expect(existsSync(neverFile)).toBe(false); expect((await never.probe()).clis).toEqual([]);
  });
  it("is the same derivation the probe uses for a row", () => {
    const signedOut = withAuthenticated(row({ authenticated: true }), false);
    expect(signedOut.runnable).toBe(false); expect(withAuthenticated(signedOut, true)).toEqual(row({ authenticated: true }));   // and back, exactly
    expect(withAuthenticated(row({ authenticated: true }), true)).toEqual(row({ authenticated: true }));
  });
});
