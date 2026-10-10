/**
 * #1565: the web chat's history on the local disk, so it survives a fleet restart — the latest messages per instance
 * (the same bounds as in memory: 500 messages, about 1 MB of text), one file per instance:
 * `<AGEND_HOME>/workspaces/<instance>/web-chat.json`, mode 0600, next to the instance's other files.
 *
 * Writes never block the fleet loop: they are debounced per instance, one in flight at a time, and go through
 * fs.promises — a temporary file, fsync, then rename, so a crash leaves either the old file or the new one, never half
 * of one. Reading happens once, at fleet start, for the instances that are configured; a file that is too large, not
 * JSON, or not ours in shape is skipped with one log line and never stops the fleet.
 */
import { closeSync, existsSync, openSync, readFileSync, fstatSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import type { StoredWebChatMessage } from "./web-chat-history.js";

export const WEB_CHAT_FILE = "web-chat.json";
/** A file larger than this is not read (the bounds keep a real one far smaller). */
export const WEB_CHAT_FILE_MAX_BYTES = 8 * 1024 * 1024;
const FORMAT = 1;

export interface WebChatStoreLogger { warn(obj: unknown, msg?: string): void; debug?(obj: unknown, msg?: string): void }

/** The rule instance paths are held to: no separator, no control character, no traversal. */
export function isSafeInstanceDirName(name: string): boolean {
  return typeof name === "string" && name.length > 0 && name.length <= 128 && !/[/\\\u0000-\u001f\u007f]/.test(name) && name !== "." && !name.includes("..");
}

export class WebChatDiskStore {
  private readonly home: string;
  private readonly logger: WebChatStoreLogger;
  private readonly debounceMs: number;
  /**
   * Who the instance is now: a fleet agent's working directory, a ClassicBot room's channel. Written with the file
   * and required to match when it is read, so a later instance that only shares the name (deleted while the fleet was
   * down, then created again elsewhere) never gets another one's history. Null: not configured — not written.
   */
  private readonly ownerOf: (instance: string) => string | null;
  /** instance → its pending write (a timer) and whether one is in flight. */
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout> | null; writing: Promise<void> | null; again: boolean; snapshot: () => StoredWebChatMessage[] }>();
  /** Instances forgotten: a write already under way must not bring the file back. */
  private readonly gone = new Set<string>();

  constructor(opts: { home: string; logger: WebChatStoreLogger; debounceMs?: number; ownerOf: (instance: string) => string | null }) {
    this.home = opts.home;
    this.ownerOf = opts.ownerOf;
    this.logger = opts.logger;
    this.debounceMs = opts.debounceMs ?? 300;
  }

  pathOf(instance: string): string | null {
    return isSafeInstanceDirName(instance) ? join(this.home, "workspaces", instance, WEB_CHAT_FILE) : null;
  }

  /**
   * The stored messages of one instance, as written (validated later by the history), or null: no file, or one that
   * is skipped (too large, unreadable, not JSON, not ours, another instance's) — said once in the log.
   */
  load(instance: string): unknown[] | null {
    const path = this.pathOf(instance);
    if (!path || !existsSync(path)) return null;
    let text: string;
    try {
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > WEB_CHAT_FILE_MAX_BYTES) {
          this.logger.warn({ instance, path, size: st.size }, "web chat history: file skipped (not a file, or too large)");
          return null;
        }
        text = readFileSync(fd, "utf-8");
      } finally { closeSync(fd); }
    } catch (err) {
      this.logger.warn({ instance, path, err: (err as Error).message }, "web chat history: file skipped (unreadable)");
      return null;
    }
    let data: unknown;
    try { data = JSON.parse(text); } catch {
      this.logger.warn({ instance, path }, "web chat history: file skipped (not JSON)");
      return null;
    }
    const d = data as { format?: unknown; instance?: unknown; owner?: unknown; messages?: unknown };
    if (!d || typeof d !== "object" || d.format !== FORMAT || d.instance !== instance || !Array.isArray(d.messages)) {
      this.logger.warn({ instance, path }, "web chat history: file skipped (not this instance's web chat history)");
      return null;
    }
    const owner = this.ownerOf(instance);
    if (owner === null || d.owner !== owner) {
      this.logger.warn({ instance, path }, "web chat history: file skipped (written for another instance of this name)");
      return null;
    }
    return d.messages;
  }

  /** The instance's history changed: write it soon (debounced; one write in flight; the latest snapshot wins). */
  schedule(instance: string, snapshot: () => StoredWebChatMessage[]): void {
    if (!this.pathOf(instance)) return;
    this.gone.delete(instance);
    let p = this.pending.get(instance);
    if (!p) { p = { timer: null, writing: null, again: false, snapshot }; this.pending.set(instance, p); }
    p.snapshot = snapshot;
    if (p.writing) { p.again = true; return; }
    if (p.timer) return;
    p.timer = setTimeout(() => { p!.timer = null; this.write(instance); }, this.debounceMs);
    p.timer.unref?.();
  }

  private write(instance: string): void {
    const p = this.pending.get(instance);
    if (!p || this.gone.has(instance)) return;
    const messages = p.snapshot();
    p.writing = this.writeFile(instance, messages).catch((err) => {
      this.logger.warn({ instance, err: (err as Error).message }, "web chat history: could not be written");
    }).finally(() => {
      p.writing = null;
      if (p.again && !this.gone.has(instance)) { p.again = false; this.write(instance); }
      else if (!p.timer) this.pending.delete(instance);
    });
  }

  private async writeFile(instance: string, messages: StoredWebChatMessage[]): Promise<void> {
    const path = this.pathOf(instance)!;
    const owner = this.ownerOf(instance);
    if (owner === null) return;                       // not a configured instance: nothing to keep it for
    const dir = join(this.home, "workspaces", instance);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}`;
    const body = JSON.stringify({ format: FORMAT, instance, owner, messages });
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await fh.writeFile(body, "utf-8");
      await fh.sync();
    } finally { await fh.close(); }
    if (this.gone.has(instance)) { await unlink(tmp).catch(() => {}); return; }
    await rename(tmp, path);
  }

  /** Every pending write done (tests; a clean shutdown). */
  async flush(): Promise<void> {
    for (;;) {
      const busy = [...this.pending.entries()];
      if (!busy.length) return;
      for (const [instance, p] of busy) {
        if (p.timer) { clearTimeout(p.timer); p.timer = null; this.write(instance); }
      }
      await Promise.all([...this.pending.values()].map((p) => p.writing ?? Promise.resolve()));
      if ([...this.pending.values()].every((p) => !p.writing && !p.timer && !p.again)) { this.pending.clear(); return; }
    }
  }

  /** The instance is gone: no further write, and the file (and any temporary one of ours) is deleted. */
  async remove(instance: string): Promise<void> {
    const path = this.pathOf(instance);
    if (!path) return;
    this.gone.add(instance);
    const p = this.pending.get(instance);
    if (p?.timer) { clearTimeout(p.timer); p.timer = null; }
    if (p?.writing) await p.writing;
    this.pending.delete(instance);
    await unlink(path).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") this.logger.warn({ instance, err: err.message }, "web chat history: could not be deleted"); });
    await unlink(`${path}.tmp-${process.pid}`).catch(() => {});
  }
}
