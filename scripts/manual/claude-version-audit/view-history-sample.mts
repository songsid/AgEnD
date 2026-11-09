// Claude history in the View: what the View samples from a new Claude version's screen, against the defaults (2.1.318's).
// Usage: tmux -L <socket> capture-pane -p -e -t <pane> > cap.ansi   (after a turn with a prompt, a reply, an edit and a
// tool result on screen), then: npx tsx scripts/manual/claude-version-audit/view-history-sample.mts cap.ansi
// "sampled, differs": the View now draws that value from the version's own screen. "NOT FOUND": the screen gave none —
// either it had none on it, or the version draws it in a way the sampler no longer recognises: look at the screen.
import { readFileSync } from "node:fs";
import { DEFAULT_PALETTE, sampleScreen } from "../../../src/ui/shared/view-history.js";

const { palette, found } = sampleScreen(readFileSync(process.argv[2]!, "utf8")) as { palette: Record<string, string>; found: string[] };
const defaults = DEFAULT_PALETTE as Record<string, string>;
// Never on a settled screen: a failed or running tool's bullet, an error's colour (the defaults stand for them).
const rare = new Set(["failedFg", "runningFg", "errorFg"]);
for (const k of Object.keys(defaults)) {
  const state = found.includes(k) ? (palette[k] === defaults[k] ? "sampled, same" : "sampled, differs") : rare.has(k) ? "default (rare)" : "NOT FOUND";
  console.log(`${k.padEnd(12)} ${String(palette[k]).padEnd(18)} default ${String(defaults[k]).padEnd(18)} ${state}`);
}
