import { DarwinMemoryProbe } from "./darwin-memory.js";
import { readFileSync } from "node:fs";
import { freemem, totalmem, platform } from "node:os";

export interface LinuxMemoryPsi { someAvg60: number; fullAvg10: number }

/** Kernel percentage averages; missing/ambiguous output is unavailable, not zero pressure. */
export function parseLinuxMemoryPsi(output: string): LinuxMemoryPsi | null {
  if (output.length > 4096) return null;
  const rows = new Map<string, number[]>();
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 2) return null;
  for (const line of lines) {
    const match = /^(some|full) avg10=(\d+(?:\.\d+)?) avg60=(\d+(?:\.\d+)?) avg300=(\d+(?:\.\d+)?) total=\d+$/.exec(line);
    if (!match || rows.has(match[1])) return null;
    const averages = match.slice(2).map(Number);
    if (averages.some(n => !Number.isFinite(n) || n < 0 || n > 100)) return null;
    rows.set(match[1], averages);
  }
  if (!rows.has("some") || !rows.has("full")) return null;
  return { someAvg60: rows.get("some")![1], fullAvg10: rows.get("full")![0] };
}

export interface HostMemory {
  totalBytes: number;
  availableBytes: number | null;
  availableKind: "available" | "free" | "unknown";
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
  /** Darwin kernel alarm, independent of the diagnostic RAM/swap estimates. */
  darwinPressureLevel?: 1 | 2 | 4 | null;
  /** Bounded diagnostic output; null when unavailable or not requested. */
  darwinPressureRaw?: string | null;
  /** Linux pressure sampling only; null means PSI cannot be used. */
  linuxPsi?: LinuxMemoryPsi | null;
}

interface HostMemoryDeps {
  platform: NodeJS.Platform;
  meminfo: () => string;
  totalmem: () => number;
  freemem: () => number;
  includePressure: boolean;
  psi: () => string;
}

/** Host memory, not the fleet's RSS/cgroup charge. Missing swap data is not zero swap. */
export function readHostMemory(overrides: Partial<HostMemoryDeps> = {}): HostMemory {
  const deps = { platform: platform(), meminfo: () => readFileSync("/proc/meminfo", "utf8"), totalmem, freemem,
    includePressure: false, psi: () => readFileSync("/proc/pressure/memory", "utf8"), ...overrides };
  // macOS keeps reclaimable pages in use. Its free count is not availability.
  // Synchronous readers cannot run the native probe; absence stays unknown.
  if (deps.platform === "darwin") {
    return { totalBytes: deps.totalmem(), availableBytes: null, availableKind: "unknown", swapTotalBytes: null, swapFreeBytes: null };
  }
  if (deps.platform === "linux") {
    let linuxPsi: LinuxMemoryPsi | null = null;
    if (deps.includePressure) {
      try { linuxPsi = parseLinuxMemoryPsi(deps.psi()); } catch { /* Fall back to RAM, without inventing PSI. */ }
    }
    try {
      const fields = new Map<string, number>();
      for (const match of deps.meminfo().matchAll(/^(\w+):\s+(\d+)\s+kB\s*$/gm)) {
        const bytes = Number(match[2]) * 1024;
        if (Number.isSafeInteger(bytes)) fields.set(match[1], bytes);
      }
      const total = fields.get("MemTotal");
      const available = fields.get("MemAvailable") ?? fields.get("MemFree");
      if (total && available !== undefined && available <= total) {
        const swapTotal = fields.get("SwapTotal");
        const swapFree = fields.get("SwapFree");
        const hasSwap = swapTotal !== undefined && swapFree !== undefined && swapFree <= swapTotal;
        return {
          totalBytes: total, availableBytes: available,
          availableKind: fields.has("MemAvailable") ? "available" : "free",
          swapTotalBytes: hasSwap ? swapTotal : null,
          swapFreeBytes: hasSwap ? swapFree : null,
          ...(deps.includePressure ? { linuxPsi } : {}),
        };
      }
    } catch { /* non-procfs Linux, or an unreadable snapshot: portable fallback */ }
    return { totalBytes: deps.totalmem(), availableBytes: deps.freemem(), availableKind: "free", swapTotalBytes: null, swapFreeBytes: null,
      ...(deps.includePressure ? { linuxPsi } : {}) };
  }
  return { totalBytes: deps.totalmem(), availableBytes: deps.freemem(), availableKind: "free", swapTotalBytes: null, swapFreeBytes: null };
}

// Diagnostics use the same bounded native reader. Construction is side-effect free.
let diagnosticDarwinProbe: DarwinMemoryProbe | null = null;
export function readHostMemoryAsync(): Promise<HostMemory> {
  if (platform() !== "darwin") return Promise.resolve(readHostMemory());
  diagnosticDarwinProbe ??= new DarwinMemoryProbe();
  return diagnosticDarwinProbe.read();
}
