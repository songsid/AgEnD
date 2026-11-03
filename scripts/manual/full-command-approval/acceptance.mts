/** Real Claude TUI, private tmux, synthetic local API and scratch HOME. No fleet or real account. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { selectionCard } from "../../../src/selection-card.js";
import { remoteCardPrompt } from "../../../src/remote-card-prompt.js";
import { answerRemoteCard } from "../../../src/remote-card-answer.js";

const output = resolve(process.argv[2] ?? ".artifacts/full-command-native");
mkdirSync(output, { recursive: true });
rmSync(join(output, "receipt.json"), { force: true });
const scratch = mkdtempSync(join(output, "private-")), home = join(scratch, "home"), cwd = join(scratch, "cwd");
mkdirSync(home); mkdirSync(cwd);
const socket = `agend-test-full-command-${process.pid}`, session = "proof";
const binary = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
const command = `printf '%s' 'FIRST_REQUEST ${Array.from({ length: 42 }, (_, i) => `wrapped-command-${String(i).padStart(2, "0")}`).join(" ")} END_REQUEST' > sentinel`;
const fakeKey = `sk-ant-api03-${"test".repeat(22)}-testtestAA`;
const config = join(home, ".claude"); mkdirSync(config);
writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", customApiKeyResponses: { approved: [fakeKey.slice(-20)], rejected: [] }, projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
let requests = 0;
const server = createServer((req, res) => {
  const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", () => {
    if (!req.url?.startsWith("/v1/messages")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(req.url?.includes("count_tokens") ? { input_tokens: 100 } : {})); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); requests++;
    const result = JSON.stringify(body.messages ?? []).includes('"tool_result"');
    const content = result ? { type: "text", text: "The request was refused; nothing executed." } : { type: "tool_use", id: `toolu_scratch_${requests}`, name: "Bash", input: { command, description: "Long wrapped command identity proof" } };
    const message = { id: `msg_scratch_${requests}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } };
    if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ...message, content: [content], stop_reason: result ? "end_turn" : "tool_use" })); return; }
    res.writeHead(200, { "content-type": "text/event-stream", "connection": "close" });
    const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    event("message_start", { type: "message_start", message });
    event("content_block_start", { type: "content_block_start", index: 0, content_block: result ? { type: "text", text: "" } : { type: "tool_use", id: content.id, name: "Bash", input: {} } });
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: result ? { type: "text_delta", text: content.text } : { type: "input_json_delta", partial_json: JSON.stringify(content.input) } });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", { type: "message_delta", delta: { stop_reason: result ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
    event("message_stop", { type: "message_stop" }); res.end();
  });
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(home,"config"), XDG_DATA_HOME: join(home,"data"), XDG_CACHE_HOME: join(home,"cache"), AGEND_HOME: join(home,"agend"), NOTIFY_SOCKET: "", TERM: "xterm-256color", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: fakeKey, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
const runner = join(scratch, "runner.cjs");
writeFileSync(runner, `const{spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(${JSON.stringify(binary)},['--permission-mode','default','--settings',JSON.stringify({permissions:{ask:['Bash']}}),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}'],{cwd:${JSON.stringify(cwd)},env:${JSON.stringify(env)},stdio:'inherit'});fs.writeFileSync(${JSON.stringify(join(scratch,"child.pid"))},String(c.pid));c.on('exit',code=>process.exit(code??1));`);
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", env: { ...process.env, TMUX: "", NOTIFY_SOCKET: "" } });
const capture = () => tmux("capture-pane", "-p", "-t", session);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (check: (pane: string) => boolean, label: string) => {
  const end = performance.now() + 60_000;
  while (performance.now() < end) { const pane = capture(); if (check(pane)) return pane; await sleep(200); }
  writeFileSync(join(output, "failure.pane.txt"), capture()); throw Error(`Deadline: ${label}`);
};
let receipt: Record<string, unknown> | undefined;
try {
  tmux("-f", "/dev/null", "new-session", "-d", "-s", session, "-x", "96", "-y", "64", "-c", cwd, `${quote(process.execPath)} ${quote(runner)}`);
  await until(p => /❯.*Try|❯\s|>\s/.test(p) && !/Use this API key|trust this folder|Choose the text style|Select login method/.test(p), "ready composer");
  tmux("send-keys", "-l", "-t", session, "Run the isolated long-command probe.");
  await sleep(200); tmux("send-keys", "-t", session, "Enter");
  const pane = await until(p => /Do you want to proceed\?/.test(p), "real permission dialog");
  writeFileSync(join(output, "claude-long-command.pane.txt"), pane.replaceAll(scratch, "/scratch/full-command").replace(/\/[^\n]*\/cwd/g, "/scratch/full-command/cwd"));
  const card = selectionCard(pane, "Claude Code"); assert(card, "complete native request must be readable");
  assert(card.question.includes("FIRST_REQUEST") && card.question.includes("END_REQUEST"), "complete command is shown");
  assert(card.question.replace(/\s/g, "").includes(command.replace(/\s/g, "")), "all command characters appear despite terminal wrapping");
  assert(remoteCardPrompt("scratch", card).message.includes("FIRST_REQUEST"));
  assert.equal(selectionCard(pane.replace("FIRST_REQUEST", "HISTORY_ONLY"), "Claude Code")?.identity, card.identity, "transcript text is outside the live request");
  const changed = selectionCard(pane.replaceAll("FIRST_REQUEST", "OTHER_REQUEST"), "Claude Code");
  assert(changed && changed.identity !== card.identity, "same wrapped tail cannot reuse approval");
  const no = card.options.find(o => /^No\b/.test(o.title)); assert(no, "verified refusal option");
  const keys: string[] = [];
  const outcome = await answerRemoteCard({ locked: async fn => fn(), read: async () => capture(), key: async key => { keys.push(key); tmux("send-keys", "-t", session, key); return true; }, paste: async () => false, sleep, now: () => performance.now() }, p => selectionCard(p, "Claude Code"), card.identity, { kind: "option", n: no.n });
  assert.equal(outcome.outcome, "answered"); assert.equal(keys.filter(k => k === "Enter").length, 1);
  assert(!existsSync(join(cwd, "sentinel")), "refused command did not execute");
  receipt = { sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), version, privateSocket: socket, localMock: true, realAccount: false, requests, fullCommandShown: true, changedPrefixInvalidates: true, verifiedRefusal: outcome, keys, sentinelAbsent: true };
} finally {
  try { tmux("kill-server"); } catch { /* owned server already gone */ }
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  if (existsSync(join(scratch,"child.pid"))) {
    const pid = Number(readFileSync(join(scratch,"child.pid"),"utf8"));
    for (let i=0;i<30;i++) { try { process.kill(pid,0); } catch { break; } await sleep(100); }
    try { process.kill(pid,0); throw Error("Owned Claude has not exited; scratch retained"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
  }
  rmSync(scratch, { recursive: true, force: true });
}
if (receipt) {
  writeFileSync(join(output, "receipt.json"), JSON.stringify({ ...receipt, passed: true, ownedChildExited: true, scratchRemoved: !existsSync(scratch) }, null, 2));
  console.log("PASS: native Claude long wrapped command, complete card, changed-prefix identity, verified refusal, owned cleanup");
}
