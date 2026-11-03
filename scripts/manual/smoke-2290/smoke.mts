/**
 * Real-CLI delivery smoke (M-2290, decision c7e5d374 — delivery-path changes run against real Claude AND Codex, each
 * idle, busy and just resumed). A real Daemon starts the real CLI in a private tmux, with a scratch HOME / AGEND_HOME /
 * CODEX_HOME, talking to a local mock API (no account, no network, no host fleet, no live tmux server), and delivers
 * with pushChannelMessage — the production write path (paste, then the delivery Enter through
 * sendDeliveryEnterAfterAvailability). A message counts as delivered when the CLI's own transcript holds it as a user
 * message, and the composer is empty afterwards (nothing left pasted and unsent).
 *
 * Run only through run.sh. Usage: smoke.mts <repo> <root> <backend: codex|claude-code>
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [repo, root, backendName] = process.argv.slice(2) as [string, string, "codex" | "claude-code"];
const sock = `agend-test-smoke-2290-${backendName}`;
const name = `smoke2290${backendName === "codex" ? "cx" : "cl"}`;
const { TmuxManager } = await import(join(repo, "src/tmux-manager.ts"));
const { Daemon } = await import(join(repo, "src/daemon.ts"));
const { CodexBackend } = await import(join(repo, "src/backend/codex.ts"));
const { ClaudeCodeBackend } = await import(join(repo, "src/backend/claude-code.ts"));
const pino = (await import(join(repo, "node_modules/pino/pino.js"))).default;
TmuxManager.setSocketName(sock);
const tmux = (...a: string[]) => execFileSync("tmux", ["-L", sock, ...a], { encoding: "utf8" });
const evidence = join(root, `evidence-${backendName}`); mkdirSync(evidence, { recursive: true });
const work = join(root, "work"); mkdirSync(work, { recursive: true });
const instanceDir = join(process.env.AGEND_HOME!, "instances", name); mkdirSync(instanceDir, { recursive: true });
const logger = pino({ level: "info" }, pino.destination({ dest: join(root, `daemon-${backendName}.log`), sync: true }));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pane = () => { try { return tmux("capture-pane", "-p", "-J", "-t", name); } catch { return ""; } };

/** Every user-message text the CLI recorded in its own transcript(s). */
function userTexts(): string[] {
  const out: string[] = [];
  const walk = (dir: string, keep: (n: string) => boolean, read: (e: any) => void) => {
    if (!existsSync(dir)) return;
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p, keep, read);
      else if (keep(n)) for (const line of readFileSync(p, "utf8").split("\n")) { try { read(JSON.parse(line)); } catch { /* partial */ } }
    }
  };
  if (backendName === "codex") {
    walk(join(process.env.CODEX_HOME!, "sessions"), n => n.startsWith("rollout-"), e => {
      const pl = e.payload ?? {};
      if (e.type === "response_item" && pl.role === "user") for (const c of pl.content ?? []) if (typeof c.text === "string") out.push(c.text);
    });
  } else {
    walk(join(process.env.HOME!, ".claude", "projects"), n => n.endsWith(".jsonl"), e => {
      if (e.type !== "user") return;
      const c = e.message?.content;
      if (typeof c === "string") out.push(c);
      else for (const part of c ?? []) if (typeof part?.text === "string") out.push(part.text);
    });
  }
  return out;
}
const sessionFiles = (): string[] => {
  const dir = backendName === "codex" ? join(process.env.CODEX_HOME!, "sessions") : join(process.env.HOME!, ".claude", "projects");
  const out: string[] = [];
  const walk = (d: string) => { if (!existsSync(d)) return; for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/^rollout-|\.jsonl$/.test(n)) out.push(n); } };
  walk(dir);
  return out.sort();
};
/** The live input box is empty: nothing pasted and left unsent. */
const claudeReader = new ClaudeCodeBackend(instanceDir);
const composerEmpty = (text: string): boolean => {
  if (backendName === "codex") return /^\s*›\s*Ask Codex to do anything\s*$/m.test(text);
  const box = claudeReader.readInputRow(text);
  return !!box && box.text.trim() === "" && box.collapsedPastes === 0;
};

async function launch() {
  const config: any = { backend: backendName, working_directory: work, log_level: "info", skipPermissions: true,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 } };
  const backend = backendName === "codex" ? new CodexBackend(instanceDir) : new ClaudeCodeBackend(instanceDir);
  const d: any = new Daemon(name, config, instanceDir, true, backend, undefined, logger);
  await d.start();
  for (let i = 0; i < 160 && d.instanceState !== "idle"; i++) await sleep(500);
  await sleep(2500);
  return d;
}
async function deliveredWithin(text: string, ms: number): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (userTexts().some(u => u.includes(text))) return Date.now() - t0;
    await sleep(1000);
  }
  return null;
}
const push = (d: any, text: string) => d.pushChannelMessage(text, { chat_id: "", user: "peer", from_instance: "peer" });
const setCodexMode = (m: string) => writeFileSync(join(root, "mode"), m);

const results: Record<string, unknown> = { backend: backendName };
let d = await launch();
writeFileSync(join(evidence, "0-launched.pane.txt"), pane());

// 1. idle
const idleText = `smoke-2290 ${backendName} IDLE delivery`;
push(d, idleText);
const idleMs = await deliveredWithin(idleText, 90_000);
await sleep(4000);
writeFileSync(join(evidence, "1-idle.pane.txt"), pane());
results.idle = { delivered: idleMs !== null, ms: idleMs, composerEmptyAfter: composerEmpty(pane()) };

// 2. busy: a slow turn first, then a second message while it runs
if (backendName === "codex") setCodexMode("slow");
const slowText = `smoke-2290 ${backendName} SLOW turn`;
push(d, slowText);
/** A turn is running on the pane: codex's live status row, claude's spinner row (`✢ Perusing… (9s · …)`). */
const turnRunning = (text: string) => backendName === "codex" ? /^• .*\(\d+s • esc to interrupt\)/m.test(text) : /^\S\s+\S+…\s+\(\d+s\b/m.test(text);
let busyPane = "";
for (let i = 0; i < 60; i++) { busyPane = pane(); if (turnRunning(busyPane)) break; await sleep(250); }
writeFileSync(join(evidence, "2a-busy-before.pane.txt"), busyPane);
const busyText = `smoke-2290 ${backendName} BUSY delivery`;
push(d, busyText);
const busyMs = await deliveredWithin(busyText, 150_000);
if (backendName === "codex") setCodexMode("ok");
await sleep(6000);
writeFileSync(join(evidence, "2b-busy-after.pane.txt"), pane());
results.busy = { turnRunningWhenPushed: turnRunning(busyPane), slowDelivered: userTexts().some(u => u.includes(slowText)), delivered: busyMs !== null, ms: busyMs, composerEmptyAfter: composerEmpty(pane()) };

// 3. just resumed: stop, start again on the same instance (the CLI resumes its conversation), deliver at once
const sessionsBefore = sessionFiles();
await d.stop();
await sleep(1500);
d = await launch();
writeFileSync(join(evidence, "3a-resumed.pane.txt"), pane());
const resumedText = `smoke-2290 ${backendName} RESUMED delivery`;
push(d, resumedText);
const resumedMs = await deliveredWithin(resumedText, 90_000);
await sleep(4000);
writeFileSync(join(evidence, "3b-resumed-after.pane.txt"), pane());
const sessionsAfter = sessionFiles();
results.resumed = { delivered: resumedMs !== null, ms: resumedMs, composerEmptyAfter: composerEmpty(pane()),
  sameConversation: sessionsAfter.length === sessionsBefore.length, sessionsBefore: sessionsBefore.length, sessionsAfter: sessionsAfter.length };

await d.stop();
try { tmux("kill-server"); } catch { /* gone */ }
results.pass = (["idle", "busy", "resumed"] as const).every(k => (results[k] as any).delivered && (results[k] as any).composerEmptyAfter)
  && (results.busy as any).turnRunningWhenPushed && (results.resumed as any).sameConversation;
console.log(JSON.stringify(results));
process.exit(0);
