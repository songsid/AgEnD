/**
 * AGEND-181 PR2: the antigravity (agy) and grok transcript parsers for the Log and the chat's activity timeline — in
 * their own module, on the step model and helpers of log-steps.ts (which does not import this file).
 */
import type { LongLine } from "./transcript-jsonl.js";
import {
  RESULT_MAX, StepParser, TEXT_MAX, bodyOf, describeTool, inputOf, isReplyTool, promptAnchor, replyAnchor, replyResult, tsOf,
  type Emission, type LogStep, type StepCat,
} from "./log-steps.js";

/**
 * An antigravity tool-call argument: agy writes each value as JSON text (`"\"echo hi\""` for a string, `"5000"`, an object
 * as its JSON). One level is decoded; a value that is not JSON stays as written.
 */
function agyArg(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}
const AGY_HEADER = /^(?:(?:Created|Completed) At: [^\n]*\n)+/;
const AGY_EXIT = /Command exited with code (-?\d+)/;
/** The `<USER_REQUEST>` agy wraps a prompt in (its metadata and settings blocks follow it; they are not the prompt). */
function agyRequest(content: string): string {
  const m = /<USER_REQUEST>\n?([\s\S]*?)(?:\n?<\/USER_REQUEST>|$)/.exec(content);
  return m ? m[1]! : content;
}

/**
 * antigravity (agy): `brain/<conversation>/.system_generated/logs/transcript.jsonl` (verified on the interactive TUI AgEnD
 * runs and on `agy -p`). One record per step, each with `step_index`: `USER_INPUT` (a prompt, in `<USER_REQUEST>`),
 * `PLANNER_RESPONSE` (the model: `thinking`, `content`, and `tool_calls` — ZERO TO SEVEN of them, each `{ name, args }`
 * with every arg value JSON text), `GENERIC` (a tool's result: `Created At:/Completed At:` header lines, then the
 * output), `SYSTEM_MESSAGE` (not shown), `CHECKPOINT` (a compaction), `ERROR_MESSAGE`.
 *
 * There is no call id. The results come in call order straight after their planner step, so the call number `i` of
 * planner step `P` is answered by step `P + 1 + i` (4,922 of 4,923 calls in 87 local conversations): a call's id is
 * `t<that step_index>`, and a result finds its call by its own `step_index` — even when the call lay before the range
 * parsed. A planner step with no tool call is the turn's last (always followed by a prompt or the end of the file in the
 * same sample), so it ends the turn. The agent's `reply` tool is `call_mcp_tool` with `ServerName` / `ToolName`; its
 * result text is `{"chatId":"web","messageId":"web-…"}`.
 */
export class AntigravityStepParser extends StepParser {
  private turnStart = 0;
  protected record(e: Record<string, unknown>): Emission {
    const ts = tsOf(e.created_at);
    const index = typeof e.step_index === "number" ? e.step_index : -1;
    const content = typeof e.content === "string" ? e.content : "";
    switch (e.type) {
      case "USER_INPUT": {
        const text = agyRequest(content);
        if (!text.trim()) return [];
        const out = this.newTurn(index >= 0 ? `u${index}` : String(this.at >= 0 ? `o${this.at}` : ""));
        this.turnStart = ts;
        const anchor = promptAnchor(text);
        const s = this.add({ kind: "user", ts, ...(anchor ? { anchor } : {}) });
        bodyOf(s, text, TEXT_MAX);
        out.push(s);
        return out;
      }
      case "CHECKPOINT": return [this.add({ kind: "state", ts, note: "compacted" })];
      case "ERROR_MESSAGE": {
        const s = this.add({ kind: "error", ts });
        bodyOf(s, content || String(e.error ?? ""), TEXT_MAX);
        return [s];
      }
      case "PLANNER_RESPONSE": return this.planner(e, index, ts, content);
      case "GENERIC": return index >= 0 ? this.result(e, index, ts, content) : [];
    }
    return [];
  }

  private planner(e: Record<string, unknown>, index: number, ts: number, content: string): Emission {
    const out: LogStep[] = [];
    // AGEND-181: the planner's `thinking` field (about half of the steps carry one) — admin only, like every thinking step.
    if (this.opts.thinking && typeof e.thinking === "string" && e.thinking.trim()) {
      const s = this.add({ kind: "thinking", ts }); bodyOf(s, e.thinking, TEXT_MAX); out.push(s);
    }
    if (content.trim()) { const s = this.add({ kind: "assistant", ts }); bodyOf(s, content, TEXT_MAX); out.push(s); }
    const calls = Array.isArray(e.tool_calls) ? e.tool_calls as Array<Record<string, unknown>> : [];
    calls.forEach((c, i) => {
      const args = (c.args && typeof c.args === "object" ? c.args : {}) as Record<string, unknown>;
      let name = String(c.name ?? "tool");
      let input: unknown = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, agyArg(v)]));
      if (name === "call_mcp_tool") {
        // An MCP tool (AgEnD's own are on the server `agend-fleet`): shown as `mcp__<server>__<tool>`, its arguments are the tool's.
        const server = agyArg(args.ServerName), tool = agyArg(args.ToolName);
        if (typeof server === "string" && typeof tool === "string") { name = `mcp__${server}__${tool}`; input = agyArg(args.Arguments) ?? {}; }
      }
      const anchor = isReplyTool(name) ? replyAnchor(input) : undefined;
      const s = this.add({ id: `t${index + 1 + i}`, kind: "tool", ts, tool: name, ...describeTool(name, input), status: "running", ...(anchor ? { anchor } : {}) });
      inputOf(s, input);
      out.push(s);
    });
    if (!calls.length) {
      // No call: the model's last word for this turn.
      out.push(...this.endOpen("interrupted"));
      out.push(this.add({ kind: "turn_end", ts, ...(this.turnStart && ts >= this.turnStart ? { durationMs: ts - this.turnStart } : {}) }));
    }
    return out;
  }

  private result(e: Record<string, unknown>, index: number, ts: number, content: string): Emission {
    const id = `t${index}`;
    const s = this.close(id) ?? this.add({ id, kind: "tool", ts, tool: "", cat: "other", status: "done" });
    const header = AGY_HEADER.exec(content)?.[0] ?? "";
    const times = [...header.matchAll(/(Created|Completed) At: (\S+)/g)];
    const t0 = tsOf(times.find((m) => m[1] === "Created")?.[2]);
    const t1 = tsOf([...times].reverse().find((m) => m[1] === "Completed")?.[2]);
    if (t0 && t1 && t1 >= t0) s.durationMs = t1 - t0;
    const text = content.slice(header.length);
    const exit = AGY_EXIT.exec(text);
    const failed = e.status === "ERROR" || (exit !== null && exit[1] !== "0");
    // A background command answers with RUNNING and its task id: the call itself is done (the task is not followed).
    s.status = failed ? "failed" : "done";
    if (exit) s.exitCode = Number(exit[1]);
    const out = /\n\nCommand output:\n([\s\S]*)$/.exec(text);
    const body = e.status === "ERROR" && typeof e.error === "string" && e.error ? e.error : out ? out[1]! : text;
    if (body) { bodyOf(s, body, RESULT_MAX); replyResult(s, text); }
    return [{ ...s }];
  }
}

/** A grok `session/update`'s text content (`{ type: "text", text }`), or "". */
function grokText(u: Record<string, unknown>): string {
  const c = u.content as Record<string, unknown> | undefined;
  return c && typeof c.text === "string" ? c.text : "";
}
/** A grok tool result's text: the `content` text blocks and diffs (a diff as its path and the lines it adds), else the MCP output. */
function grokResultText(u: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const c of Array.isArray(u.content) ? u.content as Array<Record<string, unknown>> : []) {
    if (c.type === "content") { const t = grokText(c); if (t) parts.push(t); }
    else if (c.type === "diff") parts.push(`${String(c.path ?? "")}\n${String(c.newText ?? "").split("\n").map((l) => `+ ${l}`).join("\n")}`.trim());
  }
  if (parts.length) return parts.join("\n");
  const raw = u.rawOutput as Record<string, unknown> | undefined;
  const o = raw?.output;
  if (o && typeof o === "object" && !Array.isArray(o)) { const ok = (o as Record<string, unknown>).OkayOutput; if (typeof ok === "string") return ok; }
  if (typeof raw?.output_for_prompt === "string") return raw.output_for_prompt;
  for (const v of raw ? Object.values(raw) : []) if (typeof v === "string" && v !== raw?.type) return v;
  return "";
}
/** grok writes MCP tool names as `<server>__<tool>` (`agend__reply`); shown as the `mcp__<server>__<tool>` the others use. */
const grokMcpName = (n: string): string => (/^[A-Za-z0-9-]+__.+/.test(n) && !n.startsWith("mcp__") ? `mcp__${n}` : n);

/**
 * grok: `~/.grok/sessions/<encodeURIComponent(cwd)>/<session>/updates.jsonl` — ACP `session/update` records (verified on
 * the interactive TUI AgEnD runs): `user_message_chunk` (the delivered prompt), `agent_thought_chunk` (thinking),
 * `agent_message_chunk` (text), `tool_call` / `tool_call_update` (by `toolCallId`: the call, a refinement, then a result
 * with `status`), and `turn_completed` (`stop_reason`, `elapsed_ms`). Chunks of one kind that follow each other are one
 * step. grok's MCP tools go through its `use_tool` (`tool_name` `agend__reply`, `tool_input`), shown as the tool they
 * call. A shell result is `completed` even when it failed: its `exit_code` decides.
 */
export class GrokStepParser extends StepParser {
  /** The run of chunks being joined: it ends at any other record. */
  private run: { kind: "user" | "thinking" | "assistant"; step: LogStep; raw: string; prompt?: number } | null = null;
  private started = new Map<string, number>();
  protected record(e: Record<string, unknown>): Emission {
    const params = e.params as Record<string, unknown> | undefined;
    const u = params?.update as Record<string, unknown> | undefined;
    if (!u || typeof u.sessionUpdate !== "string") return [];
    const meta = params?._meta as Record<string, unknown> | undefined;
    const ts = typeof meta?.agentTimestampMs === "number" ? meta.agentTimestampMs : typeof e.timestamp === "number" ? e.timestamp * 1000 : 0;
    switch (u.sessionUpdate) {
      case "user_message_chunk": return this.chunk("user", grokText(u), ts, u);
      case "agent_message_chunk": return this.chunk("assistant", grokText(u), ts, u);
      case "agent_thought_chunk": return this.opts.thinking ? this.chunk("thinking", grokText(u), ts, u) : this.endRun();
      case "tool_call": { this.endRun(); return this.call(u, ts); }
      case "tool_call_update": { this.endRun(); return this.update(u, ts); }
      case "turn_completed": {
        this.endRun();
        const out = this.endOpen("interrupted");
        const stop = typeof u.stop_reason === "string" ? u.stop_reason : "";
        const s = this.add({ kind: "turn_end", ts, ...(typeof u.elapsed_ms === "number" ? { durationMs: u.elapsed_ms } : {}) });
        if (stop === "cancelled") s.status = "interrupted";
        else if (stop && stop !== "end_turn") { s.status = "failed"; s.note = stop; }
        out.push(s);
        return out;
      }
    }
    return this.endRun();   // background_tasks and the rest: not steps, but they end a run of chunks
  }

  private endRun(): Emission { this.run = null; return []; }

  /** A chunk of text: the first of a run makes the step, the next ones add to it (the step is emitted again, whole). */
  private chunk(kind: "user" | "thinking" | "assistant", text: string, ts: number, u: Record<string, unknown>): Emission {
    if (!text) return [];
    const prompt = kind === "user" ? (u._meta as Record<string, unknown> | undefined)?.promptIndex : undefined;
    // Two prompts in a row (a queued message) are two prompts: grok numbers them.
    if (this.run && this.run.kind === kind && this.run.prompt === (typeof prompt === "number" ? prompt : undefined)) {
      this.run.raw += text;
      if (this.run.raw.length > TEXT_MAX * 4) this.run.raw = this.run.raw.slice(0, TEXT_MAX * 4);   // only the start can be shown
      const s = this.run.step;
      bodyOf(s, this.run.raw, TEXT_MAX);
      if (kind === "user") { const a = promptAnchor(this.run.raw); if (a) s.anchor = a; }
      return [{ ...s }];
    }
    let out: LogStep[] = [];
    if (kind === "user") out = this.newTurn(typeof prompt === "number" ? `p${prompt}` : this.at >= 0 ? `o${this.at}` : "");
    const anchor = kind === "user" ? promptAnchor(text) : undefined;
    const s = this.add({ kind, ts, ...(anchor ? { anchor } : {}) });
    bodyOf(s, text, TEXT_MAX);
    this.run = { kind, step: s, raw: text, ...(typeof prompt === "number" ? { prompt } : {}) };
    return [...out, { ...s }];
  }

  /** The tool a `tool_call` (or its refinement) names: `use_tool` is the MCP tool inside it. */
  private named(u: Record<string, unknown>): { name: string; input: unknown } {
    const raw = (u.rawInput && typeof u.rawInput === "object" ? u.rawInput : {}) as Record<string, unknown>;
    const x = ((u._meta as Record<string, unknown> | undefined)?.["x.ai/tool"] ?? {}) as Record<string, unknown>;
    const name = String(x.name ?? u.title ?? "tool");
    if (name === "use_tool" && typeof raw.tool_name === "string") return { name: grokMcpName(raw.tool_name), input: raw.tool_input ?? {} };
    // The refinement's `variant` is grok's own bookkeeping, not an argument.
    const { variant: _variant, ...input } = raw;
    return { name, input };
  }

  private call(u: Record<string, unknown>, ts: number): Emission {
    const id = String(u.toolCallId ?? "");
    if (!id) return [];
    const { name, input } = this.named(u);
    const anchor = isReplyTool(name) ? replyAnchor(input) : undefined;
    const s = this.add({ id, kind: "tool", ts, tool: name, ...this.describe(name, input, u), status: "running", ...(anchor ? { anchor } : {}) });
    inputOf(s, input);
    if (ts) this.started.set(id, ts);
    return [s];
  }

  /** describeTool, and for a tool it does not know grok's own `kind` (read / edit / execute / search / fetch). */
  private describe(name: string, input: unknown, u: Record<string, unknown>): { cat: StepCat; subject?: string } {
    const d = describeTool(name, input);
    if (d.cat !== "other") return d;
    const kind = String(((u._meta as Record<string, unknown> | undefined)?.["x.ai/tool"] as Record<string, unknown> | undefined)?.kind ?? u.kind ?? "");
    const cat: StepCat | undefined = ({ read: "read", edit: "edit", delete: "edit", move: "edit", execute: "run", search: "search", fetch: "web" } as Record<string, StepCat>)[kind];
    return cat ? { cat } : d;
  }

  private update(u: Record<string, unknown>, ts: number): Emission {
    const id = String(u.toolCallId ?? "");
    if (!id) return [];
    const status = typeof u.status === "string" ? u.status : "";
    const open = this.openTool(id);
    if (!status) {
      // A refinement of a call still running: its arguments are now complete (and use_tool's inner tool is known).
      if (!open) return [];
      const { name, input } = this.named(u);
      const before = JSON.stringify(open);
      open.tool = name; Object.assign(open, this.describe(name, input, u));
      if (isReplyTool(name) && !open.anchor) { const a = replyAnchor(input); if (a) open.anchor = a; }
      inputOf(open, input);
      return JSON.stringify(open) === before ? [] : [{ ...open }];
    }
    const s = this.close(id) ?? this.add({ id, kind: "tool", ts, tool: typeof u.title === "string" ? u.title : "", cat: "other", status: "done" });
    const raw = (u.rawOutput && typeof u.rawOutput === "object" ? u.rawOutput : {}) as Record<string, unknown>;
    const exit = typeof raw.exit_code === "number" ? raw.exit_code : undefined;
    s.status = status === "cancelled" ? "interrupted" : status === "failed" || (exit !== undefined && exit !== 0) ? "failed" : "done";
    if (exit !== undefined) s.exitCode = exit;
    const t0 = this.started.get(id); this.started.delete(id);
    if (t0 && ts >= t0) s.durationMs = ts - t0;
    const text = grokResultText(u);
    if (text) { bodyOf(s, text, RESULT_MAX); replyResult(s, text); }
    return [{ ...s }];
  }

  /** A result too long to parse (a file read): its call completes, with the size. */
  protected override long(head: string, bytes: number): Emission {
    if (!head.includes('"sessionUpdate":"tool_call_update"')) return [];
    const id = /"toolCallId":"([^"]{1,200})"/.exec(head)?.[1];
    const status = /"status":"(completed|failed|cancelled)"/.exec(head)?.[1];
    if (!id || !status) return [];
    const s = this.close(id) ?? this.add({ id, kind: "tool", ts: 0, tool: "", cat: "other", status: "done" });
    s.status = status === "failed" ? "failed" : status === "cancelled" ? "interrupted" : "done";
    s.bodyBytes = bytes;
    return [{ ...s }];
  }
}
