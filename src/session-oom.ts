/** Definitive, conservative Linux OOM attribution. Never signals a workload for memory. */
import { execFile } from "./child-process.js";
import { readFile, readlink } from "node:fs/promises";
import { basename } from "node:path";

export interface CliOomIdentity { pid: number; start: string; comm: string; observedAt: number }
export interface KernelOom { pid: number; comm: string; at: number }
const MAX_PROC_BYTES = 16_384;
const LAUNCHERS = new Set(["bash", "dash", "sh", "zsh", "fish", "env", "busybox"]);
async function text(path: string): Promise<string | null> {
  try { const value = await readFile(path, "utf8"); return value.length <= MAX_PROC_BYTES ? value : null; } catch { return null; }
}
function processStart(stat: string): string | null {
  const end = stat.lastIndexOf(")");
  const start = stat.slice(end + 2).trim().split(/\s+/)[19];
  return end > 0 && /^\d+$/.test(start ?? "") ? start! : null;
}

/** Follow only a short shell/env chain. Branched or unknown primaries are unknown. */
export async function observeCliOomIdentity(panePid: number, binaryName: string, proc = "/proc"): Promise<CliOomIdentity | null> {
  if (process.platform !== "linux" || !Number.isSafeInteger(panePid) || panePid <= 0) return null;
  let pid = panePid, parent: number | null = null;
  for (let depth = 0; depth < 4; depth++) {
    const comm = (await text(`${proc}/${pid}/comm`))?.trim();
    const stat = await text(`${proc}/${pid}/stat`);
    const status = await text(`${proc}/${pid}/status`);
    // A journal PID is in the host namespace. Do not guess container mappings.
    const ns = status?.match(/^NSpid:\s+(.+)$/m)?.[1]?.trim().split(/\s+/);
    if (!stat || !ns || ns.length !== 1 || Number(ns[0]) !== pid) return null;
    // NSpid is relative to the procfs mount, so one entry does NOT prove a
    // host PID. Linux reserves 0xEFFFFFFC for the initial PID namespace:
    // include/uapi/linux/nsfs.h PID_NS_INIT_INO (older: linux/proc_ns.h).
    // Decline unknown/nested namespaces rather than match container IDs to
    // unrelated host-journal victims. No namespace translation is attempted.
    try { if (await readlink(`${proc}/${pid}/ns/pid`) !== "pid:[4026531836]") return null; } catch { return null; }
    const start = processStart(stat);
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[1]);
    if (!start || (parent !== null && ppid !== parent)) return null;
    const again = await text(`${proc}/${pid}/stat`);
    if (!again || processStart(again) !== start) return null;
    let executable: string;
    try { executable = basename((await readlink(`${proc}/${pid}/exe`)).replace(/ \(deleted\)$/, "")); } catch { return null; }
    if (comm === binaryName && !LAUNCHERS.has(executable)) return { pid, start, comm, observedAt: Date.now() };
    // An unknown primary, or a branched launcher, cannot identify which child
    // is the primary CLI. Never search through it for a tool/subagent match.
    if (!LAUNCHERS.has(executable)) return null;
    const raw = await text(`${proc}/${pid}/task/${pid}/children`);
    const children = raw?.trim().split(/\s+/).filter(value => /^\d+$/.test(value)) ?? [];
    if (children.length !== 1) return null;
    parent = pid; pid = Number(children[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  }
  return null;
}

export function parseKernelOoms(output: string): KernelOom[] {
  const records: KernelOom[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row._TRANSPORT !== "kernel" || typeof row.MESSAGE !== "string") continue;
      const victim = /(?:Out of memory|Memory cgroup out of memory): Killed process (\d+) \(([^)]+)\)/.exec(row.MESSAGE);
      const at = Number(row.__REALTIME_TIMESTAMP) / 1000;
      if (victim && Number.isFinite(at) && at > 0) records.push({ pid: Number(victim[1]), comm: victim[2]!, at });
    } catch { /* unreadable or incomplete evidence is not proof */ }
  }
  return records;
}

let pending: Promise<KernelOom[] | null> | null = null;
/** One physical reader for a burst of deaths; bounded output/runtime, current boot only. */
function recentKernelOoms(): Promise<KernelOom[] | null> {
  if (pending) return pending;
  pending = new Promise<KernelOom[] | null>(resolve => {
    try { execFile("journalctl", ["--kernel", "--boot=0", "--since=-5min", "--no-pager", "--output=json", "--lines=256",
      "--grep=(Out of memory|Memory cgroup out of memory): Killed process"],
    { encoding: "utf8", timeout: 1000, maxBuffer: 256 * 1024, killSignal: "SIGKILL" },
    (error, stdout) => resolve(error ? null : parseKernelOoms(stdout))); }
    catch { resolve(null); }
  }).finally(() => { pending = null; });
  return pending;
}

async function identityIsDead(identity: CliOomIdentity, proc: string): Promise<boolean> {
  try {
    const stat = await readFile(`${proc}/${identity.pid}/stat`, "utf8");
    return stat.length <= MAX_PROC_BYTES && processStart(stat) === identity.start && /\) [ZX] /.test(stat);
  } catch (error) {
    // Unreadable is not absent: a reused PID owned by somebody else may be
    // hidden by procfs permissions. Only a known disappearance is acceptable.
    return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
  }
}

export async function confirmedCliOom(identity: CliOomIdentity | null, diedAt: number, proc = "/proc"): Promise<KernelOom | null> {
  if (process.platform !== "linux" || !identity || diedAt < identity.observedAt) return null;
  if (!await identityIsDead(identity, proc)) return null;
  const records = await recentKernelOoms();
  if (!await identityIsDead(identity, proc)) return null;
  return records?.find(row => row.pid === identity.pid && row.comm === identity.comm
    && row.at >= identity.observedAt && row.at <= diedAt) ?? null;
}

export interface SessionOomCount { key: string; count: number }
/** Ready after resume is not recovery proof: the same session can OOM later. */
export function consecutiveSessionOoms(previous: SessionOomCount | null, key: string | null, confirmed: boolean): SessionOomCount | null {
  if (!confirmed || !key) return null;
  return { key, count: previous?.key === key ? previous.count + 1 : 1 };
}
