// #581 e2e: a minimal Anthropic Messages API for the container round trip — no real account. A turn whose request
// offers AgEnD's MCP `reply` tool and ends with a user text is answered by calling that tool with
// "pong: <the message>"; the tool's result ends the turn. Anything else (title/summary requests) gets a short text.
// Every request is logged as one JSON line to stdout. Usage: node mock-anthropic.mjs [port]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8080);
let seq = 0;
// The newest message a person sent (AgEnD's inbound line `[user:… via …] <text>`), and what the assistant did after it.
const turnOf = (messages = []) => {
  const msgs = messages.filter(m => m.role !== "system");
  const parts = m => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? []);
  let at = -1, said = null;
  msgs.forEach((m, i) => {
    if (m.role !== "user") return;
    for (const p of parts(m)) {
      const hit = p.type === "text" && /\[user:[^\]]*\]\s*([^\n]*)/.exec(p.text);
      if (hit) { at = i; said = hit[1].trim().slice(0, 200); }
    }
  });
  const after = at < 0 ? [] : msgs.slice(at + 1).flatMap(m => (m.role === "assistant" ? parts(m) : []));
  const called = name => after.some(p => p.type === "tool_use" && name.test(p.name ?? ""));
  return { said, replied: called(/(^|__)reply$/), searched: called(/^ToolSearch$/) };
};
const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
};
createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
    if (req.url.startsWith("/v1/messages/count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"input_tokens":10}'); return; }
    let msg = {};
    try { msg = JSON.parse(body); } catch { /* answered as text */ }
    const reply = (msg.tools ?? []).find(t => /(^|__)reply$/.test(t.name ?? ""));
    const search = (msg.tools ?? []).find(t => t.name === "ToolSearch");
    const turn = turnOf(msg.messages);
    const id = `msg_${++seq}`;
    const usage = { input_tokens: 10, output_tokens: 5 };
    const start = ["message_start", { message: { id, type: "message", role: "assistant", model: msg.model ?? "mock", content: [], stop_reason: null, usage } }];
    const call = (name, input) => {
      console.log(JSON.stringify({ at: new Date().toISOString(), kind: "tool_use", tool: name, input }));
      sse(res, [start,
        ["content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${seq}`, name, input: {} } }],
        ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
        ["content_block_stop", { index: 0 }],
        ["message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }],
        ["message_stop", {}]]);
    };
    // A person's message not answered yet: reply with the tool (loading it through ToolSearch first when deferred).
    if (turn.said && !turn.replied && msg.stream) {
      if (reply) { call(reply.name, { text: `pong: ${turn.said}` }); return; }
      if (search && !turn.searched) { call("ToolSearch", { query: "select:mcp__agend__reply", max_results: 1 }); return; }
    }
    console.log(JSON.stringify({ at: new Date().toISOString(), kind: "text", tools: (msg.tools ?? []).map(t => t.name), last: JSON.stringify(msg.messages?.[msg.messages.length - 1] ?? null).slice(0, 300) }));
    if (!msg.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, type: "message", role: "assistant", model: msg.model ?? "mock", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage }));
      return;
    }
    sse(res, [start,
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }],
      ["content_block_stop", { index: 0 }],
      ["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
      ["message_stop", {}]]);
  });
}).listen(port, "0.0.0.0", () => console.log(JSON.stringify({ listening: port })));
