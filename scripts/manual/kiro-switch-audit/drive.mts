// M-3180 (S-157): drive kiro's TUI switch the way the daemon does, with the production code, on the rig's kiro (switch.sh's container,
// tmux socket `k`, session `u`): the running version from the pane's processes (cliRunningVersion + the entry's minimum), the
// session record found from the pane (the entry's checkpoint), the command, and the entry's verdict polled for 10 s. One JSON line a
// step. Never the host's kiro or tmux: run INSIDE the container (HOME and KIRO_HOME are the rig's).
//   docker exec -u 1000 -e KIRO_HOME=/home/u/h/.kiro -w /src k npx tsx scripts/manual/kiro-switch-audit/drive.mts model:claude-sonnet-4.6 effort:low …
import { execFileSync } from "node:child_process";
import { KIRO_RUNTIME_SWITCH, cliRunningVersion, cliSwitchAllowed } from "../../../src/backend/cli-runtime-switch.js";

if (!process.env.KIRO_HOME?.startsWith("/home/u/")) throw new Error("run inside the rig container with KIRO_HOME=/home/u/h/.kiro");
const tmux = (...a: string[]) => execFileSync("tmux", ["-L", "k", ...a], { encoding: "utf8" });
const capture = () => tmux("capture-pane", "-p", "-S", "-200", "-t", "u");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const e = KIRO_RUNTIME_SWITCH;
for (const spec of process.argv.slice(2)) {
  const [kind, value] = spec.split(":");
  const step = kind === "model" ? { model: value!, effort: null } : { model: null, effort: value! };
  const pid = Number(tmux("list-panes", "-t", "u", "-F", "#{pane_pid}").trim());
  const version = await cliRunningVersion(pid, { backend: "kiro-cli", matchExe: e.matchExe });
  const line = e.command(step);
  if (!cliSwitchAllowed(e, step, version) || !line) { console.log(JSON.stringify({ spec, version, typed: false })); continue; }
  const pane = capture();
  const record = await e.checkpoint!(pane, process.cwd(), pid);
  tmux("send-keys", "-t", "u", "-l", line); await sleep(400); tmux("send-keys", "-t", "u", "Enter");
  let verdict: unknown = { outcome: "not_confirmed" };
  for (const end = Date.now() + 10_000; Date.now() < end; await sleep(200)) {
    const v = await e.verify(step, { pane, ...(record !== undefined ? { record } : {}) }, { pane: capture() });
    if (v) { verdict = v; break; }
  }
  console.log(JSON.stringify({ spec, version, typed: line, record: record ?? null, ...(verdict as object) }));
  tmux("send-keys", "-t", "u", "Escape"); await sleep(800);
}
