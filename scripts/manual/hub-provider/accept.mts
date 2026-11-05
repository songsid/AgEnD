/** Real pinned CLIs; disposable network-none containers; mock model replies, no real account/key. */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createHubCliProvider } from "../../../src/hub/execution/cli-provider.js";
import { HUB_CLI_TOOLS, type HubCliBackend, type HubModelReply } from "../../../src/hub/execution/model-broker.js";

const imageId = process.env.IMAGE_ID ?? readFileSync(".artifacts/hub-s4b-work/image-config-id", "utf8").trim();
const out = process.env.OUT ?? ".artifacts/hub-s4b-work/acceptance"; mkdirSync(out, { recursive: true });
const sse = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const results: unknown[] = [];
const finalText = JSON.stringify({ answer: "APPROVED ANSWER", proposal: null });
for (const backend of (process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex"]) as HubCliBackend[]) {
  const bodies: Record<string, unknown>[] = [], reads: unknown[] = [];
  let turn = 0;
  const provider = await createHubCliProvider({ backend, imageId, model: backend === "claude" ? "claude-sonnet-4-5" : "mock-model",
    modelBroker: async (_backend, body): Promise<HubModelReply> => {
      bodies.push(body); writeFileSync(`${out}/${backend}-requests.json`, JSON.stringify(bodies, null, 2));
      const n = ++turn;
      const wireTools = body.tools as { type: string; name: string; tools?: { name: string }[] }[];
      const nested = wireTools.length === 1 && wireTools[0].type === "namespace";
      assert.deepEqual((nested ? wireTools[0].tools!.map(t => `mcp__hub_documents__${t.name}`) : wireTools.map(t => t.name)).sort(), [...HUB_CLI_TOOLS].sort());
      const tool = n === 1 ? HUB_CLI_TOOLS[0] : n === 2 ? HUB_CLI_TOOLS[1] : null;
      const args = n === 1 ? {} : { documentId: "approved-note" };
      if (backend === "claude") {
        const block = tool ? { type: "tool_use", id: `call_${n}`, name: tool, input: {} } : { type: "text", text: "" };
        return { contentType: "text/event-stream", body:
          sse("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } })
          + sse("content_block_start", { index: 0, content_block: block })
          + sse("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(args) } : { type: "text_delta", text: finalText } })
          + sse("content_block_stop", { index: 0 })
          + sse("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })
          + sse("message_stop", {}) };
      }
      const item = tool ? { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: nested ? tool.slice("mcp__hub_documents__".length) : tool, ...(nested ? { namespace: "mcp__hub_documents" } : {}), arguments: JSON.stringify(args) }
        : { type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text: finalText }] };
      return { contentType: "text/event-stream", body: sse("response.created", { response: { id: `resp_${n}` } })
        + sse("response.output_item.done", { item })
        + sse("response.completed", { response: { id: `resp_${n}`, usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 } } }) };
    } });
  try {
    const session = await provider.open({ contextId: randomUUID(), question: "List the approved documents, read approved-note, then answer.", label: "External Hub identity; no local authority.", signal: new AbortController().signal, beforeInput: () => {} });
    const text = await session.answer({ invoke: async (name, args) => { reads.push({ name, args }); return name === "documents.list" ? [{ id: "approved-note", title: "Approved" }] : { id: "approved-note", title: "Approved", text: "APPROVED DOCUMENT" }; }, propose: async () => { throw Error("unexpected proposal"); } });
    assert.equal(text, "APPROVED ANSWER"); assert.deepEqual(reads, [{ name: "documents.list", args: {} }, { name: "documents.read", args: { documentId: "approved-note" } }]);
    await session.close(); results.push({ backend, positive: true, calls: bodies.length, reads }); console.log(`PASS ${backend} real-CLI document read/answer`);
  } finally { await provider.close(); }
}
writeFileSync(`${out}/result.json`, JSON.stringify({ imageId, results }, null, 2));
