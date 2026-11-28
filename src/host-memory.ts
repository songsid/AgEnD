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
  /** Optional vm_stat diagnostic counters, not pressure inputs. */
  darwinCompressedBytes?: number | null;
  darwinStoredBytes?: number | null;
  /**
   * Linux pressure sampling only; null means PSI cannot be used. M-3916: this is the FLEET's own cgroup
   * (`memory.pressure` of the cgroup this process runs in, which also holds the CLIs it launches), never the
   * host-wide file. It is the only PSI that may slow spawns.
   */
  linuxPsi?: LinuxMemoryPsi | null;
  /**
   * M-3916: host-wide PSI (`/proc/pressure/memory`): every task on this kernel, which on WSL includes the other
   * distros and Docker Desktop's containers. A container reclaiming at its own memory limit shows up here with
   * gigabytes free. Shown and logged as "host-wide" only; never an input to the pressure level.
   */
  linuxHostPsi?: LinuxMemoryPsi | null;
}

/**
 * M-3916: the `memory.pressure` file of the cgroup this process runs in (cgroup v2, the `0::<path>` line of
 * /proc/self/cgroup), or null when that cannot be told (cgroup v1, no unified line, an unsafe path).
 */
export function ownCgroupMemoryPressurePath(cgroupFile: string): string | null {
  if (cgroupFile.length > 8192) return null;
  const line = cgroupFile.split(/\r?\n/).find(l => l.startsWith("0::"));
  const path = line?.slice(3).trim();
  if (!path || !path.startsWith("/") || path.split("/").includes("..")) return null;
  return `/sys/fs/cgroup${path === "/" ? "" : path}/memory.pressure`;
}

interface HostMemoryDeps {
  platform: NodeJS.Platform;
  meminfo: () => string;
  totalmem: () => number;
  freemem: () => number;
  includePressure: boolean;
  /** The fleet cgroup's own memory.pressure (M-3916); throws when it cannot be read. */
  psi: () => string;
  /** Host-wide /proc/pressure/memory, for display only (M-3916). */
  hostPsi: () => string;
}

const readOwnCgroupPsi = () => {
  const path = ownCgroupMemoryPressurePath(readFileSync("/proc/self/cgroup", "utf8"));
  if (!path) throw new Error("own cgroup memory.pressure unavailable");
  return readFileSync(path, "utf8");
};

/** Host memory, not the fleet's RSS/cgroup charge. Missing swap data is not zero swap. */
export function readHostMemory(overrides: Partial<HostMemoryDeps> = {}): HostMemory {
  const deps = { platform: platform(), meminfo: () => readFileSync("/proc/meminfo", "utf8"), totalmem, freemem,
    includePressure: false, psi: readOwnCgroupPsi, hostPsi: () => readFileSync("/proc/pressure/memory", "utf8"), ...overrides };
  // macOS keeps reclaimable pages in use. Its free count is not availability.
  // Synchronous readers cannot run the native probe; absence stays unknown.
  if (deps.platform === "darwin") {
    return { totalBytes: deps.totalmem(), availableBytes: null, availableKind: "unknown", swapTotalBytes: null, swapFreeBytes: null };
  }
  if (deps.platform === "linux") {
    let linuxPsi: LinuxMemoryPsi | null = null, linuxHostPsi: LinuxMemoryPsi | null = null;
    if (deps.includePressure) {
      // The fleet's own cgroup only. Unreadable means RAM checks alone, never the host-wide value (M-3916).
      try { linuxPsi = parseLinuxMemoryPsi(deps.psi()); } catch { /* Fall back to RAM, without inventing PSI. */ }
      try { linuxHostPsi = parseLinuxMemoryPsi(deps.hostPsi()); } catch { /* display only */ }
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
          ...(deps.includePressure ? { linuxPsi, linuxHostPsi } : {}),
        };
      }
    } catch { /* non-procfs Linux, or an unreadable snapshot: portable fallback */ }
    return { totalBytes: deps.totalmem(), availableBytes: deps.freemem(), availableKind: "free", swapTotalBytes: null, swapFreeBytes: null,
      ...(deps.includePressure ? { linuxPsi, linuxHostPsi } : {}) };
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
