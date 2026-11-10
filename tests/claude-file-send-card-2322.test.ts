/**
 * 2.1.322 audit (Gap A): from 2.1.319 on, the connector file-send card draws an ordinary file name as a plain
 * `"<path>" (<size>)` row — only a look-alike name gets the `* ` mark (Claude's own parser: `/^(?:\* )?"/`) — and 2.1.322
 * reworded the look-alike warning to "Name may use look-alike characters.". A card for an ordinary name then carried
 * none of AgEnD's file-send marks, and was read as the dangerous-command prompt: Down, Enter — the send declined and the
 * agent told the command was dangerous, instead of the card held for a person (M-2296). The card's own lead row, "This
 * call sends <N> file(s) from this computer", is now a mark.
 *
 * Fixtures: the 2.1.317 card chrome with the 2.1.319/2.1.322 bundle's description (G_i / mui and N: the lead rows, the
 * name rows, the warning) — the live card needs a claude.ai email connector, which an offline rig cannot reach — and the
 * live 2.1.322 dangerous-rm card from the audit rig, as the negative control.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBackend, claudeFileSendCardActive, claudeDangerousCommandPromptState } from "../src/backend/claude-code.js";

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}.pane.txt`, import.meta.url), "utf8");
const CARDS = ["claude-2.1.322-file-send-plain", "claude-2.1.322-file-send-plain-two", "claude-2.1.322-file-send-lookalike"];
const DANGER = fx("claude-2.1.322-bypass-dangerous-rm-prompt");
const backend = new ClaudeCodeBackend("/tmp/agend-test-cc2322-nonexistent");
const hit = (dialogs: ReturnType<NonNullable<ClaudeCodeBackend["getRuntimeDialogs"]>>, pane: string) =>
  dialogs.find(d => { d.pattern.lastIndex = 0; return d.isActive ? d.isActive(pane) : d.pattern.test(pane); });
const FILE_SEND_DESCRIPTION = "Claude connector file-send approval — waiting for a human choice, never auto-approving";

describe("2.1.322 file-send card (Gap A)", () => {
  it.each(CARDS)("%s is held for a person: no keys, never the dangerous-command prompt", name => {
    const pane = fx(name);
    expect(claudeDangerousCommandPromptState(pane)).toEqual({ active: true, cursor: "yes" });   // the shape it shares
    expect(claudeFileSendCardActive(pane)).toBe(true);
    for (const dialogs of [backend.getRuntimeDialogs!(), backend.getStartupDialogs!()]) {
      const d = hit(dialogs, pane);
      if (!d) continue;                                     // the startup table need not list it; it must not answer it
      expect(d.description).toBe(FILE_SEND_DESCRIPTION);
      expect(d.keys).toEqual([]);
      expect(d.holdOnly).toBe(true);
    }
    for (const d of backend.getRuntimeDialogs!().filter(d => d.interactionKind === "dangerous_command")) expect(d.isActive!(pane)).toBe(false);
  });

  it("the plain card carries none of the 2.1.317 marks: the lead row is what makes it the card", () => {
    const pane = fx("claude-2.1.322-file-send-plain");
    expect(pane).not.toMatch(/^[ \t]*\* /m);
    expect(claudeFileSendCardActive(pane.replace("This call sends 1 file from this computer", "This call writes 1 file on this computer"))).toBe(false);
  });

  it("the look-alike card is held by its warning row alone too (2.1.322 wording)", () => {
    const pane = fx("claude-2.1.322-file-send-lookalike")
      .replace(' * "/scratch/cwd/rep\\u043ert.pdf" (12 KB).', ' (a row not shown)').replace("This call sends 1 file", "This call takes 1 file");
    expect(claudeFileSendCardActive(pane)).toBe(true);
    expect(claudeFileSendCardActive(pane.replace("Name may use look-alike characters.", "Name is fine."))).toBe(false);
  });

  it("the lead row counts only as a row of its own: the words inside a tool's arguments on an ordinary MCP card do not", () => {
    const mcp = fx("claude-2.1.317-mcp-permission");
    const quoted = mcp.replace(' to: "someone@example.com"', ' subject: "This call sends 1 file from this computer"');
    expect(quoted).not.toBe(mcp);
    expect(claudeFileSendCardActive(quoted)).toBe(false);
  });

  it("negative control: the live 2.1.322 dangerous-command card is still declined (Down, Enter), never held as a file send", () => {
    expect(claudeFileSendCardActive(DANGER)).toBe(false);
    const d = hit(backend.getRuntimeDialogs!(), DANGER)!;
    expect(d.interactionKind).toBe("dangerous_command");
    expect(d.keys).toEqual(["Down", "Enter"]);
  });

  it("negative control: the lead row quoted in the transcript above a dangerous-command card does not make it a file send", () => {
    const quoted = DANGER.replace("❯ DANGER go", "❯ DANGER go\n  This call sends 1 file from this computer");
    expect(claudeFileSendCardActive(quoted)).toBe(false);
    expect(hit(backend.getRuntimeDialogs!(), quoted)!.keys).toEqual(["Down", "Enter"]);
  });
});
