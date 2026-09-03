import { describe, expect, it } from "vitest";
import {
  bottomRowIsReady,
  inputAreaText,
  lastNonBlankRow,
  pasteLeftInInput,
  pastedTextSignature,
  strandedAgendMessageInInput,
} from "../src/pane-input-residue.js";
import { KiroBackend } from "../src/backend/kiro.js";

// Kiro legacy-UI prompt marker, as implemented by the backend.
const PROMPT = new KiroBackend("/tmp/kiro-residue-test", {
  version: "kiro-cli 2.21.0", supportsRequireMcpStartup: true, supportsLegacyUi: true, supportsEffortFlag: true, source: "version",
}).getBottomReadyPattern();
const BUSY = new KiroBackend("/tmp/kiro-residue-test", {
  version: "kiro-cli 2.21.0", supportsRequireMcpStartup: true, supportsLegacyUi: true, supportsEffortFlag: true, source: "version",
}).getBusyPattern();

// Frames below are verbatim `tmux capture-pane -p` tails from the live
// reproduction on kiro-cli 2.21.0 (--legacy-ui), 2026-09-03.

/** t≈6.5s into a `sleep 9` shell tool: pane is QUIET but the CLI is busy. */
const TOOL_RUNNING = `
1% !> Use your shell tool to run exactly this command and nothing else: sleep 9; echo DONE-MARKER . After it finishes re
ply with only the word DONE.
I will run the following command: sleep 9; echo DONE-MARKER (using tool: shell)
Purpose: Sleep 9 seconds then echo marker
`;

/** After the turn: the text pasted during the tool sits in the prompt row, unsubmitted. */
const STRANDED = `
MSG-1 pasted while kiro was busy
DONE-MARKER
⠋ Thinking... - Completed in 9.6s
> DONE
 ▸ Time: 15s
2% !> [user:hanhanv via discord, id:368442276000694273] MSG-1 pasted while kiro was busy
`;

/** Both messages submitted together; the CLI is generating its reply. */
const GENERATING = `
2% !> [user:hanhanv via discord, id:368442276000694273] MSG-1 pasted while kiro was busy
[user:hanhanv via discord, id:368442276000694273] MSG-2 pasted after idle
⠇ Thinking...
`;

/** Clean idle prompt with Kiro's own placeholder hint sharing the row. */
const IDLE_WITH_HINT = `
> I see two messages here.
 ▸ Time: 2s
2% !> Not sure where to start? Ask me about my features
`;

/** Clean idle prompt, bare. Live m365 capture. */
const IDLE_BARE = `
 ▸ Time: 14s
51% !>
`;

/** A long paste wraps across rows; the prompt row is not the last row. */
const STRANDED_WRAPPED = `
 ▸ Time: 3s
12% !> [from:agend-leader-t1503382358143799511] ## Task: 研究 kiro delivery 偶發「paste 了但 Enter 沒送出」（忙碌時送訊息才發生）
使用者回報一個偶發、低機率、只在 kiro 看到的 delivery bug，想請你查根因。
`;

describe("pane-input-residue: bottom-anchored readiness", () => {
  it("is NOT ready while a silent tool runs (bottom row is the tool banner)", () => {
    expect(lastNonBlankRow(TOOL_RUNNING)).toContain("Purpose:");
    expect(bottomRowIsReady(TOOL_RUNNING, PROMPT)).toBe(false);
  });

  it("is NOT ready while generating (bottom row is the spinner) and the busy pattern agrees", () => {
    expect(bottomRowIsReady(GENERATING, PROMPT)).toBe(false);
    expect(BUSY.test(GENERATING)).toBe(true);
  });

  it("is ready on a bare prompt and on a prompt sharing its row with the placeholder hint", () => {
    expect(bottomRowIsReady(IDLE_BARE, PROMPT)).toBe(true);
    expect(bottomRowIsReady(IDLE_WITH_HINT, PROMPT)).toBe(true);
    expect(bottomRowIsReady("> ok\n20% λ !>", PROMPT)).toBe(true);      // mode-glyph form
    expect(bottomRowIsReady("> ok\n  7% !> ", PROMPT)).toBe(true);      // leading indent
  });

  it("is NOT ready when the bottom row is tool output that merely contains a percentage and a chevron", () => {
    // sol's review: the unanchored marker declared both of these ready.
    expect(bottomRowIsReady("running…\nProgress 50% > /tmp/output", PROMPT)).toBe(false);
    expect(bottomRowIsReady("running…\ndownload 100% -> done", PROMPT)).toBe(false);
    expect(bottomRowIsReady("running…\n100% > done", PROMPT)).toBe(false);          // no `!` under --trust-all-tools
    expect(bottomRowIsReady("running…\nSee 12% !> in the docs", PROMPT)).toBe(false); // not at the row start
  });

  it("is NOT ready when the turn's own prompt row has scrolled out of the viewport", () => {
    // Long tool output: the pane holds only output rows, no `N% !>` anywhere.
    const scrolled = Array.from({ length: 40 }, (_, i) => `line ${i} of a long tool output`).join("\n");
    expect(bottomRowIsReady(scrolled, PROMPT)).toBe(false);
    expect(inputAreaText(scrolled, PROMPT)).toBeNull();
  });

  it("is ready (prompt row visible) even when stranded text sits after the marker", () => {
    // Readiness and residue are separate questions: the prompt is up, so an
    // Enter will be honoured — that is exactly what F3 relies on.
    expect(bottomRowIsReady(STRANDED, PROMPT)).toBe(true);
  });
});

describe("pane-input-residue: input area text", () => {
  it("returns the text after the last prompt marker", () => {
    expect(inputAreaText(STRANDED, PROMPT)).toBe("[user:hanhanv via discord, id:368442276000694273] MSG-1 pasted while kiro was busy");
  });

  it("joins wrapped continuation rows below the prompt row", () => {
    const text = inputAreaText(STRANDED_WRAPPED, PROMPT)!;
    expect(text.startsWith("[from:agend-leader-t1503382358143799511]")).toBe(true);
    expect(text).toContain("使用者回報一個偶發");
  });

  it("is empty for a bare prompt and returns null when no prompt row is on screen", () => {
    expect(inputAreaText(IDLE_BARE, PROMPT)).toBe("");
    expect(inputAreaText("⠇ Thinking...\n", PROMPT)).toBeNull();
  });
});

describe("pane-input-residue: did our paste get submitted?", () => {
  const formatted = "[user:hanhanv via discord, id:368442276000694273] MSG-1 pasted while kiro was busy\n(message_id: 1)";

  it("detects the pasted text still sitting in the input row", () => {
    expect(pasteLeftInInput(STRANDED, PROMPT, formatted)).toBe(true);
  });

  it("does not flag a bare prompt or the placeholder hint as our unsent text", () => {
    expect(pasteLeftInInput(IDLE_BARE, PROMPT, formatted)).toBe(false);
    expect(pasteLeftInInput(IDLE_WITH_HINT, PROMPT, formatted)).toBe(false);
  });

  it("survives the TUI re-wrapping the pasted text", () => {
    const long = "[from:agend-leader-t1503382358143799511] ## Task: 研究 kiro delivery 偶發「paste 了但 Enter 沒送出」（忙碌時送訊息才發生）\n\n使用者回報…";
    expect(pasteLeftInInput(STRANDED_WRAPPED, PROMPT, long)).toBe(true);
    expect(pastedTextSignature(long)).toHaveLength(24);
  });

  it("is a whitespace-insensitive prefix match, so a different message is not mistaken for ours", () => {
    expect(pasteLeftInInput(STRANDED, PROMPT, "[user:hanhanv via discord, id:368442276000694273] MSG-9 something else")).toBe(false);
  });
});

describe("pane-input-residue: prompt pattern follows the launched UI and trust mode", () => {
  const compat = { version: "kiro-cli 2.21.0", supportsRequireMcpStartup: true, supportsLegacyUi: true, supportsEffortFlag: true, source: "version" as const };
  const base = { workingDirectory: "/tmp", instanceName: "x" } as any;

  it("is legacy-only: a v3 or new-TUI launch disables the Enter-drop gate", () => {
    const be = new KiroBackend("/tmp/kiro-residue-test", compat);
    be.buildCommand({ ...base, kiroUi: "v3" });
    expect(be.dropsEnterWhileBusy()).toBe(false);
    expect(be.getBottomReadyPattern()).toBeNull();
    be.buildCommand({ ...base, kiroUi: "tui" });
    expect(be.dropsEnterWhileBusy()).toBe(false);
    be.buildCommand({ ...base, kiroUi: "legacy" });
    expect(be.dropsEnterWhileBusy()).toBe(true);
  });

  it("treats a legacy request on a binary without --legacy-ui as the new TUI", () => {
    const be = new KiroBackend("/tmp/kiro-residue-test", { ...compat, supportsLegacyUi: false });
    be.buildCommand({ ...base, kiroUi: "legacy" });
    expect(be.dropsEnterWhileBusy()).toBe(false);
  });

  it("disables the gate without --trust-all-tools (a bare `N% >` row cannot be told from tool output)", () => {
    const be = new KiroBackend("/tmp/kiro-residue-test", compat);
    be.buildCommand({ ...base, skipPermissions: false });
    expect(be.dropsEnterWhileBusy()).toBe(false);
    expect(be.getBottomReadyPattern()).toBeNull();
    be.buildCommand({ ...base });
    expect(be.dropsEnterWhileBusy()).toBe(true);
    expect(bottomRowIsReady("> ok\n12% >", be.getBottomReadyPattern()!)).toBe(false);
    expect(bottomRowIsReady("> ok\n12% !>", be.getBottomReadyPattern()!)).toBe(true);
  });
});

describe("pane-input-residue: stranded AgEnD message detection (F3)", () => {
  it("recognises a stranded [user:] / [from:] message in the input row", () => {
    expect(strandedAgendMessageInInput(STRANDED, PROMPT)).toBe(true);
    expect(strandedAgendMessageInInput(STRANDED_WRAPPED, PROMPT)).toBe(true);
  });

  it("never fires on Kiro's own placeholder hint or a bare prompt", () => {
    expect(strandedAgendMessageInInput(IDLE_WITH_HINT, PROMPT)).toBe(false);
    expect(strandedAgendMessageInInput(IDLE_BARE, PROMPT)).toBe(false);
  });

  it("does not treat a historical prompt row as stranded input (caller checks busy first)", () => {
    // While generating, the last prompt row is history and its echo carries the
    // marker; the daemon consults the busy pattern before calling this helper.
    expect(BUSY.test(GENERATING)).toBe(true);
  });
});
