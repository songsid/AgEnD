/**
 * #1450 C6, restart path 2: launchd's PLANNED activation. On launchd a reload IS an activation (bootout stops the job;
 * bootstrap of a RunAtLoad/KeepAlive plist starts it), so a refresh that is not meant to activate — `agend install
 * --no-activate`, which the old 2.1.12 updater runs before its final `agend restart` — never bootstraps. It writes the
 * proven new plist and records the plan:
 *   { label, plistPath, the new plist's sha256, the preimage (old plist content + the job loaded at planning time and
 *     its pid), pkgDir, createdAt }
 * A refresh whose proof fails puts the preimage back and leaves NO record. `agend restart` admits the activation only
 * when the record, the file, the expected tuple, the still-loaded preimage job and this package all agree; it then
 * performs exactly one bootout + bootstrap (service-activation.ts, with this preimage to roll back to) and deletes
 * the record.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureAgendHome } from "./agend-home.js";
import { parseLaunchctlPrint, parsePlist, sameJob, type ActivationTuple, type TupleDeps } from "./service-activation.js";
import { judgeTuple, type ExpectedTuple } from "./restart-guard.js";
import type { CommandResult } from "./update-install.js";

export const SERVICE_PLAN_FILE = "service-plan.json";
/** Exclusive lock directory for every publish, revoke and consume of `SERVICE_PLAN_FILE`. */
export const SERVICE_PLAN_LOCK = "service-plan.lock";
const PLAN_LOCK_MS = 15_000;

export interface ServicePlan {
  kind: "launchd-activation";
  label: string;
  plistPath: string;
  /** sha256 of the proven new plist, as written. */
  sha256: string;
  preimage: { plist: string; tuple: ActivationTuple; pid: number | null };
  pkgDir: string;
  createdAt: string;
}

export interface PlanDeps extends Pick<TupleDeps, "realpath" | "isExecutable"> {
  run(command: string, args: string[]): CommandResult;
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  removeFile(path: string): void;
  now(): Date;
  /**
   * Exclusive section covering this home's plan file. Every publisher, revoker and consumer of
   * `service-plan.json` must take it; a nested caller from another CLI waits. `pendingPlan` does not.
   */
  withPlanLock(fn: () => void): void;
}

export const planPath = (agendHome: string) => join(agendHome, SERVICE_PLAN_FILE);
export const planLockPath = (agendHome: string) => join(agendHome, SERVICE_PLAN_LOCK);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Holder files are named by pid so unlink is generation-specific (a stale reclaim cannot drop a successor). */
function pidFromName(name: string): number {
  if (!/^[1-9][0-9]*$/.test(name)) return 0;
  const pid = Number(name);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function stealDeadLock(dir: string): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  let liveOther = false;
  for (const name of names) {
    const pid = pidFromName(name);
    if (pid > 0) {
      if (pid !== process.pid && pidAlive(pid)) { liveOther = true; continue; }
      try { unlinkSync(join(dir, name)); } catch { /* gone */ }
      continue;
    }
    if (name === "pid") {
      let old = 0;
      try { old = Number(readFileSync(join(dir, name), "utf8").trim()); } catch { /* empty / unreadable */ }
      if (Number.isInteger(old) && old > 0 && old !== process.pid && pidAlive(old)) { liveOther = true; continue; }
    }
    try { unlinkSync(join(dir, name)); } catch { /* gone */ }
  }
  if (liveOther) return;
  try { rmdirSync(dir); } catch { /* ENOTEMPTY: a successor published its holder file */ }
}

function liveOtherHolder(dir: string, self: number): boolean {
  let names: string[];
  try { names = readdirSync(dir); } catch { return false; }
  return names.some(name => {
    const pid = pidFromName(name);
    return pid > 0 && pid !== self && pidAlive(pid);
  });
}

/**
 * Cross-process exclusive lock for this home's plan file (mkdir; holder file named by pid).
 * Same-process nested acquires wait until timeout — do not call a publisher from inside a
 * consumer's section; another CLI blocks.
 */
export function withFsPlanLock(agendHome: string, fn: () => void): void {
  ensureAgendHome(agendHome);
  const dir = planLockPath(agendHome);
  const mine = join(dir, String(process.pid));
  const deadline = Date.now() + PLAN_LOCK_MS;
  for (;;) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${dir}`);
      stealDeadLock(dir);
      sleepSync(20);
      continue;
    }
    let held = false;
    try {
      try {
        writeFileSync(mine, `${process.pid}\n`, { mode: 0o600 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      if (liveOtherHolder(dir, process.pid)) continue;
      held = true;
      fn();
      return;
    } finally {
      try { unlinkSync(mine); } catch { /* */ }
      if (held) {
        try { rmdirSync(dir); } catch { /* */ }
      }
    }
  }
}

/** Locked unlink of this home's plan. Install `--no-activate` revokes any earlier record first. */
export function revokePlan(agendHome: string, deps: Pick<PlanDeps, "removeFile" | "withPlanLock">): void {
  deps.withPlanLock(() => deps.removeFile(planPath(agendHome)));
}
/**
 * `launchctl print` exits that CONFIRM nothing is loaded: 113, no such service; 125, this session has no such domain
 * (an SSH login on a Mac nobody is logged in to has no gui/<uid>, so nothing can be loaded there). Anything else that
 * is not a readable job is uncertainty.
 */
export const LAUNCHD_NOT_LOADED = [113, 125];
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const completed = (r: CommandResult) => r.status !== null && r.signal === null;

function parsePlan(text: string | null): ServicePlan | null {
  if (text === null) return null;
  try {
    const p = JSON.parse(text) as ServicePlan;
    return p && p.kind === "launchd-activation" && typeof p.plistPath === "string" && typeof p.sha256 === "string"
      && p.preimage && typeof p.preimage.plist === "string" && p.preimage.tuple && typeof p.pkgDir === "string" ? p : null;
  } catch { return null; }
}

export function readPlan(agendHome: string, deps: Pick<PlanDeps, "readFile">): ServicePlan | null {
  return parsePlan(deps.readFile(planPath(agendHome)));
}

export type RefreshOutcome =
  | { ok: true; planned: boolean; message: string }
  | { ok: false; message: string };

/**
 * `agend install --no-activate` on launchd: write `newPlist`, prove it, and — when a job is loaded — record the plan
 * instead of activating. Nothing is bootstrapped or booted out here.
 */
export function refreshLaunchdWithoutActivating(
  o: { label: string; target: string; plistPath: string; newPlist: string; expected: ExpectedTuple; pkgDir: string; agendHome: string },
  deps: PlanDeps,
): RefreshOutcome {
  // An older plan never outlives a refresh, whatever this one comes to: removed before anything can fail.
  revokePlan(o.agendHome, deps);
  const preimage = deps.readFile(o.plistPath);
  const printed = deps.run("launchctl", ["print", o.target]);
  let loaded: ReturnType<typeof parseLaunchctlPrint> | null = null;
  if (completed(printed) && printed.status === 0) {
    loaded = parseLaunchctlPrint(printed.stdout);
    if (!loaded.tuple) return { ok: false, message: `launchctl print of ${o.label} could not be read; nothing was changed` };
    const onDisk = preimage === null ? null : parsePlist(preimage);
    if (!onDisk || !sameJob(loaded.tuple, onDisk)) {
      return { ok: false, message: `the job launchd has loaded for ${o.label} is not the one ${o.plistPath} describes, so there is no job to roll back to; nothing was changed` };
    }
  } else if (!(completed(printed) && LAUNCHD_NOT_LOADED.includes(printed.status ?? -1))) {
    return { ok: false, message: `could not tell whether ${o.label} is loaded (launchctl print ${printed.signal ? `killed by ${printed.signal}` : `exited ${printed.status}`}); nothing was changed` };
  }

  deps.writeFile(o.plistPath, o.newPlist);
  const restore = (why: string): RefreshOutcome => {
    if (preimage !== null) deps.writeFile(o.plistPath, preimage);
    else deps.removeFile(o.plistPath);
    return { ok: false, message: `${o.plistPath} ${why}; the previous plist is back, no activation is planned` };
  };
  const lint = deps.run("plutil", ["-lint", o.plistPath]);
  if (!completed(lint) || lint.status !== 0) return restore("does not pass plutil -lint");
  const tuple = parsePlist(o.newPlist);
  if (!tuple) return restore("cannot be read back");
  const judged = judgeTuple(tuple, o.expected, deps);
  if (!judged.ok) return restore(judged.reason);

  if (!loaded?.tuple || preimage === null) return { ok: true, planned: false, message: `${o.plistPath} written (no job is loaded; nothing to activate)` };
  const plan: ServicePlan = {
    kind: "launchd-activation", label: o.label, plistPath: o.plistPath, sha256: sha256(o.newPlist),
    preimage: { plist: preimage, tuple: loaded.tuple, pid: loaded.pid }, pkgDir: o.pkgDir, createdAt: deps.now().toISOString(),
  };
  deps.withPlanLock(() => deps.writeFile(planPath(o.agendHome), JSON.stringify(plan, null, 2) + "\n"));
  return { ok: true, planned: true, message: `${o.plistPath} written and proven; launchd still runs the previous job until \`agend restart\` activates it` };
}

/** Restart path 2: may this plan be activated now? Every condition, or a refusal naming the first that fails. */
export function admitPlan(plan: ServicePlan, o: { target: string; expected: ExpectedTuple; pkgDir: string }, deps: PlanDeps): { ok: true } | { ok: false; reason: string } {
  if (plan.pkgDir !== o.pkgDir) return { ok: false, reason: `the planned activation is for another install (${plan.pkgDir})` };
  const onDisk = deps.readFile(plan.plistPath);
  if (onDisk === null || sha256(onDisk) !== plan.sha256) return { ok: false, reason: `${plan.plistPath} changed since its activation was planned` };
  const tuple = parsePlist(onDisk);
  const judged = tuple ? judgeTuple(tuple, o.expected, deps) : { ok: false as const, reason: "cannot be read" };
  if (!judged.ok) return { ok: false, reason: `the planned plist ${judged.reason}` };
  const printed = deps.run("launchctl", ["print", o.target]);
  if (!completed(printed) || printed.status !== 0) return { ok: false, reason: `launchctl print ${o.target} did not show the planned-from job` };
  const loaded = parseLaunchctlPrint(printed.stdout);
  if (!loaded.tuple || !sameJob(loaded.tuple, plan.preimage.tuple) || loaded.pid !== plan.preimage.pid) {
    return { ok: false, reason: `the job launchd has loaded changed since the activation was planned (pid ${loaded.pid ?? "none"}, recorded ${plan.preimage.pid ?? "none"})` };
  }
  return { ok: true };
}

/**
 * #1871: has this plan already happened? An update that died between bootout and bootstrap leaves its plan behind;
 * after `agend start` loads the plist, launchd runs exactly the planned job, but under a new pid, so admitPlan refuses
 * it ("the job launchd has loaded changed"), and every `agend restart` with it. True when the plist on disk is still the
 * proven one and launchd runs its job. `agend restart` then restarts that job as an unchanged one (path 1, whose
 * guard proves it again); a plan that changes nothing about the job comes to the same restart.
 *
 * Read-only on purpose: a consumer that deleted after `launchctl print` would race with a refresh publishing at the
 * same path (Prism, #2376). Removal is compare-and-delete of a snapshot taken before that print (`consumeUnchangedPlan`).
 */
export function planCarriedOut(plan: ServicePlan, target: string, deps: Pick<PlanDeps, "readFile" | "run">): boolean {
  const onDisk = deps.readFile(plan.plistPath);
  if (onDisk === null || sha256(onDisk) !== plan.sha256) return false;
  const planned = parsePlist(onDisk);
  if (!planned) return false;
  const printed = deps.run("launchctl", ["print", target]);
  if (!completed(printed) || printed.status !== 0) return false;
  const loaded = parseLaunchctlPrint(printed.stdout);
  return !!loaded.tuple && sameJob(loaded.tuple, planned);
}

/**
 * The plan `agend restart` still has to carry out, or null (#2375). A plan whose job launchd already runs — #1871's
 * interrupted update after `agend start`, or an update whose planned plist is the job already loaded — is done:
 * nothing to activate, and nothing to say about it (every restart used to print a note). Read-only like
 * planCarriedOut: removing it here could remove a newer plan another refresh published while launchd was being asked
 * (Prism, #2376 R1). The publication path consumes the leftover with `consumeCarriedOutPlan`.
 */
export function pendingPlan(agendHome: string, target: string, deps: Pick<PlanDeps, "readFile" | "run">): ServicePlan | null {
  const recorded = readPlan(agendHome, deps);
  if (!recorded) return null;
  return planCarriedOut(recorded, target, deps) ? null : recorded;
}

/**
 * Delete the plan file only if it is still `snapshot` (#2439). After slow work (`launchctl print`, bootout) a refresh
 * may have published a newer plan; those bytes must stay. Read and unlink share `withPlanLock` with every publisher
 * and revoker: a second CLI that writes B after this comparison read waits, then publishes onto the empty path
 * (Prism #2441 P2). A second stat-then-unlink without that lock still loses B.
 */
export function consumeUnchangedPlan(agendHome: string, snapshot: string | null, deps: Pick<PlanDeps, "readFile" | "removeFile" | "withPlanLock">): void {
  if (snapshot === null) return;
  const path = planPath(agendHome);
  deps.withPlanLock(() => {
    if (deps.readFile(path) === snapshot) deps.removeFile(path);
  });
}

/**
 * After a plan is applied (or already carried out): snapshot, confirm launchd runs it, then compare-and-delete.
 * A newer plan published during the print is a different snapshot and is left (#2376). The final read/unlink is
 * locked with publishers so a publication after that read cannot be the unlink's target (#2441).
 */
export function consumeCarriedOutPlan(agendHome: string, target: string, deps: Pick<PlanDeps, "readFile" | "run" | "removeFile" | "withPlanLock">): void {
  const snapshot = deps.readFile(planPath(agendHome));
  const plan = parsePlan(snapshot);
  if (!plan || !planCarriedOut(plan, target, deps)) return;
  consumeUnchangedPlan(agendHome, snapshot, deps);
}
