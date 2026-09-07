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
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, openSync, rmSync, readFileSync, constants as fsConstants } from "node:fs";
import { Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  /** The dedicated tmux server could NOT be confirmed dead — operator attention needed. */
  cleanupFailed?: boolean;
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
  /** Resolves only when the server is confirmed gone; rejects when it may still be alive. */
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
/** Bytes of browser input allowed to wait for tmux before the session is ended as wedged (B4). */
export const MAX_PENDING_INPUT_BYTES = 64 * 1024;
/** Queued tmux operations allowed to wait (input batches + at most one resize); more means tmux is stuck. */
export const MAX_PENDING_JOBS = 64;
/** Upper bound on any single tmux invocation (B5: a wedged tmux must not hang the session forever). */
const TMUX_EXEC_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 5_000;
/** Consecutive failed pane probes before the session is ended as unreachable. */
export const MAX_PROBE_FAILURES = 3;
const GENERIC_URL = /https:\/\/[^\s"'<>\])]+/;
/** RFC 4648 base32 alphabet without padding — unambiguous when typed on a phone. */
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 20 base32 chars = 100 bits of entropy (13 random bytes, the last 4 bits truncated). */
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
  /** Consecutive polls where tmux could not even be asked — a vanished server must not idle until TTL. */
  private probeFailures = 0;
  /** Geometry most recently requested by the browser (queued, frozen or applied) — the only dedupe key. */
  private lastRequested: { cols: number; rows: number } | null = null;
  /** Single FIFO for input + resize: browser order is pane order (B4). */
  private ioQueue: Promise<void> = Promise.resolve();
  private pendingInputBytes = 0;
  private pendingJobCount = 0;
  /** Input bytes not yet handed to a running job: consecutive frames coalesce into one tmux paste. */
  private pendingBatch: Buffer[] | null = null;
  /**
   * The resize job at the TAIL of the queue, still open for coalescing. Only
   * while no input has been queued after it may a newer resize update it;
   * input freezes it (a resize is a barrier and must stay in its FIFO slot).
   */
  private tailResize: { cols: number; rows: number } | null = null;
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
      this.audit("web_terminal_start_failed", { error: (err as Error).message, cleanupFailed: (err as { cleanupFailed?: boolean }).cleanupFailed === true });
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

  /** Bytes queued for the pane but not yet delivered. */
  get pendingInput(): number { return this.pendingInputBytes; }
  /** Queued tmux operations not yet started (tests: must stay small under any input pattern). */
  get pendingJobs(): number { return this.pendingJobCount; }

  /**
   * Queue browser input for the pane. Strictly ordered with resize.
   * Consecutive input frames coalesce into ONE paste (a resize is a barrier),
   * so the number of tmux operations is bounded by the number of barriers,
   * not by the number of keystrokes. Returns false when the session is not
   * running. A backlog beyond MAX_PENDING_INPUT_BYTES / MAX_PENDING_JOBS
   * means tmux is wedged: the session ENDS (fail closed) rather than letting
   * queued keystrokes reach a credential prompt unattended.
   */
  input(bytes: Buffer): boolean {
    if (this.state !== "running") return false;
    if (bytes.length === 0) return true;
    if (this.pendingInputBytes + bytes.length > MAX_PENDING_INPUT_BYTES) {
      void this.finish({ ok: false, reason: "error", detail: "terminal input backlog — tmux not accepting input" });
      return false;
    }
    this.pendingInputBytes += bytes.length;
    this.tailResize = null;                                     // input after a resize freezes that resize in place
    if (this.pendingBatch) {
      this.pendingBatch.push(Buffer.from(bytes));
      return true;
    }
    const batch: Buffer[] = [Buffer.from(bytes)];
    this.pendingBatch = batch;
    this.enqueue(async () => {
      if (this.pendingBatch === batch) this.pendingBatch = null;   // later frames start a new batch
      const payload = Buffer.concat(batch);
      try {
        if (this.state === "running") await this.backend.sendInput(this.socketName, payload);
      } catch (err) {
        // Fail closed (B1): a partially delivered keystroke sequence must not
        // leave the admin typing into an unknown state. Sanitized detail only.
        this.logger.warn({ sid: this.sid, op: "input", code: (err as { code?: unknown })?.code }, "web terminal tmux operation failed");
        void this.finish({ ok: false, reason: "error", detail: "terminal input failed — session ended" });
      } finally {
        this.pendingInputBytes -= payload.length;
      }
    }, "input");
    return true;
  }

  resize(cols: number, rows: number): void {
    if (this.state !== "running") return;
    const c = clamp(Math.floor(cols), MIN_COLS, MAX_COLS);
    const r = clamp(Math.floor(rows), MIN_ROWS, MAX_ROWS);
    // Dedupe only against what the browser LAST asked for (queued, frozen or
    // applied) — never against the committed size, which may be stale while
    // an earlier resize is still waiting in the queue.
    if (this.lastRequested && this.lastRequested.cols === c && this.lastRequested.rows === r) return;
    this.lastRequested = { cols: c, rows: r };
    if (this.tailResize) { this.tailResize.cols = c; this.tailResize.rows = r; return; }   // newest geometry wins — same FIFO slot
    const target = { cols: c, rows: r };
    this.tailResize = target;
    this.pendingBatch = null;                                                             // a resize is an ordering barrier for input
    this.enqueue(async () => {
      if (this.tailResize === target) this.tailResize = null;
      if (this.state !== "running") return;
      try {
        await this.backend.resize(this.socketName, target.cols, target.rows);
        this.cols = target.cols; this.rows = target.rows;                                 // committed only on success (retry stays possible)
      } catch (err) {
        this.logger.warn({ sid: this.sid, op: "resize", code: (err as { code?: unknown })?.code }, "web terminal tmux operation failed");
        // Not applied: forget it as "last requested" so the same size can be retried.
        if (this.lastRequested && this.lastRequested.cols === target.cols && this.lastRequested.rows === target.rows) this.lastRequested = null;
      }
    }, "resize");
  }

  /** Everything queued before the returned promise settles has reached tmux (tests). */
  drain(): Promise<void> { return this.ioQueue; }

  private enqueue(job: () => Promise<void>, what: string): void {
    if (this.pendingJobCount >= MAX_PENDING_JOBS) {
      void this.finish({ ok: false, reason: "error", detail: `terminal ${what} backlog — tmux not responding` });
      return;
    }
    this.pendingJobCount++;
    this.ioQueue = this.ioQueue
      .then(() => { this.pendingJobCount--; return job(); })
      .catch(err => {
        // Never log the error text: a failed tmux invocation must not leak what
        // was being typed. Operation name only.
        this.logger.warn({ sid: this.sid, op: what, code: (err as { code?: unknown })?.code }, "web terminal tmux operation failed");
      });
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
      if (status === null) {
        // tmux did not answer. One miss can be load; three in a row means the
        // dedicated server is gone or wedged — end now, fail closed, rather
        // than keep a token-gated terminal "running" on nothing until TTL.
        if (++this.probeFailures >= MAX_PROBE_FAILURES) {
          await this.finish({ ok: false, reason: "error", detail: "terminal backend unreachable — session ended" });
          return;
        }
      } else {
        this.probeFailures = 0;
      }
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
      // kill() resolves only when the dedicated server is CONFIRMED gone (B2).
      // A rejection or a timeout means the command may still be running: say so
      // loudly (audit + result flag) rather than pretending the boundary held.
      const killed = await Promise.race([
        this.backend.kill(this.socketName).then(() => true, () => false),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), KILL_TIMEOUT_MS).unref?.()),
      ]);
      if (!killed) {
        result.cleanupFailed = true;
        this.logger.warn({ sid: this.sid, socket: this.socketName }, "web terminal tmux cleanup failed — server may still be alive");
        this.audit("web_terminal_cleanup_failed", { socket: this.socketName });
      }
      this.audit("web_terminal_closed", { reason: result.reason, ok: result.ok, exitCode: result.exitCode, cleanupFailed: result.cleanupFailed === true });
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
  /**
   * Identity of each dedicated server, captured right after new-session: the
   * PID plus a process-generation fingerprint (Linux: /proc start time;
   * fallback: `ps lstart`). A bare PID may be reused by the OS once the server
   * dies outside our control; a signal must NEVER be sent unless the
   * fingerprint still matches — otherwise the "one command" scope would be
   * violated against an unrelated process.
   */
  private readonly servers = new Map<string, { pid: number; identity: string }>();
  private readonly probe: (pid: number) => ProcessProbe;

  constructor(private readonly tmuxBin = "tmux", opts: { probeProcess?: (pid: number) => ProcessProbe } = {}) {
    this.probe = opts.probeProcess ?? probeProcess;
  }

  /** Test seam: the recorded server identity, if a signal fallback was registered. */
  serverRecordForTests(socket: string): { pid: number; identity: string } | undefined {
    return this.servers.get(socket);
  }

  /**
   * Run one tmux command. Errors are re-thrown SANITIZED: operation name,
   * socket and exit code only — never the argv, which for input would be the
   * user's keystrokes (B2), and never tmux's stderr, which echoes the command.
   */
  private async tmux(socket: string, op: string, args: string[], input?: Buffer): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = execFile(this.tmuxBin, ["-L", socket, op, ...args], { encoding: "utf8", timeout: TMUX_EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            const code = (error as { code?: unknown }).code;
            const e = new Error(`tmux ${op} failed (socket ${socket}${typeof code === "number" || typeof code === "string" ? `, ${code}` : ""})`) as Error & { code?: unknown };
            e.code = code;
            reject(e);
            return;
          }
          resolve(typeof stdout === "string" ? stdout : String(stdout));
        });
      if (input) {
        child.stdin?.on("error", () => { /* surfaces as the exec error */ });
        child.stdin?.end(input);
      } else {
        child.stdin?.end();
      }
    });
  }

  async start(opts: { socket: string; command: string; cwd: string; cols: number; rows: number; onOutput: (chunk: Buffer) => void }): Promise<void> {
    const { socket } = opts;
    // Placeholder first, pipe second, real command third — so no byte is lost.
    await new Promise<void>((resolve, reject) => execFile(this.tmuxBin, ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "main",
      "-x", String(opts.cols), "-y", String(opts.rows), "-c", opts.cwd, "sleep 86400"], { timeout: TMUX_EXEC_TIMEOUT_MS },
      err => err ? reject(new Error(`tmux new-session failed (socket ${socket})`)) : resolve()));

    // From here on the server exists: every later failure must tear it down
    // (B5) — set-option, mkdtemp, mkfifo, open, pipe-pane, respawn alike.
    let dir: string | null = null;
    let stream: NetSocket | null = null;
    try {
      const pid = Number.parseInt((await this.tmux(socket, "display-message", ["-p", "#{pid}"])).trim(), 10);
      if (Number.isFinite(pid) && pid > 1) {
        const probe = this.probe(pid);
        // Only a STRONG generation fingerprint may back a signal fallback. On
        // platforms without one (no /proc start time) there is no fallback at
        // all: kill-server or a loud cleanupFailed — never a guess.
        if (probe.kind === "identified") this.servers.set(socket, { pid, identity: probe.identity });
      }
      await this.tmux(socket, "set-option", ["-g", "window-size", "manual"]);
      await this.tmux(socket, "set-option", ["-g", "remain-on-exit", "on"]);
      await this.tmux(socket, "set-option", ["-g", "history-limit", "2000"]);

      dir = mkdtempSync(join(tmpdir(), "agend-term-"));
      const fifo = join(dir, "out");
      await new Promise<void>((resolve, reject) => execFile("mkfifo", ["-m", "600", fifo], { timeout: TMUX_EXEC_TIMEOUT_MS },
        err => err ? reject(new Error("mkfifo failed")) : resolve()));
      // O_RDWR: we are always a writer too, so the FIFO never reports EOF when
      // tmux's `cat` closes. A net.Socket over the fd gives event-driven reads
      // (fs.ReadStream would abort with EAGAIN on a non-blocking pipe).
      const fd = openSync(fifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
      stream = new NetSocket({ fd, readable: true, writable: false });
      stream.on("data", (chunk: Buffer | string) => opts.onOutput(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
      stream.on("error", () => { /* pane gone */ });
      const theStream = stream;
      const theDir = dir;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        theStream.destroy();                 // closes fd
        rmSync(theDir, { recursive: true, force: true });
      };
      this.streams.set(socket, { dir, stop });

      await this.tmux(socket, "pipe-pane", ["-o", "-t", "main", `cat >> ${shellQuote(fifo)}`]);
      await this.tmux(socket, "respawn-pane", ["-k", "-t", "main", "-c", opts.cwd, `sh -c ${shellQuote(opts.command)}`]);
    } catch (err) {
      stream?.destroy();
      if (dir) rmSync(dir, { recursive: true, force: true });
      this.streams.delete(socket);
      try {
        await this.kill(socket);
      } catch {
        (err as { cleanupFailed?: boolean }).cleanupFailed = true;
        (err as Error).message += " (cleanup failed: the tmux server may still be running)";
      }
      throw err;
    }
  }

  /**
   * Deliver bytes to the pane WITHOUT putting typed text in any argv (B2).
   *
   * Two transports, chosen per run of bytes (see segmentInput):
   *   - text runs (anything a user could be typing as a secret) go to tmux
   *     over stdin into a named buffer and are pasted with `paste-buffer -r`
   *     (raw: bytes unchanged), `-d` deleting the buffer;
   *   - control runs (0x00–0x1f, 0x7f and complete ESC sequences: arrows,
   *     Enter, Tab, Ctrl-C…) go through `send-keys -H`. They carry no
   *     secret, and this is the only path on which the pane's tty performs
   *     signal handling: a pasted 0x03 is echoed but does NOT raise SIGINT
   *     (verified live), a sent one does.
   */
  async sendInput(socket: string, bytes: Buffer): Promise<void> {
    if (bytes.length === 0) return;
    const name = `agend-in-${socket.slice(-12)}`;
    for (const run of segmentInput(bytes)) {
      if (run.kind === "control") {
        const hex: string[] = [];
        for (const b of run.bytes) hex.push(b.toString(16).padStart(2, "0"));
        await this.tmux(socket, "send-keys", ["-H", "-t", "main", ...hex]);
        continue;
      }
      try {
        await this.tmux(socket, "load-buffer", ["-b", name, "-"], run.bytes);
        await this.tmux(socket, "paste-buffer", ["-d", "-r", "-b", name, "-t", "main"]);
      } catch (err) {
        await this.tmux(socket, "delete-buffer", ["-b", name]).catch(() => { /* best effort */ });
        throw err;
      }
    }
  }

  async resize(socket: string, cols: number, rows: number): Promise<void> {
    await this.tmux(socket, "resize-window", ["-t", "main", "-x", String(cols), "-y", String(rows)]);
  }

  async capture(socket: string): Promise<string> {
    return this.tmux(socket, "capture-pane", ["-p", "-J", "-t", "main", "-S", "-200"]);
  }

  async paneStatus(socket: string): Promise<{ alive: boolean; exitCode?: number } | null> {
    try {
      const stdout = await this.tmux(socket, "display-message", ["-p", "-t", "main", "#{pane_dead} #{pane_dead_status}"]);
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

  /**
   * Tri-state liveness of the dedicated server. "dead" is asserted only on
   * POSITIVE evidence of absence (tmux's own no-server answer, and — when a
   * PID is known — the process gone); a probe that could not execute
   * (spawn failure, timeout, unexpected exit) is "unknown", never "dead".
   * stderr is inspected in memory only and never logged.
   */
  async serverState(socket: string): Promise<"alive" | "dead" | "unknown"> {
    const server = this.servers.get(socket);
    // Tri-state PID evidence: true = still OUR process; false = positively
    // dead (ESRCH, or a strong fingerprint mismatch = PID reused); null = the
    // probe could not determine anything (never treated as dead).
    let pidAlive: boolean | null = null;
    if (server) {
      const now = this.probe(server.pid);
      if (now.kind === "gone") pidAlive = false;
      else if (now.kind === "identified") {
        if (now.identity === server.identity) pidAlive = true;
        else { pidAlive = false; this.servers.delete(socket); }   // PID reused by someone else: our server is dead
      }
    }
    const pid = server?.pid;
    const tmuxSays = await new Promise<"alive" | "dead" | "unknown">(resolve => {
      execFile(this.tmuxBin, ["-L", socket, "list-sessions"], { encoding: "utf8", timeout: TMUX_EXEC_TIMEOUT_MS }, (error, _stdout, stderr) => {
        if (!error) { resolve("alive"); return; }
        const code = (error as { code?: unknown }).code;
        const text = String(stderr ?? "");
        // tmux 3.x: "no server running on <path>" / "error connecting to <path> (No such file or directory)"
        if (code === 1 && /no server running|error connecting to .*No such file or directory/.test(text)) { resolve("dead"); return; }
        resolve("unknown");
      });
    });
    if (tmuxSays === "alive" || pidAlive === true) return "alive";   // any positive sign of life wins
    if (pidAlive === false) return "dead";                             // the server process is positively gone / reused
    if (tmuxSays === "dead" && !pid) return "dead";                    // tmux's own no-server answer, nothing recorded to contradict it
    return "unknown";                                                  // anything undeterminable → never "absent"
  }

  /**
   * Kill the dedicated server and CONFIRM it is gone (B2). `kill-server` is
   * tried twice; if the server is not positively dead, the PID captured at
   * start is sent SIGTERM then SIGKILL. The FINAL probe decides: resolves
   * only on "dead"; "alive" and "unknown" both reject so the caller reports
   * a cleanup failure instead of claiming the boundary held. "Already gone"
   * (positively) is success.
   */
  async kill(socket: string): Promise<void> {
    const s = this.streams.get(socket);
    if (s) { s.stop(); this.streams.delete(socket); }
    const server = this.servers.get(socket);
    let state: "alive" | "dead" | "unknown" = "unknown";
    for (let attempt = 0; attempt < 2 && state !== "dead"; attempt++) {
      await this.tmux(socket, "kill-server", []).catch(() => { /* judged by the probe */ });
      state = await this.serverState(socket);
    }
    if (state !== "dead" && server) {
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        // Re-verify identity immediately before EVERY signal: only an
        // identified process with the exact recorded fingerprint is ours.
        const now = this.probe(server.pid);
        if (now.kind !== "identified" || now.identity !== server.identity) break;
        try { process.kill(server.pid, signal); } catch { /* ESRCH: gone */ }
        await new Promise(r => setTimeout(r, 300));
        state = await this.serverState(socket);
        if (state === "dead") break;
      }
    }
    if (state !== "dead") {
      // Keep the identity so a later retry can still reach the process.
      throw new Error(`tmux server on socket ${socket} could not be confirmed dead (${state})`);
    }
    this.servers.delete(socket);
  }

  /** Test seam: adopt a server identity as if captured at start. */
  rememberServerForTests(socket: string, pid: number, identity: string): void {
    this.servers.set(socket, { pid, identity });
  }
}

export type ProcessProbe =
  | { kind: "identified"; identity: string }   // alive, with a strong generation fingerprint
  | { kind: "gone" }                           // positively absent (ESRCH)
  | { kind: "unknown" };                       // could not determine — never treated as gone

/**
 * Tri-state process probe. "gone" requires positive ESRCH evidence. A strong
 * fingerprint (start time in clock ticks since boot + command name, from
 * Linux /proc/<pid>/stat) is what makes a later signal safe under PID reuse.
 * On platforms without /proc there is NO fingerprint: the probe can only say
 * gone/unknown, and the backend registers no signal fallback.
 */
export function probeProcess(pid: number): ProcessProbe {
  if (!Number.isFinite(pid) || pid <= 1) return { kind: "unknown" };
  const exists = (): boolean | null => {
    try { process.kill(pid, 0); return true; } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH" ? false : null;   // EPERM etc.: exists but not ours to know
    }
  };
  if (process.platform !== "linux") {
    const e = exists();
    return e === false ? { kind: "gone" } : { kind: "unknown" };
  }
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && exists() === false) return { kind: "gone" };
    return { kind: "unknown" };                                    // transient read failure, EACCES, or a race
  }
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return { kind: "unknown" };
  const comm = stat.slice(open + 1, close);
  const rest = stat.slice(close + 2).split(" ");                  // rest[0] = field 3 (state) … rest[19] = field 22 (starttime)
  const starttime = rest[19];
  if (!starttime || !/^\d+$/.test(starttime)) return { kind: "unknown" };
  return { kind: "identified", identity: `linux:${starttime}:${comm}` };
}

/**
 * Split browser input into runs: "control" (C0 bytes, DEL, and complete ESC
 * sequences — never secrets) vs "text" (everything else — possibly a
 * password). Control runs may travel in argv; text runs must not.
 */
export function segmentInput(bytes: Buffer): Array<{ kind: "control" | "text"; bytes: Buffer }> {
  const runs: Array<{ kind: "control" | "text"; bytes: Buffer }> = [];
  let i = 0;
  const isControl = (b: number) => b < 0x20 || b === 0x7f;
  while (i < bytes.length) {
    const start = i;
    if (isControl(bytes[i])) {
      while (i < bytes.length && isControl(bytes[i])) {
        if (bytes[i] === 0x1b) {
          // ESC sequence: ESC [ params… final  |  ESC O final  |  ESC <single>
          let j = i + 1;
          if (j < bytes.length && (bytes[j] === 0x5b || bytes[j] === 0x4f)) {   // '[' or 'O'
            j++;
            while (j < bytes.length && bytes[j] >= 0x20 && bytes[j] <= 0x3f) j++;   // parameters/intermediates
            if (j < bytes.length && bytes[j] >= 0x40 && bytes[j] <= 0x7e) j++;      // final byte
          } else if (j < bytes.length && bytes[j] >= 0x20 && bytes[j] <= 0x7e) {
            j++;                                                                  // ESC + one char (alt-key)
          }
          i = j;
        } else {
          i++;
        }
      }
      runs.push({ kind: "control", bytes: Buffer.from(bytes.subarray(start, i)) });
    } else {
      while (i < bytes.length && !isControl(bytes[i])) i++;
      runs.push({ kind: "text", bytes: Buffer.from(bytes.subarray(start, i)) });
    }
  }
  return runs;
}

/** Single-quote for `sh`: the only quoting that survives any content. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
