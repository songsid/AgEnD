/**
 * #2942: a Windows agent an AGENT asks for (create_instance / update_instance_config with runtime "windows") is never
 * created or written by the call. It becomes a pending settings change whose General card a fleet admin confirms; the
 * confirmed apply runs the same creation and patch code the web uses, with the admin, the Windows switch and the target
 * machine asked again. Real FleetManager, real settings store and card path, real FleetWindowsRuntime; the adapters and
 * the Windows CLI bridge are fakes.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { FleetWindowsRuntime } from "../src/fleet-windows-runtime.js";
import { WindowsAgents } from "../src/windows-agents.js";
import type { WindowsCliExecutor } from "../src/windows-cli.js";
import { WINDOWS_CONFIG_REFUSED, WINDOWS_CREATE_REFUSED } from "../src/native-instance-registry.js";
import { settingsDisplay } from "../src/settings-change.js";
import { CreateInstanceArgs, CreateInstanceToolArgs } from "../src/outbound-schemas.js";
import { SETTINGS_CONFIRMATION_TTL_MS, type SettingsConfirmationStore } from "../src/settings-confirmation.js";

const fixtures: Array<{ dir: string; fm: FleetManager; any: any }> = [];
const META = { instanceName: "dev", requestId: undefined, fleetRequestId: undefined, senderSessionName: undefined } as const;
const SESSION = "agent:dev";
const DIRECTORY = "C:\\Work\\Repo";
const CREATE = { runtime: "windows", topic_name: "Repo", directory: DIRECTORY, backend: "codex", sandbox: "workspace-write", model: "gpt-6.1-sol" };

afterEach(() => {
  for (const r of fixtures.splice(0)) {
    (r.fm as any).settingsGate().store.close();
    for (const p of r.any.pendingNonceButtons.values()) clearTimeout(p.timer);
    r.fm.stormWindow.shutdown(); r.fm.spawnGate.shutdown(); rmSync(r.dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

/** Runs `hook` after the profile is made and before its fleet identity is persisted: the window the fences must close. */
function afterProfile(hook: () => void): void {
  const original = WindowsAgents.prototype.create;
  vi.spyOn(WindowsAgents.prototype, "create").mockImplementation(async function (this: WindowsAgents, ...args: Parameters<WindowsAgents["create"]>) {
    const agent = await original.apply(this, args); hook(); return agent;
  });
}
function rig(options: { prepareHook?: () => void } = {}) {
  vi.stubEnv("AGEND_WINDOWS_CLI", "1");
  const dir = mkdtempSync(join(tmpdir(), "agend-windows-request-")), fm = new FleetManager(dir), any = fm as any;
  const channels = [{ id: "a", type: "telegram", mode: "topic", group_id: "-100111", access: { mode: "open", allowed_users: ["a-F", "ab-F"] } },
    { id: "b", type: "telegram", mode: "topic", group_id: "-100222", access: { mode: "open", allowed_users: ["b-F", "ab-F"] } }];
  fm.fleetConfig = { defaults: { backend: "codex" }, channels, instances: {
    general_a: { working_directory: dir, general_topic: true, channel_id: "a", topic_id: 1 },
    dev: { working_directory: dir, channel_id: "a", topic_id: 2 } } } as any;
  const adapter = Object.assign(new EventEmitter(), { id: "a", type: "telegram",
    notifyAlert: vi.fn(async (chatId: string, _alert: unknown, options: any) => ({ chatId, messageId: "a-prompt", threadId: options?.threadId })),
    editMessageRemoveButtons: vi.fn(async () => {}), sendText: vi.fn(async () => ({ chatId: "-100111", messageId: "reply" })) });
  fm.adapter = adapter as any; fm.adapters.set("a", adapter as any);
  fm.worlds.set("a", { id: "a", adapter, groupId: "-100111", channelConfig: channels[0], accessManager: new AccessManager(channels[0]!.access as any, join(dir, "a.json")) } as any);
  const adapterB = Object.assign(new EventEmitter(), { id: "b", type: "telegram", notifyAlert: vi.fn(async () => ({ chatId: "-100222", messageId: "b-prompt" })),
    editMessageRemoveButtons: vi.fn(async () => {}), sendText: vi.fn(async () => ({ chatId: "-100222", messageId: "reply" })) });
  fm.adapters.set("b", adapterB as any);
  fm.worlds.set("b", { id: "b", adapter: adapterB, groupId: "-100222", channelConfig: channels[1], accessManager: new AccessManager(channels[1]!.access as any, join(dir, "b.json")) } as any);
  any.daemons.set("general_a", new EventEmitter()); any.daemons.set("dev", new EventEmitter()); any.adapterState.set("a", { status: "connected", retryCount: 0 });
  if (options.prepareHook) afterProfile(options.prepareHook);
  const bridge = { prepareWorkspace: vi.fn(async () => "C:\\Users\\Test\\Managed\\workspace"),
    start: vi.fn(() => { throw Error("Creation must not start any CLI"); }), get: () => null, hasActiveTask: () => false } as unknown as WindowsCliExecutor;
  const save = vi.fn();
  const runtime = new FleetWindowsRuntime({ owner: { dataDir: dir }, fleet: () => fm.fleetConfig, save, emit: vi.fn(), stopping: () => false,
    validateMachine: vi.fn(), machineAvailable: () => true }, { store: new WindowsAgents(dir, bridge), bridge });
  vi.spyOn(fm, "nativeInstanceRuntime").mockReturnValue(runtime);
  const create = vi.spyOn(runtime, "create"), update = vi.spyOn(runtime, "update");
  const lifecycleCreate = vi.spyOn(fm.lifecycle, "handleCreate");
  const store = (fm as any).settingsGate().store as SettingsConfirmationStore;
  const r = { dir, fm, any, adapter, runtime, save, bridge, create, update, lifecycleCreate, store };
  fixtures.push(r); return r;
}
async function mcp(tool: "create_instance" | "update_instance_config" | "replace_instance", r: ReturnType<typeof rig>, args: Record<string, unknown>) {
  let result: unknown, error: string | null | undefined;
  await outboundHandlers.get(tool)!(r.fm as any, args, (res, err) => { result = res; error = err; }, META as any);
  return { result: result as any, error };
}
/** The one live General card, once it has been posted. */
async function card(r: ReturnType<typeof rig>) {
  await vi.waitFor(() => expect(r.any.pendingNonceButtons.size).toBe(1));
  return [...r.any.pendingNonceButtons.values()][0] as any;
}
function click(r: ReturnType<typeof rig>, entry: any, action: "confirm" | "reject", userId: string) {
  return r.any.dispatchAdapterCallback({ callbackData: `settings-confirm:${entry.nonce}:${action}`, chatId: entry.chatId, threadId: entry.threadId,
    messageId: entry.messageId, userId, ack: vi.fn() }, "a", r.adapter);
}
function pendingIdOf(result: any): string {
  expect(result?.state).toBe("pending"); return result.pending_id;
}
async function createConfirmed(r: ReturnType<typeof rig>): Promise<string> {
  const pending = await mcp("create_instance", r, CREATE);
  const entry = await card(r); await click(r, entry, "confirm", "a-F");
  expect(r.store.get(pendingIdOf(pending.result), SESSION)!.state).toBe("applied");
  return Object.keys(r.fm.fleetConfig!.instances).find(name => name.startsWith("windows-"))!;
}

describe("#2942: an agent's Windows create is only ever a pending request", () => {
  it("(a) create_instance windows answers pending: nothing created, no fleet write, no lifecycle", async () => {
    const r = rig(), before = structuredClone(r.fm.fleetConfig);
    const out = await mcp("create_instance", r, CREATE);
    expect(out.error).toBeFalsy();
    expect(out.result.state).toBe("pending");
    expect(out.result.message).toContain("waiting for a fleet admin to confirm (in General");
    expect(out.result.message).toContain("Needs you");                       // alpha.2: a web-only fleet's owner decides it there
    const [view] = r.store.list(SESSION);
    expect(view).toMatchObject({ state: "pending", source: "agent_request", requested_by: "dev", section: "channel" });
    expect(r.fm.fleetConfig).toEqual(before);
    expect(r.create).not.toHaveBeenCalled(); expect(r.save).not.toHaveBeenCalled(); expect(r.bridge.prepareWorkspace).not.toHaveBeenCalled();
    expect(r.lifecycleCreate).not.toHaveBeenCalled();
    await card(r);                                             // the request is held for General, not applied
    expect(r.store.get(out.result.pending_id, SESSION)!.state).toBe("pending");
  });

  it("(b) a non-admin click on the General card is refused and the request stays pending", async () => {
    const r = rig(), out = await mcp("create_instance", r, CREATE), entry = await card(r);
    await click(r, entry, "confirm", "stranger-F");
    expect(r.create).not.toHaveBeenCalled(); expect(r.save).not.toHaveBeenCalled();
    expect(r.store.get(pendingIdOf(out.result), SESSION)!.state).toBe("pending");
    expect(r.any.pendingNonceButtons.has(entry.nonce)).toBe(true);
  });

  it("(c) an admin's confirm creates the instance once, with the requested directory and sandbox; repeats do nothing", async () => {
    const r = rig(), name = await createConfirmed(r);
    expect(r.create).toHaveBeenCalledOnce();
    expect(r.create.mock.calls[0]![0]).toMatchObject({ name: "Repo", cli: "codex", cwd: DIRECTORY, sandbox: "workspace-write", model: "gpt-6.1-sol" });
    expect(r.fm.fleetConfig!.instances[name]).toMatchObject({ runtime: "windows", working_directory: DIRECTORY, native_sandbox: "workspace-write" });
    expect(r.save).toHaveBeenCalledOnce();
    // The same request again: the applied record answers, and no second Windows agent is made.
    const again = await mcp("create_instance", r, CREATE);
    expect(again.result.state).toBe("applied");
    expect(r.create).toHaveBeenCalledOnce();
    expect(Object.keys(r.fm.fleetConfig!.instances).filter(n => n.startsWith("windows-"))).toHaveLength(1);
  });

  it("(c2) a repeated click on a confirmed card does not run the creation again", async () => {
    const r = rig(), out = await mcp("create_instance", r, CREATE), entry = await card(r);
    await click(r, entry, "confirm", "a-F");
    await click(r, { ...entry }, "confirm", "a-F");
    expect(r.create).toHaveBeenCalledOnce();
    expect(r.store.get(pendingIdOf(out.result), SESSION)!.state).toBe("applied");
  });

  it("(d) a rejected request creates nothing", async () => {
    const r = rig(), out = await mcp("create_instance", r, CREATE), entry = await card(r);
    await click(r, entry, "reject", "a-F");
    expect(r.store.get(pendingIdOf(out.result), SESSION)!.state).toBe("rejected");
    expect(r.create).not.toHaveBeenCalled(); expect(r.save).not.toHaveBeenCalled();
    expect(Object.keys(r.fm.fleetConfig!.instances).some(n => n.startsWith("windows-"))).toBe(false);
  });

  it("(d2) an expired request creates nothing, even when an admin then clicks", async () => {
    const r = rig(), out = await mcp("create_instance", r, CREATE), entry = await card(r);
    const t0 = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(t0 + SETTINGS_CONFIRMATION_TTL_MS + 60_000);
    expect(r.store.get(pendingIdOf(out.result), SESSION)!.state).toBe("expired");
    await click(r, entry, "confirm", "a-F");
    expect(r.create).not.toHaveBeenCalled(); expect(r.save).not.toHaveBeenCalled();
  });

  it("(e) the General card shows the drive path and the sandbox mode, not only the name", async () => {
    const r = rig(), out = await mcp("create_instance", r, CREATE);
    const summary = r.store.get(pendingIdOf(out.result), SESSION)!.summary.join("\n");
    expect(summary).toContain(settingsDisplay(DIRECTORY));
    expect(summary).toContain("workspace-write");
    const entry = await card(r);
    // The card's text is JSON-escaped once more in the call record; compare against that same escaping.
    const posted = JSON.stringify(r.adapter.notifyAlert.mock.calls[0]);
    expect(posted).toContain(JSON.stringify(settingsDisplay(DIRECTORY)).slice(1, -1));
    expect(posted).toContain("workspace-write");
    expect(entry).toBeTruthy();
  });

  it("(f) replace_instance and the template path still refuse a Windows runtime; nothing is requested", async () => {
    const r = rig();
    const respond = vi.fn();
    await r.fm.lifecycle.handleCreate({ runtime: "windows", topic_name: "Native", directory: DIRECTORY } as any, respond);
    expect(respond).toHaveBeenCalledWith(null, WINDOWS_CREATE_REFUSED);
    expect(r.create).not.toHaveBeenCalled();
    r.fm.fleetConfig!.instances.win = { runtime: "windows", native_agent_id: "12345678-1234-4321-abcd-123456789012", working_directory: DIRECTORY } as any;
    const replace = await mcp("replace_instance", r, { name: "win" });
    expect(replace.error).toBe(WINDOWS_CONFIG_REFUSED);
    expect(r.store.list(SESSION)).toEqual([]);
  });

  it("(g) with the Windows switch off, the request is refused at once, and a switch turned off before confirm creates nothing", async () => {
    const off = rig(); vi.stubEnv("AGEND_WINDOWS_CLI", "0");
    const refused = await mcp("create_instance", off, CREATE);
    expect(refused.error).toMatch(/Windows CLI|switched off|turned off/i);
    expect(off.store.list(SESSION)).toEqual([]);
    vi.unstubAllEnvs(); vi.stubEnv("AGEND_WINDOWS_CLI", "1");
    // Switched off while the admin is deciding: the apply's own fence stops the creation.
    const late = rig({ prepareHook: () => vi.stubEnv("AGEND_WINDOWS_CLI", "0") });
    const out = await mcp("create_instance", late, CREATE), entry = await card(late);
    await click(late, entry, "confirm", "a-F");
    expect(late.store.get(pendingIdOf(out.result), SESSION)!.state).not.toBe("applied");
    expect(Object.keys(late.fm.fleetConfig!.instances).some(n => n.startsWith("windows-"))).toBe(false);
    expect(late.save).not.toHaveBeenCalled();
  });

  it("the admin's authority lapsing while the agent is being made creates nothing", async () => {
    const r = rig({ prepareHook: () => { r.fm.fleetConfig!.channels![0]!.access!.allowed_users = []; } });
    const out = await mcp("create_instance", r, CREATE), entry = await card(r);
    await click(r, entry, "confirm", "a-F");
    expect(r.store.get(pendingIdOf(out.result), SESSION)!.state).not.toBe("applied");
    expect(Object.keys(r.fm.fleetConfig!.instances).some(n => n.startsWith("windows-"))).toBe(false);
  });
});

describe("#2942: the agent-facing create_instance offers the Windows request; the ordinary schema does not", () => {
  it("(i) the tool's fields include the Windows request, and CreateInstanceArgs (the ordinary validation) stays as it was", () => {
    expect(Object.keys(CreateInstanceToolArgs.shape)).toEqual(expect.arrayContaining(["runtime", "sandbox", "native_adapter", "channel_id", "machineId"]));
    expect(Object.keys(CreateInstanceArgs.shape)).not.toContain("runtime");
    expect(Object.keys(CreateInstanceArgs.shape)).not.toContain("sandbox");
  });
});

describe("#2942: an agent's Windows settings change is only ever a pending request", () => {
  it("(h) update_instance_config is pending; the admin's confirm applies only display_name, description and model", async () => {
    const r = rig(), name = await createConfirmed(r), before = structuredClone(r.fm.fleetConfig!.instances[name]);
    const out = await mcp("update_instance_config", r, { name, config: { display_name: "Renamed", model: "gpt-6.2" } });
    expect(out.result.state).toBe("pending");
    expect(r.update).not.toHaveBeenCalled();
    expect(r.fm.fleetConfig!.instances[name]).toEqual(before);
    const entry = await card(r); await click(r, entry, "confirm", "a-F");
    expect(r.update).toHaveBeenCalledOnce();
    expect(r.update.mock.calls[0]![1]).toEqual({ display_name: "Renamed", model: "gpt-6.2" });
    const after = r.fm.fleetConfig!.instances[name]!;
    expect(after).toMatchObject({ display_name: "Renamed", model: "gpt-6.2" });
    expect([after.working_directory, after.native_sandbox, after.backend]).toEqual([before!.working_directory, before!.native_sandbox, before!.backend]);
  });

  describe("#2973 review (Prism P1): a persistent pane bound to connection b needs b's admins as well as the primary General's", () => {
    async function paneOnB(r: ReturnType<typeof rig>) {
      const name = await createConfirmed(r);
      Object.assign(r.fm.fleetConfig!.instances[name]!, { native_adapter: "pane", channel_id: "b", topic_id: 7 });
      r.any.adapterState.set("b", { status: "connected", retryCount: 0 });
      return name;
    }
    it("an admin of the primary General's connection alone (A-only) cannot confirm: nothing is changed", async () => {
      const r = rig(), name = await paneOnB(r);
      const paneUpdate = vi.spyOn(r.fm, "updateNativePaneConfig").mockResolvedValue({} as never);
      const out = await mcp("update_instance_config", r, { name, config: { model: "gpt-6.2" } }); expect(out.result.state).toBe("pending");
      const entry = await card(r); await click(r, entry, "confirm", "a-F");
      expect(paneUpdate).not.toHaveBeenCalled(); expect(r.store.get(pendingIdOf(out.result), SESSION)!.state).toBe("pending");
    });
    it("an admin of both connections confirms and the pane change is applied once", async () => {
      const r = rig(), name = await paneOnB(r);
      const paneUpdate = vi.spyOn(r.fm, "updateNativePaneConfig").mockResolvedValue({} as never);
      const out = await mcp("update_instance_config", r, { name, config: { model: "gpt-6.2" } });
      const entry = await card(r); await click(r, entry, "confirm", "ab-F");
      await vi.waitFor(() => expect(paneUpdate).toHaveBeenCalledOnce()); expect(paneUpdate.mock.calls[0]![1]).toEqual({ model: "gpt-6.2" });
      expect(r.store.get(pendingIdOf(out.result), SESSION)!.state).toBe("applied");
    });
    it("the target connection's admin revoked during the apply: its authority fence turns false before the write", async () => {
      const r = rig(), name = await paneOnB(r); let fenceAfterRevoke: boolean | undefined;
      vi.spyOn(r.fm, "updateNativePaneConfig").mockImplementation(async (_n, _p, allowed) => {
        (r.fm.fleetConfig as any).channels[1].access.allowed_users = ["b-F"];
        r.any.worlds.get("b").accessManager = new AccessManager((r.fm.fleetConfig as any).channels[1].access, join(r.dir, "b2.json"));
        fenceAfterRevoke = allowed(); if (!fenceAfterRevoke) throw Error("Authorization expired"); return {} as never;
      });
      await mcp("update_instance_config", r, { name, config: { model: "gpt-6.2" } });
      const entry = await card(r); await click(r, entry, "confirm", "ab-F");
      await vi.waitFor(() => expect(fenceAfterRevoke).toBe(false));
    });
    // #2973 review (Prism P2): the real updateNativePaneConfig, its lifecycle turn held, the stop intercepted.
    async function heldUpdate(rebind: boolean, realUpdate = false) {
      const r = rig(), name = await paneOnB(r);
      (r.fm.fleetConfig as any).channels.push({ id: "c", type: "telegram", mode: "topic", group_id: "-100333", access: { mode: "open", allowed_users: ["c-F"] } });
      let release!: () => void; const held = new Promise<void>(done => { release = done; });
      const realTransition = r.fm.lifecycle.runTransition.bind(r.fm.lifecycle);
      vi.spyOn(r.fm.lifecycle, "runTransition").mockImplementation(async (n: string, fn: any) => { await held; return realTransition(n, fn); });
      r.any.daemons.set(name, Object.assign(new EventEmitter(), { nativePaneHasExited: () => true }));
      // As the real stop does: a stop moves the explicit-stop generation on.
      const stop = vi.spyOn(r.fm, "stopInstance").mockImplementation(async (n: string) => { r.any.explicitStopGeneration.set(n, (r.any.explicitStopGeneration.get(n) ?? 0) + 1); return { backgroundWorkEnded: true }; });
      if (!realUpdate) vi.spyOn(r.runtime, "previewUpdate").mockImplementation(() => undefined as never);
      if (!realUpdate) vi.spyOn(r.runtime, "update").mockImplementation(() => ({}) as never);
      const start = vi.spyOn(r.fm, "startInstance").mockResolvedValue(undefined as never);
      const out = await mcp("update_instance_config", r, { name, config: { model: "gpt-6.2" } });
      const entry = await card(r); const clicked = click(r, entry, "confirm", "ab-F");
      await vi.waitFor(() => expect(r.fm.lifecycle.runTransition).toHaveBeenCalled());
      if (rebind) r.fm.fleetConfig!.instances[name]!.channel_id = "c";     // B → C while the update waits its turn
      release(); await clicked; await vi.waitFor(() => expect(r.store.get(pendingIdOf(out.result), SESSION)!.state).not.toMatch(/pending|applying/));
      return { r, stop, start, name, state: r.store.get(pendingIdOf(out.result), SESSION)!.state };
    }
    it("a rebind (B → C) while the update waits its lifecycle turn: the old A+B approval stops nothing on C", async () => {
      const { r, stop, start, name, state } = await heldUpdate(true, true);
      expect(start).not.toHaveBeenCalled(); expect(r.fm.fleetConfig!.instances[name]!.model).not.toBe("gpt-6.2");
      expect(stop).not.toHaveBeenCalled(); expect(state).not.toBe("applied");
    });
    it("the same target held the same way, through the REAL runtime.update (it completes the transaction): stopped once, saved, restarted, applied", async () => {
      const { r, stop, start, name, state } = await heldUpdate(false, true);
      expect(stop).toHaveBeenCalledOnce(); expect(r.fm.fleetConfig!.instances[name]!.model).toBe("gpt-6.2");
      expect(start).toHaveBeenCalledOnce(); expect(state).toBe("applied");
    });
    it("a binding that names no single configured connection is refused before anything is requested (fail closed)", async () => {
      const r = rig(), name = await paneOnB(r);
      r.fm.fleetConfig!.instances[name]!.channel_id = "gone";
      const out = await mcp("update_instance_config", r, { name, config: { model: "gpt-6.2" } });
      expect(out.error).toMatch(/chat connection cannot be resolved/); expect(r.any.pendingNonceButtons.size).toBe(0);
    });
  });
  it("(h2) fields the web editor does not allow are refused before anything is requested", async () => {
    const r = rig(), name = await createConfirmed(r);
    for (const config of [{ backend: "grok" }, { working_directory: "D:\\Elsewhere" }, { auto_pause_after: 5 }, { display_name: "x", backend_options: { codex: {} } }]) {
      const out = await mcp("update_instance_config", r, { name, config });
      expect(out.error).toBe(WINDOWS_CONFIG_REFUSED);
    }
    expect(r.store.list(SESSION)).toEqual([]);
    expect(r.update).not.toHaveBeenCalled();
  });

  it("(h3) a settings change whose admin lapses before the write is not applied", async () => {
    const r = rig(), name = await createConfirmed(r);
    await mcp("update_instance_config", r, { name, config: { display_name: "Renamed" } });
    const entry = await card(r);
    // The admin's access is gone before the confirm reaches the write.
    r.fm.fleetConfig!.channels![0]!.access!.allowed_users = [];
    await click(r, entry, "confirm", "a-F");
    expect(r.update).not.toHaveBeenCalled();
    expect(r.fm.fleetConfig!.instances[name]!.display_name).not.toBe("Renamed");
  });
});
