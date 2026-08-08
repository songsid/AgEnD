import { describe, expect, it, vi } from "vitest";
import { createBackend } from "../src/backend/factory.js";
import { CLEAR_UNSUPPORTED_MSG, TopicCommands } from "../src/topic-commands.js";
import type { InboundMessage } from "../src/channel/types.js";

function inbound(userId: string): InboundMessage {
  return {
    source: "telegram",
    adapterId: "telegram-main",
    chatId: "fleet-chat",
    threadId: "topic-1",
    messageId: "message-1",
    userId,
    username: userId,
    text: "/clear",
    timestamp: new Date(),
    isBotMessage: false,
  };
}

describe("backend clear commands", () => {
  it.each([
    ["claude-code", "/clear"],
    ["codex", "/clear"],
    ["kiro-cli", "/clear"],
    ["antigravity", "/clear"],
    ["opencode", "/clear"],
    ["grok", "/new"],
    ["mock", "/clear"],
  ])("%s exposes its verified full-reset command", (name, expected) => {
    expect(createBackend(name, "/tmp/agend-clear-test").getClearCommand()).toBe(expected);
  });

  it("keeps deprecated gemini-cli explicitly unsupported", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createBackend("gemini-cli", "/tmp/agend-clear-test").getClearCommand()).toBeNull();
    warn.mockRestore();
  });
});

describe("/clear topic command", () => {
  function setup(backend = "codex") {
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
        ["worker", { connected: true, send: ipcSend }],
      ]),
      isFleetAdmin: (userId: string) => userId === "admin",
    } as any);
    return { commands, ipcSend, sendText };
  }

  it("sends the reset through raw_paste for an admin", async () => {
    const { commands, ipcSend } = setup();

    expect(await commands.handleInstanceCommand(inbound("admin"), "worker")).toBe(true);
    expect(ipcSend).toHaveBeenCalledOnce();
    expect(ipcSend).toHaveBeenCalledWith({ type: "raw_paste", content: "/clear" });
  });

  it("denies a non-admin before touching IPC", async () => {
    const { commands, ipcSend, sendText } = setup();

    expect(await commands.handleInstanceCommand(inbound("user"), "worker")).toBe(true);
    expect(ipcSend).not.toHaveBeenCalled();
    expect(sendText.mock.calls[0][1]).toContain("Permission denied");
  });

  it("reports unsupported backends without sending anything", async () => {
    const { commands, ipcSend } = setup("gemini-cli");

    expect(await commands.sendClear("worker")).toBe(CLEAR_UNSUPPORTED_MSG);
    expect(ipcSend).not.toHaveBeenCalled();
  });
});
