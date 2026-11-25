/**
 * M-3757: Claude Code 2.1.332's usage-credits prompt before a turn on a credits-billed model (Fable on Pro/Team plans,
 * server flag tengu_saffron_lattice). Live captures from the real 2.1.332 binary on the audit rig (a private tmux
 * server in a loopback-only namespace, a claude.ai-shaped home with FAKE tokens on a Pro plan, the flag served by the
 * rig's proxy, the Messages mock, `--model claude-fable-5-2`). Before this card AgEnD read the pane as ready: the
 * focus starts on "Switch to Opus 5.5 and continue", so a delivery's Enter switched the agent's model, and Esc does the
 * same (consent-escaped). Left alone, the prompt stays (4 minutes, unchanged). Now it is held for a person, who picks on
 * a Needs-you card; a choice that may spend credits asks to be confirmed. The 3-option, Fable-limit and /model-picker
 * shapes are not reachable on the rig (the plan's credit state comes from claude.ai): their rows are built from the
 * live capture with the 2.1.332 renderer's own words.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { claudeUsageCreditsPrompt } from "../src/backend/claude-usage-credits.js";

const pane = (name: string) => readFileSync(new URL(`./fixtures/claude-2.1.332-usage-credits-${name}.pane.txt`, import.meta.url), "utf8");
const backend = new ClaudeCodeBackend("/tmp/agend-claude-usage-credits-fixture");
const acting = (p: string) => backend.getRuntimeDialogs().filter(d => (d.isActive ? d.isActive(p) : d.pattern.test(p)));
const LIVE = pane("consent-dialog");
/** The live prompt with its title and option rows replaced (the renderer's other shapes). */
const shape = (title: string, options: string[], cursor = 0) => {
  const rows = LIVE.split("\n");
  const t = rows.findIndex(r => r === "  Fable 5.2 now uses usage credits");
  const first = rows.findIndex(r => r === "  ❯ Switch to Opus 5.5 and continue");
  const footer = rows.findIndex(r => r === "  Enter to confirm · Esc to cancel");
  if (t < 0 || first < 0 || footer !== first + 3) throw new Error("the live fixture changed");
  rows[t] = `  ${title}`;
  rows.splice(first, 2, ...options.map((o, i) => `  ${i === cursor ? "❯" : " "} ${o}`));
  return rows.join("\n");
};

describe("the live 2.1.332 prompt", () => {
  it("is held for a person: no keys, every delivery and input blocked, and never auto-answered", () => {
    expect(LIVE).toContain("Claude Code v2.1.332");
    const hits = acting(LIVE);
    expect(hits.map(d => d.description)).toEqual([expect.stringContaining("usage-credits prompt")]);
    expect(hits[0]).toMatchObject({ keys: [], holdOnly: true, blocksDelivery: true, inputBlocked: true, humanOnly: true });
    expect(hits[0]!.requestIdentity!(LIVE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("its Needs-you card offers the dialog's own choices, cursor on the switch, Esc not offered", () => {
    const card = claudeUsageCreditsPrompt(LIVE)!.card;
    expect(card).toMatchObject({ kind: "question", title: "Claude Code", page: "options", cursor: 0, freeText: false, noSkip: true, humanOnly: true });
    expect(card.question).toBe("Fable 5.2 now uses usage credits\nFable 5.2 runs on usage credits, purchased separately from your plan.");
    expect(card.options.map(o => o.title)).toEqual(["Switch to Opus 5.5 and continue", "Continue with Fable 5.2"]);
    // Switching changes nothing that costs money; continuing on Fable may spend credits: confirmed first.
    expect(card.options[0]!.confirmation).toBeUndefined();
    expect(card.options[1]!.confirmation).toMatchObject({ confirmLabel: "Continue with Fable 5.2" });
    expect(acting(LIVE)[0]!.remoteCard!(LIVE)).toEqual(card);
  });

  it("with the cursor moved to the credits row it is the same prompt (same card), cursor 1", () => {
    const moved = pane("consent-cursor-credits");
    const a = claudeUsageCreditsPrompt(moved)!, b = claudeUsageCreditsPrompt(LIVE)!;
    expect(a.cursor).toBe(1);
    expect(a.card.identity).toBe(b.card.identity);
    expect(acting(moved).map(d => d.holdOnly)).toEqual([true]);
  });

  it("gone after an answer: Esc switched the model (why Esc is never offered); the credits choice kept Fable", () => {
    const escaped = pane("consent-escaped"), answered = pane("consent-answered-credits");
    expect(escaped).toContain("Switched to Opus 5.5 for this session · Fable 5.2 requires usage credits");
    expect(answered).not.toContain("Switched to");
    for (const p of [escaped, answered]) {
      expect(claudeUsageCreditsPrompt(p)).toBeNull();
      expect(acting(p)).toEqual([]);
      expect(backend.getReadyPattern().test(p)).toBe(true);
    }
  });
});

describe("the renderer's other shapes (2.1.332's own words)", () => {
  it.each([
    ["Fable 5.2 now runs on usage credits", ["Switch to Opus 5.5 and continue", "Turn on usage credits and continue"], [false, true]],
    ["Fable 5.2 now uses usage credits", ["Not now", "Request usage credits from your admin"], [false, true]],
    ["You've reached your Fable limit", ["Switch to Opus 5.5 and continue", "Continue with usage credits", "Upgrade to Max or Ultra"], [false, true, false]],
    ["Switch to Fable 5.2?", ["No, keep my current model", "Yes, buy usage credits"], [false, true]],
  ] as const)("%s → held; each option offered, the credits one confirmed", (title, options, confirmed) => {
    const p = shape(title, [...options]);
    expect(acting(p).map(d => d.holdOnly)).toEqual([true]);
    const card = claudeUsageCreditsPrompt(p)!.card;
    expect(card.options.map(o => o.title)).toEqual(options);
    expect(card.options.map(o => o.confirmation !== undefined)).toEqual(confirmed);
  });
});

describe("only the live prompt is one", () => {
  it("a transcript or a composer quoting its words is not a dialog", () => {
    const quoted = `${LIVE.replace("  Enter to confirm · Esc to cancel", "")}\n● The prompt said: Enter to confirm · Esc to cancel\n────\n❯ \n────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n`;
    expect(claudeUsageCreditsPrompt(quoted)).toBeNull();
    const typed = pane("consent-answered-credits").replace("❯ second try", "❯ Fable 5.2 now uses usage credits · Switch to Opus 5.5 and continue");
    expect(claudeUsageCreditsPrompt(typed)).toBeNull();
    expect(acting(typed)).toEqual([]);
  });

  it("another dialog with the same footer (the trust screen) is not it", () => {
    const trust = shape("Accessing workspace:", ["No, exit", "Yes, I trust this folder"]);
    expect(claudeUsageCreditsPrompt(trust)).toBeNull();
  });

  it("a first option that keeps no model off credits, or a fourth option, is not this prompt", () => {
    expect(claudeUsageCreditsPrompt(shape("Fable 5.2 now uses usage credits", ["Continue with Fable 5.2", "Switch to Opus 5.5 and continue"]))).toBeNull();
    expect(claudeUsageCreditsPrompt(shape("Fable 5.2 now uses usage credits", ["Not now", "a", "b", "c"]))).toBeNull();
  });
});
