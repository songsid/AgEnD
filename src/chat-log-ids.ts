/**
 * #2940: keeping AgEnD's own status messages out of the ClassicBot chat logs (chat-logs/YYYY-MM-DD.log, read back as
 * every bot's "[Chat log for context]").
 *
 * - OwnStatusMessages: the platform message ids of the status/progress bubbles ("👀 處理中…", posted by
 *   FleetManager.sendCancelButton for any bot of this fleet — one process holds every adapter) and the ids of messages
 *   the platform said were deleted. A line is never recorded for either — matched by id, never by text (a person may
 *   write 「處理中」 too).
 * - ChatLogLines: which log lines were recorded for a message id, so a line already written can be taken out again: when
 *   the bubble's id is learned after a sibling bot logged it (the gateway's event can arrive before the post's own REST
 *   answer), and when the platform says the message was deleted (the backstop).
 * Both are memory only and bounded: they cover the minutes a status bubble lives, not history.
 */
import { readFileSync, statSync, utimesSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";

/**
 * #2943 review: the identity a status bubble, a logged line and a delete agree on — Discord only (the only platform where
 * bots of a fleet see each other's posts, and the only one that says a message was deleted), scoped by its channel:
 * Discord message ids are global, but the key never meets another platform's or chat's numbering (a Telegram "42").
 */
export function discordMessageKey(channelId: string | undefined, messageId: string | undefined): string | undefined {
  return channelId && messageId ? `discord:${channelId}:${messageId}` : undefined;
}

/** Ids kept at most this long… */
export const CHAT_LOG_ID_TTL_MS = 6 * 3_600_000;
/** …and at most this many of each kind (the oldest go first). */
export const CHAT_LOG_ID_MAX = 5_000;

class TimedIds {
  private readonly ids = new Map<string, number>();
  constructor(private readonly now: () => number) {}
  add(id: string): void {
    this.ids.delete(id);
    this.ids.set(id, this.now());
    this.prune();
  }
  has(id: string): boolean {
    const at = this.ids.get(id);
    if (at === undefined) return false;
    if (this.now() - at > CHAT_LOG_ID_TTL_MS) { this.ids.delete(id); return false; }
    return true;
  }
  private prune(): void {
    const cutoff = this.now() - CHAT_LOG_ID_TTL_MS;
    for (const [id, at] of this.ids) { if (at >= cutoff && this.ids.size <= CHAT_LOG_ID_MAX) break; this.ids.delete(id); }
  }
}

/** The ids of this fleet's own status messages, and of messages the platform reported deleted. */
export class OwnStatusMessages {
  private readonly status: TimedIds;
  private readonly deleted: TimedIds;
  constructor(now: () => number = Date.now) { this.status = new TimedIds(now); this.deleted = new TimedIds(now); }
  addStatus(messageId: string): void { if (messageId) this.status.add(messageId); }
  markDeleted(messageId: string): void { if (messageId) this.deleted.add(messageId); }
  /** A message whose line is never recorded: one of our status bubbles, or one already deleted. */
  excluded(messageId: string | undefined): boolean {
    return !!messageId && (this.status.has(messageId) || this.deleted.has(messageId));
  }
}

/** A line as it was written: which file (and that file's inode), where it starts (bytes), its exact bytes. */
interface Occurrence { file: string; ino: number; offset: number; line: string; at: number }
/** At most this many occurrences are kept in all (#2943 review: not only distinct ids), and this many per id. */
export const CHAT_LOG_OCCURRENCES_MAX = 5_000;
export const CHAT_LOG_OCCURRENCES_PER_ID = 16;

export interface ChatLogLinesIo {
  /** Replace `file`'s content atomically (a temp file in its directory, renamed over it), with permission bits `mode`. */
  replace(file: string, data: string, mode: number): void;
}
const atomicIo: ChatLogLinesIo = { replace: (file, data, mode) => atomicWriteFileSync(file, data, { mode }) };

/**
 * Which chat-log lines were written for each message key (bounded): what a later removal takes out. An occurrence is the
 * written bytes at their recorded place in that very file (#2943 review): never "the same text somewhere".
 */
export class ChatLogLines {
  private readonly byKey = new Map<string, Occurrence[]>();
  private total = 0;
  constructor(private readonly now: () => number = Date.now, private readonly io: ChatLogLinesIo = atomicIo) {}

  /** `line` was appended to `file` (inode `ino`) at byte `offset`. Ignored when this occurrence is already known. */
  record(key: string, file: string, ino: number, offset: number, line: string): void {
    const list = this.byKey.get(key) ?? [];
    if (list.some(o => o.file === file && o.offset === offset)) return;
    if (list.length >= CHAT_LOG_OCCURRENCES_PER_ID) { list.shift(); this.total--; }
    list.push({ file, ino, offset, line, at: this.now() });
    this.total++;
    this.byKey.delete(key);
    this.byKey.set(key, list);
    const cutoff = this.now() - CHAT_LOG_ID_TTL_MS;
    for (const [k, entries] of this.byKey) {
      if (entries.at(-1)!.at >= cutoff && this.byKey.size <= CHAT_LOG_ID_MAX && this.total <= CHAT_LOG_OCCURRENCES_MAX) break;
      this.byKey.delete(k);
      this.total -= entries.length;
    }
  }

  /**
   * Take each line recorded for `key` out of its file: only where it was written — the same file (inode), the same bytes
   * at the recorded offset; anything else (the file rotated, rewritten, the bytes not there) is not proven and is left
   * alone. The file is replaced atomically with its permission bits and modified time kept (the dashboard's last
   * activity); a write that fails leaves the file as it was and the occurrence recorded (a later removal may succeed).
   * Returns how many lines were removed.
   */
  remove(key: string): number {
    const entries = this.byKey.get(key);
    if (!entries) return 0;
    let removed = 0;
    const kept: Occurrence[] = [];
    for (const o of entries) {
      let st;
      try { st = statSync(o.file); } catch { this.total--; continue; }              // the file is gone: nothing to take out
      const want = Buffer.from(o.line, "utf8");
      let buf: Buffer;
      try { buf = readFileSync(o.file); } catch { kept.push(o); continue; }
      if (st.ino !== o.ino || !buf.subarray(o.offset, o.offset + want.length).equals(want)) { this.total--; continue; }   // not proven
      try {
        this.io.replace(o.file, Buffer.concat([buf.subarray(0, o.offset), buf.subarray(o.offset + want.length)]).toString("utf8"), st.mode & 0o7777);
      } catch { kept.push(o); continue; }                                            // the original is untouched
      try { utimesSync(o.file, st.atime, st.mtime); } catch { /* the content is right; only its time could not be kept */ }
      const ino = statSync(o.file).ino;
      this.total--;
      removed++;
      // Every other occurrence in that file: the new inode, and a later place moves up by the removed bytes.
      for (const list of this.byKey.values()) for (const other of list) {
        if (other === o || other.file !== o.file || other.ino !== o.ino) continue;
        other.ino = ino;
        if (other.offset > o.offset) other.offset -= want.length;
      }
      for (const other of kept) if (other.file === o.file && other.ino === o.ino) { other.ino = ino; if (other.offset > o.offset) other.offset -= want.length; }
    }
    if (kept.length) this.byKey.set(key, kept); else this.byKey.delete(key);
    return removed;
  }
}
