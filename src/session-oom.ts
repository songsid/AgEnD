/** Definitive, conservative Linux OOM attribution. Never signals a workload for memory. */
import { execFile } from "./child-process.js";
import { readFile, readlink } from "node:fs/promises";
import { basename } from "node:path";
import { t } from "./locale.js";

export interface CliOomIdentity { pid: number; start: string; comm: string; observedAt: number }
export interface SelfOomEvidence {
  policy: 2;
  scope: "global";
  ramPages: number;
  victimRssPages: number;
  victimAnonKiB: number;
  victimTotalRssKiB: number;
  largestOtherRssPages: number;
}
export interface KernelOom { pid: number; comm: string; at: number; attribution: "self" | "collateral" | "unknown"; evidence?: SelfOomEvidence }
/** Positive dominance proof only. A selected victim is not necessarily the allocator. */
function validOomEvidence(value: unknown): value is SelfOomEvidence {
  const e = value as SelfOomEvidence | null;
  if (!e || e.policy !== 2 || e.scope !== "global"
    || ![e.ramPages, e.victimRssPages, e.victimAnonKiB, e.victimTotalRssKiB, e.largestOtherRssPages]
      .every(n => Number.isSafeInteger(n) && n >= 0)
    || !e.ramPages || !e.victimRssPages || !e.victimTotalRssKiB
    || e.victimRssPages > e.ramPages || e.victimAnonKiB > e.victimTotalRssKiB) return false;
  const pageKiB = e.victimTotalRssKiB / e.victimRssPages;
  return [4, 16, 64].some(unit => Math.abs(pageKiB - unit) <= unit * 0.05);
}
export function selfOomEvidence(value: unknown): value is SelfOomEvidence {
  if (!validOomEvidence(value)) return false;
  const e = value;
  // Both table and RAM use pages. Scaling by the kill-line anonymous fraction
  // avoids assuming 4-KiB pages on arm64, or mistaking file RSS for anon RSS.
  const anonPages = e.victimRssPages * (e.victimAnonKiB / e.victimTotalRssKiB);
  return anonPages >= e.ramPages / 2 && anonPages >= 2 * e.largestOtherRssPages;
}
export function describeSelfOom(e: SelfOomEvidence): string {
  const anonPages = e.victimRssPages * (e.victimAnonKiB / e.victimTotalRssKiB);
  return t("inst.session_oom_proof", Math.floor(100 * anonPages / e.ramPages), e.largestOtherRssPages ? (anonPages / e.largestOtherRssPages).toFixed(1) : "∞");
}
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
  let beganAt = 0, ramPages = 0, table = false, header: "legacy" | "rss-columns" | null = null, invalid = false;
  let tasks = new Map<number, { comm: string; rss: number }>();
  let context = "";
  const reset = () => { beganAt = ramPages = 0; table = invalid = false; header = null; tasks = new Map(); context = ""; };
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row._TRANSPORT !== "kernel") continue;
      if (typeof row.MESSAGE !== "string") { invalid = true; continue; }
      const at = Number(row.__REALTIME_TIMESTAMP) / 1000;
      if (!Number.isFinite(at) || at <= 0) { reset(); continue; }
      const msg: string = row.MESSAGE;
      if (msg.includes("invoked oom-killer:")) { reset(); beganAt = at; }
      const ram = /^\s*(\d+) pages RAM\s*$/.exec(msg);
      if (ram) { if (ramPages && ramPages !== Number(ram[1])) invalid = true; ramPages = Number(ram[1]); }
      if (msg === "Tasks state (memory values in pages):") { if (table) invalid = true; table = true; }
      // Linux 6.8 added per-kind RSS columns. Match the declared layout before
      // reading rows; unknown/reordered columns must not hide a larger task.
      if (/^\[\s*pid\s*\]/.test(msg)) {
        const columns = /^\[\s*pid\s*\]\s+uid\s+tgid\s+total_vm\s+rss\s+(rss_anon\s+rss_file\s+rss_shmem\s+)?pgtables_bytes\s+swapents\s+oom_score_adj\s+name\s*$/.exec(msg);
        if (!table || header || !columns) invalid = true;
        else header = columns[1] ? "rss-columns" : "legacy";
      }
      if (table && /^\[\s*\d/.test(msg)) {
        // comm is the rest of the line, not a word (e.g. "tmux: server").
        const task = (header === "rss-columns"
          ? /^\[\s*(\d+)\]\s+\d+\s+\d+\s+\d+\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+-?\d+\s+(.+?)\s*$/
          : /^\[\s*(\d+)\]\s+\d+\s+\d+\s+\d+\s+(\d+)\s+\d+\s+\d+\s+-?\d+\s+(.+?)\s*$/).exec(msg);
        if (!header || !task) invalid = true;
        else {
          const pid = Number(task[1]), rss = Number(task[2]), comm = task[3]!;
          const old = tasks.get(pid);
          if (old && (old.rss !== rss || old.comm !== comm)) invalid = true;
          if (!Number.isSafeInteger(rss) || (!old && tasks.size >= 4096)) invalid = true;
          else tasks.set(pid, { rss, comm });
        }
      }
      if (msg.startsWith("oom-kill:")) { if (context) invalid = true; context = msg; }
      const victim = /^(Out of memory|Memory cgroup out of memory): Killed process (\d+) \(([^)]+)\)/.exec(msg);
      if (!victim) continue;
      const pid = Number(victim[2]), comm = victim[3]!;
      const record: KernelOom = { pid, comm, at, attribution: "unknown" };
      const own = tasks.get(pid);
      const rss = /anon-rss:(\d+)kB, file-rss:(\d+)kB, shmem-rss:(\d+)kB/.exec(msg);
      // Only one complete, unconstrained report. Shared fleet/container memcg
      // exhaustion cannot identify an individual instance as the cause.
      if (beganAt && at >= beganAt && at - beganAt <= 10_000 && !invalid && ramPages && table && header && own?.comm === comm && rss
        && context.startsWith("oom-kill:constraint=CONSTRAINT_NONE,") && context.includes(",global_oom,")
        && context.includes(`,task=${comm},pid=${pid},`) && victim[1] === "Out of memory") {
        const evidence: SelfOomEvidence = { policy: 2, scope: "global", ramPages, victimRssPages: own.rss,
          victimAnonKiB: Number(rss[1]), victimTotalRssKiB: Number(rss[1]) + Number(rss[2]) + Number(rss[3]),
          largestOtherRssPages: Math.max(0, ...[...tasks].filter(([other]) => other !== pid).map(([, task]) => task.rss)) };
        if (validOomEvidence(evidence) && evidence.largestOtherRssPages >= 2 * own.rss) record.attribution = "collateral";
        if (selfOomEvidence(evidence)) { record.attribution = "self"; record.evidence = evidence; }
      }
      records.push(record); reset();
    } catch { invalid = true; /* a lost task row may hide the actual hog */ }
  }
  return records;
}

let pending: Promise<KernelOom[] | null> | null = null;
/** One physical reader for a burst of deaths; bounded output/runtime, current boot only. */
function recentKernelOoms(): Promise<KernelOom[] | null> {
  if (pending) return pending;
  pending = new Promise<KernelOom[] | null>(resolve => {
    // Project away optional machine/host metadata (journal cursors stay).
    // Leave room for all 4096 task rows
    // plus the report's stack/Mem-Info and other recent kernel messages.
    try { execFile("journalctl", ["--kernel", "--boot=0", "--since=-5min", "--no-pager", "--output=json",
      "--output-fields=MESSAGE,_TRANSPORT,__REALTIME_TIMESTAMP", "--lines=8192"],
    { encoding: "utf8", timeout: 1000, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL" },
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
