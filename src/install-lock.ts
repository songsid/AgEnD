/**
 * #1450 C1: one owner per npm global prefix. npm has no mutex between installs into one prefix (the #1455 gate
 * characterises what a collision does), so `agend update` takes `<realpath(prefix)>/.agend-install.lock` BEFORE npm
 * runs and holds it until the transition settles. Its own npm child is admitted by a single-use token
 * (AGEND_INSTALL_TOKEN), which the package's postinstall checks against this file (launcher/postinstall.cjs). Keyed to
 * the prefix — what npm changes — so two fleets with different AGEND_HOMEs on one prefix exclude each other, and two
 * prefixes (two nvm Nodes, a user prefix and /usr/local) never do.
 *
 * Ownership is evidence: a lock is replaced only when its holder is PROVEN gone — no such pid, or the pid is now a
 * process with another start time — and an unreadable file or an unreadable holder never counts as stale: it blocks,
 * naming itself. Replacing a stale lock is itself owned: only the holder of `<lock>.reclaim` (claimed with wx) may move
 * the lock file, so no updater can ever move a lock another one just claimed (#1472 review). Release removes a file only
 * while it is still exactly ours.
 */
import { linkSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INSTALL_LOCK_FILE = ".agend-install.lock";
export const INSTALL_TOKEN_ENV = "AGEND_INSTALL_TOKEN";

export interface InstallLockRecord {
  pid: number;
  /** The holder's start time as `ps -o lstart=` prints it: with the pid, the process's identity. */
  processStart: string;
  prefix: string;
  targetSpec: string;
  agendHome: string;
  token: string;
  createdAt: string;
}

export interface InstallLockDeps {
  pid: number;
  /** `ps -o lstart= -p <pid>`, trimmed; null when the process does not exist or cannot be read. */
  processStart(pid: number): string | null;
  /** Does the pid exist (false only for a definite "no such process")? Default: process.kill(pid, 0). */
  exists?(pid: number): boolean;
  /** Test seams (another updater's turn): after a lock was judged stale; after it was moved aside. */
  afterStaleJudged?(): void;
  afterStaleMoved?(): void;
  newToken(): string;
  now(): Date;
  log(message: string): void;
}

export type InstallLock =
  | { ok: true; path: string; token: string; release(): void }
  | { ok: false; path: string; reason: string };

/** The record, or why it is not one (unreadable, unparsable, wrong shape). */
export function parseInstallLock(text: string): InstallLockRecord | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  const r = value as Partial<InstallLockRecord> | null;
  return r && Number.isSafeInteger(r.pid) && (r.pid as number) > 0 && typeof r.processStart === "string" && r.processStart
    && typeof r.prefix === "string" && typeof r.token === "string" && /^[0-9a-f]{32,}$/.test(r.token)
    && typeof r.targetSpec === "string" && typeof r.agendHome === "string" && typeof r.createdAt === "string"
    ? r as InstallLockRecord : null;
}

const pidExists = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
};

/**
 * The recorded holder: "live" (that very process), "stale" (PROVEN gone: no such pid, or the pid now belongs to a
 * process that started at another time), or "unknown" (it exists, but its start time cannot be read) — which blocks.
 */
export function holderState(record: { pid: number; processStart: string }, deps: Pick<InstallLockDeps, "processStart" | "exists">): "live" | "stale" | "unknown" {
  if (!(deps.exists ?? pidExists)(record.pid)) return "stale";
  const seen = deps.processStart(record.pid);
  if (seen === null) return "unknown";
  return seen === record.processStart ? "live" : "stale";
}

const readOrNull = (path: string): string | null => { try { return readFileSync(path, "utf8"); } catch { return null; } };

export function acquireInstallLock(prefix: string, target: { spec: string; agendHome: string }, deps: InstallLockDeps): InstallLock {
  let canonical: string;
  try { canonical = realpathSync(prefix); } catch { return { ok: false, path: join(prefix, INSTALL_LOCK_FILE), reason: `the npm prefix ${prefix} does not exist` }; }
  const path = join(canonical, INSTALL_LOCK_FILE);
  const ownStart = deps.processStart(deps.pid);
  if (!ownStart) return { ok: false, path, reason: "this process's own start time cannot be read, so its lock could not be told from a stale one" };
  const record: InstallLockRecord = {
    pid: deps.pid, processStart: ownStart, prefix: canonical, targetSpec: target.spec, agendHome: target.agendHome,
    token: deps.newToken(), createdAt: deps.now().toISOString(),
  };
  const serialized = JSON.stringify(record) + "\n";
  const claim = (): boolean => {
    try { writeFileSync(path, serialized, { flag: "wx", mode: 0o600 }); return true; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; throw err; }
  };
  const ours: InstallLock = { ok: true, path, token: record.token, release: () => releaseIfOurs(path, serialized, deps) };

  try {
    if (claim()) return ours;
  } catch (err) {
    return { ok: false, path, reason: `the install lock ${path} could not be created (${(err as Error).message})` };
  }
  const seen = readOrNull(path);
  if (seen === null) return { ok: false, path, reason: `another install is starting on ${canonical} (its lock ${path} appeared and went); retry` };
  const holder = parseInstallLock(seen);
  if (!holder) return { ok: false, path, reason: `the install lock ${path} cannot be read as a lock; if no other \`agend update\` is running, remove it and retry` };
  const state = holderState(holder, deps);
  if (state === "live") {
    return { ok: false, path, reason: `another AgEnD install is running on ${canonical} (pid ${holder.pid}, installing ${holder.targetSpec} for ${holder.agendHome}); wait for it to finish` };
  }
  if (state === "unknown") {
    return { ok: false, path, reason: `whether the install that holds ${path} (pid ${holder.pid}) is still running cannot be told; retry, or remove the lock once no \`agend update\` runs` };
  }

  // Stale. Moving the lock file is owned too: only the holder of the reclaim marker may do it. Without that, an updater
  // that judged an old stale lock could move a lock another updater has just claimed in its place (#1472 review).
  const marker = `${path}.reclaim`;
  deps.afterStaleJudged?.();
  try { writeFileSync(marker, serialized, { flag: "wx", mode: 0o600 }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false, path, reason: `the reclaim marker ${marker} could not be created (${(err as Error).message})` };
    const other = parseInstallLock(readOrNull(marker) ?? "");
    const otherState = other ? holderState(other, deps) : "unknown";
    // A marker is held for a few file operations; one left by a crash in that window is never taken automatically.
    return otherState === "live"
      ? { ok: false, path, reason: `another install is replacing the stale lock on ${canonical}; retry` }
      : { ok: false, path, reason: `a reclaim marker ${marker} was left behind (pid ${other?.pid ?? "unknown"}); if no \`agend update\` runs, remove it and retry` };
  }
  try {
    // Under the marker the lock can change only by its live owner's release — and its holder is proven gone — so the
    // file judged above is still the one to move; re-read anyway and refuse on any difference.
    if (readOrNull(path) !== seen) return { ok: false, path, reason: `another install is starting on ${canonical}; retry` };
    const aside = `${path}.stale-${deps.pid}-${record.token.slice(0, 8)}`;
    try { renameSync(path, aside); } catch { return { ok: false, path, reason: `another install is starting on ${canonical}; retry` }; }
    deps.afterStaleMoved?.();
    if (readOrNull(aside) !== seen) {
      // Cannot happen under the marker; if it ever does, theirs goes back (link never overwrites) and nothing is deleted.
      try { linkSync(aside, path); unlinkSync(aside); } catch { deps.log(`  ⚠ An install lock changed while it was being replaced; left at ${aside}.`); }
      return { ok: false, path, reason: `another install is starting on ${canonical}; retry` };
    }
    try { unlinkSync(aside); } catch { /* best effort */ }
    deps.log(`  Replaced a stale install lock (pid ${holder.pid} is gone, was installing ${holder.targetSpec}).`);
    try {
      if (claim()) return ours;
    } catch (err) {
      return { ok: false, path, reason: `the install lock ${path} could not be created (${(err as Error).message})` };
    }
    return { ok: false, path, reason: `another install is starting on ${canonical}; retry` };
  } finally {
    releaseIfOurs(marker, serialized, deps);
  }
}

/** Remove the lock only while it is still exactly the one this process wrote; never another owner's. */
function releaseIfOurs(path: string, serialized: string, deps: Pick<InstallLockDeps, "pid" | "log">): void {
  if (readOrNull(path) !== serialized) return;
  const aside = `${path}.release-${deps.pid}`;
  try { renameSync(path, aside); } catch { return; }
  if (readOrNull(aside) === serialized) {
    try { unlinkSync(aside); } catch { /* best effort */ }
    return;
  }
  // Someone replaced it between the check and the rename: put theirs back.
  try { linkSync(aside, path); } catch { deps.log(`  ⚠ The install lock changed while being released; left at ${aside}.`); return; }
  try { unlinkSync(aside); } catch { /* best effort */ }
}
