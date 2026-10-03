/**
 * Claude Code 2.1.288 extends the `rm` safety check to `bash -c` / `sh -c`
 * scripts (changelog: "a dangerous rm ... inside a bash -c or sh -c script
 * running without a prompt in bypassPermissions mode"). AgEnD runs every
 * Claude instance with --dangerously-skip-permissions, so a command that ran
 * silently on 2.1.287 now stops on this prompt — and the instance waits on it.
 *
 * The fixture is the real pane (2.1.288, bypass mode, a local Anthropic mock
 * that answers with the Bash tool call below). The existing tests for this
 * prompt use a synthetic warning row; two things in the real one are new to
 * them: the wording, and the auto-deny countdown row sitting between the
 * warning and the question.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBackend, claudeDangerousCommandPromptState } from "../src/backend/claude-code.js";

const PANE = readFileSync(new URL("./fixtures/claude-2.1.288-bypass-bash-c-dangerous-rm-prompt.pane.txt", import.meta.url), "utf8");
const backend = new ClaudeCodeBackend("/tmp/agend-claude-2.1.288-fixture");
const matches = (dialog: { pattern: RegExp; isActive?: (pane: string) => boolean }, pane: string) =>
  dialog.isActive ? dialog.isActive(pane) : dialog.pattern.test(pane);

describe("2.1.288 bash -c dangerous-rm prompt (real pane)", () => {
  it("is the captured shape: a bash -c script, warning, auto-deny countdown, then the Yes/No question", () => {
    expect(PANE).toContain("Claude Code v2.1.288");
    expect(PANE).toContain(`bash -c 'rm -rf "$(echo /tmp/agend-safe-probe)"/*'`);
    expect(PANE).toContain("Dangerous rm operation on statically-unresolvable target: command substitution output");
    expect(PANE).toMatch(/Claude Code will automatically deny this request in \d+:\d\d, to avoid blocking progress on an unattended session/);
  });

  it("is recognised as the dangerous-command prompt with the cursor on Yes", () => {
    expect(claudeDangerousCommandPromptState(PANE)).toEqual({ active: true, cursor: "yes" });
  });

  it("is answered by declining: Down then Enter, and by no other runtime dialog", () => {
    const hits = backend.getRuntimeDialogs().filter(dialog => matches(dialog, PANE));
    expect(hits.map(dialog => ({ keys: dialog.keys, holdOnly: !!dialog.holdOnly }))).toEqual([{ keys: ["Down", "Enter"], holdOnly: false }]);
  });

  it("stops being the prompt once the answer is given (the same pane without the menu)", () => {
    const answered = PANE.slice(0, PANE.indexOf(" Do you want to proceed?"));
    expect(claudeDangerousCommandPromptState(answered).active).toBe(false);
  });
});
