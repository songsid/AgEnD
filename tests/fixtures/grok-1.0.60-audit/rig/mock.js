// Local chat-completions / responses mock for the grok audit. Behaviour comes from the last user message.
const http = require("http"), fs = require("fs");
const LOG = process.env.MOCK_LOG || "/out/mock.log";
let n = 0;
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + "\n");
const ERR = { a: 401, b: 402, c: 403, d: 426, e: 429, f: 500, g: 403, h: 429 };
const BODY = {
  a: { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } },
  b: { error: { message: "Weekly usage limit reached", type: "insufficient_quota" } },
  c: { error: { message: "Forbidden", type: "permission_error" } },
  d: { error: { message: "Upgrade required", type: "invalid_request_error" } },
  e: { error: { message: "Rate limit exceeded", type: "rate_limit_error" } },
  f: { error: { message: "Internal server error", type: "server_error" } },
  g: { error: { message: "usage limit reached", type: "invalid_request_error" } },
  h: { error: { message: "rate limit exceeded; too many requests", type: "rate_limit_error" } },
};
function lastUser(body) {
  const msgs = body.messages || body.input || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "user") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (m && m.role === "tool") return "__tool_result__";
  }
  return "";
}
function sse(res, chunks, end = true) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  if (end) { res.write("data: [DONE]\n\n"); res.end(); }
}
const delta = (d, finish = null) => ({ id: "mock", object: "chat.completion.chunk", created: 0, model: "grok-mock", choices: [{ index: 0, delta: d, finish_reason: finish }] });
http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => raw += c);
  req.on("end", () => {
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const tools = (body.tools || []).map(t => t.function ? t.function.name : t.name);
    const text = lastUser(body);
    if (process.env.SCHEMA_LOG && body.tools) for (const t of body.tools) { const f = t.function || t; if (["run_terminal_command", "use_tool", "search_tool"].includes(f.name)) fs.appendFileSync(process.env.SCHEMA_LOG, JSON.stringify(f) + "\n"); }
    log({ t: Date.now(), method: req.method, url: req.url, stream: body.stream, model: body.model, tools: tools.slice(0, 80), toolCount: tools.length, last: text.slice(0, 200), keys: Object.keys(body) });
    if (req.method === "GET" && /models/.test(req.url)) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "grok-mock", object: "model", owned_by: "mock" }] })); return; }
    if (!/chat\/completions/.test(req.url)) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "mock: not here" } })); return; }
    const m = /error turn ([a-h])\b/.exec(text);
    if (m) { res.writeHead(ERR[m[1]], { "content-type": "application/json" }); res.end(JSON.stringify(BODY[m[1]])); return; }
    if (/stall forever/.test(text)) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify(delta({ role: "assistant", content: "" }))}\n\n`); return; }
    if (/please stall/.test(text)) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify(delta({ role: "assistant", content: "" }))}\n\n`); setTimeout(() => { n++; res.write(`data: ${JSON.stringify(delta({ content: `mock reply r${n}` }))}\n\n`); res.write(`data: ${JSON.stringify(delta({}, "stop"))}\n\n`); res.write("data: [DONE]\n\n"); res.end(); }, 8000); return; }
    const tool = /use tool please/.test(text) ? (process.env.TOOL_NAME || "run_terminal_command") : /mcp tool please/.test(text) ? (process.env.MCP_TOOL_NAME || "use_tool") : null;
    if (tool && text !== "__tool_result__") {
      const args = tool === (process.env.MCP_TOOL_NAME || "use_tool") ? (process.env.MCP_TOOL_ARGS || "{}") : (process.env.TOOL_ARGS || JSON.stringify({ command: "echo tool-ok-marker" }));
      sse(res, [delta({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_mock1", type: "function", function: { name: tool, arguments: "" } }] }), delta({ tool_calls: [{ index: 0, function: { arguments: args } }] }), delta({}, "tool_calls")]);
      return;
    }
    // Side requests (title, next-prompt suggestion) carry no tools: answer them empty, as the 1.0.52 captures show.
    if (!tools.length) { sse(res, [delta({ role: "assistant", content: "" }), delta({}, "stop")]); return; }
    n++;
    sse(res, [delta({ role: "assistant", content: "" }), delta({ content: text === "__tool_result__" ? `tool done r${n}` : `mock reply r${n}` }), delta({}, "stop"), { id: "mock", object: "chat.completion.chunk", created: 0, model: "grok-mock", choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }]);
  });
}).listen(18080, "127.0.0.1", () => log({ t: Date.now(), up: true }));
