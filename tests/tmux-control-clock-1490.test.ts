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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxControlClient } from "../src/tmux-control.js";
import { Daemon } from "../src/daemon.js";
import { createBackend } from "../src/backend/index.js";

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
  it("resolves false on the initial fast path when client is already stopped (unknown or idle window)", async () => {
    const { client, internals, advanceMono } = makeClient();
    // Real isIdle returns true for an unmapped window outside observation grace
    expect(client.isIdle("@3")).toBe(true);
    client.stop();

    expect(await client.waitUntilIdle("@3", 100)).toBe(false);

    // Also when the window is mapped and its silence window has genuinely elapsed
    const { client: mappedClient, internals: mappedInternals, advanceMono: advanceMapped } = makeClient();
    mappedInternals.paneToWindow.set("%3", "@3");
    mappedInternals.registeredWindows.add("@3");
    mappedInternals.lastOutputAt.set("%3", Date.now());
    mappedInternals.lastOutputAtMono.set("%3", mappedInternals.mono());
    advanceMapped(SILENCE_MS + 1);
    expect(mappedClient.isIdle("@3")).toBe(true);
    mappedClient.stop();

    expect(await mappedClient.waitUntilIdle("@3", 100)).toBe(false);
    void internals;
    void advanceMono;
  });

  it("resolves false on the initial fast path when abandoned() is already true", async () => {
    const { client } = makeClient();
    expect(client.isIdle("@3")).toBe(true);

    expect(await client.waitUntilIdle("@3", 100, () => true)).toBe(false);
  });

  it("resolves false when client stops while waiting", async () => {
    const { client, internals } = makeClient(5_000);
    internals.paneToWindow.set("%3", "@3");
    internals.registeredWindows.add("@3");
    internals.lastOutputAt.set("%3", Date.now());
    internals.lastOutputAtMono.set("%3", internals.mono());
    expect(client.isIdle("@3")).toBe(false);

    const promise = client.waitUntilIdle("@3", 10_000);
    // Stop the client after a short delay
    setTimeout(() => { client.stop(); }, 50);
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

// ── P1: getObservationResetAt() returns wall-clock (Epoch ms) ────────────────
//
// Fable W1 witness: getObservationResetAt() returned mono (~265 ms) instead
// of wall clock (~1.79e12 ms), breaking daemon.ts callers that compare
// against Date.now()-derived enterAt/pasteStartedAt values.
//
// Reverse mutation: changing getObservationResetAt() to return this.observationResetAt
// (mono) instead of this.observationResetWallAt makes this test fail because
// the mono value is many orders of magnitude smaller than a real Epoch timestamp.

describe("getObservationResetAt returns wall-clock Epoch ms (#1538 P1)", () => {
  it("getObservationResetAt() is comparable to Date.now() after reset", () => {
    const { client } = makeClient();
    const before = Date.now();
    (client as any).resetPaneObservations.call(client);
    const after = Date.now();
    const resetAt = client.getObservationResetAt();

    // Must be in wall-clock range, not mono range (~hundreds of ms)
    expect(resetAt).toBeGreaterThanOrEqual(before);
    expect(resetAt).toBeLessThanOrEqual(after + 100);
  });

  it("getObservationResetAt() returns -1 before any reset", () => {
    const { client } = makeClient();
    expect(client.getObservationResetAt()).toBe(-1);
  });
});

// ── P2: unregisterWindow clears lastOutputAtMono ─────────────────────────────
//
// Fable W2 witness: after unregisterWindow, lastOutputAtMono still had the
// stale pane entry. Re-mapping the same paneId would then make isIdle read
// the old mono timestamp and potentially report idle prematurely.
//
// Reverse mutation: removing lastOutputAtMono.delete from unregisterWindow
// makes this test fail because the stale entry persists.

describe("unregisterWindow clears lastOutputAtMono (#1538 P2)", () => {
  it("lastOutputAtMono entry is removed when window is unregistered", () => {
    const { client, internals } = makeClient();
    const paneId = "%3";
    internals.paneToWindow.set(paneId, "@3");
    internals.registeredWindows.add("@3");
    internals.lastOutputAt.set(paneId, Date.now());
    internals.lastOutputAtMono.set(paneId, internals.mono());

    client.unregisterWindow("@3");

    expect((internals as any).lastOutputAtMono.has(paneId)).toBe(false);
    expect((internals as any).lastOutputAt.has(paneId)).toBe(false);
    expect((internals as any).mappedAt.has(paneId)).toBe(false);
  });
});

// ── (3) Daemon native-queue fallback honours waitUntilIdle → false ───────────

describe("Daemon native-queue fallback does not treat waitUntilIdle → false as idle (#1490 row 70)", () => {
  it("does not re-paste or send recovery Enter when controlClient is stopped at the fallback waitUntilIdle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1490-r70-"));
    try {
      writeFileSync(join(dir, "window-id"), "@steer");
      const { client } = makeClient();
      // Window @steer is unmapped outside grace so client.isIdle("@steer") is true (the fast path).
      // Stopping the client before the fallback waitUntilIdle must make waitUntilIdle return false,
      // and writeMessageToPane must stop without re-pasting or sending a second Enter.
      client.stop();

      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const backend = createBackend("grok", dir);
      // #3199: grok now reads its boxed prompt. This case pins the readerless
      // steer-handoff idle-wait (#1490 row 70); a working reader returns
      // "handoff-box-unread" on this Claude-shaped pane and never reaches the wait.
      Object.assign(backend, { readInputRow: undefined });
      const daemon = new Daemon("r70-test", {
        working_directory: "/tmp",
        backend: "grok",
        restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
        context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
        hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
        log_level: "silent",
      } as any, dir, false, backend, client, { child: () => logger } as any) as any;

      const tmux = {
        pasteBuffer: vi.fn(async () => true),
        sendSpecialKey: vi.fn(async () => true),
        capturePane: vi.fn(async () => "✻ thinking… nothing else"),
        getLastPasteError: vi.fn(() => null),
        isLastPasteFailureRecoverable: vi.fn(() => true),
      };
      daemon.tmux = tmux;
      daemon.firstDeliveryDelay = { consume: () => 0 };
      daemon.waitForInputTransientToClear = async () => true;

      const verdict: any = { reached: false };
      const ok = await daemon.writeMessageToPane(
        "[STEERING] swallowed steer",
        "@steer",
        true,
        { chatId: "c", messageId: "m" },
        "m",
        verdict,
      );

      expect(ok).toBe(false);
      // Only the initial handoff paste and Enter may have occurred; no post-wait re-paste or recovery Enter.
      expect(tmux.pasteBuffer).toHaveBeenCalledTimes(1);
      expect(tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
      expect(verdict.phase).toBe("native-queue-idle-wait");
      expect(verdict.proof).toBe("idle-wait-failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
