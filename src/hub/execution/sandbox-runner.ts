/** Entrypoint ONLY inside the pinned, unnetworked disposable image. Never imported by the daemon. */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn } from "../../child-process.js";

const self = fileURLToPath(import.meta.url), limit = 1024 * 1024;
const tools = [
  { name: "documents_list", description: "List the approved documents.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "documents_read", description: "Read one approved document by its opaque documentId.", inputSchema: { type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"], additionalProperties: false } },
].map(t => ({ ...t, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));

async function main(): Promise<void> {
if (process.argv[2] === "--mcp") {
  const port = Number(process.env.HUB_RPC_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);
  let used = 0;
  process.stdin.on("data", (b: Buffer) => { used += b.length; if (used > 2 * limit) process.exit(1); });
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let r;
    try { r = JSON.parse(line); } catch { process.exit(1); }
    if (r.id === undefined) continue;
    let result: unknown;
    if (r.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hub-documents", version: "1" } };
    else if (r.method === "ping") result = {};
    else if (r.method === "tools/list") result = { tools };
    else if (r.method === "tools/call" && tools.some(t => t.name === r.params?.name)) {
      const response = await fetch(`http://127.0.0.1:${port}/tool`, { method: "POST", body: JSON.stringify(r.params), signal: AbortSignal.timeout(120_000) });
      if (!response.ok) process.exit(1);
      const text = await response.text(); if (Buffer.byteLength(text) > 128 * 1024) process.exit(1);
      result = { content: [{ type: "text", text }] };
    } else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "Unavailable" } }) + "\n"); continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\n");
  }
} else {
  let total = 0, next = 0, started = false;
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  const send = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
  const die = () => { send({ type: "error" }); process.exit(1); };
  // This independent deadline survives a member/controller crash or a lost attach pipe.
  setTimeout(die, 125_000).unref();
  process.stdin.on("end", die); process.stdin.on("error", die);
  process.stdin.on("data", (b: Buffer) => { total += b.length; if (total > 16 * limit) die(); });
  const ask = (type: string, fields: object) => new Promise<any>((resolve, reject) => {
    const id = ++next; if (id > 256 || pending.size) return reject(Error("bounded"));
    pending.set(id, { resolve, reject }); send({ type, id, ...fields });
  });
  const start = async (frame: any) => {
    if (started || !["claude", "codex"].includes(frame.backend) || typeof frame.prompt !== "string" || Buffer.byteLength(frame.prompt) > 40 * 1024
      || typeof frame.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(frame.model)) throw Error("invalid");
    started = true;
    for (const dir of ["home", "work", "tmp", "config", "data", "cache", "state"]) mkdirSync(`/scratch/${dir}`, { mode: 0o700 });
    const server = createServer(async (req, res) => {
      try {
        if (req.method !== "POST" || !["/tool", "/v1/messages", "/v1/messages?beta=true", "/v1/responses", "/v1/messages/count_tokens?beta=true", "/v1/messages/count_tokens"].includes(req.url ?? "")) { res.writeHead(404); res.end(); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw Error("bounded"); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (req.url!.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: Math.ceil(bytes / 2) })); return; }
        if (req.url === "/tool") {
          if (!tools.some(t => t.name === body.name)) throw Error("denied");
          const reply = await ask("tool", { name: `mcp__hub_documents__${body.name}`, arguments: body.arguments });
          res.writeHead(200, { "content-type": "application/json" }); res.end(reply.text);
        } else {
          const reply = await ask("model", { body });
          res.writeHead(200, { "content-type": reply.contentType }); res.end(reply.body);
        }
      } catch { res.writeHead(503); res.end(); die(); }
    });
    server.requestTimeout = 120_000; server.maxConnections = 8;
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const env = {
      HOME: "/scratch/home", PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: "/scratch/tmp", LANG: "C.UTF-8", TERM: "dumb",
      XDG_CONFIG_HOME: "/scratch/config", XDG_DATA_HOME: "/scratch/data", XDG_CACHE_HOME: "/scratch/cache", XDG_STATE_HOME: "/scratch/state",
      CODEX_HOME: "/scratch/home/.codex", CLAUDE_CONFIG_DIR: "/scratch/home/.claude", HUB_RPC_PORT: String(port),
      ANTHROPIC_API_KEY: "sk-ant-hub-local-broker-dummy", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", ENABLE_TOOL_SEARCH: "false",
    };
    const mcp = { command: "/usr/local/bin/node", args: [self, "--mcp"], env: { HUB_RPC_PORT: String(port) } };
    let args: string[];
    if (frame.backend === "claude") {
      writeFileSync("/scratch/config/settings.json", JSON.stringify({ disableAllHooks: true, disableClaudeAiConnectors: true, permissions: { defaultMode: "dontAsk" } }), { mode: 0o600 });
      args = ["-p", "--restricted", "--tools", "", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { hub_documents: mcp } }),
        "--allowedTools", "mcp__hub_documents__documents_list,mcp__hub_documents__documents_read", "--permission-mode", "dontAsk",
        "--settings", "/scratch/config/settings.json", "--no-session-persistence", "--no-chrome", "--model", frame.model, "--max-turns", "16", "--output-format", "json"];
    } else {
      mkdirSync(env.CODEX_HOME, { mode: 0o700 });
      writeFileSync(`${env.CODEX_HOME}/config.toml`, `model = ${JSON.stringify(frame.model)}
model_provider = "hub"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
[features]
shell_tool = false
view_image = false
multi_agent = false
apps = false
code_mode = false
shell_snapshot = false
enable_request_compression = false
[feedback]
enabled = false
[history]
persistence = "none"
[model_providers.hub]
name = "hub"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[mcp_servers.hub_documents]
command = "/usr/local/bin/node"
args = [${JSON.stringify(self)}, "--mcp"]
env = { HUB_RPC_PORT = "${port}" }
required = true
`, { mode: 0o600 });
      args = ["exec", "--skip-git-repo-check", "--ephemeral", "--json", "--output-last-message", "/scratch/answer", "-"];
    }
    const binary = frame.backend === "claude" ? "/opt/cli/node_modules/@anthropic-ai/claude-code-linux-x64/claude" : "/opt/cli/node_modules/.bin/codex";
    const child = spawn(binary, args, { cwd: "/scratch/work", env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", outputBytes = 0;
    child.stdout!.on("data", (b: Buffer) => { outputBytes += b.length; if (outputBytes > limit) die(); stdout += b.toString("utf8"); });
    child.stderr!.on("data", (b: Buffer) => { outputBytes += b.length; if (outputBytes > limit) die(); process.stderr.write(b); });
    child.on("error", die);
    child.on("close", code => {
      try {
        if (code !== 0) throw Error("exit");
        const text = frame.backend === "claude" ? (() => { const r = JSON.parse(stdout); if (r.is_error || r.type !== "result" || r.subtype !== "success") throw Error("result"); return r.result; })() : readFileSync("/scratch/answer", "utf8");
        if (typeof text !== "string" || Buffer.byteLength(text) > 128 * 1024) throw Error("bounded");
        send({ type: "answer", text }); server.close(); process.exit(0);
      } catch { die(); }
    });
    child.stdin!.end(frame.prompt);
  };
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      if (Buffer.byteLength(line) > 2 * limit) throw Error("bounded");
      const frame = JSON.parse(line);
      if (frame.type === "start") void start(frame).catch(die);
      else {
        const p = pending.get(frame.id);
        if (!p || !["tool-result", "model-result"].includes(frame.type)) throw Error("invalid");
        pending.delete(frame.id); p.resolve(frame);
      }
    } catch { die(); }
  }
}
}
if (process.argv[1] && self === resolve(process.argv[1])) void main().catch(() => process.exit(1));
