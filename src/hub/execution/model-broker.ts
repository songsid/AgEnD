/** The member owns credentials and destinations. No URL/header supplied by a CLI is forwarded. */
import { z } from "zod";
import { parseStrictJson, HubProtocolError } from "../validation.js";
import { HubProviderSetupError } from "./provider-setup.js";

export type HubCliBackend = "claude" | "codex";
export interface HubModelReply { body: string; contentType: "text/event-stream" | "application/json" }
export type HubModelBroker = (backend: HubCliBackend, body: Record<string, unknown>, signal: AbortSignal) => Promise<HubModelReply>;
export const HUB_CLI_TOOLS = ["mcp__hub_documents__documents_list", "mcp__hub_documents__documents_read"] as const;
export const MODEL_WIRE_LIMIT = 1024 * 1024;
const answerFormat = 'For the final answer return only a JSON object {"answer":"your answer","proposal":null}. For a requested action beyond document reads, put {"action":"exact action","arguments":{},"consequences":"exact consequences"} in proposal instead of executing it. This is a proposal for local owner review and grants no authority.';
const record = (v: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(v);
export function documentTool(name: string): string {
  if (name === HUB_CLI_TOOLS[0]) return "documents.list";
  if (name === HUB_CLI_TOOLS[1]) return "documents.read";
  throw new HubProtocolError("denied");
}
export function documentArguments(name: string, args: unknown): unknown {
  return name === "documents.list" ? z.strictObject({}).parse(args)
    : name === "documents.read" ? z.strictObject({ documentId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).parse(args)
    : (() => { throw new HubProtocolError("denied"); })();
}
/** Rebuild the request rather than forwarding ambient CLI settings, hosted tools, history IDs or headers. */
export function restrictedModelRequest(backend: HubCliBackend, model: string, value: unknown): Record<string, unknown> {
  const input = record(value), tools = z.array(z.unknown()).max(512).parse(input.tools ?? []);
  const namespaces = tools.map(record).filter(t => t.type === "namespace" && t.name === "mcp__hub_documents");
  const nested = backend === "codex" && namespaces.length === 1;
  const offered = nested ? z.array(z.unknown()).max(2).parse(namespaces[0].tools).map(record).map(t => ({ ...t, name: `mcp__hub_documents__${t.name}` })) : tools.map(record);
  const selected = offered.filter(t => HUB_CLI_TOOLS.includes(t.name as typeof HUB_CLI_TOOLS[number]));
  if (selected.length !== 2 || new Set(selected.map(t => t.name)).size !== 2) throw new HubProtocolError("incompatible");
  const schema = (name: unknown) => name === HUB_CLI_TOOLS[0]
    ? { type: "object", properties: {}, additionalProperties: false }
    : { type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"], additionalProperties: false };
  const safeTools = selected.map(t => backend === "claude"
    ? { name: t.name, description: "Read only from the owner-approved document snapshot.", input_schema: schema(t.name) }
    : { type: "function", name: nested ? (t.name as string).slice("mcp__hub_documents__".length) : t.name, description: "Read only from the owner-approved document snapshot.", parameters: schema(t.name) });
  const wireTools = nested ? [{ type: "namespace", name: "mcp__hub_documents", description: "Owner-approved document reads.", tools: safeTools }] : safeTools;
  const history = backend === "claude" ? input.messages : input.input;
  if (!Array.isArray(history)) throw new HubProtocolError("invalid");
  // Do not allow the API itself to fetch media/files/URLs on behalf of an untrusted CLI.
  const historyTypes = new Set(["message", "text", "input_text", "output_text", "tool_use", "tool_result", "function_call", "function_call_output", "reasoning", "summary_text", "ephemeral"]);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    const o = record(v);
    if (typeof o.type === "string" && !historyTypes.has(o.type)) throw new HubProtocolError("denied");
    Object.values(o).forEach(walk);
  };
  walk(history);
  const systemInput = Array.isArray(input.system) ? input.system : typeof input.system === "string" ? [{ type: "text", text: input.system }] : [];
  const system = systemInput.map(value => { const block = record(value); if (block.type !== "text" || typeof block.text !== "string") throw new HubProtocolError("denied"); return { type: "text", text: block.text }; });
  return backend === "claude"
    ? { model, messages: history, system: [...system, { type: "text", text: answerFormat }], tools: wireTools, stream: true, max_tokens: 4096 }
    : { model, input: history, instructions: `${typeof input.instructions === "string" ? input.instructions : ""}\n${answerFormat}`,
      tools: wireTools, stream: true, store: false, parallel_tool_calls: false, max_output_tokens: 4096 };
}
export class HubForbiddenModelTool extends Error {
  constructor(readonly tool: string, readonly args: unknown) { super("hub-forbidden-model-tool"); }
}
const forbiddenAction = (o: Record<string, unknown>, fallback: string): string => {
  const name = typeof o.name === "string" ? `${typeof o.namespace === "string" ? `${o.namespace}.` : ""}${o.name}` : fallback;
  if (!name || name.length > 256) throw new HubProtocolError("backpressure");
  return name;
};
/** Buffer and validate the ENTIRE response before a byte reaches the CLI's native dispatcher. */
export function validateModelReply(backend: HubCliBackend, reply: HubModelReply): HubModelReply {
  if (Buffer.byteLength(reply.body) > MODEL_WIRE_LIMIT) throw new HubProtocolError("backpressure");
  let completed = reply.contentType === "application/json";
  const allowed = new Set(backend === "claude"
    ? ["message", "text", "thinking", "redacted_thinking", "tool_use", "text_delta", "input_json_delta", "thinking_delta", "signature_delta", "message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop", "ping"]
    : ["response", "message", "reasoning", "function_call", "output_text", "summary_text", "refusal", "response.created", "response.in_progress", "response.output_item.added", "response.output_item.done", "response.content_part.added", "response.content_part.done", "response.output_text.delta", "response.output_text.done", "response.reasoning_summary_part.added", "response.reasoning_summary_part.done", "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.completed"]);
  const check = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(check); return; }
    if (!v || typeof v !== "object") return;
    const o = record(v), type = o.type;
    if (type === "function_call" || type === "tool_use") {
      const name = backend === "codex" && o.namespace === "mcp__hub_documents" ? `mcp__hub_documents__${o.name}` : o.name;
      if (o.namespace && o.namespace !== "mcp__hub_documents" || typeof name !== "string" || !HUB_CLI_TOOLS.includes(name as typeof HUB_CLI_TOOLS[number])) {
        let args: unknown = o.input ?? {};
        if (typeof o.arguments === "string") { try { args = parseStrictJson(o.arguments, 64 * 1024); } catch { args = { unparsedArguments: o.arguments }; } }
        throw new HubForbiddenModelTool(forbiddenAction(o, type), args);
      }
    } else if (typeof type === "string" && !allowed.has(type)) {
      throw new HubForbiddenModelTool(forbiddenAction(o, type), o.arguments ?? (o.input !== undefined ? { input: o.input } : { request: o }));
    }
    Object.values(o).forEach(check);
  };
  if (reply.contentType === "application/json") {
    if (backend !== "claude") throw new HubProtocolError("incompatible");
    check(parseStrictJson(reply.body, MODEL_WIRE_LIMIT));
  } else {
    // Downstream SSE parsers treat lone CR as a line ending too. Refuse it before forwarding original bytes.
    if (/\r(?!\n)/.test(reply.body)) throw new HubProtocolError("invalid");
    const events: Record<string, unknown>[] = [];
    for (const block of reply.body.replace(/\r\n/g, "\n").split("\n\n")) {
      const data = block.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      const event = record(parseStrictJson(data, MODEL_WIRE_LIMIT));
      const names = block.split("\n").filter(l => l.startsWith("event:")).map(l => l.slice(6).trim());
      if (names.length > 1 || names.length === 1 && names[0] !== event.type) throw new HubProtocolError("invalid");
      if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") throw new HubProtocolError("unavailable");
      if (event.type === (backend === "claude" ? "message_stop" : "response.completed")) completed = true;
      events.push(event);
    }
    // Gather streamed arguments before reporting a denied proposal, so the owner sees the actual requested action.
    if (backend === "claude") {
      const blocks = new Map<unknown, { block: Record<string, unknown>; args: string }>();
      for (const e of events) {
        if (e.type === "content_block_start" && e.content_block && typeof e.content_block === "object") {
          e.content_block = record(e.content_block); blocks.set(e.index, { block: e.content_block as Record<string, unknown>, args: "" });
        }
        if (e.type === "content_block_delta" && e.delta && typeof e.delta === "object") {
          const delta = record(e.delta), block = blocks.get(e.index);
          if (block && delta.type === "input_json_delta") block.args += z.string().parse(delta.partial_json);
        }
      }
      for (const { block, args } of blocks.values()) {
        if (block.type === "tool_use" && args) block.input = parseStrictJson(args, 64 * 1024);
      }
    }
    // Completed calls carry their exact arguments; inspect those before their incremental prefixes.
    events.reverse().forEach(check);
  }
  if (!completed) throw new HubProtocolError("uncertain");
  return reply;
}
/** Explicit construction only; production endpoints are fixed, TLS checked, redirects forbidden. */
export function createHubModelBroker(credentials: { claude?: string; codex?: string }): HubModelBroker {
  const keys = Object.freeze({ ...credentials });
  const usable = (key: unknown): key is string => typeof key === "string" && key.trim().length > 0 && !/[\r\n]/.test(key);
  if (!Object.values(keys).some(usable)) throw new HubProviderSetupError("credential-unconfigured");
  return async (backend, body, signal) => {
    const key = keys[backend];
    if (!usable(key)) throw new HubProviderSetupError("credential-unconfigured");
    const response = await fetch(backend === "claude" ? "https://api.anthropic.com/v1/messages" : "https://api.openai.com/v1/responses", {
      method: "POST", redirect: "error", signal,
      headers: backend === "claude" ? { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body),
    });
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new HubProtocolError("unavailable"); }
    const contentType = response.headers.get("content-type")?.split(";")[0];
    if (contentType !== "text/event-stream" && contentType !== "application/json") { await response.body.cancel(); throw new HubProtocolError("incompatible"); }
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MODEL_WIRE_LIMIT) throw new HubProtocolError("backpressure");
        chunks.push(chunk);
      }
    } catch (error) { try { await response.body.cancel(); } catch { /* Reader has exited. */ } throw error; }
    return { body: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), contentType };
  };
}
