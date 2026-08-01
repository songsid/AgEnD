import { readFileSync } from "node:fs";

export interface FleetMemory {
  /** RSS of the fleet manager process itself, in bytes. */
  fleetRssBytes: number;
  /**
   * Anonymous memory of the whole service cgroup — the fleet process plus every
   * CLI, MCP server and helper it started. Null when not running under a cgroup
   * (macOS, a bare `agend fleet start`).
   */
  cgroupAnonBytes: number | null;
  /** Everything the cgroup is charged for, including reclaimable page cache. */
  cgroupTotalBytes: number | null;
  /** Threads in the cgroup — the number systemd reports as "Tasks". */
  cgroupTasks: number | null;
}

/**
 * Where the fleet's memory actually goes.
 *
 * #386 reported "fleet RSS 10.1GB / 1959 tasks" and asked whether the fleet was
 * leaking. It was not: those are the **cgroup** totals that `systemctl status`
 * prints for the whole service tree — ~35 CLI agents, their MCP servers and
 * helpers — while the fleet manager process itself was 162 MB after 11h40m.
 *
 * The two numbers differ by ~60x, they are both called "memory", and nothing in
 * the fleet reported either one. Answering that question meant reading
 * /sys/fs/cgroup by hand. Reporting both, separately labelled, is what stops the
 * next person re-deriving it — and what makes a real leak visible as a rising
 * `fleetRssBytes` rather than being lost inside an aggregate dominated by CLIs.
 *
 * Never throws: every source is optional and absent on non-Linux.
 */
export function readFleetMemory(pid = process.pid): FleetMemory {
  return {
    fleetRssBytes: readSelfRss(pid),
    cgroupAnonBytes: readCgroupStat(pid, "anon"),
    cgroupTotalBytes: readCgroupFile(pid, "memory.current"),
    cgroupTasks: readCgroupFile(pid, "pids.current"),
  };
}

function readSelfRss(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf-8");
    const kb = status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1];
    if (kb) return Number.parseInt(kb, 10) * 1024;
  } catch { /* not Linux, or the process is gone */ }
  // process.memoryUsage().rss is portable but counts only this process — which is
  // exactly what fleetRssBytes means, so it is a faithful fallback.
  try {
    return process.memoryUsage().rss;
  } catch {
    return 0;
  }
}

/** The cgroup v2 path this process belongs to, e.g. /user.slice/…/agend.service. */
function cgroupPath(pid: number): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, "utf-8").split("\n")[0];
    const path = line?.split(":")[2];
    return path && path !== "/" ? path : null;
  } catch {
    return null;
  }
}

function readCgroupFile(pid: number, file: string): number | null {
  const path = cgroupPath(pid);
  if (!path) return null;
  try {
    const value = Number.parseInt(readFileSync(`/sys/fs/cgroup${path}/${file}`, "utf-8").trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function readCgroupStat(pid: number, key: string): number | null {
  const path = cgroupPath(pid);
  if (!path) return null;
  try {
    const stat = readFileSync(`/sys/fs/cgroup${path}/memory.stat`, "utf-8");
    const value = stat.match(new RegExp(`^${key} (\\d+)$`, "m"))?.[1];
    return value ? Number.parseInt(value, 10) : null;
  } catch {
    return null;
  }
}
