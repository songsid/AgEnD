import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outboundHandlers, setCrossInstanceRetryForTests } from "../src/outbound-handlers.js";
import { setLocale } from "../src/locale.js";

// Real retry intervals are 30s; keep tests snappy and let background retry chains
// finish inside the test instead of leaking timers past it.
beforeEach(() => setCrossInstanceRetryForTests({ retries: 2, intervalMs: 5 }));
afterEach(() => {
  setCrossInstanceRetryForTests(null);
  setLocale("en");
});

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
  it.each([
    ["send_to_instance", { instance_name: "target", message: "x".repeat(12_289) }],
    ["delegate_task", { target_instance: "target", task: "x".repeat(12_289) }],
    ["request_information", { target_instance: "target", question: "x".repeat(12_289) }],
    ["report_result", { target_instance: "target", summary: "x".repeat(12_289) }],
    ["broadcast", { targets: ["target"], message: "x".repeat(12_289) }],
  ])("%s rejects an oversized body synchronously", async (tool, args) => {
    setLocale("en");
    const ctx = makeContext({ deliver: neverSettles() });
    const { result, error } = await callTool(tool, ctx, args);
    expect(result).toBeNull();
    expect(error).toContain("12.0 KiB");
    expect(error).toContain("limit 12 KiB");
    expect(error).toContain("file path");
    expect(ctx.deliverToInstance).not.toHaveBeenCalled();
  });

  it("measures UTF-8 bytes and honors the configured limit", async () => {
    setLocale("zh-TW");
    const ctx = makeContext({ deliver: neverSettles() });
    ctx.fleetConfig.defaults.max_cross_instance_message_bytes = 8;
    const rejected = await callTool("send_to_instance", ctx, {
      instance_name: "target", message: "中文字", // 9 UTF-8 bytes
    });
    expect(rejected.result).toBeNull();
    expect(rejected.error).toContain("訊息過長");
    expect(rejected.error).toContain("9 B");
    expect(rejected.error).toContain("8 B");
    expect(ctx.deliverToInstance).not.toHaveBeenCalled();
    setLocale("en");
  });

  it("accepts a body exactly at the configured byte limit", async () => {
    const ctx = makeContext({ deliver: neverSettles() });
    ctx.fleetConfig.defaults.max_cross_instance_message_bytes = 8;
    const { result, error } = await callTool("send_to_instance", ctx, {
      instance_name: "target", message: "中文ab", // 8 UTF-8 bytes
    });
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ sent: true, queued: true });
    expect(ctx.deliverToInstance).toHaveBeenCalledOnce();
  });

  it("rejects an oversized assembled envelope before returning queued", async () => {
    const ctx = makeContext({ deliver: neverSettles() });
    ctx.fleetConfig.defaults.max_cross_instance_message_bytes = 20_000;
    const { result, error } = await callTool("send_to_instance", ctx, {
      instance_name: "target",
      message: "small",
      task_summary: "x".repeat(16_000),
    });
    expect(result).toBeNull();
    expect(error).toContain("assembled handoff too long");
    expect(ctx.deliverToInstance).not.toHaveBeenCalled();
  });

  it("rejects an oversized broadcast envelope before dispatching any target", async () => {
    const ctx = makeContext({ deliver: neverSettles(), connected: ["a", "b"] });
    ctx.fleetConfig.instances = { sender: {}, a: {}, b: {} };
    ctx.fleetConfig.defaults.max_cross_instance_message_bytes = 20_000;
    const { result, error } = await callTool("broadcast", ctx, {
      targets: ["a", "b"],
      message: "small",
      task_summary: "x".repeat(16_000),
    });
    expect(result).toBeNull();
    expect(error).toContain("assembled handoff too long");
    expect(ctx.deliverToInstance).not.toHaveBeenCalled();
  });

  it("send_to_instance responds immediately when the target is busy", async () => {
    const ctx = makeContext({ deliver: neverSettles() });
    const started = Date.now();

    const { result, error } = await callTool("send_to_instance", ctx, {
      instance_name: "target", message: "hello",
    });

    // The old code awaited the idle gate here and only answered after it timed out.
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ sent: true, queued: true, target: "target", target_state: "running" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(ctx.deliverToInstance).toHaveBeenCalledOnce();
  });

  it.each(["claude-code", "codex", "grok"])(
    "steers a supplement into a supported %s target without waiting for idle",
    async backend => {
      const ctx = makeContext({ deliver: neverSettles() });
      ctx.fleetConfig.instances.target.backend = backend;

      const { result, error } = await callTool("send_to_instance", ctx, {
        instance_name: "target", message: "correction", steer: true,
      });

      expect(error).toBeUndefined();
      expect(result).toMatchObject({ sent: true, queued: true, delivery_mode: "steer" });
      expect(result).not.toHaveProperty("warning");
      expect(ctx.deliverToInstance).toHaveBeenCalledWith(
        "target",
        expect.objectContaining({
          type: "steer",
          targetSession: "target",
          content: "correction",
          meta: expect.objectContaining({ from_instance: "sender" }),
        }),
        { isCrossInstance: true, waitForIdle: false },
      );
    },
  );

  it.each(["kiro-cli", "antigravity", "opencode", "gemini-cli"])(
    "safely queues a requested steer for unsupported %s and tells the sender",
    async backend => {
      const ctx = makeContext({ deliver: neverSettles() });
      ctx.fleetConfig.instances.target.backend = backend;

      const { result, error } = await callTool("send_to_instance", ctx, {
        instance_name: "target", message: "correction", steer: true,
      });

      expect(error).toBeUndefined();
      expect(result).toMatchObject({ sent: true, queued: true, delivery_mode: "idle_queue" });
      expect(result.warning).toContain(`'${backend}' backend cannot accept mid-turn input`);
      expect(result.warning).toContain("safely queued for idle delivery");
      expect(ctx.deliverToInstance).toHaveBeenCalledWith(
        "target",
        expect.objectContaining({ type: "fleet_inbound", content: "correction" }),
      );
    },
  );

  it("queues instead of guessing when the target backend cannot be confirmed", async () => {
    const ctx = makeContext({ deliver: neverSettles() });
    ctx.fleetConfig = null;

    const { result, error } = await callTool("send_to_instance", ctx, {
      instance_name: "target", message: "correction", steer: true,
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ sent: true, queued: true, delivery_mode: "idle_queue" });
    expect(result.warning).toContain("target backend could not be confirmed");
    expect(ctx.deliverToInstance).toHaveBeenCalledWith(
      "target",
      expect.objectContaining({ type: "fleet_inbound", content: "correction" }),
    );
  });

  it("preserves both the steer fallback and target-state warnings", async () => {
    const ctx = makeContext({ deliver: neverSettles() });
    ctx.fleetConfig.instances.target.backend = "kiro-cli";
    ctx.lifecycle.daemons.set("target", {
      isErrorState: true,
      isCrashLoop: false,
      lastErrorType: "auth_error",
    });

    const { result, error } = await callTool("send_to_instance", ctx, {
      instance_name: "target", message: "correction", steer: true,
    });

    expect(error).toBeUndefined();
    expect(result.warning).toContain("cannot accept mid-turn input");
    expect(result.warning).toContain("authentication error");
  });

  it("falls back for external sessions instead of steering the hosting pane", async () => {
    const ctx = makeContext({ deliver: neverSettles() });
    ctx.fleetConfig.instances.target.backend = "claude-code";
    ctx.sessionRegistry.set("teammate", "target");

    const { result, error } = await callTool("send_to_instance", ctx, {
      instance_name: "teammate", message: "correction", steer: true,
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ sent: true, queued: true, delivery_mode: "idle_queue" });
    expect(result.warning).toContain("external sessions cannot be targeted safely");
    expect(ctx.deliverToInstance).toHaveBeenCalledWith(
      "target",
      expect.objectContaining({
        type: "fleet_inbound",
        targetSession: "teammate",
        content: "correction",
      }),
    );
  });

  it("queues a steer behind an earlier idle-gated delivery instead of overtaking it", async () => {
    const ctx = makeContext({ deliver: neverSettles() });
    ctx.fleetConfig.instances.target.backend = "claude-code";
    ctx.hasPendingIdleGatedDelivery = vi.fn(() => true);

    const { result, error } = await callTool("send_to_instance", ctx, {
      instance_name: "target", message: "supplement", steer: true,
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ sent: true, queued: true, delivery_mode: "idle_queue" });
    expect(result.warning).toContain("previous message to this target is still queued");
    expect(result.warning).toContain("would overtake it");
    expect(ctx.deliverToInstance).toHaveBeenCalledWith(
      "target",
      expect.objectContaining({ type: "fleet_inbound", content: "supplement" }),
    );
  });

  it.each([undefined, false])("keeps ordinary delivery unchanged when steer is %s", async steer => {
    const ctx = makeContext({ deliver: neverSettles() });
    const args: Record<string, unknown> = { instance_name: "target", message: "new task" };
    if (steer !== undefined) args.steer = steer;

    const { result, error } = await callTool("send_to_instance", ctx, args);

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ sent: true, queued: true });
    expect(result).not.toHaveProperty("delivery_mode");
    expect(result).not.toHaveProperty("warning");
    expect(ctx.deliverToInstance).toHaveBeenCalledWith(
      "target",
      expect.objectContaining({ type: "fleet_inbound", content: "new task" }),
    );
  });

  it("forwards delegate_task steer through the shared send path", async () => {
    const ctx = makeContext({ deliver: neverSettles() });
    ctx.fleetConfig.instances.target.backend = "claude-code";

    const { result, error } = await callTool("delegate_task", ctx, {
      target_instance: "target", task: "add this constraint", steer: true,
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ sent: true, queued: true, delivery_mode: "steer" });
    expect(ctx.deliverToInstance).toHaveBeenCalledWith(
      "target",
      expect.objectContaining({
        type: "steer",
        content: "add this constraint",
        meta: expect.objectContaining({ request_kind: "task", requires_reply: "true" }),
      }),
      { isCrossInstance: true, waitForIdle: false },
    );
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

  it("reports a paused target and that the delivery facade will wake it", async () => {
    const ctx = makeContext({ deliver: neverSettles() });
    (ctx.lifecycle.isPaused as ReturnType<typeof vi.fn>).mockImplementation((name: string) => name === "target");

    const { result, error } = await callTool("delegate_task", ctx, {
      target_instance: "target", task: "wake me first",
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      sent: true,
      queued: true,
      target: "target",
      target_state: "paused",
      waking: true,
    });
  });

  it("does not queue a crashed target even when stale IPC remains", async () => {
    const ctx = makeContext({ deliver: neverSettles() });
    ctx.getInstanceStatus = vi.fn(() => "crashed");

    const { result, error } = await callTool("send_to_instance", ctx, {
      instance_name: "target", message: "do not send",
    });

    expect(result).toBeNull();
    expect(error).toContain("target_state=crashed");
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
