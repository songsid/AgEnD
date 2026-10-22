/** Keep a live, deliberately memory-deferred startup out of systemd's kill/restart loop. */
export const STARTUP_MEMORY_EXTENSION_US = 15 * 60 * 1_000_000;
export const STARTUP_MEMORY_TICK_MS = 30_000;

export class StartupMemoryDeadline {
  private timer: ReturnType<typeof setInterval> | null;
  private stopped = false;
  private held = false;
  private lastSent = -Infinity;
  private lastLog = -Infinity;

  constructor(private readonly deps: {
    current(): boolean;
    waiting(): boolean;
    notify(state: string): void;
    log(message: string): void;
    now?: () => number;
  }) {
    this.timer = setInterval(() => this.check(), STARTUP_MEMORY_TICK_MS);
    this.timer.unref?.();
  }

  /** Called immediately by a policy wait as well as periodically while it lasts. */
  check(): void {
    if (this.stopped) return;
    if (!this.deps.current()) { this.stop(); return; }
    if (!this.deps.waiting()) {
      if (this.held) {
        this.held = false;
        this.deps.log("Fleet startup memory wait ended; the normal startup deadline applies after the last extension");
        this.deps.notify("STATUS=Fleet startup continuing after memory wait");
      }
      return;
    }
    const now = this.deps.now?.() ?? performance.now();
    if (now - this.lastSent < STARTUP_MEMORY_TICK_MS) return;
    this.lastSent = now;
    this.held = true;
    this.deps.notify(`EXTEND_TIMEOUT_USEC=${STARTUP_MEMORY_EXTENSION_US}\nSTATUS=Fleet startup waiting for host memory; queued CLI spawns are deferred`);
    if (now - this.lastLog >= 10 * 60_000) {
      this.lastLog = now;
      this.deps.log("Fleet startup waiting for host memory — renewing systemd startup timeout by 15 minutes; READY is not sent");
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Stops free memory; bound their concurrency without ever waiting for recovery. */
export function fleetStopConcurrency(count: number, pressure: string): number {
  const normal = count > 30 ? 15 : count >= 10 ? 10 : 5;
  return pressure === "critical" || pressure === "elevated" ? Math.min(5, normal) : normal;
}
