/**
 * Claude Code's cold-cache resume prompt, LIVE-captured for the first time (2.1.319 audit, 2026-11-07): real 2.1.318 and
 * 2.1.319 binaries, the production writeConfig + buildCommand with --continue on a backdated 180k-token session, the
 * server flags served offline (scripts/manual/claude-version-audit/cold-resume-live.mts).
 *
 * Two findings the binary-derived 2.1.295/2.1.304 fixtures missed:
 * - an option's description is painted BESIDE its label (after two or more spaces), wrapping inside that column —
 *   never on a row of its own; with the server's look-up offered, the old predicate held the prompt for a person;
 * - 2.1.319 adds "Resume from summary" (flag `tengu_eager_brooks`, launch trigger only) as a third option.
 * Escape is still the answer: the dialog's `onCancel` → "dismiss" keeps the whole conversation (live: same session, no
 * compaction, history on screen — the `escaped` fixture).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBackend, claudeColdResumePromptState } from "../src/backend/claude-code.js";

const pane = (name: string) => readFileSync(new URL(`./fixtures/claude-${name}.pane.txt`, import.meta.url), "utf8");
const backend = new ClaudeCodeBackend("/tmp/agend-claude-cold-resume-319");
type Entry = { pattern: RegExp; isActive?: (p: string) => boolean; keys?: string[]; holdOnly?: boolean; blocksDelivery?: boolean; verifyAfterKeys?: boolean; description: string };
const acting = (table: Entry[], p: string) => table.filter(d => (d.isActive ? d.isActive(p) : d.pattern.test(p)));
const tables = () => [["startup", backend.getStartupDialogs() as Entry[]], ["runtime", backend.getRuntimeDialogs() as Entry[]]] as const;
const escapeOnly = (p: string) => {
  for (const [name, table] of tables()) {
    const hits = acting(table, p);
    expect(hits.map(d => d.keys), name).toEqual([["Escape"]]);
    expect(hits[0], name).toMatchObject({ blocksDelivery: true, verifyAfterKeys: true });
  }
};
const heldOnly = (p: string) => {
  expect(claudeColdResumePromptState(p)).toEqual({ titled: true, exact: false });
  for (const [name, table] of tables()) {
    const hits = acting(table, p);
    expect(hits.map(d => d.keys), name).toEqual([[]]);
    expect(hits[0]!.holdOnly, name).toBe(true);
  }
};

const LOOKUP = "Claude can look this one up if you refer to it later";
const SUMMARY = "Claude writes a summary now, and you continue from it";
const LIVE: [name: string, defining: RegExp][] = [
  ["2.1.319-cold-resume-live-lookup", new RegExp(`^ +2\\. Start a new conversation {2,}${LOOKUP}$`, "m")],
  ["2.1.319-cold-resume-live-nolookup", /^ +2\. Start a new conversation$/m],
  ["2.1.319-cold-resume-live-summary-lookup", new RegExp(`^ +3\\. Resume from summary {2,}${SUMMARY}$`, "m")],
  ["2.1.319-cold-resume-live-summary-nolookup", new RegExp(`^ +2\\. Start a new conversation\\n +3\\. Resume from summary {2,}${SUMMARY}$`, "m")],
  ["2.1.319-cold-resume-live-summary-lookup-80", /^ +2\. Start a new conversation {2,}Claude can look this one up if you refer to\n {20,}it later$/m],
  ["2.1.319-cold-resume-live-summary-newfocus", /^ +❯ 2\. Start a new conversation {2,}/m],
  ["2.1.318-cold-resume-live-lookup", new RegExp(`^ +2\\. Start a new conversation {2,}${LOOKUP}$`, "m")],
];

describe("the live cold-resume prompt (2.1.318, 2.1.319)", () => {
  for (const [name, defining] of LIVE) {
    it(`${name}: exact, answered with Escape only`, () => {
      const p = pane(name);
      expect(p).toMatch(/^ +Resume this conversation\?$/m);
      expect(p).toMatch(defining);
      expect(claudeColdResumePromptState(p)).toEqual({ titled: true, exact: true });
      escapeOnly(p);
    });
  }

  it("after the Escape: the conversation is back, no cold-resume entry acts", () => {
    const p = pane("2.1.319-cold-resume-live-escaped");
    expect(p).toContain("BIG hello");
    expect(claudeColdResumePromptState(p)).toEqual({ titled: false, exact: false });
    for (const [, table] of tables()) expect(acting(table, p).filter(d => /cold-cache resume/.test(d.description))).toEqual([]);
  });
});

describe("anything else carrying the title is held, never answered", () => {
  const base = pane("2.1.319-cold-resume-live-summary-lookup");
  const summaryRow = new RegExp(`^( +3\\. Resume from summary {2,})${SUMMARY}$`, "m");
  const footer = /^( +)Enter to confirm · Esc to resume$/m;
  const cases: [string, (p: string) => string][] = [
    ["a fourth, unknown option", p => p.replace(footer, "    4. Resume and compact later\n$1Enter to confirm · Esc to resume")],
    ["the summary's description changed", p => p.replace(summaryRow, "$1Claude writes a summary and starts over")],
    ["the summary without its description", p => p.replace(summaryRow, "    3. Resume from summary")],
    ["a description on Resume", p => p.replace(/^( +❯ 1\. Resume)$/m, "$1  Keeps everything")],
    ["the options out of order", p => p.replace(/^( +)2\. Start a new conversation( {2,}.*)\n( +)3\. Resume from summary( {2,}.*)$/m, "$12. Resume from summary$4\n$33. Start a new conversation$2")],
    ["numbers that skip", p => p.replace(/^( +)3\. Resume from summary/m, "$14. Resume from summary")],
    ["numbers out of order", p => p.replace(/^( +)2\. Start a new conversation/m, "$13. Start a new conversation").replace(/^( +)3\. Resume from summary/m, "$12. Resume from summary")],
    ["the third option is not the summary", p => p.replace(/^( +)3\. Resume from summary/m, "$13. Start a new conversation")],
    ["a footer the grammar does not name", p => p.replace(footer, "$1Enter to confirm · Esc to start over")],
    ["a stray row after the footer", p => p.replace(footer, "$1Enter to confirm · Esc to resume\n  something else")],
    ["the look-up text changed", p => p.replace(LOOKUP, "Claude forgets this one")],
    ["a wrapped row that is not the description's", p => p.replace(new RegExp(`^( +3\\. Resume from summary {2,}${SUMMARY})$`, "m"), "$1\n                                 and then some")],
  ];
  for (const [what, mutate] of cases) {
    it(what, () => {
      const p = mutate(base);
      expect(p, "the mutation applied").not.toBe(base);
      heldOnly(p);
    });
  }
});
