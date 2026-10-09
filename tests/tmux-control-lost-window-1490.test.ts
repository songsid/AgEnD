import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TmuxControlClient } from "../src/tmux-control.js";
import { TmuxReadError } from "../src/tmux-read.js";

/**
 * #1490 (2.2 audit): after three failed `list-panes`, the control client dropped a window's registration, and isIdle
 * answered "idle" for an unregistered window once the reconnect grace was over. A live window that stopped resolving
 * therefore read as idle forever, and a delivery pasted into a generating CLI (Enter = interrupt).
 *
 * The real TmuxControlClient, with its tmux read replaced by a stub: no tmux server, no control process, no fleet.
 * The monotonic clock is the client's own `mono` hook, advanced by hand.
 */

const SILENCE_MS = 2_000;
const RETRY_MS = 5_000;

type Internals = {
  registeredWindows: Set<string>;
  lostWindows: Map<string, unknown>;
  paneToWindow: Map<string, string>;
  lastOutputAt: Map<string, number>;
  attachment: unknown;
  mono: () => number;
  resolvePane(windowId: string): Promise<void>;
  resetPaneObservations(): void;
};

let clock = 1_000_000;
let reads: Array<{ resolve: (v: string) => void; reject: (e: unknown) => void }> = [];

function makeClient() {
  const client = new TmuxControlClient("audit-session", SILENCE_MS);
  const internals = client as unknown as Internals;
  internals.mono = () => clock;
  // Every tmux read is a pending promise the test settles.
  (client as unknown as { read: () => Promise<string> }).read = () => new Promise<string>((resolve, reject) => { reads.push({ resolve, reject }); });
  return { client, internals };
}

const commandFailure = () => new TmuxReadError("command", "can't find pane");

/** The oldest pending tmux read — asserted to exist, so a missing read fails as an assertion, not a TypeError. */
function nextRead() {
  expect(reads.length, "a tmux read was issued").toBeGreaterThan(0);
  return reads.shift()!;
}

/** Register @7 and drive its resolve to fail three times in a row (the drop threshold). */
async function loseWindow(client: TmuxControlClient, internals: Internals): Promise<void> {
  internals.registeredWindows.add("@7");
  for (let i = 0; i < 3; i++) {
    const p = internals.resolvePane.call(client, "@7");
    nextRead().reject(commandFailure());
    await p;
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => { clock = 1_000_000; reads = []; });
afterEach(() => { vi.useRealTimers(); });

describe("a registered window that stops resolving is not idle (#1490)", () => {
  it("reports a lost window as busy, long after any grace — the old code said idle forever", async () => {
    const { client, internals } = makeClient();
    await loseWindow(client, internals);

    expect(internals.registeredWindows.has("@7"), "out of the reconnect set").toBe(false);
    expect(internals.lostWindows.has("@7"), "remembered as lost").toBe(true);
    expect(client.isIdle("@7")).toBe(false);
    clock += 60 * 60_000;
    expect(client.isIdle("@7"), "still unknown an hour later").toBe(false);
  });

  it("keeps a never-registered window on the old optimistic answer (positive control)", () => {
    const { client } = makeClient();
    expect(client.isIdle("@99")).toBe(true);
  });

  it("does not let waitUntilIdle report a lost window idle", async () => {
    vi.useFakeTimers();
    const { client, internals } = makeClient();
    internals.registeredWindows.add("@7");
    for (let i = 0; i < 3; i++) {
      const p = internals.resolvePane.call(client, "@7");
      nextRead().reject(commandFailure());
      await p;
    }
    const waited = client.waitUntilIdle("@7", 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await waited).toBe(false);
  });
});

describe("a registered window whose pane is not resolved yet is not idle (#1490)", () => {
  it("stays busy after the reconnect grace while its re-resolution is still failing", () => {
    vi.useFakeTimers();
    const { client, internals } = makeClient();
    internals.registeredWindows.add("@7");
    internals.resetPaneObservations();           // what connect() does: every mapping dropped, grace armed

    vi.advanceTimersByTime(SILENCE_MS + 1);      // grace over, @7 still unresolved
    expect(client.isIdle("@7")).toBe(false);
    expect(client.isIdle("@99"), "an unregistered window after the same grace").toBe(true);
  });
});

describe("a lost window comes back on demand", () => {
  it("retries only after the spacing, then re-registers under a fresh token", async () => {
    const { client, internals } = makeClient();
    await loseWindow(client, internals);

    client.isIdle("@7");
    expect(reads.length, "no retry right after the third failure").toBe(0);
    clock += RETRY_MS;
    client.isIdle("@7");
    client.isIdle("@7");
    expect(reads.length, "one retry per spacing, however often it is asked").toBe(1);

    nextRead().resolve("%3\n");
    await flush();
    expect(internals.lostWindows.has("@7")).toBe(false);
    expect(internals.registeredWindows.has("@7"), "back in the reconnect set").toBe(true);
    expect(internals.paneToWindow.get("%3")).toBe("@7");
  });

  it("is not idle on recovery until it has been silent for silenceMs, and output resets that", async () => {
    const { client, internals } = makeClient();
    await loseWindow(client, internals);
    clock += RETRY_MS;
    client.isIdle("@7");
    nextRead().resolve("%3\n");
    await flush();

    expect(client.isIdle("@7"), "nothing observed since it came back").toBe(false);
    clock += SILENCE_MS - 1;
    expect(client.isIdle("@7")).toBe(false);
    clock += 1;
    expect(client.isIdle("@7"), "silent for silenceMs").toBe(true);

    internals.lastOutputAt.set("%3", Date.now());
    expect(client.isIdle("@7"), "real output after recovery is busy").toBe(false);
  });

  it("stays lost when the retry fails, and tries again after the next spacing", async () => {
    const { client, internals } = makeClient();
    await loseWindow(client, internals);
    clock += RETRY_MS;
    client.isIdle("@7");
    nextRead().reject(commandFailure());
    await flush();
    expect(client.isIdle("@7")).toBe(false);
    expect(reads.length).toBe(0);
    clock += RETRY_MS;
    client.isIdle("@7");
    expect(reads.length).toBe(1);
  });

  it("ignores a retry that resolves after the window was unregistered", async () => {
    const { client, internals } = makeClient();
    await loseWindow(client, internals);
    clock += RETRY_MS;
    client.isIdle("@7");

    client.unregisterWindow("@7");               // the daemon retired the window meanwhile
    nextRead().resolve("%3\n");
    await flush();

    expect(internals.registeredWindows.has("@7")).toBe(false);
    expect(internals.paneToWindow.has("%3")).toBe(false);
  });

  it("ignores a retry that resolves on an attachment that has since been replaced", async () => {
    const { client, internals } = makeClient();
    await loseWindow(client, internals);
    clock += RETRY_MS;
    client.isIdle("@7");

    internals.attachment = { replaced: true };   // a reconnect: pane ids from the old server mean nothing now
    nextRead().resolve("%3\n");
    await flush();

    expect(internals.lostWindows.has("@7")).toBe(true);
    expect(internals.paneToWindow.has("%3")).toBe(false);
  });

  it("is cleared by an explicit registerWindow of the same id", async () => {
    const { client, internals } = makeClient();
    await loseWindow(client, internals);

    const p = client.registerWindow("@7");
    expect(internals.lostWindows.has("@7")).toBe(false);
    nextRead().resolve("%3\n");
    await p;
    expect(internals.paneToWindow.get("%3")).toBe("@7");
  });
});
