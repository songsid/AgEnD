/**
 * #2481 (design approved on the issue): on a Mac, a 2.3.x that crash-loops under launchd after an upgrade from 2.2.x is
 * replaced by the 2.2.x package 2.2.x's own updater kept (`<prefix>/.agend-rollback/<2.2.x>-<time>/agend`), automatically
 * and once. 2.2.x's updater can report such an upgrade as a success and does not roll back; from 2.3 on, agend-install
 * rolls back by itself (#2420), so only the hop out of 2.2.x needs this.
 *
 * The failing fleet does it itself, from start-attempt.ts — no other process exists to act, and a child left behind dies
 * with the job. Every guard must hold (autoRestoreDue, restoreCandidate, preimageRuns):
 * - macOS, and this process is the launchd job (XPC_SERVICE_NAME), never a person's `fleet start`;
 * - the installed version never completed a start here, and this is its 3rd attempt in the window (#2490's threshold;
 *   refused starts are no attempts, `agend stop` clears them);
 * - the newest kept copy is a 2.2.x release older than the installed version, named and versioned as it says, with its
 *   files and bundled Node in place, and that Node runs its `cli.js --version` to exactly that version;
 * - one O_EXCL claim per version: never a second try, whatever came of the first.
 *
 * Then, in order: the claim and the record's intent, the notices (the chat notice runs from the installed package, which
 * is about to move), the swap — the installed tree aside to `.agend-rollback/<installed>-<time>-failed`, the copy in, by
 * rename on one filesystem, renamed back if any step fails — the record's result, and the caller exits: launchd's
 * KeepAlive starts the job again, now on 2.2.x. The plist is not touched: it names `<package>/node_modules/@songsid/
 * agend-node-darwin-<arch>/bin/node <package>/dist/cli.js`, the same paths in both versions. The bin links point into the
 * package path too; only 2.3's `agend-install` link would dangle, so it goes.
 *
 * The data caveat: the failing version may already have changed AgEnD's data before it failed (it ran, it never
 * completed a start); the notice says so. 2.2.6 reading data 2.3.x wrote is the Data downgrade compatibility CI job.
 *
 * Only node built-ins (start-attempt.ts runs this before the rest of the CLI loads).
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const RESTORE_RECORD = "fleet-auto-restore.json";
const RESTORE_CLAIM_PREFIX = "fleet-start-restore-";
const LAUNCHD_LABEL = "com.agend.fleet";
/** How long the kept copy may take to print its version. */
export const PREIMAGE_RUN_TIMEOUT_MS = 10_000;

export interface RestoreCandidate { version: string; dir: string; pkg: string; node: string }
export interface RestoreRecord {
  from: string; to: string; preimage: string; attempts: number; at: string;
  result?: "restored" | "failed"; reason?: string; failedTree?: string; finishedAt?: string;
}

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
/** a < b, for plain releases and prereleases of the form x.y.z[-…] (the core decides; a prerelease of the same core is older). */
export function versionOlder(a: string, b: string): boolean {
  const core = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null;
  const ca = core(a), cb = core(b);
  if (!ca || !cb) return false;
  for (let i = 0; i < 3; i++) if (ca[i] !== cb[i]) return ca[i]! < cb[i]!;
  return a.includes("-") && !b.includes("-");
}

/** The guards that need no file of the package: platform, launchd job, plist, a version that never ran, the 3rd attempt. */
export function autoRestoreDue(input: {
  platform: NodeJS.Platform; env: NodeJS.ProcessEnv; plistExists: boolean;
  installed: string; startedHistory: string[]; recentAttempts: number;
}): boolean {
  return input.platform === "darwin"
    && input.env.XPC_SERVICE_NAME === LAUNCHD_LABEL
    && input.plistExists
    && !input.startedHistory.includes(input.installed)
    && input.recentAttempts >= 3;
}

/**
 * The kept copy to restore, or null: the newest `.agend-rollback/<v>-<ISO time>` (never a `-failed` tree) whose
 * package is `@songsid/agend` at exactly `<v>`, a 2.2.x release older than `installed`, with dist/cli.js, launcher/agend
 * and its bundled Node (a regular file) in place.
 */
export function restoreCandidate(prefix: string, installed: string, arch: string = process.arch): RestoreCandidate | null {
  const base = join(prefix, ".agend-rollback");
  let names: string[] = [];
  try { names = readdirSync(base); } catch { return null; }
  const kept = names
    .map(name => ({ name, version: /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+?)?)-\d{4}-\d\d-\d\dT[0-9-]+Z$/.exec(name)?.[1] ?? null }))
    .filter((e): e is { name: string; version: string } => e.version !== null)
    .map(e => ({ ...e, mtime: (() => { try { return statSync(join(base, e.name)).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.mtime - a.mtime);
  const newest = kept[0];
  if (!newest) return null;
  const pkg = join(base, newest.name, "agend");
  let manifest: { name?: unknown; version?: unknown };
  try { manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")); } catch { return null; }
  if (manifest.name !== "@songsid/agend" || manifest.version !== newest.version) return null;
  const m = RELEASE.exec(newest.version);
  if (!m || m[1] !== "2" || m[2] !== "2" || !versionOlder(newest.version, installed)) return null;
  const node = join(pkg, "node_modules", "@songsid", `agend-node-darwin-${arch}`, "bin", "node");
  try {
    if (!statSync(join(pkg, "dist", "cli.js")).isFile() || !existsSync(join(pkg, "launcher", "agend"))) return null;
    if (!lstatSync(node).isFile()) return null;
  } catch { return null; }
  return { version: newest.version, dir: join(base, newest.name), pkg, node };
}

export type RunVersion = (node: string, cli: string, timeoutMs: number) => { status: number | null; stdout: string };
const defaultRunVersion: RunVersion = (node, cli, timeoutMs) => {
  const r = spawnSync(node, [cli, "--version"], {
    encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? homedir(), LANG: "C" },
  });
  return { status: r.status, stdout: r.stdout ?? "" };
};

/** The kept copy's own Node runs its cli.js --version and prints exactly its version (the last line). */
export function preimageRuns(cand: RestoreCandidate, run: RunVersion = defaultRunVersion): boolean {
  try {
    const r = run(cand.node, join(cand.pkg, "dist", "cli.js"), PREIMAGE_RUN_TIMEOUT_MS);
    return r.status === 0 && r.stdout.trim().split("\n").at(-1)?.trim() === cand.version;
  } catch { return false; }
}

/** One restore per installed version, ever: an O_EXCL claim file. */
export function claimRestore(home: string, installed: string): boolean {
  if (!/^[0-9A-Za-z.+-]{1,64}$/.test(installed)) return false;
  try { writeFileSync(join(home, `${RESTORE_CLAIM_PREFIX}${installed}`), new Date().toISOString() + "\n", { flag: "wx", mode: 0o600 }); return true; }
  catch { return false; }
}

export function readRestoreRecord(home: string): RestoreRecord | null {
  try {
    const r = JSON.parse(readFileSync(join(home, RESTORE_RECORD), "utf8")) as RestoreRecord;
    return r && typeof r.from === "string" && typeof r.to === "string" ? r : null;
  } catch { return null; }
}
function writeRecord(home: string, record: RestoreRecord): void {
  const file = join(home, RESTORE_RECORD);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

export interface SwapFs {
  rename(from: string, to: string): void;
  exists(path: string): boolean;
  unlink(path: string): void;
  readlink(path: string): string | null;
}
const realFs: SwapFs = {
  rename: renameSync, exists: existsSync, unlink: unlinkSync,
  readlink: p => { try { return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null; } catch { return null; } },
};

/**
 * The swap: `root` (the installed package) aside to `<prefix>/.agend-rollback/<installed>-<time>-failed`, the kept copy
 * into `root`. A failure of the second rename puts the first back. Then `<prefix>/bin/agend-install`, when it points
 * at a file the restored package does not have, goes. Returns the failed tree's path.
 */
export function swapInPreimage(prefix: string, root: string, installed: string, cand: RestoreCandidate, now: Date, fs: SwapFs = realFs): { ok: true; failedTree: string } | { ok: false; reason: string } {
  const failedTree = join(prefix, ".agend-rollback", `${installed}-${now.toISOString().replace(/[:.]/g, "-")}-failed`);
  try { fs.rename(root, failedTree); }
  catch (err) { return { ok: false, reason: `the installed package could not be moved aside (${(err as Error).message})` }; }
  try { fs.rename(cand.pkg, root); }
  catch (err) {
    try { fs.rename(failedTree, root); } catch { /* reported below: the reason names both */ }
    return { ok: false, reason: `the kept copy could not be put in place (${(err as Error).message}); the installed package was put back` };
  }
  const link = join(prefix, "bin", "agend-install");
  const target = fs.readlink(link);
  if (target !== null && !fs.exists(resolve(dirname(link), target))) { try { fs.unlink(link); } catch { /* a dangling link harms nothing */ } }
  return { ok: true, failedTree };
}

/** What the restore did, for start-attempt.ts's notices and exit. */
export type RestoreOutcome = { kind: "not-due" } | { kind: "restored"; from: string; to: string; preimage: string } | { kind: "failed"; reason: string };

export interface AutoRestoreDeps {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; plistPath?: string; arch?: string;
  runVersion?: RunVersion; fs?: SwapFs; now?: Date;
  /** The notices with the restore wording, sent before the swap (their script lives in the installed package). */
  notify?: (from: string, to: string, preimage: string) => void;
  log?: (line: string) => void;
}

/**
 * The whole decision and act, for the installed package at `root` under `prefix`. `attempts`: this version's attempts
 * in the window, this one included. Never throws.
 */
export function maybeAutoRestore(home: string, root: string, prefix: string, installed: string, startedHistory: string[], attempts: number, deps: AutoRestoreDeps = {}): RestoreOutcome {
  const log = deps.log ?? (line => { try { process.stderr.write(`AgEnD auto-restore: ${line}\n`); } catch { /* none */ } });
  try {
    const plistPath = deps.plistPath ?? join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    if (!autoRestoreDue({ platform: deps.platform ?? process.platform, env: deps.env ?? process.env, plistExists: existsSync(plistPath), installed, startedHistory, recentAttempts: attempts })) return { kind: "not-due" };
    if (resolve(root) !== resolve(prefix, "lib", "node_modules", "@songsid", "agend")) return { kind: "not-due" };
    const cand = restoreCandidate(prefix, installed, deps.arch);
    if (!cand) return { kind: "not-due" };
    if (!preimageRuns(cand, deps.runVersion)) { log(`the kept copy of v${cand.version} at ${cand.dir} does not run; not restoring`); return { kind: "not-due" }; }
    if (!claimRestore(home, installed)) return { kind: "not-due" };
    const now = deps.now ?? new Date();
    const record: RestoreRecord = { from: installed, to: cand.version, preimage: cand.dir, attempts, at: now.toISOString() };
    writeRecord(home, record);
    log(`v${installed} failed to start ${attempts} times and never ran here; restoring v${cand.version} from ${cand.dir}`);
    try { deps.notify?.(installed, cand.version, cand.dir); } catch { /* the restore does not wait on a notice */ }
    const swapped = swapInPreimage(prefix, root, installed, cand, now, deps.fs);
    const finishedAt = new Date().toISOString();
    if (!swapped.ok) {
      writeRecord(home, { ...record, result: "failed", reason: swapped.reason, finishedAt });
      log(`restore failed: ${swapped.reason}`);
      return { kind: "failed", reason: swapped.reason };
    }
    writeRecord(home, { ...record, result: "restored", failedTree: swapped.failedTree, finishedAt });
    log(`restored v${cand.version}; launchd starts it next. The failed v${installed} is kept at ${swapped.failedTree} (about 235 MB) until a later start completes`);
    return { kind: "restored", from: installed, to: cand.version, preimage: cand.dir };
  } catch (err) {
    log(`not restoring: ${(err as Error).message}`);
    return { kind: "not-due" };
  }
}

/** After a start completes: the failed trees a restore kept for a report go (each ~235 MB; asynchronously). */
export async function pruneFailedTrees(prefix: string): Promise<number> {
  const base = join(prefix, ".agend-rollback");
  let names: string[] = [];
  try { names = readdirSync(base); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith("-failed")) continue;
    try { await rm(join(base, name), { recursive: true, force: true }); removed++; } catch { /* next time */ }
  }
  return removed;
}
