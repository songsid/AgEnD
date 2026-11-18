// Live acceptance for the resume-from-summary menu (2.1.326 audit, 2026-11-17): AgEnD's real startup scan
// (Daemon.dismissDialogsUntilReady + ClaudeCodeBackend) against the real Claude binary, launched by the production
// writeConfig + buildCommand with --continue, on a backdated 180k-token session, with the server flag that shows the
// menu (tengu_gleaming_fair; the session must be >= 70 min old and >= 100k tokens). AgEnD must pick "Resume full
// session as-is" (Down, Enter): the history kept, nothing compacted. 2.1.326 renamed its third row "Don't ask again".
// The rig is cold-resume/rig.sh (same RIG/BIN); run it as resume-menu.mts [case ...].
//
// Isolation (decision bd0c88aa): everything runs inside `unshare -rn` (loopback only) — a private tmux server on a
// socket file under RIG, the Messages mock (mockapi.py) and an explicit HTTPS proxy that serves the server flags with a
// scratch CA (flags.mjs). The home is claude.ai-shaped with FAKE tokens; no real account, nothing leaves the host.
// IS_SANDBOX=1 only because the namespace maps us to uid 0 and Claude refuses --dangerously-skip-permissions as root.
//
//   RIG=<dir with sock, envs3, h1-aged-backup, w1, proxy.port, ca.pem, flags.json> BIN=<dir with 2.1.318/2.1.319/2.1.322/2.1.325> \
//     npx tsx scripts/manual/claude-version-audit/cold-resume/live.mts [case ...]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeBackend } from "../../../../src/backend/claude-code.js";
import { Daemon } from "../../../../src/daemon.js";

const RIG = process.env.RIG!, BIN = process.env.BIN!, SOCK = join(RIG, "sock");
const tmux = (...a: string[]) => execFileSync("tmux", ["-S", SOCK, ...a], { encoding: "utf8" });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const TIER = { fiveHourCredits: { default_claude_max_20x: 1000 }, creditsPerMillionTokens: { "claude-opus-5-5": 1000 } };
const CASES: Record<string, { v: string; width: number; flags: Record<string, unknown> }> = {
  "325-menu": { v: "325", width: 160, flags: { tengu_gleaming_fair: true } },
  "326-menu": { v: "326", width: 160, flags: { tengu_gleaming_fair: true } },
  "326-menu-80": { v: "326", width: 80, flags: { tengu_gleaming_fair: true } },
  "327-menu": { v: "327", width: 160, flags: { tengu_gleaming_fair: true } },
  "327-menu-80": { v: "327", width: 80, flags: { tengu_gleaming_fair: true } },
};
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;

async function run(name: string): Promise<boolean> {
  const c = CASES[name]!;
  writeFileSync(join(RIG, "flags.json"), JSON.stringify(c.flags));
  const home = join(RIG, `menu-${name}`), inst = join(RIG, `menu-inst-${name}`), work = join(RIG, "w1");
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
  const session = `menu-${name}`.replace(/\./g, "_");
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
    capturePane: async () => { const p = tmux("capture-pane", "-p", "-t", session); if (p.includes("Resume full session as-is") && !sawDialog) { sawDialog = true; writeFileSync(join(RIG, "frames", `menu-${name}-dialog.txt`), p); } return p; },
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
  const ok = sawDialog && ready === true && keys.join(",") === "Down,Enter" && !after.includes("Resume full session as-is")
    && !compacted && after.includes("BIG hello");
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: menu seen ${sawDialog}, ready ${ready}, keys [${keys.join(",")}], sessions ${files.length}, compacted ${compacted}, history kept ${after.includes("BIG hello")}, menu gone ${!after.includes("Resume full session as-is")}`);
  writeFileSync(join(RIG, "frames", `menu-${name}-after.txt`), after);
  tmux("kill-session", "-t", session);
  return ok;
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASES);
if (!existsSync(SOCK)) throw new Error("no rig tmux socket");
let pass = 0;
for (const n of names) if (await run(n)) pass++;
console.log(`${pass}/${names.length} PASS`);
process.exit(pass === names.length ? 0 : 1);
