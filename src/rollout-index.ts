import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * One cached listing of Codex's date-sharded rollout files, shared by every instance
 * that follows the same sessions directory (#1161, D2).
 *
 * Every Codex instance's transcript source used to re-walk, stat and sort the WHOLE
 * tree on every 2 s poll: N instances × (every directory + every rollout file), and the
 * tree only ever grows. The listing is the same for all of them, so it is built once
 * and shared; what is built is kept up to date incrementally:
 *
 *   - a listing is reused for `ttlMs` (the pollers' own interval is 2 s, so a new rollout
 *     is noticed within a second of the next poll);
 *   - a directory whose mtime has not moved is not read again (creating a rollout bumps
 *     its directory's mtime; appending to one does not);
 *   - a rollout that has been quiet for `quietMs` is not stat'ed again until the next
 *     full refresh (a file's mtime only matters for ordering, and a quiet file is not
 *     moving), which bounds how stale an old, resumed rollout's position can be by `fullRefreshMs`;
 *   - a full refresh re-reads and re-stats everything, so none of the shortcuts can go
 *     wrong for longer than `fullRefreshMs`.
 *
 * Returns newest-first, the order the sources always had.
 */
export interface RolloutFile { path: string; mtimeMs: number; size: number }

export interface RolloutFsOps {
  readdir(dir: string): string[];
  stat(path: string): { mtimeMs: number; size: number; isDirectory(): boolean };
}

const realOps: RolloutFsOps = { readdir: dir => readdirSync(dir), stat: path => statSync(path) };

export interface RolloutIndexOptions {
  ttlMs?: number;
  quietMs?: number;
  fullRefreshMs?: number;
  maxDepth?: number;
  ops?: RolloutFsOps;
  now?: () => number;
}

interface DirEntry {
  mtimeMs: number;
  subdirs: string[];
  rollouts: string[];
  /**
   * The directory had been modified less than HOT_DIR_MS before this read. Its mtime may then be shared by a
   * file created later in the same tick, so the next refresh reads it once more whatever the mtime says —
   * however long ago that refresh comes (the pollers are 2 s apart: "is it hot NOW" would already be false).
   */
  hotWhenRead: boolean;
}

export const DEFAULT_ROLLOUT_TTL_MS = 1_000;
/** A directory read this soon after its last change is read once more before its mtime is trusted. */
const HOT_DIR_MS = 2_000;

export class RolloutIndex {
  private readonly ttlMs: number;
  private readonly quietMs: number;
  private readonly fullRefreshMs: number;
  private readonly maxDepth: number;
  private readonly ops: RolloutFsOps;
  private readonly now: () => number;
  private dirs = new Map<string, DirEntry>();
  private files = new Map<string, RolloutFile>();
  private listing: RolloutFile[] = [];
  private builtAt = Number.NEGATIVE_INFINITY;
  private fullAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly root: string, options: RolloutIndexOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_ROLLOUT_TTL_MS;
    this.quietMs = options.quietMs ?? 10 * 60_000;
    this.fullRefreshMs = options.fullRefreshMs ?? 60_000;
    this.maxDepth = options.maxDepth ?? 4;
    this.ops = options.ops ?? realOps;
    this.now = options.now ?? Date.now;
  }

  /** Newest rollout first. `fresh` bypasses the shared listing (checkpoints, baselines). */
  list(fresh = false): RolloutFile[] {
    const now = this.now();
    if (!fresh && now - this.builtAt < this.ttlMs) return this.listing;
    const full = fresh || now - this.fullAt >= this.fullRefreshMs;
    this.rebuild(now, full);
    return this.listing;
  }

  private rebuild(now: number, full: boolean): void {
    const dirs = new Map<string, DirEntry>();
    const files = new Map<string, RolloutFile>();
    const walk = (dir: string, depth: number): void => {
      let mtimeMs: number;
      try { mtimeMs = this.ops.stat(dir).mtimeMs; } catch { return; }
      let entry = this.dirs.get(dir);
      // A directory whose last read was taken right after a change is read once more: file times have
      // coarse granularity, so a rollout created in the same tick as that change shares its mtime and
      // would otherwise stay unseen until the next full refresh. (Judged by when it was LAST READ, not by
      // how hot it is now: the next refresh comes a poll interval later, when it has long since cooled.)
      if (full || !entry || entry.mtimeMs !== mtimeMs || entry.hotWhenRead) {
        entry = this.readDir(dir, mtimeMs, depth, now);
      }
      dirs.set(dir, entry);
      for (const rollout of entry.rollouts) {
        const known = this.files.get(rollout);
        if (!full && known && now - known.mtimeMs > this.quietMs) { files.set(rollout, known); continue; }
        try {
          const st = this.ops.stat(rollout);
          files.set(rollout, { path: rollout, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* raced with deletion */ }
      }
      if (depth < this.maxDepth) for (const sub of entry.subdirs) walk(sub, depth + 1);
    };
    walk(this.root, 0);
    this.dirs = dirs;
    this.files = files;
    this.listing = [...files.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
    this.builtAt = now;
    if (full) this.fullAt = now;
  }

  private readDir(dir: string, mtimeMs: number, depth: number, now: number): DirEntry {
    const entry: DirEntry = { mtimeMs, subdirs: [], rollouts: [], hotWhenRead: now - mtimeMs < HOT_DIR_MS };
    let names: string[];
    try { names = this.ops.readdir(dir); } catch { return entry; }
    for (const name of names) {
      const path = join(dir, name);
      if (name.startsWith("rollout-") && name.endsWith(".jsonl")) { entry.rollouts.push(path); continue; }
      if (depth >= this.maxDepth) continue;
      try { if (this.ops.stat(path).isDirectory()) entry.subdirs.push(path); } catch { /* raced with deletion */ }
    }
    return entry;
  }
}

const shared = new Map<string, RolloutIndex>();
let sharedTtlMs = DEFAULT_ROLLOUT_TTL_MS;

/** The listing every source following `root` shares. */
export function sharedRolloutIndex(root: string): RolloutIndex {
  let index = shared.get(root);
  if (!index) { index = new RolloutIndex(root, { ttlMs: sharedTtlMs }); shared.set(root, index); }
  return index;
}

/** Test seam: drop every shared listing and set the TTL new ones get (0 = always rebuild: a test edits its own tree between polls). */
export function resetSharedRolloutIndexesForTests(ttlMs = DEFAULT_ROLLOUT_TTL_MS): void {
  shared.clear();
  sharedTtlMs = ttlMs;
}
