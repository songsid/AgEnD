/**
 * #2787 real-CLI smoke: a codex instance restarted with changed instructions gets no reload notice.
 *
 * Run only through run.sh: env -i, a scratch HOME / AGEND_HOME / CODEX_HOME, a private tmux socket and codex talking to
 * a local mock Responses API. No account, no host fleet, no live tmux server. Usage: smoke.mts <repo> <root> <label>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [repo, root, label] = process.argv.slice(2);
const sock = `agend-smoke-2787-${label}`;
const { TmuxManager } = await import(join(repo, "src/tmux-manager.ts"));
const { Daemon } = await import(join(repo, "src/daemon.ts"));
const { CodexBackend } = await import(join(repo, "src/backend/codex.ts"));
const pino = (await import(join(repo, "node_modules/pino/pino.js"))).default;
TmuxManager.setSocketName(sock);
const tmux = (...a: string[]) => execFileSync("tmux", ["-L", sock, ...a], { encoding: "utf8" });
const evidence = join(root, `evidence-${label}`); mkdirSync(evidence, { recursive: true });
const work = join(root, "work"); mkdirSync(work, { recursive: true });
const instanceDir = join(process.env.AGEND_HOME!, "instances", "smoke2787");
const logger = pino({ level: "info" }, pino.destination({ dest: join(root, `daemon-${label}.log`), sync: true }));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const history = () => { try { return tmux("capture-pane", "-p", "-J", "-S", "-2000", "-t", "smoke2787"); } catch { return ""; } };

async function launch(description: string) {
  const config = { backend: "codex", working_directory: work, description, log_level: "info",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 } };
  const d = new Daemon("smoke2787", config, instanceDir, true, new CodexBackend(instanceDir), undefined, logger);
  await d.start();
  for (let i = 0; i < 120 && (d as any).instanceState !== "idle"; i++) await sleep(500);
  await sleep(3000);
  return d;
}

const first = await launch("Smoke instance, description v1.");
writeFileSync(join(evidence, "1-first-launch.pane.txt"), history());
await first.stop();
await sleep(1000);
const second = await launch("Smoke instance, description v2 — changed, so the instructions differ.");
writeFileSync(join(evidence, "2-second-launch.pane.txt"), history());
second.pushChannelMessage("smoke-2787 hello after the instructions changed", { chat_id: "", user: "peer", from_instance: "peer" });
await sleep(25_000);
const pane = history();
writeFileSync(join(evidence, "3-after-message.pane.txt"), pane);
const notice = /instructions have been updated/i.test(pane);
const delivered = pane.includes("smoke-2787 hello after the instructions changed");
console.log(JSON.stringify({ label, delivered, reloadNoticeInPane: notice }));
await second.stop();
try { tmux("kill-server"); } catch { /* gone */ }
process.exit(0);
