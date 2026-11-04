/**
 * M-2297 (cid-native-slot-leak): `stop_instance` answered "stopped" after a bare daemon.stop(), which DETACHES a native
 * Windows pane (its CLI keeps running unsupervised and keeps a machine slot). It now goes through the fleet's stop, which
 * closes a native pane (kill confirmed → positive exit → slot released) and fails — never "stopped" — when it cannot.
 * And the per-PC limit error names its limit and the agents holding the slots.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { FleetManager } from "../src/fleet-manager.js";
import { MachineSlotLimitError, WindowsAgents } from "../src/windows-agents.js";
import { setConfiguredRuntimeSwitches } from "../src/runtime-switches.js";

const dirs: string[] = [];
afterEach(() => { setConfiguredRuntimeSwitches({}); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-2297-")); dirs.push(d); return d; };

async function callStop(ctx: any, name: string) {
  let result: any, error: any;
  await outboundHandlers.get("stop_instance")!(ctx, { name } as never, (r: unknown, e?: string) => { result = r; error = e; }, {} as never);
  return { result, error };
}

describe("stop_instance goes through the fleet's stop (never a bare detach)", () => {
  it("calls ctx.stopInstance, not daemon.stop(): the lifecycle owns the close", async () => {
    const daemon = { stop: vi.fn(async () => {}) };
    const ctx: any = { lifecycle: { daemons: new Map([["w", daemon]]) }, stopInstance: vi.fn(async () => ({ backgroundWorkEnded: false })) };
    const { result, error } = await callStop(ctx, "w");
    expect(error).toBeUndefined();
    expect(result).toEqual({ success: true, status: "stopped" });
    expect(ctx.stopInstance).toHaveBeenCalledWith("w");
    expect(daemon.stop).not.toHaveBeenCalled();
  });

  it("a close that cannot be confirmed is a failure, never \"stopped\"", async () => {
    const ctx: any = { lifecycle: { daemons: new Map([["w", { stop: vi.fn() }]]) },
      stopInstance: vi.fn(async () => { throw new Error("Native pane exit is unconfirmed; its reservation is retained"); }) };
    const { result, error } = await callStop(ctx, "w");
    expect(result).toBeNull();
    expect(error).toContain("Native pane exit is unconfirmed");
  });

  it("not running: said so, nothing stopped", async () => {
    const ctx: any = { lifecycle: { daemons: new Map() }, stopInstance: vi.fn() };
    const { error } = await callStop(ctx, "w");
    expect(error).toMatch(/not running/);
    expect(ctx.stopInstance).not.toHaveBeenCalled();
  });
});

describe("the fleet's stop closes a native pane", () => {
  function fleet(stop: (opts?: unknown) => Promise<void>) {
    const fm = new FleetManager(tmp());
    const name = "win";
    fm.fleetConfig = { defaults: {}, instances: { [name]: { working_directory: "C:\\w", backend: "codex", native_adapter: "pane", native_agent_id: randomUUID(), machine_id: randomUUID() } } } as any;
    const daemon: any = {
      usesNativePane: () => true, stop: vi.fn(stop), fenceDeliveryWritesForStop: vi.fn(), waitForDeliveryWritesToDrain: vi.fn(async () => true),
      reconcileNativeDeliveries: vi.fn(async () => true), bootId: "b", removeAllListeners: vi.fn(),
    };
    fm.lifecycle.daemons.set(name, daemon);
    return { fm, name, daemon };
  }
  it("stopInstance closes it (nativePane: \"close\"), and the daemon leaves supervision", async () => {
    const { fm, name, daemon } = fleet(async () => {});
    await fm.stopInstance(name);
    expect(daemon.stop).toHaveBeenCalledWith({ nativePane: "close" });
    expect(fm.lifecycle.daemons.has(name)).toBe(false);
  });
  it("a close that fails (exit unconfirmed): the stop fails and the daemon stays supervised", async () => {
    const { fm, name, daemon } = fleet(async () => { throw new Error("Native pane exit is unconfirmed; its reservation is retained"); });
    await expect(fm.stopInstance(name)).rejects.toThrow("Native pane exit is unconfirmed");
    expect(fm.lifecycle.daemons.get(name)).toBe(daemon);
  });
});

describe("the per-PC agent limit names the limit and its holders", () => {
  function store() {
    const dir = tmp();
    const bridge: any = { start: vi.fn((task: any) => ({ ...task, id: task.requestId, status: "working", output: "", startedAt: 1 })), get: () => null, prepareWorkspace: vi.fn() };
    return new WindowsAgents(dir, bridge);
  }
  it("the error carries the limit and every holder by the name a person gave it; healthy panes are not 'unknown'", async () => {
    setConfiguredRuntimeSwitches({ max_agents_per_machine: 2 });
    const s = store(), machine = randomUUID();
    const a = await s.create({ name: "a-profile", cwd: "C:\\a", sandbox: "read-only", machineId: machine });
    const b = await s.create({ name: "b-profile", cwd: "C:\\b", sandbox: "read-only", machineId: machine });
    const c = await s.create({ name: "c-profile", cwd: "C:\\c", sandbox: "read-only", machineId: machine });
    s.bindInstance(a.id, "alpha");
    s.reservePane(a.id, randomUUID()); s.reservePane(b.id, randomUUID());
    let thrown: unknown;
    try { s.reservePane(c.id, randomUUID()); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(MachineSlotLimitError);
    const err = thrown as MachineSlotLimitError;
    expect(err.limit).toBe(2);
    // By the agent's own name, not its windows-<uuid> instance name; reserved panes are not "outcome unknown".
    expect(err.holders).toEqual(expect.arrayContaining([{ name: "a-profile", unknown: false }, { name: "b-profile", unknown: false }]));
    expect(err.holders).toHaveLength(2);
    expect(err.message).toMatch(/^This Windows computer has reached its concurrent agent limit \(2\): /);
  });
  it("an exec holder whose task outcome is unknown (a lost task) is marked as such", async () => {
    setConfiguredRuntimeSwitches({ max_agents_per_machine: 1 });
    const dir = tmp();
    const bridge: any = { start: vi.fn((task: any) => ({ ...task, id: task.requestId, status: "working", output: "", startedAt: 1 })), get: () => null, prepareWorkspace: vi.fn() };
    const s = new WindowsAgents(dir, bridge), machine = randomUUID();
    const a = await s.create({ name: "stuck", cwd: "C:\\a", sandbox: "read-only", machineId: machine });
    const b = await s.create({ name: "next", cwd: "C:\\b", sandbox: "read-only", machineId: machine });
    s.send(a.id, { requestId: randomUUID(), prompt: "exec" }, () => true);   // an exec turn whose task the runtime lost
    expect(s.get(a.id).blocked).toBe(true);
    let thrown: any;
    try { s.reservePane(b.id, randomUUID()); } catch (e) { thrown = e; }
    expect(thrown.holders).toEqual([{ name: "stuck", unknown: true }]);
    expect(thrown.message).toContain("stuck (outcome unknown");
  });
});
