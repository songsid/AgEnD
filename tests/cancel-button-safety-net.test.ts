import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * Safety nets for the four "could a cancel button live forever?" paths from the
 * lifecycle analysis: a hard-killed daemon leaving a stale "working" cache, a
 * fleet restart orphaning the in-memory button map, a dead reporting chain, and
 * the final 24h ceiling.
 */

type Internals = {
  getInstanceIdle(name: string): boolean;
  getInstanceStatus(name: string): string;
  stateReportDead(name: string): boolean;
  instanceStateCache: Map<string, { state: string; receivedAt: number }>;
  lifecycle: { isPaused(name: string): boolean };
  cancelButtons: Map<string, Record<string, unknown>>;
  persistCancelButtons(): void;
  sweepOrphanedCancelButtons(): Promise<void>;
  worlds: Map<string, unknown>;
  adapter: unknown;
  dataDir: string;
};

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeFleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-btn-net-"));
  dirs.push(dir);
  const fm = new FleetManager(dir);
  const internals = fm as unknown as Internals;
  internals.lifecycle.isPaused = () => false;
  return { fm, internals, dir };
}

describe("net 1 — a daemon that is not running cannot hold a button", () => {
  it("treats a stale 'working' cache as idle once the daemon is gone", () => {
    const { internals } = makeFleet();
    // The SIGKILL scenario: the daemon died without an IPC crash report, so the
    // cache still says working — but there is no daemon.pid, so status is
    // "stopped". Before this net, the cache won and the button lived forever.
    internals.instanceStateCache.set("alpha", { state: "working", receivedAt: Date.now() });
    internals.getInstanceStatus = () => "stopped";
    expect(internals.getInstanceIdle("alpha")).toBe(true);

    // The same cache with a live daemon keeps the button, as before.
    internals.getInstanceStatus = () => "running";
    expect(internals.getInstanceIdle("alpha")).toBe(false);
  });
});

describe("net 3 — a reporting chain that went quiet loses its claim", () => {
  it("is not dead while updates keep arriving, dead after 30 minutes of silence", () => {
    const { internals } = makeFleet();
    internals.instanceStateCache.set("alpha", { state: "working", receivedAt: Date.now() - 29 * 60_000 });
    expect(internals.stateReportDead("alpha")).toBe(false);

    internals.instanceStateCache.set("alpha", { state: "working", receivedAt: Date.now() - 31 * 60_000 });
    expect(internals.stateReportDead("alpha")).toBe(true);
  });

  it("makes no claim when there is no cache entry at all", () => {
    const { internals } = makeFleet();
    // Nothing to distrust — getInstanceIdle's fallback owns that case.
    expect(internals.stateReportDead("alpha")).toBe(false);
  });

  it("measures the cache's age, not the button's", () => {
    const { internals } = makeFleet();
    // A healthy 3-hour run answers the backstop's query every 5 minutes, so its
    // receivedAt is always fresh — the run's length must never trip the check.
    internals.instanceStateCache.set("alpha", { state: "working", receivedAt: Date.now() - 10_000 });
    expect(internals.stateReportDead("alpha")).toBe(false);
  });
});

describe("net 2 — ledger persistence and the startup sweep", () => {
  it("mirrors live buttons to disk and clears them on discard", () => {
    const { internals, dir } = makeFleet();
    internals.cancelButtons.set("m1", {
      instanceName: "alpha", chatId: "c1", messageId: "m1", threadId: "t1", adapterId: "discord",
    });
    internals.persistCancelButtons();

    const ledger = JSON.parse(readFileSync(join(dir, "cancel-buttons.json"), "utf-8"));
    expect(ledger).toEqual([
      { instanceName: "alpha", adapterId: "discord", chatId: "c1", messageId: "m1", threadId: "t1" },
    ]);

    internals.cancelButtons.clear();
    internals.persistCancelButtons();
    expect(JSON.parse(readFileSync(join(dir, "cancel-buttons.json"), "utf-8"))).toEqual([]);
  });

  it("deletes the previous run's buttons at startup", async () => {
    const { internals, dir } = makeFleet();
    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    internals.worlds.set("discord", { adapter: { deleteMessage } });
    internals.adapter = { deleteMessage };
    writeFileSync(join(dir, "cancel-buttons.json"), JSON.stringify([
      { instanceName: "alpha", adapterId: "discord", chatId: "c1", messageId: "m1", threadId: "t1" },
      { instanceName: "beta", chatId: "c2", messageId: "m2" },
    ]));

    await internals.sweepOrphanedCancelButtons();

    expect(deleteMessage).toHaveBeenCalledWith("c1", "m1", "t1");
    expect(deleteMessage).toHaveBeenCalledWith("c2", "m2", undefined);
    // The new process now owns an empty ledger.
    expect(JSON.parse(readFileSync(join(dir, "cancel-buttons.json"), "utf-8"))).toEqual([]);
  });

  it("survives a delete failure and a corrupt ledger", async () => {
    const { internals, dir } = makeFleet();
    const deleteMessage = vi.fn().mockRejectedValue(new Error("message too old"));
    internals.adapter = { deleteMessage };
    writeFileSync(join(dir, "cancel-buttons.json"), JSON.stringify([
      { instanceName: "alpha", chatId: "c1", messageId: "m1" },
    ]));
    await expect(internals.sweepOrphanedCancelButtons()).resolves.toBeUndefined();

    writeFileSync(join(dir, "cancel-buttons.json"), "{not json");
    await expect(internals.sweepOrphanedCancelButtons()).resolves.toBeUndefined();
    // A corrupt ledger is dropped rather than reparsed forever.
    expect(existsSync(join(dir, "cancel-buttons.json"))).toBe(false);
  });

  it("is a no-op when there is no ledger", async () => {
    const { internals } = makeFleet();
    await expect(internals.sweepOrphanedCancelButtons()).resolves.toBeUndefined();
  });
});
