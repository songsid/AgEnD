/**
 * M-3770 slice 2.3 (design update-transaction §4.4): the writers-gone proof. Run after the fences (§4.2), and again
 * after the snapshot's copy and after a restore, before their result is published.
 *
 * - **It looks for** any process of this uid that has `AGEND_HOME` equal to this home, its cwd under the home, or a file
 *   of the scope open or mapped (Linux: `/proc/<pid>/{environ,cwd,fd,maps}`).
 * - **An incomplete scan is never proof of absence:** a listing that fails, or a process of this uid that can't be read
 *   (one that exits mid-scan is gone, not unreadable).
 * - **Sealed processes (design rev 10).** A process of this uid that the kernel has made non-dumpable — its
 *   `/proc/<pid>/{cwd,fd,maps,environ}` belong to root, so no unprivileged reader can inspect them — is positively
 *   identified (its `status` reads this uid while its `fd` directory is root's) and reported as `uninspectable`, not as
 *   a gap: every systemd user session has one (`(sd-pam)`), and AgEnD's own processes and the CLIs it launches are
 *   never sealed (AgEnD lowers `coredump_filter`, it never clears the dumpable flag). Any other unreadable process
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
  /** Is `pid` sealed: this uid's, but non-dumpable (its per-process files are root's)? */
  sealed(pid: number): boolean;
  /** Does `pid`'s current start match `start`? (install-lock's identity: ticks + boot, else the lstart text.) */
  sameProcess(pid: number, start: ProcessStartRecord): boolean;
  uid: number;
  platform: NodeJS.Platform;
}

export interface Identity { pid: number; start: ProcessStartRecord }
export interface Exempt { updater: Identity; runner: Identity | null; helpers: Identity[] }

export type WritersProof =
  | { ok: true; uninspectable?: number[] }
  | { ok: false; incomplete: true; reason: string }
  | { ok: false; incomplete: false; writers: Array<{ pid: number; why: string }>; reason: string };

const isUnder = (path: string, root: string) => path === root || path.startsWith(root + sep);

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
  const uninspectable: number[] = [];
  for (const pid of pids) {
    const uid = d.uidOf(pid);
    if (uid === "gone") continue;
    if (uid === null) return { ok: false, incomplete: true, reason: `pid ${pid}'s owner can't be read` };
    if (uid !== d.uid) continue;
    if (owners.some(o => isExact(pid, o)) || isHelper(pid)) continue;
    if (d.sealed(pid)) { uninspectable.push(pid); continue; }
    const env = d.agendHomeOf(pid), cwd = d.cwdOf(pid), files = d.filesOf(pid);
    if (env === "gone" || cwd === "gone" || files === "gone") continue;
    if (env === null || cwd === null || files === null) return { ok: false, incomplete: true, reason: `pid ${pid} (this user's) can't be read` };
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
export function procWritersDeps(sameProcess: WritersDeps["sameProcess"]): WritersDeps {
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
    sealed: pid => {
      try {
        const real = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
        return real !== undefined && Number(real) !== 0 && statSync(`/proc/${pid}/fd`).uid === 0;
      } catch { return false; }
    },
    sameProcess,
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    platform: process.platform,
  };
}
