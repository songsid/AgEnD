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

function setup(backend = "claude-code", connected = true) {
  const ipcSend = vi.fn();
  const sendText = vi.fn().mockResolvedValue({ messageId: "reply", chatId: "fleet-chat" });
  const commands = new TopicCommands({
    adapter: { sendText },
    adapters: new Map(),
    fleetConfig: {
      defaults: {},
      instances: { worker: { backend, working_directory: "/tmp" } },
    },
    instanceIpcClients: new Map([
      ["worker", { connected, send: ipcSend }],
    ]),
    isFleetAdmin: () => false,
  } as any);
  return { commands, ipcSend, sendText };
}

describe("/btw topic command", () => {
  it("sends a raw-side-question IPC payload to Claude Code with full reply metadata", async () => {
    const { commands, ipcSend } = setup();

    expect(await commands.handleInstanceCommand(inbound("/btw what changed?"), "worker")).toBe(true);
    expect(ipcSend).toHaveBeenCalledOnce();
    expect(ipcSend).toHaveBeenCalledWith({
      type: "btw",
      content: "what changed?",
      meta: {
        chat_id: "fleet-chat",
        message_id: "message-1",
        user: "someone",
        user_id: "someone",
        thread_id: "topic-1",
        adapter_id: "discord-main",
        source: "discord",
      },
    });
  });

  it("is not admin-gated", async () => {
    const { commands, ipcSend, sendText } = setup();
    expect(await commands.handleInstanceCommand(inbound("/btw hello", "random-user"), "worker")).toBe(true);
    expect(ipcSend).toHaveBeenCalledOnce();
    expect(String(sendText.mock.calls[0][1])).not.toContain("Permission denied");
  });

  it("shows usage for an empty question", async () => {
    const { commands, ipcSend, sendText } = setup();
    expect(await commands.handleInstanceCommand(inbound("/btw"), "worker")).toBe(true);
    expect(ipcSend).not.toHaveBeenCalled();
    expect(String(sendText.mock.calls[0][1])).toContain("/btw");
  });

  it.each(["codex", "kiro-cli", "opencode", "grok", "antigravity"])(
    "refuses %s without sending anything",
    async (backend) => {
      const { commands, ipcSend, sendText } = setup(backend);
      expect(await commands.handleInstanceCommand(inbound("/btw hello"), "worker")).toBe(true);
      expect(ipcSend).not.toHaveBeenCalled();
      expect(String(sendText.mock.calls[0][1])).toContain("Claude Code only");
    },
  );

  it("reports a disconnected Claude instance", async () => {
    const { commands, ipcSend, sendText } = setup("claude-code", false);
    expect(await commands.handleInstanceCommand(inbound("/btw hello"), "worker")).toBe(true);
    expect(ipcSend).not.toHaveBeenCalled();
    expect(String(sendText.mock.calls[0][1])).toContain("❌");
  });

  it("handles the /btw@botname form", async () => {
    const { commands, ipcSend } = setup();
    expect(await commands.handleInstanceCommand(inbound("/btw@agend hello"), "worker")).toBe(true);
    expect(ipcSend.mock.calls[0][0].content).toBe("hello");
  });
});
