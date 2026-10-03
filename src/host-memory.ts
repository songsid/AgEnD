import { readFileSync } from "node:fs";
import { freemem, totalmem, platform } from "node:os";

export interface HostMemory {
  totalBytes: number;
  availableBytes: number;
  availableKind: "available" | "free";
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
}

interface HostMemoryDeps {
  platform: NodeJS.Platform;
  meminfo: () => string;
  totalmem: () => number;
  freemem: () => number;
}

/** Host memory, not the fleet's RSS/cgroup charge. Missing swap data is not zero swap. */
export function readHostMemory(overrides: Partial<HostMemoryDeps> = {}): HostMemory {
  const deps = { platform: platform(), meminfo: () => readFileSync("/proc/meminfo", "utf8"), totalmem, freemem, ...overrides };
  if (deps.platform === "linux") {
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
        };
      }
    } catch { /* non-procfs Linux, or an unreadable snapshot: portable fallback */ }
  }
  return { totalBytes: deps.totalmem(), availableBytes: deps.freemem(), availableKind: "free", swapTotalBytes: null, swapFreeBytes: null };
}

