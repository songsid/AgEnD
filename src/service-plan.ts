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
import { join } from "node:path";
import { parseLaunchctlPrint, parsePlist, sameJob, type ActivationTuple, type TupleDeps } from "./service-activation.js";
import { judgeTuple, type ExpectedTuple } from "./restart-guard.js";
import type { CommandResult } from "./update-install.js";

export const SERVICE_PLAN_FILE = "service-plan.json";

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

export interface PlanDeps extends Pick<TupleDeps, "realpath"> {
  run(command: string, args: string[]): CommandResult;
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  removeFile(path: string): void;
  now(): Date;
}

export const planPath = (agendHome: string) => join(agendHome, SERVICE_PLAN_FILE);
/**
 * `launchctl print` exits that CONFIRM nothing is loaded: 113, no such service; 125, this session has no such domain
 * (an SSH login on a Mac nobody is logged in to has no gui/<uid>, so nothing can be loaded there). Anything else that
 * is not a readable job is uncertainty.
 */
export const LAUNCHD_NOT_LOADED = [113, 125];
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const completed = (r: CommandResult) => r.status !== null && r.signal === null;

export function readPlan(agendHome: string, deps: Pick<PlanDeps, "readFile">): ServicePlan | null {
  const text = deps.readFile(planPath(agendHome));
  if (text === null) return null;
  try {
    const p = JSON.parse(text) as ServicePlan;
    return p && p.kind === "launchd-activation" && typeof p.plistPath === "string" && typeof p.sha256 === "string"
      && p.preimage && typeof p.preimage.plist === "string" && p.preimage.tuple && typeof p.pkgDir === "string" ? p : null;
  } catch { return null; }
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

  deps.removeFile(planPath(o.agendHome));                  // an older plan never outlives a new refresh
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
  deps.writeFile(planPath(o.agendHome), JSON.stringify(plan, null, 2) + "\n");
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
