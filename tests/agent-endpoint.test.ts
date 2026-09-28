import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchAgentOperation, readPersistedReplyContext } from "../src/agent-endpoint.js";

describe("agent CLI reply context", () => {
  it.each([
    ["send", { instance_name: "worker", message: "hello" }],
    ["broadcast", { targets: ["worker"], message: "hello" }],
  ])("assigns a durable operation_id for HTTP %s ingress without MCP metadata", async (op, args) => {
    const admitDurableDelivery = vi.fn(input => ({ deliveryId: "delivery-http", state: "queued", duplicate: false }));
    const ctx = {
      fleetConfig: { defaults: {}, instances: { agy: { tool_set: "worker" }, worker: {} } },
      instanceIpcClients: new Map([["worker", { connected: true }]]),
      sessionRegistry: new Map(),
      lifecycle: { daemons: new Map() },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      getInstanceStatus: () => "running",
      getDaemonBootId: () => "http-source-boot",
      admitDurableDelivery,
      eventLog: { logActivity: vi.fn() },
      queueMirrorMessage: vi.fn(),
    } as any;

    const result = await dispatchAgentOperation(ctx, "agy", op, args as Record<string, unknown>);

    expect(result).toMatchObject({ operation_id: expect.any(String), durable: true, delivery_state: "queued" });
    expect(admitDurableDelivery).toHaveBeenCalled();
    expect(admitDurableDelivery).toHaveBeenCalledWith(expect.objectContaining({
      operationId: (result as any).operation_id,
      sourceDaemonBootId: "http-source-boot",
      sourceInstance: "agy",
      targetInstance: "worker",
    }));
  });

  it("returns the generated operation_id when HTTP admission fails closed", async () => {
    const ctx = {
      fleetConfig: { defaults: {}, instances: { agy: { tool_set: "worker" }, worker: {} } },
      instanceIpcClients: new Map([["worker", { connected: true }]]),
      sessionRegistry: new Map(),
      lifecycle: { daemons: new Map() },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      getInstanceStatus: () => "running",
      getDaemonBootId: () => "http-source-boot",
      admitDurableDelivery: vi.fn(() => { throw new Error("sqlite full"); }),
    } as any;

    const result = await dispatchAgentOperation(ctx, "agy", "send", { instance_name: "worker", message: "hello" });

    expect(result).toMatchObject({ operation_id: expect.any(String), error: expect.stringContaining("sqlite full") });
  });

  it("reads the daemon's persisted chat, thread, and adapter", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-agent-context-"));
    const instanceDir = join(dataDir, "instances", "agy");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "last-chat.json"), JSON.stringify({
      chatId: "source-chat", threadId: "source-thread", adapterId: "discord-persona",
    }));
    expect(readPersistedReplyContext(dataDir, "agy")).toEqual({
      chatId: "source-chat", threadId: "source-thread", adapterId: "discord-persona",
    });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("routes reply to persisted source context instead of configured fallback", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-agent-reply-"));
    const instanceDir = join(dataDir, "instances", "agy");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "last-chat.json"), JSON.stringify({
      chatId: "source-chat", threadId: "source-thread", adapterId: "discord-persona",
    }));
    const sourceAdapter = { sendText: vi.fn().mockResolvedValue({ messageId: "sent-1" }) };
    const fallbackAdapter = { sendText: vi.fn() };
    const clearCancelButton = vi.fn();
    const ctx = {
      dataDir,
      fleetConfig: {
        channel: { group_id: "configured-chat" },
        instances: { agy: { topic_id: "configured-thread" } },
      },
      adapters: new Map([["discord-persona", sourceAdapter]]),
      adapter: fallbackAdapter,
      getAdapterForInstance: () => fallbackAdapter,
      getGroupIdForInstance: () => "configured-chat",
      classicChannels: null,
      clearCancelButton,
    } as any;

    const result = await dispatchAgentOperation(ctx, "agy", "reply", { text: "test" });
    expect(result).toEqual({ messageId: "sent-1" });
    expect(sourceAdapter.sendText).toHaveBeenCalledWith("source-chat", "test", {
      threadId: "source-thread", replyTo: undefined, format: undefined,
    });
    expect(fallbackAdapter.sendText).not.toHaveBeenCalled();
    expect(clearCancelButton).toHaveBeenCalledWith("agy");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("uses a ClassicBot channel as an unthreaded reply target", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-agent-classic-"));
    const adapter = { sendText: vi.fn().mockResolvedValue({ messageId: "sent-2" }) };
    const ctx = {
      dataDir,
      fleetConfig: { channel: { group_id: "guild" }, instances: {} },
      adapter,
      getAdapterForInstance: () => adapter,
      getGroupIdForInstance: () => "guild",
      classicChannels: { getChannelIdByInstance: () => "classic-channel" },
    } as any;

    await dispatchAgentOperation(ctx, "classic-1", "reply", { text: "test" });
    expect(adapter.sendText).toHaveBeenCalledWith("classic-channel", "test", {
      threadId: undefined, replyTo: undefined, format: undefined,
    });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("fails fast when no inbound or configured reply context exists", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-agent-empty-"));
    const result = await dispatchAgentOperation({
      dataDir,
      fleetConfig: { instances: {} },
      adapter: { sendText: vi.fn() },
      classicChannels: null,
    } as any, "agy", "reply", { text: "test" });
    expect(result).toEqual({ error: "No active chat context — awaiting inbound message" });
    rmSync(dataDir, { recursive: true, force: true });
  });
});
