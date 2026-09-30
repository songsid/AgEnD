/**
 * #1045: muse's working row carries an elapsed timer that grows units —
 * `(12s · esc to interrupt)`, then `(1m 31s · esc to interrupt)`. The busy
 * pattern matched seconds only, so past a minute a working muse read as not
 * busy: the pane-state machine called it ready and muse's structural idle
 * proof passed, and idle-edge actions fired mid-turn (#1042's `/quit` was typed
 * under "Thinking (1m 31s …)"). The fixture is built from rows of a real muse
 * instance's output log (working row, separators, status bar).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MuseBackend } from "../src/backend/muse.js";
import { PaneStateMachine } from "../src/daemon.js";

const muse = new MuseBackend("/tmp/agend-muse-1045");
const busy = muse.getBusyPattern();
const OVER_A_MINUTE = readFileSync(new URL("./fixtures/muse-thinking-over-a-minute.pane.txt", import.meta.url), "utf8");
const IDLE = OVER_A_MINUTE.replace(/^◈ Thinking \(1m 31s · esc to interrupt\)\n/m, "◆ Done: the test is fixed.\n");

describe("muse reads as busy for the whole turn, not just its first minute (#1045)", () => {
  it("every working-row timer form seen in a real muse log is busy", () => {
    // The forms that occur (digits vary): 196 working rows, 87 of them past a minute.
    for (const row of [
      "◇ Thinking (2s · esc to interrupt)",
      "◈ Thinking (1m 31s · esc to interrupt)",
      "◈ Calling tools (12m 5s · esc to interrupt)",
      "◆ Double checking (4s ·esc to interrupt)",
      "◈ Working (1h 2m 3s · esc to interrupt)",
      "◈ Callng tols (3m 0s · esc to interrupt)", // a redraw caught mid-paint
    ]) expect(busy.test(row), row).toBe(true);
  });

  it("does not match ordinary text about interrupting", () => {
    for (const row of [
      "◆ Press esc to interrupt a run.",
      "◆ The timer (1m 31s) shows how long it took.",
      "  (esc to interrupt)",
      "  (· esc to interrupt)", // the timer is what makes it a working row
      "◈ Thinking (1m 31s esc to interrupt)", // …and so is the middle dot
    ]) expect(busy.test(row), row).toBe(false);
  });

  it("the structural idle proof refuses a turn past its first minute", () => {
    expect(muse.isPeriodicRedrawIdlePane(IDLE)).toBe(true); // the fixture's chrome is a real idle frame
    expect(muse.isPeriodicRedrawIdlePane(OVER_A_MINUTE)).toBe(false);
  });

  it("the pane-state machine keeps it working, so no idle-edge action can fire", () => {
    const machine = new PaneStateMachine(muse.getReadyPattern(), 10 * 60_000, 0, busy);
    expect(machine.observe(OVER_A_MINUTE, 0).state).toBe("working");
    // Settled (no output for the debounce window): decided on the patterns alone.
    expect(machine.observe(OVER_A_MINUTE, 5_000, { settled: true }).state).toBe("working");
    expect(machine.observe(OVER_A_MINUTE, 90_000, { settled: true }).state).toBe("working");
    // And the idle frame is still idle.
    expect(machine.observe(IDLE, 95_000, { settled: true }).state).toBe("idle");
  });
});
