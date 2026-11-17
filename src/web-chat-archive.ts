/**
 * M-3272 (the user, 2026-11-17: web chat scroll-back): the messages that leave an agent's 500-message web chat window
 * (WebChatHistory.record's eviction) are appended here instead of being dropped, so the page can scroll back past them.
 *
 *   <home>/workspaces/<instance>/web-chat-archive/
 *     owner                  who the agent is (as web-chat.json's `owner`): another agent that only shares the name
 *                            never reads this archive; its first write moves it aside (never deletes it)
 *     2026-11.jsonl          one JSON object per line, oldest first — append-only, one file per month (of eviction)
 *     files/2026-11/<ms>-<id>  M-3281: a file an archived message showed, kept with it (below)
 *
 * A line is `{"key":"<boot>-<id>",…}`: the key first, so a scan finds a message without parsing every line. What is kept
 * is what web-chat.json keeps of a message (WebChatHistory.stored), plus its buttons as they last were, closed for good
 * (an archived reply's buttons and polls are read-only), and its files (M-3281, the user 2026-11-17: an archived message
 * keeps its files and pictures): each one the message still served is hard-linked (a copy across devices) into `files/`
 * as the message leaves the window — before the window lets go of it (a reply's snapshot is deleted then, an inbox file
 * after 7 days) — under a new id of its own, which the line names (`{id, file: "<month>/<ms>-<id>", …}`); one that could
 * not be kept is named only (`gone`), as before. Writes are queued per instance (one append in flight, order kept).
 * Retention (`web.chat_archive.retention_days`, unset or 0: keep everything) drops whole months that ended before it —
 * their kept files too. The kept files of every agent's archive together stay within `web.chat_archive.files_max_gb`
 * (GiB, default 5; 0 keeps none): past it the oldest go first, and their messages show the file as no longer kept.
 * Reads go backwards through the files in fixed-size chunks: a page costs what it reads, never the whole archive.
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeInstanceDirName } from "./web-chat-store.js";

export const ARCHIVE_DIR = "web-chat-archive";
const OWNER_FILE = "owner";
const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/;
/** M-3281: where an archive keeps its messages' files, one directory per month (of eviction), as its lines are. */
export const KEPT_DIR = "files";
const MONTH_DIR = /^(\d{4})-(\d{2})$/;
const KEPT_NAME = /^\d{13}-[0-9a-f]{32}$/;
/** M-3281: what an archive line names a kept file by — `<month>/<ms>-<id>`, nothing else (never a path of its own). */
export const KEPT_FILE = /^\d{4}-\d{2}\/\d{13}-[0-9a-f]{32}$/;
/** M-3281: `web.chat_archive.files_max_gb` when fleet.yaml leaves it out — GiB, for every agent's archive together. */
export const ARCHIVE_FILES_MAX_GB = 5;
const GIB = 1024 ** 3;
const monthOf = (ms: number): string => { const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
/** The first moment of the month after `<yyyy>-<mm>`. */
const monthEnd = (y: string, m: string): number => Date.UTC(Number(y), Number(m), 1);
const CHUNK = 64 * 1024;
/** A line longer than this is not one of ours (a message is at most 16,000 characters): skipped. */
const LINE_MAX = 1024 * 1024;

export interface ArchivedLine { key: string; [field: string]: unknown }
export interface ArchiveLogger { warn(obj: unknown, msg?: string): void; debug?(obj: unknown, msg?: string): void }

export class WebChatArchive {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly prunedAt = new Map<string, number>();
  /** M-3281: the bytes every archive's kept files take, once counted (null: not yet); kept current as files come and go. */
  private filesTotal: number | null = null;

  constructor(private readonly opts: {
    home: string;
    /** Who the instance is now (WebChatDiskStore's ownerOf); null: not configured — nothing archived, nothing read. */
    ownerOf: (instance: string) => string | null;
    /** `web.chat_archive.retention_days` as in force: unset or 0 keeps everything. */
    retentionDays?: () => number | undefined;
    /** M-3281: `web.chat_archive.files_max_gb` as in force (GiB, all archives together): unset is ARCHIVE_FILES_MAX_GB, 0 keeps none. */
    filesMaxGb?: () => number | undefined;
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
    const prev = this.queues.get(instance) ?? Promise.resolve(), month = monthOf(this.now());
    const next = prev.then(() => this.write(instance, lines, month)).catch(err => this.opts.logger.warn({ err: (err as Error)?.message, instance }, "Web chat archive: lines could not be written"));
    this.queues.set(instance, next);
    void next.finally(() => { if (this.queues.get(instance) === next) this.queues.delete(instance); });
  }
  private async write(instance: string, lines: ArchivedLine[], month: string): Promise<void> {
    const dir = this.claimDir(instance);
    if (!dir) return;
    await appendFile(join(dir, `${month}.jsonl`), lines.map(l => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
    this.pruneSoon(instance, dir);
  }
  /**
   * This instance's archive directory, made this instance's when it is not yet: created with its owner file, or — another
   * agent's archive under this name (it was removed while the fleet was down) — that one set aside, never mixed in.
   * Null: not configured, or the other one could not be set aside.
   */
  private claimDir(instance: string): string | null {
    const dir = this.dirOf(instance), owner = this.opts.ownerOf(instance);
    if (!dir || !owner) return null;
    if (existsSync(dir)) {
      let was: string | null = null;
      try { was = readFileSync(join(dir, OWNER_FILE), "utf8"); } catch { was = null; }
      if (was === owner) return dir;
      const aside = `${dir}.${Math.floor(this.now() / 1000)}.old`;
      try { renameSync(dir, aside); this.opts.logger.warn({ instance, aside }, "Web chat archive: another agent's archive under this name was set aside"); this.filesTotal = null; }
      catch (err) { this.opts.logger.warn({ err: (err as Error)?.message, instance }, "Web chat archive: another agent's archive could not be set aside; not appending"); return null; }
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, OWNER_FILE), owner, { mode: 0o600 });
    return dir;
  }

  /** M-3281: the cap on every archive's kept files together, in bytes (0: none are kept). */
  private filesCap(): number {
    const gb = this.opts.filesMaxGb?.();
    return typeof gb === "number" && Number.isFinite(gb) && gb >= 0 ? Math.floor(gb * GIB) : ARCHIVE_FILES_MAX_GB * GIB;
  }
  /** M-3281: the directory an instance's kept files are in, when the archive is this instance's (null otherwise). */
  keptDirOf(instance: string): string | null {
    const dir = this.ownDir(instance);
    return dir ? join(dir, KEPT_DIR) : null;
  }
  /**
   * M-3281: keep a file an archived message shows — synchronously, while the window still holds it. `copy(dest)` puts it
   * at `dest` (the file ledger's hard link, or a copy) and says whether it did. Returns the new id and what the line names
   * the file by; null when it is not kept (no files kept at all, the archive not this instance's, or the copy failed).
   */
  keepFile(instance: string, copy: (dest: string) => boolean): { id: string; file: string } | null {
    const cap = this.filesCap();
    if (cap <= 0) return null;
    const dir = this.claimDir(instance);
    if (!dir) return null;
    const now = this.now(), month = monthOf(now), id = randomBytes(16).toString("hex"), name = `${String(Math.max(0, Math.floor(now))).padStart(13, "0").slice(-13)}-${id}`;
    const dest = join(dir, KEPT_DIR, month, name);
    try {
      mkdirSync(join(dir, KEPT_DIR, month), { recursive: true, mode: 0o700 });
      if (!copy(dest)) { try { unlinkSync(dest); } catch { /* not made */ } return null; }
      const size = lstatSync(dest).size;
      if (this.filesTotal !== null) this.filesTotal += size;
    } catch (err) {
      this.opts.logger.warn({ err: (err as Error)?.message, instance }, "Web chat archive: a file could not be kept with its message");
      try { unlinkSync(dest); } catch { /* not made */ }
      return null;
    }
    this.enforceFilesCap();
    return { id, file: `${month}/${name}` };
  }
  /**
   * M-3281: every archive's kept files, oldest first — `{ path, size, rel }` (`rel`: `<instance>/<month>/<name>`, which
   * sorts by month, then by when each was kept). Only what this archive writes: month directories and kept names, never
   * a link (a symlinked archive or files directory is not walked).
   */
  private keptFiles(): Array<{ path: string; size: number; month: string; dir: string }> {
    const out: Array<{ path: string; size: number; month: string; dir: string; order: string }> = [];
    const root = join(this.opts.home, "workspaces");
    let names: string[];
    try { names = readdirSync(root); } catch { return []; }
    for (const instance of names) {
      if (!isSafeInstanceDirName(instance)) continue;
      const kept = join(root, instance, ARCHIVE_DIR, KEPT_DIR);
      try { if (!lstatSync(join(root, instance, ARCHIVE_DIR)).isDirectory() || !lstatSync(kept).isDirectory()) continue; } catch { continue; }
      let months: string[];
      try { months = readdirSync(kept).filter(m => MONTH_DIR.test(m)); } catch { continue; }
      for (const month of months) {
        const dir = join(kept, month);
        let files: string[];
        try { if (!lstatSync(dir).isDirectory()) continue; files = readdirSync(dir).filter(f => KEPT_NAME.test(f)); } catch { continue; }
        for (const f of files) {
          try { const st = lstatSync(join(dir, f)); if (st.isFile()) out.push({ path: join(dir, f), size: st.size, month, dir, order: `${month}/${f}` }); } catch { /* gone */ }
        }
      }
    }
    return out.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0)).map(({ order: _o, ...f }) => f);
  }
  /**
   * M-3281: past `web.chat_archive.files_max_gb`, remove kept files, the oldest first (of every agent's archive), until
   * they fit; their messages then show the file as no longer kept. Counts them the first time (the fleet's start, or the
   * first file kept), then keeps the count as it goes. Returns how many were removed.
   */
  enforceFilesCap(): number {
    const cap = this.filesCap();
    if (this.filesTotal !== null && this.filesTotal <= cap) return 0;
    const files = this.keptFiles();
    let total = files.reduce((n, f) => n + f.size, 0), removed = 0;
    const emptied = new Set<string>();
    for (const f of files) {
      if (total <= cap) break;
      try { unlinkSync(f.path); total -= f.size; removed++; emptied.add(f.dir); }
      catch (err) { this.opts.logger.warn({ err: (err as Error)?.message }, "Web chat archive: a kept file past the size limit could not be removed"); }
    }
    for (const d of emptied) try { if (!readdirSync(d).length) rmSync(d, { recursive: true, force: true }); } catch { /* still in use */ }
    this.filesTotal = total;
    if (removed) this.opts.logger.debug?.({ removed, cap }, "Web chat archive: the oldest kept files removed to stay within files_max_gb");
    return removed;
  }
  /** At most once an hour per instance: drop the months that ended before the retention cut-off (and, M-3281, re-check the files' cap — it may have been lowered). */
  private pruneSoon(instance: string, dir: string): void {
    const now = this.now();
    if (now - (this.prunedAt.get(instance) ?? -Infinity) < 3_600_000) return;
    this.prunedAt.set(instance, now);
    this.prune(instance, dir);
    this.enforceFilesCap();
  }
  /**
   * Drop whole months that ended before `retention_days` ago (unset or 0: nothing) — M-3281: their kept files too.
   * Returns the month files removed.
   */
  prune(instance: string, dir = this.ownDir(instance)): string[] {
    const days = this.opts.retentionDays?.();
    if (!dir || !days || !(days > 0)) return [];
    const cutoff = this.now() - days * 86_400_000, removed: string[] = [];
    for (const f of this.months(dir)) {
      const m = MONTH_FILE.exec(f)!;
      if (monthEnd(m[1]!, m[2]!) > cutoff) continue;
      try { rmSync(join(dir, f), { force: true }); removed.push(f); } catch (err) { this.opts.logger.warn({ err: (err as Error)?.message, instance, file: f }, "Web chat archive: a month past retention could not be removed"); }
    }
    let kept: string[] = [];
    try { if (lstatSync(join(dir, KEPT_DIR)).isDirectory()) kept = readdirSync(join(dir, KEPT_DIR)).filter(d => MONTH_DIR.test(d)); } catch { kept = []; }
    for (const d of kept) {
      const m = MONTH_DIR.exec(d)!;
      if (monthEnd(m[1]!, m[2]!) > cutoff) continue;
      try { rmSync(join(dir, KEPT_DIR, d), { recursive: true, force: true }); this.filesTotal = null; }
      catch (err) { this.opts.logger.warn({ err: (err as Error)?.message, instance, month: d }, "Web chat archive: a month's kept files past retention could not be removed"); }
    }
    return removed;
  }
  /** Every append queued so far, written (tests; shutdown). */
  async flush(): Promise<void> { await Promise.all([...this.queues.values()]); }
  /** The agent was removed: its archive goes with it (after any append under way). */
  async forget(instance: string): Promise<void> {
    await (this.queues.get(instance) ?? Promise.resolve());
    const dir = this.dirOf(instance);
    if (dir) { rmSync(dir, { recursive: true, force: true }); this.filesTotal = null; }   // M-3281: its kept files with it
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
