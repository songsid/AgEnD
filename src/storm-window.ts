import { EventEmitter } from "node:events";

export type StormPhase = "closed" | "backing_off" | "recovering";

export interface StormSnapshot {
  phase: StormPhase;
  generation: number;
  crashLevel: number;
  crashCount: number;
  backoffMs: number;
  retryAt: number | null;
  affected: string[];
  recovered: string[];
  suppressed: Record<string, number>;
  serverPid: number | null;
}

export interface StormWindowOptions {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  backoffsMs?: readonly number[];
  stableResetMs?: number;
  recoveryTimeoutMs?: number;
}

const STORM_INCIDENT_KINDS = new Set([
  "crash_respawn",
  "mcp_died",
  "mcp_auto_restart",
  "snapshot_failed",
  "hang",
  "health_check_error",
]);

/**
 * Fleet-wide tmux-server storm state.
 *
 * A server death is counted on an observed alive -> dead transition, not once
 * per daemon report. Health ticks are deliberately out of phase, so a time
 * window cannot distinguish thirty reports of one death from a real second
 * crash sixteen seconds later.
 */
export class StormWindow extends EventEmitter {
  private readonly now: () => number;
  private readonly setTimer: StormWindowOptions["setTimer"];
  private readonly clearTimer: StormWindowOptions["clearTimer"];
  private readonly backoffsMs: readonly number[];
  private readonly stableResetMs: number;
  private readonly recoveryTimeoutMs: number;
  private phase: StormPhase = "closed";
  private generation = 0;
  private crashLevel = 0;
  private crashCount = 0;
  private backoffMs = 0;
  private retryAt: number | null = null;
  private serverDown = false;
  private serverPid: number | null = null;
  private affected = new Set<string>();
  private recovered = new Set<string>();
  private suppressed = new Map<string, number>();
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private spawnWaiters = new Set<() => void>();
  private deliveryWaiters = new Set<() => void>();
  private stopped = false;

  constructor(options: StormWindowOptions = {}) {
    super();
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.backoffsMs = options.backoffsMs ?? [30_000, 2 * 60_000, 10 * 60_000];
    this.stableResetMs = options.stableResetMs ?? 10 * 60_000;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? 10 * 60_000;
  }

  snapshot(): StormSnapshot {
    return {
      phase: this.phase,
      generation: this.generation,
      crashLevel: this.crashLevel,
      crashCount: this.crashCount,
      backoffMs: this.backoffMs,
      retryAt: this.retryAt,
      affected: [...this.affected],
      recovered: [...this.recovered],
      suppressed: Object.fromEntries(this.suppressed),
      serverPid: this.serverPid,
    };
  }

  isActive(): boolean { return this.phase !== "closed"; }
  isStopped(): boolean { return this.stopped; }
  isSpawnBlocked(): boolean { return !this.stopped && this.phase === "backing_off"; }
  isDeliveryHeld(): boolean { return !this.stopped && this.phase !== "closed"; }

  /** Record a confirmed tmux-server absence. Returns true for a new transition. */
  recordServerDead(reporter: string, affected: Iterable<string>): boolean {
    for (const name of affected) this.affected.add(name);
    this.affected.add(reporter);
    this.recovered.delete(reporter);
    if (this.serverDown) return false;
    this.serverDown = true;
    this.serverPid = null;
    this.recordDistinctCrash();
    return true;
  }

  /**
   * Mark the server alive. A changed PID re-arms the generation latch. If a
   * storm is already open, an unexpected PID swap is itself evidence that a
   * crash/restart transition occurred between probes.
   */
  observeServerAlive(pid: number | null): boolean {
    const changed = pid != null && this.serverPid != null && pid !== this.serverPid;
    const wasDown = this.serverDown;
    this.serverDown = false;
    if (pid != null) this.serverPid = pid;
    if (changed && !wasDown) this.recordDistinctCrash();
    return changed && !wasDown;
  }

  addAffected(name: string): void {
    if (!this.isActive()) return;
    this.affected.add(name);
    this.recovered.delete(name);
  }

  markRecovered(name: string): void {
    if (!this.isActive() || !this.affected.has(name)) return;
    this.recovered.add(name);
    this.emit("progress", this.snapshot());
    if (this.phase === "recovering" && this.recovered.size >= this.affected.size) {
      this.closeWindow("recovered");
    }
  }

  shouldSuppress(kind: string): boolean {
    if (!this.isActive() || !STORM_INCIDENT_KINDS.has(kind)) return false;
    this.suppressed.set(kind, (this.suppressed.get(kind) ?? 0) + 1);
    return true;
  }

  waitForSpawnAllowed(): Promise<void> {
    if (!this.isSpawnBlocked()) return Promise.resolve();
    return new Promise(resolve => this.spawnWaiters.add(resolve));
  }

  waitForDeliveryAllowed(): Promise<void> {
    if (!this.isDeliveryHeld()) return Promise.resolve();
    return new Promise(resolve => this.deliveryWaiters.add(resolve));
  }

  shutdown(): void {
    this.stopped = true;
    this.clearAllTimers();
    this.release(this.spawnWaiters);
    this.release(this.deliveryWaiters);
    this.phase = "closed";
  }

  private recordDistinctCrash(): void {
    const now = this.now();
    const wasClosed = this.phase === "closed";
    this.generation++;
    this.crashCount++;
    this.crashLevel = Math.min(this.crashLevel + 1, this.backoffsMs.length);
    this.backoffMs = this.backoffsMs[Math.max(0, this.crashLevel - 1)] ?? this.backoffsMs.at(-1)!;
    this.retryAt = now + this.backoffMs;
    this.phase = "backing_off";
    this.recovered.clear();
    if (this.backoffTimer) this.clearTimer!(this.backoffTimer);
    if (this.recoveryTimer) { this.clearTimer!(this.recoveryTimer); this.recoveryTimer = null; }
    this.backoffTimer = this.setTimer!(() => this.beginRecovery(), this.backoffMs);
    (this.backoffTimer as any)?.unref?.();
    if (this.stableTimer) this.clearTimer!(this.stableTimer);
    this.stableTimer = this.setTimer!(() => {
      this.crashLevel = 0;
      this.crashCount = 0;
      this.stableTimer = null;
      this.emit("stable", this.snapshot());
    }, this.stableResetMs);
    (this.stableTimer as any)?.unref?.();
    this.emit(wasClosed ? "opened" : "extended", this.snapshot());
  }

  private beginRecovery(): void {
    this.backoffTimer = null;
    if (this.stopped || this.phase !== "backing_off") return;
    this.phase = "recovering";
    this.retryAt = null;
    this.release(this.spawnWaiters);
    this.emit("recovery_due", this.snapshot());
    this.recoveryTimer = this.setTimer!(() => this.closeWindow("timeout"), this.recoveryTimeoutMs);
    (this.recoveryTimer as any)?.unref?.();
  }

  private closeWindow(reason: "recovered" | "timeout"): void {
    if (this.phase === "closed") return;
    if (this.backoffTimer) { this.clearTimer!(this.backoffTimer); this.backoffTimer = null; }
    if (this.recoveryTimer) { this.clearTimer!(this.recoveryTimer); this.recoveryTimer = null; }
    this.phase = "closed";
    this.retryAt = null;
    const snapshot = this.snapshot();
    this.release(this.spawnWaiters);
    this.release(this.deliveryWaiters);
    this.emit("closed", snapshot, reason);
    this.affected.clear();
    this.recovered.clear();
    this.suppressed.clear();
  }

  private release(waiters: Set<() => void>): void {
    for (const resolve of waiters) resolve();
    waiters.clear();
  }

  private clearAllTimers(): void {
    for (const timer of [this.backoffTimer, this.stableTimer, this.recoveryTimer]) {
      if (timer) this.clearTimer!(timer);
    }
    this.backoffTimer = this.stableTimer = this.recoveryTimer = null;
  }
}
