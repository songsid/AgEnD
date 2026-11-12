/**
 * #3190 Part 3a: this computer's side of `RuntimeSignInTransport`. The server's `StructuredSignIn` drives a sign-in through five calls
 * (start, capture, status, write, close); on a paired computer they arrive here, over the Runtime connection.
 *
 *  - The server sends a CLI id, a profile NAME and a method, never an argv, a command, a path or an environment. This module builds the
 *    command itself (`claude auth login`), sets `CLAUDE_CONFIG_DIR` to the profile's own folder, uses pipes (no terminal) and `BROWSER=true`
 *    so nothing opens on an unattended computer.
 *  - Antigravity (`agy acp --login`, Google OAuth) is signed in two ways. Its Windows login lives in the Credential Manager under one fixed name, so the sign-in with no
 *    profile name is the computer's own default login (AGEND-113). A NAMED account (AGEND-124) is the same command with `--app_data_dir <folder>` and the registry's `pin` (so the
 *    login is kept in that folder's file): the callers (runtime-remote-accounts.ts) first prove, with an empty scratch folder, that the pin holds. Both sit behind the same local
 *    `accounts` switch, one sign-in at a time, the ten-minute timeout, the start-rate limit and the audit record.
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
import { LOGIN_LINK_HOSTS, linkableLoginUrl } from "./login-url.js";
import { runtimeFacts, type RuntimeCliWith } from "./cli-registry.js";

/** What the Claude Code sign-in is. The server's `LOGIN_FLOWS["claude-code"]` carries the same argv and patterns; a test pins that they agree. */
export const CLAUDE_LOGIN_ARGV: readonly string[] = Object.freeze(runtimeFacts("claude-code", "signIn")!.argv.slice(1));   // cli-registry.ts: `runtime.signIn` (the program name, then these words)
/**
 * The CLIs this module signs in (cli-registry.ts: `runtime.signIn`): Claude Code signs a NAMED profile in; Antigravity (`agy acp --login`, "Log in with Google interactively, then exit",
 * agy 1.5.0 and later) signs the computer's OWN login in, with no profile, because Windows keeps that login in the Credential Manager under one fixed name. A Google-account
 * (subscription) sign-in only: no project, no API key. A CLI gains a place here by its spec's `runtime.signIn` saying yes, and the tables below then fail to compile until it has
 * its screen's table, its code prompt and how a code is ended (the behaviour a `yes` promises).
 */
export type SignInCli = RuntimeCliWith<"signIn">;
/** The words after the program name that start a CLI's sign-in (the registry's argv without its first word); the Runtime builds the command itself. */
export function signInWords(cli: SignInCli): readonly string[] { return runtimeFacts(cli, "signIn")!.argv.slice(1); }
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
/**
 * The Antigravity screen's closed vocabulary. `agy acp --login` prints (measured with agy 1.5.3, the same through pipes and a terminal): "Open this link in a browser to log in with Google:",
 * a blank line and the link on its own line, then "Then paste the authorization code, or the full URL of the page you land on, and press Enter:". It prints no success line that has been
 * seen (success is the process ending with exit 0 and `agy models` working, never a word on the screen), "login cancelled: ..." when no code was entered, and "couldn't log in: ..." when
 * the code was refused. The reduced screen has exactly these four forms and nothing else of the CLI's text. Each form is also a line the CLI itself writes (the link on the sentence's own
 * line, the prompt as printed, the two endings cut to their first words), so reducing a reduced screen changes nothing: the server reads it once more, as the table says.
 */
export const REDUCED_AGY_URL_PREFIX = "Open this link in a browser to log in with Google: ";
export const REDUCED_AGY_CODE_PROMPT = "Then paste the authorization code, or the full URL of the page you land on, and press Enter:";
export const REDUCED_AGY_REJECTED = "couldn't log in";
export const REDUCED_AGY_CANCELLED = "login cancelled";

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
function checkedLoginUrl(text: string, cli: SignInCli = "claude-code"): string | undefined {
  if (text.length > MAX_URL) return undefined;
  let parsed: URL; try { parsed = new URL(text); } catch { return undefined; }
  const href = parsed.href;
  // A CLI whose sign-in page is on exactly one host (Antigravity: Google's account chooser) is held to that host: not a subdomain, not another port.
  const only = BEHAVIOUR[cli].exactLoginHost ? LOGIN_LINK_HOSTS[cli]?.[0] : undefined;   // the one host login-url.ts lists for it
  if (BEHAVIOUR[cli].exactLoginHost && (!only || parsed.hostname.toLowerCase() !== only || parsed.port)) return undefined;
  return href.length <= MAX_URL && /^https:\/\/[\x21-\x7e]+$/.test(href) && linkableLoginUrl(cli, href) ? href : undefined;
}
/**
 * Antigravity's closed table: the sign-in link (https, `accounts.google.com` only, on the line after the sentence or on its own line), the code prompt when it is the last line, and
 * "Login failed" / "Login cancelled" for the two endings `agy acp --login` words. Nothing else is kept, so no account name or path in the CLI's text can reach the server.
 */
export function reduceAgyLoginScreen(raw: string): string {
  const lines = raw.replace(ANSI, "").replace(/\r/g, "\n").split("\n").map(line => line.trim()).filter(Boolean);
  let url: string | undefined, outcome: string | undefined, announced = false;
  for (const line of lines) {
    if (line.length > MAX_LINE) continue;
    if (/^Open this link in a browser to log in with Google:?$/.test(line)) { announced = true; continue; }
    // The link is the line that follows the sentence (or the sentence's own line, in case a later agy joins them); only what follows the sentence is taken as the link.
    const inline = /^Open this link in a browser to log in with Google:\s*(https:\/\/[\x21-\x7e]+)$/.exec(line);
    const alone = announced ? /^(https:\/\/[\x21-\x7e]+)$/.exec(line) : null;
    const candidate = inline?.[1] ?? alone?.[1];
    if (candidate) { announced = false; const href = checkedLoginUrl(candidate, "antigravity"); if (href) url = href; continue; }
    announced = false;
    if (/^login cancelled\b/i.test(line)) outcome = REDUCED_AGY_CANCELLED;
    else if (/^couldn't log in\b/i.test(line)) outcome = REDUCED_AGY_REJECTED;
  }
  if (outcome) return `${outcome}\n`;
  const last = lines[lines.length - 1];
  const asking = last !== undefined && /^Then paste the authorization code\b.*press Enter:$/.test(last);
  return `${url ? `${REDUCED_AGY_URL_PREFIX}${url}\n` : ""}${asking ? `${REDUCED_AGY_CODE_PROMPT}\n` : ""}`;
}
/**
 * The behaviour that backs each registry `runtime.signIn` (cli-registry.ts), keyed by the CLI id and exhaustive over `SignInCli`: a CLI whose spec says it can be signed in on a
 * computer does not compile until it has its screen's closed table, the line of that screen that means "type the code now", how a code is ended, and (if its sign-in page is on one
 * host) that host. A Claude sign-in also takes the method flag (`--claudeai`); no other CLI has a method.
 */
const BEHAVIOUR: Record<SignInCli, { reduce: (raw: string) => string; codePrompt: string; codeEnd: string; exactLoginHost?: true; methodFlags?: typeof CLAUDE_LOGIN_METHOD_FLAGS }> = {
  "claude-code": { reduce: reduceClaudeLoginScreen, codePrompt: REDUCED_CODE_PROMPT, codeEnd: "\r", methodFlags: CLAUDE_LOGIN_METHOD_FLAGS },   // claude reads its code raw: a carriage return
  "antigravity": { reduce: reduceAgyLoginScreen, codePrompt: REDUCED_AGY_CODE_PROMPT, codeEnd: "\n", exactLoginHost: true },   // `agy acp --login` reads a line from a pipe
};
/** The closed table of one CLI's sign-in screen. */
export function reduceLoginScreen(cli: SignInCli, raw: string): string { return BEHAVIOUR[cli].reduce(raw); }
/** The line of the reduced screen that means "type the code now", per CLI. */
export function reducedCodePrompt(cli: SignInCli): string { return BEHAVIOUR[cli].codePrompt; }

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
  /** The arguments that name a NAMED account for a CLI that is told it by an argument (Antigravity: `--app_data_dir <folder>`), put right after the program's own `args` and before the sign-in words. */
  profileArgs?: readonly string[];
  env: NodeJS.ProcessEnv;
  method: SignInMethod;
  /** Which CLI's sign-in this is (default Claude Code). Antigravity's is `acp --login` under the computer's own login, so `method` does not apply to it. */
  cli?: SignInCli;
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
  /** Which CLI this attempt signs in: it decides the command, the screen's table and how a code is ended. */
  readonly cli: SignInCli;
  constructor(launch: SignInLaunch, private readonly deps: SignInDeps = {}) {
    this.cli = launch.cli ?? "claude-code";
    this.gone = new Promise(done => { this.markGone = done; });
    this.scratch = mkdtempSync(join(deps.scratchRoot ?? tmpdir(), "agend-signin-"));
    try {
      const child = this.child = (deps.spawn ?? (guardedSpawn as unknown as SignInSpawn))(launch.command,
        [...launch.args, ...(launch.profileArgs ?? []), ...signInWords(this.cli), ...(BEHAVIOUR[this.cli].methodFlags ? [BEHAVIOUR[this.cli].methodFlags![launch.method]] : [])],
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
  capture(): string { return reduceLoginScreen(this.cli, this.raw); }
  status(): { alive: boolean; exitCode?: number } { return this.exited ? { alive: false, ...(this.exited.code !== null ? { exitCode: this.exited.code } : {}) } : { alive: !!this.child }; }
  /**
   * Everything that can be refused about a code without sending it: its form, the attempt being over, a code already written, the prompt not showing.
   * Nothing changes. A caller that records its operations calls this first, so a refused write is one foldable line and not a `started` entry.
   */
  assertWritable(input: unknown): string {
    const code = checkedSignInInput(input);
    if (this.closeRun || this.exited || !this.child?.stdin?.writable) throw new SignInRefusal("This sign-in has ended", "invalid_request");
    if (this.codeWritten) throw new SignInRefusal("A sign-in takes one code", "invalid_request");
    if (!this.capture().endsWith(`${reducedCodePrompt(this.cli)}\n`)) throw new SignInRefusal("This sign-in is not asking for a code", "invalid_request");
    return code;
  }
  /** One code, only while the code prompt is the screen. */
  async write(input: unknown): Promise<void> {
    const code = this.assertWritable(input);
    this.codeWritten = true;
    // Claude reads its code raw and takes a carriage return; `agy acp --login` reads a line from a pipe, which ends with a line feed.
    await new Promise<void>((done, fail) => this.child!.stdin!.write(`${code}${BEHAVIOUR[this.cli].codeEnd}`, error => error ? fail(error) : done()));
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
