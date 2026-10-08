/**
 * Claude Code 2.1.295's cold-cache resume prompt, "Resume this conversation?" (binary: `O4e`, `dZ`, the idle watcher
 * `W$`). It opens on a resumed launch and, by a timer, while an instance sits idle once its prompt cache has gone cold
 * — gated by server flags, a subscription tier and its cost against the 5-hour limit. While it is up, a paste goes to
 * the composer's draft and Enter is refused; "Start a new conversation" runs /clear.
 *
 * AgEnD answers it like the old resume menu, keeping the context: Escape — the dialog's own "resume", no cursor
 * needed — only on the exact shape; anything else carrying the title is held for a human.
 *
 * The fixtures are NOT live captures: the prompt is server-gated and did not appear in the mock rig. They are a real
 * 2.1.295 frame with the dialog's rows written from the binary's strings and component (title, body, options,
 * description, input guide; the idle trigger hides the option numbers and adds the draft line).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBackend, claudeColdResumePromptState } from "../src/backend/claude-code.js";

const pane = (name: string) => readFileSync(new URL(`./fixtures/claude-2.1.295-${name}.pane.txt`, import.meta.url), "utf8");
const old = (name: string) => readFileSync(new URL(`./fixtures/${name}.pane.txt`, import.meta.url), "utf8");
const backend = new ClaudeCodeBackend("/tmp/agend-claude-cold-resume");
type Entry = { pattern: RegExp; isActive?: (p: string) => boolean; keys?: string[]; holdOnly?: boolean; blocksDelivery?: boolean; verifyAfterKeys?: boolean; description: string };
const acting = (table: Entry[], p: string) => table.filter(d => (d.isActive ? d.isActive(p) : d.pattern.test(p)));
const tables = () => [["startup", backend.getStartupDialogs() as Entry[]], ["runtime", backend.getRuntimeDialogs() as Entry[]]] as const;

describe("2.1.295 cold-cache resume prompt", () => {
  it("the launch shape is answered with Escape alone — never Enter, never an arrow — and verified", () => {
    const p = pane("cold-resume-launch");
    expect(claudeColdResumePromptState(p)).toEqual({ titled: true, exact: true });
    for (const [name, table] of tables()) {
      const hits = acting(table, p);
      expect(hits.map(d => d.keys), name).toEqual([["Escape"]]);
      expect(hits[0]).toMatchObject({ blocksDelivery: true, verifyAfterKeys: true });
      expect(hits[0]!.description).toContain("keep the full context");
    }
  });

  it("the idle shape (a draft kept, no option numbers, the cursor on 'Start a new conversation') is still only Escape", () => {
    const p = pane("cold-resume-idle-draft");
    expect(p).toContain("❯ Start a new conversation");
    expect(p).toContain("Your unsent message will still be there after you answer.");
    const hits = acting(backend.getRuntimeDialogs() as Entry[], p);
    expect(hits.map(d => d.keys)).toEqual([["Escape"]]);
  });

  it("any other shape with the title is held for a human, in both tables", () => {
    const p = pane("cold-resume-variant");
    expect(claudeColdResumePromptState(p)).toEqual({ titled: true, exact: false });
    for (const [name, table] of tables()) {
      expect(acting(table, p).map(d => [d.keys, d.holdOnly, d.blocksDelivery]), name).toEqual([[[], true, true]]);
    }
  });

  it("the shape checks hold: the sentence, both options in order, nothing but description and footer below", () => {
    const launch = pane("cold-resume-launch");
    const mutate = (from: string, to: string) => { expect(launch).toContain(from); return launch.replace(from, to); };
    expect(claudeColdResumePromptState(mutate("tokens long.", "tokens.")).exact).toBe(false);
    expect(claudeColdResumePromptState(mutate("    2. Start a new conversation", "    2. Start fresh")).exact).toBe(false);
    expect(claudeColdResumePromptState(mutate("  ❯ 1. Resume", "  ❯ 1. Resume (recommended)")).exact).toBe(false);
    // something between the two options
    expect(claudeColdResumePromptState(mutate("  ❯ 1. Resume\n", "  ❯ 1. Resume\n       an unknown row\n")).exact).toBe(false);
    // the options swapped: "Start a new conversation" first
    expect(claudeColdResumePromptState(launch.replace("  ❯ 1. Resume\n    2. Start a new conversation", "  ❯ 1. Start a new conversation\n    2. Resume")).exact).toBe(false);
    expect(claudeColdResumePromptState(mutate("  Enter to confirm · Esc to resume", "  Enter to confirm · Esc to resume\n❯ ")).exact).toBe(false);
  });

  it("the title quoted in a transcript above the live composer is not the dialog", () => {
    const ready = pane("cold-resume-launch").replace(/─{160}\n[\s\S]*$/, "  Resume this conversation?\n  quoted by a reply\n" + "─".repeat(160) + "\n❯ \n" + "─".repeat(160) + "\n");
    expect(claudeColdResumePromptState(ready).exact).toBe(false);
    for (const [, table] of tables()) expect(acting(table, ready).filter(d => d.description.includes("cold-cache"))).toEqual([]);
  });

  it("the old resume menu and ordinary panes are untouched", () => {
    expect(claudeColdResumePromptState(old("claude-2.1.287-resume3")).titled).toBe(false);
    for (const name of ["claude-2.1.294-ready-statusline", "claude-2.1.294-busy-statusline", "claude-2.1.294-mcp-approval"]) {
      expect(claudeColdResumePromptState(old(name)).titled, name).toBe(false);
    }
  });
});
