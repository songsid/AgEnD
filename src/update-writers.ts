/**
 * M-3770 slice 2.3 (design update-transaction §4.4): the writers-gone proof. Run after the fences (§4.2), and again
 * after the snapshot's copy and after a restore, before their result is published.
 *
 * - **It looks for** any process of this uid that has `AGEND_HOME` equal to this home, its cwd under the home, or a file
 *   of the scope open or mapped (Linux: `/proc/<pid>/{environ,cwd,fd,maps}`).
 * - **An incomplete scan is never proof of absence:** a listing that fails, or a process of this uid that STAYS unreadable.
 *   A process caught mid-execve or mid-exit fails its reads for a moment (EACCES/EPERM, not ENOENT), so an unreadable one
 *   is read again a few times with a short backoff (Fable #4524 F1); between tries it is re-identified — gone is gone, a
 *   new start is a different process (classified afresh). Only the same process, unreadable through every try, makes
 *   the scan incomplete.
 * - **Sealed processes (design rev 10).** A process of this uid that the kernel closes to this reader is positively
 *   identified and reported as `uninspectable`, not as a gap: one made non-dumpable (its `status` reads this uid while
 *   its `fd` directory is root's — every systemd user session's `(sd-pam)`), or one holding capabilities this process
 *   doesn't (`CapPrm`, readable in `status`; the kernel then denies the read). AgEnD's own processes and the CLIs it
 *   launches are neither: AgEnD never clears the dumpable flag and grants no capabilities. Any other unreadable process
 *   still makes the scan incomplete.
 * - **The exempt set is exactly:** the updater (`attempt.updater`), the recovery runner (`runner.json`), and helpers the
 *   attempt itself spawned (`attempt.helpers[]`, each `{ pid, start }`) whose ancestor chain — by ppid, each step's
 *   start time read — reaches the updater or the runner. Nothing is exempt by name or argv.
 *
 * Every read goes through `WritersDeps`, so the proof is testable without real processes; `procWritersDeps()` is the
 * Linux implementation. On another platform the proof is incomplete until its scanner exists (macOS: `lsof -Fn +D`).
 */
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { classify } from "./update-snapshot-scope.js";
import type { ProcessStartRecord } from "./update-journal.js";

export interface WritersDeps {
  /** Every pid now; null when the listing fails. */
  listPids(): number[] | null;
  /** The process's real uid; "gone" when it exited; null when unreadable. */
  uidOf(pid: number): number | "gone" | null;
  /** Its environment's AGEND_HOME (undefined: unset); "gone"; null: unreadable. */
  agendHomeOf(pid: number): string | undefined | "gone" | null;
  /** Its cwd; "gone"; null: unreadable. */
  cwdOf(pid: number): string | "gone" | null;
  /** The paths it has open (fd link targets) and mapped (maps); "gone"; null: unreadable. */
  filesOf(pid: number): string[] | "gone" | null;
  /** Its parent pid; "gone"; null. */
  ppidOf(pid: number): number | "gone" | null;
  /** `pid`'s start as install-lock records it; null when it can't be read (gone, or mid-exec). */
  startOf(pid: number): ProcessStartRecord | null;
  /** Wait (synchronously) between re-reads of an unreadable process. */
  sleep(ms: number): void;
  /**
   * Is `pid` sealed: this uid's, but closed to this process — non-dumpable (its per-process files are root's), or
   * holding capabilities this process doesn't (the kernel denies the read)?
   */
  sealed(pid: number): false | "non-dumpable" | "privileged";
  /** Its command name (status `Name:`), for the words; null when unknown. */
  nameOf?(pid: number): string | null;
  /** Does `pid`'s current start match `start`? (install-lock's identity: ticks + boot, else the lstart text.) */
  sameProcess(pid: number, start: ProcessStartRecord): boolean;
  uid: number;
  platform: NodeJS.Platform;
}

export interface Identity { pid: number; start: ProcessStartRecord }
export interface Exempt { updater: Identity; runner: Identity | null; helpers: Identity[] }

export type WritersProof =
  | { ok: true; uninspectable?: Array<{ pid: number; name: string | null; why: "non-dumpable" | "privileged" }> }
  | { ok: false; incomplete: true; reason: string }
  | { ok: false; incomplete: false; writers: Array<{ pid: number; why: string }>; reason: string };

const isUnder = (path: string, root: string) => path === root || path.startsWith(root + sep);

/**
 * The kernel's subset rule for a same-uid read (ptrace_may_access): refused when the target's permitted capabilities
 * hold a bit the reader's don't. Each argument is a `/proc/<pid>/status` text; a missing CapPrm line reads as none.
 */
export function capsExceed(targetStatus: string, readerStatus: string): boolean {
  const caps = (text: string) => BigInt(`0x${/^CapPrm:\s+([0-9a-f]+)/m.exec(text)?.[1] ?? "0"}`);
  return (caps(targetStatus) & ~caps(readerStatus)) !== 0n;
}

/** Re-reads of a process of this uid that can't be read, and the wait before each (≈ 100 ms in all). */
export const UNREADABLE_RETRIES = 5;
export const UNREADABLE_BACKOFF_MS = 20;

/** §4.4 for `home` (any spelling; compared as realpath), with the attempt's exempt set. */
export function proveWritersGone(home: string, exempt: Exempt, d: WritersDeps): WritersProof {
  if (d.platform !== "linux") return { ok: false, incomplete: true, reason: `no writers scan exists on ${d.platform} yet` };
  let root: string;
  try { root = realpathSync(home); } catch (err) { return { ok: false, incomplete: true, reason: `the home can't be resolved (${(err as Error).message})` }; }
  const pids = d.listPids();
  if (!pids) return { ok: false, incomplete: true, reason: "the process list can't be read" };

  const isExact = (pid: number, who: Identity | null) => !!who && who.pid === pid && d.sameProcess(pid, who.start);
  const owners = [exempt.updater, ...(exempt.runner ? [exempt.runner] : [])];
  /** A recorded helper whose ancestor chain (each step proven by its start) reaches the updater or the runner. */
  const isHelper = (pid: number): boolean => {
    const helper = exempt.helpers.find(h => h.pid === pid);
    if (!helper || !d.sameProcess(pid, helper.start)) return false;
    let cur: number | "gone" | null = pid;
    for (let hops = 0; hops < 64 && typeof cur === "number" && cur > 1; hops++) {
      const parent: number | "gone" | null = d.ppidOf(cur);
      if (typeof parent !== "number") return false;
      if (owners.some(o => isExact(parent, o))) return true;
      // An intermediate step must itself be a recorded helper (its start proven), never an unrecorded process.
      const step = exempt.helpers.find(h => h.pid === parent);
      if (!step || !d.sameProcess(parent, step.start)) return false;
      cur = parent;
    }
    return false;
  };

  const writers: Array<{ pid: number; why: string }> = [];
  const uninspectable: Array<{ pid: number; name: string | null; why: "non-dumpable" | "privileged" }> = [];
  type Read = { kind: "skip" } | { kind: "uninspectable"; why: "non-dumpable" | "privileged" } | { kind: "unreadable"; what: string }
    | { kind: "read"; env: string | undefined; cwd: string; files: string[] };
  /** One look at a pid: not ours, exempt, sealed, gone, unreadable, or its three reads. */
  const look = (pid: number): Read => {
    const uid = d.uidOf(pid);
    if (uid === "gone") return { kind: "skip" };
    if (uid === null) return { kind: "unreadable", what: "owner" };
    if (uid !== d.uid) return { kind: "skip" };
    if (owners.some(o => isExact(pid, o)) || isHelper(pid)) return { kind: "skip" };
    const sealed = d.sealed(pid);
    if (sealed) return { kind: "uninspectable", why: sealed };
    const env = d.agendHomeOf(pid), cwd = d.cwdOf(pid), files = d.filesOf(pid);
    if (env === "gone" || cwd === "gone" || files === "gone") return { kind: "skip" };
    if (env === null || cwd === null || files === null) return { kind: "unreadable", what: env === null ? "environment" : cwd === null ? "working directory" : "open files" };
    return { kind: "read", env, cwd, files };
  };
  for (const pid of pids) {
    let r = look(pid);
    // Unreadable: re-read with a backoff. Each look classifies afresh (gone → skipped; readable → judged). A pid that is
    // now a different process (another start) gets its own full set of tries, a few times at most: the scan stays bounded.
    let seen = r.kind === "unreadable" ? d.startOf(pid) : null;
    for (let tries = 0, renewals = 0; r.kind === "unreadable" && tries < UNREADABLE_RETRIES; tries++) {
      d.sleep(UNREADABLE_BACKOFF_MS);
      const start = d.startOf(pid);
      if (start && seen && !d.sameProcess(pid, seen) && renewals < 3) { seen = start; tries = -1; renewals++; }
      else if (!seen) seen = start;
      r = look(pid);
    }
    if (r.kind === "skip") continue;
    if (r.kind === "uninspectable") { uninspectable.push({ pid, name: d.nameOf?.(pid) ?? null, why: r.why }); continue; }
    if (r.kind === "unreadable") {
      const name = d.nameOf?.(pid);
      return { ok: false, incomplete: true, reason: `pid ${pid}${name ? ` (${name})` : ""}, this user's, stays unreadable (its ${r.what}) through ${UNREADABLE_RETRIES} re-reads` };
    }
    const { env, cwd, files } = r;
    const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
    if (env !== undefined && real(env) === root) { writers.push({ pid, why: `its AGEND_HOME is this home` }); continue; }
    if (isUnder(real(cwd), root)) { writers.push({ pid, why: `its working directory is under the home (${cwd})` }); continue; }
    const scoped = files.find(f => {
      if (!isUnder(f, root) || f === root) return false;
      const rel = f.slice(root.length + 1).split(sep).join("/");
      try { return classify(rel).included; } catch { return false; }
    });
    if (scoped) writers.push({ pid, why: `it has ${scoped} open or mapped` });
  }
  return writers.length
    ? { ok: false, incomplete: false, writers, reason: writers.map(w => `pid ${w.pid}: ${w.why}`).join("; ") }
    : { ok: true, ...(uninspectable.length ? { uninspectable } : {}) };
}

/** Linux: `/proc`. A process that exits mid-read is "gone"; anything else unreadable is null. */
export function procWritersDeps(sameProcess: WritersDeps["sameProcess"], startOf: (pid: number) => string | null): WritersDeps {
  const gone = (err: unknown) => ["ENOENT", "ESRCH"].includes((err as NodeJS.ErrnoException).code ?? "");
  const read = <T>(fn: () => T): T | "gone" | null => { try { return fn(); } catch (err) { return gone(err) ? "gone" : null; } };
  return {
    listPids: () => { try { return readdirSync("/proc").filter(n => /^\d+$/.test(n)).map(Number); } catch { return null; } },
    uidOf: pid => read(() => statSync(`/proc/${pid}`).uid),
    agendHomeOf: pid => read(() => {
      const env = readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").find(e => e.startsWith("AGEND_HOME="));
      return env === undefined ? undefined : env.slice("AGEND_HOME=".length);
    }),
    cwdOf: pid => read(() => readlinkSync(`/proc/${pid}/cwd`)),
    filesOf: pid => read(() => {
      const out: string[] = [];
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try { const t = readlinkSync(join(`/proc/${pid}/fd`, fd)); if (t.startsWith("/")) out.push(t.replace(/ \(deleted\)$/, "")); }
        catch (err) { if (!gone(err)) throw err; }                       // an fd closed mid-read: skip it
      }
      for (const line of readFileSync(`/proc/${pid}/maps`, "utf8").split("\n")) {
        const at = line.indexOf("/");
        if (at >= 0) out.push(line.slice(at).replace(/ \(deleted\)$/, ""));
      }
      return out;
    }),
    ppidOf: pid => read(() => {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    }),
    startOf: pid => { const t = startOf(pid); return t ? { processStart: t } : null; },
    sleep: ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
    sealed: pid => {
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const real = /^Uid:\s+(\d+)/m.exec(status)?.[1];
        if (real === undefined || Number(real) === 0) return false;
        // Non-dumpable: its per-process files are root's.
        if (statSync(`/proc/${pid}/fd`).uid === 0) return "non-dumpable";
        // Privileged: it holds capabilities this process doesn't, so the kernel refuses to let this process read it
        // (ptrace read access) though both run as one uid (Fable #4524 CI: a runner process). AgEnD's processes hold none.
        return capsExceed(status, readFileSync("/proc/self/status", "utf8")) ? "privileged" : false;
      } catch { return false; }
    },
    nameOf: pid => { try { return /^Name:\s+(.*)$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? null; } catch { return null; } },
    sameProcess,
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    platform: process.platform,
  };
}
