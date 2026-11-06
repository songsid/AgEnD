/**
 * #3145's fleet seams for the Hub representative: DeliveryOptions.beforeInput runs after the storm/idle gates and
 * immediately before the IPC hand-off (false sends nothing), the Hub question's cross-instance payload, and the
 * report_result hook (reserved target + live Hub id + the designated caller; everything else takes the ordinary route).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { HUB_REPORT_TARGET } from "../src/hub-report-target.js";

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

  it("runs only after the storm hold clears, immediately before the hand-off; false sends nothing", async () => {
    const { fm, order } = manager();
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
    expect((fm as any).sendWhenConnected).toHaveBeenCalledTimes(1);
    fm.stormWindow.shutdown();
  });

  it("a cancel that lands during beforeInput drops the delivery unsent", async () => {
    const { fm } = manager();
    const before = vi.fn(async () => { (fm as any).deliveryEpochs.set("worker", 1); return true; });
    const delivery = (fm as any).deliverWithIdleGate("worker", { type: "fleet_inbound" }, 5, 0, false, undefined, undefined, before);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(delivery).resolves.toBe(false);
    expect(before).toHaveBeenCalledTimes(1);
    expect((fm as any).sendWhenConnected).not.toHaveBeenCalled();
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

  it("the agent's lifecycle token changes with replacement, backend or folder — not with anything else", () => {
    const { fm } = manager();
    (fm as any).fleetConfig = { instances: { worker: { working_directory: "/tmp/w", backend: "claude-code", display_name: "W" } } };
    const token = (fm as any).hubAgentToken("worker");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((fm as any).hubAgentToken("missing")).toBeNull();
    (fm as any).fleetConfig.instances.worker.display_name = "Renamed";
    expect((fm as any).hubAgentToken("worker")).toBe(token);
    (fm as any).fleetConfig.instances.worker.working_directory = "/tmp/other";
    const moved = (fm as any).hubAgentToken("worker");
    expect(moved).not.toBe(token);
    (fm as any).webChatGenerations.set("worker", 1); // removed (and possibly re-added under the same name)
    expect((fm as any).hubAgentToken("worker")).not.toBe(moved);
    fm.stormWindow.shutdown();
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
    expect(hubReport).toHaveBeenLastCalledWith({ correlationId: "hub-live", caller: "rep", text: "The answer\n\nArtifacts: a.txt" });
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

  it("a claimed id the Hub refuses tells the agent so", async () => {
    const ctx = { ...base(), hubReport: () => Promise.resolve({ ok: false as const, message: "Not delivered to the Hub asker" }) };
    expect(await call(ctx, { target_instance: HUB_REPORT_TARGET, correlation_id: "hub-x", summary: "x" })).toEqual({ result: null, error: "Not delivered to the Hub asker" });
  });
});
