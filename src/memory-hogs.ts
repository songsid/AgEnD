/**
 * #2015: which processes hold the most memory in the fleet's service, and whose they are. When host memory pressure
 * rises, General is told the top few — the fleet, tmux, or an instance's CLI or a command it ran — so a person can stop
 * a runaway before the kernel's OOM killer picks a victim (2026-10-17: one agent's 19 GB script).
 *
 * The processes are the fleet cgroup's (cgroup v2 `cgroup.procs`: everything the service runs), else the fleet's
 * descendants. Each one's owner is found by walking its parents to a tmux pane's shell: the pane's window name is the
 * instance. Every read is a small /proc file, read one at a time, never more than one at once in memory.
 */
import { readFile, readdir } from "node:fs/promises";

export interface MemoryHog {
  pid: number;
  /** The process name (/proc/<pid>/status Name). */
  name: string;
  rssBytes: number;
  /** "instance": a pane's process tree; the name is in `instance`. */
  owner: "fleet" | "tmux" | "instance" | "other";
  instance?: string;
}

export interface MemoryHogDeps {
  /** /proc (and /sys/fs/cgroup) root, for tests. */
  procRoot?: string;
  cgroupRoot?: string;
  fleetPid: number;
  tmuxServerPid: number | null;
  /** Each pane's shell pid → its window (instance) name. */
  panes: ReadonlyArray<{ pid: number; window: string }>;
  /** Window names that are fleet instances (others are reported as "other"). */
  isInstance(window: string): boolean;
}

/** At most this many processes are looked at (a bound on the work, not a cut of the answer on a normal host). */
export const MEMORY_HOGS_SCAN_MAX = 4096;

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch { return null; }
}

/** Name, VmRSS (bytes) and parent pid of one process, or null (gone, a kernel thread, unreadable). */
async function statusOf(procRoot: string, pid: number): Promise<{ name: string; rss: number; ppid: number } | null> {
  const s = await readText(`${procRoot}/${pid}/status`);
  if (!s) return null;
  const name = /^Name:\s*(.*)$/m.exec(s)?.[1]?.trim() ?? "?";
  const rss = /^VmRSS:\s+(\d+) kB$/m.exec(s)?.[1];
  const ppid = /^PPid:\s+(\d+)$/m.exec(s)?.[1];
  if (!rss || !ppid) return null;
  return { name, rss: Number.parseInt(rss, 10) * 1024, ppid: Number.parseInt(ppid, 10) };
}

/** Every descendant of `roots` (the roots included), breadth first, from one pass over every process's parent. */
async function descendants(procRoot: string, roots: number[]): Promise<number[]> {
  let entries: string[] = [];
  try { entries = await readdir(procRoot); } catch { return roots; }
  const children = new Map<number, number[]>();
  for (const e of entries.slice(0, 65536)) {
    if (!/^\d+$/.test(e)) continue;
    const st = await statusOf(procRoot, Number(e));
    if (!st) continue;
    const list = children.get(st.ppid) ?? [];
    list.push(Number(e));
    children.set(st.ppid, list);
  }
  const out: number[] = [];
  const queue = [...roots];
  const seen = new Set<number>();
  while (queue.length && out.length < MEMORY_HOGS_SCAN_MAX) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid); out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

/**
 * The pids the service runs: its cgroup's, else the fleet process and its descendants. The tmux server holding the
 * instances can outlive a fleet restart in another cgroup (a fleet started again from another terminal moves to a new
 * scope; tmux stays): when it is not among the cgroup's processes, its descendants (every pane's CLI and what it ran)
 * are added (#2036 review).
 */
async function servicePids(deps: MemoryHogDeps, procRoot: string): Promise<number[]> {
  // The cgroup v2 path (the "0::" line), as process-memory.ts reads it.
  const line = (await readText(`${procRoot}/${deps.fleetPid}/cgroup`))?.split("\n").find(l => l.startsWith("0::"));
  const cg = line ? line.slice(3).trim() : null;
  const cgRoot = deps.cgroupRoot ?? "/sys/fs/cgroup";
  if (cg && cg !== "/") {
    const procs = await readText(`${cgRoot}${cg}/cgroup.procs`);
    if (procs) {
      const pids = procs.split("\n").map(l => Number.parseInt(l, 10)).filter(n => Number.isSafeInteger(n) && n > 0).slice(0, MEMORY_HOGS_SCAN_MAX);
      if (!deps.tmuxServerPid || pids.includes(deps.tmuxServerPid)) return pids;
      const outside = (await descendants(procRoot, [deps.tmuxServerPid])).filter(p => !pids.includes(p));
      return [...pids, ...outside].slice(0, MEMORY_HOGS_SCAN_MAX);
    }
  }
  // No cgroup v2 view: the fleet's and tmux's descendants.
  return descendants(procRoot, [deps.fleetPid, ...(deps.tmuxServerPid ? [deps.tmuxServerPid] : [])]);
}

/** The `limit` processes with the most RSS in the fleet's service, largest first, each with its owner. */
export async function topMemoryHogs(deps: MemoryHogDeps, limit = 3): Promise<MemoryHog[]> {
  const procRoot = deps.procRoot ?? "/proc";
  const pids = await servicePids(deps, procRoot);
  const info = new Map<number, { name: string; rss: number; ppid: number }>();
  for (const pid of pids) {
    const st = await statusOf(procRoot, pid);
    if (st) info.set(pid, st);
  }
  const paneOf = new Map(deps.panes.map(p => [p.pid, p.window]));
  const ownerOf = async (pid: number): Promise<Pick<MemoryHog, "owner" | "instance">> => {
    let at = pid;
    for (let hops = 0; hops < 64 && at > 1; hops++) {
      const pane = paneOf.get(at);
      if (pane !== undefined) return deps.isInstance(pane) ? { owner: "instance", instance: pane } : { owner: "other" };
      if (at === deps.tmuxServerPid) return { owner: "tmux" };
      if (at === deps.fleetPid) return { owner: "fleet" };
      const parent = info.get(at)?.ppid ?? (await statusOf(procRoot, at))?.ppid;
      if (!parent) break;
      at = parent;
    }
    return { owner: "other" };
  };
  const top = [...info.entries()].sort((a, b) => b[1].rss - a[1].rss).slice(0, Math.max(0, limit));
  const out: MemoryHog[] = [];
  for (const [pid, st] of top) out.push({ pid, name: st.name, rssBytes: st.rss, ...(await ownerOf(pid)) });
  return out;
}
