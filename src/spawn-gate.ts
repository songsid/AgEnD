import { freemem } from "node:os";
import type { StormWindow } from "./storm-window.js";

export interface SpawnTask {
  instanceName: string;
  workingDirectory: string;
  reason: "startup" | "wake" | "recovery" | "restart";
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
}

/** Persistent fleet-wide concurrency/workdir gate shared by startup and recovery. */
export class SpawnGate {
  private queue: QueuedTask[] = [];
  private active = 0;
  private activeDirectories = new Set<string>();
  private activeInstances = new Set<string>();
  private lastStartedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly random: () => number;
  private readonly lowMemoryBytes: number;

  constructor(private readonly options: SpawnGateOptions) {
    this.random = options.random ?? Math.random;
    this.lowMemoryBytes = options.lowMemoryBytes ?? 300 * 1024 * 1024;
    options.storm.on("recovery_due", () => this.pump());
    options.storm.on("closed", () => this.pump());
  }

  run<T>(task: SpawnTask, operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Spawn gate is shutting down"));
    // startInstancesWithConcurrency/restartSingleInstance gate the whole
    // lifecycle operation, whose Daemon.trySpawn reaches this same choke point.
    // Treat that nested acquisition as re-entrant for the same instance.
    if (this.activeInstances.has(task.instanceName)) return operation();
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, run: operation, resolve, reject } as QueuedTask);
      this.pump();
    });
  }

  shutdown(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const err = new Error("Spawn gate shut down before task started");
    for (const item of this.queue.splice(0)) item.reject(err);
  }

  private pump(): void {
    if (this.stopped || this.timer || this.options.storm.isSpawnBlocked()) return;
    const configured = Math.max(1, Math.min(20, this.options.concurrency()));
    const limit = this.options.storm.isActive() ? Math.min(4, configured) : configured;
    while (this.active < limit) {
      const index = this.queue.findIndex(item => !this.activeDirectories.has(item.task.workingDirectory));
      if (index < 0) return;
      if (this.active > 0 && freemem() < this.lowMemoryBytes) {
        this.timer = setTimeout(() => { this.timer = null; this.pump(); }, 5_000);
        this.timer.unref?.();
        return;
      }
      const stagger = Math.max(0, Math.min(30_000, this.options.staggerMs()));
      const jitter = this.options.storm.isActive() ? Math.floor(this.random() * 500) : 0;
      const wait = Math.max(0, this.lastStartedAt + stagger + jitter - Date.now());
      if (wait > 0) {
        this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
        this.timer.unref?.();
        return;
      }
      const [item] = this.queue.splice(index, 1);
      this.active++;
      this.activeDirectories.add(item.task.workingDirectory);
      this.activeInstances.add(item.task.instanceName);
      this.lastStartedAt = Date.now();
      void item.run().then(item.resolve, item.reject).finally(() => {
        this.active--;
        this.activeDirectories.delete(item.task.workingDirectory);
        this.activeInstances.delete(item.task.instanceName);
        this.pump();
      });
    }
  }
}
