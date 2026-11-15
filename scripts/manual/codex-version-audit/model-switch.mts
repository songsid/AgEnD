// M-3175: codex's in-session `/model [NAME] --reasoning=LEVEL`, driven the way the daemon drives it, on a rig codex (rig.sh launch).
// Every step is the production code: the running-version probe on the pane's process (codexRunningVersion), the 0.164.0 gate,
// the line (codexModelCommand), the rollout checkpoint from the footer (CodexBackend.readRawPasteSession + checkpointCodexPane), and
// the verdict (the rollout's thread_settings_applied delta, else codex's own answer on the pane). It prints one JSON line per case.
// Never the host's codex or tmux: SOCK is the rig's private socket, INST the rig instance dir.
//   AGEND_HOME=$AH SOCK=cx01690-… INST=$RUN/inst-a WORKDIR=$RUN/work npx tsx model-switch.mts <case>…   case = model:effort | :effort | model: (empty = leave)
import { execFileSync } from "node:child_process";
import { CodexBackend } from "../../../src/backend/codex.js";
import { checkpointCodexPane } from "../../../src/codex-pane-ownership.js";
import { codexAppliedFromRollout, codexModelCommand, codexRunningVersion, codexSupportsInlineModel, codexSwitchAnswerCount, codexSwitchFromPane, readFrom } from "../../../src/backend/codex-model-switch.js";

const SOCK = process.env.SOCK!, INST = process.env.INST!, WORKDIR = process.env.WORKDIR!, WIN = process.env.WIN ?? "a";
if (!SOCK || !INST || !WORKDIR) throw new Error("set SOCK, INST and WORKDIR (rig.sh paths)");
// CodexBackend places the instance's codex home under AGEND_HOME: the rig's (rig.sh paths: AH), never the host's ~/.agend.
if (!process.env.AGEND_HOME || /\/\.agend\/?$/.test(process.env.AGEND_HOME)) throw new Error("set AGEND_HOME to the rig's AH (rig.sh paths)");
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8" });
const capture = () => tmux("capture-pane", "-p", "-S", "-200", "-t", WIN);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const backend = new CodexBackend(INST);

for (const spec of process.argv.slice(2)) {
  const [m, e] = spec.split(":");
  const model = m || null, effort = e || null;
  const pid = Number(tmux("list-panes", "-t", WIN, "-F", "#{pane_pid}").trim());
  const version = await codexRunningVersion(pid);
  const line = codexModelCommand(model, effort);
  const before = capture();
  if (!codexSupportsInlineModel(version) || !line) {
    // The gate: nothing is typed — the fleet restarts instead (a level outside the canonical set never reaches here: applyEffort clamps).
    await sleep(1500);
    console.log(JSON.stringify({ case: spec, version, typed: false, outcome: "not_sent", reason: line ? "version" : "not one token", paneUnchanged: capture() === before }));
    continue;
  }
  const session = backend.readRawPasteSession(before);
  const file = session ? await checkpointCodexPane(session.sessionsDir, session.sessionId, WORKDIR) : null;
  const answers = codexSwitchAnswerCount(before);
  tmux("send-keys", "-t", WIN, "-l", line); await sleep(300); tmux("send-keys", "-t", WIN, "Enter");
  const fits = (mm: string, ee: string | null) => (model === null || mm === model) && (effort === null || ee === effort);
  let verdict: Record<string, unknown> = { outcome: "not_confirmed" };
  for (const end = Date.now() + 10_000; Date.now() < end; await sleep(200)) {
    if (file) {
      const applied = codexAppliedFromRollout(await readFrom(file.path, file.offset, 4 << 20));
      if (applied) { verdict = { outcome: fits(applied.model, applied.effort) ? "switched" : "mismatch", via: "rollout", applied }; break; }
    }
    const pane = capture();
    if (codexSwitchAnswerCount(pane) > answers) {
      const a = codexSwitchFromPane(pane);
      if (a?.kind === "refused") { verdict = { outcome: "mismatch", via: "pane", refused: a.text }; break; }
      if (a?.kind === "switched" && !file) { verdict = { outcome: fits(a.model, a.effort) ? "switched" : "mismatch", via: "pane", pane: a }; break; }
    }
  }
  console.log(JSON.stringify({ case: spec, version, typed: line, rollout: file ? "checkpointed" : "none yet", ...verdict }));
}
