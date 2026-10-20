/**
 * Claude Code 2.1.304's cold-cache resume prompt (binary `yrt`; the changelog's "warning before resuming an inactive
 * conversation on Pro and Max"). Two changes from 2.1.295:
 * - the idle trigger labels Escape "Esc to dismiss" (`description: idle ? "dismiss" : "resume"`); the key's action is
 *   unchanged in both versions (`onCancel` → "dismiss": the prompt goes, the conversation stays);
 * - "Start a new conversation" carries its description only when the server offers the look-up (`offersLookUp`).
 * Before this fix the idle shape fell to the hold-only branch (its footer had no "Esc to resume"): delivery blocked
 * until a human answered.
 *
 * The fixtures are NOT live captures (the prompt is server-gated and the mock rig never shows it): a real 2.1.304
 * frame from the audit rig with the dialog's rows written from the binary's strings and component.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBackend, claudeColdResumePromptState } from "../src/backend/claude-code.js";

const pane = (name: string) => readFileSync(new URL(`./fixtures/claude-2.1.304-${name}.pane.txt`, import.meta.url), "utf8");
const backend = new ClaudeCodeBackend("/tmp/agend-claude-cold-resume-304");
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

describe("2.1.304 cold-cache resume prompt", () => {
  it("the idle shape labels Escape 'dismiss' (a draft kept, the arrow hint, the cursor on 'Start a new conversation'): Escape alone", () => {
    const p = pane("cold-resume-idle-dismiss");
    expect(p).toContain("↑/↓ pick a row first · Enter to confirm · Esc to dismiss");
    expect(p).toContain("❯ Start a new conversation");
    expect(claudeColdResumePromptState(p)).toEqual({ titled: true, exact: true });
    escapeOnly(p);
  });
  it("without the look-up offer (no description row) and no draft: still the exact shape, Escape alone", () => {
    const p = pane("cold-resume-idle-nolookup");
    expect(p).not.toContain("Claude can look this one up");
    expect(p).toContain("Enter to confirm · Esc to dismiss");
    expect(claudeColdResumePromptState(p)).toEqual({ titled: true, exact: true });
    escapeOnly(p);
  });
  it("the launch shape keeps 'Esc to resume' (numbers, no description): Escape alone", () => {
    const p = pane("cold-resume-launch");
    expect(p).toContain("Enter to confirm · Esc to resume");
    expect(claudeColdResumePromptState(p)).toEqual({ titled: true, exact: true });
    escapeOnly(p);
  });
  it("the footer must hold exactly one Escape label and 'Enter to confirm'; anything else is held for a human", () => {
    const p = pane("cold-resume-idle-dismiss");
    const footer = "↑/↓ pick a row first · Enter to confirm · Esc to dismiss";
    for (const [why, to] of [
      ["both labels", "Enter to confirm · Esc to dismiss · Esc to resume"],
      ["no Escape label", "↑/↓ pick a row first · Enter to confirm"],
      ["another Escape label", "Enter to confirm · Esc to cancel"],
      ["no Enter", "↑/↓ pick a row first · Esc to dismiss"],
      ["a repeated part", "Enter to confirm · Enter to confirm · Esc to dismiss"],
    ] as const) {
      const v = p.replace(footer, to);
      expect(v, why).not.toBe(p);
      expect(claudeColdResumePromptState(v), why).toEqual({ titled: true, exact: false });
      for (const [name, table] of tables()) expect(acting(table, v).map(d => [d.keys, d.holdOnly]), `${why} ${name}`).toEqual([[[], true]]);
    }
  });
});
