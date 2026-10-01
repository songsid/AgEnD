/** Phase 2c: the TargetQueueWorker loop against fake dependencies. */
import { describe, expect, it, vi } from "vitest";
import { TargetQueueWorker, type TargetQueueWorkerDeps } from "../src/target-queue-worker.js";

function setup(over: Partial<TargetQueueWorkerDeps> = {}, rows = 2) {
  let queue = rows;
  let budget = 0;
  const claims: string[] = [];
  let releases = 0;
  const deps: TargetQueueWorkerDeps = {
    owns: () => true,
    wanted: () => true,
    available: () => true,
    blocked: () => false,
    daemonBootId: () => "boot-1",
    claim: (boot: string) => { if (queue <= 0) return undefined; queue--; claims.push(boot); return { deliveryId: `d${claims.length}` } as any; },
    tryAcquireBudget: () => { budget++; return true; },
    releaseBudget: () => { budget--; releases++; },
    dispatch: async () => {},
    kickCoordinator: vi.fn(),
    logger: { warn: vi.fn() },
    ...over,
  };
  return { worker: new TargetQueueWorker("t", deps), deps, claims, releases: () => releases, budget: () => budget };
}

describe("TargetQueueWorker", () => {
  it("drains its lane one row at a time and returns the budget for each", async () => {
    let concurrent = 0, max = 0;
    const { worker, claims, budget } = setup({ dispatch: async () => { concurrent++; max = Math.max(max, concurrent); await new Promise(r => setTimeout(r, 2)); concurrent--; } }, 3);
    await worker.drain();
    expect(claims).toHaveLength(3);
    expect(max).toBe(1);
    expect(budget()).toBe(0);
  });

  it("re-entrant drains join the running loop (no second claimer)", async () => {
    let concurrent = 0, max = 0;
    const { worker, claims } = setup({ dispatch: async () => { concurrent++; max = Math.max(max, concurrent); await new Promise(r => setTimeout(r, 2)); concurrent--; } }, 3);
    await Promise.all([worker.drain(), worker.drain(), worker.drain()]);
    expect(claims).toHaveLength(3);
    expect(max).toBe(1);
  });

  it("blocked or without a daemon generation: no claim, the coordinator is asked to look", async () => {
    const blocked = setup({ blocked: () => true });
    await blocked.worker.drain();
    expect(blocked.claims).toEqual([]);
    expect(blocked.deps.kickCoordinator).toHaveBeenCalled();
    const noBoot = setup({ daemonBootId: () => null });
    await noBoot.worker.drain();
    expect(noBoot.claims).toEqual([]);
  });

  it("no budget, no ownership or no outbox: nothing is claimed", async () => {
    for (const over of [{ tryAcquireBudget: () => false }, { owns: () => false }, { available: () => false }, { wanted: () => false }]) {
      const s = setup(over);
      await s.worker.drain();
      expect(s.claims).toEqual([]);
    }
  });

  it("nothing to claim: the budget taken for the attempt is returned", async () => {
    const s = setup({}, 0);
    await s.worker.drain();
    expect(s.budget()).toBe(0);
  });

  it("claims carry the daemon's bootId read in the same step", async () => {
    const s = setup({ daemonBootId: () => "boot-7" }, 1);
    await s.worker.drain();
    expect(s.claims).toEqual(["boot-7"]);
  });

  it("a dispatch that throws is logged and the loop ends (rows stay in the outbox)", async () => {
    const s = setup({ dispatch: async () => { throw new Error("boom"); } }, 2);
    await s.worker.drain();
    expect(s.deps.logger.warn).toHaveBeenCalled();
    expect(s.budget()).toBe(0);
    expect(s.worker.inFlight).toBe(false);
  });
});


describe("TargetQueueWorker review fixes (#1079)", () => {
  it("no longer wanted (flag switched back): finishes the claimed row, claims no further one", async () => {
    let wanted = true;
    const s = setup({ wanted: () => wanted, dispatch: async () => { wanted = false; } }, 3);
    await s.worker.drain();
    expect(s.claims).toHaveLength(1);
  });

  it("every acquired budget is returned exactly once (claimed or not)", async () => {
    const s = setup({}, 2);
    await s.worker.drain();
    expect(s.releases()).toBe(3); // two rows + the final empty claim
    expect(s.budget()).toBe(0);
  });

  it("a claim that throws (e.g. SQLITE_BUSY) returns the budget exactly once", async () => {
    const s = setup({ claim: () => { throw new Error("SQLITE_BUSY: database is locked"); } });
    await s.worker.drain();
    expect(s.budget()).toBe(0);
    expect(s.releases()).toBe(1);
    expect(s.deps.logger.warn).toHaveBeenCalled();
  });
});
