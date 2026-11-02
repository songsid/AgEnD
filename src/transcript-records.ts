/** Provider record grammar only. No filesystem, SQLite, backend construction or account access. */
import type { TranscriptEvents } from "./transcript-sources.js";
import type { TranscriptTurnEvent } from "./transcript-turns.js";
export type TranscriptRecordEvent =
  | ["tool_use", string, unknown] | ["tool_result", string, unknown]
  | ["assistant_text", string] | ["system_informational", string]
  | ["api_error", string, number | null, number | null, string | null] | ["user_prompt"];
export interface CodexRecordState { openTurnId: string; openTurn: string | null; turnKnown: boolean }
const CODE_MODE_HOST_SPAWN_FAILED = /^failed to spawn code-mode host (\/[^\n]*)\/bin\/codex-code-mode-host: No such file or directory \(os error 2\)$/;

/** The package root a rollout tool output reports a missing code-mode host under, or null. */
export function codexCodeModeHostMissingRoot(output: unknown): string | null {
  return typeof output === "string" ? CODE_MODE_HOST_SPAWN_FAILED.exec(output)?.[1] ?? null : null;
}

export function codexTurnRecord(entry: Record<string, unknown>, state: CodexRecordState, turns: TranscriptTurnEvent[]): boolean {
    const p = entry.payload as Record<string, unknown> | undefined;
    if (!p) return false;
    if (entry.type === "event_msg") {
      if (p.type === "task_started" && typeof p.turn_id === "string") {
        state.openTurnId = p.turn_id;
        state.openTurn = p.turn_id;
        state.turnKnown = true;
        turns.push({ kind: "start", turnId: p.turn_id });
      } else if ((p.type === "task_complete" || p.type === "turn_aborted") && typeof p.turn_id === "string") {
        const end = p.type === "turn_aborted" ? "aborted" : p.last_agent_message == null ? "error" : "complete";
        if (state.openTurn === p.turn_id) state.openTurn = null;
        state.turnKnown = true;
        turns.push({ kind: "end", turnId: p.turn_id, end });
      }
      return true;
    }
    if (entry.type === "response_item" && p.type === "message" && p.role === "user") {
      const text = (p.content as Array<Record<string, unknown>> | undefined ?? [])
        .map(block => typeof block.text === "string" ? block.text : "").join("\n");
      const at = Date.parse(String(entry.timestamp ?? ""));
      if (text.trim() && Number.isFinite(at)) turns.push({ kind: "user", turnId: state.openTurnId, text, at });
      return true;
    }
    return false;
}
export function codexToolRecord(entry: Record<string, unknown>, events: TranscriptEvents): void {
  const p = entry.payload as Record<string, unknown> | undefined;
  if (!p || entry.type !== "response_item") return;
      if (p.type === "function_call") {
        let input: unknown = p.arguments;
        if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* keep raw */ } }
        events.toolUses.push({ name: String(p.name ?? "unknown"), input });
      } else if (p.type === "custom_tool_call") {
        events.toolUses.push({ name: String(p.name ?? "unknown"), input: p.input });
      } else if (p.type === "local_shell_call") {
        const action = p.action as Record<string, unknown> | undefined;
        events.toolUses.push({ name: "shell", input: { command: action?.command } });
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        events.toolResults.push({ name: String(p.name ?? "unknown") });
        const root = codexCodeModeHostMissingRoot(p.output);
        if (root) (events.codexPackageMissingHost ??= []).push(root);
      } else if (p.type === "message" && p.role === "assistant") {
        const content = p.content as Array<Record<string, unknown>> | undefined;
        for (const block of content ?? []) {
          const text = block.text;
          if (typeof text === "string" && text.trim()) events.assistantTexts.push(text);
        }
      }
}
export function codexWholeLine(head: string): boolean {
  return head.includes('"type":"event_msg"') || (head.includes('"type":"response_item"') && /"payload":\{"type":"message"/.test(head));
}

/**
 * #1218 P0: a rollout line too long to parse (an output of MBs, a huge call input) — what its head still says, so the
 * bubble keeps the step: a call by its name, or an output. Turn records and messages are read whole (codexWholeLine).
 */
export function codexLongHead(head: string, events: TranscriptEvents): void {
  if (!head.includes('"type":"response_item"')) return;
  const type = /"payload":\{[^{}]{0,400}?"type":"(function_call|custom_tool_call|function_call_output|custom_tool_call_output)"/.exec(head)?.[1];
  if (type === "function_call" || type === "custom_tool_call") {
    const name = /"name":"([^"]{1,200})"/.exec(head)?.[1];
    events.toolUses.push({ name: name ?? "unknown", input: undefined });
  } else if (type) events.toolResults.push({ name: "unknown" });
}

export function claudeTranscriptRecord(entry: any, emit: (...event: TranscriptRecordEvent) => void): void {
    // #2834: Claude's own status notes (e.g. its usage-limit auto-continue) — a system record, not model output.
    if (entry.type === "system" && entry.subtype === "informational" && typeof entry.content === "string") {
      emit("system_informational", entry.content);
      return;
    }
    const msg = entry.message;
    if (!msg?.role || !msg?.content) return;
    // #2822: Claude records a failed API call as an assistant record of its own (`isApiErrorMessage`) — the CLI's own
    // error, not model output: told as "api_error", never as "assistant_text".
    if (entry.type === "assistant" && entry.isApiErrorMessage === true) {
      const text = Array.isArray(msg.content)
        ? msg.content.map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("")
        : String(msg.content);
      const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      emit("api_error", text, typeof entry.apiErrorStatus === "number" ? entry.apiErrorStatus : null, Number.isFinite(at) ? at : null,
        typeof entry.error === "string" ? entry.error : null);
      return;
    }

    // #2822: a prompt (a person's message, a system notice; a string, or text/image blocks) — never a meta record or a
    // tool result. The point a later API error is judged against.
    if (entry.type === "user" && entry.isMeta !== true && (typeof msg.content === "string"
      ? msg.content.trim() !== ""
      : Array.isArray(msg.content) && msg.content.length > 0 && msg.content.every((b: any) => b?.type === "text" || b?.type === "image"))) {
      emit("user_prompt");
    }
    const contents = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];

    for (const block of contents) {
      if (block.type === "tool_use") {
        emit("tool_use", block.name ?? "unknown", block.input ?? {});
      } else if (block.type === "tool_result") {
        emit("tool_result", block.tool_use_id ?? "unknown", block.content);
      } else if (block.type === "text" && msg.role === "assistant" && block.text?.trim()) {
        emit("assistant_text", block.text);
      }
    }
}
export function claudeTranscriptLongHead(head: string, emit: (...event: TranscriptRecordEvent) => void): void {
    if (head.includes('"type":"tool_result"')) {
      for (const m of head.matchAll(/"tool_use_id":"([^"]{1,200})"/g)) emit("tool_result", m[1], undefined);
    }
    for (const m of head.matchAll(/"type":"tool_use"/g)) {
      const name = /"name":"([^"]{1,200})"/.exec(head.slice(m.index, m.index + 400));
      if (name) emit("tool_use", name[1], {});
    }
}
