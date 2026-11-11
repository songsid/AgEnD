// Loopback-only Responses mock. Long immediate output reproduces a lost viewport echo.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const sse = (type, value) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    appendFileSync(process.env.MOCK_LOG, `${new Date().toISOString()} ${req.method} ${req.url}\n`);
    if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[{"id":"mock-model"}]}'); return; }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sse("response.created", { response: { id: "response_private2287" } }));
    const text = Array.from({ length: 80 }, (_, i) => `Inert mock diagnostic row ${i + 1}: no external action.`).join("\n");
    res.write(sse("response.output_item.done", { item: { type: "message", role: "assistant", id: "message_private2287", content: [{ type: "output_text", text }] } }));
    res.end(sse("response.completed", { response: { id: "response_private2287", usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 } } }));
  });
}).listen(18882, "127.0.0.1", () => appendFileSync(process.env.MOCK_LOG, "listening\n"));
