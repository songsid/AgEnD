/**
 * #1450 C1: one owner per npm global prefix. npm has no mutex between installs into one prefix (the #1455 gate
 * characterises what a collision does), so `agend update` takes `<realpath(prefix)>/.agend-install.lock` BEFORE npm
 * runs and holds it until the transition settles. Its own npm child is admitted by a single-use token
 * (AGEND_INSTALL_TOKEN), which the package's postinstall checks against this file (launcher/postinstall.cjs). Keyed to
 * the prefix — what npm changes — so two fleets with different AGEND_HOMEs on one prefix exclude each other, and two
 * prefixes (two nvm Nodes, a user prefix and /usr/local) never do.
 *
 * Ownership is evidence: a lock is replaced only when its recorded pid is dead or is now another process (a different
 * start time), and a file that cannot be read or parsed is never taken — it blocks, naming itself. Release removes the
 * file only while it is still exactly ours.
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

/** Is the recorded holder still that very process? */
export function holderIsLive(record: InstallLockRecord, deps: Pick<InstallLockDeps, "processStart">): boolean {
  return deps.processStart(record.pid) === record.processStart;
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
  if (holderIsLive(holder, deps)) {
    return { ok: false, path, reason: `another AgEnD install is running on ${canonical} (pid ${holder.pid}, installing ${holder.targetSpec} for ${holder.agendHome}); wait for it to finish` };
  }
  // Stale: set it aside and check that what was set aside is the stale lock just judged — another updater may have
  // replaced it in between, and that one is live: put it back (link fails rather than overwrite) and refuse.
  const aside = `${path}.stale-${deps.pid}-${record.token.slice(0, 8)}`;
  try { renameSync(path, aside); } catch { return { ok: false, path, reason: `another install is starting on ${canonical}; retry` }; }
  const moved = readOrNull(aside);
  if (moved !== seen) {
    try { linkSync(aside, path); } catch { /* yet another claim landed: theirs stays */ }
    try { unlinkSync(aside); } catch { /* best effort */ }
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
