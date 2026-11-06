// Account-free real CLI capture: owned HOME/configs/cwd, loopback model APIs, no fleet or tmux.
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(process.env.OUT || ".artifacts/follow3160-capture");
if (["claude", "codex"].some(b => existsSync(join(root, b)))) throw Error("Use a fresh OUT directory; old sessions must not contaminate a capture.");
mkdirSync(root, { recursive: true });
const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
const sse = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
function run(bin, args, env, cwd, label) {
  return new Promise((done, fail) => {
    const child = spawn(bin, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
    const timer = setTimeout(() => { child.kill("SIGTERM"); fail(Error(`${label} timed out`)); }, 90000);
    child.on("error", fail);
    child.on("exit", code => { clearTimeout(timer); writeFileSync(join(root, `${label}.stdout`), stdout); writeFileSync(join(root, `${label}.stderr`), stderr); done({ code, stdout, stderr }); });
  });
}
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

for (const backend of ["claude", "codex"]) {
  const home = join(root, backend), work = join(home, "work"), config = join(home, "config");
  mkdirSync(join(work, "src"), { recursive: true }); mkdirSync(config, { recursive: true });
  writeFileSync(join(work, "src/a.ts"), "// NEEDLE fixture\nconst value = 1;\nconsole.log(value);\n// fourth line\n");
  writeFileSync(join(work, ".env"), "FOLLOW_PRIVATE_CANARY_3160=fixture-only\n");
  writeFileSync(join(home, "outside.txt"), "FOLLOW_OUTSIDE_CANARY_3160\n");
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const value = 1;\n+const value = 2;\n*** End Patch";
  const calls = backend === "claude" ? [
    { name: "Read", input: { file_path: join(work, "src/a.ts"), offset: 2, limit: 3 } },
    { name: "Bash", input: { command: "grep -n NEEDLE src/a.ts", description: "Search the fixture file" } },
    { name: "Edit", input: { file_path: join(work, "src/a.ts"), old_string: "const value = 1;", new_string: "const value = 2;" } },
    { name: "Read", input: { file_path: join(work, ".env") } },
    { name: "Read", input: { file_path: join(home, "outside.txt") } },
  ] : [
    { name: "exec_command", input: { cmd: "sed -n '2,4p' src/a.ts", workdir: work } },
    { name: "exec_command", input: { cmd: "rg -n --glob '*.ts' NEEDLE src", workdir: work } },
    { name: "apply_patch", input: patch },
    { name: "exec_command", input: { cmd: "cat .env", workdir: work } },
    { name: "exec_command", input: { cmd: "cat outside.txt", workdir: home } },
  ];
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: join(home, "xdg-config"), XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), AGEND_HOME: join(home, "agend"), CLAUDE_CONFIG_DIR: config, CODEX_HOME: config,
    TERM: "dumb", LANG: "C.UTF-8", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
  // Resolve the installed executable before replacing the child's environment with its private HOME/config.
  const binary = process.env[`${backend.toUpperCase()}_BIN`] || execFileSync("which", [backend], { encoding: "utf8" }).trim();
  const version = await run(binary, ["--version"], env, work, `${backend}-version`);
  if (version.code !== 0) throw Error(`${backend} version: ${version.stderr}`);
  const seen = new Set(); let requests = 0;
  const server = createServer((req, res) => {
    let data = ""; req.on("data", c => { data += c; });
    req.on("end", () => {
      let body; try { body = JSON.parse(data || "{}"); } catch { body = {}; }
      const json = (obj, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url?.includes("count_tokens")) return json({ input_tokens: 100 });
      if (req.method !== "POST") return json({ data: [], models: [] });
      writeFileSync(join(root, `${backend}-request-${++requests}.json`), JSON.stringify(body, null, 2));
      if (backend === "claude") {
        for (const m of body.messages || []) for (const c of Array.isArray(m.content) ? m.content : []) if (c.type === "tool_result") seen.add(c.tool_use_id);
      } else for (const i of body.input || []) if (i.type === "function_call_output" || i.type === "custom_tool_call_output") seen.add(i.call_id);
      let index = 0; while (seen.has(`f3160_${index}`)) index++;
      const next = calls[index], rid = `follow_${backend}_${requests}`;
      const declared = next && body.tools?.find(t => t.name === next.name);
      if (next && body.tools?.length && !declared) { res.writeHead(400); res.end(JSON.stringify({ error: { message: `Fixture tool not declared: ${next.name}` } })); return; }
      if (backend === "claude") {
        if (!body.tools?.length) return json({ id: rid, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "Follow fixture" }], stop_reason: "end_turn", stop_sequence: null, usage });
        res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        res.write(sse("message_start", { message: { id: rid, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }));
        res.write(sse("content_block_start", { index: 0, content_block: next ? { type: "tool_use", id: `f3160_${index}`, name: next.name, input: {} } : { type: "text", text: "" } }));
        res.write(sse("content_block_delta", { index: 0, delta: next ? { type: "input_json_delta", partial_json: JSON.stringify(next.input) } : { type: "text_delta", text: "Follow fixture complete." } }));
        res.write(sse("content_block_stop", { index: 0 }));
        res.write(sse("message_delta", { delta: { stop_reason: next ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }));
        res.end(sse("message_stop", {}));
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sse("response.created", { response: { id: rid } }));
        const item = !next ? { type: "message", id: rid, role: "assistant", content: [{ type: "output_text", text: "Follow fixture complete." }] }
          : next.name === "apply_patch" ? (declared?.type === "custom" ? { type: "custom_tool_call", id: rid, call_id: `f3160_${index}`, name: next.name, input: next.input }
            : { type: "function_call", id: rid, call_id: `f3160_${index}`, name: next.name, arguments: JSON.stringify({ input: next.input }) })
            : { type: "function_call", id: rid, call_id: `f3160_${index}`, name: next.name, arguments: JSON.stringify(next.input) };
        res.write(sse("response.output_item.done", { item }));
        res.end(sse("response.completed", { response: { id: rid, usage: { ...usage, input_tokens_details: null, output_tokens_details: null } } }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  if (backend === "claude") {
    Object.assign(env, { ANTHROPIC_API_KEY: "sk-ant-fixture-only-3160", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` });
    writeFileSync(join(config, "settings.json"), JSON.stringify({ disableAllHooks: true }));
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [work]: { hasTrustDialogAccepted: true } } }));
  } else {
    // 0.164 moved its catalogue to models-manager; unknown models omit apply_patch. This private test entry selects
    // the real direct-tool router: https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/protocol/src/openai_models.rs
    writeFileSync(join(config, "models.json"), JSON.stringify({ models: [{ slug: "follow-fixture", display_name: "Follow fixture", description: "Loopback capture",
      default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low", description: "Fixture" }], shell_type: "unified_exec", visibility: "list",
      supported_in_api: true, priority: 1, support_verbosity: false, apply_patch_tool_type: "freeform", tool_mode: "direct", truncation_policy: { mode: "tokens", limit: 10000 },
      experimental_supported_tools: [], context_window: 128000, base_instructions: "Use the provided tools for this local fixture." }] }));
    writeFileSync(join(config, "config.toml"), `model="follow-fixture"\nmodel_catalog_json=${JSON.stringify(join(config, "models.json"))}\nmodel_provider="mock"\napproval_policy="never"\nsandbox_mode="workspace-write"\ncheck_for_update_on_startup=false\n[features]\ncode_mode=false\ncode_mode_only=false\n[model_providers.mock]\nname="mock"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  }
  try {
    const args = backend === "claude" ? ["--print", "--verbose", "--output-format", "stream-json", "--dangerously-skip-permissions", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--model", "claude-sonnet-4-5", "FOLLOW3160 fixture"]
      : ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", work, "FOLLOW3160 fixture"];
    const result = await run(binary, args, env, work, backend);
    const transcripts = walk(config).filter(f => f.endsWith(".jsonl"));
    writeFileSync(join(root, `${backend}-receipt.json`), JSON.stringify({ version: version.stdout.trim(), code: result.code, requests, results: [...seen], transcripts, edited: readFileSync(join(work, "src/a.ts"), "utf8").includes("value = 2") }, null, 2));
    if (result.code !== 0 || seen.size < calls.length || !readFileSync(join(work, "src/a.ts"), "utf8").includes("value = 2")) throw Error(`${backend} did not finish all tools/edit: ${result.stderr.slice(-2000)}`);
    console.log(`${backend}: ${version.stdout.trim()}, ${seen.size} real tool results; ${transcripts.length} transcripts`);
  } finally { await new Promise(resolve => server.close(resolve)); }
}
