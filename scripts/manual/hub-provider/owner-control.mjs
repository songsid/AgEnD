// Runs ONLY in an isolated witness container. Private tmux/socket/home, fake APIs and fake private data.
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
const backend = process.argv[2]; if (!["claude", "codex"].includes(backend)) process.exit(1);
setTimeout(() => process.exit(1), 300_000).unref();
const home = "/scratch/owner-home", work = "/scratch/owner-work", socket = "/scratch/owner-tmux.sock";
for (const d of [home, work, "/scratch/tmp", `${home}/.claude`, `${home}/.codex`]) mkdirSync(d, { recursive: true, mode: 0o700 });
const canary = `OWNER_PRIVATE_CANARY_${randomUUID()}`; writeFileSync(`${home}/private-note`, canary, { mode: 0o600 });
const requests = [], held = new Set(); let mode = "ok", n = 0, phaseText = "";
const event = (type, body = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const server = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 2 * 1024 * 1024) { res.destroy(); return; } }
  if (req.method === "GET" && req.url.startsWith("/v1/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "claude-sonnet-4-5", type: "model", display_name: "Sonnet" }], models: [], has_more: false })); return; }
  if (req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"input_tokens":100}'); return; }
  if (req.method !== "POST" || !/^\/v1\/(messages|responses)/.test(req.url)) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
  requests.push(JSON.parse(raw)); n++;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  if (mode === "busy" && raw.includes("OWNER_BUSY_WITNESS")) {
    res.write(backend === "claude" ? event("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } }) : event("response.created", { response: { id: `resp_${n}` } }));
    held.add(res); res.once("close", () => held.delete(res)); return;
  }
  const text = "OWNER IDLE WITNESS";
  if (backend === "claude") res.end(event("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } })
    + event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + event("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) + event("content_block_stop", { index: 0 })
    + event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }) + event("message_stop"));
  else res.end(event("response.created", { response: { id: `resp_${n}` } }) + event("response.output_item.done", { item: { type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text }] } })
    + event("response.completed", { response: { id: `resp_${n}`, usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 } } }));
});
await new Promise(r => server.listen(0, "127.0.0.1", r)); const port = server.address().port;
const key = "sk-ant-api03-" + "dummy".repeat(24);
const claudeState = JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.316", theme: "dark", apiKeyApprovals: { approved: [key.slice(-20)], rejected: [] }, projects: { [work]: { hasTrustDialogAccepted: true } }, oauthAccount: { accountUuid: "00000000-0000-4000-8000-000000000001", emailAddress: "witness@example.invalid", organizationUuid: "00000000-0000-4000-8000-000000000002", organizationRole: "admin", billingType: "stripe_subscription" } });
for (const p of [`${home}/.claude.json`, `${home}/.claude/.claude.json`]) writeFileSync(p, claudeState, { mode: 0o600 });
writeFileSync(`${home}/.codex/config.toml`, `model="mock-model"\nmodel_provider="mock"\napproval_policy="never"\nsandbox_mode="workspace-write"\ncheck_for_update_on_startup=false\n[projects."${work}"]\ntrust_level="trusted"\n[model_providers.mock]\nname="mock"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
const env = { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: "/scratch/tmp", TERM: "xterm-256color", LANG: "C.UTF-8", CODEX_HOME: `${home}/.codex`, CLAUDE_CONFIG_DIR: `${home}/.claude`, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: key, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
const tmux = (...args) => execFileSync("tmux", ["-S", socket, ...args], { env, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
const pause = ms => new Promise(r => setTimeout(r, ms));
const capture = () => tmux("capture-pane", "-p", "-t", "owner:0.0");
const files = root => existsSync(root) ? readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(`${root}/${e.name}`) : [`${root}/${e.name}`]) : [];
const transcripts = () => files(home).filter(f => f.endsWith(".jsonl") && !f.includes("debug"));
const snapshot = phase => ({ phase, canary, requestCount: requests.length, held: held.size, hashes: Object.fromEntries([...transcripts(), `${home}/private-note`].map(f => [f.slice(home.length), createHash("sha256").update(readFileSync(f)).digest("hex")])), capture: capture(), privateInOwnerContext: requests.some(r => JSON.stringify(r).includes(canary)), privateInPhaseOwnerRequest: requests.some(r => JSON.stringify(r).includes(phaseText) && JSON.stringify(r).includes(canary)), ownerTools: requests.filter(r => JSON.stringify(r).includes(phaseText) && JSON.stringify(r).includes(canary)).flatMap(r => r.tools ?? []).flatMap(t => t.type === "namespace" ? (t.tools ?? []).map(n => `${t.name}.${n.name}`) : [t.name ?? t.type]) });
let originalSession = null;
async function launch(phase) {
  try { tmux("kill-session", "-t", "owner"); } catch { /* Own first launch only. */ }
  mode = phase === "busy" ? "busy" : "ok";
  const binary = backend === "claude" ? "/opt/cli/node_modules/@anthropic-ai/claude-code-linux-x64/claude" : "/opt/cli/node_modules/.bin/codex";
  const args = backend === "claude" ? ["--model", "claude-sonnet-4-5", ...(phase !== "idle" ? ["--resume", originalSession] : [])] : ["--no-daemon", ...(phase !== "idle" ? ["resume", originalSession] : [])];
  tmux("new-session", "-d", "-s", "owner", "-x", "120", "-y", "40", "-c", work, "/bin/sleep", "300");
  tmux("set-option", "-g", "exit-empty", "off");
  tmux("set-window-option", "-t", "owner", "remain-on-exit", "on");
  tmux("respawn-pane", "-k", "-t", "owner:0.0", "-c", work, "/usr/bin/env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), binary, ...args);
  await pause(1500);
  const before = requests.length;
  const text = phase === "idle" ? `Remember my private owner context: ${canary}. Say ready.` : `OWNER_${phase.toUpperCase()}_WITNESS`;
  phaseText = text;
  let pasted = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    const pane = capture();
    if (/Do you want to use this API key/i.test(pane)) { tmux("send-keys", "-t", "owner", "Up", "Enter"); await pause(200); continue; }
    if (/trust this folder|trust the files|Is this a project|Choose the text style|Let.s get you started/i.test(pane)) { tmux("send-keys", "-t", "owner", "Enter"); await pause(200); continue; }
    if (!pasted) { tmux("send-keys", "-l", "-t", "owner", text); await pause(300); tmux("send-keys", "-t", "owner", "Enter"); pasted = true; }
    if (requests.slice(before).some(r => JSON.stringify(r).includes(text) && JSON.stringify(r).includes(canary)) && (phase === "busy" ? held.size > 0 : pane.includes("OWNER IDLE WITNESS"))) break;
    if (attempt === 44) throw Error(`owner did not reach ${phase}: ${pane}`);
    await pause(500);
  }
  await pause(750);
  if (phase === "idle") {
    for (const f of transcripts()) for (const line of readFileSync(f, "utf8").split("\n")) {
      try { const row = JSON.parse(line); originalSession ??= backend === "claude" ? row.sessionId : row.type === "session_meta" ? row.payload?.id : null; } catch { /* Empty final line. */ }
    }
    if (!originalSession) throw Error("no native owner session ID");
  }
  return { ...snapshot(phase), sessionId: originalSession };
}
process.stdout.write(JSON.stringify({ ready: true, backend }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  try { const q = JSON.parse(line); const result = q.phase ? await launch(q.phase) : snapshot("snapshot"); process.stdout.write(JSON.stringify({ id: q.id, ...result }) + "\n"); }
  catch (error) { let pane; try { pane = capture(); } catch {} process.stdout.write(JSON.stringify({ error: String(error) + " PANE=" + pane }) + "\n"); }
}
