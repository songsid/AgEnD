/**
 * Web terminal session: one command, one tmux pane, one browser, a few minutes.
 *
 * This is the core of remote `/login` and `/install-cli` (v2.1.5). The fleet
 * starts exactly one command inside a *dedicated* tmux server and hands the
 * admin a browser terminal onto that single pane. Nothing here interprets the
 * CLI's screens or presses keys on the user's behalf — the human is the TUI's
 * interpreter, so every CLI's every login flow works without per-CLI modelling.
 *
 * Security shape (design doc §3):
 *   - scope: the browser never gets a tmux client. Input goes through
 *     `send-keys -H` to this one pane; the pane runs `sh -c "<command>"` and
 *     dies when the command exits. No shell is reachable.
 *   - token gate: the URL carries no secret (sid is a path, not a credential).
 *     A separate one-time access token — delivered over the authenticated chat
 *     channel — is verified in constant time; three failures destroy the
 *     session. Success yields a session-bound cookie.
 *   - TTL: the session ends when the process exits, when the TTL lapses, on
 *     lockout, or on cancel. Ending always kills the tmux server.
 *   - observation: the fleet reads the pane (capture-pane) to post the device
 *     URL/code into chat and to judge success/failure — read-only.
 *
 * Output streaming uses `pipe-pane` into a FIFO we hold open O_RDWR (never
 * EOF, nothing on disk). The pane is created running a placeholder and the
 * real command is started with `respawn-pane -k` *after* the pipe is attached,
 * so the very first bytes are captured (verified live: new-session + pipe-pane
 * loses the first line; placeholder + respawn does not).
 */
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, openSync, rmSync, constants as fsConstants } from "node:fs";
import { Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

// ── Public types ─────────────────────────────────────────────────────────────

export interface WebTerminalObserve {
  /** Overrides the generic https matcher when the CLI prints several URLs. */
  urlPattern?: RegExp;
  /** One-time device code shown next to the URL. First capture group wins. */
  codePattern?: RegExp;
  /** Pane text that proves the command achieved its purpose (login done). */
  successPattern?: RegExp;
  /** Known failure strings → human wording + suggested next step. */
  failures?: Array<{ pattern: RegExp; message: string; suggest?: "relogin" | "check-args" | "retry" }>;
}

export interface WebTerminalSpec {
  kind: "login" | "install";
  backend: string;
  /** The one shell command the pane will run (`sh -c`). */
  command: string;
  cwd: string;
  ttlMs: number;
  cols?: number;
  rows?: number;
  observe?: WebTerminalObserve;
  requester: { adapterId: string; userId: string; chatId: string; threadId?: string };
}

export type WebTerminalEndReason = "exit" | "ttl" | "cancel" | "token_lockout" | "error";

export interface WebTerminalResult {
  ok: boolean;
  reason: WebTerminalEndReason;
  exitCode?: number;
  /** Last non-empty pane lines (evidence), or the failure mapping's message. */
  detail: string;
  suggest?: "relogin" | "check-args" | "retry";
}

export interface WebTerminalEvents {
  /** Device URL (+ code) appeared in the pane — post to chat (spoiler). Once per distinct URL. */
  onHint?(url: string, code: string | null): void | Promise<void>;
  /** Terminal state, exactly once. */
  onDone(result: WebTerminalResult): void | Promise<void>;
  /** Audit trail (eventLog). Never receives the token or cookie. */
  onAudit?(event: string, fields: Record<string, unknown>): void;
}

/** A browser attached over WebSocket, as the session sees it. */
export interface TerminalClient {
  send(data: Buffer | string): void;
  close(code: number, reason: string): void;
}

export interface TerminalLogger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

/** The tmux operations a session needs — injectable for unit tests. */
export interface TerminalBackend {
  start(opts: {
    socket: string;
    command: string;
    cwd: string;
    cols: number;
    rows: number;
    onOutput: (chunk: Buffer) => void;
  }): Promise<void>;
  sendInput(socket: string, bytes: Buffer): Promise<void>;
  resize(socket: string, cols: number, rows: number): Promise<void>;
  /** Plain-text pane content (joined wrapped lines), for observation and evidence. */
  capture(socket: string): Promise<string>;
  paneStatus(socket: string): Promise<{ alive: boolean; exitCode?: number } | null>;
  kill(socket: string): Promise<void>;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const ACCESS_TOKEN_LENGTH = 20;
export const MAX_TOKEN_ATTEMPTS = 3;
export const MAX_TTL_MS = 20 * 60_000;
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 36;
export const MIN_COLS = 20, MAX_COLS = 250, MIN_ROWS = 5, MAX_ROWS = 100;
const REPLAY_BUFFER_LIMIT = 256 * 1024;
const POLL_INTERVAL_MS = 1_000;
const SUCCESS_EXIT_GRACE_MS = 15_000;
const INPUT_CHUNK = 256;
const GENERIC_URL = /https:\/\/[^\s"'<>\])]+/;
/** RFC 4648 base32 alphabet without padding — unambiguous when typed on a phone. */
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateAccessToken(bytes: Buffer = randomBytes(13)): string {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.slice(0, ACCESS_TOKEN_LENGTH);
}

/** Evidence for a failure report: the last `n` non-empty lines, bounded. */
export function nonEmptyTail(text: string, n = 3, maxLen = 300): string {
  return text.split("\n").map(l => l.trim()).filter(Boolean).slice(-n).join(" / ").slice(0, maxLen);
}

// ── Session ──────────────────────────────────────────────────────────────────

export class WebTerminalSession extends EventEmitter {
  readonly sid: string = randomBytes(16).toString("hex");
  readonly socketName: string;
  readonly createdAt: number;
  expiresAt = 0;
  state: "created" | "running" | "finished" = "created";

  private accessToken: string | null = generateAccessToken();
  private tokenAttempts = 0;
  private cookieValue: string | null = null;

  private readonly replay: Buffer[] = [];
  private replayBytes = 0;
  private replayTruncated = false;
  private client: TerminalClient | null = null;

  private ttlTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private finishing: Promise<void> | null = null;
  private sentUrls = new Set<string>();
  private successSeenAt: number | null = null;
  private cols: number;
  private rows: number;

  constructor(
    readonly spec: WebTerminalSpec,
    private readonly events: WebTerminalEvents,
    private readonly backend: TerminalBackend,
    private readonly logger: TerminalLogger,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.socketName = `agend-term-${this.sid.slice(0, 12)}`;
    this.createdAt = this.now();
    this.cols = clamp(spec.cols ?? DEFAULT_COLS, MIN_COLS, MAX_COLS);
    this.rows = clamp(spec.rows ?? DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
    if (!Number.isFinite(spec.ttlMs) || spec.ttlMs <= 0 || spec.ttlMs > MAX_TTL_MS) {
      throw new Error(`ttlMs must be within (0, ${MAX_TTL_MS}]`);
    }
  }

  /** The one-time access token, readable only until it is redeemed or the session ends. */
  peekAccessToken(): string | null { return this.accessToken; }

  get ttlRemainingMs(): number { return Math.max(0, this.expiresAt - this.now()); }

  async start(): Promise<void> {
    if (this.state !== "created") throw new Error("session already started");
    this.state = "running";
    this.expiresAt = this.now() + this.spec.ttlMs;
    try {
      await this.backend.start({
        socket: this.socketName,
        command: this.spec.command,
        cwd: this.spec.cwd,
        cols: this.cols,
        rows: this.rows,
        onOutput: chunk => this.onOutput(chunk),
      });
    } catch (err) {
      this.state = "finished";
      this.accessToken = null;
      this.audit("web_terminal_start_failed", { error: (err as Error).message });
      throw err;
    }
    this.audit("web_terminal_created", { ttlMs: this.spec.ttlMs, cols: this.cols, rows: this.rows });
    this.ttlTimer = setTimeout(() => { void this.finish({ ok: false, reason: "ttl", detail: "time limit reached" }); }, this.spec.ttlMs);
    this.ttlTimer.unref?.();
    this.schedulePoll();
  }

  // ── Token gate ──

  /**
   * Redeem the one-time access token. Constant-time compare; three failures
   * destroy the session (URL + attempts = suspected leak). Success returns the
   * cookie value the HTTP layer sets; the token is gone from memory afterwards.
   */
  redeemToken(candidate: string): { result: "ok"; cookie: string } | { result: "bad"; remaining: number } | { result: "used" | "locked" | "finished" } {
    if (this.state !== "running") return { result: "finished" };
    if (this.accessToken === null) return { result: "used" };
    const expected = Buffer.from(this.accessToken, "ascii");
    const given = Buffer.alloc(expected.length);
    const normalized = candidate.trim().toUpperCase().replace(/[\s-]/g, "");
    Buffer.from(normalized, "ascii").copy(given, 0, 0, Math.min(normalized.length, expected.length));
    const equal = timingSafeEqual(expected, given) && normalized.length === expected.length;
    if (!equal) {
      this.tokenAttempts++;
      const remaining = MAX_TOKEN_ATTEMPTS - this.tokenAttempts;
      this.audit("web_terminal_token_failed", { attempts: this.tokenAttempts });
      if (remaining <= 0) {
        this.audit("web_terminal_token_lockout", {});
        void this.finish({ ok: false, reason: "token_lockout", detail: "access token failed 3 times — link may have leaked" });
        return { result: "locked" };
      }
      return { result: "bad", remaining };
    }
    this.accessToken = null;
    this.cookieValue = randomBytes(32).toString("hex");
    this.audit("web_terminal_opened", {});
    return { result: "ok", cookie: this.cookieValue };
  }

  checkCookie(value: string | undefined): boolean {
    if (!value || !this.cookieValue || this.state !== "running") return false;
    const a = Buffer.from(this.cookieValue, "ascii");
    const b = Buffer.alloc(a.length);
    Buffer.from(value, "ascii").copy(b, 0, 0, Math.min(value.length, a.length));
    return timingSafeEqual(a, b) && value.length === a.length;
  }

  // ── Browser I/O ──

  /** Attach the (single) browser; replays buffered output first. Returns a detach function. */
  attachClient(client: TerminalClient): () => void {
    if (this.client && this.client !== client) {
      try { this.client.close(4000, "replaced by a newer connection"); } catch { /* gone */ }
    }
    this.client = client;
    client.send(JSON.stringify({
      t: "hello", backend: this.spec.backend, kind: this.spec.kind, command: this.spec.command,
      ttlRemainingMs: this.ttlRemainingMs, cols: this.cols, rows: this.rows, truncated: this.replayTruncated,
    }));
    for (const chunk of this.replay) client.send(chunk);
    return () => { if (this.client === client) this.client = null; };
  }

  async input(bytes: Buffer): Promise<void> {
    if (this.state !== "running") return;
    for (let i = 0; i < bytes.length; i += INPUT_CHUNK) {
      await this.backend.sendInput(this.socketName, bytes.subarray(i, i + INPUT_CHUNK));
    }
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.state !== "running") return;
    const c = clamp(Math.floor(cols), MIN_COLS, MAX_COLS);
    const r = clamp(Math.floor(rows), MIN_ROWS, MAX_ROWS);
    if (c === this.cols && r === this.rows) return;
    this.cols = c; this.rows = r;
    await this.backend.resize(this.socketName, c, r);
  }

  cancel(detail = "cancelled"): Promise<void> {
    return this.finish({ ok: false, reason: "cancel", detail });
  }

  // ── Internals ──

  private onOutput(chunk: Buffer): void {
    this.replay.push(chunk);
    this.replayBytes += chunk.length;
    while (this.replayBytes > REPLAY_BUFFER_LIMIT && this.replay.length > 1) {
      this.replayBytes -= this.replay.shift()!.length;
      this.replayTruncated = true;
    }
    this.client?.send(chunk);
  }

  private schedulePoll(): void {
    if (this.state !== "running") return;
    this.pollTimer = setTimeout(() => { void this.poll(); }, POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  /** Exposed for tests; the timer calls this every second. */
  async poll(): Promise<void> {
    if (this.state !== "running" || this.polling) return;
    this.polling = true;
    try {
      const status = await this.backend.paneStatus(this.socketName).catch(() => null);
      const pane = await this.backend.capture(this.socketName).catch(() => "");
      this.observe(pane);
      if (status && !status.alive) {
        await this.finishFromExit(status.exitCode, pane);
        return;
      }
      if (this.successSeenAt !== null && this.now() - this.successSeenAt > SUCCESS_EXIT_GRACE_MS) {
        // The CLI printed its success line but keeps running (some stay in a
        // TUI). The purpose is achieved; don't make the admin wait for TTL.
        await this.finish({ ok: true, reason: "exit", detail: "success reported" });
        return;
      }
    } finally {
      this.polling = false;
    }
    this.schedulePoll();
  }

  private observe(pane: string): void {
    const obs = this.spec.observe;
    if (!obs || !pane) return;
    const urlMatch = pane.match(obs.urlPattern ?? GENERIC_URL);
    if (urlMatch) {
      const url = urlMatch[0].replace(/[.,]+$/, "");
      if (!this.sentUrls.has(url)) {
        this.sentUrls.add(url);
        const codeMatch = obs.codePattern ? pane.match(obs.codePattern) : null;
        const code = codeMatch ? codeMatch.slice(1).find(g => g !== undefined) ?? null : null;
        this.audit("web_terminal_hint", { host: safeHost(url), hasCode: code !== null });
        void Promise.resolve(this.events.onHint?.(url, code)).catch(err =>
          this.logger.warn({ err: (err as Error).message }, "web terminal hint handler failed"));
      }
    }
    if (obs.successPattern && this.successSeenAt === null && obs.successPattern.test(pane)) {
      this.successSeenAt = this.now();
      this.audit("web_terminal_success_seen", {});
    }
  }

  private async finishFromExit(exitCode: number | undefined, pane: string): Promise<void> {
    const obs = this.spec.observe;
    const success = this.successSeenAt !== null || (obs?.successPattern ? obs.successPattern.test(pane) : false);
    if (exitCode === 0 || success) {
      await this.finish({ ok: true, reason: "exit", exitCode, detail: success ? "success reported" : "clean exit" });
      return;
    }
    const tail = nonEmptyTail(pane);
    const known = obs?.failures?.find(f => f.pattern.test(pane));
    await this.finish({
      ok: false, reason: "exit", exitCode,
      detail: known ? known.message : `exited with code ${exitCode ?? "?"}${tail ? ` — ${tail}` : ""}`,
      suggest: known?.suggest,
    });
  }

  private finish(result: WebTerminalResult): Promise<void> {
    if (this.finishing) return this.finishing;
    this.finishing = (async () => {
      this.state = "finished";
      this.accessToken = null;
      this.cookieValue = null;
      if (this.ttlTimer) clearTimeout(this.ttlTimer);
      if (this.pollTimer) clearTimeout(this.pollTimer);
      try { this.client?.send(JSON.stringify({ t: "exit", ok: result.ok, reason: result.reason, exitCode: result.exitCode, detail: result.detail })); } catch { /* gone */ }
      try { this.client?.close(1000, result.reason); } catch { /* gone */ }
      this.client = null;
      await this.backend.kill(this.socketName).catch(err =>
        this.logger.warn({ err: (err as Error).message }, "web terminal tmux cleanup failed"));
      this.audit("web_terminal_closed", { reason: result.reason, ok: result.ok, exitCode: result.exitCode });
      this.emit("finished", result);
      await Promise.resolve(this.events.onDone(result)).catch(err =>
        this.logger.warn({ err: (err as Error).message }, "web terminal done handler failed"));
    })();
    return this.finishing;
  }

  private audit(event: string, fields: Record<string, unknown>): void {
    const base = { sid: this.sid, kind: this.spec.kind, backend: this.spec.backend, requester: this.spec.requester.userId };
    this.logger.info({ ...base, ...fields }, event);
    try { this.events.onAudit?.(event, { ...base, ...fields }); } catch { /* audit must never break the session */ }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return "?"; }
}

// ── Real tmux backend ────────────────────────────────────────────────────────

/**
 * Drives a dedicated tmux server (`-L <socket>`, `-f /dev/null` so the user's
 * tmux.conf cannot alter behaviour). Output: pipe-pane → FIFO held O_RDWR.
 */
export class TmuxTerminalBackend implements TerminalBackend {
  private readonly streams = new Map<string, { dir: string; stop: () => void }>();

  constructor(private readonly tmuxBin = "tmux") {}

  private tmux(socket: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return exec(this.tmuxBin, ["-L", socket, ...args], { encoding: "utf8" });
  }

  async start(opts: { socket: string; command: string; cwd: string; cols: number; rows: number; onOutput: (chunk: Buffer) => void }): Promise<void> {
    const { socket } = opts;
    // Placeholder first, pipe second, real command third — so no byte is lost.
    await exec(this.tmuxBin, ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "main",
      "-x", String(opts.cols), "-y", String(opts.rows), "-c", opts.cwd, "sleep 86400"]);
    await this.tmux(socket, ["set-option", "-g", "window-size", "manual"]);
    await this.tmux(socket, ["set-option", "-g", "remain-on-exit", "on"]);
    await this.tmux(socket, ["set-option", "-g", "history-limit", "2000"]);

    const dir = mkdtempSync(join(tmpdir(), "agend-term-"));
    const fifo = join(dir, "out");
    await exec("mkfifo", ["-m", "600", fifo]);
    // O_RDWR: we are always a writer too, so the FIFO never reports EOF when
    // tmux's `cat` closes. A net.Socket over the fd gives event-driven reads
    // (fs.ReadStream would abort with EAGAIN on a non-blocking pipe).
    const fd = openSync(fifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
    const stream = new NetSocket({ fd, readable: true, writable: false });
    stream.on("data", (chunk: Buffer | string) => opts.onOutput(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    stream.on("error", () => { /* pane gone */ });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stream.destroy();                     // closes fd
      rmSync(dir, { recursive: true, force: true });
    };
    this.streams.set(socket, { dir, stop });

    try {
      await this.tmux(socket, ["pipe-pane", "-o", "-t", "main", `cat >> ${shellQuote(fifo)}`]);
      await this.tmux(socket, ["respawn-pane", "-k", "-t", "main", "-c", opts.cwd, `sh -c ${shellQuote(opts.command)}`]);
    } catch (err) {
      stop();
      this.streams.delete(socket);
      await this.kill(socket);
      throw err;
    }
  }

  async sendInput(socket: string, bytes: Buffer): Promise<void> {
    if (bytes.length === 0) return;
    const hex: string[] = [];
    for (const b of bytes) hex.push(b.toString(16).padStart(2, "0"));
    await this.tmux(socket, ["send-keys", "-H", "-t", "main", ...hex]);
  }

  async resize(socket: string, cols: number, rows: number): Promise<void> {
    await this.tmux(socket, ["resize-window", "-t", "main", "-x", String(cols), "-y", String(rows)]);
  }

  async capture(socket: string): Promise<string> {
    const { stdout } = await this.tmux(socket, ["capture-pane", "-p", "-J", "-t", "main", "-S", "-200"]);
    return stdout;
  }

  async paneStatus(socket: string): Promise<{ alive: boolean; exitCode?: number } | null> {
    try {
      const { stdout } = await this.tmux(socket, ["display-message", "-p", "-t", "main", "#{pane_dead} #{pane_dead_status}"]);
      const [dead, status] = stdout.trim().split(/\s+/);
      if (dead === "1") {
        const code = Number.parseInt(status ?? "", 10);
        return { alive: false, exitCode: Number.isFinite(code) ? code : undefined };
      }
      return { alive: true };
    } catch {
      return null;
    }
  }

  async kill(socket: string): Promise<void> {
    const s = this.streams.get(socket);
    if (s) { s.stop(); this.streams.delete(socket); }
    await this.tmux(socket, ["kill-server"]).catch(() => { /* already gone */ });
  }
}

/** Single-quote for `sh`: the only quoting that survives any content. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
