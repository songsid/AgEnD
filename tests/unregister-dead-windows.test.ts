import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Every reconnect re-resolves every registered window, one `tmux list-panes`
 * subprocess each. A registration for a window that no longer exists is therefore
 * a permanent per-reconnect cost, paid for the life of the fleet process — and the
 * registry only ever grew: a crash respawn creates a new window id and the dead
 * one was never retired.
 *
 * The tmux call itself is stubbed; everything else is the real implementation, so
 * these fail if the bookkeeping in resolvePane changes.
 */

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile,
}));

const { TmuxControlClient } = await import("../src/tmux-control.js");

type Internals = {
  registeredWindows: Set<string>;
  resolveFailures: Map<string, number>;
  paneToWindow: Map<string, string>;
  lastOutputAt: Map<string, number>;
  resolvePane(windowId: string): Promise<void>;
};

/** Next `tmux list-panes` succeeds with a pane id, or fails like a missing window. */
function tmuxWill(outcome: "ok" | "fail"): void {
  execFile.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null, out: string) => void) => {
    if (outcome === "ok") cb(null, "%3\n");
    else cb(new Error("can't find window: @7"), "");
  });
}

function makeClient() {
  const client = new TmuxControlClient("test-session", 2_000);
  const internals = client as unknown as Internals;
  internals.registeredWindows.add("@7");
  return { client, internals, resolve: () => internals.resolvePane.call(client, "@7") };
}

beforeEach(() => { execFile.mockReset(); });

describe("dead window registrations", () => {
  it("is dropped after three consecutive resolve failures", async () => {
    const { internals, resolve } = makeClient();
    tmuxWill("fail");

    await resolve();
    await resolve();
    expect(internals.registeredWindows.has("@7")).toBe(true); // still tolerated

    await resolve();
    expect(internals.registeredWindows.has("@7")).toBe(false);
  });

  it("survives transient failures interleaved with successes", async () => {
    // tmux fails intermittently under load (a fleet-restart storm). Dropping a
    // live window's registration would silence the output events its daemon
    // depends on, so only an unbroken run counts.
    const { internals, resolve } = makeClient();

    for (let i = 0; i < 10; i++) {
      tmuxWill("fail"); await resolve();
      tmuxWill("fail"); await resolve();
      tmuxWill("ok"); await resolve();
    }

    expect(internals.registeredWindows.has("@7")).toBe(true);
    expect(internals.resolveFailures.has("@7")).toBe(false);
  });

  it("caches the pane mapping on a successful resolve", async () => {
    const { client, internals, resolve } = makeClient();
    tmuxWill("ok");

    await resolve();

    expect(internals.paneToWindow.get("%3")).toBe("@7");
    // No output recorded yet and no reconnect in play: the pre-existing
    // optimistic answer stands.
    expect(client.isIdle("@7")).toBe(true);
  });

  it("forgets a window's failure count when it is unregistered", async () => {
    const { client, internals, resolve } = makeClient();
    tmuxWill("fail");
    await resolve();

    client.unregisterWindow("@7");

    // Otherwise a re-registered id would inherit a head start toward being dropped.
    expect(internals.resolveFailures.has("@7")).toBe(false);
  });

  it("unregistering clears the pane mapping and its output timestamp", async () => {
    const { client, internals, resolve } = makeClient();
    tmuxWill("ok");
    await resolve();
    internals.lastOutputAt.set("%3", Date.now());

    client.unregisterWindow("@7");

    expect(internals.paneToWindow.has("%3")).toBe(false);
    expect(internals.lastOutputAt.has("%3")).toBe(false);
  });

  it("only drops a window that is actually registered", async () => {
    // resolvePane also runs for ids that were never registered; failing on one
    // must not synthesise a registration just to delete it.
    const { client, internals } = makeClient();
    internals.registeredWindows.delete("@7");
    tmuxWill("fail");

    for (let i = 0; i < 5; i++) await internals.resolvePane.call(client, "@7");

    expect(internals.registeredWindows.size).toBe(0);
  });
});
