import { spawn, execFile, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";
import type { Logger } from "./logger.js";
import { getTmuxSocketName } from "./paths.js";

export interface TmuxPaneOutputEvent {
  paneId: string;
  windowId?: string;
  at: number;
}

export const CONTROL_SAFETY_SWEEP_MS = 60_000;

function tmuxArgs(args: string[]): string[] {
  const socket = getTmuxSocketName();
  return socket ? ["-L", socket, ...args] : args;
}

function execTmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", tmuxArgs(args), (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

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
export class TmuxControlClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private lastOutputAt = new Map<string, number>(); // paneId → timestamp
  private paneToWindow = new Map<string, string>();  // paneId → windowId
  private registeredWindows = new Set<string>();    // windowIds we should re-resolve on reconnect
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Epoch ms until which "no output recorded" must not be read as "idle". */
  private observationGraceUntil = 0;
  private safetySweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sessionName: string,
    private silenceMs: number = 2000,
    private logger?: Logger,
  ) {
    super();
    // One shared control client intentionally has one listener per daemon.
    this.setMaxListeners(0);
  }

  start(): void {
    this.stopped = false;
    if (!this.safetySweepTimer) {
      this.safetySweepTimer = setInterval(() => {
        this.emit("safety_sweep", { at: Date.now() });
      }, CONTROL_SAFETY_SWEEP_MS);
    }
    this.connect();
  }

  // PLACEHOLDER_REST

  stop(): void {
    this.stopped = true;
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

  /**
   * Register a window so we can track its pane's output.
   * Call this after createWindow().
   */
  async registerWindow(windowId: string): Promise<void> {
    this.registeredWindows.add(windowId);
    await this.resolvePane(windowId);
  }

  /** Unregister a window (call on killWindow) */
  unregisterWindow(windowId: string): void {
    this.registeredWindows.delete(windowId);
    for (const [pane, win] of this.paneToWindow) {
      if (win === windowId) {
        this.paneToWindow.delete(pane);
        this.lastOutputAt.delete(pane);
        break;
      }
    }
  }

  /** Resolve a window's current pane id and cache the mapping. */
  private async resolvePane(windowId: string): Promise<void> {
    try {
      const paneId = await execTmux([
        "list-panes", "-t", `${this.sessionName}:${windowId}`,
        "-F", "#{pane_id}",
      ]);
      if (paneId) {
        this.paneToWindow.set(paneId, windowId);
        this.logger?.debug({ windowId, paneId }, "Registered window→pane mapping");
      }
    } catch {
      this.logger?.debug({ windowId }, "Failed to resolve pane ID for window");
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
    this.observationGraceUntil = Date.now() + this.silenceMs;
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
    return Date.now() < this.observationGraceUntil;
  }

  /** Check if a window's pane has been silent for at least silenceMs */
  isIdle(windowId: string): boolean {
    const paneId = this.windowToPaneId(windowId);
    // "Unknown" means unknown, not idle — but only while that ignorance is fresh.
    // After the grace we fall back to the old optimistic answer, because a window
    // that is genuinely untracked (never registered, or resolve failed) must not
    // block delivery forever.
    if (!paneId) return !this.inObservationGrace();
    const last = this.lastOutputAt.get(paneId);
    if (last == null) return !this.inObservationGrace();
    return Date.now() - last >= this.silenceMs;
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
    if (this.stopped) return;

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
    this.proc = spawn("tmux", tmuxArgs([
      "-C", "attach", "-f", "ignore-size", "-t", this.sessionName, "-r",
    ]), {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => this.parseLine(line));

    this.proc.on("close", () => {
      this.cleanup();
      if (!this.stopped) {
        this.logger?.debug("Control mode disconnected — reconnecting in 2s");
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    });

    this.proc.on("error", (err) => {
      this.logger?.warn({ err: (err as Error).message }, "Control mode spawn error");
    });

    // Re-resolve panes for any windows that were registered before this
    // (re)connect. Safe even on first connect: registeredWindows is empty.
    for (const windowId of this.registeredWindows) {
      void this.resolvePane(windowId);
    }

    this.logger?.debug("tmux control mode connected");
  }

  private parseLine(line: string): void {
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
    this.rl?.close();
    this.rl = null;
    if (this.proc && !this.proc.killed) {
      this.proc.stdin?.write("detach\n");
      this.proc.kill();
    }
    this.proc = null;
  }
}
