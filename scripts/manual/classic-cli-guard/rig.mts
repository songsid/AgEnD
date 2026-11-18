// Real CLI, private HOME/network, local dummy API. Never launch an AgEnD Fleet.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { ClaudeCodeBackend } from "../../../src/backend/claude-code.js";
import { classicGuardStatus, invalidateClassicGuard, stageClaudeClassicGuard, type ClassicGuardLaunch } from "../../../src/classic-cli-guard.js";
import { CLASSIC_RESTRICTED_TOOLS } from "../../../src/contact-auth-types.js";
import { shellQuote } from "../../../src/backend/types.js";

assert.equal(process.env.HOME, "/rig/home");
const root = "/rig", captures: Record<string, unknown>[] = [];
const webRequests: string[] = [];
const web = (url: string, res: import("node:http").ServerResponse) => {
  webRequests.push(url);
  if (url.includes("domain_info")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ can_fetch: true })); }
  else { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>PUBLIC_FETCH_FIXTURE</body></html>"); }
};
const tls = createHttpsServer({ key: readFileSync("/rig/server.key"), cert: readFileSync("/rig/server.crt") }, (req, res) => web(req.url ?? "", res));
await new Promise<void>(r => tls.listen(0, "127.0.0.1", r));
const tlsPort = (tls.address() as {port: number}).port;
const proxy = createServer((req, res) => web(req.url ?? "", res));
const sockets = new Set<import("node:net").Socket>();
proxy.on("connect", (req, client, head) => {
  if (!["api.anthropic.com:443", "claude.ai:443", "example.com:443"].includes(req.url ?? "")) { client.end("HTTP/1.1 403 Refused\r\n\r\n"); return; }
  const upstream = connect(tlsPort, "127.0.0.1", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); client.pipe(upstream).pipe(client); });
  sockets.add(client); sockets.add(upstream); client.on("close", () => sockets.delete(client)); upstream.on("close", () => sockets.delete(upstream));
  client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
});
await new Promise<void>(r => proxy.listen(0, "127.0.0.1", r));
const proxyPort = (proxy.address() as {port: number}).port;
let active: { name: string; tool: string; launch: ClassicGuardLaunch; mutation?: string; requests: unknown[]; results: unknown[] };
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks), body = raw.length ? JSON.parse((req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString()) : {};
  const json = (value: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (req.url?.includes("count_tokens")) return json({ input_tokens: 100 });
  if (!req.url?.includes("/messages")) return json({});
  active.requests.push({ tools: (body.tools ?? []).map((t: {name: string}) => t.name) });
  const messages = body.messages ?? [];
  const results = messages.flatMap((m: { content?: unknown }) => Array.isArray(m.content) ? m.content.filter(p => p.type === "tool_result") : []);
  const search = (body.tools ?? []).some((t: {type?: string}) => t.type?.startsWith("web_search"));
  if (results.length) active.results = results;
  const call = !results.length && !search && (body.tools ?? []).length > 0;
  if (call && active.mutation) {
    assert.ok(existsSync(active.launch.receiptPath), "mutation must follow real SessionStart load");
    if (active.mutation === "missing") unlinkSync(active.launch.hookPath);
    else if (active.mutation === "crash") writeFileSync(active.launch.hookPath, "process.exit(1)");
    else if (active.mutation === "timeout") writeFileSync(active.launch.hookPath, "setTimeout(()=>{},10000)");
    else if (active.mutation === "stale") invalidateClassicGuard(join(active.launch.currentPath, "..", ".."));
    active.mutation = undefined;
  }
  const id = `toolu_fixture_${active.requests.length}`;
  const content = call ? [{ type: "tool_use", id, name: active.tool, input: active.tool === "WebSearch" ? { query: "public fixture" }
    : active.tool === "WebFetch" ? { url: "https://example.com", prompt: "Read the public fixture" }
    : active.tool === "Bash" ? { command: "touch /rig/MUST_NOT_EXIST" }
    : active.tool === "Read" ? { file_path: "/rig/private.txt" }
    : active.tool === "Write" ? { file_path: "/rig/MUST_NOT_EXIST", content: "not allowed" }
    : active.tool === "Agent" ? { description: "fixture", prompt: "must not run", subagent_type: "general-purpose" } : {} }]
    : [{ type: "text", text: search ? "PUBLIC_SEARCH_OK" : active.name === "public-fetch" ? "PUBLIC_FETCH_OK" : "FINAL_FIXTURE_OK" }];
  const answer = { id: `msg_fixture_${active.requests.length}`, type: "message", role: "assistant", model: body.model,
    content, stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
  if (!body.stream) return json(answer);
  res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  const event = (name: string, value: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  event("message_start", { type: "message_start", message: { ...answer, content: [], stop_reason: null } });
  content.forEach((block, index) => {
    event("content_block_start", { type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
    event("content_block_delta", { type: "content_block_delta", index, delta: block.type === "text"
      ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    event("content_block_stop", { type: "content_block_stop", index });
  });
  event("message_delta", { type: "message_delta", delta: { stop_reason: answer.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
  event("message_stop", { type: "message_stop" }); res.end();
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as {port: number}).port;
const fakeKey = `sk-ant-api03-${"fixture".repeat(16)}`;
const environment = { ...process.env, ANTHROPIC_API_KEY: fakeKey, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: "localhost,127.0.0.1",
  NODE_EXTRA_CA_CERTS: "/rig/server.crt", SSL_CERT_FILE: "/rig/server.crt",
  DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
const run = (command: string, cwd: string, env: Record<string, string | undefined>) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
  const child = spawn("/bin/sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  child.on("error", reject); child.stdout.on("error", reject); child.stderr.on("error", reject);
  child.stdout.on("data", x => output += x); child.stderr.on("data", x => output += x);
  child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
});
try {
  for (const version of (process.env.GUARD_RIG_VERSIONS || "2.1.295,2.1.327").split(",")) {
    for (const [name, tool, mutation] of [
      ["reply", "mcp__agend__reply"], ["public-search", "WebSearch"], ["public-fetch", "WebFetch"],
      ["selected", "mcp__selected__lookup"], ["other-selected-tool", "mcp__selected__write"],
      ["agend-admin", "mcp__agend__create_instance"], ["bash", "Bash"], ["read", "Read"], ["write", "Write"], ["agent", "Agent"],
      ["missing-hook", "mcp__agend__reply", "missing"], ["crashing-hook", "mcp__agend__reply", "crash"],
      ["timed-out-hook", "mcp__agend__reply", "timeout"],
      ["missing-start", "mcp__agend__reply"], ["stale-policy", "mcp__agend__reply", "stale"],
      ["backend-reply", "mcp__agend__reply"],
      ["inheritance", "mcp__agend__reply"],
      ["public-off", "WebSearch"],
      ["owner-selected", "mcp__selected__lookup"], ["owner-missing", "WebSearch"],
    ]) {
      if (process.env.GUARD_RIG_CASE && name !== process.env.GUARD_RIG_CASE) continue;
      const directory = join(root, `${version}-${name}`), instanceDir = join(directory, "instance"), cwd = join(directory, "room"), home = join(directory, "home");
      for (const p of [instanceDir, cwd, home]) mkdirSync(p, { recursive: true });
      const trace = join(directory, "mcp-calls.jsonl");
      const entry = (label: string) => ({ command: process.execPath, args: ["/repo/scripts/manual/classic-cli-guard/mcp.mjs", label, trace], env: {} });
      const plan = { roomKey: "sample-room", policyRevision: 1, publicRead: name !== "public-off", allowedAgendTools: [...CLASSIC_RESTRICTED_TOOLS],
        allowedMcpTools: [{ name: "mcp__selected__lookup", kind: "mcp" as const, usesOwnerAccount: name.startsWith("owner-"),
          ...(name.startsWith("owner-") ? { accountWarning: "Uses the owner's account and quota" } : {}) }] };
      // Pre-2.1.295 is an intentional upstream fail-open control, never a covered production plan.
      let backendCommand: string | undefined;
      const mcpServers = name.startsWith("owner-") ? { agend: entry("agend") }
        : { agend: entry("agend"), selected: entry("selected"), excluded: entry("excluded") };
      if (name === "inheritance") {
        mkdirSync(join(home, ".claude"), { recursive: true });
        writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { inherited: entry("inherited") } }));
        writeFileSync(join(home, ".claude/.claude.json"), JSON.stringify({ mcpServers: { inherited: entry("inherited") } }));
        writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ disableAllHooks: true }));
        writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { project: entry("project") } }));
      }
      if (name.startsWith("owner-")) {
        mkdirSync(join(home, ".claude"), { recursive: true });
        writeFileSync(join(home, ".claude/.claude.json"), JSON.stringify({ mcpServers: name === "owner-selected"
          ? { selected: entry("selected"), inherited: entry("inherited") } : {} }));
        writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { selected: entry("selected") } }));
      }
      const staged = stageClaudeClassicGuard({ plan, version: version === "2.1.294" ? "2.1.295" : version, platform: "linux", instanceDir, cwd,
        mcpServers, settings: {} });
      if (name === "backend-reply" || name.startsWith("owner-")) {
        const backend = new ClaudeCodeBackend(instanceDir); backend.refreshLaunchBinary(`/versions/${version}`);
        const config = { instanceDir, instanceName: "sample-room", workingDirectory: cwd, classicRestriction: plan,
          mcpServers, skipResume: true, agentMode: "mcp" as const };
        const previous = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
        try { await backend.prepareLaunch(config); backend.writeConfig(config); backendCommand = backend.buildCommand(config); }
        finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
        assert.ok(!backendCommand.includes("--dangerously-skip-permissions"));
        staged.launch = (backend as any).classicGuardLaunch;
      }
      assert.ok(staged.launch);
      active = { name, tool, launch: staged.launch, mutation, requests: [], results: [] };
      if (name === "missing-start") unlinkSync(staged.launch.hookPath);
      const env = { ...environment, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") };
      const command = (backendCommand ?? `/versions/${version} --settings ${shellQuote(staged.launch.settingsPath)} --mcp-config ${shellQuote(staged.launch.mcpPath)} --strict-mcp-config --setting-sources '' --disable-slash-commands --no-chrome --permission-mode dontAsk --tools ${shellQuote(staged.launch.tools.join(","))}`)
        + " --print --verbose --output-format stream-json --max-turns 2 'Guard fixture only'";
      const result = await run(command, cwd, env);
      writeFileSync(join(directory, "output.txt"), result.output);
      const calls = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
      const status = classicGuardStatus(staged.launch, plan);
      const starts = existsSync(`${trace}.starts`) ? readFileSync(`${trace}.starts`, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
      const row = { version, controlOnly: version === "2.1.294", name, tool, code: result.code, status, calls, starts, requests: active.requests, results: active.results, webRequests: [...webRequests] };
      captures.push(row); writeFileSync(join(root, "results.json"), JSON.stringify(captures, null, 2));
      console.log(JSON.stringify({ version, name, code: result.code, state: status.state, calls: calls.length, requests: active.requests.length }));
      assert.equal(existsSync(join(root, "MUST_NOT_EXIST")), false);
      if (name === "reply" || name === "selected" || name === "backend-reply" || name === "inheritance" || name === "owner-selected" || version === "2.1.294" && name === "missing-hook") assert.equal(calls.length, 1, result.output.slice(-1200));
      else assert.equal(calls.length, 0);
      if (name.includes("hook") || name === "missing-start" || name === "stale-policy" || name === "owner-missing") assert.notEqual(status.state, "ready");
      else assert.equal(status.state, "ready", result.output.slice(-1200));
      if (name === "missing-start") assert.equal(active.requests.length, 0);
      else assert.ok(active.requests.length, result.output.slice(-1200));
      if (name === "public-search" || name === "public-fetch" || name === "owner-missing") {
        assert.ok(active.results.length);
        assert.ok(active.results.every((r: any) => !r.is_error), JSON.stringify(active.results));
        assert.ok(JSON.stringify(active.results).includes(name === "public-fetch" ? "PUBLIC_FETCH_OK" : "PUBLIC_SEARCH_OK"));
      }
      if (name === "inheritance") assert.deepEqual(starts.map(s => s.server).sort(), ["agend", "selected"]);
    }
  }
} finally { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); proxy.closeAllConnections(); tls.closeAllConnections();
  await Promise.all([server, proxy, tls].map(s => new Promise<void>(r => s.close(() => r())))); }
