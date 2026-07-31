import { describe, expect, it, vi, afterEach } from "vitest";
import { TmuxControlClient } from "../src/tmux-control.js";

/**
 * `connect()` drops the paneId→windowId map and the last-output timestamps,
 * because pane IDs are tmux-server-scoped and a reconnect may be talking to a
 * different server. That is correct — but it also erases the only evidence that
 * a pane is busy, and `isIdle` used to answer "idle" whenever it had no evidence.
 *
 * The consequence was not cosmetic: `deliverMessage` skips its busy branch when
 * `isIdle` is true, so for a moment after every reconnect a message could be
 * pasted straight into a generating CLI, where Enter steers the current turn
 * instead of starting a new one.
 */

const SILENCE_MS = 2_000;

function makeClient() {
  const client = new TmuxControlClient("test-session", SILENCE_MS);
  // Drive the state directly. Spawning a real `tmux -C attach` is neither
  // available nor necessary — the bug lives entirely in the bookkeeping.
  const state = client as unknown as {
    paneToWindow: Map<string, string>;
    lastOutputAt: Map<string, number>;
    resetPaneObservations(): void;
  };
  return { client, state };
}

/**
 * The cache reset `connect()` performs, invoked directly rather than re-stated
 * here — a hand-written simulation would keep passing if `connect()` stopped
 * arming the grace, which is the whole thing under test.
 */
function simulateReconnect(state: ReturnType<typeof makeClient>["state"]) {
  state.resetPaneObservations();
}

describe("control-mode reconnect does not fake an idle pane", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("reports a pane with no observations as busy while the grace holds", () => {
    vi.useFakeTimers();
    const { client, state } = makeClient();

    state.paneToWindow.set("%1", "@1");
    state.lastOutputAt.set("%1", Date.now());
    expect(client.isIdle("@1")).toBe(false); // actively producing output

    simulateReconnect(state);
    // Same pane, same generating CLI — only our knowledge of it was discarded.
    expect(client.isIdle("@1")).toBe(false);
  });

  it("re-resolving the pane before any output still does not claim idle", () => {
    vi.useFakeTimers();
    const { client, state } = makeClient();
    simulateReconnect(state);

    // resolvePane() restores the mapping; output has not arrived yet.
    state.paneToWindow.set("%1", "@1");
    expect(client.isIdle("@1")).toBe(false);
  });

  it("becomes idle again once the grace expires with nothing observed", () => {
    vi.useFakeTimers();
    const { client, state } = makeClient();
    simulateReconnect(state);

    expect(client.isIdle("@1")).toBe(false);
    vi.advanceTimersByTime(SILENCE_MS);
    // A window that is genuinely untracked must not block delivery forever, and
    // silence for silenceMs is this class's own definition of idle anyway.
    expect(client.isIdle("@1")).toBe(true);
  });

  it("lets real output during the grace settle to idle on the normal schedule", () => {
    vi.useFakeTimers();
    const { client, state } = makeClient();
    simulateReconnect(state);

    state.paneToWindow.set("%1", "@1");
    vi.advanceTimersByTime(500);
    state.lastOutputAt.set("%1", Date.now()); // a %output record arrives

    expect(client.isIdle("@1")).toBe(false);
    vi.advanceTimersByTime(SILENCE_MS - 1);
    expect(client.isIdle("@1")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(client.isIdle("@1")).toBe(true);
  });

  it("treats an untracked window as idle when no reconnect has happened", () => {
    // The pre-existing "unknown window = assume idle" behaviour is unchanged for
    // a client that never connected — e.g. a fresh window in a standalone test.
    const { client } = makeClient();
    expect(client.isIdle("@99")).toBe(true);
  });
});
