import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INSTANCE_CONFIG } from "../src/config.js";
import { GeneralBindings, generalBindingRevision, parseGeneralSwitchInput, switchGeneralLocation, type GeneralLocation, type GeneralWindowsBinding } from "../src/general-binding.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import { SettingsRouteLifetime } from "../src/settings-route-lifetime.js";
import type { InstanceConfig } from "../src/types.js";
import { WindowsAgents } from "../src/windows-agents.js";
import { registerWindowsProfiles } from "../src/native-instance-registry.js";

const dirs: string[] = [], executions: SettingsExecution[] = [];
afterEach(() => { for (const e of executions.splice(0)) e.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig() {
  const home = mkdtempSync(join(tmpdir(), "agend-general-binding-")); dirs.push(home);
  const store = new GeneralBindings(home), name = "general", machineId = randomUUID(), id = randomUUID(), agentId = randomUUID();
  const original: InstanceConfig = { ...structuredClone(DEFAULT_INSTANCE_CONFIG), general_topic: true, working_directory: join(home, "host"), backend: "claude-code", topic_id: 1, channel_id: "telegram" };
  let current = original, allowed = true;
  const windows: GeneralWindowsBinding = { id, agentId, machineId, cli: "claude-code", config: {
    ...original, runtime: "windows", native_adapter: "pane", native_general_binding: id, native_agent_id: agentId,
    machine_id: machineId, native_sandbox: "workspace-write", backend: "claude-code", model: "haiku", working_directory: "C:\\fixture\\general",
  } };
  const target: GeneralLocation = { location: "windows", machineId, cli: "claude-code", model: "haiku" };
  const deps = { store, current: () => current, assert: () => { if (!allowed) throw Error("revoked"); },
    prepare: vi.fn(async () => windows), idle: vi.fn(async () => true), stop: vi.fn(async () => ({ backend: "claude-code", sessionId: randomUUID() })),
    save: vi.fn((cfg: InstanceConfig) => { current = cfg; }), start: vi.fn(async () => {}), notify: vi.fn(),
  };
  const execution = () => { const e = new SettingsExecution({ current: () => allowed, snapshot: () => current }); executions.push(e); return e; };
  const request = (t: GeneralLocation = target) => ({ name, revision: generalBindingRevision(store.read(name), current), target: t });
  return { home, store, name, original, windows, target, deps, execution, request, current: () => current, revoke: () => { allowed = false; } };
}
describe("General's durable location binding", () => {
  it("closes the old owner before saving or starting, keeps its exact pin and uses the same route", async () => {
    const r = rig(), events: string[] = [], pin = randomUUID();
    const save = r.deps.save.getMockImplementation()!;
    r.deps.stop.mockImplementation(async () => { events.push("stop"); expect(r.current()).toEqual(r.original); return { backend: "claude-code", sessionId: pin }; });
    r.deps.save.mockImplementation(cfg => { events.push("save"); save(cfg); });
    r.deps.start.mockImplementation(async () => { events.push("start"); r.store.assertStart(r.name, r.current()); });
    expect(await switchGeneralLocation(r.deps, r.request(), r.execution())).toEqual({ started: true });
    expect(events).toEqual(["stop", "save", "start"]);
    const record = r.store.read(r.name)!;
    expect(record.host.pin).toEqual({ backend: "claude-code", sessionId: pin });
    expect(record.host.config.working_directory).toBe(r.original.working_directory);
    expect(record.active).toBe(r.windows.id); expect(record.pending).toBeUndefined();
    expect(r.current()).toMatchObject({ general_topic: true, channel_id: "telegram", topic_id: 1, native_agent_id: r.windows.agentId });
    const file = join(r.home, "general-bindings", readdirSync(join(r.home, "general-bindings"))[0]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("unknown exit retains the old config, blocks automatic start and starts no replacement", async () => {
    const r = rig(); r.deps.stop.mockRejectedValueOnce(Error("old owner unconfirmed"));
    await expect(switchGeneralLocation(r.deps, r.request(), r.execution())).rejects.toThrow("old owner unconfirmed");
    expect(r.deps.save).not.toHaveBeenCalled(); expect(r.deps.start).not.toHaveBeenCalled();
    expect(r.store.read(r.name)).toMatchObject({ active: "host", hold: "exit", pending: { phase: "prepared" } });
    expect(() => new GeneralBindings(r.home).assertStart(r.name, r.current())).toThrow("confirmed old process exit");
    expect(r.deps.notify).toHaveBeenCalledWith("exit", expect.any(Error));
  });
  it("a fresh confirmed retry reuses an interrupted stop intent, without republishing or a new binding", async () => {
    const r = rig(); r.deps.stop.mockRejectedValueOnce(Error("unconfirmed"));
    await expect(switchGeneralLocation(r.deps, r.request(), r.execution())).rejects.toThrow("unconfirmed");
    const intent = r.store.read(r.name)!.pending!.id;
    await switchGeneralLocation(r.deps, r.request(), r.execution());
    expect(r.deps.prepare).toHaveBeenCalledTimes(1); expect(r.deps.stop).toHaveBeenCalledTimes(2);
    expect(r.deps.start).toHaveBeenCalledTimes(1); expect(r.store.read(r.name)!.windows).toHaveLength(1);
    expect(intent).toMatch(/^[0-9a-f-]{36}$/);
  });
  it.each([false, true])("recovers a selected receipt after config save interruption (written=%s), without a second stop", async written => {
    const r = rig(), save = r.deps.save.getMockImplementation()!;
    r.deps.save.mockImplementationOnce(cfg => { if (written) save(cfg); throw Error("crash at config boundary"); });
    await expect(switchGeneralLocation(r.deps, r.request(), r.execution())).rejects.toThrow("crash at config boundary");
    expect(r.store.read(r.name)).toMatchObject({ active: r.windows.id, pending: { phase: "selected" } });
    expect(r.deps.start).not.toHaveBeenCalled();
    await switchGeneralLocation(r.deps, r.request(), r.execution());
    expect(r.deps.stop).toHaveBeenCalledTimes(1); expect(r.deps.prepare).toHaveBeenCalledTimes(1);
    expect(r.deps.start).toHaveBeenCalledTimes(1); expect(r.store.read(r.name)!.pending).toBeUndefined();
  });
  it("a failed selected start is visible and retries the same location without restarting the old owner", async () => {
    const r = rig(); r.deps.start.mockRejectedValueOnce(Error("changed AGENTS.md"));
    expect(await switchGeneralLocation(r.deps, r.request(), r.execution())).toEqual({ started: false });
    expect(r.store.read(r.name)).toMatchObject({ active: r.windows.id, hold: "start", pending: { phase: "selected" } });
    expect(r.deps.notify).toHaveBeenCalledWith("start", expect.any(Error));
    await switchGeneralLocation(r.deps, r.request(), r.execution());
    expect(r.deps.stop).toHaveBeenCalledTimes(1); expect(r.deps.prepare).toHaveBeenCalledTimes(1);
    expect(r.deps.start).toHaveBeenCalledTimes(2); expect(r.store.read(r.name)!.hold).toBeUndefined();
  });
  it("switch-back positively closes Windows, restores host config and retains the Windows binding", async () => {
    const r = rig(); await switchGeneralLocation(r.deps, r.request(), r.execution());
    await switchGeneralLocation(r.deps, r.request({ location: "host" }), r.execution());
    expect(r.current()).toEqual(r.original); expect(r.deps.stop).toHaveBeenCalledTimes(2);
    expect(r.store.read(r.name)).toMatchObject({ active: "host", windows: [{ agentId: r.windows.agentId }] });
  });
  it("refuses an old-tab revision before publication or stop", async () => {
    const r = rig(), old = r.request(); await switchGeneralLocation(r.deps, old, r.execution());
    await expect(switchGeneralLocation(r.deps, old, r.execution())).rejects.toThrow("location changed");
    expect(r.deps.prepare).toHaveBeenCalledTimes(1); expect(r.deps.stop).toHaveBeenCalledTimes(1);
  });
  it.each(["prepare", "idle", "stop"] as const)("revocation during %s starts and saves nothing", async boundary => {
    const r = rig();
    if (boundary === "prepare") r.deps.prepare.mockImplementation(async () => { r.revoke(); return r.windows; });
    if (boundary === "idle") r.deps.idle.mockImplementation(async () => { r.revoke(); return true; });
    if (boundary === "stop") r.deps.stop.mockImplementation(async () => { r.revoke(); return undefined as never; });
    await expect(switchGeneralLocation(r.deps, r.request(), r.execution())).rejects.toThrow();
    expect(r.deps.save).not.toHaveBeenCalled(); expect(r.deps.start).not.toHaveBeenCalled();
  });
  it("refuses a corrupt receipt instead of silently reverting to an untracked host binding", async () => {
    const r = rig(); await switchGeneralLocation(r.deps, r.request(), r.execution());
    const path = join(r.home, "general-bindings", readdirSync(join(r.home, "general-bindings"))[0]);
    const value = JSON.parse(readFileSync(path, "utf8")); value.record.active = "host"; writeFileSync(path, JSON.stringify(value));
    expect(() => new GeneralBindings(r.home).read(r.name)).toThrow("checksum differs");
  });
  it("ordinary model/hot edits keep their normal start policy, while machine/cwd rebinding remains refused", async () => {
    const r = rig(); await switchGeneralLocation(r.deps, r.request(), r.execution());
    const next = { ...r.current(), model: "sonnet", display_name: "General" };
    r.store.assertStart(r.name, next);
    expect(r.store.read(r.name)!.windows[0].config.model).toBe("sonnet");
    expect(() => r.store.assertStart(r.name, { ...next, machine_id: randomUUID() })).toThrow("binding differs");
    expect(() => r.store.assertStart(r.name, { ...next, working_directory: "C:\\other" })).toThrow("binding differs");
  });
  it("a Windows General profile is linked in the same write and cannot be imported as a second worker", () => {
    const r = rig(), start = vi.fn(() => { throw Error("no process may launch"); });
    const agents = new WindowsAgents(r.home, { get: () => null, start } as never);
    const input = { id: r.windows.agentId, instance: r.name, machineId: r.windows.machineId, cli: r.windows.cli,
      cwd: r.windows.config.working_directory, name: "General", model: "haiku", instructions: "", description: "" };
    const row = agents.ensureGeneralBinding(input, () => true);
    expect(row.fleet_instance).toBe("general");
    const fleet = { instances: { general: r.original } } as never;
    expect(registerWindowsProfiles(fleet, agents, () => { throw Error("must not import"); })).toBe(false);
    expect(agents.ensureGeneralBinding(input, () => true).id).toBe(row.id);
    expect(agents.list()).toHaveLength(1); expect(start).not.toHaveBeenCalled();
    expect(() => agents.ensureGeneralBinding({ ...input, machineId: randomUUID() }, () => true)).toThrow("profile differs");
  });
  it("parses a closed primitive request, refusing arrays, unknown fields and account/path inputs", () => {
    const r = rig(); expect(parseGeneralSwitchInput(r.request())).toEqual(r.request());
    for (const bad of [{ ...r.request(), revision: [r.request().revision] }, { ...r.request(), path: "C:\\account" },
      { ...r.request(), target: { ...r.target, cwd: "C:\\account" } }, { ...r.request(), target: { ...r.target, machineId: [r.windows.machineId] } }]) {
      expect(() => parseGeneralSwitchInput(bad)).toThrow();
    }
  });
});

describe("one confirmation's operation-owned stop", () => {
  it("advances only its own card across exactly one synchronous stop; another card stays stale", async () => {
    let epoch = 7, stopping = false; const route = new SettingsRouteLifetime("general", () => true, () => epoch, () => stopping);
    const other = new SettingsRouteLifetime("general", () => true, () => epoch, () => stopping);
    await route.followStop("general", async () => { epoch++; stopping = true; await Promise.resolve(); expect(route.current()).toBe(true); expect(other.current()).toBe(false); stopping = false; });
    expect(route.current()).toBe(true); expect(other.current()).toBe(false);
    await expect(route.followStop("general", async () => { epoch++; })).rejects.toThrow("expired");
  });
  it("a second stop, route rebind or admin-route loss during the await always revokes the first", async () => {
    let checked = 0;
    for (const change of ["epoch", "route"] as const) {
      let epoch = 1, same = true; const route = new SettingsRouteLifetime("general", () => same, () => epoch, () => false);
      await expect(route.followStop("general", async () => { epoch++; await Promise.resolve(); if (change === "epoch") epoch++; else same = false; })).rejects.toThrow("superseded"); checked++;
    }
    expect(checked).toBe(2);
  });
  it("a missing or deferred invalidation is never adopted", async () => {
    const route = new SettingsRouteLifetime("general", () => true, () => 1, () => false);
    await expect(route.followStop("general", async () => {})).rejects.toThrow("superseded");
  });
});

it("a selected interrupted start settles only after its exact target is published", async () => {
  const r = rig(); r.deps.start.mockRejectedValueOnce(Error("restart"));
  await switchGeneralLocation(r.deps, r.request(), r.execution());
  expect(r.store.completeSelected(r.name, r.original)).toBe(false); expect(r.store.read(r.name)!.pending).toBeDefined();
  expect(r.store.completeSelected(r.name, r.current())).toBe(true); expect(r.store.read(r.name)!.pending).toBeUndefined();
  expect(r.store.completeSelected(r.name, r.current())).toBe(false);
});

it("a selected config-save gap can switch back while the selected PC is offline, but still closes that binding positively", async () => {
  const r = rig(); r.deps.save.mockImplementationOnce(() => { throw Error("save gap"); });
  await expect(switchGeneralLocation(r.deps, r.request(), r.execution())).rejects.toThrow("save gap");
  expect(r.current()).toBe(r.original); expect(r.store.read(r.name)!.active).toBe(r.windows.id);
  r.deps.prepare.mockRejectedValue(Error("PC is offline; must not publish"));
  await switchGeneralLocation(r.deps, r.request({ location: "host" }), r.execution());
  expect(r.current()).toEqual(r.original); expect(r.deps.stop).toHaveBeenCalledTimes(2); expect(r.deps.start).toHaveBeenCalledTimes(1);
  expect(r.store.read(r.name)!.active).toBe("host");
});
it("a same-binding model request is refused before changing its profile", async () => {
  const r = rig(); await switchGeneralLocation(r.deps, r.request(), r.execution()); const calls = r.deps.prepare.mock.calls.length;
  await expect(switchGeneralLocation(r.deps, r.request({ ...r.target, location: "windows", machineId: r.windows.machineId, cli: "claude-code", model: "different" }), r.execution())).rejects.toThrow("already runs");
  expect(r.deps.prepare).toHaveBeenCalledTimes(calls); expect(r.current().model).toBe("haiku");
});
