/**
 * alpha.2 polish (#3004; leader xmsg-1793760134143): applying an agent's Windows request for a PAIRED machine whose CLI
 * inventory has not arrived yet (just paired — the runner's own report not in) first asks that runner for it, then runs
 * the creation, so its validation sees what is installed there: never a refusal only a manual Refresh would undo.
 * FleetManager.proposeAgentWindowsChange with the real settings store; the runtime coordinator is a stand-in (its probe
 * over a real WebSocket is runtime-coordinator.test.ts's). Checked:
 *  - no inventory: one probe, BEFORE the creation runs (the creation sees the inventory), then applied;
 *  - an inventory already there: no probe;
 *  - a probe that fails: the creation still runs (its own validation says what is missing), never a crash of the store;
 *  - a machine gone offline: no probe (the fence refuses it), never applied;
 *  - a create for this PC (no machine): no probe.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";

const dirs: string[] = [];
const ENV = ["AGEND_REMOTE_RUNTIME", "AGEND_WINDOWS_CLI"] as const;
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
});
const MACHINE = "6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const INVENTORY = { home: "C:\\Users\\pc", probedAt: 1_793_000_000_000, clis: [{ id: "codex", runnable: true, supports: { resume: true }, readOnlySupport: true, models: [] }] };

function rig(machine: { status: string; inventory?: unknown } | null, probe: () => Promise<unknown>) {
  process.env.AGEND_REMOTE_RUNTIME = "1"; process.env.AGEND_WINDOWS_CLI = "1";
  setLocale("en");
  const dir = mkdtempSync(join(tmpdir(), "agend-backstop-")); dirs.push(dir);
  const fm = new FleetManager(dir), any = fm as any;
  const sink = () => {};
  fm.logger = { info: sink, warn: sink, error: sink, debug: sink, trace: sink, fatal: sink, child: () => fm.logger } as unknown as typeof fm.logger;
  fm.fleetConfig = { defaults: {}, instances: {} } as never;
  const order: string[] = [];
  const call = vi.fn(async (_id: string, op: string) => { order.push(`probe:${op}`); const r = await probe(); if (machine) machine.inventory = r; return r; });
  any.runtimeCoordinator = () => ({ machine: (id: string) => (id === MACHINE ? machine : undefined), call });
  const create = vi.fn(async (allowed: () => boolean, execution: any) => {
    order.push(`create:inventory=${!!machine?.inventory}:allowed=${allowed()}`);
    if (!allowed()) throw new Error("Authorization expired");                         // as FleetWindowsRuntime.create's persist
    return execution.commit(() => ({ name: "windows-abc" }));
  });
  /** `null`: a create for this PC (no machine named). */
  const propose = (machine: string | null = MACHINE) => any.proposeAgentWindowsChange({ requester: "planner", key: `k${Math.random()}`, fingerprint: `f${Math.random()}`,
    summary: ["Create agent"], machineId: machine ?? undefined, bytes: 1, authority: { connections: [], primaryGeneral: true, unknown: false }, apply: create });
  const decide = (id: string) => any.settingsGate().store.decide(id, "confirm", { label: "owner", current: () => true, via: "web" });
  return { fm, any, call, create, order, propose, decide, machine };
}

describe("alpha.2 polish: a paired machine with no CLI inventory is asked for it before the creation", () => {
  it("no inventory yet: one probe, before the creation — which then sees the inventory; applied", async () => {
    const r = rig({ status: "online" }, async () => INVENTORY);
    const view = await r.propose();
    const done = await r.decide(view.id);
    expect(done.state).toBe("applied");
    expect(r.call.mock.calls).toEqual([[MACHINE, "probe", { force: true }]]);   // forced: the cached answer would be the placeholder
    expect(r.order).toEqual(["probe:probe", "create:inventory=true:allowed=true"]);
  });
  it("#3004 rig: the placeholder a just-paired runner reports ({clis: [], home: \"\", probedAt: null}) counts as none: probed first", async () => {
    const r = rig({ status: "online", inventory: { clis: [], home: "", probedAt: null } }, async () => INVENTORY);
    const done = await r.decide((await r.propose()).id);
    expect([done.state, r.call.mock.calls.length]).toEqual(["applied", 1]);
    expect(r.order).toEqual(["probe:probe", "create:inventory=true:allowed=true"]);
  });
  it("an inventory already there: no probe", async () => {
    const r = rig({ status: "online", inventory: INVENTORY }, async () => INVENTORY);
    const done = await r.decide((await r.propose()).id);
    expect([done.state, r.call.mock.calls.length]).toEqual(["applied", 0]);
  });
  it("a probe that fails: the creation still runs once (its own validation says what is missing); the store settles", async () => {
    const r = rig({ status: "online" }, async () => { throw new Error("runner busy"); });
    const done = await r.decide((await r.propose()).id);
    expect(r.call).toHaveBeenCalledTimes(1);
    expect(r.order).toEqual(["probe:probe", "create:inventory=false:allowed=true"]);
    expect(done.state).toBe("applied");                                              // this stand-in creation does not validate
  });
  it("a machine gone offline: no probe, and the fence refuses the creation", async () => {
    const machine = { status: "online" as string };
    const r = rig(machine, async () => INVENTORY);
    const view = await r.propose();
    machine.status = "offline";
    const done = await r.decide(view.id);
    expect(r.call).not.toHaveBeenCalled();
    expect(r.order.every(o => !o.startsWith("create:") || o.endsWith("allowed=false"))).toBe(true);
    expect(done.state).not.toBe("applied");
  });
  it("a create for this PC (no machine named): no probe", async () => {
    const r = rig(null, async () => INVENTORY);
    const done = await r.decide((await r.propose(null)).id);
    expect([done.state, r.call.mock.calls.length]).toEqual(["applied", 0]);
  });
});
