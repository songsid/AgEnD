// Live acceptance for the cold-cache resume prompt (2.1.319 audit, 2026-11-07): AgEnD's real startup scan
// (Daemon.dismissDialogsUntilReady + ClaudeCodeBackend) against the real Claude binary, launched by the production
// writeConfig + buildCommand with --continue, on a backdated 180k-token session.
//
// Isolation (decision bd0c88aa): everything runs inside `unshare -rn` (loopback only) — a private tmux server on a
// socket file under RIG, the Messages mock (mockapi.py) and an explicit HTTPS proxy that serves the server flags with a
// scratch CA (flags.mjs). The home is claude.ai-shaped with FAKE tokens; no real account, nothing leaves the host.
// IS_SANDBOX=1 only because the namespace maps us to uid 0 and Claude refuses --dangerously-skip-permissions as root.
//
//   RIG=<dir with sock, envs3, h1-aged-backup, w1, proxy.port, ca.pem, flags.json> BIN=<dir with 2.1.318/2.1.319> \
//     npx tsx scripts/manual/claude-version-audit/cold-resume-live.mts [case ...]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeBackend } from "../../../src/backend/claude-code.js";
import { Daemon } from "../../../src/daemon.js";

const RIG = process.env.RIG!, BIN = process.env.BIN!, SOCK = join(RIG, "sock");
const tmux = (...a: string[]) => execFileSync("tmux", ["-S", SOCK, ...a], { encoding: "utf8" });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const TIER = { fiveHourCredits: { default_claude_max_20x: 1000 }, creditsPerMillionTokens: { "claude-opus-5-5": 1000 } };
const CASES: Record<string, { v: string; width: number; flags: Record<string, unknown> }> = {
  "319-lookup": { v: "319", width: 160, flags: { tengu_amber_tally: TIER } },
  "319-nolookup": { v: "319", width: 160, flags: { tengu_amber_tally: { ...TIER, newConversationPointer: false } } },
  "319-summary-lookup": { v: "319", width: 160, flags: { tengu_amber_tally: TIER, tengu_eager_brooks: true } },
  "319-summary-nolookup": { v: "319", width: 160, flags: { tengu_amber_tally: { ...TIER, newConversationPointer: false }, tengu_eager_brooks: true } },
  "319-summary-lookup-80": { v: "319", width: 80, flags: { tengu_amber_tally: TIER, tengu_eager_brooks: true } },
  "319-summary-newfocus": { v: "319", width: 160, flags: { tengu_amber_tally: TIER, tengu_eager_brooks: true, tengu_stateful_mitten: true } },
  "318-lookup": { v: "318", width: 160, flags: { tengu_amber_tally: TIER } },
};
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;

async function run(name: string): Promise<boolean> {
  const c = CASES[name]!;
  writeFileSync(join(RIG, "flags.json"), JSON.stringify(c.flags));
  const home = join(RIG, `acc-${name}`), inst = join(RIG, `acc-inst-${name}`), work = join(RIG, "w1");
  rmSync(home, { recursive: true, force: true }); rmSync(inst, { recursive: true, force: true });
  cpSync(join(RIG, "h1-aged-backup"), home, { recursive: true }); mkdirSync(inst, { recursive: true });
  // An instance that has run before: its session marker, so buildCommand resumes (--continue).
  writeFileSync(join(inst, "session-id"), "acc\n");
  const envs = readFileSync(join(RIG, "envs3"), "utf8").trim().replaceAll(join(RIG, "h1"), home);
  // The production command, built in-process with the instance's env (no API key: the home is claude.ai-shaped).
  const saved = { ...process.env };
  for (const kv of envs.split(" ")) { const i = kv.indexOf("="); process.env[kv.slice(0, i)] = kv.slice(i + 1); }
  delete process.env.ANTHROPIC_API_KEY;
  const backend = new ClaudeCodeBackend(inst);
  (backend as any).binaryPath = join(BIN, `2.1.${c.v}`);
  const config = { workingDirectory: work, instanceDir: inst, instanceName: "audit", mcpServers: {}, skipPermissions: true, skipResume: false };
  backend.preTrust?.(work); backend.writeConfig(config as any);
  const cmd = backend.buildCommand(config as any);
  process.env = saved;
  if (!/--continue|--resume/.test(cmd)) throw new Error(`${name}: the production command does not resume`);
  writeFileSync(join(inst, "cmd.txt"), cmd);
  const session = `acc-${name}`.replace(/\./g, "_");
  try { execFileSync("tmux", ["-S", SOCK, "kill-session", "-t", session], { stdio: "ignore" }); } catch {}
  tmux("new-session", "-d", "-s", session, "-x", String(c.width), "-y", "50", "-c", work,
    `env -i PATH=${process.env.PATH} ${envs} bash -c '${cmd.replace(/'/g, "'\\''")}'; echo EXITED rc=$?; sleep 3600`);

  const keys: string[] = [];
  const daemon: any = new Daemon("audit", {
    working_directory: work, log_level: "error", backend: "claude-code",
    restart_policy: { max_retries: 1, backoff: "linear", reset_after: 1 }, context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  } as any, inst, false, backend as any, undefined, logger);
  let sawDialog = false;
  daemon.tmux = {
    capturePane: async () => { const p = tmux("capture-pane", "-p", "-t", session); if (p.includes("Resume this conversation?") && !sawDialog) { sawDialog = true; writeFileSync(join(RIG, "frames", `acc-${name}-dialog.txt`), p); } return p; },
    sendSpecialKey: async (k: string) => { keys.push(k); tmux("send-keys", "-t", session, k); return true; },
    sendKeys: async (t: string) => { keys.push(`text:${t}`); tmux("send-keys", "-t", session, "-l", t); return true; },
    getWindowId: () => "@acc",
  };
  daemon.paneLiveness = async () => "alive";
  const ready = await daemon.dismissDialogsUntilReady(45_000, 250);
  await sleep(1500);
  const after = tmux("capture-pane", "-p", "-t", session);
  const proj = join(home, ".claude", "projects");
  const files = readdirSync(proj).flatMap(d => readdirSync(join(proj, d)).filter(f => f.endsWith(".jsonl")).map(f => join(proj, d, f)));
  const text = files.map(f => readFileSync(f, "utf8")).join("");
  const compacted = /"compact_boundary"|isCompactSummary/.test(text);
  const ok = sawDialog && ready === true && keys.join(",") === "Escape" && !after.includes("Resume this conversation?")
    && files.length === 1 && !compacted && after.includes("BIG hello");
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: dialog seen ${sawDialog}, ready ${ready}, keys [${keys.join(",")}], sessions ${files.length}, compacted ${compacted}, history kept ${after.includes("BIG hello")}`);
  writeFileSync(join(RIG, "frames", `acc-${name}-after.txt`), after);
  tmux("kill-session", "-t", session);
  return ok;
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASES);
if (!existsSync(SOCK)) throw new Error("no rig tmux socket");
let pass = 0;
for (const n of names) if (await run(n)) pass++;
console.log(`${pass}/${names.length} PASS`);
process.exit(pass === names.length ? 0 : 1);
