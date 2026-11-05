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
 *   cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens (a part of output_tokens) }. The write field exists but was 0 in every one of
 *   38,551 real events on GPT-5.6+ models — so a write is estimated as the request's uncached input unless a real
 *   write count shows up. The model comes from the preceding `turn_context`.
 */
import { objectAt, type ScanLine } from "./cache-scan.js";
import { isLongPrompt } from "./cache-prices.js";

/** The reader: Claude Code, Codex, Grok, Muse, OpenCode and Antigravity are measured; Kiro is estimated (#2122 §10). */
export type TranscriptKind = "claude" | "codex" | "kiro" | "grok" | "muse" | "opencode" | "antigravity";

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
  /** The part of `output` the CLI reports as reasoning (Codex `reasoning_output_tokens`); absent or 0 where none is. */
  reasoning?: number;
  /** The model requests this record covers (a Kiro turn's `total_request_count`, Grok's `modelCalls`); absent: one. */
  requests?: number;
  /** What the CLI itself reported the request cost, USD (Grok's `costUsdTicks` × 1e-10); absent: not reported. */
  cost?: number;
}

/** Gap histogram edges, seconds: ≤5 min, ≤30 min, ≤1 h, ≤2 h, ≤6 h, ≤24 h, longer. */
export const GAP_EDGES = [300, 1800, 3600, 7200, 21600, 86400] as const;
export const GAP_BUCKETS = GAP_EDGES.length + 1;
/** Gaps at least this long are kept one by one (the shortest keep-warm interval is a 5-minute TTL's 270 s). */
export const GAP_EVENT_SEC = 240;
export const KEEP_DAYS = 31;

/** [requests, uncached, read, write5m, write1h, write, output] */
export type HourTotals = [number, number, number, number, number, number, number];
/**
 * `src` (#2122): the same totals split by where they were read from — `sourceKey(reader, profile)`: the transcript reader
 * (claude, codex) and the credential profile (claude: its config dir's profile, "default" without one; codex:
 * "unrecorded", since a rollout does not say which login wrote it). Each source keeps its own exact totals. What `m`
 * holds beyond the sum of `src` was counted before #2122 and reads as unknown (hourSources) — never relabelled with
 * today's backend or profile.
 */
export interface HourAgg {
  m: Record<string, HourTotals>; g: number[]; src?: Record<string, Record<string, HourTotals>>;
  /**
   * #2122 §10.3: reasoning tokens, by source and model key — the part of `output` a CLI reports as reasoning (Codex). Kept
   * beside the totals, never as an 8th entry: a published reader keeps only 7-entry totals and would drop the hour (Fable
   * #2604 P1); an older version that rewrites the ledger drops only this.
   */
  rs?: Record<string, Record<string, number>>;
  /** #2122 §10.2: the cost a CLI reported (USD), by source and model key — beside the totals, as `rs`. */
  cs?: Record<string, Record<string, number>>;
  /** #3066 §2: output speed, by source and model key (SpeedAgg) — beside the totals, as `rs`. */
  sp?: Record<string, Record<string, SpeedAgg>>;
}
/** A source of an hour's totals: the reader that read them and the profile it read them under. */
export const sourceKey = (reader: TranscriptKind, profile: string): string => `${reader}:${profile}`;
/**
 * One long gap: [tEnd, gapSec, contextCached, contextModel, ttlSec, model, promptAfter, measuredWrite, estimatedWrite].
 * - `contextCached`/`contextModel`: what the previous request left cached, and its model — what a ping would read.
 * - `ttlSec`: the TTL of that cache as the session last wrote it (Claude's own write split; Codex's 30 minutes).
 * - `measuredWrite`: what the request after the gap recorded writing (Claude always; Codex its write field, 0
 *   included, or null when the field is absent). `estimatedWrite`: Codex's uncached input — used only while the
 *   instance has never recorded a real write (the field exists but stays 0 on the CLIs seen so far).
 */
export type GapEvent = [number, number, number, string, number, string, number, number | null, number];

export interface SessionPoint { t: number; ctx: number; model: string; ttl: number }
export interface FileCursor {
  kind: TranscriptKind;
  ino: number;
  offset: number;
  first?: number;
  last?: SessionPoint;
  /** Claude: the TTL the session's latest cache write used (1 h or 5 min). */
  ttl?: number;
  /** The file size at which only an unfinished line was left: not read again until the file grows. */
  stalled?: number;
  /** Codex: the model of the latest turn_context; the last cumulative total (token_count repeats itself). */
  model?: string;
  total?: number;
  /** Claude: ids of the last messages counted (one message spans several lines). */
  ids?: string[];
  /** #3066 §2, Claude: the response being read, for its speed (its window ends at its last block). */
  resp?: ClaudeResponse;
  /** #3066 §2, Codex: the turn being read — the open response's clocks, hosted tool intervals, responses awaiting count. */
  cx?: CodexResponse;
  /** #3066 §2: timed responses read from the last lines, for the reader to count (addSpeed); never kept. */
  speeds?: SpeedSample[];
  /** Kiro (kiro-usage-scan.ts): what the source looked like when read, and the time of the last turn counted. */
  sig?: string;
  after?: number;
}

export interface Ledger {
  v: 2;
  files: Record<string, FileCursor>;
  hours: Record<string, HourAgg>;
  gaps: GapEvent[];
  /** A real OpenAI cache-write count was seen (Codex): writes are then measured, not estimated. */
  writesSeen?: boolean;
}

/** A dictionary keyed by names from outside (paths, model ids): every key an own property (#1467 lesson). */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
export function emptyLedger(): Ledger { return { v: 2, files: dict(), hours: dict(), gaps: [] }; }

/** A ledger read back from disk; anything that is not one is a fresh ledger. */
export function reviveLedger(raw: unknown): Ledger {
  const l = emptyLedger();
  if (!raw || typeof raw !== "object" || (raw as Ledger).v !== 2) return l;
  const r = raw as Ledger;
  for (const [k, v] of Object.entries(r.files ?? {})) if (v && typeof v.offset === "number") l.files[k] = v;
  for (const [k, v] of Object.entries(r.hours ?? {})) {
    if (!v || !Array.isArray(v.g)) continue;
    const m = dict<HourTotals>();
    for (const [mk, tot] of Object.entries(v.m ?? {})) if (Array.isArray(tot) && tot.length === 7) m[mk] = tot as HourTotals;
    const src = dict<Record<string, HourTotals>>();
    for (const [sk, sm] of Object.entries(v.src ?? {})) {
      if (!/^(?:claude|codex|kiro|grok|muse|opencode|antigravity):.{1,120}$/s.test(sk) || !sm || typeof sm !== "object") continue;
      const into = dict<HourTotals>();
      for (const [mk, tot] of Object.entries(sm)) if (Array.isArray(tot) && tot.length === 7 && tot.every(n => Number.isFinite(n))) into[mk] = tot as HourTotals;
      src[sk] = into;
    }
    // Beside the totals, by source and model key: only for a total that exists, only positive and finite.
    const beside = (raw: unknown): Record<string, Record<string, number>> => {
      const out = dict<Record<string, number>>();
      for (const [sk, sm] of Object.entries((raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>)) {
        if (!src[sk] || !sm || typeof sm !== "object") continue;
        const into = dict<number>();
        for (const [mk, n] of Object.entries(sm)) if (typeof n === "number" && Number.isFinite(n) && n > 0 && src[sk][mk]) into[mk] = n;
        if (Object.keys(into).length) out[sk] = into;
      }
      return out;
    };
    const rs = beside(v.rs), cs = beside(v.cs);
    // #3066 §2: speed beside the totals too — a whole SpeedAgg of finite, non-negative numbers, for a known source.
    const sp = dict<Record<string, SpeedAgg>>();
    for (const [sk, sm] of Object.entries((v.sp && typeof v.sp === "object" ? v.sp : {}) as Record<string, unknown>)) {
      if (!src[sk] || !sm || typeof sm !== "object") continue;
      const into = dict<SpeedAgg>();
      for (const [mk, a] of Object.entries(sm)) if (Array.isArray(a) && a.length === 3 + SPEED_BUCKETS && a.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) into[mk] = a as SpeedAgg;
      if (Object.keys(into).length) sp[sk] = into;
    }
    l.hours[k] = { m, g: v.g, ...(Object.keys(src).length ? { src } : {}), ...(Object.keys(rs).length ? { rs } : {}), ...(Object.keys(cs).length ? { cs } : {}), ...(Object.keys(sp).length ? { sp } : {}) };
  }
  if (Array.isArray(r.gaps)) l.gaps = r.gaps.filter((g) => Array.isArray(g) && g.length === 9);
  if (r.writesSeen) l.writesSeen = true;
  return l;
}

const HOUR = 3_600_000;
export const hourOf = (t: number): number => Math.floor(t / HOUR) * HOUR;
export const gapBucket = (sec: number): number => { let i = 0; while (i < GAP_EDGES.length && sec > GAP_EDGES[i]!) i++; return i; };
/** The key hourly totals are kept under: the model, and whether the request paid its long-prompt row. */
export const modelKey = (model: string, prompt: number): string => `${model}|${isLongPrompt(model, prompt) ? 1 : 0}`;

/** Codex keeps a prefix 30 minutes (GPT-5.6 and later; assumed for any other Codex model, which is then an estimate). */
export const CODEX_TTL_SEC = 1800;
const CLAUDE_DEFAULT_TTL_SEC = 3600;

/** The TTL a Claude request's own cache writes used: its write split decides; no write leaves the session's as it was. */
export function claudeTtlAfter(turn: Turn, current: number | undefined): number {
  if (turn.write1h > 0 || turn.write5m > 0) return turn.write5m > turn.write1h ? 300 : 3600;
  return current ?? CLAUDE_DEFAULT_TTL_SEC;
}

/**
 * Fold one turn into the ledger, in file order. Turns older than `cutoff` only move the session's last point (the
 * next gap needs it); everything else is counted. Pure apart from mutating `ledger`.
 */
export function addTurn(ledger: Ledger, file: FileCursor, turn: Turn, cutoff: number, profile?: string): void {
  const prev = file.last;
  const ttlBefore = file.kind === "claude" ? (file.ttl ?? CLAUDE_DEFAULT_TTL_SEC) : CODEX_TTL_SEC;
  if (file.kind === "claude") file.ttl = claudeTtlAfter(turn, file.ttl);
  file.first ??= turn.t;
  file.last = { t: turn.t, ctx: turn.prompt + turn.output, model: turn.model, ttl: file.kind === "claude" ? file.ttl! : CODEX_TTL_SEC };
  if (turn.write !== null && turn.write > 0) ledger.writesSeen = true;
  if (turn.t < cutoff) return;
  const hk = String(hourOf(turn.t));
  const hour = ledger.hours[hk] ??= { m: dict<HourTotals>(), g: new Array<number>(GAP_BUCKETS).fill(0) };
  const mk = modelKey(turn.model, turn.prompt);
  const bump = (tot: HourTotals): void => {
    tot[0] += turn.requests ?? 1; tot[1] += turn.uncached; tot[2] += turn.read; tot[3] += turn.write5m; tot[4] += turn.write1h; tot[5] += turn.write ?? 0; tot[6] += turn.output;
  };
  bump(hour.m[mk] ??= [0, 0, 0, 0, 0, 0, 0]);
  // #2122: and under its source — the reader that read it (this file's kind) and the profile it was read under.
  const sk = sourceKey(file.kind, profile ?? "unknown");
  const src = (hour.src ??= dict<Record<string, HourTotals>>())[sk] ??= dict<HourTotals>();
  bump(src[mk] ??= [0, 0, 0, 0, 0, 0, 0]);
  if (turn.reasoning) { const rs = (hour.rs ??= dict<Record<string, number>>())[sk] ??= dict<number>(); rs[mk] = (rs[mk] ?? 0) + turn.reasoning; }
  if (turn.cost) { const cs = (hour.cs ??= dict<Record<string, number>>())[sk] ??= dict<number>(); cs[mk] = (cs[mk] ?? 0) + turn.cost; }
  // Only Claude and Codex are in the cache analysis (Kiro's turns are estimates; the others' analysis is not built).
  if (!prev || (file.kind !== "claude" && file.kind !== "codex")) return;
  const gap = (turn.t - prev.t) / 1000;
  if (!(gap >= 0)) return;
  hour.g[gapBucket(gap)]! += 1;
  if (gap < GAP_EVENT_SEC) return;
  const measured = file.kind === "claude" ? turn.write5m + turn.write1h : turn.write;
  const estimated = file.kind === "claude" ? turn.write5m + turn.write1h : turn.uncached + (turn.write ?? 0);
  ledger.gaps.push([turn.t, gap, prev.ctx, prev.model, ttlBefore, turn.model, turn.prompt, measured, estimated]);
}

// ── #3066 §2: output speed — Claude after the first token, Codex over the response window ──
/**
 * Output tokens per second of a response's own generation — after its first token (the user's choice), the method of
 * tokdash (MIT, © 2026 Jingbiao Mei; github.com/JingbiaoMei/tokdash, its `post_first_token`): Claude Code stamps each
 * content block when it finishes, and a leading thinking block carries `thinkingDurationMs`, so its stamp minus that is
 * the first token; the window runs to the last block. A response without that (no thinking block, an API error or a
 * fallback, no stop_reason) is not timed. Rate = Σ tokens ÷ Σ duration, never a mean of rates.
 *
 * Kept per hour, source and model key as one array: [tokens, ms, responses, …SPEED_BUCKETS] — the histogram is the
 * duration in each rate bucket (√2 steps from 1 tok/s), for a duration-weighted p10–p90.
 */
export const SPEED_BUCKETS = 24;
export type SpeedAgg = number[];
export const speedBucket = (tokPerSec: number): number => Math.max(0, Math.min(SPEED_BUCKETS - 1, Math.floor(2 * Math.log2(Math.max(1, tokPerSec)))));
/** The lower edge of a histogram bucket, tok/s. */
export const speedBucketFloor = (i: number): number => 2 ** (i / 2);
export interface SpeedSample { t: number; model: string; prompt: number; tokens: number; ms: number }
export const emptySpeed = (): SpeedAgg => new Array<number>(3 + SPEED_BUCKETS).fill(0);
export function addSpeedInto(into: SpeedAgg, from: SpeedAgg): void { for (let i = 0; i < 3 + SPEED_BUCKETS; i++) into[i] = (into[i] ?? 0) + (from[i] ?? 0); }

/** Count one timed response into its hour, under its source and model key (as addTurn counts its tokens). */
export function addSpeed(ledger: Ledger, file: FileCursor, s: SpeedSample, cutoff: number, profile?: string): void {
  if (s.t < cutoff || !(s.ms > 0) || !(s.tokens > 0)) return;
  const hour = ledger.hours[String(hourOf(s.t))] ??= { m: dict<HourTotals>(), g: new Array(GAP_BUCKETS).fill(0) };
  const sk = sourceKey(file.kind, profile ?? "unknown");
  const agg = ((hour.sp ??= dict<Record<string, SpeedAgg>>())[sk] ??= dict<SpeedAgg>())[modelKey(s.model, s.prompt)] ??= emptySpeed();
  agg[0] += s.tokens; agg[1] += s.ms; agg[2] += 1;
  agg[3 + speedBucket(s.tokens * 1000 / s.ms)]! += s.ms;
}

/** A Claude response being read (one message id, one line per content block): what its timing needs. */
export interface ClaudeResponse { id: string; first: number; think: number | null; last: number; out: number; model: string; prompt: number; stopped: boolean; failed: boolean; done?: true }

/**
 * Observe one assistant line for the speed of its response; a finished response (its stop_reason seen) becomes a sample
 * in `file.speeds`, which the reader drains. Every line of a message is observed — not only the first, which counts its
 * tokens — because the window ends at the last block.
 */
function observeClaudeSpeed(file: FileCursor, id: string | undefined, d: { timestamp?: unknown; isApiErrorMessage?: unknown; thinkingDurationMs?: unknown;
  message?: { model?: unknown; stop_reason?: unknown; content?: unknown; usage?: Record<string, unknown> } }): void {
  const stamp = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
  if (!id || !Number.isFinite(stamp) || !d.message) return;
  const u = d.message.usage, model = typeof d.message.model === "string" ? d.message.model : "";
  const content = d.message.content;
  const thinking = Array.isArray(content) && content.length === 1 && (content[0] as { type?: unknown } | null)?.type === "thinking";
  let r = file.resp;
  if (!r || r.id !== id) {
    r = file.resp = { id, first: stamp, think: thinking && typeof d.thinkingDurationMs === "number" && d.thinkingDurationMs > 0 ? d.thinkingDurationMs : null,
      last: stamp, out: 0, model, prompt: num(u?.input_tokens) + num(u?.cache_read_input_tokens) + num(u?.cache_creation_input_tokens), stopped: false, failed: false };
  }
  if (r.done) return;
  r.last = Math.max(r.last, stamp);
  r.out = Math.max(r.out, num(u?.output_tokens));
  r.failed ||= d.isApiErrorMessage === true || model === "<synthetic>";
  r.stopped ||= !!d.message.stop_reason;
  if (!r.stopped) return;
  r.done = true;
  if (r.failed || r.think === null) return;                           // timed only after its first token (tokdash's rule)
  const ms = r.last - (r.first - r.think);
  if (ms > 0 && r.out > 0) (file.speeds ??= []).push({ t: r.first, model: r.model, prompt: r.prompt, tokens: r.out, ms });
}

/**
 * Codex (0.147+ rollouts): a response's model items (AgentMessage, Reasoning) carry `started_at_ms` / `completed_at_ms`
 * on their `item_completed` event, and a `token_usage_record` closes the response with its own usage — tokdash's
 * `response_window` (not a first-token boundary: the rollout does not mark one): the first model item's start → the last
 * model item's end, minus the hosted tool time (WebSearch) inside that window; client tools (commands, edits, MCP) are
 * not the model's time and bound nothing. Faster than 3000 tok/s is a clock artefact (tokdash's ceiling), not counted.
 * Older rollouts have no item clocks: not timed.
 *
 * Owned, never guessed (Prism #3075):
 * - clocks belong to their turn (`turn_id`): a new turn, an abort, an error or a compaction drops the open response's
 *   clocks, and an item or record of another turn makes the response ambiguous — untimed;
 * - hosted tool intervals are kept per turn and clipped into each response's own window, so a search logged after its
 *   response's record still counts against that response only; the turn's samples are made when the turn ends;
 * - a sample is the response's counted usage, timed: it waits (in the cursor, across restarts) for the `token_count`
 *   that counts the response — the next count, carrying the same usage as its record; an unmatched one is dropped — and
 *   is filed at that count's time: the same hour, source and model as its tokens.
 */
export const CODEX_MAX_TOK_PER_S = 3000;
const CODEX_MODEL_ITEMS = new Set(["AgentMessage", "Reasoning"]);
const CODEX_HOSTED_ITEMS = new Set(["WebSearch"]);
const CX_ITEM_TYPE = /"item":\{"type":"([A-Za-z]+)"/, CX_STARTED = /"started_at_ms":(\d{10,16})/, CX_DONE = /"completed_at_ms":(\d{10,16})/;
const CX_TURN = /"turn_id":"([^"]+)"/;
const CX_EVENT = /"type":"event_msg","payload":\{"type":"(task_started|task_complete|turn_aborted|error|stream_error|context_compacted)"/;
const CX_PENDING_MAX = 64, CX_HOSTED_MAX = 256;
/** One response closed by its record, waiting for its count (`counted`, the token_count's time) and its turn's end. */
export interface CodexPending { start: number; end: number; out: number; prompt: number; model: string; counted?: number }
/** A turn being read: its id, the open response's clocks, its hosted tool intervals, its closed responses. */
export interface CodexResponse { turn: string | null; start: number | null; end: number | null; bad?: true; hosted: Array<[number, number]>; pend: CodexPending[] }
const newCx = (turn: string | null): CodexResponse => ({ turn, start: null, end: null, hosted: [], pend: [] });

/** The time inside [start, end] that the intervals cover, each instant once (clip, then union). */
export function clippedUnionMs(intervals: ReadonlyArray<readonly [number, number]>, start: number, end: number): number {
  let total = 0, cursor = start;
  for (const [lo, hi] of intervals.map(([a, b]) => [Math.max(start, a), Math.min(end, b)] as const).sort((x, y) => x[0] - y[0])) {
    if (hi > Math.max(cursor, lo)) { total += hi - Math.max(cursor, lo); cursor = hi; }
  }
  return total;
}

/** A counted response becomes a sample, its window less the turn's hosted tool time inside it. */
function emitCodexSample(file: FileCursor, r: CodexResponse, p: CodexPending): void {
  if (typeof p.counted !== "number") return;                          // never counted: no one's usage
  const ms = p.end - p.start - clippedUnionMs(Array.isArray(r.hosted) ? r.hosted : [], p.start, p.end);
  if (!(ms > 0) || !(p.out > 0) || (p.out * 1000) / ms > CODEX_MAX_TOK_PER_S) return;
  (file.speeds ??= []).push({ t: p.counted, model: p.model, prompt: p.prompt, tokens: p.out, ms });
}

/** The turn has ended: its counted responses become samples; one never counted is no one's usage and is dropped. */
function finishCodexTurn(file: FileCursor): void {
  const r = file.cx;
  delete file.cx;
  if (!r || !Array.isArray(r.pend)) return;
  for (const p of r.pend) emitCodexSample(file, r, p);
}

function observeCodexSpeed(line: ScanLine, file: FileCursor): void {
  const buf = "whole" in line ? line.whole : line.head;
  const text = buf.toString("utf8", 0, Math.min(buf.length, 4096));
  const event = CX_EVENT.exec(text)?.[1];
  if (event) {
    const turn = CX_TURN.exec(text)?.[1] ?? null;
    if (event === "task_started") { finishCodexTurn(file); file.cx = newCx(turn); return; }
    if (event === "task_complete") { finishCodexTurn(file); return; }
    // An abort, an error, a compaction: the open response is cut off — its clocks are no one's.
    const r = file.cx;
    if (r) { r.start = null; r.end = null; delete r.bad; }
    return;
  }
  if (text.includes("\"type\":\"item_completed\"")) {
    const kind = CX_ITEM_TYPE.exec(text)?.[1], s = Number(CX_STARTED.exec(text)?.[1]), e = Number(CX_DONE.exec(text)?.[1]);
    const turn = CX_TURN.exec(text)?.[1] ?? null;
    if (kind === "ContextCompaction") { const r = file.cx; if (r) { r.start = null; r.end = null; delete r.bad; } return; }
    if (!kind || !(CODEX_MODEL_ITEMS.has(kind) || CODEX_HOSTED_ITEMS.has(kind))) return;
    const r = file.cx ??= newCx(turn);
    if (r.turn === null) r.turn = turn;
    const valid = Number.isFinite(s) && Number.isFinite(e) && e >= s;
    if (turn !== r.turn) { if (CODEX_MODEL_ITEMS.has(kind)) r.bad = true; return; }     // another turn's: owner unproven
    if (CODEX_HOSTED_ITEMS.has(kind)) { if (valid && r.hosted.length < CX_HOSTED_MAX) r.hosted.push([s, e]); return; }
    if (!valid || e === s) { r.bad = true; return; }
    r.start = r.start === null ? s : Math.min(r.start, s); r.end = r.end === null ? e : Math.max(r.end, e);
    return;
  }
  if (!("whole" in line) || line.whole.indexOf("\"token_usage_record\"") === -1) return;
  let d: { type?: unknown; payload?: { turn_id?: unknown; usage?: Record<string, unknown> } };
  try { d = JSON.parse(line.whole.toString("utf8")); } catch { return; }
  if (d.type !== "token_usage_record") return;
  const r = file.cx;
  if (!r) return;
  const timed = r.start !== null && r.end !== null && !r.bad && (r.turn === null || d.payload?.turn_id === r.turn);
  const out = num(d.payload?.usage?.output_tokens);
  // Every record — timed or not — is now the response the next count belongs to (Prism #3075 r3): one still waiting
  // from before never had its count, and is dropped, so a later count can only ever be this record's.
  r.pend = r.pend.filter((x) => typeof x.counted === "number");
  if (timed && out > 0) {
    // Over the cap, the oldest is withheld — untimed (the coverage says so): timing it now could miss a search logged
    // later in the turn (Prism #3075 r4), and a wrong rate is worse than none.
    while (r.pend.length >= CX_PENDING_MAX) r.pend.shift();
    r.pend.push({ start: r.start!, end: r.end!, out, prompt: num(d.payload?.usage?.input_tokens), model: file.model ?? "unknown" });
  }
  r.start = null; r.end = null; delete r.bad;               // a record closes its response, timed or not
}

/**
 * A token_count was counted at `t` with this usage. Its response is the latest closed one still waiting — and only if
 * that response's own record has the same usage (Prism #3075 r2): a count never goes to a response it does not match.
 * Each record drops the responses still waiting before it (observeCodexSpeed), so the latest waiting one is always the
 * latest record's — an untimed record leaves none waiting, and its count times nothing.
 */
function codexCounted(file: FileCursor, t: number, usage: { input: number; output: number }): void {
  const pend = file.cx?.pend;
  if (!Array.isArray(pend)) return;
  const latest = pend.filter((x) => typeof x.counted !== "number").at(-1);
  if (latest && latest.out === usage.output && latest.prompt === usage.input) latest.counted = t;
}

/**
 * Drop what is older than `cutoff` (hours and gap events). `foldedThrough` (#2122): an hour is dropped only once the
 * usage rollup holds it (usage-rollup.ts: fold, then prune) — never one after the rollup's durable checkpoint.
 */
export function pruneLedger(ledger: Ledger, cutoff: number, foldedThrough = Number.POSITIVE_INFINITY): void {
  for (const k of Object.keys(ledger.hours)) if (Number(k) + HOUR <= cutoff && Number(k) <= foldedThrough) delete ledger.hours[k];
  if (ledger.gaps.length && ledger.gaps[0]![0] < cutoff) ledger.gaps = ledger.gaps.filter((g) => g[0] >= cutoff);
}

// ── Reading turns out of transcript lines ──

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const CLAUDE_ID = /"id":"(msg_[A-Za-z0-9_-]{1,120})"/;
const CLAUDE_ID_G = /"id":"(msg_[A-Za-z0-9_-]{1,120})"/g;
const CLAUDE_MODEL = /"model":"([^"]{1,120})"/;
const CLAUDE_MODEL_G = /"model":"([^"]{1,120})"/g;
const TIMESTAMP = /"timestamp":"([^"]{10,40})"/g;
const lastMatch = (text: string, re: RegExp): string | undefined => { const all = [...text.matchAll(re)]; return all.length ? all[all.length - 1]![1] : undefined; };
function lastUsage(text: string): Record<string, unknown> | undefined {
  const at = text.lastIndexOf("\"usage\":{");
  const obj = at === -1 ? null : objectAt(text, at + "\"usage\":".length);
  try { return obj ? JSON.parse(obj) as Record<string, unknown> : undefined; } catch { return undefined; }
}

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
    let d: { type?: unknown; isSidechain?: unknown; timestamp?: unknown; isApiErrorMessage?: unknown; thinkingDurationMs?: unknown;
      message?: { id?: unknown; model?: unknown; stop_reason?: unknown; content?: unknown; usage?: Record<string, unknown> } };
    try { d = JSON.parse(line.whole.toString("utf8")); } catch { return null; }
    if (d.type !== "assistant" || d.isSidechain === true || !d.message) return null;
    id = typeof d.message.id === "string" ? d.message.id : undefined;
    observeClaudeSpeed(file, id, d);                                  // #3066 §2: every block line, before the dedupe
    if (id && file.ids?.includes(id)) return null;
    turn = claudeTurn(d.message.usage, d.message.model, d.timestamp);
  } else {
    // A long line, kept as its two ends. Claude writes the model and id near the start and the usage and timestamp
    // near the end, but where `type` and `isSidechain` sit depends on the writer: both ends are searched alike.
    const head = line.head.toString("utf8"), tail = line.tail.toString("utf8");
    const either = (needle: string): boolean => head.includes(needle) || tail.includes(needle);
    if (!either("\"type\":\"assistant\"") || either("\"isSidechain\":true")) return null;
    id = CLAUDE_ID.exec(head)?.[1] ?? lastMatch(tail, CLAUDE_ID_G);
    if (id && file.ids?.includes(id)) return null;
    const usage = lastUsage(tail) ?? lastUsage(head);
    const ts = lastMatch(tail, TIMESTAMP) ?? lastMatch(head, TIMESTAMP);
    turn = claudeTurn(usage, CLAUDE_MODEL.exec(head)?.[1] ?? lastMatch(tail, CLAUDE_MODEL_G), ts);
  }
  if (turn && id) file.ids = [...(file.ids ?? []).slice(-15), id];
  return turn;
}

/** The turn a Codex rollout line records, or null. A `turn_context` line updates the file's model. */
export function codexLine(line: ScanLine, file: FileCursor): Turn | null {
  observeCodexSpeed(line, file);                            // #3066 §2: item clocks and the response's closing record
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
  const input = num(u.input_tokens), read = Math.min(num(u.cached_input_tokens), input), output = num(u.output_tokens);
  codexCounted(file, t, { input, output });                 // #3066 §2: the waiting response this count is the usage of
  const write = typeof u.cache_write_input_tokens === "number" ? Math.min(num(u.cache_write_input_tokens), input - read) : null;
  // Reasoning is counted inside output_tokens (total_tokens = input + output): kept as its part, capped at output.
  return { t, model: file.model ?? "unknown", prompt: input, uncached: input - read - (write ?? 0), read, write5m: 0, write1h: 0, write, output, reasoning: Math.min(num(u.reasoning_output_tokens), output) };
}

/**
 * #2122 §10 step 3: the turns a Grok `updates.jsonl` line records — a `turn_completed` update's `usage`, one turn per
 * model in its `modelUsage` (else the whole usage under `_meta.modelId`). Real counts, per turn (not cumulative):
 * `inputTokens` includes the cache reads and writes, `reasoningTokens` is a part of `outputTokens` (totalTokens = input +
 * output, checked on the host's 1.0.x sessions), `modelCalls` the requests, `costUsdTicks` × 1e-10 the cost grok
 * reported. A turn already counted (its `prompt_id`, kept in `file.ids`) is not counted again.
 */
export function grokLine(line: ScanLine, file: FileCursor): Turn[] {
  if (!("whole" in line) || line.whole.indexOf("\"turn_completed\"") === -1) return [];
  let d: { timestamp?: unknown; params?: { update?: Record<string, unknown>; _meta?: Record<string, unknown> } };
  try { d = JSON.parse(line.whole.toString("utf8")); } catch { return []; }
  const u = d.params?.update, meta = d.params?._meta;
  if (!u || u.sessionUpdate !== "turn_completed" || !u.usage || typeof u.usage !== "object") return [];
  const id = typeof u.prompt_id === "string" ? u.prompt_id : typeof meta?.eventId === "string" ? meta.eventId : undefined;
  if (id && file.ids?.includes(id)) return [];
  const ms = typeof meta?.agentTimestampMs === "number" ? meta.agentTimestampMs : typeof d.timestamp === "number" ? d.timestamp * 1000 : NaN;
  if (!Number.isFinite(ms)) return [];
  const usage = u.usage as Record<string, unknown>;
  const perModel = usage.modelUsage && typeof usage.modelUsage === "object" && Object.keys(usage.modelUsage).length
    ? Object.entries(usage.modelUsage as Record<string, Record<string, unknown>>)
    : [[typeof meta?.modelId === "string" ? meta.modelId : "unknown", usage] as [string, Record<string, unknown>]];
  const out: Turn[] = [];
  for (const [model, mu] of perModel) {
    if (!mu || typeof mu !== "object") continue;
    const input = num(mu.inputTokens), read = Math.min(num(mu.cachedReadTokens), input), write = Math.min(num(mu.cacheCreationTokens), input - read);
    const output = num(mu.outputTokens), ticks = num(mu.costUsdTicks);
    if (!input && !output) continue;
    out.push({ t: ms, model, prompt: input, uncached: input - read - write, read, write5m: 0, write1h: 0, write, output,
      reasoning: Math.min(num(mu.reasoningTokens), output), requests: Math.max(1, Math.round(num(mu.modelCalls))), ...(ticks ? { cost: ticks * 1e-10 } : {}) });
  }
  if (id && out.length) file.ids = [...(file.ids ?? []).slice(-15), id];
  return out;
}

/**
 * #2122 §10 step 4: the turn a Muse `session.jsonl` line records — a `runtime.session` event `model_completed` with its
 * `usage`. Real counts, one per model call, read as tokscale reads them (sessions/muse.rs at 669fdaee):
 * - `input_tokens` includes the cache reads — `cache_read_tokens`, else (absent, not 0) the older `cached_tokens` — and
 *   `cache_write_tokens` is apart; `reasoning_tokens` is a part of `output_tokens`;
 * - the call's time is its start: `recorded_at` (when it completed; µs, ms or s) less a positive `duration_ms`;
 * - a call replayed into the file (the same stream, sequence, model and counts) is counted once (`file.ids`).
 * Only `model_completed` counts: a workflow's aggregate events would count a child's calls twice.
 */
export function museLine(line: ScanLine, file: FileCursor): Turn | null {
  if (!("whole" in line) || line.whole.indexOf("\"model_completed\"") === -1) return null;
  let d: { recorded_at?: unknown; sequence?: unknown; stream?: { id?: unknown }; payload_type?: unknown; payload?: { event?: Record<string, unknown> } };
  try { d = JSON.parse(line.whole.toString("utf8")); } catch { return null; }
  const e = d.payload?.event;
  if (d.payload_type !== "runtime.session" || !e || e.kind !== "model_completed" || !e.usage || typeof e.usage !== "object") return null;
  const ended = museMs(d.recorded_at);
  if (ended === null) return null;
  const u = e.usage as Record<string, unknown>;
  const present = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const input = num(u.input_tokens), read = Math.min(num(present(u.cache_read_tokens) ? u.cache_read_tokens : u.cached_tokens), input);
  const write = present(u.cache_write_tokens) ? num(u.cache_write_tokens) : null;
  const output = num(u.output_tokens), reasoning = Math.min(num(u.reasoning_tokens), output);
  if (!input && !output && !write) return null;
  const model = typeof e.model === "string" && e.model ? e.model : "unknown";
  const id = `${typeof d.stream?.id === "string" ? d.stream.id : ""}:${present(d.sequence) ? d.sequence : ""}:${model}:${input}:${output}:${read}:${write ?? 0}:${reasoning}`;
  if (file.ids?.includes(id)) return null;
  file.ids = [...(file.ids ?? []).slice(-63), id];
  const duration = num(e.duration_ms);
  return { t: duration && ended - duration > 0 ? ended - duration : ended, model, prompt: input + (write ?? 0), uncached: input - read, read,
    write5m: 0, write1h: 0, write, output, reasoning };
}
/** Muse's `recorded_at` as milliseconds: it writes microseconds; milliseconds and seconds are read too (as tokscale does). */
function museMs(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw >= 1e15) return Math.floor(raw / 1000);
  if (raw >= 1e12) return raw;
  if (raw >= 1e9) return raw * 1000;
  return null;
}
