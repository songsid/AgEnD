import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outboundHandlers, setCrossInstanceRetryForTests } from "../src/outbound-handlers.js";

// Real retry intervals are 30s; keep tests snappy and let background retry chains
// finish inside the test instead of leaking timers past it.
beforeEach(() => setCrossInstanceRetryForTests({ retries: 2, intervalMs: 5 }));
afterEach(() => setCrossInstanceRetryForTests(null));

/**
 * Cross-instance tools must hand the message to the fleet and return immediately.
 * Awaiting delivery blocked the caller for as long as the target stayed busy (the
 * idle gate), which surfaced as "IPC request timed out after 30000ms" and
 * serialized all cross-instance traffic.
 */
function makeContext(opts: { deliver: () => Promise<void>; connected?: string[] }) {
  const connected = opts.connected ?? ["target"];
  return {
    fleetConfig: { defaults: {}, instances: { sender: {}, target: {} }, channel: undefined },
    adapter: null,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    instanceIpcClients: new Map(connected.map(n => [n, { connected: true, send: vi.fn() }])),
    sessionRegistry: new Map(),
    lifecycle: { daemons: new Map(), isPaused: vi.fn(() => false) },
    classicChannels: null,
    eventLog: { logActivity: vi.fn(), insert: vi.fn() },
    deliverToInstance: vi.fn(opts.deliver),
    notifyInstanceTopic: vi.fn(),
    lastActivityMs: vi.fn(() => 0),
  } as any;
}

/** A target that never goes idle — deliverToInstance never settles. */
function neverSettles() {
  return () => new Promise<void>(() => { /* intentionally pending */ });
}

const meta = { instanceName: "sender", requestId: 1, fleetRequestId: undefined, senderSessionName: undefined };

async function callTool(tool: string, ctx: any, args: Record<string, unknown>) {
  let result: any; let error: string | undefined;
  await outboundHandlers.get(tool)!(ctx, args, (r, e) => { result = r; error = e; }, meta as any);
  return { result, error };
}

describe("cross-instance tools are fire-and-queue", () => {
  it("send_to_instance responds immediately when the target is busy", async () => {
    const ctx = makeContext({ deliver: neverSettles() });
    const started = Date.now();

    const { result, error } = await callTool("send_to_instance", ctx, {
      instance_name: "target", message: "hello",
    });

    // The old code awaited the idle gate here and only answered after it timed out.
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ sent: true, queued: true, target: "target" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(ctx.deliverToInstance).toHaveBeenCalledOnce();
  });

  it("still errors when the target does not exist", async () => {
    const ctx = makeContext({ deliver: neverSettles(), connected: [] });
    const { result, error } = await callTool("send_to_instance", ctx, {
      instance_name: "ghost", message: "hello",
    });
    expect(result).toBeNull();
    expect(error).toMatch(/not found/i);
    expect(ctx.deliverToInstance).not.toHaveBeenCalled();
  });

  it("reports a stopped-but-configured target as an error, not queued", async () => {
    const ctx = makeContext({ deliver: neverSettles(), connected: [] });
    const { result, error } = await callTool("send_to_instance", ctx, {
      instance_name: "target", message: "hello", // in fleetConfig.instances but no IPC
    });
    expect(result).toBeNull();
    expect(error).toMatch(/stopped/i);
  });

  it("a delivery that rejects later does not fail the caller", async () => {
    const ctx = makeContext({ deliver: () => Promise.reject(new Error("wake failed")) });
    const { result, error } = await callTool("send_to_instance", ctx, {
      instance_name: "target", message: "hello",
    });
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ queued: true });
    // The rejection triggers background retries rather than surfacing to the agent.
    await vi.waitFor(() => expect(ctx.logger.warn).toHaveBeenCalled());
  });

  it.each([
    ["delegate_task", { target_instance: "target", task: "do it" }],
    ["request_information", { target_instance: "target", question: "why?" }],
    ["report_result", { target_instance: "target", summary: "done" }],
  ])("%s also returns immediately (shared sendToInstance path)", async (tool, args) => {
    const ctx = makeContext({ deliver: neverSettles() });
    const started = Date.now();
    const { result, error } = await callTool(tool, ctx, args);
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ queued: true });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("retries a failed delivery and succeeds without bothering anyone", async () => {
    // Transient failure — exactly the restart/crash-loop window the retry exists
    // for. The recipient gets the message on attempt 2; no notification needed.
    let calls = 0;
    const ctx = makeContext({
      deliver: () => (++calls === 1 ? Promise.reject(new Error("IPC gone")) : Promise.resolve()),
    });

    await callTool("send_to_instance", ctx, { instance_name: "target", message: "hello" });

    await vi.waitFor(() => expect(ctx.deliverToInstance).toHaveBeenCalledTimes(2));
    expect(ctx.notifyInstanceTopic).not.toHaveBeenCalled();
    expect(ctx.logger.error).not.toHaveBeenCalled();
  });

  it("tells both topics and the event log when every retry fails", async () => {
    // This used to die in a single warn-level log line: the sender believed it
    // delivered, the recipient never got it, and no human was told.
    const ctx = makeContext({ deliver: () => Promise.reject(new Error("IPC gone")) });

    const { result } = await callTool("send_to_instance", ctx, {
      instance_name: "target", message: "hello",
    });
    const correlationId = result.correlation_id as string;

    // 1 initial + 2 retries (test config), then give up loudly.
    await vi.waitFor(() => expect(ctx.notifyInstanceTopic).toHaveBeenCalledTimes(2));
    expect(ctx.deliverToInstance).toHaveBeenCalledTimes(3);

    const topics = ctx.notifyInstanceTopic.mock.calls.map((c: unknown[]) => c[0]);
    expect(topics).toContain("sender");
    expect(topics).toContain("target");
    const notice = ctx.notifyInstanceTopic.mock.calls[0][1] as string;
    expect(notice).toContain("could not be delivered");
    expect(notice).toContain(correlationId);

    expect(ctx.eventLog.insert).toHaveBeenCalledWith(
      "target",
      "cross_instance_delivery_failed",
      expect.objectContaining({ from: "sender", correlation_id: correlationId }),
    );
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("broadcast targets get the same retry-and-report treatment", async () => {
    const ctx = makeContext({ deliver: () => Promise.reject(new Error("IPC gone")), connected: ["a"] });
    ctx.fleetConfig.instances = { sender: {}, a: {} };

    const { result } = await callTool("broadcast", ctx, { message: "all hands", targets: ["a"] });
    expect(result).toMatchObject({ queued: true, count: 1 });

    await vi.waitFor(() => expect(ctx.notifyInstanceTopic).toHaveBeenCalled());
    expect(ctx.deliverToInstance).toHaveBeenCalledTimes(3);
  });

  it("broadcast responds immediately and reports unreachable targets as failed", async () => {
    const ctx = makeContext({ deliver: neverSettles(), connected: ["a", "b"] });
    ctx.fleetConfig.instances = { sender: {}, a: {}, b: {} };
    const started = Date.now();

    const { result, error } = await callTool("broadcast", ctx, {
      message: "all hands", targets: ["a", "b", "ghost"],
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ queued: true, count: 2 });
    expect(result.sent_to).toEqual(["a", "b"]);
    expect(result.failed).toEqual(["ghost"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
