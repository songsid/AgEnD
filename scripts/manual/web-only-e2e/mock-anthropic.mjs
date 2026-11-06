// #2910 web-only e2e (scripts/manual/web-only-e2e): a minimal Anthropic Messages API stand-in — no real account, no
// network. Each turn's last user text picks the answer:
//   "PERM-2910 <file>"            → a Bash tool_use `touch /home/rh/w/lead/<file>` (Claude Code asks first when its
//                                    permission mode asks);
//   "STATUS-2910"                 → AgEnD's delivery_status on the message's own agend-human-id (its receipt);
//   "SEND-2910 to <name>: <text>" → AgEnD's send_to_instance;
//   "PING-2377 #<n>"              → AgEnD's reply tool with "PONG-2377 #<n>";
//   a tool_result                 → a short closing text; anything else → a short text.
// Every request is logged (MOCK_LOG, one JSON line each: the last user text, any tool_result's text).
import http from "node:http";
import { appendFileSync } from "node:fs";
const LOG = process.env.MOCK_LOG || "requests.log";
let n = 0;
function lastUser(body) {
  for (const m of [...(body.messages || [])].reverse()) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return { text: m.content, toolResult: false };
    const parts = m.content || [];
    const texts = parts.filter(p => p.type === "text").map(p => p.text || "");
    const results = parts.filter(p => p.type === "tool_result").map(p => typeof p.content === "string" ? p.content : JSON.stringify(p.content || ""));
    return { text: texts.at(-1) || "", toolResult: parts.some(p => p.type === "tool_result"), resultText: results.join(" ").slice(0, 4000) };
  }
  return { text: "", toolResult: false, resultText: "" };
}
http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => raw += c).on("end", () => {
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const { text, toolResult, resultText } = lastUser(body);
    const tools = (body.tools || []).map(t => t.name);
    appendFileSync(LOG, JSON.stringify({ t: Date.now(), method: req.method, path: req.url, last: text.slice(-160), first: text.slice(0, 400), toolResult, resultText, replyTool: tools.find(t => /reply$/.test(t)) || null }) + "\n");
    const json = (code, obj) => { const d = JSON.stringify(obj); res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(d) }); res.end(d); };
    if (req.method === "GET" && req.url.startsWith("/v1/models")) return json(200, { data: [{ id: "claude-sonnet-4-5", type: "model", display_name: "Sonnet" }], has_more: false });
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) return json(200, {});
    if (req.url.includes("count_tokens")) return json(200, { input_tokens: 100 });
    n++;
    const replyTool = tools.find(t => /^mcp__agend.*__reply$/.test(t)) || "mcp__agend__reply";
    let blocks, stop = "end_turn";
    const sendTo = /SEND-2910 to ([A-Za-z0-9._-]+): (.+)/.exec(text);
    if (toolResult) blocks = [{ type: "text", text: "sent" }];
    else if (/PERM-2910 (\S+)/.test(text)) {
      // #2910 PR5: a real Bash tool call — with permissions not bypassed, Claude Code asks the person in its own dialog.
      const file = /PERM-2910 (\S+)/.exec(text)[1];
      const bashTool = tools.find(t => t === "Bash") || "Bash";
      blocks = [{ type: "tool_use", id: `toolu_${n}`, name: bashTool, input: { command: `touch /home/rh/w/lead/${file}`, description: "Create a marker file" } }]; stop = "tool_use";
    }
    else if (text.includes("STATUS-2910")) {
      const all = JSON.stringify(([...(body.messages || [])].reverse().find(m => m.role === "user") || {}).content || "");
      const id = /agend-human-id:([A-Za-z0-9_-]+)/.exec(all)?.[1] || "none";
      const statusTool = tools.find(t => /^mcp__agend.*__delivery_status$/.test(t)) || "mcp__agend__delivery_status";
      blocks = [{ type: "tool_use", id: `toolu_${n}`, name: statusTool, input: { message_id: id } }]; stop = "tool_use";
    }
    else if (sendTo) {
      const sendTool = tools.find(t => /^mcp__agend.*__send_to_instance$/.test(t)) || "mcp__agend__send_to_instance";
      blocks = [{ type: "tool_use", id: `toolu_${n}`, name: sendTool, input: { instance_name: sendTo[1], message: sendTo[2].trim() } }]; stop = "tool_use";
    }
    else if (text.includes("PING-2377")) {
      // Every numbered ping in the turn's user message (messages queued while busy arrive merged): one reply names them all.
      const all = JSON.stringify(([...(body.messages || [])].reverse().find(m => m.role === "user") || {}).content || "");
      const nums = [...new Set([...all.matchAll(/PING-2377 #(\d+)/g)].map(m => m[1]))];
      blocks = [{ type: "tool_use", id: `toolu_${n}`, name: replyTool, input: { text: `PONG-2377${nums.map(x => ` #${x}`).join("")}` } }]; stop = "tool_use";
    }
    else blocks = [{ type: "text", text: `mock reply ${n}` }];
    if (!body.stream) return json(200, { id: `msg_${n}`, type: "message", role: "assistant", model: body.model || "claude-sonnet-4-5", content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 5 } });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
    const ev = (name, obj) => res.write(`event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`);
    ev("message_start", { type: "message_start", message: { id: `msg_${n}`, type: "message", role: "assistant", model: body.model || "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } });
    blocks.forEach((b, i) => {
      if (b.type === "text") {
        ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } });
      } else {
        ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
        ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
      }
      ev("content_block_stop", { type: "content_block_stop", index: i });
    });
    ev("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
    ev("message_stop", { type: "message_stop" });
    res.end();
  });
}).listen(Number(process.argv[2] || 18300), "127.0.0.1");
