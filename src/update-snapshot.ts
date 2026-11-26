/**
 * M-3770 slice 2.3 (design update-transaction §4.5, §5.2, §5.3): the update's snapshot of the home, taken in
 * `snapshotted` while every writer is fenced (§4.2) and proven gone (§4.4; `proveWritersGone`, before and after).
 *
 * - **Confinement (§5.2).** The scope (§5.1) is walked from `realpath(home)` with `lstat`, never following a link. A
 *   symlink is recorded as a link with its target text — unless its target is a directory or a SQLite database, which
 *   refuses the snapshot (Fable #4523 F2): a rollback would put the link back while the newer state behind it stays,
 *   the very failure the snapshot exists to prevent. (The target is `stat`ed and its first 16 bytes peeked; it is never
 *   opened as a database, and a linked directory is never entered.) Every
 *   included regular file's components below the home are real directories (the walk only descends into those), and
 *   its realpath lies inside the home's. Anything that is neither a file, a directory nor a link refuses the snapshot.
 * - **SQLite (§4.5).** A file is a database when it starts with SQLite's header. Each is opened alone at its confined
 *   path, its `dev`/`ino` compared before and after; `PRAGMA wal_checkpoint(TRUNCATE)` must report `busy = 0` and
 *   `log = checkpointed`; `PRAGMA quick_check` must say `ok`. Its `user_version` and a hash of its schema are recorded.
 *   Its `-wal`, `-shm` and `-journal` files are not copied: after a verified checkpoint they hold nothing it needs.
 * - **The copy (§5.3).** Each file to `snapshot/<rel>` (a clone where the filesystem can), its mode and mtime kept,
 *   fsynced; each directory fsynced after its entries, bottom-up; links recreated with their targets. The manifest
 *   `snapshot.json` (every entry: rel, type, mode, size, sha256, target; plus the databases) is written last and
 *   fsynced, then the attempt directory. `verifySnapshot` walks the copy again and compares it with the manifest as an
 *   exact set.
 *
 * A failure anywhere — confinement, a database, the copy, the writers' proof — removes the partial snapshot THIS call
 * made, and says why: the caller abandons the attempt (§2.3). A snapshot already present is never touched (§5.3: it is
 * immutable once published). Nothing is written into the home except each database's own checkpoint (§4.5: the WAL
 * folded into the main file and truncated, a `-shm` possibly created, a hot rollback journal rolled back).
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync,
  readSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, chmodSync, writeSync, renameSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { classify } from "./update-snapshot-scope.js";

export const SNAPSHOT_DIR = "snapshot";
export const SNAPSHOT_MANIFEST = "snapshot.json";

export type EntryType = "file" | "dir" | "link";
export interface ManifestEntry { rel: string; type: EntryType; mode: number; size?: number; sha256?: string; target?: string; mtimeMs?: number }
export interface DatabaseRecord { rel: string; userVersion: number; schemaSha256: string }
export interface SnapshotManifest { schema: 1; home: string; entries: ManifestEntry[]; databases: DatabaseRecord[] }

export type SnapshotResult = { ok: true; manifest: SnapshotManifest; manifestSha256: string } | { ok: false; reason: string };

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const SIDECARS = ["-wal", "-shm", "-journal"];

export interface SnapshotDeps {
  /** §4.4: every writer of the home is gone (the exempt set aside). Called before the walk and after the copy. */
  proveWritersGone(): { ok: true } | { ok: false; reason: string };
  /** Test seam: called after each file is copied. */
  afterCopy?(rel: string): void;
}

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const fsyncPath = (path: string): void => { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };

function isSqlite(path: string): boolean {
  const fd = openSync(path, "r");
  try { const buf = Buffer.alloc(16); return readSync(fd, buf, 0, 16, 0) === 16 && buf.equals(SQLITE_HEADER); } finally { closeSync(fd); }
}

/**
 * What a link leads to that the snapshot can't protect: a directory, or a SQLite database (header peeked, never opened
 * as one). null: a dangling link, or one to a plain file — recorded as a link.
 */
function linkedTarget(link: string): string | null {
  let st;
  try { st = statSync(link); } catch { return null; }
  if (st.isDirectory()) return "a directory";
  if (st.isFile()) { try { if (isSqlite(link)) return "a SQLite database"; } catch { return "a file that can't be read"; } }
  return null;
}

class Refused extends Error {}
const refuse = (why: string): never => { throw new Refused(why); };

interface Walked { entries: ManifestEntry[]; files: string[] }

/** §5.2: the scope, from the home's realpath, never following a link. */
export function walkScope(home: string): Walked {
  const root = realpathSync(home);
  const entries: ManifestEntry[] = [], files: string[] = [];
  const visit = (rel: string) => {
    const abs = rel ? join(root, rel) : root;
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (!classify(childRel).included) continue;
      const st = lstatSync(join(abs, name));
      const mode = st.mode & 0o7777;
      if (st.isSymbolicLink()) {
        const behind = linkedTarget(join(abs, name));
        if (behind) refuse(`${childRel} is a link to ${behind}; the rollback couldn't restore what's behind it`);
        entries.push({ rel: childRel, type: "link", mode, target: readlinkSync(join(abs, name)) });
        continue;
      }
      if (st.isDirectory()) { entries.push({ rel: childRel, type: "dir", mode }); visit(childRel); continue; }
      if (!st.isFile()) refuse(`${childRel} is neither a file, a directory nor a link`);
      const real = realpathSync(join(abs, name));
      if (real !== join(root, childRel) && !real.startsWith(root + sep)) refuse(`${childRel} resolves outside the home`);
      entries.push({ rel: childRel, type: "file", mode, size: st.size, mtimeMs: st.mtimeMs });
      files.push(childRel);
    }
  };
  visit("");
  return { entries, files };
}

/** §4.5: checkpoint, check and describe one database, at its confined path. */
function settleDatabase(path: string, rel: string): DatabaseRecord {
  const before = statSync(path);
  const db = new Database(path, { fileMustExist: true });
  try {
    const row = (db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>)[0];
    if (!row || row.busy !== 0 || row.log !== row.checkpointed) refuse(`${rel}'s checkpoint is incomplete (busy ${row?.busy}, log ${row?.log}, checkpointed ${row?.checkpointed})`);
    const check = db.pragma("quick_check", { simple: true });
    if (check !== "ok") refuse(`${rel} fails its quick_check (${String(check)})`);
    const userVersion = Number(db.pragma("user_version", { simple: true }));
    const schema = (db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all() as unknown[]);
    const schemaSha256 = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
    return { rel, userVersion, schemaSha256 };
  } finally {
    db.close();
    const after = statSync(path);
    if (after.dev !== before.dev || after.ino !== before.ino) refuse(`${rel} was replaced while it was checked`);
  }
}

/**
 * §5.3: snapshot the home into `<attemptDir>/snapshot/` and `<attemptDir>/snapshot.json`. The attempt directory must
 * exist; the snapshot directory must not (a retry starts over: the caller removes a partial one first).
 */
export function takeSnapshot(home: string, attemptDir: string, deps: SnapshotDeps): SnapshotResult {
  const out = join(attemptDir, SNAPSHOT_DIR), manifestPath = join(attemptDir, SNAPSHOT_MANIFEST);
  // A snapshot already here is never touched (Fable #4523 F1): refused before anything is done.
  if (existsSync(out) || existsSync(manifestPath)) return { ok: false, reason: "a snapshot is already here; the caller removes a partial one first" };
  let madeDir = false, wroteManifest = false;
  try {
    const first = deps.proveWritersGone();
    if (!first.ok) refuse(`writers are present: ${first.reason}`);
    const root = realpathSync(home);
    const walked = walkScope(home);
    // Databases first (§5.2): settled at their confined paths before anything is copied.
    const databases: DatabaseRecord[] = [];
    const dbRels = new Set<string>();
    for (const rel of walked.files) {
      if (SIDECARS.some(s => rel.endsWith(s))) continue;
      if (isSqlite(join(root, rel))) { databases.push(settleDatabase(join(root, rel), rel)); dbRels.add(rel); }
    }
    const sidecarOf = (rel: string) => SIDECARS.some(s => rel.endsWith(s) && dbRels.has(rel.slice(0, -s.length)));
    const entries = walked.entries.filter(e => !(e.type === "file" && sidecarOf(e.rel)));
    mkdirSync(out, { mode: 0o700 });
    madeDir = true;
    const dirs: string[] = [out];
    for (const e of entries) {
      const src = join(root, e.rel), dst = join(out, e.rel);
      if (e.type === "dir") { mkdirSync(dst, { mode: 0o700 }); dirs.push(dst); continue; }
      if (e.type === "link") { symlinkSync(e.target!, dst); continue; }
      copyFileSync(src, dst, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
      chmodSync(dst, e.mode);
      utimesSync(dst, new Date(e.mtimeMs!), new Date(e.mtimeMs!));
      fsyncPath(dst);
      e.sha256 = sha256File(dst);
      e.size = statSync(dst).size;
      deps.afterCopy?.(e.rel);
    }
    // Directories: their modes, then fsynced bottom-up (deepest first).
    for (const e of entries) if (e.type === "dir") chmodSync(join(out, e.rel), e.mode);
    for (const d of dirs.sort((a, b) => b.length - a.length)) fsyncPath(d);
    const after = deps.proveWritersGone();
    if (!after.ok) refuse(`a writer appeared during the copy: ${after.reason}`);
    for (const e of entries) delete e.mtimeMs;
    const manifest: SnapshotManifest = { schema: 1, home: root, entries, databases };
    const text = JSON.stringify(manifest, null, 2) + "\n";
    const tmp = `${manifestPath}.tmp-${process.pid}`;
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, manifestPath);
    wroteManifest = true;
    fsyncPath(attemptDir);
    const verified = verifySnapshot(attemptDir, manifest);
    if (!verified.ok) refuse(verified.reason);
    return { ok: true, manifest, manifestSha256: createHash("sha256").update(text).digest("hex") };
  } catch (err) {
    // Only what this call made is removed.
    try { if (wroteManifest) rmSync(manifestPath, { force: true }); if (madeDir) rmSync(out, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, reason: err instanceof Refused ? err.message : `the snapshot failed (${(err as Error).message})` };
  }
}

/** The manifest as written, or null when it can't be read or isn't one. */
export function readManifest(attemptDir: string): SnapshotManifest | null {
  try {
    const m = JSON.parse(readFileSync(join(attemptDir, SNAPSHOT_MANIFEST), "utf8")) as SnapshotManifest;
    return m && m.schema === 1 && Array.isArray(m.entries) && Array.isArray(m.databases) ? m : null;
  } catch { return null; }
}

/** §5.3: the snapshot tree against its manifest, as an exact set — no extra entry, none missing, same types, hashes and targets. */
export function verifySnapshot(attemptDir: string, manifest: SnapshotManifest): { ok: true } | { ok: false; reason: string } {
  const out = join(attemptDir, SNAPSHOT_DIR);
  const seen = new Map<string, ManifestEntry>();
  const visit = (rel: string) => {
    for (const name of readdirSync(rel ? join(out, rel) : out).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(out, r));
      if (st.isSymbolicLink()) seen.set(r, { rel: r, type: "link", mode: 0, target: readlinkSync(join(out, r)) });
      else if (st.isDirectory()) { seen.set(r, { rel: r, type: "dir", mode: st.mode & 0o7777 }); visit(r); }
      else if (st.isFile()) seen.set(r, { rel: r, type: "file", mode: st.mode & 0o7777, size: st.size, sha256: sha256File(join(out, r)) });
      else seen.set(r, { rel: r, type: "file", mode: -1 });
    }
  };
  try { visit(""); } catch (err) { return { ok: false, reason: `the snapshot can't be read (${(err as Error).message})` }; }
  if (seen.size !== manifest.entries.length) return { ok: false, reason: `the snapshot holds ${seen.size} entries, its manifest ${manifest.entries.length}` };
  for (const e of manifest.entries) {
    const s = seen.get(e.rel);
    if (!s) return { ok: false, reason: `${e.rel} is missing from the snapshot` };
    if (s.type !== e.type) return { ok: false, reason: `${e.rel} is a ${s.type}, not a ${e.type}` };
    if (e.type === "link" && s.target !== e.target) return { ok: false, reason: `${e.rel} points elsewhere` };
    if (e.type === "file" && (s.sha256 !== e.sha256 || s.size !== e.size || s.mode !== e.mode)) return { ok: false, reason: `${e.rel} differs from its manifest` };
    if (e.type === "dir" && s.mode !== e.mode) return { ok: false, reason: `${e.rel}'s mode differs from its manifest` };
  }
  return { ok: true };
}

/** The directory a manifest entry's parent is in, for callers building restore plans. */
export const parentOf = (rel: string) => (rel.includes("/") ? dirname(rel) : "");
