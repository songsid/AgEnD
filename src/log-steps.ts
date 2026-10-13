/**
 * #1218: an instance's work, step by step, for the web Log tab (紀錄) — the step model and the per-backend parsers.
 * Design: issue #1218 comment 6142912335 and the user's decisions after it; docs/design/1218-live-activity.md.
 *
 * A parser turns one backend's transcript records, in file order, into steps: what a person asked (user), what the
 * agent said (assistant — never its thinking), each tool call with its arguments and, once seen, its result (an
 * update of the same step, by id), errors, and where a turn ended. Every string a step carries is masked and
 * bounded HERE, before it leaves this module: known secret shapes and long mixed-case opaque tokens are masked (the
 * user's decision: only actual secret values are hidden, nothing by category), and text is cut with the count of what
 * was cut, so the page can say so. The page renders words from the structured fields (kind, cat, subject), so the
 * labels follow its language.
 *
 * Nothing here reads a file except `readTailRecords` (bounded, async, for an on-demand backfill).
 */
import { open, stat } from "node:fs/promises";
import { LINE_MAX_BYTES, LONG_HEAD_BYTES, lastLineBoundary, type LongLine } from "./transcript-jsonl.js";
import { redactSecrets } from "./tool-progress.js";

export type StepKind = "user" | "assistant" | "tool" | "error" | "turn_end" | "state";
/** What a tool call does, for its icon and words on the page. */
export type StepCat = "read" | "edit" | "search" | "run" | "web" | "mcp" | "agent" | "plan" | "message" | "other";
export type StepStatus = "running" | "done" | "failed" | "interrupted";

export interface LogStep {
  /** Stable for the step's life: a later emission with the same id replaces it (a tool call, then its result). */
  id: string;
  /** The turn it belongs to (1, 2, …, counted from the start of what was read). */
  turn: number;
  /** When the record was written (ms), or 0 when the record has no time. */
  ts: number;
  kind: StepKind;
  /** tool: the CLI's tool name ("Bash", "exec_command", "fs_read"). */
  tool?: string;
  cat?: StepCat;
  /** tool: what it acts on — a path, a command, a pattern, `server:tool` — masked, ≤ SUBJECT_MAX. */
  subject?: string;
  /** tool: its arguments as text (JSON or the command), masked, ≤ INPUT_MAX — the page shows it on demand. */
  input?: string;
  inputCut?: number;
  status?: StepStatus;
  durationMs?: number;
  exitCode?: number;
  /** user / assistant / error text, or a tool's result, masked and cut (≤ TEXT_MAX / RESULT_MAX). */
  body?: string;
  /** Characters cut from `body` (0 or absent: nothing), or the bytes of a result too long to read (`bodyBytes`). */
  bodyCut?: number;
  bodyBytes?: number;
  /** state: what happened ("compacted"); error: a status code. */
  note?: string;
}

export const SUBJECT_MAX = 300;
export const INPUT_MAX = 2000;
export const TEXT_MAX = 4000;
export const RESULT_MAX = 4000;

/* ------------------------------------------------------------------ masking and bounds */

/**
 * A run of 32+ token characters that mixes upper case, lower case and digits — the shape of a base64/random secret.
 * Git SHAs and UUIDs (lower-case hex), long instance names and paths (which have "/") are not masked.
 */
const OPAQUE = /(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])/g;
function looksOpaque(s: string): boolean { return /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s); }

/** Mask secret values in `text`: the bubble's redactor (known key shapes, Bearer, key=value, URL userinfo) + opaque tokens. */
export function maskSecrets(text: string): string {
  return redactSecrets(text).replace(OPAQUE, (m) => (looksOpaque(m) ? "[REDACTED]" : m));
}

/** `text` masked and cut to `max` characters (never inside a surrogate pair), with how many were cut. */
export function bounded(text: string, max: number): { text: string; cut: number } {
  const masked = maskSecrets(text);
  if (masked.length <= max) return { text: masked, cut: 0 };
  let end = max;
  if (/[\uD800-\uDBFF]/.test(masked[end - 1] ?? "")) end--;
  return { text: masked.slice(0, end), cut: masked.length - end };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
function subjectOf(s: unknown): string | undefined {
  if (s == null || s === "") return undefined;
  const t = oneLine(typeof s === "string" ? s : JSON.stringify(s));
  return t ? bounded(t, SUBJECT_MAX).text : undefined;
}
function inputOf(step: LogStep, input: unknown): void {
  if (input == null || input === "") return;
  const raw = typeof input === "string" ? input : JSON.stringify(input, null, 1);
  const b = bounded(raw, INPUT_MAX);
  step.input = b.text;
  if (b.cut) step.inputCut = b.cut;
}
function bodyOf(step: LogStep, text: string, max: number): void {
  const b = bounded(text, max);
  step.body = b.text;
  if (b.cut) step.bodyCut = b.cut;
  else delete step.bodyCut;
}
const tsOf = (v: unknown): number => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : 0; };

/* ------------------------------------------------------------------ tool calls: what they do */

const MCP = /^mcp__(.+?)__(.+)$/;
/** The category and subject of a tool call, from its name and input. An unknown tool: "other", its name. */
export function describeTool(name: string, input: unknown): { cat: StepCat; subject?: string } {
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const mcp = MCP.exec(name);
  if (mcp) {
    const agend = /^agend/.test(mcp[1]!);
    return { cat: agend ? "message" : "mcp", subject: `${mcp[1]}:${mcp[2]}` };
  }
  switch (name) {
    // claude-code
    case "Read": case "NotebookRead": return { cat: "read", subject: subjectOf(inp.file_path ?? inp.notebook_path ?? inp.path) };
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return { cat: "edit", subject: subjectOf(inp.file_path ?? inp.notebook_path ?? inp.path) };
    case "Glob": return { cat: "search", subject: subjectOf(inp.pattern) };
    case "Grep": return { cat: "search", subject: subjectOf([inp.pattern, inp.path].filter(Boolean).join("  in  ")) };
    case "Bash": case "bash": case "shell": case "BashOutput": return { cat: "run", subject: subjectOf(inp.command ?? inp.cmd) };
    case "WebFetch": return { cat: "web", subject: subjectOf(inp.url) };
    case "WebSearch": return { cat: "web", subject: subjectOf(inp.query) };
    case "Task": case "Agent": return { cat: "agent", subject: subjectOf(inp.description ?? inp.subagent_type) };
    case "Skill": return { cat: "other", subject: subjectOf(inp.skill) };
    case "TodoWrite": { const n = Array.isArray(inp.todos) ? inp.todos.length : 0; return { cat: "plan", subject: n ? `${n}` : undefined }; }
    // codex
    case "exec_command": return { cat: "run", subject: subjectOf(inp.cmd ?? inp.command) };
    case "update_plan": return { cat: "plan" };
    case "apply_patch": {
      const text = typeof input === "string" ? input : String(inp.input ?? inp.patch ?? "");
      const files = [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim());
      return { cat: "edit", subject: subjectOf(files.join(", ")) };
    }
    case "exec": {
      // codex's custom tool: a script driving tools.* — name the tools it calls, else its first line.
      const text = typeof input === "string" ? input : "";
      const calls = [...new Set([...text.matchAll(/\btools\.(\w+)\s*\(/g)].map((m) => m[1]!))];
      return { cat: "run", subject: subjectOf(calls.length ? calls.join(", ") : text.split("\n").find((l) => l.trim()) ?? "") };
    }
    // kiro
    case "fs_read": { const ops = inp.operations as Array<Record<string, unknown>> | undefined; return { cat: "read", subject: subjectOf(ops?.[0]?.path ?? inp.path) }; }
    case "fs_write": return { cat: "edit", subject: subjectOf(inp.path) };
    case "execute_bash": case "execute_cmd": return { cat: "run", subject: subjectOf(inp.command) };
    case "web_fetch": case "web_search": return { cat: "web", subject: subjectOf(inp.url ?? inp.query) };
  }
  return { cat: "other" };
}

/* ------------------------------------------------------------------ parsers */

/** What a parser gives back for one record: the steps it created or changed (each a complete, latest copy). */
export type Emission = LogStep[];

abstract class StepParser {
  protected turn = 0;
  private open = new Map<string, LogStep>();
  private n = 0;
  /** Steps in the order they were first seen (updated in place). */
  readonly steps: LogStep[] = [];
  protected abstract record(entry: Record<string, unknown>): Emission;
  /** A record too long to parse: what its head still says (by default nothing). */
  protected long(_head: string, _bytes: number): Emission { return []; }

  /** One transcript line (JSON text) or a long line's head: the steps it created or changed. Malformed: none. */
  push(item: string | LongLine): Emission {
    if (typeof item !== "string") return this.long(item.head, item.bytes);
    let entry: unknown;
    try { entry = JSON.parse(item); } catch { return []; }
    return entry && typeof entry === "object" ? this.record(entry as Record<string, unknown>) : [];
  }

  protected add(step: Omit<LogStep, "id" | "turn"> & { id?: string }): LogStep {
    const s = { ...step, id: step.id ?? `s${++this.n}`, turn: Math.max(1, this.turn) } as LogStep;
    this.steps.push(s);
    if (s.kind === "tool" && s.status === "running") this.open.set(s.id, s);
    return s;
  }
  protected openTool(id: string): LogStep | undefined { return this.open.get(id); }
  protected close(id: string): LogStep | undefined { const s = this.open.get(id); this.open.delete(id); return s; }
  /** A new turn: every tool still running in the last one is interrupted (its result never came). */
  protected newTurn(): Emission {
    const out = this.endOpen("interrupted");
    this.turn++;
    return out;
  }
  protected endOpen(status: StepStatus): Emission {
    const out: LogStep[] = [];
    for (const s of this.open.values()) { s.status = status; out.push({ ...s }); }
    this.open.clear();
    return out;
  }
}

/** A tool result's text: a string, or text blocks joined (an image block says so). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((b) => {
    const blk = b as Record<string, unknown>;
    if (typeof blk.text === "string") return blk.text;
    if (blk.type === "image" || blk.type === "input_image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

/** The start of a JSON string value `"key":"…` in a long line's head, unescaped as far as the head goes. */
function headString(head: string, key: string): string | null {
  const at = head.indexOf(`"${key}":"`);
  if (at < 0) return null;
  let raw = head.slice(at + key.length + 4);
  const end = /(?<!\\)(?:\\\\)*"/.exec(raw);
  if (end) raw = raw.slice(0, end.index + end[0].length - 1);
  raw = raw.replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, "");             // never end inside an escape
  try { return JSON.parse(`"${raw}"`); } catch { return null; }
}

/**
 * claude-code: the JSONL at statusline.json's transcript_path. user: a prompt (string content; `isMeta` records and
 * tool results are not prompts); assistant: `text` (thinking never), `tool_use` (running); a `tool_result` (by
 * `tool_use_id`, `is_error`) completes its call; an API error is an assistant record with `isApiErrorMessage`;
 * `system` `turn_duration` ends a turn, `compact_boundary` is a state.
 */
export class ClaudeStepParser extends StepParser {
  private started = new Map<string, number>();
  protected record(e: Record<string, unknown>): Emission {
    const ts = tsOf(e.timestamp);
    const msg = e.message as Record<string, unknown> | undefined;
    if (e.type === "system") {
      if (e.subtype === "turn_duration") {
        const out = this.endOpen("interrupted");
        out.push(this.add({ kind: "turn_end", ts, ...(typeof e.durationMs === "number" ? { durationMs: e.durationMs } : {}) }));
        return out;
      }
      if (e.subtype === "compact_boundary") return [this.add({ kind: "state", ts, note: "compacted" })];
      return [];
    }
    if (e.type === "assistant" && e.isApiErrorMessage === true) {
      const s = this.add({ kind: "error", ts, ...(typeof e.apiErrorStatus === "number" ? { note: String(e.apiErrorStatus) } : {}) });
      bodyOf(s, resultText(msg?.content) || String(e.error ?? ""), TEXT_MAX);
      return [s];
    }
    if (!msg || (e.type !== "user" && e.type !== "assistant") || e.isSidechain === true) return [];
    const content = msg.content;
    if (e.type === "user") {
      if (e.isMeta === true) return [];
      if (typeof content === "string") {
        if (!content.trim()) return [];
        const out = this.newTurn();
        const cmd = /<command-name>([^<]{1,100})<\/command-name>/.exec(content);
        const s = this.add({ kind: "user", ts });
        bodyOf(s, cmd ? cmd[1]!.trim() : content, TEXT_MAX);
        out.push(s);
        return out;
      }
      const out: LogStep[] = [];
      for (const b of Array.isArray(content) ? content : []) {
        const blk = b as Record<string, unknown>;
        if (blk.type === "tool_result" && typeof blk.tool_use_id === "string") out.push(this.result(blk.tool_use_id, resultText(blk.content), blk.is_error === true, ts));
        else if (blk.type === "text" && typeof blk.text === "string" && blk.text.trim()) {
          const s = this.add({ kind: "user", ts }); bodyOf(s, blk.text, TEXT_MAX); out.push(s);
        }
      }
      return out;
    }
    const out: LogStep[] = [];
    for (const b of Array.isArray(content) ? content : []) {
      const blk = b as Record<string, unknown>;
      if (blk.type === "text" && typeof blk.text === "string" && blk.text.trim()) {
        const s = this.add({ kind: "assistant", ts }); bodyOf(s, blk.text, TEXT_MAX); out.push(s);
      } else if (blk.type === "tool_use" && typeof blk.id === "string") {
        const name = String(blk.name ?? "tool");
        const s = this.add({ id: blk.id, kind: "tool", ts, tool: name, ...describeTool(name, blk.input), status: "running" });
        inputOf(s, blk.input);
        if (ts) this.started.set(blk.id, ts);
        out.push(s);
      }
    }
    return out;
  }

  private result(id: string, text: string, isError: boolean, ts: number, bytes?: number): LogStep {
    const s = this.close(id) ?? this.add({ id, kind: "tool", ts, tool: "", cat: "other", status: "running" });
    s.status = isError ? "failed" : "done";
    const t0 = this.started.get(id); this.started.delete(id);
    if (t0 && ts >= t0) s.durationMs = ts - t0;
    if (bytes !== undefined) { s.bodyBytes = bytes; }
    if (text) bodyOf(s, text, RESULT_MAX);
    return { ...s };
  }

  /** A tool result too long to parse (most long claude lines are): its call completes, with the start of its text. */
  protected override long(head: string, bytes: number): Emission {
    if (!head.includes('"type":"tool_result"')) return [];
    const id = /"tool_use_id":"([^"]{1,200})"/.exec(head)?.[1];
    if (!id) return [];
    const ts = tsOf(/"timestamp":"([^"]{10,40})"/.exec(head)?.[1]);
    return [this.result(id, headString(head, "content") ?? "", false, ts, bytes)];
  }
}

const CODEX_EXIT = /Process exited with code (-?\d+)/;
const CODEX_WALL = /Wall time: ([\d.]+) seconds/;
/**
 * codex: the rollout JSONL. `response_item`: `message` (user / assistant), `function_call` / `custom_tool_call` /
 * `local_shell_call` (running, by `call_id`) and their `*_output` (exec_command's output says its exit code and wall
 * time); `event_msg`: `task_started` (a turn), `task_complete` / `turn_aborted` (its end), and — on versions that
 * write them — `item_completed` items: CommandExecution (a command, with exit code and duration), McpToolCall,
 * FileChange. Their AgentMessage / UserMessage duplicate the response items and are not shown twice; reasoning never.
 */
export class CodexStepParser extends StepParser {
  private started = new Map<string, number>();
  protected record(e: Record<string, unknown>): Emission {
    const ts = tsOf(e.timestamp);
    const p = e.payload as Record<string, unknown> | undefined;
    if (!p) return [];
    if (e.type === "compacted") return [this.add({ kind: "state", ts, note: "compacted" })];
    if (e.type === "event_msg") {
      if (p.type === "task_started") return this.newTurn();
      if (p.type === "task_complete" || p.type === "turn_aborted") {
        const out = this.endOpen("interrupted");
        const s = this.add({ kind: "turn_end", ts, ...(typeof p.duration_ms === "number" ? { durationMs: p.duration_ms } : {}) });
        if (p.type === "turn_aborted") { s.status = "interrupted"; if (typeof p.reason === "string") s.note = p.reason; }
        else if (p.last_agent_message == null) s.status = "failed";
        out.push(s);
        return out;
      }
      if (p.type === "error" && typeof p.message === "string") { const s = this.add({ kind: "error", ts }); bodyOf(s, p.message, TEXT_MAX); return [s]; }
      if (p.type === "item_completed") return this.item(p.item as Record<string, unknown> | undefined, ts);
      return [];
    }
    if (e.type !== "response_item") return [];
    switch (p.type) {
      case "message": {
        const role = p.role;
        if (role !== "user" && role !== "assistant") return [];
        const text = resultText(p.content);
        if (!text.trim() || (role === "user" && /^<(environment_context|user_instructions|permissions)/.test(text.trim()))) return [];
        const out = role === "user" && this.turn === 0 ? this.newTurn() : [];
        const s = this.add({ kind: role, ts }); bodyOf(s, text, TEXT_MAX); out.push(s);
        return out;
      }
      case "function_call": case "custom_tool_call": case "local_shell_call": {
        const id = String(p.call_id ?? p.id ?? "");
        let input: unknown = p.type === "local_shell_call" ? { command: (p.action as Record<string, unknown> | undefined)?.command } : p.type === "custom_tool_call" ? p.input : p.arguments;
        if (typeof input === "string" && p.type === "function_call") { try { input = JSON.parse(input); } catch { /* keep the text */ } }
        const name = p.type === "local_shell_call" ? "shell" : String(p.name ?? "tool");
        if (Array.isArray((input as Record<string, unknown> | null)?.command)) {
          const cmd = (input as { command: unknown[] }).command;
          input = { ...(input as object), command: cmd.map(String).join(" ") };
        }
        const s = this.add({ ...(id ? { id } : {}), kind: "tool", ts, tool: name, ...describeTool(name, input), status: "running" });
        inputOf(s, input);
        if (ts && id) this.started.set(id, ts);
        return [s];
      }
      case "function_call_output": case "custom_tool_call_output": {
        const id = String(p.call_id ?? "");
        const s = this.close(id) ?? this.add({ id: id || undefined, kind: "tool", ts, tool: "", cat: "other", status: "running" });
        const text = resultText(p.output);
        const exit = CODEX_EXIT.exec(text), wall = CODEX_WALL.exec(text);
        s.status = (exit && exit[1] !== "0") || /^failed to /.test(text) ? "failed" : "done";
        if (exit) s.exitCode = Number(exit[1]);
        const t0 = this.started.get(id); this.started.delete(id);
        if (wall) s.durationMs = Math.round(Number(wall[1]) * 1000);
        else if (t0 && ts >= t0) s.durationMs = ts - t0;
        const out = /\nOutput:\n([\s\S]*)$/.exec(text);
        if (text) bodyOf(s, out ? out[1]! : text, RESULT_MAX);
        return [{ ...s }];
      }
    }
    return [];
  }

  private item(it: Record<string, unknown> | undefined, ts: number): Emission {
    if (!it || typeof it.id !== "string") return [];
    const dur = it.duration as { secs?: number; nanos?: number } | undefined;
    const durationMs = dur && typeof dur.secs === "number" ? dur.secs * 1000 + Math.round((dur.nanos ?? 0) / 1e6) : undefined;
    const failed = it.status === "failed" || (typeof it.exit_code === "number" && it.exit_code !== 0);
    const base = { id: it.id, kind: "tool" as const, ts, status: (failed ? "failed" : "done") as StepStatus, ...(durationMs !== undefined ? { durationMs } : {}) };
    switch (it.type) {
      case "CommandExecution": {
        const cmd = Array.isArray(it.command) ? it.command.map(String).join(" ") : String(it.command ?? "");
        const s = this.add({ ...base, tool: "command", cat: "run", subject: subjectOf(cmd), ...(typeof it.exit_code === "number" ? { exitCode: it.exit_code } : {}) });
        const text = String(it.aggregated_output ?? it.formatted_output ?? "");
        if (text) bodyOf(s, text, RESULT_MAX);
        return [s];
      }
      case "McpToolCall": {
        const s = this.add({ ...base, tool: `${it.server}:${it.tool}`, cat: /^agend/.test(String(it.server)) ? "message" : "mcp", subject: subjectOf(`${it.server}:${it.tool}`) });
        inputOf(s, it.arguments);
        const text = resultText((it.result as Record<string, unknown> | undefined)?.content);
        if (text) bodyOf(s, text, RESULT_MAX);
        return [s];
      }
      case "FileChange": {
        const files = Object.keys((it.changes as Record<string, unknown>) ?? {});
        const s = this.add({ ...base, tool: "file_change", cat: "edit", subject: subjectOf(files.join(", ")) });
        const text = [it.stdout, it.stderr].filter((x) => typeof x === "string" && x).join("\n");
        if (text) bodyOf(s, text, RESULT_MAX);
        return [s];
      }
    }
    return [];
  }

  /** A long rollout line: an output completes its call with the start of its text; a call starts by its name. */
  protected override long(head: string, bytes: number): Emission {
    if (!head.includes('"type":"response_item"')) return [];
    const type = /"payload":\{[^{}]{0,400}?"type":"(function_call|custom_tool_call|function_call_output|custom_tool_call_output)"/.exec(head)?.[1];
    const id = /"call_id":"([^"]{1,200})"/.exec(head)?.[1];
    if (!type || !id) return [];
    const ts = tsOf(/"timestamp":"([^"]{10,40})"/.exec(head)?.[1]);
    if (type.endsWith("_output")) {
      const s = this.close(id) ?? this.add({ id, kind: "tool", ts, tool: "", cat: "other", status: "running" });
      s.status = "done"; s.bodyBytes = bytes;
      const text = headString(head, "text") ?? headString(head, "output");
      if (text) bodyOf(s, text, RESULT_MAX);
      return [{ ...s }];
    }
    const name = /"name":"([^"]{1,200})"/.exec(head)?.[1] ?? "tool";
    return [this.add({ id, kind: "tool", ts, tool: name, ...describeTool(name, undefined), status: "running", bodyBytes: bytes })];
  }
}

/* ------------------------------------------------------------------ backfill: the end of a transcript */

export const BACKFILL_MAX_BYTES = 8 * 1024 * 1024;
const BACKFILL_CHUNK = 256 * 1024;

/**
 * The last records of a JSONL transcript, in file order — complete lines, and long lines (over LINE_MAX_BYTES) by
 * their head and size — read backwards in BACKFILL_CHUNK chunks, at most `maxBytes`, stopping once `maxLines` records
 * are held. A record still being written (after the last line end) is not included. `truncated`: older records exist
 * that were not read. Async and bounded — for an on-demand backfill when a Log is opened, never a whole-file read.
 *
 * Of the record that crosses a chunk's left edge only its first LINE_MAX_BYTES + LONG_HEAD_BYTES are kept (with its
 * exact length): enough for a short record whole, or for a long one's head.
 */
export async function readTailRecords(path: string, opts: { maxBytes?: number; maxLines?: number } = {}): Promise<{ records: Array<string | LongLine>; truncated: boolean }> {
  const maxBytes = Math.max(1, opts.maxBytes ?? BACKFILL_MAX_BYTES);
  const maxLines = Math.max(1, opts.maxLines ?? 2000);
  const end = await lastLineBoundary(path);
  const out: Array<string | LongLine> = [];
  if (end === 0) return { records: out, truncated: false };
  const KEEP = LINE_MAX_BYTES + LONG_HEAD_BYTES;
  const fh = await open(path, "r");
  try {
    let pos = end - 1;                 // the last record's line end (excluded); records lie between line ends
    let recEnd = end - 1;              // where the record being assembled ends (its line end)
    let acc: Buffer = Buffer.alloc(0); // its bytes after the current chunk: its first KEEP bytes at most
    let read = 0;
    const emit = (bytes: Buffer, total: number) => { if (total > 0) out.push(toRecord(bytes, total)); };
    while (pos > 0 && read < maxBytes && out.length < maxLines) {
      const length = Math.min(BACKFILL_CHUNK, pos, maxBytes - read);
      const start = pos - length;
      const buf = Buffer.alloc(length);
      for (let filled = 0; filled < length;) {
        const { bytesRead } = await fh.read(buf, filled, length - filled, start + filled);
        if (bytesRead <= 0) throw new Error(`readTailRecords: no progress reading ${path} at ${start + filled}`);
        filled += bytesRead;
      }
      read += length;
      let segEnd = length;
      for (let i = length - 1; i >= 0 && out.length < maxLines; i--) {
        if (buf[i] !== 0x0a) continue;
        const total = recEnd - (start + i + 1);
        emit(Buffer.concat([buf.subarray(i + 1, segEnd), acc]), total);
        acc = Buffer.alloc(0);
        recEnd = start + i;
        segEnd = i;
      }
      if (out.length >= maxLines) { pos = start + segEnd; break; }
      acc = Buffer.concat([buf.subarray(0, segEnd), acc]);
      if (acc.length > KEEP) acc = acc.subarray(0, KEEP);
      pos = start;
    }
    // The first record of the file, when the read reached it.
    if (pos === 0 && out.length < maxLines) { emit(acc, recEnd); recEnd = 0; }
    return { records: out.reverse(), truncated: recEnd > 0 };
  } finally {
    await fh.close();
  }
}

function toRecord(piece: Buffer, bytes: number): string | LongLine {
  if (bytes > LINE_MAX_BYTES) {
    let endAt = Math.min(LONG_HEAD_BYTES, piece.length);
    if (endAt < piece.length) while (endAt > 0 && (piece[endAt]! & 0xc0) === 0x80) endAt--;
    return { at: 0, head: piece.toString("utf-8", 0, endAt), bytes, complete: true };
  }
  return piece.toString("utf-8");
}

/** Parse `records` (file order) with `parser` and return its last `max` steps. */
export function stepsOf(parser: { push(item: string | LongLine): Emission; steps: LogStep[] }, records: Array<string | LongLine>, max = 200): LogStep[] {
  for (const r of records) parser.push(r);
  return parser.steps.slice(-max);
}
