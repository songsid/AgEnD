import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOGIN_FLOWS } from "../src/login-flows.js";
import { structuredSignInPrompt } from "../src/structured-signin.js";
import { CLAUDE_LOGIN_ARGV, CLAUDE_LOGIN_METHOD_FLAGS, REDUCED_CODE_PROMPT, REDUCED_INVALID_CODE, REDUCED_REJECTED, REDUCED_SUCCESS, REDUCED_URL_PREFIX, RuntimeSignIn, RuntimeSignInSlot,
  SignInRefusal, checkedSignInInput, reduceClaudeLoginScreen, type SignInDeps } from "../src/runtime-signin.js";

const URL_OK = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&state=abc";
const REAL = `Opening browser to sign in…\nIf the browser didn't open, visit: ${URL_OK}\nPaste code here if prompted >`;   // measured with claude 2.1.319
const directories: string[] = [];
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-signin-test-")); directories.push(path); return path; };
afterEach(() => { vi.useRealTimers(); for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });

class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); pid = 4242; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; killed = false; written = "";
  constructor() { super(); this.stdin.on("data", chunk => { this.written += chunk.toString(); }); }
  say(text: string): void { this.stdout.write(text); }
  end(code: number): void { this.exitCode = code; this.emit("close", code); }
  kill(): boolean { this.killed = true; queueMicrotask(() => { if (this.exitCode === null) this.end(1); }); return true; }
}
function harness(extra: Partial<SignInDeps> = {}) {
  const children: FakeChild[] = [], calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [], root = scratch();
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => { calls.push({ command, args, options }); const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; };
  const make = (method: keyof typeof CLAUDE_LOGIN_METHOD_FLAGS = "subscription") => new RuntimeSignIn({ command: "claude.exe", args: ["--prefix"], env: { CLAUDE_CONFIG_DIR: "C:\\profile", PATH: "p" }, method }, { spawn, scratchRoot: root, ...extra });
  return { children, calls, root, make, child: () => children[0]! };
}

describe("the closed table: what capture() may carry", () => {
  it("is the URL and the code prompt of the real screen, and nothing else", () => {
    expect(reduceClaudeLoginScreen(REAL)).toBe(`${REDUCED_URL_PREFIX}${URL_OK}\n${REDUCED_CODE_PROMPT}\n`);
    expect(reduceClaudeLoginScreen(`Opening browser to sign in…\nIf the browser didn't open, visit: ${URL_OK}\n`)).toBe(`${REDUCED_URL_PREFIX}${URL_OK}\n`);
    expect(reduceClaudeLoginScreen("")).toBe("");
  });
  it("turns a success line that names an account into the fixed success line", () => {
    for (const screen of [`${REAL}\nLogin successful`, `${REAL}\nLogged in as ab@example.com`, `${REAL}\nLogged in as Alice Example <alice@example.com> (Team)\nLogin successful! Welcome back, alice@example.com`]) {
      const reduced = reduceClaudeLoginScreen(screen);
      expect(reduced).toBe(`${REDUCED_SUCCESS}\n`); expect(reduced).not.toMatch(/example|alice|@/);
    }
  });
  it("drops every other line: no output, e-mail, path, token or stack trace passes", () => {
    const noisy = `Welcome alice@example.com\nC:\\Users\\alice\\.claude\\.credentials.json\nsk-ant-oat01-SECRET\nError: ENOENT at C:\\x\\y.js:1\nrefresh_token=abc\n${REAL}`;
    const reduced = reduceClaudeLoginScreen(noisy);
    expect(reduced).toBe(`${REDUCED_URL_PREFIX}${URL_OK}\n${REDUCED_CODE_PROMPT}\n`);
    expect(reduced).not.toMatch(/alice|sk-ant|ENOENT|refresh_token|\\Users/);
  });
  it("drops a URL that is not https, not on an allowed host, carries credentials or is too long; and strips terminal escapes", () => {
    for (const bad of ["http://claude.com/x", "https://evil.example.com/cai/oauth/authorize", "https://claude.com.evil.test/x", "https://user:pw@claude.com/x", "javascript:alert(1)", "ftp://claude.com/x", `https://claude.com/${"a".repeat(5000)}`]) {
      expect(reduceClaudeLoginScreen(`If the browser didn't open, visit: ${bad}\n${REDUCED_CODE_PROMPT}`), bad.slice(0, 40)).toBe(`${REDUCED_CODE_PROMPT}\n`);
    }
    expect(reduceClaudeLoginScreen(`\x1b[2K\x1b[1GIf the browser didn't open, visit: ${URL_OK}\n\x1b[32mPaste code here if prompted >\x1b[0m`)).toBe(`${REDUCED_URL_PREFIX}${URL_OK}\n${REDUCED_CODE_PROMPT}\n`);
  });
  it("shows the prompt only while it is the last line, and an outcome ends the screen", () => {
    expect(reduceClaudeLoginScreen(`${REAL}\nsomething else`)).toBe(`${REDUCED_URL_PREFIX}${URL_OK}\n`);
    expect(reduceClaudeLoginScreen(`${REAL}\nLogin failed: Request failed with status code 400`)).toBe(`${REDUCED_REJECTED}\n`);
    expect(reduceClaudeLoginScreen(`${REAL}\nInvalid code. Please make sure the full code was copied`)).toBe(`${REDUCED_INVALID_CODE}\n`);
  });
  it("is read by the server's own structuredSignInPrompt, unchanged, into the same phases the host path has", () => {
    expect(structuredSignInPrompt("claude-code", reduceClaudeLoginScreen(REAL))).toEqual({ phase: "code", url: URL_OK });
    expect(structuredSignInPrompt("claude-code", reduceClaudeLoginScreen(`If the browser didn't open, visit: ${URL_OK}`))).toEqual({ phase: "authorization", url: URL_OK, code: null });
    expect(structuredSignInPrompt("claude-code", reduceClaudeLoginScreen(`${REAL}\nLogged in as ab@example.com`))).toEqual({ phase: "success" });
    expect(structuredSignInPrompt("claude-code", reduceClaudeLoginScreen(`${REAL}\nLogin failed: Request failed with status code 400`))).toEqual({ phase: "failed", reason: "provider_rejected" });
    expect(structuredSignInPrompt("claude-code", reduceClaudeLoginScreen(`${REAL}\nInvalid code. Please try again`))).toEqual({ phase: "failed", reason: "provider_rejected" });
    expect(structuredSignInPrompt("claude-code", reduceClaudeLoginScreen(""))).toEqual({ phase: "waiting" });
  });
  it("agrees with the host's LOGIN_FLOWS for claude-code: same argv, same success and failure patterns (one definition of the flow)", () => {
    const flow = LOGIN_FLOWS["claude-code"]!;
    expect(["claude", ...CLAUDE_LOGIN_ARGV].join(" ")).toBe(flow.command);
    expect(flow.authCheck!.argv).toEqual(["claude", "auth", "status"]);
    expect(flow.successPattern.test(REDUCED_SUCCESS)).toBe(true);
    expect(flow.failures!.some(failure => failure.pattern.test(REDUCED_REJECTED))).toBe(true);
    expect(flow.loginScreenPattern!.test(REDUCED_CODE_PROMPT)).toBe(true);
  });
});

describe("what the Runtime accepts as input", () => {
  it("takes the driver's code form and nothing else: a code, optionally behind the clear-line byte, ending in the line ending", () => {
    expect(checkedSignInInput("\x15ABCD-efgh_12.3~+/#=\r")).toBe("ABCD-efgh_12.3~+/#=");
    expect(checkedSignInInput("abc123")).toBe("abc123");
    for (const bad of ["", "\x15\r", "\x1b[B\r", "a b", "ab\ncd", "ab\r\ncd\r", "code;rm -rf", "$(x)", "é", "a\x00b", `${"a".repeat(4097)}`, 5, undefined, {}, ["a"], "a`b", "a|b", "a'b", "a\"b", "a\\b"]) {
      expect(() => checkedSignInInput(bad), JSON.stringify(bad)?.slice(0, 40)).toThrow(SignInRefusal);
    }
  });
});

describe("one sign-in attempt", () => {
  it("builds the command itself: the CLI's own program with the fixed arguments, the profile's variable, BROWSER=true, pipes, no shell, a scratch folder", () => {
    const h = harness(); const session = h.make("console");
    expect(h.calls).toHaveLength(1);
    const { command, args, options } = h.calls[0]!;
    expect(command).toBe("claude.exe"); expect(args).toEqual(["--prefix", "auth", "login", "--console"]);
    expect(options.shell).toBe(false); expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]); expect(options.windowsHide).toBe(true);
    expect(options.env).toMatchObject({ CLAUDE_CONFIG_DIR: "C:\\profile", BROWSER: "true" });
    expect(String(options.cwd).startsWith(h.root)).toBe(true); expect(existsSync(String(options.cwd))).toBe(true);
    expect(session.id).toMatch(/^[a-f0-9]{32}$/);
    expect(h.calls[0]!.args.at(-1)).toBe("--console");
    h.make("subscription"); expect(h.calls[1]!.args.at(-1)).toBe("--claudeai");
    void session.close();
  });
  it("shows the reduced screen as the CLI speaks, never the raw output, and keeps a bounded buffer", () => {
    const h = harness(), session = h.make();
    h.child().say("Opening browser to sign in…\nIf the browser didn't open, visit: "); expect(session.capture()).toBe("");
    h.child().say(`${URL_OK}\nPaste code here if prompted >`);
    expect(session.capture()).toBe(`${REDUCED_URL_PREFIX}${URL_OK}\n${REDUCED_CODE_PROMPT}\n`);
    h.child().say(`x`.repeat(200_000) + "\n");
    expect(session.capture()).not.toContain("xxxx");
    void session.close();
  });
  it("writes one code, only while the prompt shows, with the CLI's line ending, and refuses a second", async () => {
    const h = harness(), session = h.make();
    await expect(session.write("\x15ABC\r")).rejects.toThrow(/not asking for a code/);
    h.child().say(REAL);
    await expect(session.write("\x1b[B\r")).rejects.toThrow(/not a sign-in code/);
    await session.write("\x15ABCD-1234\r"); expect(h.child().written).toBe("ABCD-1234\r");
    await expect(session.write("\x15EFGH\r")).rejects.toThrow(/one code/);
    expect(h.child().written).toBe("ABCD-1234\r");
    void session.close();
  });
  it("reports alive and the exit code; a rejected code ends as the host's does", async () => {
    const h = harness(), session = h.make();
    expect(session.status()).toEqual({ alive: true });
    h.child().say(`${REAL}\nLogin failed: Request failed with status code 400\n`); h.child().end(1);
    expect(session.status()).toEqual({ alive: false, exitCode: 1 }); expect(structuredSignInPrompt("claude-code", session.capture())).toEqual({ phase: "failed", reason: "provider_rejected" });
    await session.write("x").then(() => { throw Error("expected refusal"); }, error => expect(error).toBeInstanceOf(SignInRefusal));
    await session.close();
  });
  it("close() kills exactly its own child, removes the scratch folder and answers only when the child is gone; and wipes what it held", async () => {
    const h = harness(), session = h.make(), cwd = String(h.calls[0]!.options.cwd); h.child().say(REAL);
    await session.close();
    expect(h.child().killed).toBe(true); expect(existsSync(cwd)).toBe(false); expect(readdirSync(h.root)).toEqual([]);
    expect(session.capture()).toBe(""); expect(session.live).toBe(false);
    await session.close();   // idempotent
  });
  it("close() says so when the child cannot be shown gone, keeps the slot, and does not remove what may still be written", async () => {
    vi.useFakeTimers();
    const h = harness({ kill: () => {} }), session = h.make(), cwd = String(h.calls[0]!.options.cwd);
    const closing = session.close().catch(error => error); await vi.advanceTimersByTimeAsync(6000);
    expect(await closing).toBeInstanceOf(SignInRefusal); expect(session.live).toBe(true); expect(existsSync(cwd)).toBe(true);
  });
  it("ends itself after ten minutes, whatever the server does", async () => {
    vi.useFakeTimers();
    const h = harness(), session = h.make(); await vi.advanceTimersByTimeAsync(10 * 60_000 + 10);
    expect(h.child().killed).toBe(true); expect(session.live).toBe(false);
  });
  it("hands a timeout to its owner to record when one is given", async () => {
    vi.useFakeTimers(); const onTimeout = vi.fn(); const h = harness({ onTimeout }); h.make(); await vi.advanceTimersByTimeAsync(10 * 60_000 + 10);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
  it("removes its scratch folder when the program cannot be started at all", () => {
    const root = scratch();
    expect(() => new RuntimeSignIn({ command: "x", args: [], env: {}, method: "subscription" }, { scratchRoot: root, spawn: () => { throw new Error("ENOENT C:\\secret\\path"); } })).toThrow();
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("one sign-in at a time on this computer", () => {
  it("refuses a second while one is live, frees the slot when it is closed, and rate-limits starts", async () => {
    let now = 1_000_000; const h = harness(), slot = new RuntimeSignInSlot(() => now);
    const first = await slot.start(() => h.make());
    await expect(slot.start(() => h.make())).rejects.toThrow(/Another sign-in/);
    expect(h.calls).toHaveLength(1);
    expect(slot.find(first.id)).toBe(first);
    await slot.close(first.id);
    await expect(slot.start(() => h.make())).rejects.toThrow(/too quickly/);
    now += 5_000; const second = await slot.start(() => h.make()); await slot.close(second.id);
    for (let i = 0; i < 10; i++) { now += 5_000; await slot.close((await slot.start(() => h.make())).id); }
    now += 5_000; await expect(slot.start(() => h.make())).rejects.toThrow(/Too many sign-ins/);
    now += 3_600_000; await slot.close((await slot.start(() => h.make())).id);
  });
  it("answers only for the live attempt's own id", async () => {
    const h = harness(), slot = new RuntimeSignInSlot(), session = await slot.start(() => h.make());
    for (const bad of [undefined, 5, "", "0".repeat(32), session.id.toUpperCase()]) expect(() => slot.find(bad)).toThrow(/no longer running/);
    await slot.close(session.id);
  });
  it("keeps the slot taken while an attempt's child cannot be shown gone, and lets a later start close it again once the child is gone", async () => {
    vi.useFakeTimers(); let canKill = false; const h = harness({ kill: child => { if (canKill) (child as unknown as FakeChild).kill(); } }), slot = new RuntimeSignInSlot(() => Date.now()), session = await slot.start(() => h.make());
    const closing = slot.close(session.id).catch(error => error); await vi.advanceTimersByTimeAsync(6000); expect(await closing).toBeInstanceOf(SignInRefusal);
    vi.setSystemTime(Date.now() + 60_000);
    const stuck = slot.start(() => h.make()).catch(error => error); await vi.advanceTimersByTimeAsync(6000);
    expect(await stuck).toMatchObject({ message: expect.stringMatching(/Another sign-in/) });
    canKill = true; vi.setSystemTime(Date.now() + 60_000);
    const next = await slot.start(() => h.make()); expect(next).not.toBe(session); expect(session.live).toBe(false); await slot.close(next.id);
  });
  it("frees the slot by itself when the child already ended and nobody closed the attempt (a lost close)", async () => {
    let now = 1_000_000; const h = harness(), slot = new RuntimeSignInSlot(() => now), first = await slot.start(() => h.make());
    await expect(slot.start(() => h.make())).rejects.toThrow(/Another sign-in/);
    h.child().end(0); now += 6_000;
    const second = await slot.start(() => h.make()); expect(second).not.toBe(first); expect(first.live).toBe(false); expect(h.calls).toHaveLength(2);
    await slot.close(second.id);
  });
  it("check() says busy or too fast without starting anything", async () => {
    let now = 1_000_000; const h = harness(), slot = new RuntimeSignInSlot(() => now); slot.check();
    const first = await slot.start(() => h.make()); expect(() => slot.check()).toThrow(/Another sign-in/); await slot.close(first.id); expect(() => slot.check()).toThrow(/too quickly/); now += 5_000; slot.check();
  });
});

describe("the method flag, an early exit, and the line ending", () => {
  it("pins both flags and the closed method table (the CLI's own help: --claudeai = Claude subscription, --console = Console)", () => {
    expect(CLAUDE_LOGIN_METHOD_FLAGS).toEqual({ subscription: "--claudeai", console: "--console" });
    expect(Object.keys(CLAUDE_LOGIN_METHOD_FLAGS)).toEqual(["subscription", "console"]);
    const h = harness(); void h.make("subscription"); expect(h.calls[0]!.args).toEqual(["--prefix", ...CLAUDE_LOGIN_ARGV, "--claudeai"]);
  });
  it("a child that exits at once with an error (a CLI that does not know the flag) is reported as ended right away, not after the ten minutes", async () => {
    const h = harness(), session = h.make();
    expect(session.status()).toEqual({ alive: true });
    h.child().stderr.write("error: unknown option '--claudeai'\n"); h.child().end(1);
    expect(session.status()).toEqual({ alive: false, exitCode: 1 });
    expect(session.capture()).toBe("");                       // nothing of that output reaches the screen
    expect(session.childEnded).toBe(true);
    await session.close(); expect(session.live).toBe(false);
  });
  it("a program that cannot be started at all is reported as ended too", async () => {
    const h = harness(), session = h.make(); h.child().emit("error", new Error("spawn ENOENT C:\\secret\\claude.exe"));
    expect(session.status()).toEqual({ alive: false }); expect(session.capture()).toBe(""); await session.close();
  });
  it("writes the code with \\r (measured on Linux with claude 2.1.319: \\n, \\r and \\r\\n all submit it; \\r is the one the host's terminal sends)", async () => {
    const h = harness(), session = h.make(); h.child().say(REAL); await session.write("\x15BADCODE123\r");
    expect(h.child().written).toBe("BADCODE123\r"); void session.close();
  });
  it("a close that failed can be tried again", async () => {
    vi.useFakeTimers(); let canKill = false; const h = harness({ kill: child => { if (canKill) (child as unknown as FakeChild).kill(); } }), session = h.make();
    const first = session.close().catch(error => error); await vi.advanceTimersByTimeAsync(6000); expect(await first).toBeInstanceOf(SignInRefusal); expect(session.live).toBe(true);
    canKill = true; await session.close(); expect(session.live).toBe(false);
  });
});

describe("hardening of the reduced screen (review items 4 and 5)", () => {
  it("drops a URL line with a bell, a backspace, a NUL or any control or non-ASCII character in it", () => {
    for (const bad of ["https://claude.ai/oauth/x\x07\x08evil", "https://claude.ai/oauth/\x00x", "https://claude.ai/oauth/\x7fx", "https://claude.ai/oauth/\x01x", "https://claude.ai/oauth/é", "https://claude.ai/oauth/x\u2028y", "https://claude.ai/\x1fx"]) {
      expect(reduceClaudeLoginScreen(`If the browser didn't open, visit: ${bad}\n${REDUCED_CODE_PROMPT}`), JSON.stringify(bad)).toBe(`${REDUCED_CODE_PROMPT}\n`);
    }
  });
  it("sends the URL in the form the URL parser gives back, not as written", () => {
    expect(reduceClaudeLoginScreen("If the browser didn't open, visit: https://CLAUDE.ai:443/oauth/a")).toBe("If the browser didn't open, visit: https://claude.ai/oauth/a\n");
    expect(reduceClaudeLoginScreen("If the browser didn't open, visit: https://claude.com")).toBe("If the browser didn't open, visit: https://claude.com/\n");
  });
  it("matches an outcome only at the start of a line (or of the text after the prompt), not anywhere in it", () => {
    for (const noise of ["Please note Login successful elsewhere", "foo Logged in as x", "x Login failed: Request failed with status code 400", "the Invalid code message", "You are Logged in as ab@example.com now"]) {
      expect(reduceClaudeLoginScreen(`${REAL}\n${noise}`), noise).toBe(`${REDUCED_URL_PREFIX}${URL_OK}\n`);
    }
  });
  it("reads the verdict the CLI prints on the line of the prompt itself (measured with claude 2.1.319)", () => {
    expect(reduceClaudeLoginScreen(`If the browser didn't open, visit: ${URL_OK}\nPaste code here if prompted > Invalid code. Please make sure the full code was copied.\n`)).toBe(`${REDUCED_INVALID_CODE}\n`);
    expect(reduceClaudeLoginScreen(`${REAL} Login successful`)).toBe(`${REDUCED_SUCCESS}\n`);
    expect(structuredSignInPrompt("claude-code", reduceClaudeLoginScreen(`${REAL} Invalid code. Please make sure the full code was copied.`))).toEqual({ phase: "failed", reason: "provider_rejected" });
  });
});
