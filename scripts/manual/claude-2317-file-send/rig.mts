/**
 * Shared isolated rig for Claude Code 2.1.317 (M-2296): the real Claude TUI binary named by CLAUDE_BIN, a private
 * tmux socket, a scratch HOME and a synthetic loopback Anthropic API with a fake key. No account, fleet, systemd,
 * live tmux server or operator settings are touched. Every helper here is owned by one rig and torn down by close().
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Turn { kind: "text"; text: string; delayMs?: number }
export interface ToolTurn { kind: "tool"; name: string; input: Record<string, unknown> }
export type Reply = Turn | ToolTurn;

export interface Rig {
  scratch: string; home: string; cwd: string; socket: string; session: string;
  /** Every user prompt the mock API received, in order (the text of the last user message). */
  prompts: string[];
  tmux(...args: string[]): string;
  capture(): string;
  until(check: (pane: string) => boolean, label: string, ms?: number): Promise<string>;
  launch(args: string[]): void;
  /** A shell command that runs the CLI with these args in the rig's cwd and env (for a window AgEnD's TmuxManager opens). */
  runnerCommand(args: string[]): string;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The text of the newest user message a request carries, tool results excluded. */
function lastUserText(body: { messages?: Array<{ role: string; content: unknown }> }): string {
  const users = (body.messages ?? []).filter(m => m.role === "user");
  const last = users.at(-1);
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return (last.content as Array<{ type: string; text?: string }>).filter(b => b.type === "text").map(b => b.text ?? "").join("\n");
}

export async function openRig(output: string, reply: (prompt: string, n: number, hasToolResult: boolean) => Reply): Promise<Rig> {
  const binary = process.env.CLAUDE_BIN;
  if (!binary || !existsSync(binary)) throw Error("Set CLAUDE_BIN to a private copy of the Claude Code binary under test");
  mkdirSync(output, { recursive: true });
  const scratch = mkdtempSync(join(resolve(output), "private-")), home = join(scratch, "home"), cwd = join(scratch, "cwd");
  mkdirSync(home); mkdirSync(cwd);
  const config = join(home, ".claude"); mkdirSync(config);
  const fakeKey = `sk-ant-api03-${"test".repeat(22)}-testtestAA`;
  writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, theme: "dark", customApiKeyResponses: { approved: [fakeKey.slice(-20)], rejected: [] }, projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  const prompts: string[] = [];
  let requests = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", async () => {
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(req.url?.includes("count_tokens") ? { input_tokens: 100 } : {})); return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      // Side requests (titles, summaries) carry no tools and a short system prompt: answer them plainly.
      const main = Array.isArray(body.tools) && body.tools.length > 0;
      const text = lastUserText(body);
      const toolResult = JSON.stringify(body.messages ?? []).includes('"tool_result"');
      if (main && !toolResult) prompts.push(text);
      requests++;
      const out: Reply = main ? reply(text, requests, toolResult) : { kind: "text", text: "Title" };
      if (out.kind === "text" && out.delayMs) await sleep(out.delayMs);
      const id = `toolu_scratch_${requests}`;
      const message = { id: `msg_scratch_${requests}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } };
      const block = out.kind === "text" ? { type: "text", text: out.text } : { type: "tool_use", id, name: out.name, input: out.input };
      const stop = out.kind === "text" ? "end_turn" : "tool_use";
      if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ...message, content: [block], stop_reason: stop })); return; }
      res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      event("message_start", { type: "message_start", message });
      event("content_block_start", { type: "content_block_start", index: 0, content_block: out.kind === "text" ? { type: "text", text: "" } : { type: "tool_use", id, name: out.name, input: {} } });
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: out.kind === "text" ? { type: "text_delta", text: out.text } : { type: "input_json_delta", partial_json: JSON.stringify(out.input) } });
      event("content_block_stop", { type: "content_block_stop", index: 0 });
      event("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
      event("message_stop", { type: "message_stop" }); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), AGEND_HOME: join(home, "agend"), NOTIFY_SOCKET: "", TERM: "xterm-256color", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: fakeKey, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
  const socket = `agend-test-cc2317-${process.pid}`, session = "proof";
  const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", env: { ...process.env, TMUX: "", NOTIFY_SOCKET: "" } });
  const capture = () => tmux("capture-pane", "-p", "-t", session);
  const until = async (check: (pane: string) => boolean, label: string, ms = 60_000) => {
    const end = performance.now() + ms;
    while (performance.now() < end) { const pane = capture(); if (check(pane)) return pane; await sleep(200); }
    writeFileSync(join(output, `failure-${label.replace(/\W+/g, "-")}.pane.txt`), capture()); throw Error(`Deadline: ${label}`);
  };
  let runs = 0;
  const pids: number[] = [];
  const runnerCommand = (args: string[]) => {
    const runner = join(scratch, `runner-${++runs}.cjs`), pidFile = join(scratch, `child-${runs}.pid`);
    writeFileSync(runner, `const{spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(${JSON.stringify(binary)},${JSON.stringify(args)},{cwd:${JSON.stringify(cwd)},env:${JSON.stringify(env)},stdio:'inherit'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.on('exit',code=>process.exit(code??1));`);
    pids.push(runs);
    return `${quote(process.execPath)} ${quote(runner)}`;
  };
  const launch = (args: string[]) => {
    const runner = join(scratch, `runner-${++runs}.cjs`), pidFile = join(scratch, `child-${runs}.pid`);
    writeFileSync(runner, `const{spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(${JSON.stringify(binary)},${JSON.stringify(args)},{cwd:${JSON.stringify(cwd)},env:${JSON.stringify(env)},stdio:'inherit'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.on('exit',code=>process.exit(code??1));`);
    try { tmux("kill-session", "-t", session); } catch { /* none yet */ }
    if (runs === 1) tmux("-f", "/dev/null", "new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", cwd, `${quote(process.execPath)} ${quote(runner)}`);
    else tmux("new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", cwd, `${quote(process.execPath)} ${quote(runner)}`);
    pids.push(runs);
  };
  const close = async () => {
    try { tmux("kill-server"); } catch { /* owned server already gone */ }
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    for (const n of pids) {
      const file = join(scratch, `child-${n}.pid`);
      if (!existsSync(file)) continue;
      const pid = Number(readFileSync(file, "utf8"));
      for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); } catch { break; } await sleep(100); }
      try { process.kill(pid, 0); throw Error(`Owned Claude ${pid} has not exited; scratch retained at ${scratch}`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    }
    rmSync(scratch, { recursive: true, force: true });
  };
  return { scratch, home, cwd, socket, session, prompts, tmux, capture, until, launch, runnerCommand, close };
}

/** Replace the scratch paths in a capture before it is kept as a fixture. */
export function scrub(pane: string, rig: Rig): string {
  return pane.replaceAll(rig.cwd, "/scratch/cwd").replaceAll(rig.home, "/scratch/home").replaceAll(rig.scratch, "/scratch");
}
