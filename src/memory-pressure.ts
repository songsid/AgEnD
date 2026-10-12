import { readHostMemory, type HostMemory } from "./host-memory.js";
import { DarwinMemoryProbe } from "./darwin-memory.js";
import { platform } from "node:os";

export type MemoryPressureLevel = "normal" | "elevated" | "critical" | "unknown";
export type LinuxMemoryPressureSignal = "psi-some" | "psi-full" | "available" | "available-swap" | "recovery";
export interface MemoryPressureSnapshot {
  level: MemoryPressureLevel;
  memory: HostMemory | null;
  sampledAt: number | null;
  recovering: boolean;
  samples: number;
  /** Change per minute over the bounded observation window; negative means draining. */
  trend: { availableBytesPerMinute: number; swapFreeBytesPerMinute: number | null } | null;
  /** The current Linux trigger, for diagnostics/notices; not an independent policy. */
  signal?: LinuxMemoryPressureSignal | null;
}

interface Options {
  platform?: NodeJS.Platform;
  darwinProbe?: Pick<DarwinMemoryProbe, "read" | "stop">;
  monotonicNow?: () => number;
  read?: () => HostMemory;
  now?: () => number;
  onSample?: (snapshot: MemoryPressureSnapshot) => void;
  onDarwinUnknown?: (memory: HostMemory | null) => void;
  criticalBytes?: number;
}

const MiB = 1024 * 1024;
export const MEMORY_SAMPLE_MS = 30_000;
export const MEMORY_RECOVERY_MS = 30_000;
/** AgEnD policy, in percent; documented together in docs/memory-pressure.md. */
export const LINUX_PSI_THRESHOLDS = Object.freeze({ someAvg60Elevated: 10, fullAvg10Elevated: 5, fullAvg10Critical: 20 });

/** One fleet sampler/policy, shared by spawn admission and health. Linux reads stay synchronous; macOS uses a bounded async probe. */
export class MemoryPressure {
  readonly platform: NodeJS.Platform;
  private readonly read: () => HostMemory;
  private readonly native: Pick<DarwinMemoryProbe, "read" | "stop"> | null;
  private readonly monotonicNow: () => number;
  private nativeAt: number | null = null;
  private nativeValue: HostMemory | null = null;
  private nativeFlight: Promise<MemoryPressureSnapshot> | null = null;
  private epoch = 0;
  private stopped = false;
  private unknownReported = false;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private history: Array<{ at: number; memory: HostMemory & { availableBytes: number } }> = [];
  private listeners = new Set<(snapshot: MemoryPressureSnapshot) => void>();
  private recoveryUntil = 0;
  // A PSI level cannot arm RAM/swap release thresholds. Track actual triggers,
  // including ones masked by simultaneous PSI, independently of the aggregate.
  private ramCriticalHeld = false;
  private ramLowHeld = false;
  private ramSwapHeld = false;
  private current: MemoryPressureSnapshot = {
    level: "unknown", memory: null, sampledAt: null, recovering: false, samples: 0, trend: null,
  };

  constructor(private readonly options: Options = {}) {
    this.platform = options.platform ?? platform();
    this.read = options.read ?? (() => readHostMemory({ platform: this.platform, includePressure: this.platform === "linux" }));
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.native = this.platform === "darwin" && !options.read ? options.darwinProbe ?? new DarwinMemoryProbe({ includePressure: true }) : null;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.unknownReported = false;
    this.timer = setInterval(() => this.sample(), MEMORY_SAMPLE_MS);
    this.timer.unref?.();
    this.sample();
  }

  stop(): void {
    this.stopped = true;
    this.epoch++;
    this.nativeAt = null;
    this.nativeValue = null;
    this.nativeFlight = null;
    this.native?.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Sampling may detect recovery before a long admission backoff expires. */
  startRecoveryWindow(): MemoryPressureSnapshot {
    if (this.advisoryOnly()) return this.snapshot();
    this.recoveryUntil = (this.platform === "darwin" ? this.monotonicNow() : this.now()) + MEMORY_RECOVERY_MS;
    this.current = { ...this.current, recovering: true,
      ...(this.platform === "linux" && this.current.level === "normal" ? { signal: "recovery" as const } : {}),
      level: this.current.level === "normal" ? "elevated" : this.current.level };
    return this.snapshot();
  }

  /** Health readers cannot create samples or move recovery deadlines. */
  snapshot(): MemoryPressureSnapshot {
    return { ...this.current, memory: this.current.memory && { ...this.current.memory,
      ...(this.current.memory.linuxPsi !== undefined ? { linuxPsi: this.current.memory.linuxPsi && { ...this.current.memory.linuxPsi } } : {}) },
      trend: this.current.trend && { ...this.current.trend } };
  }

  /** Only unknown Darwin kernel alarms bypass pressure admission; unavailable Linux PSI uses RAM fallback. */
  advisoryOnly(): boolean {
    return this.platform === "darwin" && this.current.level === "unknown";
  }

  onUpdate(listener: (snapshot: MemoryPressureSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Admission joins a sampler flight or reads its cache; it never starts a Darwin command. */
  sampleForAdmission(): MemoryPressureSnapshot | Promise<MemoryPressureSnapshot> {
    if (!this.native) return this.sample();
    if (this.stopped) return this.snapshot();
    if (this.nativeFlight) return this.nativeFlight;
    if (this.nativeAt !== null && this.monotonicNow() - this.nativeAt < MEMORY_SAMPLE_MS) return this.evaluate(this.nativeValue);
    // A cache miss is not a completed probe: preserve the once-per-lifecycle raw-read diagnostic.
    return this.evaluate(null, false);
  }

  private sampleNative(): Promise<MemoryPressureSnapshot> {
    if (this.nativeFlight) return this.nativeFlight;
    const epoch = this.epoch;
    const flight = Promise.resolve().then(() => {
      if (this.stopped || epoch !== this.epoch) return null;
      return this.native!.read();
    }).then(value => {
      if (this.stopped || epoch !== this.epoch) return this.snapshot();
      this.nativeAt = this.monotonicNow();
      this.nativeValue = value;
      return this.evaluate(value);
    }, () => {
      if (this.stopped || epoch !== this.epoch) return this.snapshot();
      this.nativeAt = this.monotonicNow();
      this.nativeValue = null;
      return this.evaluate(null);
    }).finally(() => { if (this.nativeFlight === flight) this.nativeFlight = null; });
    this.nativeFlight = flight;
    return flight;
  }

  sample(): MemoryPressureSnapshot {
    if (this.native) { if (!this.stopped) void this.sampleNative(); return this.snapshot(); }
    let value: HostMemory | null = null;
    try { value = this.read(); } catch { /* Unreadable data is unknown. */ }
    return this.evaluate(value);
  }

  private evaluate(value: HostMemory | null, reportUnknown = true): MemoryPressureSnapshot {
    if (this.platform === "darwin") return this.evaluateDarwin(value, reportUnknown);
    const at = this.now();
    let memory: (HostMemory & { availableBytes: number }) | null = null;
    try {
      if (value && Number.isFinite(value.totalBytes) && value.totalBytes > 0
        && value.availableBytes !== null && Number.isFinite(value.availableBytes) && value.availableBytes >= 0 && value.availableBytes <= value.totalBytes) {
        memory = { ...value, availableBytes: value.availableBytes };
        if (value.linuxPsi !== undefined) {
          const psi = value.linuxPsi;
          memory.linuxPsi = psi && [psi.someAvg60, psi.fullAvg10].every(n => Number.isFinite(n) && n >= 0 && n <= 100)
            ? { ...psi } : null;
        }
        if (value.swapTotalBytes === null || value.swapFreeBytes === null
          || !Number.isFinite(value.swapTotalBytes) || !Number.isFinite(value.swapFreeBytes)
          || value.swapTotalBytes < 0 || value.swapFreeBytes < 0 || value.swapFreeBytes > value.swapTotalBytes) {
          memory.swapTotalBytes = memory.swapFreeBytes = null;
        }
      }
    } catch { /* Unavailable data slows admissions; it cannot deadlock the fleet. */ }

    let level: MemoryPressureLevel = "unknown";
    let signal: LinuxMemoryPressureSignal | null = null;
    if (memory) {
      const linux = this.platform === "linux";
      const psi = linux ? memory.linuxPsi : null;
      const critical = Math.max(this.options.criticalBytes ?? 300 * MiB, memory.totalBytes * 0.02);
      const low = Math.max(critical * 2, memory.totalBytes * 0.05);
      const swapRatio = memory.swapTotalBytes && memory.swapFreeBytes !== null
        ? memory.swapFreeBytes / memory.swapTotalBytes : null;
      const swapTight = swapRatio !== null && swapRatio <= 0.05;
      const psiCritical = !!psi && psi.fullAvg10 >= LINUX_PSI_THRESHOLDS.fullAvg10Critical;
      const psiFullElevated = !!psi && psi.fullAvg10 >= LINUX_PSI_THRESHOLDS.fullAvg10Elevated;
      const psiSomeElevated = !!psi && psi.someAvg60 >= LINUX_PSI_THRESHOLDS.someAvg60Elevated;
      const ramCritical = memory.availableKind === "available"
        && (memory.availableBytes < critical || (memory.availableBytes < low && swapTight));
      const swapCanElevate = !linux || (!psi && memory.availableBytes < low * 2);
      const swapLingering = swapCanElevate && swapRatio !== null && swapRatio <= 0.1;
      if (linux) {
        this.ramCriticalHeld = ramCritical || (this.ramCriticalHeld
          && memory.availableKind === "available" && memory.availableBytes < critical * 1.5);
        this.ramLowHeld = memory.availableBytes < low || (this.ramLowHeld && memory.availableBytes < low * 1.2);
        this.ramSwapHeld = (swapTight && swapCanElevate) || (this.ramSwapHeld && swapLingering);
      }
      const ramCriticalHold = linux ? this.ramCriticalHeld : ramCritical || (this.current.level === "critical"
        && memory.availableKind === "available" && memory.availableBytes < critical * 1.5);
      const ramLowHold = linux ? this.ramLowHeld : memory.availableBytes < low
        || (this.current.level === "elevated" && memory.availableBytes < low * 1.2);
      const ramSwapHold = linux ? this.ramSwapHeld : (swapTight && swapCanElevate)
        || (this.current.level === "elevated" && swapLingering);
      // MemFree alone cannot distinguish healthy reclaimable cache from pressure.
      // It can throttle, but must never impose an indefinite Linux procfs-failure hold.
      if (psiCritical || ramCriticalHold) {
        level = "critical";
        signal = psiCritical ? "psi-full" : memory.availableBytes < critical || !ramCritical ? "available" : "available-swap";
        this.recoveryUntil = 0;
      } else {
        if (this.current.level === "critical") this.recoveryUntil = at + MEMORY_RECOVERY_MS;
        // Cold swap is not pressure. Its fallback and release hysteresis need low RAM too.
        level = psiFullElevated || psiSomeElevated || ramLowHold || ramSwapHold
          || at < this.recoveryUntil ? "elevated" : "normal";
        if (level === "elevated") signal = psiFullElevated ? "psi-full" : psiSomeElevated ? "psi-some"
          : ramLowHold ? "available" : ramSwapHold ? "available-swap" : "recovery";
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
      this.ramCriticalHeld = this.ramLowHeld = this.ramSwapHeld = false;
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
    this.current = { level, memory, sampledAt: at, recovering: at < this.recoveryUntil, samples: this.history.length, trend,
      ...(this.platform === "linux" ? { signal } : {}) };
    if (this.timer) {
      try { this.options.onSample?.(this.snapshot()); } catch { /* Diagnostics must not break admission or polling. */ }
    }
    for (const listener of this.listeners) {
      try { listener(this.snapshot()); } catch { /* Observers cannot break sampling. */ }
    }
    return this.snapshot();
  }

  /** The kernel is authoritative even when vm_stat fails; bytes are display/trend data only. */
  private evaluateDarwin(value: HostMemory | null, reportUnknown: boolean): MemoryPressureSnapshot {
    const at = this.now(), monotonicAt = this.monotonicNow();
    const kernel = value?.darwinPressureLevel;
    let level: MemoryPressureLevel = kernel === 1 ? "normal" : kernel === 2 ? "elevated" : kernel === 4 ? "critical" : "unknown";
    if (level === "critical" || level === "unknown") this.recoveryUntil = 0;
    else {
      if (this.current.level === "critical") this.recoveryUntil = monotonicAt + MEMORY_RECOVERY_MS;
      if (monotonicAt < this.recoveryUntil) level = "elevated";
    }
    const memory = value ? { ...value } : null;
    if (memory && Number.isFinite(memory.totalBytes) && memory.totalBytes > 0
      && memory.availableKind === "available" && memory.availableBytes !== null
      && Number.isFinite(memory.availableBytes) && memory.availableBytes >= 0 && memory.availableBytes <= memory.totalBytes) {
      const last = this.history.at(-1);
      if (!last || at - last.at >= MEMORY_SAMPLE_MS) {
        this.history.push({ at, memory: { ...memory, availableBytes: memory.availableBytes } });
        if (this.history.length > 12) this.history.shift();
      }
    } else this.history = [];
    const first = this.history[0], last = this.history.at(-1);
    let trend: MemoryPressureSnapshot["trend"] = null;
    if (first && last && last.at - first.at >= 60_000 && first.memory.totalBytes === last.memory.totalBytes) {
      const minutes = (last.at - first.at) / 60_000;
      trend = { availableBytesPerMinute: (last.memory.availableBytes - first.memory.availableBytes) / minutes,
        swapFreeBytesPerMinute: first.memory.swapFreeBytes !== null && last.memory.swapFreeBytes !== null
          && first.memory.swapTotalBytes === last.memory.swapTotalBytes
          ? (last.memory.swapFreeBytes - first.memory.swapFreeBytes) / minutes : null };
    }
    this.current = { level, memory, sampledAt: at, recovering: monotonicAt < this.recoveryUntil, samples: this.history.length, trend };
    if (this.timer) {
      if (reportUnknown && level === "unknown" && !this.unknownReported) {
        this.unknownReported = true;
        try { this.options.onDarwinUnknown?.(memory); } catch { /* Diagnostics cannot block admission. */ }
      }
      try { this.options.onSample?.(this.snapshot()); } catch { /* Diagnostics cannot block admission. */ }
    }
    for (const listener of this.listeners) {
      try { listener(this.snapshot()); } catch { /* Observers cannot break sampling. */ }
    }
    return this.snapshot();
  }
}
