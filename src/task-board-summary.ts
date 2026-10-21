/**
 * #2246 step 3: the task board's daily summary for the person, as taskhall sends it. Once a day at
 * `defaults.task_board.summary_at` (the fleet's zone): what waits for their confirmation and what is blocked now, what
 * got done and what was opened since the last summary, and each project's progress. Each chat world's General gets the
 * cards of its own instances (a card nobody in a world holds goes to the primary one); the web chat's Generals too.
 *
 * The clock is taskhall's: it looks every minute, sends at most once a calendar day, and a summary missed while the
 * fleet was down goes out when it is back that day, covering the time since the last one (at most a week). A quiet day
 * (nothing waits, nothing moved) sends nothing. The first summary after this ships waits for the next morning.
 */
import { atomicWriteFileSync } from "./atomic-write.js";
import { readFileSync } from "node:fs";
import type { Card, Project, ProjectStats } from "./scheduler/task-board.js";

/** Cards listed per section; the rest are counted. */
export const SUMMARY_LISTED = 10;
const WEEK_MS = 7 * 86_400_000;

export const DEFAULT_SUMMARY_AT = "09:00";

/**
 * `defaults.task_board.summary_at`: `"HH:MM"` (24 h) → itself, `"off"` (any case) → null, not set → the default;
 * anything else → undefined (the validator refuses it; the clock then sends nothing).
 */
export function summaryTime(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return DEFAULT_SUMMARY_AT;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "off") return null;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined;
}

/** The wall clock at `now` in `zone` ("YYYY-MM-DD", "HH:MM"); a zone the runtime does not know reads as UTC. */
export function wallClock(now: Date, zone: string): { date: string; time: string } {
  let wall: string;
  try { wall = now.toLocaleString("sv-SE", { timeZone: zone, hour12: false }); } catch { wall = now.toLocaleString("sv-SE", { timeZone: "UTC", hour12: false }); }
  return { date: wall.slice(0, 10), time: wall.slice(11, 16) };
}

/** When the last summary went out: its local date and the end of the time it covered. */
export interface SummaryMark { date: string; until: string }

/** The mark on disk (`<dataDir>/task-board-summary.json`); a missing or unreadable file is no mark. */
export function summaryMarkFile(path: string): { read(): SummaryMark | null; write(mark: SummaryMark): void } {
  return {
    read() {
      try {
        const m = JSON.parse(readFileSync(path, "utf8")) as Partial<SummaryMark>;
        return typeof m.date === "string" && typeof m.until === "string" ? { date: m.date, until: m.until } : null;
      } catch { return null; }
    },
    write(mark) { atomicWriteFileSync(path, JSON.stringify(mark) + "\n"); },
  };
}

export interface SummaryClockDeps {
  /** `defaults.task_board.summary_at` as it is now ("HH:MM"), or null when off. Read at every look. */
  at(): string | null;
  zone(): string;
  now(): Date;
  mark: { read(): SummaryMark | null; write(mark: SummaryMark): void };
  /** Gather and post the summary of [since, until). */
  send(since: Date, until: Date): void;
  /** A look that threw (the data directory gone, a board that cannot be read): logged, and the next look tries again. */
  failed?(err: unknown): void;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

export class TaskBoardSummaryClock {
  private timer: unknown = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly deps: SummaryClockDeps) {}

  /** A look 5 s after start (a summary missed while the fleet was down), then every minute. */
  start(): void {
    if (this.timer) return;
    const every = this.deps.setInterval ?? ((fn: () => void, ms: number) => { const h = setInterval(fn, ms); h.unref?.(); return h; });
    const look = () => { try { this.tick(); } catch (err) { this.deps.failed?.(err); } };
    this.timer = every(look, 60_000);
    this.first = setTimeout(look, 5_000);
    this.first.unref?.();
  }

  stop(): void {
    if (this.timer) (this.deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)))(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = null;
    this.first = null;
  }

  /** One look: true when a summary was due today and is now handled (sent, or quiet). */
  tick(): boolean {
    const at = this.deps.at();
    if (!at) return false;
    const now = this.deps.now();
    const wall = wallClock(now, this.deps.zone());
    if (wall.time < at) return false;
    const last = this.deps.mark.read();
    if (last?.date === wall.date) return false;
    // Marked before it is sent: a send that throws does not repeat every minute.
    this.deps.mark.write({ date: wall.date, until: now.toISOString() });
    if (!last) return false;   // the first day: nothing to look back on yet; the next one covers from now
    const since = Math.min(Math.max(Date.parse(last.until) || 0, now.getTime() - WEEK_MS), now.getTime());
    this.deps.send(new Date(since), now);
    return true;
  }
}

// ── What a summary says ──────────────────────────────────

export interface ProjectLine { name: string; percent: number; done: number; total: number; waiting: number; blocked: number }
export interface BoardSummary {
  since: Date;
  until: Date;
  review: Card[];
  blocked: Card[];
  done: Card[];
  created: Card[];
  projects: ProjectLine[];
}

export interface SummaryRead {
  /** What waits for the person now (TaskBoard.waitingForPerson): review cards that need them, blocked cards. */
  waiting: Card[];
  done: Card[];
  created: Card[];
  /** Every live main task's project and assignee: a project's line goes to the chats whose instances hold one. */
  mains: Array<{ projectId: number | null; assignee: string | null }>;
}

/** Main tasks first, then by number. */
const byNumber = (a: Card, b: Card) => (a.kind === b.kind ? 0 : a.kind === "main" ? -1 : 1) || Number(a.code.slice(2)) - Number(b.code.slice(2));

/**
 * One chat's summary: the cards `inChat` keeps (by assignee), and the active projects one of its cards' main tasks is
 * in, with the project's numbers over all its cards (projectStats).
 */
export function buildSummary(
  read: SummaryRead, since: Date, until: Date,
  opts: { inChat(assignee: string | null): boolean; projects: Project[]; stats: Record<string, ProjectStats> },
): BoardSummary {
  const mine = (cards: Card[]) => cards.filter((c) => opts.inChat(c.assignee)).sort(byNumber);
  const here = new Set(read.mains.filter((m) => m.projectId !== null && opts.inChat(m.assignee)).map((m) => m.projectId));
  return {
    since, until,
    review: mine(read.waiting.filter((c) => c.status === "review")),
    blocked: mine(read.waiting.filter((c) => c.status === "blocked")),
    done: mine(read.done),
    created: mine(read.created),
    projects: opts.projects.filter((p) => !p.archived && here.has(p.id)).flatMap((p) => {
      const st = opts.stats[String(p.id)];
      return st && st.mains ? [{ name: p.name, percent: st.percent, done: st.units.done, total: st.units.total, waiting: st.waiting, blocked: st.blocked }] : [];
    }),
  };
}

/** Nothing waits and nothing moved: no summary that day. */
export function isQuiet(s: BoardSummary): boolean {
  return !s.review.length && !s.blocked.length && !s.done.length && !s.created.length;
}

type T = (key: string, ...args: (string | number)[]) => string;
const short = (s: string, n: number) => (Array.from(s).length > n ? Array.from(s).slice(0, n - 1).join("") + "…" : s);

/** `M/D HH:MM` in the fleet's zone. */
function shortTime(d: Date, zone: string): string {
  const { date, time } = wallClock(d, zone);
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} ${time}`;
}

/**
 * The summary as plain text in the fleet's language (no markup: Telegram, Discord and the web chat read it the same).
 * `projectOf`: a main task's project name.
 */
export function renderSummary(s: BoardSummary, opts: { zone: string; t: T; projectOf(card: Card): string | null }): string {
  const { t } = opts;
  const ref = (c: Card) => t("board_summary.card", c.code, short(c.title, 30))
    + (c.kind === "main" ? (opts.projectOf(c) ? ` · ${opts.projectOf(c)}` : "") : c.assignee ? ` @${c.assignee}` : "");
  const list = (cards: Card[], line: (c: Card) => string) => {
    const out = cards.slice(0, SUMMARY_LISTED).map((c) => `• ${line(c)}`);
    if (cards.length > SUMMARY_LISTED) out.push(`• ${t("board_summary.more", cards.length - SUMMARY_LISTED)}`);
    return out;
  };
  // Finished and new: a main task a line each, sub tasks folded into one line of numbers.
  const folded = (cards: Card[]) => {
    const mains = cards.filter((c) => c.kind === "main"), subs = cards.filter((c) => c.kind === "sub");
    const out = list(mains, ref);
    if (subs.length) {
      const codes = subs.slice(0, SUMMARY_LISTED).map((c) => c.code).join(t("board_summary.join"));
      out.push(`• ${t(subs.length > SUMMARY_LISTED ? "board_summary.subs_more" : "board_summary.subs", subs.length, codes)}`);
    }
    return out;
  };
  const blocks: string[] = [t("board_summary.title", shortTime(s.since, opts.zone), shortTime(s.until, opts.zone))];
  const section = (title: string, lines: string[]) => { if (lines.length) blocks.push([title, ...lines].join("\n")); };
  section(t("board_summary.review", s.review.length), list(s.review, ref));
  section(t("board_summary.blocked", s.blocked.length), list(s.blocked, (c) =>
    ref(c) + (c.kind === "main" && c.assignee ? ` @${c.assignee}` : "") + (c.blockedReason ? t("board_summary.reason", short(c.blockedReason, 60)) : "")));
  section(t("board_summary.done", s.done.length), folded(s.done));
  section(t("board_summary.created", s.created.length), folded(s.created));
  section(t("board_summary.projects"), s.projects.map((p) => {
    const extra = [p.waiting ? t("board_summary.project_waiting", p.waiting) : "", p.blocked ? t("board_summary.project_blocked", p.blocked) : ""].filter(Boolean);
    return `• ${t("board_summary.project", p.name, p.percent, p.done, p.total)}${extra.length ? t("board_summary.project_extra", extra.join(t("board_summary.join"))) : ""}`;
  }));
  blocks.push(t("board_summary.footer"));
  return blocks.join("\n\n");
}
