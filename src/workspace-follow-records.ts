/** File metadata in provider record order. Never retains commands, patterns, result text or edit contents. */
import { followStepOf, FOLLOW_LIMITS, type FollowStepInput } from "./workspace-follow-parse.js";

export type FollowObservation =
  | { type: "turn" }
  | { type: "call"; id: string; step: FollowStepInput }
  | { type: "done"; id: string; failed: boolean; paths?: string[]; editLines?: number[] };
const idOf = (v: unknown): string | null => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f]/.test(v) ? v : null;

/** Claude 2.1.319's recorded structuredPatch; keep only numbers, never its line text. */
function editLinesOf(patches: unknown): number[] | undefined {
  if (!Array.isArray(patches) || !patches.length || patches.length > 32) return undefined;
  const lines = new Set<number>();
  for (const p of patches) {
    if (!Number.isSafeInteger(p?.newStart) || p.newStart < 0 || !Array.isArray(p.lines) || p.lines.length > 10000) return undefined;
    let at = p.newStart;
    for (const line of p.lines) {
      if (typeof line !== "string") return undefined;
      if (line.startsWith("+")) { lines.add(Math.max(1, at)); at++; }
      else if (line.startsWith("-")) lines.add(Math.max(1, at));
      else if (line.startsWith(" ")) at++;
      if (lines.size > 2048 || at > 1048576) return undefined;
    }
  }
  return [...lines];
}

export function claudeFollowRecords(entry: any): FollowObservation[] {
  if (entry.isSidechain === true || entry.isApiErrorMessage === true) return [];
  const msg = entry.message;
  if (!msg?.role || !msg.content) return [];
  const contents = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
  const out: FollowObservation[] = [];
  if (entry.type === "user" && entry.isMeta !== true && contents.length && contents.every((b: any) => b?.type === "text" || b?.type === "image")) out.push({ type: "turn" });
  for (const b of contents) {
    if (msg.role === "assistant" && b?.type === "tool_use") {
      const id = idOf(b.id), step = followStepOf(String(b.name), b.input);
      if (id && step?.paths.length) out.push({ type: "call", id, step: { ...step, ...(step.cwd === undefined && typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}) } });
    } else if (msg.role === "user" && b?.type === "tool_result") {
      const id = idOf(b.tool_use_id);
      if (!id) continue;
      // Only the provider's explicit filename array, never grep's lines of matching text.
      const names = entry.toolUseResult?.filenames;
      const paths = Array.isArray(names) ? names.filter((p): p is string => typeof p === "string" && p.length <= FOLLOW_LIMITS.pathChars && !/[\u0000-\u001f]/.test(p)).slice(0, FOLLOW_LIMITS.pathsPerStep) : undefined;
      const editLines = editLinesOf(entry.toolUseResult?.structuredPatch);
      out.push({ type: "done", id, failed: b.is_error === true, ...(paths?.length ? { paths } : {}), ...(editLines ? { editLines } : {}) });
    }
  }
  return out;
}

export function codexFollowRecords(entry: Record<string, any>): FollowObservation[] {
  const p = entry.payload;
  if (!p) return [];
  if (entry.type === "event_msg" && p.type === "task_started" && idOf(p.turn_id)) return [{ type: "turn" }];
  if (entry.type !== "response_item") return [];
  if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
    let input: unknown = p.type === "custom_tool_call" ? p.input : p.type === "local_shell_call" ? p.action : p.arguments;
    if (p.type === "function_call" && typeof input === "string") { try { input = JSON.parse(input); } catch { return []; } }
    const id = idOf(p.call_id), step = followStepOf(p.type === "local_shell_call" ? "local_shell" : String(p.name), input);
    return id && step?.paths.length ? [{ type: "call", id, step }] : [];
  }
  if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
    const id = idOf(p.call_id);
    const header = typeof p.output === "string" ? p.output.split("\nOutput:", 1)[0]!.slice(0, 1024) : "";
    const code = /(?:Process exited with code |Exit code: )(\d+)/.exec(header)?.[1];
    return id ? [{ type: "done", id, failed: p.is_error === true || (code !== undefined && code !== "0") || /^unsupported (?:custom )?tool call:/.test(header) }] : [];
  }
  return [];
}
