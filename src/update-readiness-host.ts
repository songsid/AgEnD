/**
 * M-3770 slice 1.3 (design #4480 §4.1 P2, P6, P8; §4.2): the pre-flight checks about the rest of this computer.
 *   - P2  one fleet per install and per home, proven: this home's live fleet is this process (its fleet.lock), no other
 *         live fleet uses this home or this package with another home. Other AgEnD services (systemd units, launchd
 *         plists) and the conventional global roots are scanned as a DIAGNOSTIC: what they show can make the machine
 *         stop or admin-only, never prove it disjoint (so never self on their word).
 *   - P6  room to update: free space in the install prefix and the home of at least 3 × the package size (Phase 1 takes
 *         no snapshot, so none is counted).
 *   - P8  nothing else is updating or being tested: a rehearsal/test marker (AGEND_REHEARSAL=1, AGEND_E2E=1 in the
 *         fleet's environment, `<home>/.no-auto-update`), another live updater's home or prefix lock, or (outside a
 *         launch's own re-proof) an update in progress.
 * Every probe is bounded and read-only; a check that can't be evaluated is absent, never passing.
 */
import { join, resolve } from "node:path";
import type { PreflightCheck } from "./update-readiness.js";

export interface HostDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  uid: number;
  user: string;
  /** This process (the fleet, when run in it). */
  pid: number;
  /** This user's home directory (for the conventional install and service places). */
  homeDir: string;
  exists(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  readText(path: string): Promise<string | null>;
  listDir(path: string): Promise<string[]>;
  run(command: string, args: string[], timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string; timedOut?: boolean }>;
  /** Linux: the pids in /proc; elsewhere []. */
  listPids(): Promise<number[]>;
  /** Linux: a process's argv, environment and owner (null: gone or unreadable). */
  procArgv(pid: number): Promise<string[] | null>;
  procEnv(pid: number): Promise<Record<string, string> | null>;
  procUid(pid: number): Promise<number | null>;
  /** Bytes free to this user on the filesystem holding `path` (statfs), or null. */
  freeBytes(path: string): Promise<number | null>;
  /** Who holds an owned lock file (home-update-lock.ts lockHolderAt). */
  lockHolder(path: string): { state: "free" | "unreadable" } | { state: "live" | "stale" | "unknown"; record: { pid: number } };
  /** An AgEnD update in progress for this home (its progress marker). */
  updateInProgress(home: string): boolean;
}

const same = (a: string, b: string) => resolve(a) === resolve(b);
const FLEET_START = /\b(?:agend|(?:cli|daemon-entry)\.(?:js|ts))\b.*\bfleet\s+start\b/;

/** The AgEnD package directory a path leads to (a bin link, `dist/cli.js`, a launcher), by its package.json; or null. */
async function packageOf(d: HostDeps, path: string): Promise<{ dir: string; version: string | null } | null> {
  let real: string;
  try { real = await d.realpath(path); } catch { return null; }
  let dir = real;
  for (let up = 0; up < 4; up++) {
    const text = await d.readText(join(dir, "package.json"));
    if (text) {
      try {
        const pkg = JSON.parse(text) as { name?: unknown; version?: unknown };
        if (pkg.name === "@songsid/agend") return { dir, version: typeof pkg.version === "string" ? pkg.version : null };
      } catch { /* not this one */ }
    }
    const parent = join(dir, "..");
    if (resolve(parent) === resolve(dir)) break;
    dir = resolve(parent);
  }
  return null;
}

interface Other { package: string; home: string | null; version?: string | null; via: "fleet" | "service" | "install" }

/** Live fleets of this user other than this process: their package and home (Linux /proc; macOS `ps`, no home). */
async function liveFleets(d: HostDeps): Promise<Array<{ pid: number; package: string | null; home: string | null }>> {
  const out: Array<{ pid: number; package: string | null; home: string | null }> = [];
  if (d.platform === "linux") {
    for (const pid of await d.listPids()) {
      if (pid === d.pid) continue;
      const argv = await d.procArgv(pid);
      if (!argv || !FLEET_START.test(argv.join(" "))) continue;
      if (await d.procUid(pid) !== d.uid) continue;                       // another user's fleet is another user's state
      const entry = argv.find(a => /(?:^|\/)(?:cli\.js|agend)$/.test(a) && a.startsWith("/")) ?? null;
      const pkg = entry ? await packageOf(d, entry) : null;
      const env = await d.procEnv(pid);
      const home = env ? (env.AGEND_HOME || (env.HOME ? join(env.HOME, ".agend") : null)) : null;
      out.push({ pid, package: pkg?.dir ?? null, home });
    }
  } else if (d.platform === "darwin") {
    const ps = await d.run("ps", ["-axww", "-o", "pid=,uid=,command="], 5000);
    if (ps.status !== 0) return out;
    for (const line of ps.stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m || Number(m[1]) === d.pid || Number(m[2]) !== d.uid || !FLEET_START.test(m[3]!)) continue;
      const entry = m[3]!.split(/\s+/).find(a => /(?:^|\/)(?:cli\.js|agend)$/.test(a) && a.startsWith("/")) ?? null;
      out.push({ pid: Number(m[1]), package: entry ? (await packageOf(d, entry))?.dir ?? null : null, home: null });   // macOS: no other process's environment
    }
  }
  return out;
}

/** AgEnD services defined for this user: what each runs, for which home (null: unknown). */
async function services(d: HostDeps): Promise<Array<{ name: string; package: string | null; home: string | null }>> {
  const out: Array<{ name: string; package: string | null; home: string | null }> = [];
  const defaultHome = join(d.homeDir, ".agend");
  if (d.platform === "linux") {
    for (const [dir, system] of [[join(d.homeDir, ".config", "systemd", "user"), false], ["/etc/systemd/system", true]] as const) {
      for (const file of await d.listDir(dir)) {
        if (!file.endsWith(".service")) continue;
        const text = await d.readText(join(dir, file));
        if (!text || !/agend/i.test(text)) continue;
        const exec = /^\s*ExecStart\s*=\s*(.+)$/m.exec(text)?.[1] ?? "";
        let pkg: string | null = null;
        for (const token of exec.replace(/^[-@+!:]+/, "").split(/\s+/)) {
          if (!token.startsWith("/")) continue;
          const found = await packageOf(d, token);
          if (found) { pkg = found.dir; break; }
        }
        if (!pkg) continue;                                                // not an AgEnD fleet's unit
        const envHome = /AGEND_HOME=([^\s"]+)/.exec(text)?.[1] ?? null;
        const user = /^\s*User\s*=\s*(\S+)/m.exec(text)?.[1] ?? null;
        const home = envHome ?? (!system ? defaultHome : user === d.user ? defaultHome : user === null && d.uid === 0 ? defaultHome : null);
        out.push({ name: file, package: pkg, home });
      }
    }
  } else if (d.platform === "darwin") {
    const dir = join(d.homeDir, "Library", "LaunchAgents");
    for (const file of await d.listDir(dir)) {
      if (!file.endsWith(".plist")) continue;
      const text = await d.readText(join(dir, file));
      if (!text || !/agend/i.test(text)) continue;
      let pkg: string | null = null;
      for (const m of text.matchAll(/<string>([^<]+)<\/string>/g)) {
        if (!m[1]!.startsWith("/")) continue;
        const found = await packageOf(d, m[1]!);
        if (found) { pkg = found.dir; break; }
      }
      if (!pkg) continue;
      out.push({ name: file, package: pkg, home: /<key>AGEND_HOME<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1] ?? defaultHome });
    }
  }
  return out;
}

/** The conventional places a global AgEnD install lives (a diagnostic list, never complete). */
async function globalRoots(d: HostDeps): Promise<string[]> {
  const roots = ["/usr/local/lib/node_modules", "/usr/lib/node_modules", "/opt/homebrew/lib/node_modules",
    join(d.homeDir, ".npm-global", "lib", "node_modules"), join(d.homeDir, ".local", "lib", "node_modules")];
  const nvm = join(d.homeDir, ".nvm", "versions", "node");
  for (const v of await d.listDir(nvm)) roots.push(join(nvm, v, "lib", "node_modules"));
  const fnm = join(d.homeDir, ".local", "share", "fnm", "node-versions");
  for (const v of await d.listDir(fnm)) roots.push(join(fnm, v, "installation", "lib", "node_modules"));
  return roots.map(r => join(r, "@songsid", "agend"));
}

/**
 * P2. `home`: this fleet's AgEnD home; `ownPackage`: the realpath of the package this fleet runs (null: not proven by P1,
 * and then nothing here can be proven either).
 */
export async function checkSharing(d: HostDeps, home: string, ownPackage: string | null): Promise<PreflightCheck> {
  // This home's live fleet is this process: its fleet.lock names this pid.
  const lockText = await d.readText(join(home, "fleet.lock"));
  let lockPid: number | null = null;
  try { const r = lockText ? JSON.parse(lockText) as { pid?: unknown } : null; lockPid = typeof r?.pid === "number" ? r.pid : null; } catch { lockPid = null; }
  if (lockPid !== d.pid || ownPackage === null) return { id: "P2", ok: false, code: "unknown-owner", detail: { path: join(home, "fleet.lock") } };
  const others: Other[] = [];
  for (const f of await liveFleets(d)) {
    if (f.package === null || f.home === null) return { id: "P2", ok: false, code: "unknown-owner", detail: { path: `pid ${f.pid}` } };
    if (same(f.home, home)) return { id: "P2", ok: false, code: "shared-home", detail: { path: f.package, home: f.home } };
    if (same(f.package, ownPackage)) return { id: "P2", ok: false, code: "shared-home", detail: { path: f.package, home: f.home } };
    others.push({ package: f.package, home: f.home, via: "fleet" });
  }
  for (const s of await services(d)) {
    if (s.package === null) continue;
    const mine = same(s.package, ownPackage);
    if (s.home !== null && same(s.home, home) && !mine) return { id: "P2", ok: false, code: "shared-home", detail: { path: s.package, home: s.home } };
    if (mine && s.home !== null && !same(s.home, home)) return { id: "P2", ok: false, code: "shared-home", detail: { path: s.package, home: s.home } };
    if (!mine) others.push({ package: s.package, home: s.home, via: "service" });
  }
  for (const candidate of await globalRoots(d)) {
    if (!await d.exists(join(candidate, "package.json"))) continue;
    const found = await packageOf(d, candidate);
    if (!found || same(found.dir, ownPackage) || others.some(o => same(o.package, found.dir))) continue;
    others.push({ package: found.dir, home: null, version: found.version, via: "install" });
  }
  if (others.length) {
    const first = others[0]!;
    return { id: "P2", ok: false, code: "other-install", detail: {
      path: first.package, ...(first.home ? { home: first.home } : {}), ...(first.version ? { version: first.version } : {}), count: others.length } };
  }
  return { id: "P2", ok: true };
}

const fmtBytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.ceil(n / 1e6)} MB`);

/** P6: free space in the prefix and the home of at least 3 × the package size. Unmeasurable: absent. */
export async function checkSpace(d: HostDeps, home: string, install: { prefix: string; packageDir: string } | null): Promise<PreflightCheck | null> {
  if (!install) return null;
  const du = await d.run("du", ["-sk", install.packageDir], 20_000);
  const kb = du.status === 0 ? Number(/^(\d+)/.exec(du.stdout.trim())?.[1]) : NaN;
  if (!Number.isFinite(kb) || kb <= 0) return null;
  const need = kb * 1024 * 3;
  for (const path of [install.prefix, home]) {
    const have = await d.freeBytes(path);
    if (have === null) return null;
    if (have < need) return { id: "P6", ok: false, code: "low-disk", detail: { need: fmtBytes(need), have: fmtBytes(have), path } };
  }
  return { id: "P6", ok: true };
}

/** P8: a rehearsal or test marker, or another live update. `localOnly`: a launch's own re-proof (its own marker is not another update). */
export async function checkQuiet(d: HostDeps, home: string, install: { prefix: string } | null, localOnly: boolean): Promise<PreflightCheck> {
  if (d.env.AGEND_REHEARSAL === "1" || d.env.AGEND_E2E === "1") return { id: "P8", ok: false, code: "rehearsal", detail: { path: d.env.AGEND_REHEARSAL === "1" ? "AGEND_REHEARSAL" : "AGEND_E2E" } };
  const marker = join(home, ".no-auto-update");
  if (await d.exists(marker)) return { id: "P8", ok: false, code: "rehearsal", detail: { path: marker } };
  for (const path of [join(home, ".update.lock"), ...(install ? [join(install.prefix, ".agend-install.lock")] : [])]) {
    const holder = d.lockHolder(path);
    if ((holder.state === "live" || holder.state === "unknown") && holder.record.pid !== d.pid) return { id: "P8", ok: false, code: "update-running", detail: { path } };
  }
  if (!localOnly && d.updateInProgress(home)) return { id: "P8", ok: false, code: "update-running", detail: { path: join(home, "update-in-progress.json") } };
  return { id: "P8", ok: true };
}
