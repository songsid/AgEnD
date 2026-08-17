import { describe, expect, it, vi } from "vitest";
import { TopicCommands } from "../src/topic-commands.js";
import type { InboundMessage } from "../src/channel/types.js";

function inbound(text: string, userId = "someone"): InboundMessage {
  return {
    source: "discord",
    adapterId: "discord-main",
    chatId: "fleet-chat",
    threadId: "topic-1",
    messageId: "message-1",
    userId,
    username: userId,
    text,
    timestamp: new Date(),
    isBotMessage: false,
  };
}

function setup() {
  const ipcSend = vi.fn();
  const sendText = vi.fn().mockResolvedValue({ messageId: "reply", chatId: "fleet-chat" });
  const commands = new TopicCommands({
    adapter: { sendText },
    adapters: new Map(),
    fleetConfig: {
      defaults: {},
      instances: { worker: { backend: "codex", working_directory: "/tmp" } },
    },
    instanceIpcClients: new Map([
      ["worker", { connected: true, send: ipcSend }],
    ]),
    getDeliveryEpoch: () => 11,
    isFleetAdmin: (userId: string) => userId === "admin",
  } as any);
  return { commands, ipcSend, sendText };
}

describe("/steer topic command", () => {
  it("sends a steer IPC payload carrying the full inbound meta", async () => {
    const { commands, ipcSend } = setup();

    expect(await commands.handleInstanceCommand(inbound("/steer focus on the tests first"), "worker")).toBe(true);
    expect(ipcSend).toHaveBeenCalledOnce();
    const payload = ipcSend.mock.calls[0][0];
    expect(payload.type).toBe("steer");
    expect(payload.content).toBe("focus on the tests first");
    expect(payload.delivery_epoch).toBe(11);
    // The daemon formats a steer through the SAME inbound wrapper as a queued
    // message (#528 trap 6) — that only works if the meta actually arrives.
    expect(payload.meta).toMatchObject({
      chat_id: "fleet-chat",
      message_id: "message-1",
      user: "someone",
      user_id: "someone",
      thread_id: "topic-1",
      adapter_id: "discord-main",
      source: "discord",
    });
  });

  it("is NOT admin-gated — steering adds direction, it destroys nothing", async () => {
    const { commands, ipcSend, sendText } = setup();

    expect(await commands.handleInstanceCommand(inbound("/steer x", "random-user"), "worker")).toBe(true);
    expect(ipcSend).toHaveBeenCalledOnce();
    expect(String(sendText.mock.calls[0][1])).not.toContain("Permission denied");
  });

  it("shows usage when the message is empty", async () => {
    const { commands, ipcSend, sendText } = setup();

    expect(await commands.handleInstanceCommand(inbound("/steer"), "worker")).toBe(true);
    expect(ipcSend).not.toHaveBeenCalled();
    expect(String(sendText.mock.calls[0][1])).toContain("/steer");
  });

  it("reports a disconnected instance instead of dropping the steer silently", async () => {
    const ipcSend = vi.fn();
    const sendText = vi.fn().mockResolvedValue({ messageId: "r", chatId: "c" });
    const commands = new TopicCommands({
      adapter: { sendText },
      adapters: new Map(),
      fleetConfig: { defaults: {}, instances: { worker: {} } },
      instanceIpcClients: new Map([["worker", { connected: false, send: ipcSend }]]),
      isFleetAdmin: () => false,
    } as any);

    expect(await commands.handleInstanceCommand(inbound("/steer hello"), "worker")).toBe(true);
    expect(ipcSend).not.toHaveBeenCalled();
    expect(String(sendText.mock.calls[0][1])).toContain("❌");
  });

  it.each(["kiro-cli", "opencode", "antigravity"])(
    "tells the user plainly that %s does not support /steer, and sends nothing",
    async (backend) => {
      const ipcSend = vi.fn();
      const sendText = vi.fn().mockResolvedValue({ messageId: "r", chatId: "c" });
      const commands = new TopicCommands({
        adapter: { sendText },
        adapters: new Map(),
        fleetConfig: { defaults: {}, instances: { worker: { backend, working_directory: "/tmp" } } },
        instanceIpcClients: new Map([["worker", { connected: true, send: ipcSend }]]),
        isFleetAdmin: () => false,
      } as any);

      expect(await commands.handleInstanceCommand(inbound("/steer do it"), "worker")).toBe(true);
      // An honest refusal, not a silent queue fallback masquerading as a steer.
      expect(ipcSend).not.toHaveBeenCalled();
      expect(String(sendText.mock.calls[0][1])).toContain("not supported");
    },
  );

  it("handles the /steer@botname form", async () => {
    const { commands, ipcSend } = setup();
    expect(await commands.handleInstanceCommand(inbound("/steer@agend do it"), "worker")).toBe(true);
    expect(ipcSend.mock.calls[0][0].content).toBe("do it");
  });
});
