/**
 * Mid-session Luna Reserve re-arm: when a delivery waits for a
 * "Resuming session…" transient to clear, the first-delivery delay must be
 * re-armed so the *next* paste uses the 1750ms minimum settle window instead
 * of the normal 500ms.
 *
 * The daemon's waitForInputTransientToClear() calls
 * firstDeliveryDelay.recordReady() exactly when this matters: after actually
 * observing the transient and seeing it go clear. Removing that call would
 * leave mid-session Luna Reserve switches on the 500ms path — Enter fires at
 * ~550ms, the compositor is still initialising, and the Enter is swallowed.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";

const dirs: string[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeCodexDaemon() {
  const instanceDir = mkdtempSync(join(tmpdir(), "agend-rearm-"));
  dirs.push(instanceDir);
  writeFileSync(join(instanceDir, "window-id"), "@1");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const backend = new CodexBackend(instanceDir);
  const daemon = new Daemon(
    "codex-rearm",
    {
      working_directory: "/tmp",
      backend: "codex",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
      log_level: "silent",
    } as any,
    instanceDir,
    false,
    backend as any,
    undefined,
    { child: () => logger } as any,
  ) as any;
  return { daemon, backend };
}

/** Codex's real "Resuming session…" transient pane structure (simplified). */
const RESUMING_PANE = [
  "╭────────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.154.0)             │",
  "│ model:                loading          │",
  "╰────────────────────────────────────────╯",
  "  Resuming session…",
  "› Ask Codex to do anything",
].join("\n");

const IDLE_PANE = [
  "› Ask Codex to do anything",
  "  Context 80% left | $0.03",
].join("\n");

describe("first-delivery re-arm after input transient clears", () => {
  it("re-arms the 1750ms window when a Resuming-session transient clears on pre-write", async () => {
    // Mutation guard: removing `this.firstDeliveryDelay.recordReady()` from
    // waitForInputTransientToClear would leave the second-or-later delivery
    // after a mid-session resume on the normal 500ms path, which is too short
    // for the Luna Reserve compositor to be ready.
    const { daemon } = makeCodexDaemon();

    // Simulate mid-session: the first startup consume already happened.
    daemon.firstDeliveryDelay.recordReady(0);
    daemon.firstDeliveryDelay.consume(100);  // consume the startup arm
    expect(daemon.firstDeliveryDelay.consume(200)).toBe(500); // normal after first

    // Re-arm it: treat this as if the transient guard was armed for this spawn.
    daemon.firstDeliveryDelay.recordReady(0);  // fresh startup arm again
    daemon.firstDeliveryDelay.consume(100);    // consume again (previous session)

    // Set up the transient guard as the daemon does at spawn time.
    daemon.inputTransientGuardGeneration = daemon.spawnGeneration;

    // Mock capturePane: first call returns RESUMING (active transient),
    // second call returns IDLE (transient cleared).
    let callCount = 0;
    daemon.tmux = {
      capturePane: async () => { callCount++; return callCount === 1 ? RESUMING_PANE : IDLE_PANE; },
    };

    // Run waitForInputTransientToClear — it should observe the transient,
    // then see it clear, and re-arm firstDeliveryDelay.
    const result = (daemon as any).waitForInputTransientToClear("pre-write");

    // Advance past the poll interval so the transient clears.
    await vi.advanceTimersByTimeAsync(500);
    const cleared = await result;
    expect(cleared).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(2);

    // The re-arm must have fired: consume() now returns 1750ms again.
    // Without the re-arm, this would return 500ms.
    expect(daemon.firstDeliveryDelay.consume(Date.now())).toBe(1_750);
  });

  it("does NOT re-arm when transient clears on an Enter-path phase (mutation guard: scope)", async () => {
    // The re-arm must be scoped to phase === "pre-write". Enter-path callers
    // (initial-submit, retries) run after consume(), so re-arming there leaves
    // the 1750ms flag for the NEXT unrelated delivery — incorrectly slowing it.
    // Mutation guard: removing `&& phase === "pre-write"` would cause this test
    // to fail (re-arm happens, consume returns 1750 instead of 500).
    const { daemon } = makeCodexDaemon();

    // Consume the startup arm — no 1750ms pending.
    daemon.firstDeliveryDelay.recordReady(0);
    daemon.firstDeliveryDelay.consume(100);

    daemon.inputTransientGuardGeneration = daemon.spawnGeneration;
    let callCount = 0;
    daemon.tmux = {
      capturePane: async () => { callCount++; return callCount === 1 ? RESUMING_PANE : IDLE_PANE; },
    };

    // Run from the Enter-path phase (NOT pre-write).
    const result = (daemon as any).waitForInputTransientToClear("initial-submit");
    await vi.advanceTimersByTimeAsync(500);
    const cleared = await result;
    expect(cleared).toBe(true);

    // No re-arm: Enter-path phase must not arm the next delivery.
    expect(daemon.firstDeliveryDelay.consume(Date.now())).toBe(500);
  });

  it("does NOT re-arm when no transient was observed (normal delivery path)", async () => {
    // Only actually-observed transients trigger the re-arm. A delivery that
    // passes through waitForInputTransientToClear with no transient active
    // must not spuriously re-arm and slow down normal deliveries.
    const { daemon } = makeCodexDaemon();
    daemon.firstDeliveryDelay.recordReady(0);
    daemon.firstDeliveryDelay.consume(100); // consume startup arm

    // Guard armed, but pane is already clear.
    daemon.inputTransientGuardGeneration = daemon.spawnGeneration;
    daemon.tmux = { capturePane: async () => IDLE_PANE };

    await (daemon as any).waitForInputTransientToClear("pre-write");

    // No re-arm: observedDescription remained null (no transient was seen).
    expect(daemon.firstDeliveryDelay.consume(Date.now())).toBe(500);
  });
});
