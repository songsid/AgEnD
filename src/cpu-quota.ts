import { readFileSync } from "node:fs";
import { availableParallelism, platform } from "node:os";

/**
 * How many CPUs this process may actually use (#749).
 *
 * `os.cpus().length` is the host's core count. Inside a container or a
 * systemd slice with `CPUQuota=`, that overstates what the fleet can run, and
 * the cold-start concurrency derived from it starts more CLIs than can make
 * progress. `availableParallelism()` honours the CPU affinity mask, and on
 * current Node (22, libuv) it already applies a cgroup v2 quota too, rounded
 * down (`--cpus=1.5` → 1). The quota read here — cgroup v2 `cpu.max` at every
 * level from this process's cgroup up to the root, the tightest winning, or
 * cgroup v1 `cpu.cfs_quota_us` / `cpu.cfs_period_us` — is the fallback for
 * runtimes and hosts where it does not (older libuv, v1 and hybrid hosts). The
 * smaller of the two wins; a fractional quota read here rounds up.
 */
export interface CpuQuotaDeps {
  platform: NodeJS.Platform;
  availableParallelism: () => number;
  /** Throws when the file is missing. */
  readFile: (path: string) => string;
}

const defaultDeps: CpuQuotaDeps = {
  platform: platform(),
  availableParallelism,
  readFile: (path) => readFileSync(path, "utf8"),
};

export function effectiveCpuCount(deps: CpuQuotaDeps = defaultDeps): number {
  const parallelism = Math.max(1, Math.floor(deps.availableParallelism()) || 1);
  if (deps.platform !== "linux") return parallelism;
  const quota = cgroupCpuQuota(deps);
  return quota == null ? parallelism : Math.max(1, Math.min(parallelism, Math.ceil(quota)));
}

/** The tightest CFS quota on this process, in CPUs; null when unlimited or unreadable. */
export function cgroupCpuQuota(deps: Pick<CpuQuotaDeps, "readFile">): number | null {
  let selfCgroup: string;
  try { selfCgroup = deps.readFile("/proc/self/cgroup"); } catch { return null; }
  const lines = selfCgroup.split("\n");
  const v2 = lines.find(l => l.startsWith("0::"));
  if (v2) {
    const fromV2 = v2Quota(deps, v2.slice(3).trim());
    if (fromV2 != null) return fromV2;
  }
  // Hybrid hosts list both; a v1 cpu controller line is "N:cpu,cpuacct:/path" (any order).
  const v1 = lines.map(l => l.split(":")).find(p => p.length >= 3 && p[1].split(",").includes("cpu"));
  return v1 ? v1Quota(deps, v1.slice(2).join(":").trim()) : null;
}

/** A cgroup's own quota says nothing about its parents': check every level up to the mount. */
function ancestry(base: string, path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  // A path outside our cgroup namespace ("/../..") does not exist under our mount: only the mount root applies.
  if (segments.includes("..")) return [base];
  const dirs: string[] = [];
  for (let i = segments.length; i >= 0; i--) dirs.push([base, ...segments.slice(0, i)].join("/"));
  return dirs;
}

function v2Quota(deps: Pick<CpuQuotaDeps, "readFile">, path: string): number | null {
  let tightest: number | null = null;
  for (const dir of ancestry("/sys/fs/cgroup", path)) {
    let text: string;
    try { text = deps.readFile(`${dir}/cpu.max`); } catch { continue; }
    const match = /^(\d+|max)\s+(\d+)\s*$/.exec(text.trim());
    if (!match || match[1] === "max") continue;
    const cpus = Number(match[1]) / Number(match[2]);
    if (Number.isFinite(cpus) && cpus > 0 && (tightest == null || cpus < tightest)) tightest = cpus;
  }
  return tightest;
}

function v1Quota(deps: Pick<CpuQuotaDeps, "readFile">, path: string): number | null {
  let tightest: number | null = null;
  for (const mount of ["/sys/fs/cgroup/cpu", "/sys/fs/cgroup/cpu,cpuacct"]) {
    for (const dir of ancestry(mount, path)) {
      let quota: number, period: number;
      try {
        quota = Number(deps.readFile(`${dir}/cpu.cfs_quota_us`).trim());
        period = Number(deps.readFile(`${dir}/cpu.cfs_period_us`).trim());
      } catch { continue; }
      if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) continue; // -1 = unlimited
      const cpus = quota / period;
      if (tightest == null || cpus < tightest) tightest = cpus;
    }
  }
  return tightest;
}
