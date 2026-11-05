/** Scripted model content only; this module opens no listener and never calls a real API. */
import type { HubCliBackend, HubModelReply } from "../../../src/hub/execution/model-broker.js";
export type MockOutput = { text: string } | { tool: string; args: unknown; namespace?: string } | { custom: string; input: string };
const event = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
export function mockReply(backend: HubCliBackend, output: MockOutput, n: number): HubModelReply {
  if (backend === "claude") {
    if ("custom" in output) throw Error("custom is Codex only");
    const tool = "tool" in output;
    return { contentType: "text/event-stream", body:
      event("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } })
      + event("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `call_${n}`, name: output.tool, input: {} } : { type: "text", text: "" } })
      + event("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(output.args) } : { type: "text_delta", text: output.text } })
      + event("content_block_stop", { index: 0 })
      + event("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }) + event("message_stop", {}) };
  }
  const item = "custom" in output ? { type: "custom_tool_call", id: `fc_${n}`, call_id: `call_${n}`, name: output.custom, input: output.input }
    : "tool" in output ? { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: output.tool, ...(output.namespace ? { namespace: output.namespace } : {}), arguments: JSON.stringify(output.args) }
    : { type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text: output.text }] };
  return { contentType: "text/event-stream", body: event("response.created", { response: { id: `resp_${n}` } })
    + event("response.output_item.done", { item })
    + event("response.completed", { response: { id: `resp_${n}`, usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 } } }) };
}
export function approvedCall(backend: HubCliBackend, name: "list" | "read", args: unknown): MockOutput {
  return backend === "claude" ? { tool: `mcp__hub_documents__documents_${name}`, args }
    : { tool: `documents_${name}`, namespace: "mcp__hub_documents", args };
}
export const finalOutput = (answer: string, proposal: unknown = null): MockOutput => ({ text: JSON.stringify({ answer, proposal }) });
