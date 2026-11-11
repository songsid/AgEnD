/**
 * #1218 phase 1: the Log tab's server side — on demand only (the user's decision on load, 2026-10-13). Off by default
 * (`web.log_tab`); off, it answers `{ enabled: false }` and does no work at all. On:
 *
 * - **Nothing runs in the background.** No collector, no step log on disk: each GET /ui/steps reads a bounded range of
 *   the instance's own transcript (async, ≤ 8 MiB back or ≤ 4 MiB forward) and parses it with the backend's parser
 *   (log-steps.ts). Step ids depend on the bytes, not on the range, so the page merges ranges.
 * - **Live only under a watch.** A request with `watch` holds a lease (WATCH_LEASE_MS, renewed by every request); while
 *   one is held the fleet looks at the transcript's size every WATCH_POLL_MS and, when it moved, broadcasts a tiny
 *   `steps_tick { instance }` — the page then fetches `after=` its cursor. No lease: no timer, no read.
 * - **Fleet events** (crash, restart, hang, a prompt waiting, a pause) come from the existing event log, by id.
 *
 * Nothing here runs in the daemon, and nothing reads a CLI's file on a tool call.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { ClaudeStepParser, CodexStepParser, bounded, chatStep, readTailRecords, type LogStep } from "./log-steps.js";
import type { ToolProgressLevel } from "./tool-progress.js";
import { AntigravityStepParser, GrokStepParser } from "./log-steps-agy-grok.js";
import type { LogFormat } from "./log-transcript-paths.js";
export type { LogFormat };
import { SCREEN_MAX_BYTES } from "./dialog-screen-text.js";
import { LOOKS_PER_POLL, isClaudeAssistantHead, readNewLines, readWholeLine, type LongLine } from "./transcript-jsonl.js";

/**
 * AGEND-197: whether thinking is switched on — `web.log_thinking` is exactly `true` (OFF by default: unset, false and junk
 * are all off). The one test every use shares: the service's thinking steps, and AgEnD's asking Claude Code for thinking
 * summaries at launch (which writes `showThinkingSummaries` into Claude's settings — never while this is off).
 */
export const thinkingOn = (web: { log_thinking?: unknown } | null | undefined): boolean => web?.log_thinking === true;

export const LOG_STEPS_LIMIT = 200;
export const LOG_OLDER_LIMIT = 100;
export const LOG_RESPONSE_MAX_BYTES = 512 * 1024;
export const WATCH_LEASE_MS = 45_000;
export const WATCH_POLL_MS = 2_000;
export const LOG_EVENTS_LIMIT = 50;

/** Where an instance's steps come from, as the fleet resolves it (only when the Log asks). */
export interface LogSource {
  backend: string;
  /** The transcript to read, or null: none known now. */
  path: string | null;
  /** The parser for it: claude / codex / antigravity / grok (kiro: its own reader, later in phase 1); null: this backend has none. */
  format: LogFormat | null;
  /** Why there is nothing to read: "not_running" (its transcript is found while it runs), "no_transcript", "unsupported". */
  reason?: string;
}

export interface LogEventRow { id: number; event_type: string; payload: unknown; created_at: string }

export interface LogServiceDeps {
  enabled(): boolean;
  /** AGEND-181: `web.log_thinking` (default OFF, AGEND-197): only `true` lets a request have thinking, whatever the route says. */
  thinking?(): boolean;
  /**
   * AGEND-197: an instance's own `tool_progress` (its setting, else the fleet default, else off) — what the chat's activity
   * block is gated by, instead of `web.log_tab`. Not given: the chat's block is never offered.
   */
  toolProgress?(name: string): ToolProgressLevel;
  /** AGEND-181: an instance's working directory — the page shows paths under it relative (display only). */
  cwd?(name: string): string | undefined;
  /** An instance the Log may show (a fleet instance or a ClassicBot room). */
  known(name: string): boolean;
  source(name: string): LogSource;
  /** The instance's newest event-log rows (newest first), at most `limit`. */
  events(name: string, limit: number): LogEventRow[];
  /** Broadcast to the web stream. */
  emit(event: string, data: unknown): void;
  now?(): number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

export interface LogQuery {
  /**
   * AGEND-197: this is the chat's activity block asking (not the Log tab), and this viewer may have it. Set by the route
   * only for an admin session on the local dashboard. It is gated by the instance's `tool_progress` — not `web.log_tab` —
   * and the steps are cut to that level (chatStep): `off` answers no steps and reads nothing.
   */
  chat?: boolean;
  after?: number; before?: number; key?: string; skip?: boolean; limit?: number; watch?: boolean; ev?: number;
  /**
   * AGEND-181: the thinking steps are wanted AND this viewer may have them. Set by the route only for an admin session
   * on the local dashboard, and only with `web.log_thinking` on (off by default); absent: the parser does not make them,
   * so they are never in an answer for anyone else (filtered here on the server, not hidden by the page).
   */
  thinking?: boolean }

/** A fleet event as the page shows it: its type (the page words it) and its details, masked. */
export interface LogEvent { id: number; ts: number; type: string; detail?: string;
  /** M-2269: the dialog or prompt as it was on screen (dialog_parked, interactive_prompt), masked; shown folded. */
  screen?: string }

/** The event types a Log shows: what changed for the instance itself, not bookkeeping (tips, cost snapshots). */
export const LOG_EVENT_TYPES: ReadonlySet<string> = new Set([
  "working_state", "kiro_reconcile",
  "crash_respawn", "crash_loop", "hang_detected", "hang_action", "instance_paused", "instance_resumed",
  "interactive_prompt", "interactive_prompt_assist", "dialog_parked", "model_failover", "model_recovered",
  "mcp_died", "mcp_recovered", "mcp_auto_restart", "message_failed", "messages_cancelled", "pty_error", "pty_recovered",
  "backend_unreachable", "startup_backend_unreachable", "backend_launch_warning", "clear_action", "normal_exit_action",
  "reply_drop_detected", "reply_drop_recovered", "reply_drop_unrecovered", "supervision_ended", "tmux_server_crash",
  "malformed_tool_call", "health_check_error", "context_lost", "remote_card", "remote_card_answer",
]);

export type LogAnswer =
  | { enabled: false }
  | {
    enabled: true; instance: string; backend: string; supported: boolean; reason?: string;
    /** AGEND-181: whether this answer may hold `thinking` steps (the request asked and was allowed). */
    thinking: boolean;
    /** AGEND-197: for the chat's block, the level its steps were cut to (`off`: none were read). Absent: the Log's answer. */
    level?: ToolProgressLevel;
    /** AGEND-181: where paths are shortened from — the instance's working directory and the server's home (display only).
     *  Present only for the chat's block and a thinking answer (an admin session on the local dashboard): they name the OS user. */
    cwd?: string; home?: string;
    /** The transcript's identity (device-inode): a cursor of another one is reset. */
    key?: string;
    steps: LogStep[]; events: LogEvent[];
    /** Offset to ask `before=` for older steps; null: nothing older. */
    before: number | null;
    /** Offset to ask `after=` for newer steps (with `skip` when it is inside a long record). */
    after: number | null; skip?: boolean;
    /** More is already waiting after `after`. */
    more?: boolean;
    /** The page's cursor was for another transcript (a new session) or past its end: start again from this answer. */
    reset?: boolean;
    /** The newest event id this answer saw (for `ev=`). */
    ev: number;
  };

/** LogService.readBack's answer: the steps before `end`, or why there are none (`reason`, no `steps`). */
export type ReadBack =
  | { backend: string; format: LogFormat | null; reason: string; key?: undefined; steps?: undefined }
  | { backend: string; format: LogFormat; key: string; steps: LogStep[]; before: number | null; end: number; reset?: boolean; reason?: undefined };

/** The transcript format whose new chat-activity projection (and thinking) is withheld until it has a real redacted fixture (#3648). */
const CODEX_ACTIVITY_WITHHELD = "codex";
const parserFor = (format: LogFormat, thinking = false) => {
  switch (format) {
    case "claude": return new ClaudeStepParser({ thinking });
    case "codex": return new CodexStepParser({ thinking });
    case "antigravity": return new AntigravityStepParser({ thinking });
    case "grok": return new GrokStepParser({ thinking });
  }
};
/**
 * The long records worth reading whole for a Log (a reply, a turn record); every other long one by its head. agy's
 * transcript.jsonl clips its own fields (no line passes 20 KB in the sample) and grok's long lines are file reads: neither
 * has a record worth reading whole.
 */
const wholeFor = (format: LogFormat) => (head: string) => (format === "claude"
  ? isClaudeAssistantHead(head)
  : format === "codex"
    ? head.includes('"type":"event_msg"') || (head.includes('"type":"response_item"') && /"payload":\{"type":"message"/.test(head))
    : false);

const dbTime = (s: string): number => { const t = Date.parse(s.replace(" ", "T") + "Z"); return Number.isFinite(t) ? t : 0; };

export class LogService {
  /** `chat` / `log`: who holds the watch (the chat's block: gated by tool_progress; the Log tab: by log_tab) — either keeps it. */
  private readonly watches = new Map<string, { until: number; path: string; size: number; ino: number; timer: unknown; chat: boolean; log: boolean }>();
  constructor(private readonly deps: LogServiceDeps) {}

  private now(): number { return this.deps.now ? this.deps.now() : performance.now(); }

  /** GET /ui/steps — null: no such instance. */
  async steps(name: string, q: LogQuery): Promise<LogAnswer | null> {
    const chat = q.chat === true;
    // The Log tab is `web.log_tab`'s. The chat's block is the instance's own `tool_progress`'s (AGEND-197): with log_tab off it
    // still works, and with log_tab on but tool_progress off it shows nothing.
    if (!chat && !this.deps.enabled()) { this.unwatchAll(false); return { enabled: false }; }
    if (!this.deps.known(name)) return null;
    const level: ToolProgressLevel = chat ? (this.deps.toolProgress?.(name) ?? "off") : "verbose";
    const src = this.deps.source(name);
    if (chat && level === "off") {
      // Only the chat's own hold on the watch ends — the Log tab, when it is watching this instance, keeps its (AGEND-210).
      this.unwatch(name, "chat");
      return { enabled: true, instance: name, backend: src.backend, supported: !!src.format, level, thinking: false, steps: [], events: [], ev: q.ev ?? 0, before: null, after: null };
    }
    // Prism #3709 R6: the new Codex activity projection is withheld until a real, redacted Codex capture proves it (the owner's
    // #3648 decision: an unproved backend stays as it is today). Codex keeps its Log tab exactly as before; the chat's block
    // gets "not supported" for it and nothing is read. The parser stays, unreachable from the chat.
    if (chat && src.format === CODEX_ACTIVITY_WITHHELD) {
      return { enabled: true, instance: name, backend: src.backend, supported: false, reason: "unsupported", level, thinking: false, steps: [], events: [], ev: q.ev ?? 0, before: null, after: null };
    }
    const evs = chat ? { events: [] as LogEvent[], ev: q.ev ?? 0 } : this.eventsFor(name, q.ev);
    // Thinking: only when asked, only for the viewer the route let it through, and only while `web.log_thinking` is ON —
    // and never for Codex (the same withholding: its reasoning summaries are the new, unproved part).
    const thinking = q.thinking === true && this.deps.thinking?.() === true && src.format !== CODEX_ACTIVITY_WITHHELD;
    // The OS user name (home) and the working directory are for the viewer the route let the chat's block or thinking
    // through (an admin session on the local dashboard) — never the public link or a guest: the page only shortens paths.
    const named = chat || thinking;
    const cwd = named ? this.deps.cwd?.(name) : undefined;
    const base = { enabled: true as const, instance: name, backend: src.backend, events: evs.events, ev: evs.ev, thinking,
      ...(chat ? { level } : {}), ...(cwd ? { cwd } : {}), ...(named ? { home: homedir() } : {}) };
    const offAnswer = (): LogAnswer => ({ enabled: true, instance: name, backend: src.backend, supported: !!src.format, level: "off", thinking: false, steps: [], events: [], ev: q.ev ?? 0, before: null, after: null });
    /**
     * Prism #3709 R2: the policy is the one in force when the answer LEAVES, not when the read began — `tool_progress` and
     * `web.log_thinking` can change while the transcript is read. Looked at again for every forward / backward result:
     * thinking gone when it is now off, the summary cut of the level now set, and nothing at all when the chat's is now off.
     * (A read that began with thinking off never parsed any — the parser stays opt-in; this only ever removes.)
     */
    const settle = <T extends { steps: LogStep[] }>(a: T): (T & { thinking: boolean; level?: ToolProgressLevel }) | null => {
      const now: ToolProgressLevel = chat ? (this.deps.toolProgress?.(name) ?? "off") : "verbose";
      if (chat && now === "off") return null;
      const thinkingNow = thinking && this.deps.thinking?.() === true;
      const kept = thinkingNow ? a.steps : a.steps.filter((x) => x.kind !== "thinking");
      const steps = chat && now !== "off" ? kept.map((x) => chatStep(x, now)) : kept;
      return { ...a, steps, thinking: thinkingNow, ...(chat ? { level: now } : {}) };
    };
    if (!src.format || !src.path) {
      return { ...base, supported: !!src.format, reason: src.reason ?? (src.format ? "no_transcript" : "unsupported"), steps: [], before: null, after: null };
    }
    let st: { dev: number; ino: number; size: number };
    try { st = await stat(src.path); } catch { return { ...base, supported: true, reason: "no_transcript", steps: [], before: null, after: null }; }
    const key = `${st.dev}-${st.ino}`;
    if (q.watch) this.watch(name, src.path, st.size, st.ino, chat);
    const answer = { ...base, supported: true, key };
    const done = (settled: ReturnType<typeof settle>, rest: object = {}): LogAnswer => {
      if (!settled) { this.unwatch(name, "chat"); return offAnswer(); }
      return { ...answer, ...settled, ...rest } as LogAnswer;
    };
    const fresh = q.key !== undefined && q.key !== key;
    const past = q.after !== undefined && q.after > st.size;
    if (q.after !== undefined && !fresh && !past) return done(settle(await this.forward(src.path, src.format, q.after, !!q.skip, thinking)));
    if (q.before !== undefined && !fresh) return done(settle(await this.backward(src.path, src.format, q.before, Math.min(q.limit ?? LOG_OLDER_LIMIT, LOG_OLDER_LIMIT), thinking)), { after: null });
    return done(settle(await this.backward(src.path, src.format, undefined, Math.min(q.limit ?? LOG_STEPS_LIMIT, LOG_STEPS_LIMIT), thinking)),
      (fresh || past) && (q.after !== undefined || q.before !== undefined) ? { reset: true } : {});
  }

  /**
   * Claude history in the View (view-history.ts): the steps before `end` (the newest when undefined), at most `limit` —
   * read the way the Log reads them, but without the Log's switch, its watch or its events: the View's own access rules
   * were applied before this is asked (view-api.ts). `end` of a cursor for another transcript (a new session), or past
   * this one's end, reads the newest instead (`reset`). Null: no such instance.
   */
  async readBack(name: string, q: { end?: number; key?: string; limit: number }): Promise<ReadBack | null> {
    if (!this.deps.known(name)) return null;
    const src = this.deps.source(name);
    if (!src.format || !src.path) return { backend: src.backend, format: src.format, reason: src.reason ?? (src.format ? "no_transcript" : "unsupported") };
    let st: { dev: number; ino: number; size: number };
    try { st = await stat(src.path); } catch { return { backend: src.backend, format: src.format, reason: "no_transcript" }; }
    const key = `${st.dev}-${st.ino}`;
    const limit = Math.max(1, Math.min(q.limit, LOG_STEPS_LIMIT));
    const stale = q.end !== undefined && ((q.key !== undefined && q.key !== key) || q.end > st.size);
    if (q.end !== undefined && !stale) {
      const back = await this.backward(src.path, src.format, q.end, limit);
      return { backend: src.backend, format: src.format, key, steps: back.steps, before: back.before, end: q.end };
    }
    const back = await this.backward(src.path, src.format, undefined, limit);
    return { backend: src.backend, format: src.format, key, steps: back.steps, before: back.before, end: back.after, ...(stale ? { reset: true } : {}) };
  }

  /** The steps before `end` (the newest when undefined), at most `limit`, and where older ones start. */
  private async backward(path: string, format: LogFormat, end: number | undefined, limit: number, thinking = false): Promise<{ steps: LogStep[]; before: number | null; after: number }> {
    const tail = await readTailRecords(path, { maxLines: 4000, ...(end !== undefined ? { end } : {}) });
    const parser = parserFor(format, thinking);
    const whole = wholeFor(format);
    const firstAt = new Map<string, number>();
    for (const r of tail.records) {
      let record: string | LongLine = r.record;
      // #1788 review P3: a long reply or turn record is read whole here too, as the live read does.
      if (typeof record !== "string" && whole(record.head)) {
        const text = await readWholeLine(path, r.at, record.bytes).catch(() => null);
        if (text !== null) record = text;
      }
      for (const s of parser.push(record, r.at)) if (!firstAt.has(s.id)) firstAt.set(s.id, r.at);
    }
    let steps = fitBytes(parser.steps.slice(-limit));
    // #1788 review P3: cut only at a record's boundary — one record can make several steps (a reply's text and its
    // call): the oldest kept record comes whole, so `before` (its start) never leaves one of its steps out for good.
    let from = parser.steps.length - steps.length;
    const recordOf = (i: number) => firstAt.get(parser.steps[i]!.id);
    while (from > 0 && steps.length && recordOf(from - 1) === recordOf(from)) from--;
    steps = parser.steps.slice(from);
    // Older steps exist when the read stopped before the file's start, or when steps it parsed were left out (the limit,
    // the answer's size): they start at the record of the oldest step shown. Otherwise nothing is older.
    const all = !tail.truncated && steps.length === parser.steps.length;
    const first = steps.length ? Math.min(...steps.map(s => firstAt.get(s.id) ?? Infinity)) : (tail.records[0]?.at ?? 0);
    const before = !all && Number.isFinite(first) && first > 0 ? first : null;
    return { steps, before, after: tail.end };
  }

  /** The steps after `from` (≤ LOOKS_PER_POLL looks), and the cursor after them. */
  private async forward(path: string, format: LogFormat, from: number, skip: boolean, thinking = false): Promise<{ steps: LogStep[]; before: null; after: number; skip?: boolean; more?: boolean }> {
    const parser = parserFor(format, thinking);
    const whole = wholeFor(format);
    let offset = from, skipping = skip, more = false;
    for (let look = 0; look < LOOKS_PER_POLL; look++) {
      const read = await readNewLines(path, offset, { skipping });
      const moved = read.newOffset !== offset;
      offset = read.newOffset; skipping = read.skipping; more = read.more;
      // In file order: complete lines with their offsets, long lines by their head — or whole, for a reply or turn record.
      let li = 0;
      const pushLong = async (l: LongLine) => {
        if (l.complete && whole(l.head)) {
          const text = await readWholeLine(path, l.offset, l.bytes).catch(() => null);
          if (text !== null) { parser.push(text, l.offset); return; }
        }
        parser.push(l, l.offset);
      };
      for (const l of read.long) {
        while (li < l.at) { parser.push(read.lines[li]!, read.offsets[li]!); li++; }
        await pushLong(l);
      }
      while (li < read.lines.length) { parser.push(read.lines[li]!, read.offsets[li]!); li++; }
      if (!moved || !read.more) break;
    }
    const steps = fitBytes(parser.steps);
    return { steps, before: null, after: offset, ...(skipping ? { skip: true } : {}), ...(more || skipping ? { more: true } : {}) };
  }

  private eventsFor(name: string, after: number | undefined): { events: LogEvent[]; ev: number } {
    let rows: LogEventRow[] = [];
    try { rows = this.deps.events(name, LOG_EVENTS_LIMIT); } catch { rows = []; }
    const ev = rows.reduce((m, r) => Math.max(m, r.id), after ?? 0);
    const events = rows
      .filter(r => (after === undefined || r.id > after) && LOG_EVENT_TYPES.has(r.event_type))
      .map(r => {
        // M-2269: a dialog's screen text is its own field, masked again here, never folded into the JSON detail.
        const rawScreen = r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>).screen : undefined;
        const screen = typeof rawScreen === "string" && rawScreen ? bounded(rawScreen, SCREEN_MAX_BYTES).text : undefined;
        const detail = r.payload && typeof r.payload === "object"
          ? (() => {
            const { screen: _screen, ...p } = r.payload as Record<string, unknown>;
            // When the payload is only (or includes) a `message`, show that text rather than raw JSON.
            if (typeof p.message === "string" && p.message) return bounded(p.message, 300).text;
            const keys = Object.keys(p);
            return keys.length ? bounded(JSON.stringify(p), 300).text : undefined;
          })()
          : undefined;
        return { id: r.id, ts: dbTime(r.created_at), type: r.event_type, ...(detail ? { detail } : {}), ...(screen ? { screen } : {}) };
      })
      .reverse();
    return { events, ev };
  }

  /** Hold (or renew) the watch on `name`: its transcript's size is looked at while the lease lasts. */
  private watch(name: string, path: string, size: number, ino: number, chat = false): void {
    const until = this.now() + WATCH_LEASE_MS;
    const held = this.watches.get(name);
    if (held && held.path === path) { held.until = until; held.chat ||= chat; held.log ||= !chat; return; }
    if (held) this.unwatch(name, "all");
    const setI = this.deps.setInterval ?? ((fn: () => void, ms: number) => { const t = setInterval(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    const w = { until, path, size, ino, timer: null as unknown, chat, log: !chat };
    w.timer = setI(() => { void this.look(name); }, WATCH_POLL_MS);
    this.watches.set(name, w);
  }

  private async look(name: string): Promise<void> {
    const w = this.watches.get(name);
    if (!w) return;
    // Each holder is checked on its own switch: one whose switch went off lets go, the other keeps the watch.
    const logOk = w.log && this.deps.enabled();
    const chatOk = w.chat && (this.deps.toolProgress?.(name) ?? "off") !== "off";
    if (this.now() > w.until || (!logOk && !chatOk)) { this.unwatch(name, "all"); return; }
    w.log = logOk; w.chat = chatOk;
    let st: { size: number; ino: number };
    try { st = await stat(w.path); } catch { return; }
    if (this.watches.get(name) !== w) return;
    if (st.size !== w.size || st.ino !== w.ino) {
      w.size = st.size; w.ino = st.ino;
      this.deps.emit("steps_tick", { instance: name });
    }
  }

  /**
   * Let go of `name`'s watch: `all` ends it; `log` / `chat` release only that holder's part (AGEND-210) — the watch goes
   * when no holder is left, and stays while the other still holds it (the chat reading `tool_progress` off must not end
   * the Log tab's live view, nor the Log being switched off the chat's).
   */
  private unwatch(name: string, part: "all" | "log" | "chat" = "all"): void {
    const w = this.watches.get(name);
    if (!w) return;
    if (part === "chat") w.chat = false; else if (part === "log") w.log = false;
    if (part !== "all" && (w.chat || w.log)) return;
    (this.deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)))(w.timer);
    this.watches.delete(name);
  }

  /**
   * Every watch ends (the fleet stops). `all` false: the Log was turned off — only what the Log held ends, and a chat's
   * block (gated by tool_progress, not log_tab) keeps its watch.
   */
  unwatchAll(all = true): void { for (const name of [...this.watches.keys()]) this.unwatch(name, all ? "all" : "log"); }

  /** How many instances are watched now (for tests and diagnostics). */
  watched(): number { return this.watches.size; }
}

/** The newest steps whose JSON fits LOG_RESPONSE_MAX_BYTES (each step is already bounded; this bounds their number). */
function fitBytes(steps: LogStep[]): LogStep[] {
  let total = 0, i = steps.length;
  while (i > 0) {
    const size = JSON.stringify(steps[i - 1]).length + 1;
    if (total + size > LOG_RESPONSE_MAX_BYTES) break;
    total += size; i--;
  }
  return steps.slice(i);
}
