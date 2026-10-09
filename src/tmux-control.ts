import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import type { Logger } from "./logger.js";
import { getTmuxSocketName } from "./paths.js";
import { measureSyncWork } from "./sync-work-attribution.js";
import { TmuxReadLane, TmuxReadError, TMUX_READ_MAX_BYTES, tmuxReadArgs, tmuxCommandToken,
  type TmuxReadQuery, type TmuxReadPort } from "./tmux-read.js";

export interface TmuxPaneOutputEvent {
  paneId: string;
  windowId?: string;
  at: number;
}

export const CONTROL_SAFETY_SWEEP_MS = 60_000;
/**
 * The sweep's listeners — one per daemon, each capturing and evaluating its pane —
 * are spread over this much of the period instead of all running in one tick (#1402): measured live, that one tick was
 * 150–860 ms of unbroken spawning under normal load and 1–2.5 s when the host was busy (#1235). Half the period, so a
 * sweep's last slot is always well before the next sweep starts.
 */
export const CONTROL_SAFETY_SWEEP_SPREAD_MS = CONTROL_SAFETY_SWEEP_MS / 2;

/**
 * Consecutive `list-panes` failures before a window's registration is dropped.
 * More than one because tmux fails transiently under load, and unregistering a
 * live window would silence the output events its daemon depends on.
 */
const RESOLVE_FAILURES_BEFORE_DROP = 3;

/**
 * How often a lost window (one that stopped resolving) is retried, at most, while a caller asks about it. Retries are
 * on demand only — nothing re-resolves a lost window on reconnect — so a dead window that nobody asks about costs
 * nothing, and a live one that comes back is picked up within this long of the next question.
 */
const LOST_WINDOW_RETRY_MS = 5_000;

interface Attachment {
  proc: ChildProcess;
  retired: boolean;
  released: boolean;
  ready: boolean;
  attachGuard: string | null;
  decoder: StringDecoder;
  pending: string;
  timer?: ReturnType<typeof setTimeout>;
}

interface ControlRead {
  owner: Attachment;
  nonce: string;
  guard: string | null;
  lines: string[];
  bytes: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (output: string) => void;
  reject: (error: unknown) => void;
}

const FRAME_OVERHEAD_BYTES = 64 * 1024;
const RECONNECT_MS = 2_000;

/**
 * Persistent tmux control mode client that monitors %output events
 * to detect per-pane idle state. One instance per tmux session.
 *
 * Usage:
 *   const ctrl = new TmuxControlClient("agend", 2000, logger);
 *   ctrl.start();
 *   await ctrl.waitForIdle("@5");  // wait until window @5 is idle
 *   tmux.pasteText(msg);
 */
export class TmuxControlClient extends EventEmitter implements TmuxReadPort {
  /** A retired child still owns this slot until exit/close proves it is gone. */
  private attachment: Attachment | null = null;
  private activeRead: ControlRead | null = null;
  private reconnectAfter = 0;
  private readonly socket = getTmuxSocketName();
  private readonly reads: TmuxReadLane;
  private registrationSerial = 0;
  private registrationTokens = new Map<string, number>();
  private lastOutputAt = new Map<string, number>(); // paneId → timestamp
  private paneToWindow = new Map<string, string>();  // paneId → windowId
  private registeredWindows = new Set<string>();    // windowIds we should re-resolve on reconnect
  private resolveFailures = new Map<string, number>(); // windowId → consecutive resolve failures
  /**
   * Registered windows that stopped resolving (#1490). They leave the reconnect set — a dead window's registration was
   * a permanent per-reconnect cost — but are not forgotten: their state is unknown, and unknown is not idle. A caller's
   * question retries the resolve (at most every LOST_WINDOW_RETRY_MS); success registers the window again.
   */
  private lostWindows = new Map<string, { lastTryAt: number; token: number; inFlight: boolean }>();
  /** Monotonic time a lost window resolved again: until it has been silent this long, it is not idle. */
  private recoveredAt = new Map<string, number>();
  /** Monotonic clock for retry spacing and the recovery silence (elapsed budgets, never wall time). */
  private mono = (): number => performance.now();
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Epoch ms of the last observation reset. Everything before it is unobservable:
   *  the pane cache was dropped, so the absence of a record proves nothing. */
  private observationResetAt = 0;
  private safetySweepTimer: ReturnType<typeof setInterval> | null = null;
  /** The current sweep's pending per-listener slots. */
  private safetySweepSlots = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private sessionName: string,
    private silenceMs: number = 2000,
    private logger?: Logger,
  ) {
    super();
    this.reads = new TmuxReadLane(this.socket, {
      ready: () => Boolean(this.attachment?.ready && !this.attachment.retired),
      execute: (args, deadline) => this.executeRead(args, deadline),
      retire: () => this.cleanup(),
    });
    // One shared control client intentionally has one listener per daemon.
    this.setMaxListeners(0);
  }

  start(): void {
    if (!this.stopped && this.safetySweepTimer) return;
    this.stopped = false;
    this.reads.start();
    if (!this.safetySweepTimer) {
      this.safetySweepTimer = setInterval(() => this.runSafetySweep(), CONTROL_SAFETY_SWEEP_MS);
    }
    this.connect();
  }

  /**
   * One sweep: every daemon's listener, each in a tick of its own, spread evenly over CONTROL_SAFETY_SWEEP_SPREAD_MS
   * (#1402). A listener removed before its slot (its daemon stopped) is skipped; stop() drops slots still pending.
   */
  private runSafetySweep(): void {
    const listeners = this.listeners("safety_sweep") as Array<(event: { at: number }) => void>;
    const step = listeners.length > 0 ? CONTROL_SAFETY_SWEEP_SPREAD_MS / listeners.length : 0;
    listeners.forEach((listener, i) => {
      const slot = setTimeout(() => {
        this.safetySweepSlots.delete(slot);
        if (this.stopped || !this.listeners("safety_sweep").includes(listener)) return;
        // One daemon's capture start and pane evaluation: attributed per tick (#1235).
        measureSyncWork("tmux.safetySweep", () => listener({ at: Date.now() }));
      }, Math.floor(i * step));
      slot.unref?.();
      this.safetySweepSlots.add(slot);
    });
  }

  private clearSafetySweepSlots(): void {
    for (const slot of this.safetySweepSlots) clearTimeout(slot);
    this.safetySweepSlots.clear();
  }

  stop(): void {
    this.stopped = true;
    this.reads.stop();
    this.clearSafetySweepSlots();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.safetySweepTimer) {
      clearInterval(this.safetySweepTimer);
      this.safetySweepTimer = null;
    }
    this.cleanup();
  }

  isFor(session: string, socket: string | null): boolean {
    return session === this.sessionName && socket === this.socket;
  }

  read(query: TmuxReadQuery, timeoutMs = 10_000): Promise<string> {
    if (!this.isFor(query.session, getTmuxSocketName())) {
      return Promise.reject(new TmuxReadError("command", "tmux read scope mismatch"));
    }
    try { return this.reads.read(tmuxReadArgs(query), timeoutMs); }
    catch (error) { return Promise.reject(error); }
  }

  /**
   * Register a window so we can track its pane's output.
   * Call this after createWindow().
   */
  async registerWindow(windowId: string): Promise<void> {
    this.lostWindows.delete(windowId);
    this.recoveredAt.delete(windowId);
    this.registeredWindows.add(windowId);
    this.registrationTokens.set(windowId, ++this.registrationSerial);
    await this.resolvePane(windowId);
  }

  /** Unregister a window (call on killWindow) */
  unregisterWindow(windowId: string): void {
    this.registeredWindows.delete(windowId);
    this.registrationTokens.delete(windowId);
    this.resolveFailures.delete(windowId);
    this.lostWindows.delete(windowId);
    this.recoveredAt.delete(windowId);
    for (const [pane, win] of this.paneToWindow) {
      if (win === windowId) {
        this.paneToWindow.delete(pane);
        this.lastOutputAt.delete(pane);
        break;
      }
    }
  }

  /**
   * Resolve a window's current pane id and cache the mapping.
   *
   * Drops a registration that has failed to resolve `RESOLVE_FAILURES_BEFORE_DROP`
   * times in a row. Every reconnect re-resolves every registered window through the read FIFO,
   * so a registration for a window that no longer exists is a
   * permanent per-reconnect cost — and callers do forget to unregister (a crash
   * respawn creates a new window id and the dead one used to stay forever).
   *
   * Consecutive failures rather than one: `list-panes` also fails transiently when
   * tmux is busy, e.g. during a fleet-restart storm, and dropping a live window's
   * registration would silence its output events.
   */
  private async resolvePane(windowId: string): Promise<void> {
    const token = this.registrationTokens.get(windowId);
    const owner = this.attachment;
    const current = () => !this.stopped && this.registeredWindows.has(windowId)
      && this.registrationTokens.get(windowId) === token && this.admissible(owner);
    try {
      const paneId = (await this.read({ kind: "pane", session: this.sessionName, window: windowId, field: "id" })).trim();
      if (!current()) return;
      this.resolveFailures.delete(windowId);
      if (paneId) {
        this.paneToWindow.set(paneId, windowId);
        this.logger?.debug({ windowId, paneId }, "Registered window→pane mapping");
      }
    } catch (error) {
      if (!current() || !(error instanceof TmuxReadError) || error.kind !== "command") return;
      const failures = (this.resolveFailures.get(windowId) ?? 0) + 1;
      this.resolveFailures.set(windowId, failures);
      if (failures >= RESOLVE_FAILURES_BEFORE_DROP && this.registeredWindows.has(windowId)) {
        // Out of the reconnect set, but remembered as lost: a window we cannot see is not idle (#1490). Dropping it
        // outright made isIdle answer "idle" forever, and a delivery pasted into a generating CLI.
        this.logger?.warn({ windowId, failures }, "Window has not resolved for several attempts — treating it as busy until it resolves again");
        this.unregisterWindow(windowId);
        this.lostWindows.set(windowId, { lastTryAt: this.mono(), token: 0, inFlight: false });
        return;
      }
      this.logger?.debug({ windowId, failures }, "Failed to resolve pane ID for window");
    }
  }

  /**
   * Forget everything we knew about panes, and remember that we have forgotten.
   *
   * Kept as one method so the grace can never be skipped: clearing the maps
   * without arming it is precisely the bug this exists to prevent.
   */
  private resetPaneObservations(): void {
    this.paneToWindow.clear();
    this.lastOutputAt.clear();
    // A recovered window's "silent since it came back" is an observation too: kept, it would vouch for whatever pane
    // the window re-resolves to inside the new grace (#1494 review).
    this.recoveredAt.clear();
    this.observationResetAt = Date.now();
  }

  /**
   * Whether a read started on `owner` may still commit what it learned: the same attachment, not retired. A retired
   * attachment stays in `this.attachment` until its child exits, and a completed frame followed by `%exit` in one
   * chunk resolves the read before the retirement is visible to identity alone (#1494 review). A read started with
   * no attachment (the fallback lane) counts while there is still none.
   */
  private admissible(owner: Attachment | null): boolean {
    return this.attachment === owner && !owner?.retired;
  }

  /**
   * True while a freshly (re)connected client has not had time to observe output.
   *
   * `connect()` drops the pane cache, so for a moment afterwards *every* pane looks
   * like it has never produced output — including panes that are mid-generation.
   * Reading that as "idle" is the dangerous direction: a delivery would skip its
   * busy branch and paste straight into a working CLI, where Enter is a steering
   * interrupt rather than a new turn.
   *
   * `silenceMs` is the right length because it is already this class's definition
   * of idle: a pane that produces nothing for that long counts as idle anyway, so
   * the grace never suppresses a state the client would otherwise have reported.
   * An actively generating pane re-registers well inside it.
   */
  private inObservationGrace(): boolean {
    return this.observationResetAt > 0 && Date.now() < this.observationResetAt + this.silenceMs;
  }

  /**
   * When this client last lost its view of every pane (0 if it never has).
   *
   * A caller reasoning about a *window* of time — "did the pane react in the two
   * seconds after I pressed Enter?" — needs to know whether it could see for all
   * of it. A reset inside that window makes a negative answer meaningless, and
   * acting on it produces confident, wrong conclusions.
   */
  getObservationResetAt(): number {
    return this.observationResetAt;
  }

  /** Check if a window's pane has been silent for at least silenceMs */
  isIdle(windowId: string): boolean {
    // A registered window that stopped resolving: unknown, so not idle; asking retries the resolve (#1490).
    if (this.lostWindows.has(windowId)) { this.retryLostWindow(windowId); return false; }
    const paneId = this.windowToPaneId(windowId);
    // A registered window whose pane is not resolved yet (after a reconnect, or between failed attempts) is unknown,
    // not idle, however long the grace has run: its re-resolution can outlast the grace (#1490).
    if (!paneId && this.registeredWindows.has(windowId)) return false;
    // "Unknown" means unknown, not idle — but only while that ignorance is fresh.
    // After the grace we fall back to the old optimistic answer, because a window
    // that was never registered must not block delivery forever.
    if (!paneId) return !this.inObservationGrace();
    const last = this.lastOutputAt.get(paneId);
    if (last == null) {
      // Back from lost: nothing observed since; idle only after silenceMs of observed silence.
      const recovered = this.recoveredAt.get(windowId);
      if (recovered !== undefined) return this.mono() - recovered >= this.silenceMs;
      return !this.inObservationGrace();
    }
    return Date.now() - last >= this.silenceMs;
  }

  /**
   * Try a lost window again (at most every LOST_WINDOW_RETRY_MS). Success re-registers it under a fresh token; the
   * result counts only for the same lost record, the same attachment, and a client that has not stopped.
   */
  private retryLostWindow(windowId: string): void {
    const lost = this.lostWindows.get(windowId);
    // One attempt at a time per lost record: superseding a slow but healthy read every spacing meant a window whose
    // reads take longer than the spacing could never come back (#1494 review). Reads are bounded, so it settles.
    if (!lost || lost.inFlight || this.stopped) return;
    const at = this.mono();
    // The first retry also waits: the window has just failed RESOLVE_FAILURES_BEFORE_DROP times.
    if (at - lost.lastTryAt < LOST_WINDOW_RETRY_MS) return;
    lost.lastTryAt = at;
    lost.inFlight = true;
    const token = ++this.registrationSerial;
    lost.token = token;
    const owner = this.attachment;
    const current = () => !this.stopped && this.lostWindows.get(windowId) === lost && lost.token === token
      && this.admissible(owner);
    this.read({ kind: "pane", session: this.sessionName, window: windowId, field: "id" }).finally(() => {
      lost.inFlight = false;
    }).then((output) => {
      const paneId = output.trim();
      if (!current() || !paneId) return;
      this.lostWindows.delete(windowId);
      this.registeredWindows.add(windowId);
      this.registrationTokens.set(windowId, token);
      this.resolveFailures.delete(windowId);
      this.paneToWindow.set(paneId, windowId);
      this.recoveredAt.set(windowId, this.mono());
      this.logger?.info({ windowId, paneId }, "Lost window resolved again — re-registered");
    }, () => { /* still lost; the next question retries */ });
  }

  /** Timestamp of the window pane's last observed output, or undefined if unknown. */
  getLastOutputAt(windowId: string): number | undefined {
    const paneId = this.windowToPaneId(windowId);
    if (!paneId) return undefined;
    return this.lastOutputAt.get(paneId);
  }

  /** True if the window's pane produced output strictly after `ts` (an idle→busy transition). */
  hasOutputSince(windowId: string, ts: number): boolean {
    const last = this.getLastOutputAt(windowId);
    return last != null && last > ts;
  }

  // PLACEHOLDER_WAIT

  /**
   * Wait until a window's pane is idle (no output for silenceMs).
   * Returns true if idle detected, false if timeout reached.
   */
  waitForIdle(windowId: string, timeoutMs = 30_000): Promise<boolean> {
    if (this.isIdle(windowId)) return Promise.resolve(true);

    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.isIdle(windowId)) {
          clearInterval(check);
          clearTimeout(timer);
          resolve(true);
        }
      }, 200);

      const timer = setTimeout(() => {
        clearInterval(check);
        this.logger?.warn({ windowId, timeoutMs }, "waitForIdle timed out — forcing delivery");
        resolve(false);
      }, timeoutMs);
    });
  }

  /**
   * Wait until a window's pane is idle. Used by message delivery to queue behind a
   * busy CLI and deliver the moment it frees up, rather than force-pasting.
   *
   * Resolves `true` on idle (or if the control client stops), `false` if
   * `timeoutMs` elapsed first. This used to have NO timeout at all, so a wedged
   * pane held the pasteLock forever and every message behind it queued silently
   * with no ❌ and no log — the caller believed delivery was merely slow. A very
   * long default keeps the "a busy CLI is not a lost message" behaviour while
   * putting a floor under how long a wedge can absorb the queue unnoticed.
   */
  waitUntilIdle(windowId: string, timeoutMs = 30 * 60_000): Promise<boolean> {
    if (this.isIdle(windowId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.stopped || this.isIdle(windowId)) {
          clearInterval(check);
          clearTimeout(timer);
          resolve(true);
        }
      }, 200);
      const timer = setTimeout(() => {
        clearInterval(check);
        this.logger?.warn({ windowId, timeoutMs }, "waitUntilIdle timed out — pane appears wedged");
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  /**
   * Wait until a window's pane produces any output.
   * Used to verify CLI startup — if no output within timeout, CLI likely failed.
   */
  waitForOutput(windowId: string, timeoutMs = 15_000): Promise<boolean> {
    const paneId = this.windowToPaneId(windowId);
    // If already has output recorded, it's alive
    if (paneId && this.lastOutputAt.has(paneId)) return Promise.resolve(true);

    return new Promise((resolve) => {
      const check = setInterval(() => {
        const pid = this.windowToPaneId(windowId);
        if (pid && this.lastOutputAt.has(pid)) {
          clearInterval(check);
          clearTimeout(timer);
          resolve(true);
        }
      }, 300);

      const timer = setTimeout(() => {
        clearInterval(check);
        resolve(false);
      }, timeoutMs);
    });
  }

  private windowToPaneId(windowId: string): string | undefined {
    for (const [pane, win] of this.paneToWindow) {
      if (win === windowId) return pane;
    }
    return undefined;
  }

  private connect(): void {
    if (this.stopped || this.attachment) return;
    if (performance.now() < this.reconnectAfter) { this.scheduleReconnect(); return; }

    // Pane IDs are tmux-server-scoped: a server restart (or a long-enough
    // disconnect that windows churned) can leave our cached paneId →
    // windowId mapping pointing at a stale or recycled pane. Drop the
    // cache and re-resolve every registered window from the new server.
    this.resetPaneObservations();

    // This is an observation-only client with no real terminal geometry.
    // `ignore-size` prevents tmux's `window-size=latest` policy from treating
    // its synthetic dimensions as authoritative. This flag is now load-bearing,
    // not defense in depth: instance windows use `window-size latest` (see
    // TmuxManager.applyLogicalSize) so a human `tmux attach` can resize them, and
    // without `ignore-size` this client would collapse them to 80 columns.
    //
    // Do NOT add `-r` here. tmux 3.7 tightened read-only client handling so an
    // otherwise unrelated `tmux send-keys -t <pane> Enter` resolves this sole
    // attached client, rejects the key with "client is read-only", and leaves a
    // successfully pasted message sitting unsubmitted. The control process is a
    // trusted child whose stdin is owned by this FleetManager; writable control
    // mode does not grant a capability the same OS user does not already have.
    const args = ["-C", "attach", "-f", "ignore-size", "-t", this.sessionName];
    let proc: ChildProcess;
    try {
      proc = measureSyncWork("tmux.spawn", () => spawn("tmux", this.socket ? ["-L", this.socket, ...args] : args,
        { stdio: ["pipe", "pipe", "pipe"] }));
    } catch {
      this.reconnectAfter = performance.now() + RECONNECT_MS;
      this.scheduleReconnect();
      return;
    }
    const owner: Attachment = { proc, retired: false, released: false, ready: false,
      attachGuard: null, decoder: new StringDecoder("utf8"), pending: "" };
    this.attachment = owner;
    owner.timer = setTimeout(() => this.retire(owner), 10_000);
    owner.timer.unref?.();
    proc.stdout?.on("data", (chunk: Buffer | string) => this.receive(owner, chunk));
    proc.stdout?.on("error", () => this.retire(owner));
    // Drain stderr without retaining/logging pane or protocol content.
    proc.stderr?.on("data", () => {});
    proc.stdin?.on("error", () => this.retire(owner));
    proc.once("exit", () => this.release(owner));
    proc.once("close", () => this.release(owner));
    proc.on("error", () => {
      this.retire(owner);
      if (proc.pid === undefined) this.release(owner); // confirmed no-child spawn failure
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.attachment || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, Math.max(0, Math.ceil(this.reconnectAfter - performance.now())));
    this.reconnectTimer.unref?.();
  }

  private release(owner: Attachment): void {
    if (owner.released) return;
    owner.released = true;
    this.retire(owner);
    if (this.attachment !== owner) return;
    this.attachment = null;
    this.scheduleReconnect();
  }

  private retire(owner: Attachment): void {
    if (this.attachment !== owner || owner.retired) return;
    owner.retired = true;
    owner.ready = false;
    clearTimeout(owner.timer);
    owner.pending = "";
    this.reconnectAfter = performance.now() + RECONNECT_MS;
    this.resetPaneObservations();
    const read = this.activeRead;
    if (read?.owner === owner) {
      this.activeRead = null;
      clearTimeout(read.timer);
      read.reject(new TmuxReadError("transport", "tmux control transport unavailable"));
    }
    // killed/kill success is NOT exit proof; keep attachment until release().
    if (!owner.released) {
      try { owner.proc.kill(); } catch { /* no exit proof: retain physical reservation */ }
    }
  }

  private receive(owner: Attachment, chunk: Buffer | string): void {
    if (this.attachment !== owner || owner.retired) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
      owner.pending += owner.decoder.write(bytes.subarray(offset, offset + 16 * 1024));
      let end: number;
      while ((end = owner.pending.indexOf("\n")) !== -1) {
        const line = owner.pending.slice(0, end);
        owner.pending = owner.pending.slice(end + 1);
        if (Buffer.byteLength(line) > TMUX_READ_MAX_BYTES + FRAME_OVERHEAD_BYTES) { this.retire(owner); return; }
        this.parseLine(line, owner);
        if (this.attachment !== owner || owner.retired) return;
      }
      if (Buffer.byteLength(owner.pending) > TMUX_READ_MAX_BYTES + FRAME_OVERHEAD_BYTES) { this.retire(owner); return; }
    }
  }

  private executeRead(args: string[], deadline: number): Promise<string> {
    const owner = this.attachment;
    if (!owner?.ready || owner.retired || this.activeRead) {
      return Promise.reject(new TmuxReadError("transport", "tmux control unavailable"));
    }
    return new Promise((resolve, reject) => {
      const read: ControlRead = { owner, nonce: `agend-read-${randomUUID()}`, guard: null,
        lines: [], bytes: 0, deadline, resolve, reject,
        timer: setTimeout(() => this.retire(owner), Math.max(1, Math.ceil(deadline - performance.now()))) };
      this.activeRead = read;
      try {
        const command = args.map(tmuxCommandToken).join(" ");
        const payload = `${command}\ndisplay-message -p ${tmuxCommandToken(read.nonce)}\n`;
        if (performance.now() >= deadline) { this.retire(owner); return; }
        owner.proc.stdin!.write(payload, error => {
          if (error) this.retire(owner);
        });
      } catch { this.retire(owner); }
    });
  }

  private parseLine(line: string, owner = this.attachment): void {
    if (owner && (owner !== this.attachment || owner.retired)) return;
    if (owner && !owner.ready) {
      if (!owner.attachGuard) {
        const begin = line.match(/^%begin (\d+ \d+ 0)$/);
        if (begin) owner.attachGuard = begin[1];
      } else if (line === `%end ${owner.attachGuard}`) {
        owner.ready = true;
        clearTimeout(owner.timer);
        this.reads.wake();
        for (const window of this.registeredWindows) void this.resolvePane(window);
      } else if (line === `%error ${owner.attachGuard}`) this.retire(owner);
      if (line.startsWith("%exit")) this.retire(owner);
      return;
    }
    const read = this.activeRead;
    if (read && read.owner === owner) {
      if (!read.guard) {
        const begin = line.match(/^%begin (\d+ \d+ 1)$/);
        if (begin) { read.guard = begin[1]; return; }
      } else {
        // Payload may contain %output or even a matching %end. Only the fresh
        // nonce's complete frame proves where the read really ended.
        read.lines.push(line);
        read.bytes += Buffer.byteLength(line) + 1;
        if (read.bytes > TMUX_READ_MAX_BYTES + FRAME_OVERHEAD_BYTES) { this.retire(read.owner); return; }
        const length = read.lines.length;
        const trailer = read.lines[length - 3]?.match(/^%begin (\d+ \d+ 1)$/);
        if (trailer && read.lines[length - 2] === read.nonce && line === `%end ${trailer[1]}`) {
          if (performance.now() >= read.deadline) { this.retire(read.owner); return; }
          let footer = length - 4;
          while (footer >= 0 && read.lines[footer] !== `%end ${read.guard}` && read.lines[footer] !== `%error ${read.guard}`) footer--;
          if (footer < 0) { this.retire(read.owner); return; }
          const data = read.lines.slice(0, footer);
          const output = data.length ? data.join("\n") + "\n" : "";
          if (Buffer.byteLength(output) > TMUX_READ_MAX_BYTES) { this.retire(read.owner); return; }
          this.activeRead = null;
          clearTimeout(read.timer);
          // Notifications between the real footer and trailer remain visible;
          // capture body lines never become activity evidence.
          for (const notification of read.lines.slice(footer + 1, length - 3)) this.observeOutput(notification);
          if (read.lines[footer].startsWith("%error")) read.reject(new TmuxReadError("command", "tmux control read failed"));
          else read.resolve(output);
        }
        return;
      }
    }
    if (line.startsWith("%exit") && owner) { this.retire(owner); return; }
    this.observeOutput(line);
  }

  private observeOutput(line: string): void {
    if (line.startsWith("%output ")) {
      const match = line.match(/^%output (%\d+) /);
      if (match) {
        const at = Date.now();
        const paneId = match[1];
        const windowId = this.paneToWindow.get(paneId);
        this.lastOutputAt.set(paneId, at);
        if (windowId) {
          // Scope hot-path output events by window so one active TUI does not
          // wake every daemon listener in a large fleet.
          this.emit(`output:${windowId}`, { paneId, windowId, at } satisfies TmuxPaneOutputEvent);
        }
      }
    }
  }

  private cleanup(): void {
    if (this.attachment) this.retire(this.attachment);
  }
}
