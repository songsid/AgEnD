/**
 * M-2296 (Claude Code 2.1.317): the connector file-send safety card is held for a person — never auto-answered,
 * never given a delivery's keys — and no other screen is taken for it. Fixtures: the real 2.1.317 MCP permission card
 * (captured in an isolated rig, scripts/manual/claude-2317-file-send) and file-send variants derived from it and the
 * 2.1.317 bundle (the live trigger needs a claude.ai email connector, which an offline rig cannot reach).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeBackend, claudeFileSendCardActive, claudeDangerousCommandPromptState } from "../src/backend/claude-code.js";
import { selectionCard } from "../src/selection-card.js";

const dir = join(__dirname, "fixtures");
const fx = (name: string) => readFileSync(join(dir, `${name}.pane.txt`), "utf8");
const FILE_SEND = ["claude-2.1.317-file-send-card", "claude-2.1.317-file-send-default-no", "claude-2.1.317-file-send-unlisted", "claude-2.1.317-file-send-too-short"];
const backend = new ClaudeCodeBackend("/tmp/agend-test-cc2317-nonexistent");
const first = (pane: string) => backend.getRuntimeDialogs!().find(d => { d.pattern.lastIndex = 0; return d.isActive ? d.isActive(pane) : d.pattern.test(pane); });
const FILE_SEND_DESCRIPTION = "Claude connector file-send approval — waiting for a human choice, never auto-approving";

describe("M-2296 Claude 2.1.317 connector file-send card", () => {
  it.each(FILE_SEND)("%s is the file-send card, held for a person with no keys", name => {
    const pane = fx(name);
    expect(claudeFileSendCardActive(pane)).toBe(true);
    const dialog = first(pane)!;
    expect(dialog.description).toBe(FILE_SEND_DESCRIPTION);
    expect(dialog.keys).toEqual([]);
    expect([dialog.holdOnly, dialog.blocksDelivery, dialog.inputBlocked]).toEqual([true, true, true]);
    expect(dialog.interactionKind).toBe("permission");
  });

  it("a two-option card is never auto-answered as a dangerous command (main selected No and told the agent it was dangerous)", () => {
    const pane = fx("claude-2.1.317-file-send-card");
    expect(claudeDangerousCommandPromptState(pane)).toEqual({ active: true, cursor: "yes" });   // the shape it shares
    const dangerous = backend.getRuntimeDialogs!().filter(d => d.interactionKind === "dangerous_command");
    expect(dangerous.length).toBeGreaterThan(0);
    for (const d of dangerous) expect(d.isActive!(pane)).toBe(false);
  });

  it("it is a Needs-you wait (a blocked-input permission), with no remote Yes: #2968 reads no non-shell Claude card", () => {
    const pane = fx("claude-2.1.317-file-send-card");
    const dialog = first(pane)!;
    // needs-you.ts lists an awaiting_input instance with reason "permission" from these two fields.
    expect([dialog.inputBlocked, dialog.interactionKind]).toEqual([true, "permission"]);
    // #2968: a complete request is required before any remote card; a non-shell "Do you want to proceed?" gives none,
    // so the files are approved only at the terminal, by a person. Its episode then keys on the pane (daemon fallback).
    expect(dialog.remoteCard!(pane)).toBeNull();
    expect(dialog.requestIdentity!(pane)).toBeNull();
  });

  it("the real 2.1.317 MCP permission card (no file marks) is not this card", () => {
    const pane = fx("claude-2.1.317-mcp-permission");
    expect(claudeFileSendCardActive(pane)).toBe(false);
  });

  it("a transcript quoting the card, a card that is not at the bottom, and a Bash card are not this card", () => {
    const pane = fx("claude-2.1.317-file-send-card");
    expect(claudeFileSendCardActive(`${pane}\n❯ \n`)).toBe(false);                                   // composer below it
    expect(claudeFileSendCardActive(pane.replace(" Esc to cancel · Tab to amend", ""))).toBe(false);  // no footer
    expect(claudeFileSendCardActive(pane.replace(" Tool use", " Bash command"))).toBe(false);
    expect(claudeFileSendCardActive(pane.replace(' * "/scratch/cwd/report.pdf"', "").replace('* attachments', ' attachments'))).toBe(false);
    expect(claudeFileSendCardActive(pane.replace("   2. No", "   2. Maybe"))).toBe(false);
  });

  it("every other Claude fixture is untouched by the new detector", () => {
    const others = readdirSync(dir).filter(f => f.startsWith("claude") && f.endsWith(".txt") && !FILE_SEND.some(n => f.startsWith(n)));
    expect(others.length).toBeGreaterThan(300);
    const hits = others.filter(f => claudeFileSendCardActive(readFileSync(join(dir, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("selectionCard reads the default-No order without numbers as no card (the hold still stands)", () => {
    const pane = fx("claude-2.1.317-file-send-default-no");
    expect(selectionCard(pane, "Claude Code")).toBeNull();
    expect(first(pane)!.holdOnly).toBe(true);
  });
});
