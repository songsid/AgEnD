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
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";

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

interface LoggedLine { file: string; line: string; at: number }

/** Which chat-log lines were written for each message id (bounded): what a later removal takes out. */
export class ChatLogLines {
  private readonly lines = new Map<string, LoggedLine[]>();
  constructor(private readonly now: () => number = Date.now) {}
  record(messageId: string, file: string, line: string): void {
    const list = this.lines.get(messageId) ?? [];
    list.push({ file, line, at: this.now() });
    this.lines.delete(messageId);
    this.lines.set(messageId, list);
    const cutoff = this.now() - CHAT_LOG_ID_TTL_MS;
    for (const [id, entries] of this.lines) {
      if (entries[0]!.at >= cutoff && this.lines.size <= CHAT_LOG_ID_MAX) break;
      this.lines.delete(id);
    }
  }
  /**
   * Take every line recorded for `messageId` out of its file (once: the entry is forgotten). The last exact occurrence
   * of each line goes; the file's modified time is kept (it is how the dashboard tells a room's last activity). Returns
   * how many lines were removed.
   */
  remove(messageId: string): number {
    const entries = this.lines.get(messageId);
    if (!entries) return 0;
    this.lines.delete(messageId);
    let removed = 0;
    for (const { file, line } of entries) {
      try {
        const before = statSync(file);
        const text = readFileSync(file, "utf8");
        const at = text.lastIndexOf(line);
        if (at < 0 || (at > 0 && text[at - 1] !== "\n")) continue;
        writeFileSync(file, text.slice(0, at) + text.slice(at + line.length));
        utimesSync(file, before.atime, before.mtime);
        removed++;
      } catch { /* the file rotated away or cannot be read: nothing to take out */ }
    }
    return removed;
  }
}
