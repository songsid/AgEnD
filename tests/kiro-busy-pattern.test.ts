import { describe, expect, it } from "vitest";
import { KiroBackend } from "../src/backend/kiro.js";
import { PaneStateMachine } from "../src/daemon.js";

const WORKING_PANE = [
  " ▸ Credits: 4.24 • Time: 1m 35s",
  "64% λ !>",
  "",
  "⠹ Thinking...",
].join("\n");

const IDLE_PANE = [
  " ▸ Credits: 4.24 • Time: 1m 35s",
  "64% λ !>",
  "",
  "Ask a question or describe a task",
].join("\n");

// Captured from doupo-leader after a completed report_result (2026-08-14).
// Kiro left the old spinner in the visible pane, then painted a fresh ready
// footer below it. #572's pane-wide busy match pinned this state as working
// until the 15-minute stuck deadline fired.
const IDLE_WITH_STALE_SPINNER = [
  "72% λ !>",
  "[from:worker] completed report",
  "",
  "⠹ Thinking...",
  "> 完成。",
  "Running tool report_result with the param",
  " - Completed in 0.15s",
  "",
  "> .",
  "",
  " ▸ Credits: 2.41 • Time: 42s",
  "",
  "72% λ !>",
].join("\n");

describe("KiroBackend ready/busy patterns (#548)", () => {
  const backend = new KiroBackend("/tmp/agend-kiro-busy-test");

  it("vetoes the persistent ready statusline while the live Kiro spinner is visible", () => {
    expect(backend.getReadyPattern().test(WORKING_PANE)).toBe(true);
    expect(backend.getReadyPattern().test(IDLE_PANE)).toBe(true);
    expect(backend.getBusyPattern().test(WORKING_PANE)).toBe(true);
    expect(backend.getBusyPattern().test(IDLE_PANE)).toBe(false);
  });

  it.each([
    "⠹ Thinking...",
    "⠏ Thinking...",
    "  ⣷ Working…",
  ])("recognizes Kiro spinner frame %s", (line) => {
    expect(backend.getBusyPattern().test(line)).toBe(true);
  });

  it.each([
    "I was Thinking... about the issue",
    "- Thinking... is the spinner text",
    "Worked for 12s",
    "64% λ !>",
  ])("does not pin normal prose/status as busy: %s", (line) => {
    expect(backend.getBusyPattern().test(line)).toBe(false);
  });

  it("ignores a stale spinner when a completed turn and ready footer follow it", () => {
    expect(backend.getReadyPattern().test(IDLE_WITH_STALE_SPINNER)).toBe(true);
    expect(backend.getBusyPattern().test(IDLE_WITH_STALE_SPINNER)).toBe(false);
    expect(backend.getPaneActivity(IDLE_WITH_STALE_SPINNER)).toBeNull();

    const machine = new PaneStateMachine(
      backend.getReadyPattern(),
      10 * 60_000,
      0,
      backend.getBusyPattern(),
    );
    expect(machine.observe(WORKING_PANE, 1, { settled: true }).state).toBe("working");
    expect(machine.observe(IDLE_WITH_STALE_SPINNER, 2_001, { settled: true }).state).toBe("idle");
  });

  it("keeps the pane working after the 2s idle debounce until the spinner disappears", () => {
    const machine = new PaneStateMachine(
      backend.getReadyPattern(),
      10 * 60_000,
      0,
      backend.getBusyPattern(),
    );

    expect(machine.observe(WORKING_PANE, 1, { settled: true }).state).toBe("working");
    expect(machine.observe(WORKING_PANE, 2_500, { settled: true }).state).toBe("working");
    expect(machine.observe(IDLE_PANE, 2_501, { settled: false }).state).toBe("working");
    expect(machine.observe(IDLE_PANE, 4_502, { settled: true }).state).toBe("idle");
  });
});
