/**
 * Board 003648ac: whether a /compact sent from the web chat has finished. The chat said only "sent", forever.
 *
 * - **Only what the CLI writes.** Claude Code appends a `system` `compact_boundary` record to the session's JSONL and
 *   Codex a `compacted` record to its rollout (the same records the Log tab shows as "compacted", log-steps.ts). Only
 *   a record's own top-level fields count: a long record is read whole (≤ WHOLE_LINE_MAX_BYTES) and parsed, never
 *   judged by text in its head; one that can't be read whole stays unknown. kiro (classic and TUI V2) writes no
 *   transcript AgEnD reads here, but its daemon reports its own record of a compaction (`signal`). Other backends, and
 *   kiro V3, record nothing AgEnD can see, so their compaction is never called finished: `begin` answers null.
 * - **Only after the command reached the pane.** The daemon queues a paste behind its lock and a wake; it says when
 *   this one was written (`raw_paste_written`). The watch takes the transcript's end then, so neither an older
 *   boundary nor one written while the command still waited counts. A command that never reached the pane is lost.
 * - **One transcript, one launch.** The watch is bound to the instance's daemon when the command was written and to
 *   the transcript's format; another daemon (a stop, a relaunch), another backend or no transcript any more ends it
 *   as lost. Each look reads through one opened file whose identity was checked; another file at the path, or this
 *   one cut short, starts again at its end: a boundary may then be missed (the watch times out), never invented.
 * - **Bounded.** One watch per instance (a new /compact replaces it), a look every COMPACT_WATCH_POLL_MS of at most
 *   LOOKS_PER_POLL bounded reads (readNewLines), and an end: done, lost, or timed out after COMPACT_WATCH_TIMEOUT_MS
 *   from the command. A finished watch stays in view for COMPACT_WATCH_KEEP_MS so a page that was away still learns it.
 */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { LOOKS_PER_POLL, readNewLines, readWholeLine, WHOLE_LINE_MAX_BYTES } from "./transcript-jsonl.js";

export const COMPACT_WATCH_POLL_MS = 2_000;
/** A long session's compaction can take minutes (one of 1M tokens took about two); ten is well past that. */
export const COMPACT_WATCH_TIMEOUT_MS = 10 * 60_000;
export const COMPACT_WATCH_KEEP_MS = 2 * 60_000;

export type CompactFormat = "claude" | "codex";
export type CompactState = "running" | "done" | "timeout" | "lost";
export interface CompactWatchView { id: string; state: CompactState }

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
  /** Who runs the instance now (its daemon); null: nobody. Compared by identity. */
  owner(name: string): unknown;
  /** No transcript to read, but the instance's daemon reports a compaction (`signal`): kiro's engines that record it. */
  signals?(name: string): boolean;
  /** A watch ended (done, lost or timed out): the status frame should go out again. */
  changed(name: string): void;
  now?(): number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

interface FileBase { kind: "file"; format: CompactFormat; path: string; ino: number; offset: number; skipping: boolean; owner: unknown }
interface SignalBase { kind: "signal"; owner: unknown }
type Base = FileBase | SignalBase;
interface Watch { id: string; mode: "file" | "signal"; state: CompactState; deadline: number; endedAt: number | null; timer: unknown; reading: boolean; base: Base | null }

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
    const mode = src.format && src.path ? "file" : this.deps.signals?.(name) ? "signal" : null;
    if (!mode) return null;
    this.drop(name);
    const id = randomBytes(8).toString("hex");
    const w: Watch = { id, mode, state: "running", deadline: this.now() + COMPACT_WATCH_TIMEOUT_MS, endedAt: null, timer: null, reading: false, base: null };
    w.timer = this.every(() => { void this.poll(name, id); }, COMPACT_WATCH_POLL_MS);
    this.watches.set(name, w);
    return id;
  }

  /**
   * The daemon wrote (or gave up on) the command with this id. Written: the transcript's end now is where its record
   * may start, under the daemon that runs the instance now. Synchronous, so nothing is read in between.
   */
  pasted(name: string, id: string, written: boolean): void {
    const w = this.watches.get(name);
    if (!w || w.id !== id || w.state !== "running" || w.base) return;
    if (!written) { this.finish(name, w, "lost"); return; }
    const owner = this.deps.owner(name);
    if (w.mode === "signal") {
      if (owner == null) this.finish(name, w, "lost");
      else w.base = { kind: "signal", owner };
      return;
    }
    const src = this.deps.source(name);
    let st: { ino: number; size: number } | null = null;
    if (src.format && src.path && owner != null) { try { st = statSync(src.path); } catch { st = null; } }
    if (!st || !src.format || !src.path) { this.finish(name, w, "lost"); return; }
    w.base = { kind: "file", format: src.format, path: src.path, ino: st.ino, offset: st.size, skipping: false, owner };
  }

  /**
   * The instance's daemon reported that its CLI recorded a compaction (kiro). It ends a signal watch whose command was
   * written under that same daemon; one still queued, or any other watch, is untouched.
   */
  signal(name: string): void {
    const w = this.watches.get(name);
    if (!w || w.state !== "running" || w.base?.kind !== "signal") return;
    if (this.deps.owner(name) !== w.base.owner) { this.finish(name, w, "lost"); return; }
    this.finish(name, w, "done");
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

  /** One look at the transcript: the watch's timer calls it (tests call it directly). */
  async poll(name: string, id: string): Promise<void> {
    const w = this.watches.get(name);
    if (!w || w.id !== id || w.state !== "running" || w.reading) return;
    if (this.now() >= w.deadline) { this.finish(name, w, "timeout"); return; }
    const base = w.base;
    if (!base) return;                                                     // the command has not reached the pane yet
    if (base.kind === "signal") {                                          // its end comes as a signal; only the launch is checked
      if (this.deps.owner(name) !== base.owner) this.finish(name, w, "lost");
      return;
    }
    const live = () => this.watches.get(name) === w && w.state === "running" && w.base === base;
    const src = this.deps.source(name);
    if (this.deps.owner(name) !== base.owner || src.format !== base.format || !src.path) { this.finish(name, w, "lost"); return; }
    w.reading = true;
    try {
      if (src.path !== base.path) {
        // Another transcript of the same launch: only what is written to it from now on.
        const { size, ino } = await stat(src.path);
        if (live()) Object.assign(base, { path: src.path, ino, offset: size, skipping: false });
        return;
      }
      const fh = await open(base.path, "r");
      try {
        const st = await fh.stat();
        if (!live()) return;
        if (st.ino !== base.ino || st.size < base.offset) { Object.assign(base, { ino: st.ino, offset: st.size, skipping: false }); return; }
        // Every read below goes through this handle: the file whose identity was just checked, whatever the path holds now.
        for (let look = 0; look < LOOKS_PER_POLL; look++) {
          const read = await readNewLines(base.path, base.offset, { skipping: base.skipping, handle: fh });
          if (!live()) return;
          let found = read.lines.some(l => isCompactionRecord(base.format, l));
          for (const l of read.long) {
            if (found || !l.complete || !mayBeCompaction(base.format, l.head)) continue;
            const whole = await readWholeLine(base.path, l.offset, l.bytes, WHOLE_LINE_MAX_BYTES, fh).catch(() => null);
            if (whole !== null && isCompactionRecord(base.format, whole)) found = true;
          }
          if (!live()) return;
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
