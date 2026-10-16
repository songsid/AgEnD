/**
 * Board 003648ac: whether a /compact sent from the web chat has finished. The chat said only "sent", forever.
 *
 * - **Only what the CLI writes.** Claude Code appends a `system` `compact_boundary` record to the session's JSONL and
 *   Codex a `compacted` record to its rollout (the same records the Log tab shows as "compacted", log-steps.ts). Only
 *   a record's own top-level fields count: a long record is read whole (≤ WHOLE_LINE_MAX_BYTES, also when it spans
 *   several reads) and parsed, never judged by text in its head; one that can't be read whole stays unknown. Other
 *   backends (kiro included) record nothing AgEnD can attribute to the instance, so their compaction is never called
 *   finished: `begin` answers null.
 * - **From just before the command's own write.** The daemon queues a paste behind its lock and a wake; just before
 *   it writes this one, it takes the transcript's end (`checkpoint`), and once written it sends that with the launch it
 *   wrote under (`raw_paste_written`). So neither an older boundary nor one written while the command waited counts,
 *   and a compaction that finishes fast is not missed.
 * - **One transcript, one launch.** The watch is bound to that launch (boot, spawn generation, attempt, fence) and to
 *   the transcript's format and path; it is rechecked before every read and after every await, and before it ends.
 *   Another launch, another backend or no transcript ends it as lost. Each look reads through one opened file whose
 *   identity was checked; another file at the path, or this one cut short, starts again at its end: a boundary may then
 *   be missed (the watch times out), never invented.
 * - **Bounded.** One watch per instance (a new /compact replaces it), a look every COMPACT_WATCH_POLL_MS of at most
 *   LOOKS_PER_POLL bounded reads (readNewLines), and an end: done, lost, or timed out after COMPACT_WATCH_TIMEOUT_MS
 *   from the command. A finished watch stays in view for COMPACT_WATCH_KEEP_MS so a page that was away still learns it.
 */
import { randomBytes } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { LOOKS_PER_POLL, readNewLines, readWholeLine, WHOLE_LINE_MAX_BYTES } from "./transcript-jsonl.js";

export const COMPACT_WATCH_POLL_MS = 2_000;
/** A long session's compaction can take minutes (one of 1M tokens took about two); ten is well past that. */
export const COMPACT_WATCH_TIMEOUT_MS = 10 * 60_000;
export const COMPACT_WATCH_KEEP_MS = 2 * 60_000;

export type CompactFormat = "claude" | "codex";
export type CompactState = "running" | "done" | "timeout" | "lost";
export interface CompactWatchView { id: string; state: CompactState }
/** The transcript's end just before the command was written (the daemon's). */
export interface CompactCheckpoint { path: string; ino: number; size: number }

/** One launch of an instance, as a value: a respawn, pause/wake or new fence is another. */
export function launchIdentity(o: { bootId: unknown; spawnGeneration: unknown; launchAttempt: unknown; launchFenceEpoch: unknown }): string {
  return JSON.stringify([o.bootId, o.spawnGeneration, o.launchAttempt, o.launchFenceEpoch]);
}

/** Whether one whole transcript record says the conversation was compacted (its own top-level fields only). */
export function isCompactionRecord(format: CompactFormat, line: string): boolean {
  let e: unknown;
  try { e = JSON.parse(line); } catch { return false; }
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  const r = e as Record<string, unknown>;
  return format === "claude" ? r.type === "system" && r.subtype === "compact_boundary" && r.isSidechain !== true : r.type === "compacted";
}
/** A long record worth reading whole: its head mentions the record at all (anything else is skipped unread). */
const mayBeCompaction = (format: CompactFormat, head: string) => head.includes(format === "claude" ? "compact_boundary" : "compacted");

export interface CompactWatchDeps {
  /** The instance's transcript now, as the Log resolves it; format null: none AgEnD can read. */
  source(name: string): { path: string | null; format: CompactFormat | null };
  /** The launch that runs the instance now (launchIdentity); null: none. */
  owner(name: string): string | null;
  /** A watch ended (done, lost or timed out): the status frame should go out again. */
  changed(name: string): void;
  now?(): number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

interface Base {
  format: CompactFormat; path: string; ino: number; offset: number; skipping: boolean; owner: string;
  /** A long record that may be the one, whose end a later read will find (where it starts). */
  pending: number | null;
}
interface Watch { id: string; state: CompactState; deadline: number; endedAt: number | null; timer: unknown; reading: boolean; base: Base | null }

export class CompactWatch {
  private readonly watches = new Map<string, Watch>();
  constructor(private readonly deps: CompactWatchDeps) {}

  private now(): number { return this.deps.now ? this.deps.now() : performance.now(); }
  private every(fn: () => void, ms: number): unknown { return this.deps.setInterval ? this.deps.setInterval(fn, ms) : setInterval(fn, ms); }
  private clear(handle: unknown): void {
    if (this.deps.clearInterval) this.deps.clearInterval(handle);
    else clearInterval(handle as ReturnType<typeof setInterval>);
  }

  /**
   * Before a /compact is handed to the daemon: a watch that waits for the daemon to say the command was written.
   * Returns its id (sent along with the paste), or null when this backend's compaction cannot be seen.
   */
  begin(name: string): string | null {
    const src = this.deps.source(name);
    if (!src.format || !src.path) return null;
    this.drop(name);
    const id = randomBytes(8).toString("hex");
    const w: Watch = { id, state: "running", deadline: this.now() + COMPACT_WATCH_TIMEOUT_MS, endedAt: null, timer: null, reading: false, base: null };
    w.timer = this.every(() => { void this.poll(name, id); }, COMPACT_WATCH_POLL_MS);
    this.watches.set(name, w);
    return id;
  }

  /**
   * The daemon wrote (or gave up on) the command with this id. Written: it says under which launch, and where the
   * transcript ended just before the write. Both must be this instance's now — the launch running it and the transcript
   * the watch reads — or the watch is lost.
   */
  pasted(name: string, id: string, written: boolean, report: { owner?: unknown; checkpoint?: unknown } = {}): void {
    const w = this.watches.get(name);
    if (!w || w.id !== id || w.state !== "running" || w.base) return;
    if (!written) { this.finish(name, w, "lost"); return; }
    const owner = this.deps.owner(name);
    const src = this.deps.source(name);
    const cp = report.checkpoint as Partial<CompactCheckpoint> | null | undefined;
    const valid = !!cp && typeof cp === "object" && typeof cp.path === "string" && Number.isSafeInteger(cp.ino) && Number.isSafeInteger(cp.size) && (cp.size as number) >= 0;
    if (owner === null || report.owner !== owner || !src.format || !src.path || !valid || cp!.path !== src.path) { this.finish(name, w, "lost"); return; }
    w.base = { format: src.format, path: src.path, ino: cp!.ino as number, offset: cp!.size as number, skipping: false, owner, pending: null };
  }

  /** The command was not handed over after all: forget its watch (nothing was announced for it). */
  cancel(name: string, id: string): void {
    if (this.watches.get(name)?.id === id) this.drop(name);
  }

  /** What the status frame says about the instance's last /compact — or nothing. */
  view(name: string): CompactWatchView | null {
    const w = this.watches.get(name);
    if (!w) return null;
    if (w.endedAt !== null && this.now() - w.endedAt >= COMPACT_WATCH_KEEP_MS) { this.watches.delete(name); return null; }
    return { id: w.id, state: w.state };
  }

  /** The instance went away, or the fleet stops. */
  forget(name: string): void { this.drop(name); }
  stopAll(): void { for (const name of [...this.watches.keys()]) this.drop(name); }

  private drop(name: string): void {
    const w = this.watches.get(name);
    if (!w) return;
    if (w.timer !== null) this.clear(w.timer);
    this.watches.delete(name);
  }

  private finish(name: string, w: Watch, state: "done" | "timeout" | "lost"): void {
    if (this.watches.get(name) !== w || w.state !== "running") return;
    if (w.timer !== null) { this.clear(w.timer); w.timer = null; }
    w.state = state;
    w.endedAt = this.now();
    this.deps.changed(name);
  }

  /**
   * Whether the watch still stands as `base` was set: the same watch and base, running, the same launch, the source
   * still this format with a transcript (else lost, said here) — and still this transcript: one that moved meanwhile
   * stops this look, and the next look starts at the new one's end. Checked after every await and before it ends.
   */
  private standing(name: string, w: Watch, base: Base): boolean {
    if (this.watches.get(name) !== w || w.state !== "running" || w.base !== base) return false;
    const src = this.deps.source(name);
    if (this.deps.owner(name) !== base.owner || src.format !== base.format || !src.path) { this.finish(name, w, "lost"); return false; }
    return src.path === base.path;
  }

  /** One look at the transcript: the watch's timer calls it (tests call it directly). */
  async poll(name: string, id: string): Promise<void> {
    const w = this.watches.get(name);
    if (!w || w.id !== id || w.state !== "running" || w.reading) return;
    if (this.now() >= w.deadline) { this.finish(name, w, "timeout"); return; }
    const base = w.base;
    if (!base) return;                                                     // the command has not reached the pane yet
    w.reading = true;
    try {
      const src = this.deps.source(name);
      if (this.deps.owner(name) !== base.owner || src.format !== base.format || !src.path) { this.finish(name, w, "lost"); return; }
      if (src.path !== base.path) {
        // Another transcript of the same launch: only what is written to it from now on.
        const moved = src.path;
        const { size, ino } = await stat(moved);
        const now = this.deps.source(name);
        if (this.watches.get(name) !== w || w.state !== "running" || w.base !== base) return;
        if (this.deps.owner(name) !== base.owner || now.format !== base.format || !now.path) { this.finish(name, w, "lost"); return; }
        if (now.path === moved) Object.assign(base, { path: moved, ino, offset: size, skipping: false, pending: null });
        return;
      }
      const fh = await open(base.path, "r");
      try {
        const st = await fh.stat();
        if (!this.standing(name, w, base)) return;
        if (st.ino !== base.ino || st.size < base.offset) { Object.assign(base, { ino: st.ino, offset: st.size, skipping: false, pending: null }); return; }
        // Every read below goes through this handle: the file whose identity was just checked, whatever the path holds now.
        const whole = async (offset: number, bytes: number) =>
          (await readWholeLine(base.path, offset, bytes, WHOLE_LINE_MAX_BYTES, fh).catch(() => null)) ?? "";
        for (let look = 0; look < LOOKS_PER_POLL; look++) {
          const read = await readNewLines(base.path, base.offset, { skipping: base.skipping, handle: fh });
          if (!this.standing(name, w, base)) return;
          let found = read.lines.some(l => isCompactionRecord(base.format, l));
          // A long record that began in an earlier read ends in this one: read it whole now.
          if (base.pending !== null && read.longEnd !== undefined) {
            if (!found && isCompactionRecord(base.format, await whole(base.pending, read.longEnd - 1 - base.pending))) found = true;
            base.pending = null;
          }
          for (const l of read.long) {
            if (found || !mayBeCompaction(base.format, l.head)) continue;
            if (!l.complete) { base.pending = l.offset; continue; }
            if (isCompactionRecord(base.format, await whole(l.offset, l.bytes))) found = true;
          }
          if (!this.standing(name, w, base)) return;
          const moved = read.newOffset !== base.offset;
          base.offset = read.newOffset; base.skipping = read.skipping;
          if (found) { this.finish(name, w, "done"); return; }
          if (!moved || !read.more) break;
        }
      } finally {
        await fh.close();
      }
    } catch {
      // A look that fails is tried again on the next tick; the deadline still ends the watch.
    } finally {
      w.reading = false;
    }
  }
}
