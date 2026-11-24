/**
 * #1753: carry a Claude Code conversation across a credential-profile switch.
 *
 * Each profile is its own `CLAUDE_CONFIG_DIR`, and a conversation is a transcript under it:
 * `<config>/projects/<cwd key>/<session id>.jsonl`, with its `<session id>/` folder (subagents, tool results) beside it.
 * The new profile has no conversation for this directory, so a switch used to start fresh with a handover. Copying the
 * session into the new profile and making it the newest there lets the relaunch's `--continue` pick it up — verified on
 * a real account with claude 2.1.296 (#1753).
 *
 * Copy, never move: the old profile keeps its original untouched, so switching back still has it. Everything is written
 * under a temporary name and renamed into place, so claude never sees a half-copied transcript. A failure says why, and
 * the caller then starts fresh with a handover, as before. Up to the rename into place the target is left as it was;
 * the one step after it (dating the copy as the newest) can fail with the copy already there — or, switching back,
 * already in place of the older one — which the fresh start leaves unused.
 */
import { constants as fsConstants } from "node:fs";
import { copyFile, cp, mkdir, open, readdir, rename, rm, stat, statfs, utimes } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectKey } from "./claude-code.js";

export type CarryResult =
  | { carried: true; sessionId: string; bytes: number; ms: number; replacedOlderCopy: boolean;
      /** M-3629: the target's own copy (a different history, older by its last turn), kept beside it under this name. */
      backedUp?: string }
  | { carried: false; reason: string };

export interface CarryRequest {
  /** The instance's session id (`<instanceDir>/session-id`), as read. */
  sessionId: string | null | undefined;
  workingDirectory: string;
  /** Config dirs as the CLI sees them (claudeConfigDirFor): the one being left, the one being switched to. */
  fromConfigDir: string;
  toConfigDir: string;
  now?: () => number;
  /** Free bytes on the target's filesystem; injectable for tests. */
  freeBytes?: (dir: string) => Promise<number>;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Room kept free beyond the copy itself. */
const SPACE_MARGIN = 64 * 1024 * 1024;
/** How much of an existing copy is compared, at its start and at its end, to tell an older copy from another history. */
const PREFIX_PROBE = 64 * 1024;

async function defaultFreeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

async function sizeOf(path: string): Promise<number | null> {
  try { return (await stat(path)).size; } catch { return null; }
}

async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await treeBytes(p);
    else if (e.isFile()) total += (await sizeOf(p)) ?? 0;
  }
  return total;
}

async function readAt(path: string, offset: number, length: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

/**
 * Is `target` an older copy of `source` — the same conversation, cut shorter? (Switching back: A → B → A finds A's
 * original, which B's copy has since grown past.) Its start and its end must match the source at the same offsets.
 */
async function isOlderCopy(target: string, targetSize: number, source: string, sourceSize: number): Promise<boolean> {
  if (targetSize > sourceSize) return false;
  const head = Math.min(PREFIX_PROBE, targetSize);
  const tailAt = Math.max(0, targetSize - PREFIX_PROBE);
  const [th, sh, tt, st] = await Promise.all([
    readAt(target, 0, head), readAt(source, 0, head),
    readAt(target, tailAt, targetSize - tailAt), readAt(source, tailAt, targetSize - tailAt),
  ]);
  return th.equals(sh) && tt.equals(st);
}

/**
 * M-3629: when a transcript's last turn was (ms), from its own lines — not the file's mtime, which a carry sets to "now"
 * on purpose. The last line in its final PREFIX_PROBE bytes with a `timestamp` that parses; null if none.
 */
export async function lastTurnAt(path: string): Promise<number | null> {
  const size = await sizeOf(path);
  if (!size) return null;
  const at = Math.max(0, size - PREFIX_PROBE);
  const lines = (await readAt(path, at, size - at)).toString("utf8").split("\n");
  if (at > 0) lines.shift();                                  // a line cut by the probe's start is not read
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
      const n = typeof ts === "string" ? Date.parse(ts) : NaN;
      if (Number.isFinite(n)) return n;
    } catch { /* a partial or non-JSON line: look further back */ }
  }
  return null;
}
/** Where a target's own copy is kept when the source replaces it: beside it, under a name claude never reads as a transcript. */
export const carryBackupName = (name: string, at: number) => `${name}.agend-backup-${new Date(at).toISOString().replace(/[:.]/g, "-")}`;

/** The newest mtime (ms) among the other transcripts in the target's project folder. */
async function newestOtherTranscript(dir: string, except: string): Promise<number> {
  let newest = 0;
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".jsonl") || e.name === except) continue;
      const m = (await stat(join(dir, e.name))).mtimeMs;
      if (m > newest) newest = m;
    }
  } catch { /* no folder yet */ }
  return newest;
}

export async function carryClaudeConversation(req: CarryRequest): Promise<CarryResult> {
  const started = performance.now();
  const sid = (req.sessionId ?? "").trim();
  if (!SESSION_ID.test(sid)) return { carried: false, reason: "no session id to carry" };
  if (!req.workingDirectory.trim()) return { carried: false, reason: "no working directory" };
  if (req.fromConfigDir === req.toConfigDir) return { carried: false, reason: "same config dir" };
  const key = claudeProjectKey(req.workingDirectory);
  const fromDir = join(req.fromConfigDir, "projects", key);
  const toDir = join(req.toConfigDir, "projects", key);
  const name = `${sid}.jsonl`;
  const source = join(fromDir, name), target = join(toDir, name);
  const sourceSize = await sizeOf(source);
  if (sourceSize === null) return { carried: false, reason: "the session's transcript is not in the old profile" };

  const targetSize = await sizeOf(target);
  let replacedOlderCopy = false, backup: string | null = null;
  if (targetSize !== null) {
    if (!await isOlderCopy(target, targetSize, source, sourceSize).catch(() => false)) {
      // M-3629: another history of this conversation (each profile went on with it). The source goes over it only when
      // its last turn is later; the target's copy is then kept beside it, never lost. Newer, the same, or unknown: refused.
      const [sourceAt, targetAt] = await Promise.all([lastTurnAt(source).catch(() => null), lastTurnAt(target).catch(() => null)]);
      if (sourceAt === null || targetAt === null || !(sourceAt > targetAt)) {
        return { carried: false, reason: sourceAt === null || targetAt === null
          ? "the new profile already holds a different version of this conversation, and which is newer can't be told"
          : "the new profile already holds a version of this conversation at least as new" };
      }
      backup = carryBackupName(name, (req.now ?? Date.now)());
    }
    replacedOlderCopy = true;
  }

  const folderBytes = await treeBytes(join(fromDir, sid));
  const needed = sourceSize + folderBytes + SPACE_MARGIN;
  try {
    await mkdir(toDir, { recursive: true });
    const free = await (req.freeBytes ?? defaultFreeBytes)(toDir);
    if (free < needed) return { carried: false, reason: `not enough free space (${needed} bytes needed, ${free} free)` };
  } catch (err) {
    return { carried: false, reason: `the new profile's folder is not usable: ${(err as Error).message}` };
  }

  const tag = `.carry-${process.pid}-${Math.floor(started)}`;
  const tmpFile = join(toDir, `.${name}${tag}`);
  const tmpFolder = join(toDir, `.${sid}${tag}`);
  try {
    // A copy-on-write clone where the filesystem has one (btrfs, xfs, APFS), a plain copy elsewhere.
    await copyFile(source, tmpFile, fsConstants.COPYFILE_FICLONE);
    // The session's folder first, so the transcript never appears before the files it refers to.
    if (await sizeOf(join(fromDir, sid)) !== null) {
      await cp(join(fromDir, sid), tmpFolder, { recursive: true, errorOnExist: false, force: true });
      if (await sizeOf(join(toDir, sid)) === null) await rename(tmpFolder, join(toDir, sid));
      else {
        // Switching back: the folder is there already. It takes the copy's files; its own extra files stay.
        await cp(tmpFolder, join(toDir, sid), { recursive: true, errorOnExist: false, force: true });
        await rm(tmpFolder, { recursive: true, force: true });
      }
    }
    // M-3629: the target's own (older) history is kept, renamed, before the source takes its place.
    if (backup) await rename(target, join(toDir, backup));
    await rename(tmpFile, target);
  } catch (err) {
    // The target's own copy is put back if it was moved aside and the source never took its place: never lose either.
    if (backup && await sizeOf(target) === null) await rename(join(toDir, backup), target).catch(() => undefined);
    await rm(tmpFile, { force: true }).catch(() => undefined);
    await rm(tmpFolder, { recursive: true, force: true }).catch(() => undefined);
    return { carried: false, reason: `copy failed: ${(err as Error).message}` };
  }

  // Newest in its folder, so `--continue` picks it — even past another transcript dated ahead of this clock.
  const now = (req.now ?? Date.now)();
  const mtime = Math.max(now, (await newestOtherTranscript(toDir, name)) + 1_000);
  try { await utimes(target, mtime / 1000, mtime / 1000); } catch (err) {
    return { carried: false, reason: `could not date the copy as the newest: ${(err as Error).message}` };
  }

  // `/rewind` reaches edits from before the switch: the session's file history, merged, never overwriting. Best effort.
  await cp(join(req.fromConfigDir, "file-history", sid), join(req.toConfigDir, "file-history", sid), { recursive: true, errorOnExist: false, force: false })
    .catch(() => undefined);

  return { carried: true, sessionId: sid, bytes: sourceSize + folderBytes, ms: Math.round(performance.now() - started), replacedOlderCopy, ...(backup ? { backedUp: backup } : {}) };
}
