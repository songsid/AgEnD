/**
 * #3190 Part 3a: this computer's side of `RuntimeSignInTransport`. The server's `StructuredSignIn` drives a sign-in through five calls
 * (start, capture, status, write, close); on a paired computer they arrive here, over the Runtime connection.
 *
 *  - The server sends a CLI id, a profile NAME and a method, never an argv, a command, a path or an environment. This module builds the
 *    command itself (`claude auth login`), sets `CLAUDE_CONFIG_DIR` to the profile's own folder, uses pipes (no terminal) and `BROWSER=true`
 *    so nothing opens on an unattended computer.
 *  - `capture()` is NOT the CLI's output. The raw output stays in this process, is bounded, and is reduced to lines of a closed table: the
 *    sign-in URL (https, an allowed host), the code prompt, and the outcome, each in its fixed form. Everything else is dropped, so an
 *    e-mail address in a success line (`Logged in as ...`) reaches the server as `Login successful`.
 *  - `write()` accepts one sign-in code, only while the code prompt is showing, in the characters a code has.
 *  - One sign-in at a time on this computer, a start-rate limit and a ten-minute timeout, enforced here whatever the server says.
 *  - `close()` ends exactly the child this module started, removes its scratch folder and says so only when the child is gone.
 *
 * Built-ins and shared Runtime modules only: part of the Runtime bundle.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as guardedSpawn } from "./child-process.js";
import { linkableLoginUrl } from "./login-url.js";

/** What the Claude Code sign-in is. The server's `LOGIN_FLOWS["claude-code"]` carries the same argv and patterns; a test pins that they agree. */
export const CLAUDE_LOGIN_ARGV = Object.freeze(["auth", "login"] as const);
export const CLAUDE_LOGIN_METHOD_FLAGS = Object.freeze({ subscription: "--claudeai", console: "--console" } as const);
export type SignInMethod = keyof typeof CLAUDE_LOGIN_METHOD_FLAGS;
export const SIGNIN_TTL_MS = 10 * 60_000;
export const SIGNIN_MIN_GAP_MS = 5_000;
export const SIGNIN_MAX_STARTS_PER_HOUR = 12;
const MAX_RAW = 64 * 1024;
const MAX_LINE = 8 * 1024;
const MAX_URL = 4096;
const MAX_CODE = 4096;
const CLOSE_WAIT_MS = 5_000;

/** The reduced screen's closed vocabulary (fixed forms; the server's `structuredSignInPrompt` reads exactly these). */
export const REDUCED_URL_PREFIX = "If the browser didn't open, visit: ";
export const REDUCED_CODE_PROMPT = "Paste code here if prompted >";
export const REDUCED_SUCCESS = "Login successful";
export const REDUCED_REJECTED = "Login failed: Request failed with status code 400";
export const REDUCED_INVALID_CODE = "Invalid code";

/** A refusal with our own text: no URL, code, output or path in it. */
export class SignInRefusal extends Error { constructor(message: string, readonly reason: "busy" | "rate_limited" | "invalid_request" | "timeout" | "failed") { super(message); this.name = "SignInRefusal"; } }

/** Plain text only: a terminal control sequence, an escape or a NUL has no place in a line we would keep. */
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
/**
 * The closed table. Given the CLI's raw output so far, the screen the server may see:
 *  - the outcome if there is one (success wins nothing over a rejection that came later: the last outcome line counts),
 *  - otherwise the URL (if it is https, on an allowed host, bounded) and, if the prompt is the last line, the prompt.
 */
export function reduceClaudeLoginScreen(raw: string): string {
  const lines = raw.replace(ANSI, "").replace(/\r/g, "\n").split("\n").map(line => line.trim()).filter(Boolean);
  let url: string | undefined, outcome: string | undefined;
  for (const line of lines) {
    if (line.length > MAX_LINE) continue;
    // The URL is printable ASCII only (a bell, a backspace or a NUL inside it drops the line), and it is sent in the form the URL parser gives
    // back, not as the CLI wrote it. Its query is the CLI's own and not a closed set; only the scheme, the host and these characters are checked.
    const found = /^If the browser didn't open, visit:\s*(https:\/\/[\x21-\x7e]+)$/.exec(line);
    if (found) { const href = checkedLoginUrl(found[1]); if (href) url = href; continue; }
    // The CLI prints a verdict on the line of the prompt itself ("Paste code here if prompted > Invalid code..." measured with 2.1.319), so an
    // optional prompt prefix is allowed; nothing else may come before the words.
    const verdict = line.replace(PROMPT_PREFIX, "");
    if (/^(?:Login successful|Logged in as\b)/.test(verdict)) outcome = REDUCED_SUCCESS;
    else if (/^Login failed: Request failed with status code 400/.test(verdict)) outcome = REDUCED_REJECTED;
    else if (/^Invalid code\b/.test(verdict)) outcome = REDUCED_INVALID_CODE;
  }
  if (outcome) return `${outcome}\n`;
  const last = lines[lines.length - 1];
  return `${url ? `${REDUCED_URL_PREFIX}${url}\n` : ""}${last === REDUCED_CODE_PROMPT ? `${REDUCED_CODE_PROMPT}\n` : ""}`;
}
const PROMPT_PREFIX = /^Paste code here if prompted >\s*/;
/** https, an allowed host, no credentials, bounded, printable ASCII after parsing; returns the parsed form. */
function checkedLoginUrl(text: string): string | undefined {
  if (text.length > MAX_URL) return undefined;
  let href: string; try { href = new URL(text).href; } catch { return undefined; }
  return href.length <= MAX_URL && /^https:\/\/[\x21-\x7e]+$/.test(href) && linkableLoginUrl("claude-code", href) ? href : undefined;
}

/**
 * What the server's driver sends for a code: `\x15` (clears a prefilled prompt), the code, `\r`. Anything else (menu keys, a second line,
 * control bytes, a non-code character, too long) is refused here too. Returns the code to write.
 */
export function checkedSignInInput(input: unknown): string {
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > MAX_CODE + 2) throw new SignInRefusal("That is not a sign-in code", "invalid_request");
  const code = input.replace(/^\x15/, "").replace(/\r?\n?$|\r$/, "");
  if (!code || code.length > MAX_CODE || !/^[A-Za-z0-9._~+/#=-]+$/.test(code)) throw new SignInRefusal("That is not a sign-in code", "invalid_request");
  return code;
}

export interface SignInLaunch {
  /** The CLI's own program (`findCli`), its leading arguments, and the environment already holding the profile's variable. */
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  method: SignInMethod;
}
export type SignInSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export interface SignInDeps { spawn?: SignInSpawn; now?: () => number; ttlMs?: number; scratchRoot?: string; kill?: (child: ChildProcess) => void; /** How long close() waits for the child's `close` after killing it (default 5 s). */ closeWaitMs?: number; /** The ten minutes ran out: the owner records it, and this ends the attempt. */ onTimeout?: () => void }

/** A process that was told to stop and was not confirmed gone: `ended` settles when it really has. Whoever owns the profile (or the install lock) keeps it until then. */
export class ProcessNotConfirmedEnded extends Error { constructor(readonly ended: Promise<unknown>) { super("The process could not be confirmed ended"); this.name = "ProcessNotConfirmedEnded"; } }
export function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // Only the process this module created, and what it started: never a name match.
    const taskkill = guardedSpawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    taskkill.on("error", () => { child.kill(); });
  } else child.kill("SIGKILL");
}

/** One sign-in attempt: one child, one profile, one code. */
export class RuntimeSignIn {
  readonly id = randomBytes(16).toString("hex");
  private raw = "";
  private child: ChildProcess | null = null;
  private exited: { code: number | null } | null = null;
  private codeWritten = false;
  private closeRun: Promise<void> | null = null;
  private released = false;
  private scratch: string | null = null;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly gone: Promise<void>;
  private markGone!: () => void;
  constructor(launch: SignInLaunch, private readonly deps: SignInDeps = {}) {
    this.gone = new Promise(done => { this.markGone = done; });
    this.scratch = mkdtempSync(join(deps.scratchRoot ?? tmpdir(), "agend-signin-"));
    try {
      const child = this.child = (deps.spawn ?? (guardedSpawn as unknown as SignInSpawn))(launch.command,
        [...launch.args, ...CLAUDE_LOGIN_ARGV, CLAUDE_LOGIN_METHOD_FLAGS[launch.method]],
        { cwd: this.scratch, env: { ...launch.env, BROWSER: "true" }, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const take = (chunk: Buffer | string): void => { this.raw = (this.raw + chunk.toString()).slice(-MAX_RAW); };
      child.stdout?.on("data", take); child.stderr?.on("data", take);
      // `error` means two different things. With no pid the program never started: nothing runs, so it counts as ended. With a pid it is a failure
      // to signal or kill a child that EXISTS (Node emits it then too), which proves nothing about whether it died: only `close` does.
      child.on("error", () => { if (child.pid === undefined) { this.exited ??= { code: null }; this.markGone(); } });
      child.on("close", code => { this.exited ??= { code }; this.markGone(); });
    } catch (error) { this.removeScratch(); throw error; }
    // The same ten minutes as the host's sign-in, enforced here whatever the server does.
    this.timer = setTimeout(() => { if (deps.onTimeout) deps.onTimeout(); else void this.close().catch(() => {}); }, deps.ttlMs ?? SIGNIN_TTL_MS); this.timer.unref?.();
  }
  /** The reduced screen: lines of the closed table only. */
  capture(): string { return reduceClaudeLoginScreen(this.raw); }
  status(): { alive: boolean; exitCode?: number } { return this.exited ? { alive: false, ...(this.exited.code !== null ? { exitCode: this.exited.code } : {}) } : { alive: !!this.child }; }
  /**
   * Everything that can be refused about a code without sending it: its form, the attempt being over, a code already written, the prompt not showing.
   * Nothing changes. A caller that records its operations calls this first, so a refused write is one foldable line and not a `started` entry.
   */
  assertWritable(input: unknown): string {
    const code = checkedSignInInput(input);
    if (this.closeRun || this.exited || !this.child?.stdin?.writable) throw new SignInRefusal("This sign-in has ended", "invalid_request");
    if (this.codeWritten) throw new SignInRefusal("A sign-in takes one code", "invalid_request");
    if (!this.capture().endsWith(`${REDUCED_CODE_PROMPT}\n`)) throw new SignInRefusal("This sign-in is not asking for a code", "invalid_request");
    return code;
  }
  /** One code, only while the code prompt is the screen. */
  async write(input: unknown): Promise<void> {
    const code = this.assertWritable(input);
    this.codeWritten = true;
    await new Promise<void>((done, fail) => this.child!.stdin!.write(`${code}\r`, error => error ? fail(error) : done()));
  }
  /**
   * Ends exactly this child, removes the scratch folder, and resolves only when the child is gone; rejects when that cannot be shown. A failed
   * attempt can be tried again (the next call kills and waits again), so a stuck child does not hold the computer's sign-in slot for ever.
   */
  close(): Promise<void> {
    if (this.closeRun) return this.closeRun;
    const run = (async () => {
      clearTimeout(this.timer);
      try { this.child?.stdin?.end(); } catch { /* already closed */ }
      if (!this.exited) { (this.deps.kill ?? killTree)(this.child!); }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const ended = await Promise.race([this.gone.then(() => true), new Promise<boolean>(done => { timeout = setTimeout(() => done(false), this.deps.closeWaitMs ?? CLOSE_WAIT_MS); timeout.unref?.(); })]);
      clearTimeout(timeout);
      if (!ended) throw new SignInRefusal("The sign-in process could not be confirmed ended", "failed");
      this.raw = ""; this.removeScratch(); this.released = true;
    })().catch(error => { this.closeRun = null; throw error; });
    return this.closeRun = run;
  }
  /** The child has ended on its own (or could not start); the attempt only waits to be closed. */
  get childEnded(): boolean { return this.exited !== null; }
  private removeScratch(): void { if (this.scratch) { try { rmSync(this.scratch, { recursive: true, force: true }); } catch { /* a temporary folder */ } this.scratch = null; } }
  /** A sign-in that is still taking this computer's one slot. */
  get live(): boolean { return !this.released; }
}

/**
 * The one slot: a second start while one is live, too-fast starts and too many in an hour are refused with a reason. A closed attempt frees the
 * slot. One whose child has ended on its own, or whose close failed earlier, is closed again by the next start (the child is shown gone or the
 * kill is retried), so a lost `signin.close` or a failed `taskkill` does not block sign-ins until the Runtime restarts.
 */
export class RuntimeSignInSlot {
  private active: RuntimeSignIn | null = null;
  private starts: number[] = [];
  private cleanupFailed = false;
  constructor(private readonly now: () => number = Date.now) {}
  current(): RuntimeSignIn | null { return this.active && this.active.live ? this.active : null; }
  /** Closes an attempt that cannot go on (its child ended, or an earlier close failed); a live, working one is left alone. */
  async recover(): Promise<void> {
    const session = this.active;
    if (!session || !session.live || !(session.childEnded || this.cleanupFailed)) return;
    try { await session.close(); this.cleanupFailed = false; if (this.active === session) this.active = null; } catch { this.cleanupFailed = true; }
  }
  /** Busy or too fast: throws, starts nothing. For a caller that must know before it changes anything else. */
  check(): void {
    if (this.current() || this.cleanupFailed) throw new SignInRefusal("Another sign-in is running on this computer", "busy");
    const now = this.now(); this.starts = this.starts.filter(at => now - at < 3_600_000);
    if (this.starts.length && now - this.starts[this.starts.length - 1] < SIGNIN_MIN_GAP_MS) throw new SignInRefusal("Sign-ins start too quickly on this computer; wait a few seconds", "rate_limited");
    if (this.starts.length >= SIGNIN_MAX_STARTS_PER_HOUR) throw new SignInRefusal("Too many sign-ins were started on this computer in the last hour", "rate_limited");
  }
  async start(make: () => RuntimeSignIn): Promise<RuntimeSignIn> {
    await this.recover(); this.check();
    const session = make(); this.starts.push(this.now()); this.active = session; return session;
  }
  /** Looks up an attempt by id, only while it is the live one. */
  find(id: unknown): RuntimeSignIn {
    const session = this.active;
    if (!session || typeof id !== "string" || session.id !== id) throw new SignInRefusal("That sign-in is no longer running", "invalid_request");
    return session;
  }
  async close(id: unknown): Promise<void> {
    const session = this.find(id);
    try { await session.close(); this.cleanupFailed = false; if (this.active === session) this.active = null; }
    catch (error) { this.cleanupFailed = true; throw error; }
  }
}
