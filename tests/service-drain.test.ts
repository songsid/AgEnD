/** Inert process/listener adapters and an injected clock: never a real service or PID. */
import { describe, expect, it, vi } from "vitest";
import { waitForServiceDrain, captureServiceProcess, type ServiceDrainDeps, type ServiceProcessState } from "../src/service-drain.js";
import { FLEET_STOP_TIMEOUT_MS } from "../src/fleet-stop-budget.js";

function rig() {
  let clock = 0, valid = true, process = true, listeners = true;
  const events: string[] = [];
  const deps: ServiceDrainDeps = {
    current: () => valid,
    processStopped: vi.fn(() => { events.push("process"); return process; }),
    listenersClosed: vi.fn(async () => { events.push("listeners"); return listeners; }),
    now: () => clock,
    sleep: vi.fn(async ms => { events.push("wait"); expect(ms, "startup polling must advance time").toBeGreaterThan(0);
      clock += ms; expect(clock, "startup polling must stay bounded").toBeLessThanOrEqual(FLEET_STOP_TIMEOUT_MS); }),
  };
  return { deps, events, time: () => clock, valid: (x: boolean) => { valid = x; },
    process: (x: boolean) => { process = x; }, listeners: (x: boolean) => { listeners = x; } };
}
describe("replacement waits for positive old-service closure", () => {
  it("returns only after the old process and listeners close, without querying sockets early", async () => {
    const r = rig(); r.process(false); r.listeners(false);
    r.deps.sleep = async ms => {
      expect(ms).toBeGreaterThan(0); expect(ms).toBeLessThanOrEqual(250);
      if (!r.events.includes("process-closed")) { r.events.push("process-closed"); r.process(true); }
      else { r.events.push("listeners-closed"); r.listeners(true); }
    };
    await waitForServiceDrain(r.deps);
    expect(r.events).toEqual(["process", "process-closed", "process", "listeners", "listeners-closed", "process", "listeners"]);
  });
  it.each(["process", "listeners"] as const)("withholds admission when %s never confirms closure, without raising the existing stop budget", async gate => {
    const r = rig(); r[gate](false);
    await expect(waitForServiceDrain(r.deps)).rejects.toThrow("did not close");
    expect(r.time()).toBe(FLEET_STOP_TIMEOUT_MS);
  });
  it("refuses changed settings before any process or listener inspection", async () => {
    const r = rig(); r.valid(false);
    await expect(waitForServiceDrain(r.deps)).rejects.toThrow("settings changed");
    expect(r.deps.processStopped).not.toHaveBeenCalled(); expect(r.deps.listenersClosed).not.toHaveBeenCalled();
  });
  it("rechecks settings after an asynchronous listener check and before admitting startup", async () => {
    const r = rig(); r.deps.listenersClosed = async () => { r.valid(false); return true; };
    await expect(waitForServiceDrain(r.deps)).rejects.toThrow("settings changed");
  });
  it("an unreadable listener check is no proof of absence", async () => {
    const r = rig(); r.deps.listenersClosed = async () => { throw Error("unknown evidence"); };
    await expect(waitForServiceDrain(r.deps)).rejects.toThrow("unknown evidence");
  });
});
describe("old process identity is only observed", () => {
  it("ignores a stale PID reused by a younger process, without waiting for or signalling it", () => {
    const read = vi.fn(() => ({ birth: "younger", startedAtMs: 2000 }));
    expect(captureServiceProcess(40, read, 1000)()).toBe(true); expect(read).toHaveBeenCalledOnce();
    expect(captureServiceProcess(40, read, 2000)()).toBe(false);
    expect(captureServiceProcess(40, read, 3000)()).toBe(false);
  });
  it("never waits for this replacement's own PID or inspects it as the old fleet", () => {
    const read = vi.fn(() => "unknown" as const);
    let stopped: (() => boolean) | undefined;
    expect(() => { stopped = captureServiceProcess(process.pid, read, Date.now()); }).not.toThrow();
    expect(stopped!()).toBe(true); expect(read).not.toHaveBeenCalled();
  });
  it("waits while the same birth remains and accepts a gone process or reused PID", () => {
    let state: ServiceProcessState = { birth: "first" };
    const read = vi.fn(() => state), stopped = captureServiceProcess(40, read);
    expect(stopped()).toBe(false); state = "unknown"; expect(stopped()).toBe(false);
    state = { birth: "second" }; expect(stopped()).toBe(true); state = "gone"; expect(stopped()).toBe(true);
    expect(read).toHaveBeenCalledWith(40);
  });
  it("requires readable identity but needs no PID operation when no previous PID was recorded", () => {
    const read = vi.fn(() => "unknown" as const);
    expect(captureServiceProcess(null, read)()).toBe(true); expect(read).not.toHaveBeenCalled();
    expect(() => captureServiceProcess(40, read)).toThrow("identity is unavailable");
  });
  it("an already gone old PID is settled, regardless of a later unrelated process", () => {
    const read = vi.fn(() => "gone" as const), stopped = captureServiceProcess(40, read);
    expect(stopped()).toBe(true); expect(read).toHaveBeenCalledOnce();
  });
  it.each([0, 1, -1, 1.5, NaN, Infinity])("refuses invalid main PID %s before observation", pid => {
    const read = vi.fn(() => "gone" as const);
    expect(() => captureServiceProcess(pid, read)).toThrow("invalid"); expect(read).not.toHaveBeenCalled();
  });
});
