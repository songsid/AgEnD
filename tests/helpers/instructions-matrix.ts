/**
 * the parameter grid of what an agent is told (buildFleetInstructions / buildNativeFleetInstructions), shared by
 * the test and by the script that recorded the golden hashes from the code as it was BEFORE this change
 * (tests/fixtures/instructions-matrix.json, recorded from `release/2.3.5-alpha` at 861ca2ac4).
 */
import type { FleetInstructionsParams } from "../../src/instructions.js";

type Axis<T> = ReadonlyArray<readonly [string, T]>;
const RUNTIME: Axis<FleetInstructionsParams["runtimeIdentity"]> = [
  ["rt-none", undefined], ["rt-topic", { kind: "fleet-topic", backend: "claude-code", model: "opus" }], ["rt-classic", { kind: "classic", backend: "codex", model: "gpt-5" }],
];
const NAME: Axis<string | undefined> = [["dn-none", undefined], ["dn-set", "Ada"]];
const DESC: Axis<string | undefined> = [["desc-none", undefined], ["desc-set", "Reviews pull requests."]];
const PROMPT: Axis<string | undefined> = [["sp-none", undefined], ["sp-set", "Be terse.\nNo emoji."]];
const WORKFLOW: Axis<string | false | undefined> = [["wf-default", undefined], ["wf-off", false], ["wf-custom", "## My workflow\nDo the thing. avoid these AgEnD system emojis: 👀 ⏳ ✅ ❌"]];
const DECISIONS: Axis<FleetInstructionsParams["decisions"]> = [["dec-none", undefined], ["dec-two", [{ title: "B rule", content: "Always rebase. Then push." }, { title: "A rule", content: "Never force-push." }]]];
const CLI: Axis<string | undefined> = [["cli-none", undefined], ["cli-ref", "## CLI\n`agend reply`\n`agend task list`"]];
const BOARD: Axis<boolean | undefined> = [["board-default", undefined], ["board-off", false]];

export interface MatrixCase { key: string; params: FleetInstructionsParams; }
export function matrixCases(): MatrixCase[] {
  const out: MatrixCase[] = [];
  for (const [a, runtimeIdentity] of RUNTIME) for (const [b, displayName] of NAME) for (const [c, description] of DESC)
    for (const [d, customPrompt] of PROMPT) for (const [e, workflow] of WORKFLOW) for (const [f, decisions] of DECISIONS)
      for (const [g, cliInstructions] of CLI) for (const [h, taskBoard] of BOARD)
        out.push({ key: [a, b, c, d, e, f, g, h].join("|"), params: {
          instanceName: "worker", workingDirectory: "/work/project", runtimeIdentity, displayName, description, customPrompt, workflow, decisions, cliInstructions, taskBoard,
        } });
  return out;
}
