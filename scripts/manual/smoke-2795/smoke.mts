/**
 * #2795 real-CLI smoke: an agent's reply that merely quotes an auth error puts the daemon in no error/auth state.
 *
 * Run only through run.sh: env -i, a scratch HOME / AGEND_HOME / CODEX_HOME, a private tmux socket and codex talking to
 * a local mock Responses API whose answer quotes "Error: 401 Unauthorized". No lifecycle is attached, so no token-free
 * verdict ever arrives: what is printed is exactly what the pane text alone did. Usage: smoke.mts <repo> <root> <label>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [repo, root, label] = process.argv.slice(2);
const sock = `agend-smoke-2795-${label}`;
const { TmuxManager } = await import(join(repo, "src/tmux-manager.ts"));
const { Daemon } = await import(join(repo, "src/daemon.ts"));
const { CodexBackend } = await import(join(repo, "src/backend/codex.ts"));
const pino = (await import(join(repo, "node_modules/pino/pino.js"))).default;
TmuxManager.setSocketName(sock);
const tmux = (...a: string[]) => execFileSync("tmux", ["-L", sock, ...a], { encoding: "utf8" });
const evidence = join(root, `evidence-${label}`); mkdirSync(evidence, { recursive: true });
const work = join(root, "work"); mkdirSync(work, { recursive: true });
const instanceDir = join(process.env.AGEND_HOME!, "instances", "smoke2795");
const logFile = join(root, `daemon-${label}.log`);
const logger = pino({ level: "info" }, pino.destination({ dest: logFile, sync: true }));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const history = () => { try { return tmux("capture-pane", "-p", "-J", "-S", "-2000", "-t", "smoke2795"); } catch { return ""; } };

const config = { backend: "codex", working_directory: work, log_level: "info",
  restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 } };
const d: any = new Daemon("smoke2795", config, instanceDir, true, new CodexBackend(instanceDir), undefined, logger);
// The state a sender, the hang detector and MCP auto-restart see right when the match fires (emit is synchronous).
const errors: any[] = []; d.on("pty_error", (e: any) => errors.push({ type: e.type,
  atMatch: { isErrorState: d.isErrorState, lastErrorType: d.lastErrorType, authFailureUnresolved: d.authFailureUnresolved } }));
await d.start();
for (let i = 0; i < 120 && d.instanceState !== "idle"; i++) await sleep(500);
await sleep(2000);
d.pushChannelMessage("smoke-2795: show me the log line", { chat_id: "", user: "peer", from_instance: "peer" });
await sleep(30_000);
const pane = history();
writeFileSync(join(evidence, "pane.txt"), pane);
console.log(JSON.stringify({
  label,
  quotedInPane: pane.includes("Error: 401 Unauthorized"),
  authMatch: errors.find((e: any) => e.type === "auth_error") ?? null,
  otherPtyErrors: errors.filter((e: any) => e.type !== "auth_error").length,
  "PTY error detected logged": readFileSync(logFile, "utf8").includes("PTY error detected: OpenAI authentication error"),
}));
await d.stop();
try { tmux("kill-server"); } catch { /* gone */ }
process.exit(0);
