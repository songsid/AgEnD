/**
 * M-3757: Claude Code 2.1.332's usage-credits prompt before a turn on a credits-billed model (Fable on Pro/Team plans,
 * server flag tengu_saffron_lattice). Live captures from the real 2.1.332 binary on the audit rig (a private tmux
 * server in a loopback-only namespace, a claude.ai-shaped home with FAKE tokens on a Pro plan, the flag served by the
 * rig's proxy, the Messages mock, `--model claude-fable-5-2`). Before this card AgEnD read the pane as ready: the
 * focus starts on "Switch to Opus 5.5 and continue", so a delivery's Enter switched the agent's model, and Esc does the
 * same (consent-escaped). Left alone, the prompt stays (4 minutes, unchanged). Now it is held for a person, who picks on
 * a Needs-you card. The 3-option, Fable-limit and /model-picker
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
    expect(card).toMatchObject({ kind: "question", title: "Claude Code", page: "options", cursor: 0, freeText: false, noSkip: true, webOnly: true, humanOnly: true });
    expect(card.question).toBe("Fable 5.2 now uses usage credits\nFable 5.2 runs on usage credits, purchased separately from your plan.");
    expect(card.options.map(o => o.title)).toEqual(["Switch to Opus 5.5 and continue", "Continue with Fable 5.2"]);
    expect(card.options.map(o => o.hint)).toEqual(["Uses your plan", "Billed to usage credits, separate from your plan"]);
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
    ["Fable 5.2 now runs on usage credits", ["Switch to Opus 5.5 and continue", "Turn on usage credits and continue"]],
    ["Fable 5.2 now uses usage credits", ["Not now", "Request usage credits from your admin"]],
    ["You've reached your Fable limit", ["Switch to Opus 5.5 and continue", "Continue with usage credits", "Upgrade to Max or Ultra"]],
    ["Switch to Fable 5.2?", ["No, keep my current model", "Yes, buy usage credits"]],
  ] as const)("%s → held; each option offered", (title, options) => {
    const p = shape(title, [...options]);
    expect(acting(p).map(d => d.holdOnly)).toEqual([true]);
    const card = claudeUsageCreditsPrompt(p)!.card;
    expect(card.options.map(o => o.title)).toEqual(options);
    expect(card.options.every(o => typeof o.hint === "string" || o.title.startsWith("Upgrade"))).toBe(true);
  });

  it("the dashboard's buttons carry each subtitle (remoteCardPrompt)", async () => {
    const { remoteCardPrompt } = await import("../src/remote-card-prompt.js");
    const p = remoteCardPrompt("x", claudeUsageCreditsPrompt(LIVE)!.card);
    expect(p.choices.map(c => c.hint)).toEqual(["Uses your plan", "Billed to usage credits, separate from your plan"]);
  });
});

describe("the compact card (M-3757 redesign): one-line title, options by what they do, Claude's words folded", () => {
  it("the card carries the models and each option's role, read from Claude's words", async () => {
    const card = claudeUsageCreditsPrompt(LIVE)!.card;
    expect(card.usageCreditsPrompt).toEqual({ model: "Fable 5.2", target: "Opus 5.5", picker: false });
    expect(card.options.map(o => o.role)).toEqual(["switch", "credits"]);
    const { remoteCardPrompt } = await import("../src/remote-card-prompt.js");
    const view = remoteCardPrompt("x", card, "Lumen").view!;
    expect(view).toMatchObject({ kind: "usage-credits", agent: "Lumen", model: "Fable 5.2", target: "Opus 5.5", picker: false });
    expect(view.raw).toBe("Fable 5.2 now uses usage credits\nFable 5.2 runs on usage credits, purchased separately from your plan.\nSwitch to Opus 5.5 and continue\nContinue with Fable 5.2");
    expect(view.raw).not.toMatch(/❓/);
    expect(remoteCardPrompt("x", card, "Lumen").choices.map(c => c.role)).toEqual(["switch", "credits"]);
  });

  it.each([
    ["Not now", "Request usage credits from your admin", ["not-now", "admin"], null],
    ["Switch to Opus 5.5 and continue", "Continue with usage credits", ["switch", "credits"], "Opus 5.5"],
  ] as const)("roles come from the words, not the position (%s / %s)", (a, b, roles, target) => {
    const card = claudeUsageCreditsPrompt(shape("Fable 5.2 now uses usage credits", [a, b]))!.card;
    expect(card.options.map(o => o.role)).toEqual(roles);
    expect(card.usageCreditsPrompt!.target).toBe(target);
  });

  it.each([
    ["en", "Lumen: Fable 5.2 now costs extra. Switch model?", ["Switch to Opus 5.5 (uses your plan)", "Keep Fable 5.2 (billed to credits)"], "Keep Lumen on Fable 5.2?", "Continue on credits", "Show Claude's text"],
    ["zh-TW", "Lumen：Fable 5.2 要另外收費，要換模型嗎？", ["換成 Opus 5.5（用方案額度）", "繼續用 Fable 5.2（另外扣點數）"], "讓 Lumen 繼續用 Fable 5.2？", "繼續（用點數）", "看 Claude 原文"],
  ] as const)("%s: the page names the card and its choices in the UI's language", async (lang, title, labels, confirmTitle, confirmLabel, raw) => {
    const i18n = await import("/assets/app-i18n.js");
    const ui = await import("/ui/js/usage-credits-card.js");
    i18n.setLang(lang);
    try {
      const { remoteCardPrompt } = await import("../src/remote-card-prompt.js");
      const prompt = remoteCardPrompt("x", claudeUsageCreditsPrompt(LIVE)!.card, "Lumen");
      const actions = prompt.choices.map(c => ({ id: c.action, label: c.label, role: c.role }));
      expect(ui.usageCreditsTitle(prompt.view)).toBe(title);
      const shown = ui.usageCreditsActions(prompt.view, actions);
      expect(shown.map((a: any) => a.label)).toEqual(labels);
      expect(shown.map((a: any) => a.id)).toEqual(["opt-1", "opt-2"]);                 // the server's ids, unchanged
      expect(shown.map((a: any) => a.primary)).toEqual([true, false]);
      expect(shown[0].confirmation).toBeUndefined();
      expect(shown[1].confirmation).toMatchObject({ title: confirmTitle, confirmLabel });
      expect(ui.showRawLabel()).toBe(raw);
    } finally { i18n.setLang("en"); }
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
