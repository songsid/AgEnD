/**
 * M-3272 (the user, 2026-11-17: web chat scroll-back): the messages that leave an agent's 500-message web chat window
 * (WebChatHistory.record's eviction) are appended here instead of being dropped, so the page can scroll back past them.
 *
 *   <home>/workspaces/<instance>/web-chat-archive/
 *     owner                  who the agent is (as web-chat.json's `owner`): another agent that only shares the name
 *                            never reads this archive; its first write moves it aside (never deletes it)
 *     2026-11.jsonl          one JSON object per line, oldest first — append-only, one file per month (of eviction)
 *
 * A line is `{"key":"<boot>-<id>",…}`: the key first, so a scan finds a message without parsing every line. What is kept
 * is what web-chat.json keeps of a message (WebChatHistory.stored), plus its buttons as they last were, closed for good
 * (an archived reply's buttons and polls are read-only), and its files by name only (a file leaves with its message:
 * nothing is served under its id any more, #1565). Writes are queued per instance (one append in flight, order kept).
 * Retention (`web.chat_archive.retention_days`, unset or 0: keep everything) drops whole months that ended before it.
 * Reads go backwards through the files in fixed-size chunks: a page costs what it reads, never the whole archive.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeInstanceDirName } from "./web-chat-store.js";

export const ARCHIVE_DIR = "web-chat-archive";
const OWNER_FILE = "owner";
const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/;
const CHUNK = 64 * 1024;
/** A line longer than this is not one of ours (a message is at most 16,000 characters): skipped. */
const LINE_MAX = 1024 * 1024;

export interface ArchivedLine { key: string; [field: string]: unknown }
export interface ArchiveLogger { warn(obj: unknown, msg?: string): void; debug?(obj: unknown, msg?: string): void }

export class WebChatArchive {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly prunedAt = new Map<string, number>();

  constructor(private readonly opts: {
    home: string;
    /** Who the instance is now (WebChatDiskStore's ownerOf); null: not configured — nothing archived, nothing read. */
    ownerOf: (instance: string) => string | null;
    /** `web.chat_archive.retention_days` as in force: unset or 0 keeps everything. */
    retentionDays?: () => number | undefined;
    logger: ArchiveLogger;
    now?: () => number;
  }) {}

  private now(): number { return this.opts.now?.() ?? Date.now(); }
  dirOf(instance: string): string | null {
    return isSafeInstanceDirName(instance) ? join(this.opts.home, "workspaces", instance, ARCHIVE_DIR) : null;
  }
  /** This instance's archive directory, when it is this instance's (its owner file matches); null otherwise. */
  private ownDir(instance: string): string | null {
    const dir = this.dirOf(instance), owner = this.opts.ownerOf(instance);
    if (!dir || !owner || !existsSync(dir)) return null;
    try { return readFileSync(join(dir, OWNER_FILE), "utf8") === owner ? dir : null; } catch { return null; }
  }
  /** The month files, newest first. */
  private months(dir: string): string[] {
    try { return readdirSync(dir).filter(f => MONTH_FILE.test(f)).sort().reverse(); } catch { return []; }
  }

  /**
   * Append these lines (oldest first) to the instance's archive, in order, after any append still under way. A failure is
   * logged and those lines are lost (as before M-3272, when every one was): the chat itself is never held up by it.
   */
  append(instance: string, lines: ArchivedLine[]): void {
    if (!lines.length) return;
    const prev = this.queues.get(instance) ?? Promise.resolve();
    const next = prev.then(() => this.write(instance, lines)).catch(err => this.opts.logger.warn({ err: (err as Error)?.message, instance }, "Web chat archive: lines could not be written"));
    this.queues.set(instance, next);
    void next.finally(() => { if (this.queues.get(instance) === next) this.queues.delete(instance); });
  }
  private async write(instance: string, lines: ArchivedLine[]): Promise<void> {
    const dir = this.dirOf(instance), owner = this.opts.ownerOf(instance);
    if (!dir || !owner) return;
    if (existsSync(dir)) {
      let was: string | null = null;
      try { was = readFileSync(join(dir, OWNER_FILE), "utf8"); } catch { was = null; }
      if (was !== owner) {
        // Another agent's archive under this name (it was removed while the fleet was down): set aside, never mixed in.
        const aside = `${dir}.${Math.floor(this.now() / 1000)}.old`;
        try { renameSync(dir, aside); this.opts.logger.warn({ instance, aside }, "Web chat archive: another agent's archive under this name was set aside"); }
        catch (err) { this.opts.logger.warn({ err: (err as Error)?.message, instance }, "Web chat archive: another agent's archive could not be set aside; not appending"); return; }
      }
    }
    if (!existsSync(dir)) { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(join(dir, OWNER_FILE), owner, { mode: 0o600 }); }
    const d = new Date(this.now());
    const file = join(dir, `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
    await appendFile(file, lines.map(l => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
    this.pruneSoon(instance, dir);
  }
  /** At most once an hour per instance: drop the months that ended before the retention cut-off. */
  private pruneSoon(instance: string, dir: string): void {
    const now = this.now();
    if (now - (this.prunedAt.get(instance) ?? -Infinity) < 3_600_000) return;
    this.prunedAt.set(instance, now);
    this.prune(instance, dir);
  }
  /** Drop whole months that ended before `retention_days` ago (unset or 0: nothing). Returns the files removed. */
  prune(instance: string, dir = this.ownDir(instance)): string[] {
    const days = this.opts.retentionDays?.();
    if (!dir || !days || !(days > 0)) return [];
    const cutoff = this.now() - days * 86_400_000, removed: string[] = [];
    for (const f of this.months(dir)) {
      const m = MONTH_FILE.exec(f)!;
      const monthEnd = Date.UTC(Number(m[1]), Number(m[2]), 1);          // the first moment of the next month
      if (monthEnd > cutoff) continue;
      try { rmSync(join(dir, f), { force: true }); removed.push(f); } catch (err) { this.opts.logger.warn({ err: (err as Error)?.message, instance, file: f }, "Web chat archive: a month past retention could not be removed"); }
    }
    return removed;
  }
  /** Every append queued so far, written (tests; shutdown). */
  async flush(): Promise<void> { await Promise.all([...this.queues.values()]); }
  /** The agent was removed: its archive goes with it (after any append under way). */
  async forget(instance: string): Promise<void> {
    await (this.queues.get(instance) ?? Promise.resolve());
    const dir = this.dirOf(instance);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Lines from newest to oldest (the files newest first, each read backwards in chunks). Bytes, never text, until a line is
   * whole (#4101 review F1): a chunk's edge can cut a character (CJK, an emoji) in two — decoding each chunk on its own
   * turned both halves into U+FFFD, still valid JSON, the message silently changed. Lines split on the newline byte, the
   * cut-off start kept as bytes for the next (earlier) chunk; LINE_MAX is in bytes. Retention is applied on reads too.
   */
  private *backwards(instance: string): Generator<string> {
    const dir = this.ownDir(instance);
    if (!dir) return;
    this.pruneSoon(instance, dir);
    for (const f of this.months(dir)) {
      let fd: number;
      try { fd = openSync(join(dir, f), "r"); } catch { continue; }
      try {
        let pos = statSync(join(dir, f)).size, rest: Buffer = Buffer.alloc(0);
        while (pos > 0) {
          const size = Math.min(CHUNK, pos);
          pos -= size;
          const buf = Buffer.alloc(size);
          readSync(fd, buf, 0, size, pos);
          const data = rest.length ? Buffer.concat([buf, rest]) : buf;
          let end = data.length;
          for (let nl = data.lastIndexOf(10, end - 1); nl >= 0; nl = end > 0 ? data.lastIndexOf(10, end - 1) : -1) {
            const l = data.subarray(nl + 1, end);
            if (l.length && l.length <= LINE_MAX) yield l.toString("utf8");
            end = nl;
          }
          // The start of a line that began in an earlier chunk: kept as bytes (a line longer than LINE_MAX is not ours).
          rest = end > LINE_MAX ? Buffer.alloc(0) : Buffer.from(data.subarray(0, end));
        }
        if (rest.length) yield rest.toString("utf8");
      } finally { closeSync(fd); }
    }
  }
  private static keyOf(line: string): string | null {
    const m = /^\{"key":"([0-9a-f]{1,32}-\d{1,15})"/.exec(line);
    return m ? m[1]! : null;
  }
  private static parse(line: string): ArchivedLine | null {
    try { const v = JSON.parse(line); return v && typeof v === "object" && typeof v.key === "string" ? v as ArchivedLine : null; } catch { return null; }
  }

  /**
   * Up to `limit` archived lines older than `before` (a key in the archive), oldest first — or the newest `limit` when
   * `before` is null (the page has reached the top of what the window holds). `more`: older ones remain. `found`: false
   * when `before` was given and is not in the archive (nothing returned).
   */
  older(instance: string, before: string | null, limit: number): { lines: ArchivedLine[]; more: boolean; found: boolean } {
    const out: ArchivedLine[] = [];
    let seen = before === null, more = false;
    for (const line of this.backwards(instance)) {
      if (!seen) { if (WebChatArchive.keyOf(line) === before) seen = true; continue; }
      if (out.length >= limit) { more = true; break; }
      const v = WebChatArchive.parse(line);
      if (v) out.push(v);
    }
    return { lines: out.reverse(), more, found: seen };
  }
  /**
   * The archived line `key` with up to `before` lines older than it and up to `after` newer ones (newer ones only from
   * the archive: the caller adds the window's when the archive runs out), oldest first. Null: not in the archive.
   */
  around(instance: string, key: string, before: number, after: number): { lines: ArchivedLine[]; olderMore: boolean; newerMore: boolean } | null {
    const newer: ArchivedLine[] = [];          // newest first, the last `after` before the key
    let hit: ArchivedLine | null = null;
    const older: ArchivedLine[] = [];
    let olderMore = false, newerSeen = 0;
    for (const line of this.backwards(instance)) {
      if (!hit) {
        if (WebChatArchive.keyOf(line) === key) { hit = WebChatArchive.parse(line); if (!hit) return null; continue; }
        newerSeen++;
        const v = WebChatArchive.parse(line);
        if (v) { newer.push(v); if (newer.length > after) newer.shift(); }
        continue;
      }
      if (older.length >= before) { olderMore = true; break; }
      const v = WebChatArchive.parse(line);
      if (v) older.push(v);
    }
    if (!hit) return null;
    return { lines: [...older.reverse(), hit, ...newer.reverse()], olderMore, newerMore: newerSeen > after };
  }
}
