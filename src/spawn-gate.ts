import { MemoryPressure } from "./memory-pressure.js";
import type { StormWindow } from "./storm-window.js";

export interface SpawnTask {
  instanceName: string;
  workingDirectory: string;
  reason: "startup" | "wake" | "recovery" | "restart";
  /** Outer fleet operations reserve a slot before their Daemon.trySpawn call. */
  stage?: "lifecycle";
}

interface QueuedTask<T = unknown> {
  task: SpawnTask;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export interface SpawnGateOptions {
  storm: StormWindow;
  concurrency: () => number;
  staggerMs: () => number;
  random?: () => number;
  lowMemoryBytes?: number;
  memoryPressure?: MemoryPressure;
}

/** Persistent fleet-wide concurrency/workdir gate shared by startup and recovery. */
export class SpawnGate {
  private queue: QueuedTask[] = [];
  private nestedQueue: QueuedTask[] = [];
  private active = 0;
  private physicalActive = 0;
  private activeDirectories = new Set<string>();
  private activeInstances = new Set<string>();
  private lastStartedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private capacityWait = false;
  private stopped = false;
  private pumping = false;
  private pressureRetryMs = 5_000;
  private pressureHeld = false;
  private readonly random: () => number;
  private readonly memoryPressure: MemoryPressure;
  private readonly onStormReady = () => this.pump();

  constructor(private readonly options: SpawnGateOptions) {
    this.random = options.random ?? Math.random;
    this.memoryPressure = options.memoryPressure ?? new MemoryPressure({ criticalBytes: options.lowMemoryBytes });
    options.storm.on("recovery_due", this.onStormReady);
    options.storm.on("closed", this.onStormReady);
  }

  run<T>(task: SpawnTask, operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Spawn gate is shutting down"));
    // startInstancesWithConcurrency/restartSingleInstance gate the whole
    // lifecycle operation, whose Daemon.trySpawn reaches this same choke point.
    // Keep the outer concurrency/workdir reservation, but recheck pressure
    // before the nested physical spawn. Reacquiring its own slot would deadlock.
    return new Promise<T>((resolve, reject) => {
      const queue = this.activeInstances.has(task.instanceName) ? this.nestedQueue : this.queue;
      queue.push({ task, run: operation, resolve, reject } as QueuedTask);
      this.pump();
    });
  }

  shutdown(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.options.storm.off("recovery_due", this.onStormReady);
    this.options.storm.off("closed", this.onStormReady);
    const err = new Error("Spawn gate shut down before task started");
    for (const item of this.queue.splice(0)) item.reject(err);
    for (const item of this.nestedQueue.splice(0)) item.reject(err);
  }

  private wait(ms: number, capacityWait = false): void {
    this.capacityWait = capacityWait;
    this.timer = setTimeout(() => { this.timer = null; this.capacityWait = false; this.pump(); }, ms);
    this.timer.unref?.();
  }

  private pump(): void {
    if (this.stopped || this.pumping || this.timer || this.options.storm.isSpawnBlocked()) return;
    this.pumping = true;
    try {
      while (!this.stopped) {
        const index = this.queue.findIndex(item => !this.activeDirectories.has(item.task.workingDirectory));
        if (this.nestedQueue.length === 0 && index < 0) return;
        // Explicit zero preserves the existing deterministic test/embedding opt-out.
        let pressure = this.options.lowMemoryBytes === 0 ? "normal" : this.memoryPressure.sample().level;
        if (this.stopped) return;
        if (pressure === "critical") {
          this.pressureHeld = true;
          this.wait(this.pressureRetryMs);
          this.pressureRetryMs = Math.min(60_000, this.pressureRetryMs * 2);
          return;
        }
        if (this.pressureHeld) {
          pressure = this.memoryPressure.startRecoveryWindow().level;
          this.pressureHeld = false;
        }
        this.pressureRetryMs = 5_000;
        const configured = Math.max(1, Math.min(20, this.options.concurrency()));
        const limit = Math.min(pressure === "normal" ? configured : 1, this.options.storm.isActive() ? 4 : configured);
        const nested = this.nestedQueue.length > 0;
        const physical = (nested ? this.nestedQueue[0] : this.queue[index]).task.stage !== "lifecycle";
        if (pressure !== "normal" && physical && this.physicalActive > 0) {
          this.wait(5_000, true);
          return;
        }
        if (!nested && this.active >= limit) {
          // Recovery must be able to raise the limit without waiting for a
          // long-running outer lifecycle callback to release its slot.
          if (pressure !== "normal") this.wait(5_000, true);
          return;
        }
        const stagger = Math.max(0, Math.min(30_000, this.options.staggerMs()), pressure === "normal" ? 0 : 5_000);
        const jitter = this.options.storm.isActive() ? Math.floor(this.random() * 500) : 0;
        // A healthy nested acquisition already owns its outer admission slot.
        const delay = nested && pressure === "normal" ? 0 : Math.max(0, this.lastStartedAt + stagger + jitter - Date.now());
        if (delay > 0) { this.wait(delay); return; }
        const [item] = nested ? this.nestedQueue.splice(0, 1) : this.queue.splice(index, 1);
        if (!nested) {
          this.active++;
          this.activeDirectories.add(item.task.workingDirectory);
          this.activeInstances.add(item.task.instanceName);
        }
        if (physical) this.physicalActive++;
        this.lastStartedAt = Date.now();
        let operation: Promise<unknown>;
        try { operation = item.run(); } catch (err) { operation = Promise.reject(err); }
        void operation.then(item.resolve, item.reject).finally(() => {
          if (physical) this.physicalActive--;
          if (!nested) {
            this.active--;
            this.activeDirectories.delete(item.task.workingDirectory);
            this.activeInstances.delete(item.task.instanceName);
          }
          if (this.capacityWait && this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
            this.capacityWait = false;
          }
          this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }
}
