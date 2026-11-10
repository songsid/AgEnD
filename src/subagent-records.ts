/** Read-only CLI observations. Never feed children into the parent's turn/delivery monitor. */
import { createHash } from "node:crypto";
import { redactSecrets } from "./tool-progress.js";
export interface SubagentRun {
  key: string; parentTurn: string; parentStartedAt: number; parentTask?: string; name: string; type?: string; task: string;
  state: "running" | "completed" | "unknown"; startedAt: number; durationMs?: number; summary?: string; expiresAt?: number;
}
export interface SubagentArtifact { records: unknown[]; meta?: unknown }
export interface SubagentProjection {
  backend: "claude-code" | "codex"; sessionId: string; cwd: string; parent: unknown[];
  children: ReadonlyMap<string, SubagentArtifact>; now: number; live: boolean;
}
export const SUBAGENT_MAX = 16;
export const SUBAGENT_FRESH_MS = 30_000;
export const SUBAGENT_UNKNOWN_MS = 120_000;
export const SUBAGENT_COMPLETED_MS = 15_000;
type Obj = Record<string, any>;
const obj = (v: unknown): Obj => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const uuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s);
const callId = (s: unknown): s is string => typeof s === "string" && /^[\w-]{1,160}$/.test(s);
const text = (s: unknown, n = 500): string => typeof s === "string" ? redactSecrets(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, n).trim() : "";
const at = (s: unknown): number => typeof s === "string" && Number.isFinite(Date.parse(s)) ? Date.parse(s) : 0;
const duration = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 7 * 86400000;
const parse = (s: unknown): Obj => { try { return typeof s === "string" && s.length <= 128000 ? obj(JSON.parse(s)) : {}; } catch { return {}; } };
const blocks = (r: Obj): Obj[] => Array.isArray(r.message?.content) ? r.message.content.map(obj) : [];
const key = (...v: string[]) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
export interface ChildSpec { id: string; call: string; turn: string; parentStartedAt: number; startedAt: number; name: string; type?: string; task: string; parentTask?: string }

/** Only successful, session-bound launch edges. Never follow an output_file supplied by the transcript. */
export function subagentLaunches(i: Omit<SubagentProjection, "children" | "now" | "live">): ChildSpec[] {
  if (!uuid(i.sessionId) || i.parent.length > 20000) return [];
  const out = new Map<string, ChildSpec>();
  if (i.backend === "claude-code") {
    const calls = new Map<string, { r: Obj; b: Obj; turn: string; parentStartedAt: number; parentTask?: string }>();
    let turn = "", parentTask = "", parentStartedAt = 0;
    for (const raw of i.parent) {
      const r = obj(raw);
      if (r.sessionId !== i.sessionId || r.cwd !== i.cwd || r.isSidechain !== false) continue;
      if (r.type === "user" && r.origin?.kind === "human" && uuid(r.promptId)) {
        turn = r.promptId; parentStartedAt = at(r.timestamp); parentTask = text(r.message?.content, 200);
      }
      if (r.type === "assistant" && turn) for (const b of blocks(r)) {
        // The captured schema is Agent. Unsupported legacy spellings need their own fixtures.
        if (b.type === "tool_use" && b.name === "Agent" && callId(b.id)) calls.set(b.id, { r, b, turn, parentStartedAt, parentTask });
      }
      const result = obj(r.toolUseResult);
      if (r.type !== "user" || result.status !== "async_launched" || result.isAsync !== true
        || typeof result.agentId !== "string" || !/^[a-f0-9]{1,64}$/.test(result.agentId)) continue;
      const bs = blocks(r).filter(b => b.type === "tool_result" && !b.is_error);
      if (bs.length !== 1) continue;
      const c = calls.get(bs[0].tool_use_id);
      if (!c || r.sourceToolAssistantUUID !== c.r.uuid || r.promptId !== c.turn || !at(r.timestamp)) continue;
      const input = obj(c.b.input), type = text(input.subagent_type, 80), name = text(input.description, 120);
      const edge = { id: result.agentId, call: c.b.id, turn: c.turn, parentStartedAt: c.parentStartedAt, startedAt: at(r.timestamp), name, ...(type ? { type } : {}), task: text(input.prompt), ...(c.parentTask ? { parentTask: c.parentTask } : {}) };
      out.set(key(i.sessionId, edge.turn, edge.call, edge.id), edge);
      if (out.size > SUBAGENT_MAX) out.delete(out.keys().next().value!);
    }
  } else {
    const meta = obj(i.parent.find(r => obj(r).type === "session_meta")).payload;
    if (!meta || meta.id !== i.sessionId || meta.cwd !== i.cwd || meta.parent_thread_id || meta.thread_source === "subagent" || obj(meta.source).subagent) return [];
    const calls = new Map<string, Obj>();
    const turns = new Map<string, number>();
    for (const raw of i.parent) {
      const r = obj(raw), p = obj(r.payload);
      if (r.type === "event_msg" && p.type === "task_started" && uuid(p.turn_id)) turns.set(p.turn_id, at(r.timestamp));
      if (r.type !== "response_item") continue;
      const turn = p.internal_chat_message_metadata_passthrough?.turn_id;
      if (!turns.has(turn) || !callId(p.call_id)) continue;
      if (p.type === "function_call" && p.namespace === "multi_agent_v1" && p.name === "spawn_agent") calls.set(p.call_id, { ...p, at: at(r.timestamp) });
      if (p.type !== "function_call_output") continue;
      const c = calls.get(p.call_id), result = parse(p.output);
      if (!c || c.internal_chat_message_metadata_passthrough?.turn_id !== turn || !uuid(result.agent_id) || !c.at) continue;
      const edge = { id: result.agent_id, call: p.call_id, turn, parentStartedAt: turns.get(turn)!, startedAt: c.at, name: text(result.nickname, 120), task: text(parse(c.arguments).message) };
      out.set(key(i.sessionId, edge.turn, edge.call, edge.id), edge);
      if (out.size > SUBAGENT_MAX) out.delete(out.keys().next().value!);
    }
  }
  return [...out.values()];
}
function tag(s: string, name: string): string | null {
  const matches = [...s.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))];
  return matches.length === 1 ? matches[0][1].trim() : null;
}
/** A duration record must name an admitted assistant from that exact prompt, not a later notification turn. */
function parentEnds(i: SubagentProjection): Map<string, number> {
  const ends = new Map<string, number>(), assistants = new Map<string, string>();
  let turn = "";
  for (const raw of i.parent) {
    const r = obj(raw), time = at(r.timestamp);
    if (i.backend === "claude-code") {
      if (r.sessionId !== i.sessionId || r.cwd !== i.cwd || r.isSidechain !== false) continue;
      if (r.type === "user" && uuid(r.promptId)) {
        if (r.origin?.kind === "human" || (r.origin?.kind === "task-notification" && r.origin.producer === "session-task" && r.promptSource === "system")) turn = r.promptId;
        else if (r.promptId !== turn) turn = "";
      }
      if (r.type === "assistant" && uuid(r.uuid) && turn) assistants.set(r.uuid, turn);
      if (r.type !== "system" || r.subtype !== "turn_duration") continue;
      const original = assistants.get(r.parentUuid); if (!original) continue;
      if (time && time <= i.now + 1000 && !ends.has(original)) ends.set(original, time);
    } else {
      const p = obj(r.payload);
      if (r.type === "event_msg" && p.type === "task_complete" && uuid(p.turn_id) && time && time <= i.now + 1000 && !ends.has(p.turn_id)) ends.set(p.turn_id, time);
    }
  }
  return ends;
}
const diagnostic = (r: Obj) => r.type === "api-request-shape" || r.type === "api-request-blob" || r.type === "api-request";
export function projectSubagents(i: SubagentProjection): SubagentRun[] {
  const ends = parentEnds(i);
  return subagentLaunches(i).map(edge => {
    const { id, call, turn, ...display } = edge;
    const row: SubagentRun = { ...display, key: key(i.backend, i.sessionId, turn, call, id), parentTurn: turn, state: "unknown", expiresAt: edge.startedAt + SUBAGENT_UNKNOWN_MS };
    const completed = (finishedAt: number, ms: number, summary: unknown): SubagentRun => {
      if (!finishedAt || finishedAt > i.now + 1000) return row;
      const end = ends.get(turn);
      // Background children often outlive the parent's yield. Give those a short visible completion;
      // otherwise leave with the proven original parent turn. No wall-clock observation resets this.
      const expiresAt = end && end >= row.startedAt ? (end >= finishedAt ? end : finishedAt + SUBAGENT_COMPLETED_MS) : finishedAt + SUBAGENT_UNKNOWN_MS;
      return { ...row, state: "completed", durationMs: ms, summary: text(summary, 1500), expiresAt };
    };
    const child = i.children.get(id);
    if (!child || !child.records.length || child.records.length > 20000) return row;
    const all = child.records.map(obj), rs = i.backend === "claude-code" ? all.filter(r => !diagnostic(r)) : all;
    let latest = 0;
    if (i.backend === "claude-code") {
      const meta = obj(child.meta);
      if (meta.toolUseId !== call || meta.agentType !== edge.type || meta.spawnDepth !== 1
        // These three captured diagnostic schemas omit cwd/isSidechain. Ignore their payload/activity,
        // retaining their explicit session/child binding and every message/sidechain check below.
        || all.some(r => diagnostic(r) && (r.sessionId !== i.sessionId || r.agentId !== id))
        || rs.some(r => r.sessionId !== i.sessionId || r.cwd !== i.cwd || r.agentId !== id || r.isSidechain !== true)
        || !rs.some(r => r.type === "user" && r.promptId === turn)
        // A later resumed child run must not inherit this spawn's old completion.
        || rs.some(r => r.type === "user" && r.promptId && r.promptId !== turn)) return row;
      for (const r of rs) latest = Math.max(latest, at(r.timestamp));
      if (latest && latest <= i.now + 1000) row.expiresAt = Math.max(row.startedAt, latest) + SUBAGENT_UNKNOWN_MS;
      const completions = i.parent.map(obj).filter(r => r.sessionId === i.sessionId && r.cwd === i.cwd && r.isSidechain === false
        && r.type === "user" && r.origin?.kind === "task-notification" && r.origin.producer === "session-task"
        && r.promptSource === "system" && at(r.timestamp) >= edge.startedAt && typeof r.message?.content === "string")
        .filter(r => tag(r.message.content, "task-id") === id && tag(r.message.content, "tool-use-id") === call);
      const last = completions.at(-1);
      if (last && meta.finished === true && tag(last.message.content, "status") === "completed") {
        const d = tag(last.message.content, "duration_ms"), ms = d !== null && /^\d+(?:\.\d+)?$/.test(d) ? Number(d) : NaN;
        if (duration(ms)) return completed(at(last.timestamp), ms, tag(last.message.content, "result"));
      }
      if (last || meta.finished === true) return row;
    } else {
      const meta = obj(rs.find(r => r.type === "session_meta")).payload;
      const spawn = meta?.source?.subagent?.thread_spawn;
      if (!meta || meta.id !== id || meta.session_id !== i.sessionId || meta.parent_thread_id !== i.sessionId || meta.cwd !== i.cwd || meta.thread_source !== "subagent"
        || !spawn || spawn.parent_thread_id !== i.sessionId || spawn.depth !== 1) return row;
      const starts = rs.filter(r => r.type === "event_msg" && r.payload?.type === "task_started");
      // A resumed child can have new instructions. Do not apply its later result to the original spawn task.
      if (new Set(starts.map(r => r.payload.turn_id)).size !== 1) return row;
      const start = starts.at(-1), t = start?.payload;
      if (!t || !uuid(t.turn_id) || t.turn_attribution?.parent_turn_id !== turn || t.turn_attribution?.root_turn_id !== turn
        || t.root_turn_id !== turn || at(start!.timestamp) < edge.startedAt - 5000) return row;
      row.startedAt = at(start!.timestamp);
      for (const r of rs) latest = Math.max(latest, at(r.timestamp));
      if (latest && latest <= i.now + 1000) row.expiresAt = Math.max(row.startedAt, latest) + SUBAGENT_UNKNOWN_MS;
      const finishes = rs.filter(r => r.type === "event_msg" && r.payload?.type === "task_complete" && at(r.timestamp) >= row.startedAt);
      if (finishes.some(r => r.payload.turn_id !== t.turn_id || r.payload.root_turn_id !== turn)) return row;
      const finished = finishes.at(-1);
      if (finished) {
        const p = finished.payload;
        if (!p.error && at(finished.timestamp) >= row.startedAt && duration(p.duration_ms)) return completed(at(finished.timestamp), p.duration_ms, p.last_agent_message);
        return row;
      }
    }
    // The captured child's first user is written 6–11ms before the async launch result. Binding proves
    // the edge; allow that bounded write ordering, without making an old silent child look live.
    if (i.live && latest >= row.startedAt - 1000 && latest <= i.now + 1000 && i.now - latest <= SUBAGENT_FRESH_MS) row.state = "running";
    return row;
  }).filter(row => row.expiresAt !== undefined && i.now < row.expiresAt);
}
