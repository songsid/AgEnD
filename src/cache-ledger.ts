/**
 * #1468: what the prompt-cache analysis keeps per instance — never the transcripts themselves. Each model request a
 * CLI made (a Claude assistant message, a Codex `token_count`) becomes a "turn"; the ledger folds turns into:
 * - hourly totals per model and price tier (requests and tokens: uncached input, cache reads, cache writes, output)
 *   with the hour's histogram of gaps between consecutive requests of the same session;
 * - one event per long gap (≥ GAP_EVENT_SEC): when it ended, how long it was, the context it left cached, what the
 *   request after it wrote to the cache — all the keep-warm simulation needs;
 * - per transcript file: where reading stopped (a line start), and the session's first and last request.
 * That keeps a month of a busy fleet in kilobytes per instance, and a file is read once, incrementally.
 *
 * Usage fields (real shapes, checked 2026-10-09):
 * - Claude Code: `message.usage` { input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
 *   cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }, output_tokens }. A message spans several
 *   lines (one per content block) carrying the same id and usage: counted once.
 * - Codex (0.160): `event_msg` `token_count` with `info.last_token_usage` { input_tokens (cached included),
 *   cached_input_tokens, cache_write_input_tokens, output_tokens }. The write field exists but was 0 in every one of
 *   38,551 real events on GPT-5.6+ models — so a write is estimated as the request's uncached input unless a real
 *   write count shows up. The model comes from the preceding `turn_context`.
 */
import { objectAt, type ScanLine } from "./cache-scan.js";
import { isLongPrompt } from "./cache-prices.js";

export type TranscriptKind = "claude" | "codex";

/** One model request, as the transcript records it. */
export interface Turn {
  t: number;
  model: string;
  /** Everything the request sent: uncached input + cache reads + cache writes. */
  prompt: number;
  uncached: number;
  read: number;
  write5m: number;
  write1h: number;
  /** An OpenAI cache write as recorded (null: not recorded, 0 included when the field is absent). */
  write: number | null;
  output: number;
}

/** Gap histogram edges, seconds: ≤5 min, ≤30 min, ≤1 h, ≤2 h, ≤6 h, ≤24 h, longer. */
export const GAP_EDGES = [300, 1800, 3600, 7200, 21600, 86400] as const;
export const GAP_BUCKETS = GAP_EDGES.length + 1;
/** Gaps at least this long are kept one by one (the shortest keep-warm interval is a 5-minute TTL's 270 s). */
export const GAP_EVENT_SEC = 240;
export const KEEP_DAYS = 31;

/** [requests, uncached, read, write5m, write1h, write, output] */
export type HourTotals = [number, number, number, number, number, number, number];
export interface HourAgg { m: Record<string, HourTotals>; g: number[] }
/** [tEnd, gapSec, contextCached, rewritten, model, promptAfter] */
export type GapEvent = [number, number, number, number, string, number];

export interface SessionPoint { t: number; ctx: number; model: string }
export interface FileCursor {
  kind: TranscriptKind;
  ino: number;
  offset: number;
  first?: number;
  last?: SessionPoint;
  /** Codex: the model of the latest turn_context; the last cumulative total (token_count repeats itself). */
  model?: string;
  total?: number;
  /** Claude: ids of the last messages counted (one message spans several lines). */
  ids?: string[];
}

export interface Ledger {
  v: 1;
  files: Record<string, FileCursor>;
  hours: Record<string, HourAgg>;
  gaps: GapEvent[];
  /** A real OpenAI cache-write count was seen (Codex): writes are then measured, not estimated. */
  writesSeen?: boolean;
}

/** A dictionary keyed by names from outside (paths, model ids): every key an own property (#1467 lesson). */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
export function emptyLedger(): Ledger { return { v: 1, files: dict(), hours: dict(), gaps: [] }; }

/** A ledger read back from disk; anything that is not one is a fresh ledger. */
export function reviveLedger(raw: unknown): Ledger {
  const l = emptyLedger();
  if (!raw || typeof raw !== "object" || (raw as Ledger).v !== 1) return l;
  const r = raw as Ledger;
  for (const [k, v] of Object.entries(r.files ?? {})) if (v && typeof v.offset === "number") l.files[k] = v;
  for (const [k, v] of Object.entries(r.hours ?? {})) {
    if (!v || !Array.isArray(v.g)) continue;
    const m = dict<HourTotals>();
    for (const [mk, tot] of Object.entries(v.m ?? {})) if (Array.isArray(tot) && tot.length === 7) m[mk] = tot as HourTotals;
    l.hours[k] = { m, g: v.g };
  }
  if (Array.isArray(r.gaps)) l.gaps = r.gaps.filter((g) => Array.isArray(g) && g.length === 6);
  if (r.writesSeen) l.writesSeen = true;
  return l;
}

const HOUR = 3_600_000;
export const hourOf = (t: number): number => Math.floor(t / HOUR) * HOUR;
export const gapBucket = (sec: number): number => { let i = 0; while (i < GAP_EDGES.length && sec > GAP_EDGES[i]!) i++; return i; };
/** The key hourly totals are kept under: the model, and whether the request paid its long-prompt row. */
export const modelKey = (model: string, prompt: number): string => `${model}|${isLongPrompt(model, prompt) ? 1 : 0}`;

/** What the request after a gap wrote to the cache: Claude's recorded writes; Codex's recorded write, else its uncached input. */
export function rewritten(turn: Turn, kind: TranscriptKind): number {
  if (kind === "claude") return turn.write5m + turn.write1h;
  return turn.write && turn.write > 0 ? turn.write : turn.uncached;
}

/**
 * Fold one turn into the ledger, in file order. Turns older than `cutoff` only move the session's last point (the
 * next gap needs it); everything else is counted. Pure apart from mutating `ledger`.
 */
export function addTurn(ledger: Ledger, file: FileCursor, turn: Turn, cutoff: number): void {
  const prev = file.last;
  file.first ??= turn.t;
  file.last = { t: turn.t, ctx: turn.prompt + turn.output, model: turn.model };
  if (turn.write !== null && turn.write > 0) ledger.writesSeen = true;
  if (turn.t < cutoff) return;
  const hk = String(hourOf(turn.t));
  const hour = ledger.hours[hk] ??= { m: dict<HourTotals>(), g: new Array<number>(GAP_BUCKETS).fill(0) };
  const mk = modelKey(turn.model, turn.prompt);
  const tot = hour.m[mk] ??= [0, 0, 0, 0, 0, 0, 0];
  tot[0] += 1; tot[1] += turn.uncached; tot[2] += turn.read; tot[3] += turn.write5m; tot[4] += turn.write1h; tot[5] += turn.write ?? 0; tot[6] += turn.output;
  if (!prev) return;
  const gap = (turn.t - prev.t) / 1000;
  if (!(gap >= 0)) return;
  hour.g[gapBucket(gap)]! += 1;
  if (gap >= GAP_EVENT_SEC) ledger.gaps.push([turn.t, gap, prev.ctx, rewritten(turn, file.kind), turn.model, turn.prompt]);
}

/** Drop what is older than `cutoff` (hours and gap events). */
export function pruneLedger(ledger: Ledger, cutoff: number): void {
  for (const k of Object.keys(ledger.hours)) if (Number(k) + HOUR <= cutoff) delete ledger.hours[k];
  if (ledger.gaps.length && ledger.gaps[0]![0] < cutoff) ledger.gaps = ledger.gaps.filter((g) => g[0] >= cutoff);
}

// ── Reading turns out of transcript lines ──

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const CLAUDE_ID = /"id":"(msg_[A-Za-z0-9_-]{1,120})"/;
const CLAUDE_MODEL = /"model":"([^"]{1,120})"/;
const TIMESTAMP = /"timestamp":"([^"]{10,40})"/g;

function claudeTurn(u: Record<string, unknown> | undefined, model: unknown, ts: unknown): Turn | null {
  if (!u || typeof model !== "string" || typeof ts !== "string") return null;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  const input = num(u.input_tokens), read = num(u.cache_read_input_tokens), creation = num(u.cache_creation_input_tokens);
  const split = u.cache_creation as Record<string, unknown> | undefined;
  let write1h = num(split?.ephemeral_1h_input_tokens), write5m = num(split?.ephemeral_5m_input_tokens);
  // No split recorded (older CLIs): the API's default, a 5-minute write.
  if (!split && creation) write5m = creation;
  if (split && write1h + write5m !== creation) write5m = Math.max(0, creation - write1h);
  return { t, model, prompt: input + read + creation, uncached: input, read, write5m, write1h, write: null, output: num(u.output_tokens) };
}

/** The turn a Claude Code transcript line records, or null; a message already counted (`file.ids`) is null too. */
export function claudeLine(line: ScanLine, file: FileCursor): Turn | null {
  let id: string | undefined, turn: Turn | null = null;
  if ("whole" in line) {
    if (line.whole.indexOf("\"usage\"") === -1 || line.whole.indexOf("\"assistant\"") === -1) return null;
    let d: { type?: unknown; isSidechain?: unknown; timestamp?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } };
    try { d = JSON.parse(line.whole.toString("utf8")); } catch { return null; }
    if (d.type !== "assistant" || d.isSidechain === true || !d.message) return null;
    id = typeof d.message.id === "string" ? d.message.id : undefined;
    if (id && file.ids?.includes(id)) return null;
    turn = claudeTurn(d.message.usage, d.message.model, d.timestamp);
  } else {
    // A long line: the start carries the model and id, the end the usage, type and timestamp.
    const head = line.head.toString("utf8"), tail = line.tail.toString("utf8");
    if (!tail.includes("\"type\":\"assistant\"") || head.includes("\"isSidechain\":true")) return null;
    id = CLAUDE_ID.exec(head)?.[1];
    if (id && file.ids?.includes(id)) return null;
    const at = tail.lastIndexOf("\"usage\":{");
    const obj = at === -1 ? null : objectAt(tail, at + "\"usage\":".length);
    let usage: Record<string, unknown> | undefined;
    try { usage = obj ? JSON.parse(obj) : undefined; } catch { usage = undefined; }
    const stamps = [...tail.matchAll(TIMESTAMP)];
    turn = claudeTurn(usage, CLAUDE_MODEL.exec(head)?.[1], stamps.length ? stamps[stamps.length - 1]![1] : undefined);
  }
  if (turn && id) file.ids = [...(file.ids ?? []).slice(-15), id];
  return turn;
}

/** The turn a Codex rollout line records, or null. A `turn_context` line updates the file's model. */
export function codexLine(line: ScanLine, file: FileCursor): Turn | null {
  if (!("whole" in line)) return null;                     // token_count and turn_context lines are small
  const w = line.whole;
  const isCount = w.indexOf("\"token_count\"") !== -1;
  if (!isCount && w.indexOf("\"turn_context\"") === -1) return null;
  let d: { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> };
  try { d = JSON.parse(w.toString("utf8")); } catch { return null; }
  const p = d.payload;
  if (!p) return null;
  if (d.type === "turn_context") { if (typeof p.model === "string") file.model = p.model; return null; }
  if (d.type !== "event_msg" || p.type !== "token_count") return null;
  const info = p.info as { last_token_usage?: Record<string, unknown>; total_token_usage?: Record<string, unknown> } | null | undefined;
  const u = info?.last_token_usage;
  if (!u || typeof d.timestamp !== "string") return null;
  // The same usage is re-announced (a rate-limit update): the running total has not moved.
  const total = num(info?.total_token_usage?.total_tokens);
  if (total && file.total === total) return null;
  if (total) file.total = total;
  const t = Date.parse(d.timestamp);
  if (!Number.isFinite(t)) return null;
  const input = num(u.input_tokens), read = Math.min(num(u.cached_input_tokens), input);
  const write = typeof u.cache_write_input_tokens === "number" ? Math.min(num(u.cache_write_input_tokens), input - read) : null;
  return { t, model: file.model ?? "unknown", prompt: input, uncached: input - read - (write ?? 0), read, write5m: 0, write1h: 0, write, output: num(u.output_tokens) };
}
