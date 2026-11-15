// M-3175: the REAL Daemon and TmuxManager drive codex's in-session switch on a rig pane: the raw_paste route with our switch spec,
// its gate (idle, running version, rollout checkpoint), its own delivery path, and its verdict — the runtime_switch_result it
// would send the fleet, printed here. Only the fleet side is absent (the broadcast is captured; wake() is a no-op: the rig codex is up).
// The rig's private tmux server and homes only:
//   AGEND_HOME=$AH AGEND_TMUX_BIN=/usr/bin/tmux SOCK=cx01690-… SESSION=b INST=$RUN/inst-b WORKDIR=$RUN/b-work \
//     npx tsx daemon-switch.mts '{"model":"gpt-6-astra","effort":"high"}' …
import { execFileSync } from "node:child_process";
import { TmuxManager } from "../../../src/tmux-manager.js";
import { Daemon } from "../../../src/daemon.js";
import { CodexBackend } from "../../../src/backend/codex.js";
import { codexModelCommand } from "../../../src/backend/codex-model-switch.js";

const { SOCK, SESSION, INST, WORKDIR, AGEND_HOME } = process.env;
if (!SOCK || !SESSION || !INST || !WORKDIR) throw new Error("set SOCK, SESSION, INST, WORKDIR (rig.sh paths)");
if (!AGEND_HOME || /\/\.agend\/?$/.test(AGEND_HOME)) throw new Error("set AGEND_HOME to the rig's AH (rig.sh paths), never the host's");
TmuxManager.setSocketName(SOCK);
const windowId = execFileSync("tmux", ["-L", SOCK, "list-windows", "-t", SESSION, "-F", "#{window_id}"], { encoding: "utf8" }).trim().split("\n")[0]!;
const logger = { debug() {}, info() {}, warn(...a: unknown[]) { console.error("warn", JSON.stringify(a).slice(0, 300)); }, error() {}, child() { return logger; } } as any;
const d: any = new Daemon("rig", {
  working_directory: WORKDIR, backend: "codex", log_level: "silent",
  restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
} as any, INST, false, new CodexBackend(INST), undefined, logger);
d.tmux = new TmuxManager(SESSION, windowId);
const results: unknown[] = [];
d.ipcServer = { broadcast: (m: { type?: string }) => { if (m.type === "runtime_switch_result") results.push(m); }, send: () => {} };
d.wake = async () => {};

for (const [i, arg] of process.argv.slice(2).entries()) {
  const want = JSON.parse(arg) as { model: string | null; effort: string | null };
  const line = codexModelCommand(want.model, want.effort)!;
  d.handleRawPasteIpcMessage({ type: "raw_paste", content: line, runtime_switch: { id: `rig-${i}`, kind: "model", requested: want.model ?? "", codex: want } });
  await d.pasteLock;
  console.log(JSON.stringify({ asked: want, typed: line, result: results.at(-1) ?? null }));
}
process.exit(0);
