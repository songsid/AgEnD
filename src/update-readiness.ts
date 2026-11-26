/**
 * M-3770 slice 1.2 (design #4480 §4): can this machine update itself safely? Three outcomes, not pass or fail:
 *   - self        every check below passes and is proven;
 *   - admin-only  the install and its data are proven, but this setup can't bring itself back, or needs an admin's hand:
 *                 only an admin's own press updates it, never a schedule;
 *   - stop        the install, its platform or the target can't be proven or can't succeed here: no one updates it.
 * Each failing check carries a fixed code (never raw error text); the page and chat word it. A check that could not be
 * evaluated (no target offered, a requirement npm couldn't read) is ABSENT from `checks`, never reported as passing, and
 * the class is computed from the checks present.
 *
 * This slice covers P1 (the install that runs), P3 (the service brings it back), P4 (it may write the install), P5 (a
 * linked or vendored copy), P7 (the update source answers), P9 (a platform we update) and P10 (the target runs here).
 * P2, P6 and P8 come with slice 1.3.
 *
 * The result is a diagnostic: every launch runs the local checks again (`localOnly`) right before it spawns
 * (identity proven at the moment of change, §4.2). Runs on the fleet's event loop: every probe is async and bounded.
 */
import { constants } from "node:fs";
import { access, lstat, readdir, readFile, realpath, stat, statfs } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { execFile } from "./child-process.js";
import { defaultDispatchDeps, npmForRunningInstall, resolveInstalledAgend, runningInstall, type DispatchDeps } from "./update-dispatch.js";
import { NODE_PROBE_SCRIPT, evaluateUpdateTarget, lookupTargetManifest, runtimePlatform, type RuntimeHost, type SystemNode } from "./update-preflight.js";
import { isLocalLinkTarget } from "./update-install.js";
import { applyUpdateNpmBounds, npmConfigQuery, parseNpmConfigLs, registryUnreachable, updateRegistry, updateScriptsIgnored } from "./update-npm-env.js";
import { serviceManagerOf } from "./update-launch.js";
import { isExactVersion } from "./update-check.js";
import { startedByServiceManager, systemdServiceOf } from "./service-owner.js";
import { checkQuiet, checkSharing, checkSpace, procUidBy, type HostDeps } from "./update-readiness-host.js";
import { lockHolderAt } from "./home-update-lock.js";
import { isUpdateInProgress } from "./update-marker.js";
import { readCurrent } from "./update-journal.js";
import { createRequire } from "node:module";

export type PreflightClass = "self" | "admin-only" | "stop";
export type PreflightId = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8" | "P9" | "P10";
export type PreflightCode =
  | "checkout" | "other-copy" | "path-shadow" | "unreadable"                                  // P1
  | "shared-home" | "unknown-owner" | "other-install"                                       // P2
  | "not-service" | "service-unknown" | "linger-off" | "system-unit-not-root" | "unit-reload-pending" // P3
  | "no-write"                                                                              // P4
  | "linked" | "vendored"                                                                   // P5
  | "low-disk"                                                                              // P6
  | "npm-unreachable" | "scripts-off"                                                       // P7
  | "rehearsal" | "update-running"                                                          // P8
  | "container" | "windows-runtime"                                                         // P9
  | "node-too-old";                                                                         // P10
/** One check's result. `checkedAt`: when THIS check ran (a merged result keeps each row's own age). */
export interface PreflightCheck { id: PreflightId; ok: boolean; code?: PreflightCode; detail?: Record<string, string | number>; checkedAt?: number }
export interface UpdatePreflight {
  class: PreflightClass;
  /** The OLDEST row's time: the result is no fresher than its oldest check. */
  checkedAt: number;
  checks: PreflightCheck[];
  /** An admin's press from the web or chat may start it: not stop, and not P4 (that needs `sudo agend update` in a shell). */
  pressHere: boolean;
  /** The version P10 was judged for (null: none). */
  target: string | null;
  /** The proven install's `agend` (null: not proven): P7 and P10 hold only for this install. */
  install: string | null;
}

/** What a failing check makes the machine (design §4.1's table). */
const FAILS_TO: Record<PreflightId, PreflightClass> = {
  P1: "stop", P2: "stop", P3: "admin-only", P4: "admin-only", P5: "admin-only", P6: "stop", P7: "stop", P8: "stop", P9: "stop", P10: "stop",
};

/** What one failing row makes the machine: by its check, except P2's `other-install` (proven disjoint), which is admin-only. */
const failsTo = (c: PreflightCheck): PreflightClass => (c.id === "P2" && c.code === "other-install" ? "admin-only" : FAILS_TO[c.id]);

/** The class of a set of results: the worst failing check's, else self. */
export function preflightClass(checks: readonly PreflightCheck[]): PreflightClass {
  let worst: PreflightClass = "self";
  for (const c of checks) {
    if (c.ok) continue;
    const to = failsTo(c);
    if (to === "stop") return "stop";
    worst = "admin-only";
  }
  return worst;
}

/** The local checks a result must hold, passed, before it may be self (a partial or empty result is never self). */
const SELF_NEEDS: readonly PreflightId[] = ["P1", "P2", "P3", "P4", "P8", "P9"];

export function summarize(checks: PreflightCheck[], checkedAt: number, scope: { target?: string | null; install?: string | null } = {}): UpdatePreflight {
  const rows = checks.map(c => (c.checkedAt === undefined ? { ...c, checkedAt } : c));
  let cls = preflightClass(rows);
  if (cls === "self" && !SELF_NEEDS.every(id => rows.some(c => c.id === id && c.ok))) cls = "admin-only";
  const oldest = rows.length ? Math.min(...rows.map(c => c.checkedAt!)) : checkedAt;
  return { class: cls, checkedAt: oldest, checks: rows, pressHere: cls !== "stop" && !rows.some(c => c.id === "P4" && !c.ok),
    target: scope.target ?? null, install: scope.install ?? null };
}

const ORDER: readonly PreflightId[] = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"];

/**
 * A cached result brought up to date with a fresher one (a launch's local re-proof, or a refresh). Per check, the newer
 * row wins. A P7 or P10 row only `prev` holds is kept only while it still applies: the same proven install, and for
 * P10 the version offered now (`target`); otherwise it is dropped, never relabelled. The result is as old as its
 * oldest row.
 */
export function mergePreflight(prev: UpdatePreflight | null, fresh: UpdatePreflight, target: string | null): UpdatePreflight {
  const rows = new Map<PreflightId, PreflightCheck>();
  for (const c of fresh.checks) rows.set(c.id, c);
  for (const c of prev?.checks ?? []) {
    const mine = rows.get(c.id);
    if (mine) {
      if ((c.checkedAt ?? 0) > (mine.checkedAt ?? 0) && prev!.install === fresh.install && (c.id !== "P10" || prev!.target === target)) rows.set(c.id, c);
      continue;
    }
    if (c.id !== "P7" && c.id !== "P10") continue;                                      // local checks: the fresh run's only
    if (!prev || prev.install === null || prev.install !== fresh.install) continue;
    if (c.id === "P10" && (prev.target === null || prev.target !== target)) continue;
    rows.set(c.id, c);
  }
  // A P10 the fresh run made is for the version it was asked about: kept only while that is still the one offered.
  if (rows.get("P10") && fresh.checks.includes(rows.get("P10")!) && fresh.target !== target) rows.delete("P10");
  const checks = [...rows.values()].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  return summarize(checks, fresh.checkedAt, { target: rows.has("P10") ? target : null, install: fresh.install });
}

/** Whether `origin` may start an update on a machine with this result: a press needs pressHere; anything unattended, self. */
export function preflightAllows(p: UpdatePreflight, origin: "press" | "unattended"): boolean {
  return origin === "press" ? p.pressHere : p.class === "self";
}

export interface ReadinessDeps extends HostDeps {
  dispatch: DispatchDeps;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  uid: number;
  user: string;
  ppid: number;
  /** This fleet's AgEnD home (the fleet passes its own; default: AGEND_HOME, else ~/.agend). */
  home: string;
  /** /proc/self/cgroup, or null off Linux / unreadable. */
  ownCgroup(): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  writable(path: string): Promise<boolean>;
  isSymlink(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  readText(path: string): Promise<string | null>;
  /** A bounded command: its exit status (null: it could not run, or timed out — `timedOut`), stdout and stderr. */
  run(command: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string; timedOut?: boolean }>;
  host(): RuntimeHost;
  now(): number;
}

const bounded = async (p: Promise<unknown>) => { try { await p; return true; } catch { return false; } };
export const defaultReadinessDeps = (): ReadinessDeps => ({
  dispatch: defaultDispatchDeps,
  platform: process.platform,
  env: process.env,
  uid: typeof process.getuid === "function" ? process.getuid() : -1,
  user: (() => { try { return userInfo().username; } catch { return ""; } })(),
  ppid: process.ppid,
  ownCgroup: async () => { try { return await readFile("/proc/self/cgroup", { encoding: "utf8", signal: AbortSignal.timeout(2000) }); } catch { return null; } },
  exists: path => bounded(access(path, constants.F_OK)),
  writable: path => bounded(access(path, constants.W_OK)),
  isSymlink: async path => { try { return (await lstat(path)).isSymbolicLink(); } catch { return false; } },
  realpath: path => realpath(path),
  readText: async path => { try { return await readFile(path, { encoding: "utf8", signal: AbortSignal.timeout(2000) }); } catch { return null; } },
  run: (command, args, timeoutMs, env) => new Promise(resolve => {
    execFile(command, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
      const code = err ? (err as { code?: unknown }).code : 0;
      const timedOut = !!err && (err as { killed?: boolean }).killed === true;
      resolve({ status: typeof code === "number" ? code : null, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), ...(timedOut ? { timedOut } : {}) });
    });
  }),
  host: () => runtimePlatform.hostPlatform(),
  now: () => Date.now(),
  pid: process.pid,
  home: process.env.AGEND_HOME || join(homedir(), ".agend"),
  homeDir: homedir(),
  listDir: async path => { try { return await readdir(path); } catch { return []; } },
  listPids: async () => { try { return (await readdir("/proc")).filter(n => /^\d+$/.test(n)).map(Number); } catch { return null; } },
  procArgv: async pid => { try { return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean); } catch { return null; } },
  procEnv: async pid => {
    try {
      const out: Record<string, string> = Object.create(null);
      for (const kv of (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0")) { const at = kv.indexOf("="); if (at > 0) out[kv.slice(0, at)] = kv.slice(at + 1); }
      return out;
    } catch { return null; }
  },
  procUid: procUidBy(path => stat(path)),
  freeBytes: async path => { try { const s = await statfs(path); return Number(s.bavail) * Number(s.bsize); } catch { return null; } },
  lockHolder: path => lockHolderAt(path, admission()),
  updateInProgress: home => { try { return isUpdateInProgress(home); } catch { return false; } },
  journalState: home => readCurrent(home).state,
});

/** The lock-holder helpers the installer's postinstall shares (launcher/install-admission.cjs). */
const admission = (): { processStart(pid: number): string | null; startTicks(pid: number): string | null; bootId(): string | null } =>
  createRequire(import.meta.url)("../launcher/install-admission.cjs");

/** The first executable `name` on `path`. */
async function onPath(d: ReadinessDeps, name: string, path: string): Promise<string | null> {
  const executable = d.dispatch.isExecutable ?? defaultDispatchDeps.isExecutable!;
  for (const dir of path.split(delimiter)) if (dir && isAbsolute(dir) && await executable(join(dir, name))) return join(dir, name);
  return null;
}

interface Install { root: string; prefix: string; npmDir?: string; agend: string; packageDir: string; linked: boolean }

/** P1 (and the install P4/P5/P7/P10 build on): the running package is the global one npm updates, and PATH's agend is it. */
async function checkInstall(d: ReadinessDeps): Promise<{ check: PreflightCheck; install: Install | null; runningRoot: string | null }> {
  const running = await runningInstall(d.dispatch);
  if (running.kind === "unreadable") return { check: { id: "P1", ok: false, code: "unreadable" }, install: null, runningRoot: null };
  const found = await npmForRunningInstall(d.dispatch);
  const installed = "reason" in found ? null : await resolveInstalledAgend(d.dispatch);
  if (running.kind === "checkout") {
    // `npm link`: the global entry is a link to this very folder (Node runs a linked package from its real path, so it
    // reads as a checkout). npm updates that entry (replacing the link): the install is proven, P5 names the link.
    const entry = "reason" in found ? null : join(found.root, "@songsid", "agend");
    let mine = false;
    if (entry && installed?.ok && d.dispatch.packageDir && await d.isSymlink(entry)) {
      try { mine = await d.realpath(entry) === await d.realpath(d.dispatch.packageDir); } catch { mine = false; }
    }
    if (!mine || "reason" in found || !installed?.ok) return { check: { id: "P1", ok: false, code: "checkout" }, install: null, runningRoot: null };
    return pathAgrees(d, { root: found.root, prefix: found.prefix, ...(found.npmDir ? { npmDir: found.npmDir } : {}), agend: installed.agend, packageDir: entry!, linked: true }, null);
  }
  if ("reason" in found || !installed || !installed.ok) {
    return { check: { id: "P1", ok: false, code: "other-copy", detail: { path: join(running.root, "@songsid", "agend") } }, install: null, runningRoot: running.root };
  }
  return pathAgrees(d, { root: found.root, prefix: found.prefix, ...(found.npmDir ? { npmDir: found.npmDir } : {}), agend: installed.agend, packageDir: join(found.root, "@songsid", "agend"), linked: false }, running.root);
}

/**
 * P1's last part, for every proven install (a registry install or an npm link alike): PATH's `agend` (the fleet's) is
 * that install's file. Another file there would run instead of the one updated. Moved before the install (#4480 P1).
 */
async function pathAgrees(d: ReadinessDeps, install: Install, runningRoot: string | null): Promise<{ check: PreflightCheck; install: Install; runningRoot: string | null }> {
  const first = await onPath(d, "agend", d.env.PATH ?? "");
  if (first) {
    let same = false;
    try { same = await d.realpath(first) === await d.realpath(install.agend); } catch { same = false; }
    if (!same) return { check: { id: "P1", ok: false, code: "path-shadow", detail: { path: first } }, install, runningRoot };
  }
  return { check: { id: "P1", ok: true }, install, runningRoot };
}

/**
 * P3: the service manager will bring it back after the update — proven, not assumed. A service whose proof can't be had
 * (a query that fails, times out or answers nothing; a unit not loaded or not active; on macOS a parent of 1 with no
 * launchd job naming this process) is `service-unknown`: admin-only, never self.
 */
async function checkService(d: ReadinessDeps): Promise<PreflightCheck | null> {
  if (d.platform === "win32") return null;                                       // P9's (the Runtime updates itself)
  if (d.platform === "darwin") return checkLaunchd(d);
  const cgroup = d.platform === "linux" ? await d.ownCgroup() : null;
  if (!startedByServiceManager({ platform: d.platform, env: d.env, ownCgroup: cgroup, ppid: d.ppid, launchdLabel: LAUNCHD_LABEL })) {
    return { id: "P3", ok: false, code: "not-service" };
  }
  if (d.platform !== "linux" || cgroup === null) return { id: "P3", ok: false, code: "service-unknown" };
  const manager = serviceManagerOf(cgroup), unit = systemdServiceOf(cgroup);
  if (!manager || !unit) return { id: "P3", ok: false, code: "service-unknown" };
  if (manager === "system" && d.uid !== 0) return { id: "P3", ok: false, code: "system-unit-not-root" };
  if (manager === "user" && (!d.user || !await d.exists(`/var/lib/systemd/linger/${d.user}`))) return { id: "P3", ok: false, code: "linger-off", detail: { user: d.user } };
  const r = await d.run("systemctl", [...(manager === "user" ? ["--user"] : []), "show", `${unit}.service`, "-p", "LoadState", "-p", "ActiveState", "-p", "NeedDaemonReload"], 5000);
  const props = new Map(r.status === 0 ? r.stdout.split("\n").map(l => /^(\w+)=(.*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m).map(m => [m[1]!, m[2]!.trim()]) : []);
  if (props.get("LoadState") !== "loaded" || !["active", "reloading"].includes(props.get("ActiveState") ?? "") || !["yes", "no"].includes(props.get("NeedDaemonReload") ?? "")) {
    return { id: "P3", ok: false, code: "service-unknown" };
  }
  if (props.get("NeedDaemonReload") === "yes") return { id: "P3", ok: false, code: "unit-reload-pending" };
  return { id: "P3", ok: true };
}

const LAUNCHD_LABEL = "com.agend.fleet";

/** macOS: launchd names its job in XPC_SERVICE_NAME, and the job must be loaded and running. A parent of 1 alone proves nothing. */
async function checkLaunchd(d: ReadinessDeps): Promise<PreflightCheck> {
  if (d.env.XPC_SERVICE_NAME !== LAUNCHD_LABEL) return { id: "P3", ok: false, code: d.ppid === 1 ? "service-unknown" : "not-service" };
  const r = await d.run("launchctl", ["print", `gui/${d.uid}/${LAUNCHD_LABEL}`], 5000);
  return r.status === 0 && /^\s*state = running\s*$/m.test(r.stdout) ? { id: "P3", ok: true } : { id: "P3", ok: false, code: "service-unknown" };
}

/** P4: this user may write the install (no silent sudo or nvm route is ever taken). */
async function checkWrite(d: ReadinessDeps, install: Install): Promise<PreflightCheck> {
  for (const path of [install.packageDir, install.root, install.prefix, join(install.prefix, "bin")]) {
    if (!await d.writable(path)) return { id: "P4", ok: false, code: "no-write", detail: { path } };
  }
  return { id: "P4", ok: true };
}

/** P5: the global entry is an `npm link` to a development folder, or the running copy sits in another project's node_modules. */
async function checkCopy(d: ReadinessDeps, install: Install | null, runningRoot: string | null): Promise<PreflightCheck | null> {
  if (runningRoot && !install) {
    // A copy inside a project: `<project>/node_modules/@songsid/agend`, not `<prefix>/lib/node_modules` (POSIX global).
    const project = dirname(runningRoot);
    if (d.platform !== "win32" && !project.endsWith("/lib") && await d.exists(join(project, "package.json"))) return { id: "P5", ok: false, code: "vendored", detail: { path: project } };
  }
  if (!install) return null;
  if (install.linked || await d.isSymlink(install.packageDir)) {
    let target = "";
    try { target = await d.realpath(install.packageDir); } catch { target = ""; }
    if (install.linked || isLocalLinkTarget(true, target)) return { id: "P5", ok: false, code: "linked", detail: { path: target } };
  }
  return { id: "P5", ok: true };
}

/** The environment npm runs in for this install: the proving npm's directory and the install's bin first. */
function npmEnv(d: ReadinessDeps, install: Install): NodeJS.ProcessEnv {
  const first = [install.npmDir, join(install.prefix, "bin")].filter((p): p is string => !!p);
  return { ...d.env, PATH: [...first, d.env.PATH ?? ""].filter(Boolean).join(delimiter) };
}

/**
 * P7: `npm ping` against the registry AgEnD comes from, with the update's own npm bounds (a person's settings kept), so a
 * dead registry fails in seconds instead of npm's minutes of retries. A network failure, or no answer at all within the
 * bound, is npm-unreachable; a registry without ping says nothing about the network (as `agend update`'s own stop).
 * M-3805: npm set to skip install scripts (`ignore-scripts`, any npm) is scripts-off: the new version's install step would
 * not run and it would not start. On npm 12 `agend update` allows AgEnD's own scripts itself (applyUpdateAllowScripts).
 */
async function checkSource(d: ReadinessDeps, install: Install): Promise<PreflightCheck | null> {
  const env = npmEnv(d, install);
  const listed = await d.run("npm", npmConfigQuery(), 15_000, env);
  const explicit = listed.status === 0 ? parseNpmConfigLs(listed.stdout) : null;
  if (updateScriptsIgnored(env, explicit)) return { id: "P7", ok: false, code: "scripts-off" };
  const registry = updateRegistry(explicit);
  if (!registry) return null;
  applyUpdateNpmBounds(env, explicit);
  const ping = await d.run("npm", ["ping", "--registry", registry], 90_000, env);
  if (ping.timedOut) return { id: "P7", ok: false, code: "npm-unreachable" };
  if (ping.status === null) return null;                                       // npm could not run: says nothing
  return registryUnreachable(ping) ? { id: "P7", ok: false, code: "npm-unreachable" } : { id: "P7", ok: true };
}

/** P9: a container, or Windows (its AgEnD Runtime updates itself). */
async function checkPlatform(d: ReadinessDeps): Promise<PreflightCheck> {
  if (d.platform === "win32") return { id: "P9", ok: false, code: "windows-runtime" };
  if (d.platform === "linux") {
    if (await d.exists("/.dockerenv") || await d.exists("/run/.containerenv")) return { id: "P9", ok: false, code: "container" };
    const init = await d.readText("/proc/1/cgroup");
    if (init && /\/(?:docker|kubepods|containerd|libpod|lxc)[/.-]/.test(init)) return { id: "P9", ok: false, code: "container" };
  }
  return { id: "P9", ok: true };
}

/** P10: the target's Node requirement, on the Node it will run on here. Unknown (unreadable, no target): absent. */
async function checkTarget(d: ReadinessDeps, install: Install, target: string): Promise<PreflightCheck | null> {
  const env = npmEnv(d, install);
  const spec = `@songsid/agend@${target}`;
  if (!isExactVersion(target)) return null;
  // lookupTargetManifest reads through a callback and validates the answer: the async answer is fetched first.
  let raw: string | null = null;
  const view = await d.run("npm", ["view", spec, "version", "engines", "optionalDependencies", "--json"], 30_000, env);
  if (view.status === 0) raw = view.stdout;
  const manifest = lookupTargetManifest(spec, target, () => raw);
  if (!manifest) return null;
  const probe = await d.run("sh", ["-c", NODE_PROBE_SCRIPT], 10_000, env);
  const m = probe.status === 0 ? /^(\d+\.\d+\.\d+) (\/.*)$/.exec(probe.stdout.trim().split("\n").pop()?.trim() ?? "") : null;
  const system: SystemNode = probe.status === 127 ? { kind: "none" }
    : m ? { kind: "version", version: m[1]!, path: m[2]!, label: "the Node on the update's PATH" }
    : { kind: "unknown", note: "unreadable" };
  const verdict = evaluateUpdateTarget({ manifest, host: d.host(), system });
  if (verdict.kind === "unknown") return null;
  if (verdict.kind === "refuse") {
    return { id: "P10", ok: false, code: "node-too-old", detail: { node: system.kind === "version" ? system.version : "none", needs: manifest.engines ?? "" } };
  }
  return { id: "P10", ok: true };
}

/**
 * Run the checks. `target`: the offered version, for P10 (absent: P10 is not reported). `localOnly`: the checks a launch
 * re-proves (P1, P3, P4, P5, P9): no network, since `agend update` pings and checks the target itself.
 */
export async function runUpdatePreflight(opts: { target?: string | null; localOnly?: boolean } = {}, d: ReadinessDeps = defaultReadinessDeps()): Promise<UpdatePreflight> {
  // Each row is stamped when its check finished (Prism #4483 R2): a run that then waits on the network must not make
  // what it saw earlier look newer than a launch's re-proof made meanwhile.
  const checks: PreflightCheck[] = [];
  const seen = (c: PreflightCheck | null): void => { if (c) checks.push({ ...c, checkedAt: d.now() }); };
  seen(await checkPlatform(d));
  const { check: p1, install, runningRoot } = await checkInstall(d);
  seen(p1);
  seen(await checkService(d));
  let ownPackage: string | null = null;
  if (install) { try { ownPackage = await d.realpath(install.packageDir); } catch { ownPackage = null; } }
  seen(await checkSharing(d, d.home, ownPackage));
  if (install) seen(await checkWrite(d, install));
  seen(await checkCopy(d, install, runningRoot));
  seen(await checkSpace(d, d.home, install));
  seen(await checkQuiet(d, d.home, install, !!opts.localOnly));
  if (install && !opts.localOnly) {
    seen(await checkSource(d, install));
    if (opts.target) seen(await checkTarget(d, install, opts.target));
  }
  checks.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  return summarize(checks, d.now(), { target: checks.some(c => c.id === "P10") ? opts.target ?? null : null, install: install?.agend ?? null });
}

/** One failing check in words (the fleet's language): its fixed code, with only the values its sentence names. */
export function preflightWords(check: PreflightCheck, tr: (key: string, ...args: string[]) => string): string {
  const d = check.detail ?? {};
  const args = check.code === "node-too-old" ? [String(d.node ?? ""), String(d.needs ?? "")]
    : check.code === "low-disk" ? [String(d.need ?? ""), String(d.have ?? ""), String(d.path ?? "")]
    : check.code === "shared-home" || check.code === "other-install" ? [String(d.path ?? ""), String(d.home ?? "?")]
    : [String(d.path ?? d.user ?? "")];
  return tr(`update.preflight.code.${check.code}`, ...args);
}

/**
 * The refusal a launch gives, or null when `origin` may go ahead: the first check that stops it, in words. A press is
 * refused by stop or by P4 (that needs a shell with sudo); anything unattended needs class self.
 */
export function preflightRefusal(p: UpdatePreflight, origin: "press" | "unattended", tr: (key: string, ...args: string[]) => string): string | null {
  if (preflightAllows(p, origin)) return null;
  const blocking = p.checks.find(c => !c.ok && (failsTo(c) === "stop" || c.id === "P4"));
  if (blocking) return tr("update.preflight.refused", preflightWords(blocking, tr));
  const first = p.checks.find(c => !c.ok);
  return tr("update.preflight.press_only", first ? preflightWords(first, tr) : "");
}
