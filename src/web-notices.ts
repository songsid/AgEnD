/**
 * #2910 D2: a web-only fleet's Notices — what General would have said. A fleet with no Discord or Telegram connection
 * has no General to post fleet errors, an agent's crash or quota notice, a sign-in, a schedule that could not run or an
 * available update in; they used to be dropped with a log line. They are kept here instead (the newest NOTICES_MAX,
 * `web-notices.json` beside the fleet, 0600, written atomically), pushed to the dashboard as they come, and listed on
 * its Notices page. Which ones the person has read is one mark: the newest id they have seen.
 * A fleet with a chat connection never writes here (FleetManager.recordWebNotice): its General still says them.
 */
import { readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";

export const WEB_NOTICES_FILE = "web-notices.json";
/** Kept: the newest this many (the oldest go first). */
export const NOTICES_MAX = 500;
/** A notice's text is cut to this many characters (a fleet error can carry a long message). */
export const NOTICE_TEXT_MAX = 4000;

/** Where a notice came from — the page labels it, nothing else depends on it. */
export type NoticeKind = "fleet" | "instance" | "update" | "schedule" | "summary";
const KINDS: readonly string[] = ["fleet", "instance", "update", "schedule", "summary"];

export interface WebNotice {
  /** Increasing, never reused (the next one survives a restart). */
  readonly id: number;
  /** Wall clock, ms. */
  readonly at: number;
  readonly kind: NoticeKind;
  /** The agent it is about, when it is about one (its topic would have been where it was said). */
  readonly instance?: string;
  readonly text: string;
}

export interface WebNoticesView {
  /** Newest first. */
  items: WebNotice[];
  /** The newest id the person has seen (0: none). */
  seen: number;
  unread: number;
}

function valid(v: unknown): v is WebNotice {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return Number.isSafeInteger(n.id) && (n.id as number) > 0 && Number.isSafeInteger(n.at) && (n.at as number) > 0
    && typeof n.kind === "string" && KINDS.includes(n.kind) && typeof n.text === "string"
    && (n.instance === undefined || (typeof n.instance === "string" && n.instance.length > 0));
}

export class WebNotices {
  private items: WebNotice[] = [];       // oldest first
  private next = 1;
  private seen = 0;
  private warned = false;

  constructor(private readonly path: string, private readonly log: { warn(obj: object, msg?: string): void },
    private readonly now: () => number = Date.now) {
    let raw: string;
    try { raw = readFileSync(path, "utf8"); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn({ path }, "Web notices unreadable — starting with none");
      return;
    }
    try {
      const v = JSON.parse(raw) as { v?: unknown; next?: unknown; seen?: unknown; items?: unknown };
      if (v.v !== 1 || !Array.isArray(v.items)) throw new Error("shape");
      // Increasing ids only (a hand-edited file cannot reorder or repeat them), the newest NOTICES_MAX.
      let last = 0;
      for (const n of v.items) if (valid(n) && n.id > last) { this.items.push(Object.freeze({ ...n, text: n.text.slice(0, NOTICE_TEXT_MAX) })); last = n.id; }
      this.items = this.items.slice(-NOTICES_MAX);
      this.next = Math.max(last + 1, Number.isSafeInteger(v.next) ? v.next as number : 1);
      this.seen = Number.isSafeInteger(v.seen) && (v.seen as number) >= 0 ? Math.min(v.seen as number, this.next - 1) : 0;
    } catch {
      log.warn({ path }, "Web notices unreadable — starting with none");
      this.items = []; this.next = 1; this.seen = 0;
    }
  }

  /** Keep one notice; the oldest beyond NOTICES_MAX goes. Returns it (kept in memory even when the file cannot be written). */
  add(input: { kind: NoticeKind; text: string; instance?: string }): WebNotice {
    const notice: WebNotice = Object.freeze({ id: this.next++, at: this.now(), kind: input.kind, text: input.text.slice(0, NOTICE_TEXT_MAX),
      ...(input.instance ? { instance: input.instance } : {}) });
    this.items.push(notice);
    if (this.items.length > NOTICES_MAX) this.items.splice(0, this.items.length - NOTICES_MAX);
    this.flush();
    return notice;
  }

  /** The newest notice of a kind, if one is kept (e.g. not to repeat the same update notice every day). */
  latest(kind: NoticeKind): WebNotice | null {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i]!.kind === kind) return this.items[i]!;
    return null;
  }

  /** Everything up to `id` has been seen (never moves back, never past the newest). */
  markSeen(id: number): number {
    const newest = this.items.at(-1)?.id ?? 0;
    const to = Math.min(Math.max(0, Math.floor(id)), newest);
    if (to > this.seen) { this.seen = to; this.flush(); }
    return this.seen;
  }

  /** The newest id kept (0: none). */
  newest(): number { return this.items.at(-1)?.id ?? 0; }

  unread(): number {
    let n = 0;
    for (let i = this.items.length - 1; i >= 0 && this.items[i]!.id > this.seen; i--) n++;
    return n;
  }

  view(): WebNoticesView {
    return { items: [...this.items].reverse(), seen: this.seen, unread: this.unread() };
  }

  private flush(): void {
    try {
      atomicWriteFileSync(this.path, JSON.stringify({ v: 1, next: this.next, seen: this.seen, items: this.items }) + "\n", { mode: 0o600 });
      this.warned = false;
    } catch (err) {
      if (!this.warned) this.log.warn({ err: (err as Error).message, path: this.path }, "Web notices could not be saved; a restart forgets the newest");
      this.warned = true;
    }
  }
}
