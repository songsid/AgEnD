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
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { execFile } from "./child-process.js";
import { defaultDispatchDeps, npmForRunningInstall, resolveInstalledAgend, runningInstall, type DispatchDeps } from "./update-dispatch.js";
import { NODE_PROBE_SCRIPT, evaluateUpdateTarget, lookupTargetManifest, runtimePlatform, type RuntimeHost, type SystemNode } from "./update-preflight.js";
import { isLocalLinkTarget } from "./update-install.js";
import { applyUpdateNpmBounds, npmConfigQuery, parseNpmConfigLs, registryUnreachable, updateRegistry } from "./update-npm-env.js";
import { serviceManagerOf } from "./update-launch.js";
import { isExactVersion } from "./update-check.js";
import { startedByServiceManager, systemdServiceOf } from "./service-owner.js";

export type PreflightClass = "self" | "admin-only" | "stop";
export type PreflightId = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8" | "P9" | "P10";
export type PreflightCode =
  | "checkout" | "other-copy" | "path-shadow" | "unreadable"                                  // P1
  | "not-service" | "linger-off" | "system-unit-not-root" | "unit-reload-pending"           // P3
  | "no-write"                                                                              // P4
  | "linked" | "vendored"                                                                   // P5
  | "npm-unreachable"                                                                       // P7
  | "container" | "windows-runtime"                                                         // P9
  | "node-too-old";                                                                         // P10
export interface PreflightCheck { id: PreflightId; ok: boolean; code?: PreflightCode; detail?: Record<string, string | number> }
export interface UpdatePreflight {
  class: PreflightClass;
  checkedAt: number;
  checks: PreflightCheck[];
  /** An admin's press from the web or chat may start it: not stop, and not P4 (that needs `sudo agend update` in a shell). */
  pressHere: boolean;
}

/** What a failing check makes the machine (design §4.1's table). */
const FAILS_TO: Record<PreflightId, PreflightClass> = {
  P1: "stop", P2: "stop", P3: "admin-only", P4: "admin-only", P5: "admin-only", P6: "stop", P7: "stop", P8: "stop", P9: "stop", P10: "stop",
};

/** The class of a set of results: the worst failing check's, else self. */
export function preflightClass(checks: readonly PreflightCheck[]): PreflightClass {
  let worst: PreflightClass = "self";
  for (const c of checks) {
    if (c.ok) continue;
    const to = FAILS_TO[c.id];
    if (to === "stop") return "stop";
    worst = "admin-only";
  }
  return worst;
}

export function summarize(checks: PreflightCheck[], checkedAt: number): UpdatePreflight {
  const cls = preflightClass(checks);
  return { class: cls, checkedAt, checks, pressHere: cls !== "stop" && !checks.some(c => c.id === "P4" && !c.ok) };
}

/** Whether `origin` may start an update on a machine with this result: a press needs pressHere; anything unattended, self. */
export function preflightAllows(p: UpdatePreflight, origin: "press" | "unattended"): boolean {
  return origin === "press" ? p.pressHere : p.class === "self";
}

export interface ReadinessDeps {
  dispatch: DispatchDeps;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  uid: number;
  user: string;
  ppid: number;
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
});

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
    return { check: { id: "P1", ok: true }, install: { root: found.root, prefix: found.prefix, ...(found.npmDir ? { npmDir: found.npmDir } : {}), agend: installed.agend, packageDir: entry!, linked: true }, runningRoot: null };
  }
  if ("reason" in found || !installed || !installed.ok) {
    return { check: { id: "P1", ok: false, code: "other-copy", detail: { path: join(running.root, "@songsid", "agend") } }, install: null, runningRoot: running.root };
  }
  const install: Install = { root: found.root, prefix: found.prefix, ...(found.npmDir ? { npmDir: found.npmDir } : {}), agend: installed.agend, packageDir: join(found.root, "@songsid", "agend"), linked: false };
  // PATH's `agend` (the fleet's): another file there would run instead of the one updated. Moved before the install (#4480 P1).
  const first = await onPath(d, "agend", d.env.PATH ?? "");
  if (first) {
    let same = false;
    try { same = await d.realpath(first) === await d.realpath(installed.agend); } catch { same = false; }
    if (!same) return { check: { id: "P1", ok: false, code: "path-shadow", detail: { path: first } }, install, runningRoot: running.root };
  }
  return { check: { id: "P1", ok: true }, install, runningRoot: running.root };
}

/** P3: the service manager will bring it back after the update. */
async function checkService(d: ReadinessDeps): Promise<PreflightCheck | null> {
  if (d.platform === "win32") return null;                                       // P9's (the Runtime updates itself)
  const cgroup = d.platform === "linux" ? await d.ownCgroup() : null;
  if (!startedByServiceManager({ platform: d.platform, env: d.env, ownCgroup: cgroup, ppid: d.ppid, launchdLabel: "com.agend.fleet" })) {
    return { id: "P3", ok: false, code: "not-service" };
  }
  if (d.platform !== "linux" || cgroup === null) return { id: "P3", ok: true };
  const manager = serviceManagerOf(cgroup);
  if (manager === "system" && d.uid !== 0) return { id: "P3", ok: false, code: "system-unit-not-root" };
  const unit = systemdServiceOf(cgroup);
  if (manager === "user") {
    if (!d.user || !await d.exists(`/var/lib/systemd/linger/${d.user}`)) return { id: "P3", ok: false, code: "linger-off", detail: { user: d.user } };
  }
  if (unit && manager) {
    const r = await d.run("systemctl", [...(manager === "user" ? ["--user"] : []), "show", `${unit}.service`, "-p", "NeedDaemonReload", "--value"], 5000);
    if (r.status === 0 && r.stdout.trim() === "yes") return { id: "P3", ok: false, code: "unit-reload-pending" };
  }
  return { id: "P3", ok: true };
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
 */
async function checkSource(d: ReadinessDeps, install: Install): Promise<PreflightCheck | null> {
  const env = npmEnv(d, install);
  const listed = await d.run("npm", npmConfigQuery(), 15_000, env);
  const explicit = listed.status === 0 ? parseNpmConfigLs(listed.stdout) : null;
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
  const checks: PreflightCheck[] = [];
  const platform = await checkPlatform(d);
  const { check: p1, install, runningRoot } = await checkInstall(d);
  checks.push(p1);
  const p3 = await checkService(d);
  if (p3) checks.push(p3);
  if (install) checks.push(await checkWrite(d, install));
  const p5 = await checkCopy(d, install, runningRoot);
  if (p5) checks.push(p5);
  if (install && !opts.localOnly) {
    const p7 = await checkSource(d, install);
    if (p7) checks.push(p7);
    if (opts.target) {
      const p10 = await checkTarget(d, install, opts.target);
      if (p10) checks.push(p10);
    }
  }
  checks.push(platform);
  const order: PreflightId[] = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"];
  checks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return summarize(checks, d.now());
}

/** One failing check in words (the fleet's language): its fixed code, with only the values its sentence names. */
export function preflightWords(check: PreflightCheck, tr: (key: string, ...args: string[]) => string): string {
  const d = check.detail ?? {};
  const args = check.code === "node-too-old" ? [String(d.node ?? ""), String(d.needs ?? "")] : [String(d.path ?? d.user ?? "")];
  return tr(`update.preflight.code.${check.code}`, ...args);
}

/**
 * The refusal a launch gives, or null when `origin` may go ahead: the first check that stops it, in words. A press is
 * refused by stop or by P4 (that needs a shell with sudo); anything unattended needs class self.
 */
export function preflightRefusal(p: UpdatePreflight, origin: "press" | "unattended", tr: (key: string, ...args: string[]) => string): string | null {
  if (preflightAllows(p, origin)) return null;
  const blocking = p.checks.find(c => !c.ok && (FAILS_TO[c.id] === "stop" || c.id === "P4"));
  if (blocking) return tr("update.preflight.refused", preflightWords(blocking, tr));
  const first = p.checks.find(c => !c.ok);
  return tr("update.preflight.press_only", first ? preflightWords(first, tr) : "");
}
