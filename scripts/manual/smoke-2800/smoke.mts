/**
 * #2800 real-CLI acceptance: what an agent upgraded from 2.3.1 to 2.3.2 receives with its next message.
 *
 * Run only through run.sh: env -i, a scratch HOME / AGEND_HOME / CODEX_HOME, a private tmux socket and real codex talking
 * to a local mock Responses API. No account, no host fleet, no live tmux server. A checkout has no release version, so
 * the launch's what's-new plan is made for "2.3.2" right after start, from a record that holds everything up to 2.3.1.
 * Usage: smoke.mts <repo> <root> <label>; SMOKE_PACKS=1 switches office_pack_access on (the 2.3.2 entry's tools).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [repo, root, label] = process.argv.slice(2);
const packs = process.env.SMOKE_PACKS === "1";
const sock = `agend-smoke-2800-${label}`;
const { TmuxManager } = await import(join(repo, "src/tmux-manager.ts"));
const { Daemon } = await import(join(repo, "src/daemon.ts"));
const { CodexBackend } = await import(join(repo, "src/backend/codex.ts"));
const { AGENT_WHATS_NEW, recordWhatsNew, readWhatsNewRecord } = await import(join(repo, "src/agent-whats-new.ts"));
const pino = (await import(join(repo, "node_modules/pino/pino.js"))).default;
TmuxManager.setSocketName(sock);
const tmux = (...a: string[]) => execFileSync("tmux", ["-L", sock, ...a], { encoding: "utf8" });
const evidence = join(root, `evidence-${label}`); mkdirSync(evidence, { recursive: true });
const work = join(root, "work"); mkdirSync(work, { recursive: true });
const instanceDir = join(process.env.AGEND_HOME!, "instances", "smoke2800"); mkdirSync(instanceDir, { recursive: true });
const logger = pino({ level: "debug" }, pino.destination({ dest: join(root, `daemon-${label}.log`), sync: true }));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const history = () => { try { return tmux("capture-pane", "-p", "-J", "-S", "-3000", "-t", "smoke2800"); } catch { return ""; } };
const userEntries = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (n.startsWith("rollout-")) {
    for (const line of readFileSync(p, "utf8").split("\n")) { try { const e = JSON.parse(line); const pl = e.payload ?? {};
      if (e.type === "response_item" && pl.role === "user") for (const c of pl.content ?? []) if (typeof c.text === "string" && !c.text.startsWith("<")) out.push(c.text); } catch { /* partial */ } } } } };
  try { walk(join(process.env.CODEX_HOME!, "sessions")); } catch { /* none yet */ }
  return out;
};

// Told everything up to 2.3.1 before; 2.3.2's office-pack entry is new.
recordWhatsNew(instanceDir, AGENT_WHATS_NEW.filter((e: any) => e.id !== "2.3.2-office-pack-tools").map((e: any) => e.id), "2.3.1");
writeFileSync(join(instanceDir, "prev-instructions"), "launched before");
const config: any = { backend: "codex", working_directory: work, log_level: "debug",
  restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  ...(packs ? { office_pack_access: true } : {}) };
const d: any = new Daemon("smoke2800", config, instanceDir, true, new CodexBackend(instanceDir), undefined, logger);
await d.start();
for (let i = 0; i < 120 && d.instanceState !== "idle"; i++) await sleep(500);
await sleep(2000);
d.prepareWhatsNew(false, "2.3.2");
const planned = d.pendingWhatsNew ? d.pendingWhatsNew.ids : null;
d.pushChannelMessage("smoke-2800: the real task", { chat_id: "", user: "peer", from_instance: "peer" });
await sleep(25_000);
const pane = history();
writeFileSync(join(evidence, "pane.txt"), pane);
const users = userEntries();
writeFileSync(join(evidence, "codex-user-entries.json"), JSON.stringify(users, null, 2));
const withTask = users.filter(u => u.includes("smoke-2800: the real task"));
const record = readWhatsNewRecord(instanceDir);
console.log(JSON.stringify({
  label, officePackAccess: packs, planned,
  codexUserTurns: users.length,
  noticeTurnsOfItsOwn: users.filter(u => u.startsWith("[system:whats-new]") && !u.includes("smoke-2800: the real task")).length,
  taskTurnStartsWithNotice: withTask.length === 1 && withTask[0]!.startsWith("[system:whats-new]"),
  noticeNamesPackTools: users.some(u => u.includes("office_pack_check")),
  linksNotes: users.some(u => u.includes("https://songsid.github.io/AgEnD/docs/whats-new/")),
  recordedPackEntry: record && record !== "unreadable" ? record.announced.includes("2.3.2-office-pack-tools") : record,
  pendingAfter: d.pendingWhatsNew,
}));
await d.stop();
try { tmux("kill-server"); } catch { /* gone */ }
process.exit(0);
