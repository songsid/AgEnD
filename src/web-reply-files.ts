/**
 * #1770: the files an agent attaches to a reply, as the web chat shows them. When the reply is routed, each file is
 * copied (a snapshot) into the instance's own `workspaces/<instance>/web-files/`, named by the id it is served under,
 * and that copy is what the chat serves and what its history keeps. The agent's file may then be rewritten, moved or
 * cleaned out of /tmp, and the fleet may restart: the message still shows what was sent. Telegram and Discord send
 * the agent's own path, as before; nothing here touches that.
 *
 * Bounded: a snapshot leaves with its message (WebFileLedger.dropServed unlinks it), an instance's directory is held
 * to REPLY_FILES_MAX_BYTES (the oldest go first), and a fleet start removes what no restored message holds.
 */
import { constants as fsConstants, closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { lstat, mkdir, open, realpath, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { isSafeInstanceDirName } from "./web-chat-store.js";
import { MAX_SERVED_BYTES } from "./web-upload.js";

export const WEB_FILES_DIR = "web-files";
/** Per instance. One reply can carry 20 files of 50 MB: the newest reply always fits whole. */
export const REPLY_FILES_MAX_BYTES = 1024 ** 3;
/** A snapshot's name: its served id and the source's plain extension. Nothing else in the directory is ours. */
const SNAPSHOT_NAME = /^([0-9a-f]{32})(\.[a-z0-9]{1,10})?$/;
const TMP_NAME = /^\.tmp-[0-9a-f]{32}$/;
const CHUNK = 1 << 20;
const PROC_FD = process.platform === "linux" ? "/proc/self/fd" : null;

/** An instance's snapshot directory; null for a name that is not a safe directory name. */
export function webFilesDir(home: string, instance: string): string | null {
  return isSafeInstanceDirName(instance) ? join(home, "workspaces", instance, WEB_FILES_DIR) : null;
}

/** The extension a snapshot keeps (lower-cased, so the served type is the one the source's name gives); "" when not plain. */
export function snapshotExt(path: string): string {
  const ext = extname(path).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

/** The reply tool's own rule (tool-router assertSendable), applied again when copying: nothing under the state dir but inbox/. */
function isStateFile(real: string, stateDir: string): boolean {
  const roots = new Set([resolve(stateDir)]);
  try { roots.add(realpathSync(stateDir)); } catch { /* not there: the resolved path is the rule */ }
  return [...roots].some((root) => real.startsWith(root + sep) && !real.includes(sep + "inbox" + sep));
}

export type SnapshotResult =
  /** Copied: serve `path`. `evicted`: ids whose snapshots were removed to make room (their messages show them as gone). */
  | { ok: true; path: string; size: number; evicted: string[] }
  /** Not a file the web chat shows (a symlink, not a regular file, over the limit, a state file, missing). */
  | { ok: false; refused: true; reason: string }
  /** Could not be copied (I/O): the caller may serve the agent's own path, as before #1770 — until a restart. */
  | { ok: false; refused: false; reason: string; evicted: string[] };

/**
 * Copy the agent's file `src` into `dir` as `<id><ext>`. The path itself must not be a symlink; it is opened without
 * following one, and what is copied is that open file — a regular file within maxFileBytes, the same file (device +
 * inode) its real path names, and not a state file. Written to a temp name and renamed, so a snapshot is never partial.
 */
export async function snapshotReplyFile(src: string, dir: string, id: string, opts: { stateDir: string; maxFileBytes?: number; maxDirBytes?: number }): Promise<SnapshotResult> {
  const maxFile = opts.maxFileBytes ?? MAX_SERVED_BYTES;
  const refused = (reason: string): SnapshotResult => ({ ok: false, refused: true, reason });
  let fh: FileHandle | null = null;
  let tmp: string | null = null;
  let evicted: string[] = [];
  try {
    let size: number, mtimeMs: number;
    try {
      const own = await lstat(src);
      if (own.isSymbolicLink()) return refused("a symlink");
      if (!own.isFile()) return refused("not a regular file");
      fh = await open(src, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const st = await fh.stat();
      if (!st.isFile()) return refused("not a regular file");
      if (st.size > maxFile) return refused("over the size limit");
      const real = await realpath(src);
      const named = await stat(real);
      if (named.dev !== st.dev || named.ino !== st.ino) return refused("replaced while it was opened");
      if (isStateFile(real, opts.stateDir)) return refused("inside the AgEnD state directory");
      ({ size, mtimeMs } = st);
    } catch {
      return refused("cannot be read");
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!inTree(dir)) return { ok: false, refused: false, reason: "the snapshot directory is not the instance's own", evicted };
    evicted = makeRoom(dir, size, opts.maxDirBytes ?? REPLY_FILES_MAX_BYTES);
    tmp = join(dir, `.tmp-${id}`);
    const out = await open(tmp, "wx", 0o600);
    let off = 0;
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, size)));
      while (off < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - off), off);
        if (bytesRead <= 0) break;
        await out.write(buf, 0, bytesRead);
        off += bytesRead;
      }
    } finally { await out.close(); }
    const after = await fh.stat();
    // Rewritten while it was copied: the copy may be torn — not kept.
    if (off !== size || after.size !== size || after.mtimeMs !== mtimeMs) return { ok: false, refused: false, reason: "changed while it was copied", evicted };
    const path = join(dir, id + snapshotExt(src));
    await rename(tmp, path);
    tmp = null;
    return { ok: true, path, size, evicted };
  } catch (err) {
    return { ok: false, refused: false, reason: (err as NodeJS.ErrnoException).code ?? "copy failed", evicted };
  } finally {
    if (fh) await fh.close().catch(() => {});
    if (tmp) await unlink(tmp).catch(() => {});
  }
}

/** `dir` is a real directory at its own path (not a link elsewhere, nor under one). */
function inTree(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory() && realpathSync(dir) === join(realpathSync(dirname(dir)), basename(dir));
  } catch { return false; }
}

/**
 * Run `fn` on `dir` opened as a directory and checked to be the in-tree one: removals go through the open directory
 * where the platform allows it, so a parent swapped for a link afterwards cannot redirect them (as sweepOrphanedUploads).
 */
function withPinnedDir<T>(dir: string, fallback: T, fn: (anchor: string, stillPinned: () => boolean) => T): T {
  let fd: number | null = null;
  try {
    if (!inTree(dir)) return fallback;
    fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const pinned = fstatSync(fd);
    const here = lstatSync(dir);
    if (pinned.dev !== here.dev || pinned.ino !== here.ino) return fallback;
    const anchor = PROC_FD && existsSync(`${PROC_FD}/${fd}`) ? `${PROC_FD}/${fd}` : dir;
    const stillPinned = () => {
      if (anchor !== dir) return true;
      const now = lstatSync(dir);
      return now.isDirectory() && now.dev === pinned.dev && now.ino === pinned.ino && inTree(dir);
    };
    return fn(anchor, stillPinned);
  } catch { return fallback; } finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
}

/** The snapshots in `dir` (regular files named as ours), oldest first. */
function snapshotsIn(anchor: string): Array<{ id: string; name: string; size: number; mtimeMs: number }> {
  const out: Array<{ id: string; name: string; size: number; mtimeMs: number }> = [];
  for (const name of readdirSync(anchor)) {
    const m = SNAPSHOT_NAME.exec(name);
    if (!m) continue;
    try {
      const st = lstatSync(join(anchor, name));
      if (st.isFile()) out.push({ id: m[1]!, name, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* vanished */ }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
}

/** Remove the oldest snapshots until `incoming` more bytes fit under `maxBytes`; the ids removed. */
export function makeRoom(dir: string, incoming: number, maxBytes: number): string[] {
  return withPinnedDir(dir, [] as string[], (anchor, stillPinned) => {
    const all = snapshotsIn(anchor);
    let total = all.reduce((n, s) => n + s.size, 0);
    const evicted: string[] = [];
    for (const s of all) {
      if (total + incoming <= maxBytes) break;
      if (!stillPinned()) break;
      try { unlinkSync(join(anchor, s.name)); } catch { continue; }
      total -= s.size;
      evicted.push(s.id);
    }
    return evicted;
  });
}

/**
 * At fleet start, after the web chat history is restored: remove every snapshot of `dir` whose id no restored message
 * holds (`held`), and every temp file a stopped copy left. Nothing but our own names is touched. How many were removed.
 */
export function sweepReplySnapshots(dir: string, held: ReadonlySet<string>): number {
  return withPinnedDir(dir, 0, (anchor, stillPinned) => {
    let removed = 0;
    for (const name of readdirSync(anchor)) {
      const m = SNAPSHOT_NAME.exec(name);
      if (!(m && !held.has(m[1]!)) && !TMP_NAME.test(name)) continue;
      try {
        if (!lstatSync(join(anchor, name)).isFile()) continue;   // a link or a directory is not one of ours
        if (!stillPinned()) break;
        unlinkSync(join(anchor, name)); removed++;
      } catch { /* vanished */ }
    }
    return removed;
  });
}
