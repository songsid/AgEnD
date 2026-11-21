/**
 * M-3501 (Claude Code 2.1.330): the connector file-send card's lead row is reworded. 2.1.330 writes
 * "Allowing this sends a copy of 1 file through Anthropic" / "…copies of <N> files…" (with an optional
 * "(… outside this session's folders)") and "to <connector>, a third-party app. Its terms and privacy policy apply."
 * where 2.1.319–2.1.329 wrote "This call sends <N> file(s) from this computer" / "to <connector>, which decides where to
 * store …". That lead row is the only mark an ordinary (not look-alike) file name gives the card (the 2.1.322 audit's
 * Gap A), so without it the card was read as the dangerous-command prompt and answered No.
 *
 * Fixtures: the 2.1.322 plain cards with only those two rows replaced by 2.1.330's wording, taken from the 2.1.330
 * bundle (the function that builds the description). The live card needs a claude.ai connector, which an offline rig
 * cannot reach, as for 2.1.317 and 2.1.322.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBackend, claudeFileSendCardActive, claudeDangerousCommandPromptState } from "../src/backend/claude-code.js";

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}.pane.txt`, import.meta.url), "utf8");
const CARDS = ["claude-2.1.330-file-send-plain", "claude-2.1.330-file-send-plain-two"];
const backend = new ClaudeCodeBackend("/tmp/agend-test-cc2330-nonexistent");
const hit = (dialogs: ReturnType<NonNullable<ClaudeCodeBackend["getRuntimeDialogs"]>>, pane: string) =>
  dialogs.find(d => { d.pattern.lastIndex = 0; return d.isActive ? d.isActive(pane) : d.pattern.test(pane); });
const FILE_SEND_DESCRIPTION = "Claude connector file-send approval — waiting for a human choice, never auto-approving";

describe("2.1.330 file-send card (M-3501)", () => {
  it.each(CARDS)("%s is held for a person: no keys, never the dangerous-command prompt", name => {
    const pane = fx(name);
    expect(pane).toContain("Allowing this sends");
    expect(pane).not.toContain("This call sends");
    expect(claudeDangerousCommandPromptState(pane)).toEqual({ active: true, cursor: "yes" });   // the shape it shares
    expect(claudeFileSendCardActive(pane)).toBe(true);
    const d = hit(backend.getRuntimeDialogs!(), pane)!;
    expect([d.description, d.keys, d.holdOnly]).toEqual([FILE_SEND_DESCRIPTION, [], true]);
    for (const dd of backend.getRuntimeDialogs!().filter(x => x.interactionKind === "dangerous_command")) expect(dd.isActive!(pane)).toBe(false);
  });

  it("the other single-file forms are the card too: a named copy, and files outside the session's folders", () => {
    const base = fx("claude-2.1.330-file-send-plain");
    for (const lead of ['Allowing this sends a copy of "report.pdf" through Anthropic', "Allowing this sends a copy of 1 file (outside this session's folders) through Anthropic"]) {
      expect(claudeFileSendCardActive(base.replace("Allowing this sends a copy of 1 file through Anthropic", lead)), lead).toBe(true);
    }
  });

  it("the lead row counts only as a row of its own: the words quoted inside a tool argument do not make a card", () => {
    const plain = fx("claude-2.1.330-file-send-plain");
    const quoted = plain.replace(" Allowing this sends a copy of 1 file through Anthropic\n", "").replace(' subject: "Weekly report"', ' subject: "Allowing this sends a copy of 1 file"');
    expect(quoted).not.toMatch(/^ Allowing this sends/m);
    expect(claudeFileSendCardActive(quoted)).toBe(false);
  });

  it("2.1.329's wording is still the card (older releases keep working)", () => {
    expect(claudeFileSendCardActive(fx("claude-2.1.322-file-send-plain"))).toBe(true);
    expect(claudeFileSendCardActive(fx("claude-2.1.322-file-send-plain-two"))).toBe(true);
  });
});
