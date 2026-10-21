// Mock Responses API for codex version audits. The mode is read from $MOCK_MODE_FILE on every request, so one
// running codex can be walked through ok / slow / near-limit / usage-limit / 401 / 500 / capacity turns.
import { createServer } from "node:http";
import { readFileSync, appendFileSync } from "node:fs";
const port = Number(process.env.PORT || 18762);
const modeFile = process.env.MOCK_MODE_FILE;
const log = process.env.MOCK_LOG;
const mode = () => { try { return readFileSync(modeFile, "utf8").trim() || "ok"; } catch { return "ok"; } };
const sse = (type, body) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
const limitHeaders = (used) => ({
  "x-codex-primary-used-percent": String(used), "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 3600),
  "x-codex-secondary-used-percent": String(used), "x-codex-secondary-window-minutes": "10080",
  "x-codex-secondary-reset-at": String(Math.floor(Date.now() / 1000) + 86400),
});
createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    const m = mode();
    if (log) appendFileSync(log, `${new Date().toISOString()} ${req.method} ${req.url} mode=${m}\n`);
    // BODY_LOG: every request body, one per line (tool-schema-codex-2155 reads the tool declarations codex sends).
    if (process.env.BODY_LOG && req.method === "POST") appendFileSync(process.env.BODY_LOG, body.replace(/\n/g, " ") + "\n");
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ models: [] })); return;
    }
    if (!(req.method === "POST" && req.url.startsWith("/v1/responses"))) { res.writeHead(404); res.end(); return; }
    // #2282: transient429 exhaustion and account quota are different Codex errors.
    if (m === "e429" || m === "insufficient") {
      const quota = m === "insufficient";
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: { message: quota ? "You exceeded your current quota" : "Too many requests", type: quota ? "insufficient_quota" : "rate_limit_exceeded", code: quota ? "insufficient_quota" : "rate_limit_exceeded" } }));
      return;
    }
    if (m === "e401") { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } })); return; }
    if (m === "e500") { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "internal", type: "server_error" } })); return; }
    if (m === "usage") {
      res.writeHead(429, { "content-type": "application/json", ...limitHeaders(100) });
      res.end(JSON.stringify({ error: { type: "usage_limit_reached", message: "usage limit", plan_type: "plus", resets_at: Math.floor(Date.now() / 1000) + 3600 } }));
      return;
    }
    const headers = { "content-type": "text/event-stream", "cache-control": "no-cache", ...(m === "near" ? limitHeaders(96) : {}) };
    res.writeHead(200, headers);
    res.write(sse("response.created", { response: { id: "resp_audit" } }));
    if (m === "capacity") {
      res.end(sse("response.failed", { response: { id: "resp_audit", error: { code: "server_is_overloaded", message: "overloaded" } } }));
      return;
    }
    // tool / toolshell / toolexec: the model calls one tool (an MCP tool in AgEnD's namespace, or the shell), then answers once the
    // tool's output comes back. Used for the missing-companion repro (codex-code-mode-host), where every call fails.
    // toolexec: the code-mode `exec` tool (a custom tool whose input is JavaScript), the only tool code_mode_only declares.
    if (["tool", "toolshell", "toolexec"].includes(m) && !/"(?:custom_tool_call|function_call)_output"/.test(body)) {
      const item = m === "tool"
        ? { type: "function_call", id: "fc_audit", call_id: "call_audit", namespace: "mcp__agend", name: "reply", arguments: JSON.stringify({ text: "probe" }) }
        : m === "toolshell"
          ? { type: "function_call", id: "fc_audit", call_id: "call_audit", name: "exec_command", arguments: JSON.stringify({ cmd: "echo probe" }) }
          : { type: "custom_tool_call", id: "ctc_audit", call_id: "call_audit", name: "exec", input: 'text("probe")' };
      res.write(sse("response.output_item.done", { item }));
      res.end(sse("response.completed", { response: { id: "resp_audit", usage } }));
      return;
    }
    const finish = () => {
      res.write(sse("response.output_item.done", { item: { type: "message", role: "assistant", id: "msg_audit", content: [{ type: "output_text", text: "ok" }] } }));
      res.end(sse("response.completed", { response: { id: "resp_audit", usage } }));
    };
    if (m === "slow") setTimeout(finish, Number(process.env.SLOW_MS || 8000)); else finish();
  });
}).listen(port, "127.0.0.1", () => { if (log) appendFileSync(log, `listening ${port}\n`); });
