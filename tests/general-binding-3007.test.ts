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
    expect(r.deps.notify).toHaveBeenCalledWith("exit");
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
    expect(r.deps.notify).toHaveBeenCalledWith("start");
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
