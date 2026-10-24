/**
 * #2122 §10 step 2: Kiro's usage, ESTIMATED. Kiro records no token counts (design §10.1: every `request_metadata` token
 * field is null in the classic store, every `*_token_count` 0 in the TUI one, and V3 has no such field), so each turn is
 * estimated from its text size the way tokscale does — the same basis as the user's tokscale-based reports (the user's
 * decision, option B). Kiro keeps a conversation in one of three stores, by engine:
 * - classic (legacy UI, engine v1): `<XDG_DATA_HOME>/kiro-cli/data.sqlite3`, table `conversations_v2` — kiroClassicTurns;
 * - TUI (engine v2): `<KIRO_HOME>/sessions/cli/<id>.json` with its `<id>.jsonl` — kiroTuiTurns;
 * - V3 (KAS): `<KIRO_HOME>/sessions/<bucket>/sess_<id>/{session.json, messages.jsonl}` — kiroKasTurns.
 * The estimate:
 * - fresh input: ceil(bytes / 4) of the prompt (its recorded `user_prompt_length`, else the prompt text) plus the tool
 *   results the turn sent;
 * - output: ceil(bytes / 4) of the response (`response_size`, TUI `assistant_response_length`, else its text);
 * - cache read: the context the turn resent, `floor(window × context_usage_percentage / 100) − fresh input` (never below
 *   0); the window is the conversation's `context_window_tokens` (classic: none → no cache read; TUI: none → 200,000;
 *   V3 records none: 200,000);
 * - cache write and reasoning: 0. A real count, should Kiro ever record one above 0, is taken instead.
 * Credits are not read: the user's plan is not billed in them (design §10.2).
 *
 * The estimation formula and field mapping follow tokscale (github.com/junhoyeo/tokscale,
 * crates/tokscale-core/src/sessions/kiro.rs at 669fdaeec54502a30468adbfa97789bb7ee2b762), MIT License,
 * Copyright (c) 2025 Junho Yeo — see THIRD_PARTY_NOTICES.md. The code is AgEnD's own. Pure: no I/O.
 */
import type { Turn } from "./cache-ledger.js";

/** The window when a TUI or V3 session records none (tokscale's DEFAULT_CONTEXT_WINDOW). */
export const KIRO_DEFAULT_WINDOW = 200_000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Obj : null);
const at = (v: unknown, ...path: string[]): unknown => { let c = v; for (const k of path) c = obj(c)?.[k]; return c; };
/** A count as recorded; anything that is not a finite number is absent. */
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const positive = (v: unknown): number | null => { const n = count(v); return n !== null && n > 0 ? n : null; };
const estimate = (bytes: number): number => Math.ceil(Math.max(0, bytes) / 4);
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const chars = (s: string): number => { let n = 0; for (const _ of s) n++; return n; };
const modelOf = (info: unknown): string => {
  const m = at(info, "model_id");
  return typeof m === "string" && m.trim() ? m : "unknown";
};
const turn = (t: number, model: string, input: number, read: number, output: number, requests = 1): Turn =>
  ({ t, model, prompt: input + read, uncached: input, read, write5m: 0, write1h: 0, write: null, output, ...(requests > 1 ? { requests } : {}) });

/** The classic store's tool results: the bytes of every `Text`/`text` string inside, else of the whole JSON. */
function classicToolResultBytes(value: unknown): number {
  const walk = (v: unknown): number => {
    if (Array.isArray(v)) return v.reduce((n: number, x) => n + walk(x), 0);
    const o = obj(v);
    if (!o) return 0;
    let n = 0;
    for (const [k, x] of Object.entries(o)) n += (k === "Text" || k === "text") && typeof x === "string" ? bytes(x) : walk(x);
    return n;
  };
  const found = walk(value);
  return found > 0 ? found : bytes(JSON.stringify(value) ?? "");
}

export interface KiroClassicTurn extends Turn { index: number }
/**
 * The estimated turns of one classic conversation (`conversations_v2.value`, parsed) whose request started after
 * `after` (ms). One turn per `history[]` entry with `request_metadata`; an entry estimated at nothing is skipped.
 */
export function kiroClassicTurns(conversation: unknown, after: number): KiroClassicTurn[] {
  const model = modelOf(at(conversation, "model_info"));
  const window = count(at(conversation, "model_info", "context_window_tokens")) ?? 0;
  const history = at(conversation, "history");
  if (!Array.isArray(history)) return [];
  const out: KiroClassicTurn[] = [];
  history.forEach((entry, index) => {
    const meta = obj(at(entry, "request_metadata"));
    if (!meta) return;
    const t = positive(meta.request_start_timestamp_ms) ?? positive(meta.stream_end_timestamp_ms) ?? 0;
    if (!(t > after)) return;
    const nested = obj(meta.token_usage) ?? obj(meta.usage);
    const real = (...keys: string[]): number | null => { for (const k of keys) { const v = positive(meta[k]) ?? positive(nested?.[k]); if (v !== null) return v; } return null; };
    const realInput = real("input_tokens", "uncached_input_tokens", "input_token_count");
    const realOutput = real("output_tokens", "output_token_count");
    const realRead = real("cache_read_input_tokens", "cache_read_tokens", "cache_read");
    const content = at(entry, "user", "content");
    const promptText = at(content, "Prompt", "prompt");
    const promptBytes = positive(meta.user_prompt_length) ?? (typeof promptText === "string" ? bytes(promptText) : 0);
    const toolBytes = obj(content) && "ToolUseResults" in obj(content)! ? classicToolResultBytes(obj(content)!.ToolUseResults) : 0;
    const fresh = estimate(promptBytes + toolBytes);
    const pct = count(meta.context_usage_percentage) ?? 0;
    const context = window > 0 && pct > 0 ? Math.floor(window * pct / 100) : 0;
    const input = realInput ?? fresh;
    const read = realRead ?? (realInput === null ? Math.max(context - fresh, 0) : 0);
    const output = realOutput ?? estimate(count(meta.response_size) ?? 0);
    if (input + output === 0) return;
    const requests = positive(meta.request_count) ?? positive(meta.user_turn_request_count) ?? positive(meta.total_request_count) ?? 1;
    out.push({ ...turn(t, model, input, read, output, requests), index });
  });
  return out;
}

/** The request start times a classic conversation recorded (for the cross-store dedup below). */
export function kiroClassicRequestTimes(conversation: unknown): number[] {
  const history = at(conversation, "history");
  if (!Array.isArray(history)) return [];
  const out: number[] = [];
  for (const e of history) { const t = positive(at(e, "request_metadata", "request_start_timestamp_ms")); if (t !== null) out.push(t); }
  return out;
}

/** A TUI or V3 timestamp: an RFC 3339 string, or a number in seconds (below 1e12) or milliseconds. */
function v3Time(v: unknown): number | null {
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) && t > 0 ? t : null; }
  const n = count(v);
  if (n === null || n <= 0) return null;
  return Math.abs(n) < 1e12 ? Math.round(n * 1000) : n;
}
const secsOf = (d: unknown): number | null => {
  const s = count(at(d, "secs")), ns = count(at(d, "nanos"));
  return s === null ? null : s + (ns ?? 0) / 1e9;
};

/** TUI tool results (a `ToolResults` line's `data.content`): the text of each toolResult's content data. */
function v3ToolResultBytes(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content) {
    if (at(part, "kind") !== "toolResult") continue;
    const inner = at(part, "data", "content");
    if (!Array.isArray(inner)) continue;
    for (const x of inner) {
      const d = obj(x)?.data;
      if (d === undefined) continue;
      n += typeof d === "string" ? bytes(d) : bytes(JSON.stringify(d) ?? "");
    }
  }
  return n;
}
const textChars = (content: unknown): number => {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const p of content) { const k = at(p, "kind"), d = at(p, "data"); if ((k === undefined || k === null || k === "text") && typeof d === "string") n += chars(d); }
  return n;
};

export interface KiroTuiTurn extends Turn { index: number }
/**
 * The estimated turns of one TUI session — its `<id>.json` (parsed) and the lines of its `<id>.jsonl` — that started
 * after `after` (ms). Only the messages a turn's `message_ids` name count toward it: the sidecar also carries the
 * messages a conversation brought over from the classic engine.
 *
 * Dedup across stores (design §10.1): a conversation can have turns in both engines under one id. A TUI turn whose
 * window [end − turn_duration, end] holds a request of the same conversation's classic record (`classicTimes`) is that
 * request's, counted from the classic store: it is dropped here.
 */
export function kiroTuiTurns(session: unknown, jsonlLines: Iterable<string>, after: number, classicTimes: readonly number[] = []): KiroTuiTurn[] {
  const info = at(session, "session_state", "rts_model_state", "model_info");
  const model = modelOf(info);
  const window = positive(at(info, "context_window_tokens")) ?? KIRO_DEFAULT_WINDOW;
  const turns = at(session, "session_state", "conversation_metadata", "user_turn_metadatas");
  if (!Array.isArray(turns) || !turns.length) return [];
  const byId = new Map<string, { prompt: number; assistant: number; tools: number; promptAt: number | null }>();
  let pendingPrompt: { chars: number; at: number | null } | null = null, pendingTools = 0;
  for (const line of jsonlLines) {
    let e: unknown;
    try { e = JSON.parse(line); } catch { continue; }
    const kind = at(e, "kind");
    if (kind === "ToolResults") { pendingTools += v3ToolResultBytes(at(e, "data", "content")); continue; }
    const id = at(e, "data", "message_id");
    if (typeof id !== "string") continue;
    const c = textChars(at(e, "data", "content"));
    if (kind === "Prompt") pendingPrompt = { chars: c, at: v3Time(at(e, "data", "meta", "timestamp")) };
    else if (kind === "AssistantMessage") {
      const m = byId.get(id) ?? { prompt: 0, assistant: 0, tools: 0, promptAt: null };
      if (pendingPrompt) { m.prompt += pendingPrompt.chars; m.promptAt ??= pendingPrompt.at; pendingPrompt = null; }
      m.assistant += c; m.tools += pendingTools; pendingTools = 0;
      byId.set(id, m);
    }
  }
  const out: KiroTuiTurn[] = [];
  turns.forEach((tm, index) => {
    let prompt = 0, assistant = 0, tools = 0, promptAt: number | null = null;
    const ids = at(tm, "message_ids");
    for (const id of Array.isArray(ids) ? ids : []) {
      const m = typeof id === "string" ? byId.get(id) : undefined;
      if (!m) continue;
      prompt += m.prompt; assistant += m.assistant; tools += m.tools; promptAt ??= m.promptAt;
    }
    const end = v3Time(at(tm, "end_timestamp"));
    const t = promptAt ?? end;
    if (t === null || !(t > after)) return;
    if (end !== null && classicTimes.length) {
      const secs = secsOf(at(tm, "turn_duration"));
      const start = secs === null ? (promptAt ?? end) : end - secs * 1000;
      if (classicTimes.some(c => c >= start && c <= end)) return;
    }
    const realInput = positive(at(tm, "input_token_count")), realOutput = positive(at(tm, "output_token_count"));
    const realRead = positive(at(tm, "cache_read_input_token_count"));
    const fresh = estimate((positive(at(tm, "user_prompt_length")) ?? prompt) + tools);
    const input = realInput ?? fresh;
    const pct = count(at(tm, "context_usage_percentage")) ?? 0;
    const read = realRead ?? Math.max((pct > 0 ? Math.floor(window * pct / 100) : 0) - input, 0);
    const responseBytes = positive(at(tm, "assistant_response_length"));
    const output = realOutput ?? estimate(responseBytes ?? assistant);
    if (input + output === 0) return;
    out.push({ ...turn(t, model, input, read, output, positive(at(tm, "total_request_count")) ?? 1), index });
  });
  return out;
}

/**
 * The estimated turns of one V3 (KAS) session — its `session.json` (parsed) and the lines of its `messages.jsonl` — that
 * started after `after` (ms). A turn runs to its `turn_end`: its `user` text and `tool_result` text are its fresh input,
 * its `assistant` text its output, and its last `contextUsage` its context. The window is 200,000 (V3 records none).
 *
 * A session converted from another engine (`ensure-session`: a new id, the history copied in) holds turns that store
 * already counted: a turn that ended before the session was created (`createdAt`) is not counted again, nor one whose
 * window holds a request of its source's classic record (`classicTimes`).
 */
export function kiroKasTurns(session: unknown, jsonlLines: Iterable<string>, after: number, classicTimes: readonly number[] = []): Turn[] {
  const model = typeof at(session, "modelId") === "string" && String(at(session, "modelId")).trim() ? String(at(session, "modelId")) : "unknown";
  const created = v3Time(at(session, "createdAt"));
  type T = { prompt: number; assistant: number; tools: number; pct: number; promptAt: number | null; endAt: number | null; elapsed: number | null; requests: number };
  const turns: T[] = [];
  let cur: T | null = null;
  const fresh = (): T => ({ prompt: 0, assistant: 0, tools: 0, pct: 0, promptAt: null, endAt: null, elapsed: null, requests: 0 });
  const close = (): void => { if (cur && (cur.prompt || cur.assistant || cur.tools)) turns.push(cur); cur = null; };
  for (const line of jsonlLines) {
    let e: unknown;
    try { e = JSON.parse(line); } catch { continue; }
    const p = obj(at(e, "payload"));
    if (!p || typeof p.type !== "string") continue;
    const ts = v3Time(at(e, "timestamp"));
    const text = typeof p.content === "string" ? chars(p.content) : 0;
    switch (p.type) {
      case "user": cur ??= fresh(); cur.prompt += text; cur.promptAt ??= ts; break;
      case "assistant": if (cur) cur.assistant += text; break;
      case "tool_result": cur ??= fresh(); cur.tools += text; break;
      case "session_metadata": { const pct = count(at(p, "value", "usagePercentage")); if (p.key === "contextUsage" && cur && pct !== null) cur.pct = pct; break; }
      case "usage_summary": {
        const el = count(p.elapsedTime);
        if (cur && el !== null) cur.elapsed = el;
        if (cur && Array.isArray(p.requestIds)) cur.requests = p.requestIds.length;
        break;
      }
      case "turn_end": if (cur) cur.endAt = ts; close(); break;
    }
  }
  // A turn still being written (no turn_end yet) is not counted now: counted unfinished, the rest of it would come after
  // the cursor's `after` and never be added. It is counted, whole, once it ends.
  const out: Turn[] = [];
  for (const t of turns) {
    const at0 = t.promptAt ?? t.endAt;
    if (at0 === null || !(at0 > after)) continue;
    if (created !== null && t.endAt !== null && t.endAt < created) continue;
    const end = t.endAt ?? at0, start = t.promptAt ?? (t.elapsed !== null ? end - t.elapsed : end);
    if (classicTimes.some(c => c >= start && c <= end)) continue;
    const input = estimate(t.prompt + t.tools);
    const read = Math.max((t.pct > 0 ? Math.floor(KIRO_DEFAULT_WINDOW * t.pct / 100) : 0) - input, 0);
    const output = estimate(t.assistant);
    if (input + output === 0) continue;
    out.push(turn(at0, model, input, read, output, Math.max(1, t.requests)));
  }
  return out;
}
