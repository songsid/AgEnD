/**
 * #1631 part B: `agend install --no-activate` writes nothing for a hand-started fleet only when it is CERTAIN it is
 * the activation refresh of an older updater in flight (2.2.0-beta.1 and before refresh a detached fleet's service and
 * would create one). Every doubt keeps the current behaviour: the service file is created.
 */
import { describe, expect, it } from "vitest";
import { startedByUpdater, type UpdaterCallerProbe } from "../src/updater-caller.js";
import { UPDATE_MARKER_MAX_AGE_MS } from "../src/update-marker.js";

const NOW = 1_800_000_000_000;
const SELF = 500, UPDATER = 300;
/** This process 500 → launcher 400 → updater 300 → shell 200 → init 1. */
const TREE: Record<number, number> = { 500: 400, 400: 300, 300: 200, 200: 1 };
const probe = (over: Partial<UpdaterCallerProbe> = {}): UpdaterCallerProbe => ({
  now: () => NOW,
  markerMtimeMs: () => NOW - 60_000,
  marker: () => ({ startedAt: NOW - 90_000, pid: UPDATER }),
  parentOf: pid => TREE[pid] ?? null,
  alive: pid => pid in TREE || pid === SELF,
  startMs: () => NOW - 120_000,
  selfPid: SELF,
  selfVersion: "2.2.0-beta.2",
  ...over,
});

describe("startedByUpdater: certain only when every guard holds", () => {
  it("a fresh marker naming a live ancestor that started before it: the updater's refresh", () => {
    expect(startedByUpdater(probe())).toEqual({ updater: true, pid: UPDATER });
  });

  it("the updater may be the parent, the grandparent or the great-grandparent — no further", () => {
    expect(startedByUpdater(probe({ marker: () => ({ pid: 400 }) })).updater).toBe(true);
    expect(startedByUpdater(probe({ marker: () => ({ pid: 300 }) })).updater).toBe(true);
    expect(startedByUpdater(probe({ marker: () => ({ pid: 200 }) })).updater).toBe(true);
    const deep: Record<number, number> = { 500: 450, 450: 420, 420: 400, 400: 300, 300: 1 };   // 300 = 4 levels up
    expect(startedByUpdater(probe({ parentOf: pid => deep[pid] ?? null, alive: () => true }))).toMatchObject({ updater: false, reason: expect.stringContaining("not an ancestor") });
  });

  it("a marker naming a progress version that is this binary's: still certain; another version: doubt", () => {
    expect(startedByUpdater(probe({ marker: () => ({ pid: UPDATER, progress: { version: "2.2.0-beta.2" } }) })).updater).toBe(true);
    expect(startedByUpdater(probe({ marker: () => ({ pid: UPDATER, progress: { version: "2.2.0-beta.3" } }) }))).toMatchObject({ updater: false, reason: expect.stringContaining("another version") });
  });

  // The manual-install cases: each must keep creating the service.
  const doubts: Array<[string, Partial<UpdaterCallerProbe>, string]> = [
    ["no marker", { markerMtimeMs: () => null }, "no update marker"],
    ["a stale marker (left by a crashed update)", { markerMtimeMs: () => NOW - UPDATE_MARKER_MAX_AGE_MS }, "not fresh"],
    ["a marker from the future", { markerMtimeMs: () => NOW + 5_000 }, "not fresh"],
    ["an unreadable marker", { marker: () => null }, "no updater pid"],
    ["a marker without a pid", { marker: () => ({ startedAt: NOW }) }, "no updater pid"],
    ["a marker naming pid 1", { marker: () => ({ pid: 1 }) }, "no updater pid"],
    ["a dead pid", { alive: pid => pid !== UPDATER }, "not running"],
    ["an unrelated live pid", { marker: () => ({ pid: 999 }), alive: () => true }, "not an ancestor"],
    ["a parent that cannot be read", { parentOf: () => null }, "not an ancestor"],
    ["a reused pid (started after the marker was written)", { startMs: () => NOW - 60_000 + 1_001 }, "reused"],
    ["a pid whose start time cannot be read", { startMs: () => null }, "reused"],
  ];
  it.each(doubts)("%s: not certain → the service is created as always", (_label, over, reason) => {
    expect(startedByUpdater(probe(over))).toEqual({ updater: false, reason: expect.stringContaining(reason) });
  });

  it("ps start-time resolution: a start within the same second as the marker is not a reused pid", () => {
    expect(startedByUpdater(probe({ startMs: () => NOW - 60_000 + 1_000 })).updater).toBe(true);
  });
});
