import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * A daemon that is restarting — `/restart`, crash recovery, a model switch —
 * drops its IPC socket for a few seconds. Any message arriving in that window
 * used to fail instantly: a warning in the log, ❌ on the user's message, and the
 * message gone. The user had to spot the ❌ and retype it.
 *
 * Deliveries now wait out a transient disconnect, in arrival order, and only fail
 * once the instance is really gone.
 */

function makeFleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-ipc-wait-"));
  const fm = new FleetManager(dir);
  const internals = fm as unknown as {
    sendWhenConnected(name: string, payload: Record<string, unknown>): Promise<void>;
    instanceIpcClients: Map<string, { connected: boolean; send(msg: unknown): boolean }>;
    logger: { info: (...a: unknown[]) => void };
  };
  internals.logger = { ...internals.logger, info: vi.fn() } as never;
  return { fm, internals, dir };
}

/** A stand-in IpcClient whose socket can be taken away and given back. */
function fakeClient(sent: unknown[], connected = true) {
  return {
    connected,
    send(msg: unknown) {
      if (!this.connected) return false;
      sent.push(msg);
      return true;
    },
  };
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("delivery survives an IPC restart", () => {
  it("sends immediately when the socket is up", async () => {
    const { internals, dir } = makeFleet(); dirs.push(dir);
    const sent: unknown[] = [];
    internals.instanceIpcClients.set("alpha", fakeClient(sent));

    await internals.sendWhenConnected("alpha", { type: "fleet_inbound", content: "hi" });

    expect(sent).toEqual([{ type: "fleet_inbound", content: "hi" }]);
  });

  it("holds the message until the daemon reconnects, then delivers it", async () => {
    const { internals, dir } = makeFleet(); dirs.push(dir);
    const sent: unknown[] = [];
    // Mid-restart: the disconnect handler has already removed the client.
    internals.instanceIpcClients.delete("alpha");

    const delivery = internals.sendWhenConnected("alpha", { type: "fleet_inbound", content: "hi" });
    await new Promise(r => setTimeout(r, 50));
    expect(sent).toEqual([]); // still waiting, not failed

    // Reconnect installs a NEW client object — a cached reference would stay dead.
    internals.instanceIpcClients.set("alpha", fakeClient(sent));
    await delivery;

    expect(sent).toEqual([{ type: "fleet_inbound", content: "hi" }]);
  });

  it("treats a socket that dies between the check and the write as undelivered", async () => {
    const { internals, dir } = makeFleet(); dirs.push(dir);
    const sent: unknown[] = [];
    // `connected` is true but the write fails — the race that used to vanish a
    // message, because send() returned void and the caller assumed success.
    const flaky = { connected: true, send: () => false };
    internals.instanceIpcClients.set("alpha", flaky as never);

    const delivery = internals.sendWhenConnected("alpha", { type: "fleet_inbound", content: "hi" });
    await new Promise(r => setTimeout(r, 50));
    internals.instanceIpcClients.set("alpha", fakeClient(sent));
    await delivery;

    expect(sent).toEqual([{ type: "fleet_inbound", content: "hi" }]);
  });

  it("keeps arrival order when a message lands after the reconnect", async () => {
    const { internals, dir } = makeFleet(); dirs.push(dir);
    const sent: Array<{ content: string }> = [];
    internals.instanceIpcClients.delete("alpha");

    // "first" arrives during the outage and starts waiting.
    const first = internals.sendWhenConnected("alpha", { content: "first" });
    await new Promise(r => setTimeout(r, 20));
    // "second" arrives while "first" is still queued.
    const second = internals.sendWhenConnected("alpha", { content: "second" });

    internals.instanceIpcClients.set("alpha", fakeClient(sent as unknown[]) as never);
    await Promise.all([first, second]);

    // Without joining the queue, "second" would find a live socket and overtake.
    expect(sent.map(m => m.content)).toEqual(["first", "second"]);
  });

  it("still fails, loudly, when the instance never comes back", async () => {
    vi.useFakeTimers();
    const { internals, dir } = makeFleet(); dirs.push(dir);
    internals.instanceIpcClients.delete("alpha");

    const delivery = internals.sendWhenConnected("alpha", { content: "hi" });
    const assertion = expect(delivery).rejects.toThrow(/IPC is unavailable/);
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
    vi.useRealTimers();
  });

  it("does not let one failed delivery wedge the next one", async () => {
    vi.useFakeTimers();
    const { internals, dir } = makeFleet(); dirs.push(dir);
    const sent: unknown[] = [];
    internals.instanceIpcClients.delete("alpha");

    const doomed = internals.sendWhenConnected("alpha", { content: "doomed" });
    const doomedAssertion = expect(doomed).rejects.toThrow(/IPC is unavailable/);
    await vi.advanceTimersByTimeAsync(31_000);
    await doomedAssertion;

    vi.useRealTimers();
    internals.instanceIpcClients.set("alpha", fakeClient(sent));
    await internals.sendWhenConnected("alpha", { content: "next" });
    expect(sent).toEqual([{ content: "next" }]);
  });
});
