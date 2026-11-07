import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const sse = (type, value) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
createServer((req, res) => {
  let raw = ""; req.on("data", c => { raw += c; }); req.on("end", () => {
    appendFileSync(process.env.RIG_ROOT + "/api.jsonl", JSON.stringify({ method: req.method, url: req.url }) + "\n");
    if (req.method !== "POST" || !req.url.startsWith("/v1/responses")) { res.writeHead(404); res.end(); return; }
    const done = /"function_call_output"/.test(raw);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse("response.created", { response: { id: "resp_quota" } }));
    const item = done
      ? { type: "message", role: "assistant", id: "msg_quota", content: [{ type: "output_text", text: "Fixture usage read: 8% weekly remaining." }] }
      : { type: "function_call", id: "fc_quota", call_id: "call_quota", namespace: "mcp__quota", name: "get_usage", arguments: "{}" };
    res.write(sse("response.output_item.done", { item }));
    res.end(sse("response.completed", { response: { id: "resp_quota", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }));
  });
}).listen(18791, "127.0.0.1");
