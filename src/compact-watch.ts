/**
 * Board 003648ac: whether a /compact sent from the web chat has finished. The chat said only "sent", forever.
 *
 * - **Only what the CLI writes.** Claude Code appends a `system` `compact_boundary` record to the session's JSONL and
 *   Codex a `compacted` record to its rollout (the same records the Log tab shows as "compacted", log-steps.ts). Other
 *   backends write nothing AgEnD can read, so their compaction is never called finished: `begin` answers null.
 * - **Only after the command.** The watch starts at the transcript's end as it is just before the command goes, so an
 *   older boundary never counts. If the transcript changes under it (another file, replaced or cut short), it starts
 *   again at that file's end: a boundary may then be missed (the watch times out), but none is ever invented.
 * - **Bounded.** One watch per instance (a new /compact replaces it), a read every COMPACT_WATCH_POLL_MS of at most
 *   LOOKS_PER_POLL bounded looks (readNewLines), and an end: done, or timed out after COMPACT_WATCH_TIMEOUT_MS. A
 *   finished watch stays in view for COMPACT_WATCH_KEEP_MS so a page that was away still learns how it ended.
 */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { LOOKS_PER_POLL, readNewLines, type LongLine } from "./transcript-jsonl.js";

export const COMPACT_WATCH_POLL_MS = 2_000;
/** A long session's compaction can take minutes (one of 1M tokens took about two); ten is well past that. */
export const COMPACT_WATCH_TIMEOUT_MS = 10 * 60_000;
export const COMPACT_WATCH_KEEP_MS = 2 * 60_000;

export type CompactFormat = "claude" | "codex";
export type CompactState = "running" | "done" | "timeout";
export interface CompactWatchView { id: string; state: CompactState }

/** Whether one transcript record — a line, or a long line's head — says the conversation was compacted. */
export function isCompactionRecord(format: CompactFormat, item: string | LongLine): boolean {
  if (typeof item !== "string") {
    // Too long to parse: only a head that starts the record as that record does.
    return format === "claude"
      ? item.head.includes('"type":"system","subtype":"compact_boundary"') && !item.head.includes('"isSidechain":true')
      : /^\{"timestamp":"[^"]*","type":"compacted"/.test(item.head);
  }
  let e: unknown;
  try { e = JSON.parse(item); } catch { return false; }
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  return format === "claude" ? r.type === "system" && r.subtype === "compact_boundary" && r.isSidechain !== true : r.type === "compacted";
}

export interface CompactWatchDeps {
  /** The instance's transcript now, as the Log resolves it; format null: none AgEnD can read. */
  source(name: string): { path: string | null; format: CompactFormat | null };
  /** A watch ended (done or timed out): the status frame should go out again. */
  changed(name: string): void;
  now?(): number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

interface Watch {
  id: string; format: CompactFormat; state: CompactState;
  path: string; ino: number; offset: number; skipping: boolean;
  deadline: number; endedAt: number | null; timer: unknown; reading: boolean;
}

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
   * Just before a /compact goes: watch for its record. Returns the watch's id, or null when this backend's compaction
   * cannot be seen (no transcript AgEnD reads, or none yet). Synchronous, so nothing is written between the transcript's
   * end being taken and the command being sent.
   */
  begin(name: string): string | null {
    const src = this.deps.source(name);
    if (!src.format || !src.path) return null;
    let st: { ino: number; size: number };
    try { st = statSync(src.path); } catch { return null; }
    this.drop(name);
    const id = randomBytes(8).toString("hex");
    const w: Watch = {
      id, format: src.format, state: "running", path: src.path, ino: st.ino, offset: st.size, skipping: false,
      deadline: this.now() + COMPACT_WATCH_TIMEOUT_MS, endedAt: null, timer: null, reading: false,
    };
    w.timer = this.every(() => { void this.poll(name, id); }, COMPACT_WATCH_POLL_MS);
    this.watches.set(name, w);
    return id;
  }

  /** The command was not sent after all: forget its watch (nothing was announced for it). */
  cancel(name: string, id: string): void {
    if (this.watches.get(name)?.id === id) this.drop(name);
  }

  /** What the status frame says about the instance's last /compact: running, done or timed out — or nothing. */
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

  private finish(name: string, w: Watch, state: "done" | "timeout"): void {
    if (this.watches.get(name) !== w || w.state !== "running") return;
    if (w.timer !== null) { this.clear(w.timer); w.timer = null; }
    w.state = state;
    w.endedAt = this.now();
    this.deps.changed(name);
  }

  /** One look at the transcript: the watch's timer calls it (tests call it directly). */
  async poll(name: string, id: string): Promise<void> {
    const w = this.watches.get(name);
    if (!w || w.id !== id || w.state !== "running" || w.reading) return;
    if (this.now() >= w.deadline) { this.finish(name, w, "timeout"); return; }
    w.reading = true;
    try {
      const src = this.deps.source(name);
      if (src.path && src.path !== w.path) {
        // Another transcript: only what is written to it from now on.
        let size: number, ino: number;
        try { ({ size, ino } = await stat(src.path)); } catch { return; }
        if (this.watches.get(name) !== w) return;
        Object.assign(w, { path: src.path, ino, offset: size, skipping: false });
        return;
      }
      let st: { ino: number; size: number };
      try { st = await stat(w.path); } catch { return; }
      if (this.watches.get(name) !== w) return;
      if (st.ino !== w.ino || st.size < w.offset) { Object.assign(w, { ino: st.ino, offset: st.size, skipping: false }); return; }
      for (let look = 0; look < LOOKS_PER_POLL; look++) {
        const read = await readNewLines(w.path, w.offset, { skipping: w.skipping });
        if (this.watches.get(name) !== w || w.state !== "running") return;
        const moved = read.newOffset !== w.offset;
        w.offset = read.newOffset; w.skipping = read.skipping;
        if (read.lines.some(l => isCompactionRecord(w.format, l)) || read.long.some(l => isCompactionRecord(w.format, l))) {
          this.finish(name, w, "done");
          return;
        }
        if (!moved || !read.more) break;
      }
    } catch {
      // A read that fails is tried again on the next tick; the deadline still ends the watch.
    } finally {
      w.reading = false;
    }
  }
}
