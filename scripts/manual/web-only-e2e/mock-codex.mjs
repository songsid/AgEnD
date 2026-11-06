// #2910 web-only e2e: a minimal Responses API stand-in for Codex (no account, no network). Every user turn asks to run
// `echo probe` with escalation (so a Codex that asks before acting shows its approval dialog); right after the command's
// output comes back, it answers "ok". Request bodies are logged (BODY_LOG, one per line).
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const port = Number(process.env.PORT || 18762);
const sse = (type, body) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
let n = 0;
createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (process.env.BODY_LOG && req.method === "POST") appendFileSync(process.env.BODY_LOG, raw.replace(/\n/g, " ") + "\n");
    if (req.method === "GET" && req.url.startsWith("/v1/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ models: [] })); return; }
    if (!(req.method === "POST" && req.url.startsWith("/v1/responses"))) { res.writeHead(404); res.end(); return; }
    let body = {}; try { body = JSON.parse(raw); } catch {}
    const last = Array.isArray(body.input) ? body.input.at(-1) : null;
    n++;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sse("response.created", { response: { id: `resp_${n}` } }));
    const item = last?.type === "function_call_output"
      ? { type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text: "ok" }] }
      : { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: "exec_command",
        arguments: JSON.stringify({ cmd: "echo probe", sandbox_permissions: "require_escalated", justification: "Run the web-only e2e probe?" }) };
    res.write(sse("response.output_item.done", { item }));
    res.end(sse("response.completed", { response: { id: `resp_${n}`, usage } }));
  });
}).listen(port, "127.0.0.1");
