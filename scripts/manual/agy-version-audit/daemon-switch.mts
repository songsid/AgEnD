// Actual Daemon/TmuxManager route on the PRIVATE agy audit pane. No Fleet starts.
import { execFileSync } from "node:child_process";
import { TmuxManager } from "../../../src/tmux-manager.js";
import { Daemon } from "../../../src/daemon.js";
import { AntigravityBackend } from "../../../src/backend/antigravity.js";
import { readAgyCliEnv } from "../../../src/backend/effort-metadata.js";
import { agySwitchCommand } from "../../../src/backend/agy-model-switch.js";

const { SOCK, SESSION, INST, WORKDIR, AGEND_HOME } = process.env;
if (!SOCK || !SESSION || !INST || !WORKDIR) throw new Error("set SOCK, SESSION, INST, WORKDIR (rig.sh paths)");
if (!AGEND_HOME || /\/\.agend\/?$/.test(AGEND_HOME)) throw new Error("set AGEND_HOME to the rig's AH (rig.sh paths), never the host's");
TmuxManager.setSocketName(SOCK);
const windowId = execFileSync("tmux", ["-L", SOCK, "list-windows", "-t", SESSION, "-F", "#{window_id}"], { encoding: "utf8" }).trim().split("\n")[0]!;
const logger = { debug() {}, info() {}, warn(...a: unknown[]) { console.error("warn", JSON.stringify(a).slice(0, 300)); }, error() {}, child() { return logger; } } as any;
const d: any = new Daemon("rig", {
  working_directory: WORKDIR, backend: "antigravity", log_level: "silent",
  restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
} as any, INST, false, new AntigravityBackend(INST), undefined, logger);
d.tmux = new TmuxManager(SESSION, windowId);
const results: unknown[] = [];

d.ipcServer = { broadcast: (m: { type?: string }) => { if (m.type === "runtime_switch_result") results.push(m); }, send: () => {} };
d.wake = async () => {};

for (const [i, arg] of process.argv.slice(2).entries()) {
  const want = JSON.parse(arg) as { model: string | null; effort: string | null };
  const line = agySwitchCommand(want, readAgyCliEnv()?.models ?? []);
  if (!line) throw Error("The isolated catalog cannot build this switch");
  d.handleRawPasteIpcMessage({ type: "raw_paste", content: line, runtime_switch: { id: `rig-${i}`, kind: "model", requested: want.model ?? "", cli: { backend: "antigravity", ...want } } });
  await d.pasteLock;
  const result = results.at(-1) as { outcome?: string } | undefined;
  console.log(JSON.stringify({ asked: want, typed: line, result: result ?? null }));
  if (result?.outcome !== (process.env.EXPECTED_OUTCOME || "switched")) throw Error("Unexpected production switch verdict");
}
process.exit(0);
