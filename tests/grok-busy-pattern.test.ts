import { describe, expect, it } from "vitest";
import { GrokBackend } from "../src/backend/grok.js";
import { PaneStateMachine } from "../src/daemon.js";

/**
 * Captured from a live grok instance: I sent it a read-only task and sampled its
 * pane every second for 90 seconds — 27 distinct frames. The ready pattern
 * matched **every working frame**, because the TUI keeps its input box on screen
 * the whole time it works. Same shape as claude-code before #415: `stuck` is
 * unreachable, so no hang notification, and a frozen CLI reports idle — which
 * clears pending work and books the user's message as handled.
 */

const WORKING = [
  "   ❯ [from:claude-fable] Diagnostic probe …",
  "  ❙  ◆ Run List dir and count entries (read-only)",
  "    ⠹ Waiting for response… 5s                                    5s ⇣2k [stop]",
  "╭──────────────────────────────────────────────────────────────╮",
  "│ ❯                                                            │",
  "╰──────────────────────────────── Grok 4.5 (high) · always-approve ─╯",
  "Shift+Tab:mode  │  Esc:cancel  │  Ctrl+x:shortcuts",
].join("\n");

const IDLE = [
  "     ◆ Thought for 1.8s",
  "╭──────────────────────────────────────────────────────────────╮",
  "│ ❯                                                            │",
  "╰──────────────────────────────── Grok 4.5 (high) · always-approve ─╯",
  "Shift+Tab:mode  │  Ctrl+x:shortcuts",
].join("\n");

describe("GrokBackend busy pattern", () => {
  const backend = new GrokBackend("/tmp/test");

  it("separates a working pane from a waiting one", () => {
    const ready = backend.getReadyPattern();
    const busy = backend.getBusyPattern();

    // The ready marker alone cannot do it — 23 of 23 sampled working frames
    // matched it, because the input box never leaves the screen.
    expect(ready.test(WORKING)).toBe(true);
    expect(ready.test(IDLE)).toBe(true);

    expect(busy.test(WORKING)).toBe(true);
    expect(busy.test(IDLE)).toBe(false);
  });

  it("matches the spinner whatever glyph and verb it shows", () => {
    const busy = backend.getBusyPattern();
    for (const line of [
      "    ⠹ Waiting for response… 5s",
      "  ⠼ Thinking… 3.0s",
      "  ⠸ Waiting for response… 12.3s",
      "  ⠧ Waiting for response… 1s",
    ]) {
      expect(busy.test(line), line).toBe(true);
    }
  });

  it("rejects completed steps and prose", () => {
    // A false positive on a *stable* pane pins the instance in `working` forever:
    // no auto-pause, no cancel-button retirement, eventually a bogus hang alert.
    const busy = backend.getBusyPattern();
    for (const line of [
      "     ◆ Thought for 1.8s",                          // past tense, no ellipsis
      "  ❙  ◈ Searched 1 pattern",                        // a finished tool
      "  ❙  ◆ Run List dir and count entries (read-only)", // a tool title, no timer
      "I waited… 30s for the build",                      // prose
      "- something… 5s",                                  // a bullet
      "Shift+Tab:mode  │  Ctrl+x:shortcuts",
      "│ ❯                                              │",
    ]) {
      expect(busy.test(line), line).toBe(false);
    }
  });
});

describe("grok stuck detection with the busy veto", () => {
  const backend = new GrokBackend("/tmp/test");
  const STUCK_MS = 15_000;

  it("reaches stuck on a frozen working pane", () => {
    // Before the veto this was unreachable on a REAL pane. The existing coverage
    // in critical-coverage.test.ts passes only because it feeds a pane containing
    // nothing but the spinner — the sampled frames never look like that; the
    // input box is always there too.
    const machine = new PaneStateMachine(
      backend.getReadyPattern(), STUCK_MS, 0, backend.getBusyPattern(),
    );

    expect(machine.observe(WORKING, 1).state).toBe("working");
    expect(machine.observe(WORKING, STUCK_MS).state).toBe("working");
    expect(machine.observe(WORKING, STUCK_MS + 1).state).toBe("stuck");
  });

  it("would have reported that same frozen pane as idle without it", () => {
    const machine = new PaneStateMachine(backend.getReadyPattern(), STUCK_MS, 0);

    expect(machine.observe(WORKING, 1).state).toBe("idle");
    expect(machine.observe(WORKING, STUCK_MS + 1).state).toBe("idle");
  });

  it("still settles to idle once the spinner is gone", () => {
    const machine = new PaneStateMachine(
      backend.getReadyPattern(), STUCK_MS, 0, backend.getBusyPattern(),
    );

    machine.observe(WORKING, 1);
    expect(machine.observe(IDLE, 2).state).toBe("working"); // motion
    expect(machine.observe(IDLE, 3).state).toBe("idle");
  });
});
