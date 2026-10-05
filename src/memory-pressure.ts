import { readHostMemory, type HostMemory } from "./host-memory.js";
import { platform } from "node:os";

export type MemoryPressureLevel = "normal" | "elevated" | "critical" | "unknown";
export interface MemoryPressureSnapshot {
  level: MemoryPressureLevel;
  memory: HostMemory | null;
  sampledAt: number | null;
  recovering: boolean;
  samples: number;
  /** Change per minute over the bounded observation window; negative means draining. */
  trend: { availableBytesPerMinute: number; swapFreeBytesPerMinute: number | null } | null;
}

interface Options {
  platform?: NodeJS.Platform;
  read?: () => HostMemory;
  now?: () => number;
  onSample?: (snapshot: MemoryPressureSnapshot) => void;
  criticalBytes?: number;
}

const MiB = 1024 * 1024;
export const MEMORY_SAMPLE_MS = 30_000;
export const MEMORY_RECOVERY_MS = 30_000;

/** One fleet sampler/policy, shared by spawn admission and health. No subprocesses. */
export class MemoryPressure {
  readonly platform: NodeJS.Platform;
  private readonly read: () => HostMemory;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private history: Array<{ at: number; memory: HostMemory & { availableBytes: number } }> = [];
  private listeners = new Set<(snapshot: MemoryPressureSnapshot) => void>();
  private recoveryUntil = 0;
  private current: MemoryPressureSnapshot = {
    level: "unknown", memory: null, sampledAt: null, recovering: false, samples: 0, trend: null,
  };

  constructor(private readonly options: Options = {}) {
    this.platform = options.platform ?? platform();
    this.read = options.read ?? (() => readHostMemory({ platform: this.platform }));
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), MEMORY_SAMPLE_MS);
    this.timer.unref?.();
    this.sample();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Sampling may detect recovery before a long admission backoff expires. */
  startRecoveryWindow(): MemoryPressureSnapshot {
    if (this.allowsUnknown()) return this.snapshot();
    this.recoveryUntil = this.now() + MEMORY_RECOVERY_MS;
    this.current = { ...this.current, recovering: true,
      level: this.current.level === "normal" ? "elevated" : this.current.level };
    return this.snapshot();
  }

  /** Health readers cannot create samples or move recovery deadlines. */
  snapshot(): MemoryPressureSnapshot {
    return { ...this.current, memory: this.current.memory && { ...this.current.memory }, trend: this.current.trend && { ...this.current.trend } };
  }

  /** Only macOS opts out of memory restrictions when no reliable sample exists. */
  allowsUnknown(snapshot: MemoryPressureSnapshot = this.current): boolean {
    return this.platform === "darwin" && snapshot.level === "unknown";
  }

  onUpdate(listener: (snapshot: MemoryPressureSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  sample(): MemoryPressureSnapshot {
    const at = this.now();
    let memory: (HostMemory & { availableBytes: number }) | null = null;
    try {
      const value = this.read();
      if (Number.isFinite(value.totalBytes) && value.totalBytes > 0
        && value.availableBytes !== null && Number.isFinite(value.availableBytes) && value.availableBytes >= 0 && value.availableBytes <= value.totalBytes
        && (this.platform !== "darwin" || value.availableKind === "available")) {
        memory = { ...value, availableBytes: value.availableBytes };
        if (value.swapTotalBytes === null || value.swapFreeBytes === null
          || !Number.isFinite(value.swapTotalBytes) || !Number.isFinite(value.swapFreeBytes)
          || value.swapTotalBytes < 0 || value.swapFreeBytes < 0 || value.swapFreeBytes > value.swapTotalBytes) {
          memory.swapTotalBytes = memory.swapFreeBytes = null;
        }
      }
    } catch { /* Unavailable data slows admissions; it cannot deadlock the fleet. */ }

    let level: MemoryPressureLevel = "unknown";
    if (memory) {
      const critical = Math.max(this.options.criticalBytes ?? 300 * MiB, memory.totalBytes * 0.02);
      const low = Math.max(critical * 2, memory.totalBytes * 0.05);
      const swapRatio = memory.swapTotalBytes && memory.swapFreeBytes !== null
        ? memory.swapFreeBytes / memory.swapTotalBytes : null;
      const swapTight = swapRatio !== null && swapRatio <= 0.05;
      const criticalNow = memory.availableKind === "available"
        && (memory.availableBytes < critical || (memory.availableBytes < low && swapTight));
      // MemFree alone cannot distinguish healthy reclaimable cache from pressure.
      // It can throttle, but must never impose an indefinite Linux procfs-failure hold.
      if (criticalNow || (this.current.level === "critical"
        && memory.availableKind === "available" && memory.availableBytes < critical * 1.5)) {
        level = "critical";
        this.recoveryUntil = 0;
      } else {
        if (this.current.level === "critical") this.recoveryUntil = at + MEMORY_RECOVERY_MS;
        const lingering = this.current.level === "elevated"
          && (memory.availableBytes < low * 1.2 || (swapRatio !== null && swapRatio <= 0.1));
        level = memory.availableBytes < low || swapTight || lingering || at < this.recoveryUntil ? "elevated" : "normal";
      }
      const last = this.history.at(-1);
      // Admission bursts must not fill history with near-identical microsecond samples.
      if (!last || at - last.at >= MEMORY_SAMPLE_MS) {
        this.history.push({ at, memory });
        if (this.history.length > 12) this.history.shift();
      }
    } else {
      this.history = [];
      this.recoveryUntil = 0;
    }
    let trend: MemoryPressureSnapshot["trend"] = null;
    const first = this.history[0];
    const last = this.history.at(-1);
    if (first && last && last.at - first.at >= 60_000 && first.memory.totalBytes === last.memory.totalBytes) {
      const minutes = (last.at - first.at) / 60_000;
      trend = {
        availableBytesPerMinute: (last.memory.availableBytes - first.memory.availableBytes) / minutes,
        swapFreeBytesPerMinute: first.memory.swapFreeBytes !== null && last.memory.swapFreeBytes !== null
          && first.memory.swapTotalBytes === last.memory.swapTotalBytes
          ? (last.memory.swapFreeBytes - first.memory.swapFreeBytes) / minutes : null,
      };
    }
    this.current = { level, memory, sampledAt: at, recovering: at < this.recoveryUntil, samples: this.history.length, trend };
    if (this.timer) {
      try { this.options.onSample?.(this.snapshot()); } catch { /* Diagnostics must not break admission or polling. */ }
    }
    for (const listener of this.listeners) {
      try { listener(this.snapshot()); } catch { /* Observers cannot break sampling. */ }
    }
    return this.snapshot();
  }
}
