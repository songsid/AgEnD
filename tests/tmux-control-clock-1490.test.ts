/**
 * #1490 P3: TmuxControlClient observation age and waitUntilIdle.
 *
 * (1) Observation age uses mono() (performance.now stub), not Date.now().
 *     A wall-clock jump must not affect whether a window appears idle.
 *
 * (2) waitUntilIdle resolves false (not true) when the client is stopped.
 *     Callers must not deliver into a pane because the client stopped.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { TmuxControlClient } from "../src/tmux-control.js";

const SILENCE_MS = 200;

type Internals = {
  mono: () => number;
  lastOutputAt: Map<string, number>;
  lastOutputAtMono: Map<string, number>;
  observationResetAt: number;
  windowToPaneId(id: string): string | undefined;
  paneToWindow: Map<string, string>;
  registeredWindows: Set<string>;
  resetPaneObservations(): void;
  stopped: boolean;
};

function makeClient(silenceMs = SILENCE_MS) {
  const client = new TmuxControlClient("audit-session", silenceMs);
  const internals = client as unknown as Internals;
  let mono = 1_000_000;
  internals.mono = () => mono;
  const advanceMono = (ms: number) => { mono += ms; };
  // Stub out the tmux read so there are no real processes
  (client as unknown as { read: () => Promise<string> }).read = () =>
    new Promise(() => {}); // never resolves in tests
  return { client, internals, advanceMono };
}

afterEach(() => { vi.restoreAllMocks(); });

// ── (1) observation age uses mono() ─────────────────────────────────────────
//
// Reverse mutation: reverting to Date.now() for observationResetAt or
// lastOutputAt causes these tests to fail because a fake wall-clock jump
// makes a pane appear idle before the silence window has elapsed.

describe("TmuxControlClient: observation age uses monotonic clock (#1490 P3)", () => {
  it("inObservationGrace uses mono(): wall-clock jump does not expire grace early", () => {
    const { client, internals, advanceMono } = makeClient(1_000);
    internals.registeredWindows.add("@1");
    internals.resetPaneObservations.call(client);

    // Right after reset: grace is active
    expect((client as any).inObservationGrace()).toBe(true);

    // Advance wall clock by 2s but NOT mono clock — grace should still be active
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2_000);
    expect((client as any).inObservationGrace()).toBe(true);

    // Advance mono clock past silence window — grace expires
    advanceMono(1_001);
    expect((client as any).inObservationGrace()).toBe(false);
  });

  it("isIdle uses mono(): wall-clock jump does not make pane appear idle early", () => {
    const { client, internals, advanceMono } = makeClient(500);
    const paneId = "%1";
    internals.paneToWindow.set(paneId, "@2");
    internals.registeredWindows.add("@2");
    internals.windowToPaneId = () => paneId;
    // Record output at current mono time
    internals.lastOutputAt.set(paneId, Date.now()); // wall clock for hasOutputSince
    internals.lastOutputAtMono.set(paneId, internals.mono()); // mono for isIdle

    // Not idle yet (0ms since last output)
    expect(client.isIdle("@2")).toBe(false);

    // Jump wall clock by 1s but NOT mono — pane should still not be idle
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
    expect(client.isIdle("@2")).toBe(false);

    // Advance mono past silenceMs — now idle
    advanceMono(501);
    expect(client.isIdle("@2")).toBe(true);
  });
});

// ── (2) waitUntilIdle resolves false when stopped ────────────────────────────
//
// Reverse mutation: resolving true when stopped makes this test fail because
// callers would proceed as if the pane is idle.

describe("TmuxControlClient.waitUntilIdle: resolves false when stopped (#1490 P3)", () => {
  it("resolves false when client is already stopped before calling", async () => {
    const { client } = makeClient();
    (client as any).stopped = true;
    // Stub isIdle to return false so we reach the interval check
    (client as any).isIdle = () => false;

    const result = await client.waitUntilIdle("@3", 100);
    expect(result).toBe(false);
  });

  it("resolves false when client stops while waiting", async () => {
    const { client } = makeClient();
    (client as any).isIdle = () => false;

    const promise = client.waitUntilIdle("@3", 10_000);
    // Stop the client after a short delay
    setTimeout(() => { (client as any).stopped = true; }, 50);
    const result = await promise;
    expect(result).toBe(false);
  });

  it("still resolves true when pane becomes idle (regression)", async () => {
    const { client, internals, advanceMono } = makeClient(10);
    const paneId = "%2";
    internals.paneToWindow.set(paneId, "@4");
    internals.registeredWindows.add("@4");
    internals.windowToPaneId = () => paneId;
    internals.lastOutputAt.set(paneId, Date.now()); // wall clock for hasOutputSince
    internals.lastOutputAtMono.set(paneId, internals.mono()); // mono for isIdle

    const promise = client.waitUntilIdle("@4", 5_000);
    // Advance mono past silenceMs so isIdle returns true
    setTimeout(() => advanceMono(20), 100);
    const result = await promise;
    expect(result).toBe(true);
  });
});
