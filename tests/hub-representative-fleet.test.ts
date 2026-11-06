/**
 * #3145's fleet seams for the Hub representative: DeliveryOptions.beforeInput runs after the storm/idle gates and
 * immediately before the IPC hand-off (false sends nothing), the Hub question's cross-instance payload, and the
 * report_result hook (reserved target + live Hub id + the designated caller; everything else takes the ordinary route).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { HUB_REPORT_TARGET } from "../src/hub-report-target.js";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("beforeInput in the delivery facade", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-06T00:00:00Z")); });
  afterEach(() => vi.useRealTimers());
  function manager() {
    const fm = new FleetManager("/tmp/agend-hub-representative-fleet-test");
    vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(false);
    (fm as any).instanceStateCache.set("worker", { state: "idle", observedAt: Date.now(), receivedAt: Date.now() });
    const order: string[] = [];
    (fm as any).sendWhenConnected = vi.fn(async () => { order.push("send"); return true; });
    return { fm, order };
  }

  it("runs only after the storm hold clears and only at the connected hand-off; false sends nothing", async () => {
    const { fm, order } = manager();
    (fm as any).sendWhenConnected = (FleetManager.prototype as any).sendWhenConnected; // the real hand-off
    const ipc = { connected: true, send: vi.fn((p: { type?: string }) => { if (p.type === "fleet_inbound") order.push("send"); return true; }) };
    (fm as any).instanceIpcClients.set("worker", ipc);
    fm.stormWindow.recordServerDead("worker", ["worker"]);
    const before = vi.fn(async () => { order.push("beforeInput"); return true; });
    const delivery = (fm as any).deliverWithIdleGate("worker", { type: "fleet_inbound" }, 5, 0, false, undefined, undefined, before);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(before).not.toHaveBeenCalled(); // never a lease while the delivery is still held
    fm.stormWindow.markRecovered("worker");
    await expect(delivery).resolves.toBe(true);
    expect(order).toEqual(["beforeInput", "send"]);

    const refused = vi.fn(async () => false);
    const second = (fm as any).deliverWithIdleGate("worker", { type: "fleet_inbound" }, 5, 0, false, undefined, undefined, refused);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(second).resolves.toBe(false);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["beforeInput", "send"]); // the refused one sent nothing
    fm.stormWindow.shutdown();
  });

  it("#3147 review: during an IPC reconnect wait no lease is taken; the hook runs once the client is connected", async () => {
    const { fm, order } = manager();
    (fm as any).sendWhenConnected = (FleetManager.prototype as any).sendWhenConnected;
    const down = { connected: false, send: vi.fn(() => false) };
    (fm as any).instanceIpcClients.set("worker", down);
    const before = vi.fn(async () => { order.push("beforeInput"); return true; });
    const delivery = (fm as any).deliverWithIdleGate("worker", { type: "fleet_inbound" }, 5, 0, false, undefined, undefined, before);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(before).not.toHaveBeenCalled(); // still reconnecting: nothing spent
    const up = { connected: true, send: vi.fn(() => { order.push("send"); return true; }) };
    (fm as any).instanceIpcClients.set("worker", up); // a reconnect replaces the client
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(delivery).resolves.toBe(true);
    expect(order).toEqual(["beforeInput", "send"]);
    fm.stormWindow.shutdown();
  });

  it("#3147 review: once the intent is spent, a client lost or a fence moved during the hook is a single failed attempt, never retried", async () => {
    const { fm } = manager();
    (fm as any).sendWhenConnected = (FleetManager.prototype as any).sendWhenConnected;
    const ipc = { connected: true, send: vi.fn(() => true) };
    (fm as any).instanceIpcClients.set("worker", ipc);
    const before = vi.fn(async () => { ipc.connected = false; return true; }); // the client drops while the lease is fetched
    const delivery = (fm as any).deliverWithIdleGate("worker", { type: "fleet_inbound" }, 5, 0, false, undefined, undefined, before);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(delivery).resolves.toBe(false);
    expect(before).toHaveBeenCalledTimes(1);
    expect(ipc.send).not.toHaveBeenCalled();

    let fenced = false;
    const ipc2 = { connected: true, send: vi.fn(() => true) };
    (fm as any).instanceIpcClients.set("worker", ipc2);
    const fencing = vi.fn(async () => { fenced = true; return true; }); // e.g. consent withdrawn during the lease
    const second = (fm as any).deliverWithIdleGate("worker", { type: "fleet_inbound" }, 5, 0, false, () => !fenced, undefined, fencing);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(second).resolves.toBe(false);
    expect(ipc2.send).not.toHaveBeenCalled();
    fm.stormWindow.shutdown();
  });

  it("a cancel that lands during beforeInput drops the delivery unsent", async () => {
    const { fm } = manager();
    (fm as any).sendWhenConnected = (FleetManager.prototype as any).sendWhenConnected;
    const ipc = { connected: true, send: vi.fn(() => true) };
    (fm as any).instanceIpcClients.set("worker", ipc);
    const before = vi.fn(async () => { (fm as any).deliveryEpochs.set("worker", 1); return true; });
    const delivery = (fm as any).deliverWithIdleGate("worker", { type: "fleet_inbound" }, 5, 0, false, undefined, undefined, before);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(delivery).resolves.toBe(false);
    expect(before).toHaveBeenCalledTimes(1);
    expect(ipc.send).not.toHaveBeenCalled();
    fm.stormWindow.shutdown();
  });

  it("a Hub question is an ordinary cross-instance delivery from the reserved Hub sender, with its correlation id", async () => {
    const { fm } = manager();
    (fm as any).fleetConfig = { instances: { worker: { working_directory: "/tmp/w", backend: "claude-code" } } };
    const deliver = vi.spyOn(fm, "deliverToInstance").mockResolvedValue(true);
    const beforeInput = async () => true, stillCurrent = () => true;
    await expect((fm as any).deliverHubQuestion({ agent: "worker", correlationId: "hub-0000", text: "Q", beforeInput, stillCurrent })).resolves.toBe(true);
    const [name, payload, options] = deliver.mock.calls[0]!;
    expect(name).toBe("worker");
    expect(payload).toMatchObject({ type: "fleet_inbound", content: "Q", meta: { from_instance: HUB_REPORT_TARGET, correlation_id: "hub-0000", requires_reply: "true" } });
    expect(options).toMatchObject({ isCrossInstance: true, beforeInput, stillCurrent });
    // Not a configured instance, or a Windows agent (no pre-input hook there): never delivered.
    await expect((fm as any).deliverHubQuestion({ agent: "gone", correlationId: "hub-1", text: "Q", beforeInput, stillCurrent })).resolves.toBe(false);
    (fm as any).fleetConfig.instances.win = { working_directory: "C:/w", runtime: "windows" };
    await expect((fm as any).deliverHubQuestion({ agent: "win", correlationId: "hub-2", text: "Q", beforeInput, stillCurrent })).resolves.toBe(false);
    expect(deliver).toHaveBeenCalledTimes(1);
    fm.stormWindow.shutdown();
  });

  it("#3147 review: the lifecycle token is durable across restarts and never revives after replacement or A→B→A", () => {
    const home = mkdtempSync(join(tmpdir(), "agend-hub-token-"));
    try {
      const made: FleetManager[] = [];
      const make = (instances: Record<string, unknown>) => {
        const fm = new FleetManager(home);
        (fm as any).fleetConfig = { instances };
        made.push(fm);
        return fm;
      };
      const a = { working_directory: "/tmp/w", backend: "claude-code", display_name: "W" };
      const fm1 = make({ worker: { ...a } });
      const token = (fm1 as any).hubAgentToken("worker");
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect((fm1 as any).hubAgentToken("missing")).toBeNull();
      expect(statSync(join(home, "hub-member", "agent-incarnations.json")).mode & 0o777).toBe(0o600);
      // Restart: the same agent keeps its token; a label change does not matter.
      const fm2 = make({ worker: { ...a, display_name: "Renamed" } });
      expect((fm2 as any).hubAgentToken("worker")).toBe(token);
      // Removed (a reload without it), then re-added with the very same name and config, then a restart: a new token.
      (fm2 as any).fleetConfig = { instances: {} };
      (fm2 as any).observeHubAgentIncarnations();
      const fm3 = make({ worker: { ...a } });
      const readded = (fm3 as any).hubAgentToken("worker");
      expect(readded).not.toBe(token);
      expect((make({ worker: { ...a } }) as any).hubAgentToken("worker")).toBe(readded);
      // A → B → A (folder): every change seen by the running fleet rotates it; going back never revives the old one.
      (fm3 as any).fleetConfig = { instances: { worker: { ...a, working_directory: "/tmp/other" } } };
      (fm3 as any).observeHubAgentIncarnations();
      const moved = (fm3 as any).hubAgentToken("worker");
      (fm3 as any).fleetConfig = { instances: { worker: { ...a } } };
      (fm3 as any).observeHubAgentIncarnations();
      const back = (fm3 as any).hubAgentToken("worker");
      expect(new Set([token, readded, moved, back]).size).toBe(4);
      // Removing it through the fleet (remove_instance) forgets it as well.
      (fm3 as any).forgetHubAgentIncarnation("worker");
      const after = (fm3 as any).hubAgentToken("worker");
      expect(after).not.toBe(back);
      // No configuration loaded yet (startup): nothing is forgotten.
      const fm4 = new FleetManager(home);
      made.push(fm4);
      (fm4 as any).observeHubAgentIncarnations();
      (fm4 as any).fleetConfig = { instances: { worker: { ...a } } };
      expect((fm4 as any).hubAgentToken("worker")).toBe(after);
      for (const fm of made) fm.stormWindow.shutdown();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("report_result to the Hub", () => {
  function call(ctx: Record<string, unknown>, args: Record<string, unknown>, meta: Record<string, unknown> = { instanceName: "rep" }) {
    return new Promise<{ result: unknown; error?: string }>((resolve) => {
      void outboundHandlers.get("report_result")!(ctx as never, args, (result: unknown, error?: string) => resolve({ result, error }), meta as never);
    });
  }
  const base = () => ({ logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }, fleetConfig: { instances: {} }, instanceIpcClients: new Map(), sessionRegistry: new Map() });

  it("a live Hub id from its agent is answered by the hook; anything else takes the ordinary route", async () => {
    const hubReport = vi.fn((input: { correlationId: string; caller: string; text: string }) =>
      input.correlationId === "hub-live" && input.caller === "rep" ? Promise.resolve({ ok: true as const, message: "Delivered to the Hub asker." }) : null);
    const ctx = { ...base(), hubReport };
    expect(await call(ctx, { target_instance: HUB_REPORT_TARGET, correlation_id: "hub-live", summary: "The answer", artifacts: "a.txt" }))
      .toEqual({ result: { sent: true, target: HUB_REPORT_TARGET, correlation_id: "hub-live", message: "Delivered to the Hub asker." }, error: undefined });
    expect(hubReport).toHaveBeenLastCalledWith({ correlationId: "hub-live", caller: "rep", text: "The answer\n\nArtifacts: a.txt", callerCurrent: expect.any(Function) });
    // Not claimed (another caller, an unknown id): the ordinary refusal.
    expect((await call(ctx, { target_instance: HUB_REPORT_TARGET, correlation_id: "hub-live", summary: "x" }, { instanceName: "other" })).error).toMatch(/not found/);
    expect((await call(ctx, { target_instance: HUB_REPORT_TARGET, correlation_id: "hub-gone", summary: "x" })).error).toMatch(/not found/);
    // No correlation id, an external MCP session sending as the agent, or another target: never asked.
    hubReport.mockClear();
    expect((await call(ctx, { target_instance: HUB_REPORT_TARGET, summary: "x" })).error).toMatch(/not found/);
    expect((await call(ctx, { target_instance: HUB_REPORT_TARGET, correlation_id: "hub-live", summary: "x" }, { instanceName: "rep", senderSessionName: "ext" })).error).toMatch(/not found/);
    expect((await call(ctx, { target_instance: "peer", correlation_id: "hub-live", summary: "x" })).error).toMatch(/not found/);
    expect(hubReport).not.toHaveBeenCalled();
  });

  it("#3147 review: the source-daemon generation fence — a retired generation never claims; the current one is rechecked later", async () => {
    let boot = "boot-2";
    const hubReport = vi.fn((input: { callerCurrent(): boolean }) => Promise.resolve({ ok: true as const, message: String(input.callerCurrent()) }));
    const ctx = { ...base(), hubReport, getDaemonBootId: () => boot };
    expect(await call(ctx, { target_instance: HUB_REPORT_TARGET, correlation_id: "hub-live", summary: "x" }, { instanceName: "rep", sourceDaemonBootId: "retired-boot" }))
      .toEqual({ result: null, error: "Source daemon generation is no longer current; outcome is unknown" });
    expect(hubReport).not.toHaveBeenCalled();
    const ok = await call(ctx, { target_instance: HUB_REPORT_TARGET, correlation_id: "hub-live", summary: "x" }, { instanceName: "rep", sourceDaemonBootId: "boot-2" });
    expect(ok.result).toMatchObject({ sent: true, message: "true" });
    const { callerCurrent } = hubReport.mock.calls[0]![0];
    boot = "boot-3"; // the agent's daemon restarted while the answer was being released
    expect(callerCurrent()).toBe(false);
  });

  it("a claimed id the Hub refuses tells the agent so", async () => {
    const ctx = { ...base(), hubReport: () => Promise.resolve({ ok: false as const, message: "Not delivered to the Hub asker" }) };
    expect(await call(ctx, { target_instance: HUB_REPORT_TARGET, correlation_id: "hub-x", summary: "x" })).toEqual({ result: null, error: "Not delivered to the Hub asker" });
  });
});
