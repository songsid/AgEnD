import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend } from "../src/backend/factory.js";
import { CLEAR_UNSUPPORTED_MSG, TopicCommands } from "../src/topic-commands.js";
import type { InboundMessage } from "../src/channel/types.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";

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

  it("describes Kiro's destructive clear confirmation precisely", () => {
    const dialog = createBackend("kiro-cli", "/tmp/agend-clear-test").getClearConfirmationDialog?.();
    expect(dialog?.pattern.test(
      "Are you sure?\nThis will erase the conversation history and cannot be undone.\n[y/n]:",
    )).toBe(true);
    expect(dialog?.pattern.test("Install package? [y/n]:")).toBe(false);
    expect(dialog?.keys).toEqual(["y", "Enter"]);
  });
});

describe("/clear topic command", () => {
  function setup(backend = "codex") {
    const ipcSend = vi.fn();
    const promptClearConfirmation = vi.fn().mockResolvedValue(null);
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
      promptClearConfirmation,
    } as any);
    return { commands, ipcSend, promptClearConfirmation, sendText };
  }

  it("asks for confirmation without touching IPC for an admin", async () => {
    const { commands, ipcSend, promptClearConfirmation } = setup();

    expect(await commands.handleInstanceCommand(inbound("admin"), "worker")).toBe(true);
    expect(promptClearConfirmation).toHaveBeenCalledWith(
      "worker",
      "topic-1",
      expect.any(Object),
      "fleet-chat",
      "topic-1",
    );
    expect(ipcSend).not.toHaveBeenCalled();
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

  it("arms terminal confirmation only for Kiro", async () => {
    const { commands, ipcSend } = setup("kiro-cli");

    expect(await commands.sendClear("worker")).toContain("/clear");
    expect(ipcSend).toHaveBeenCalledWith({
      type: "raw_paste",
      content: "/clear",
      confirm_clear: true,
    });
  });
});

describe("/clear nonce confirmation", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agend-clear-confirm-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setLocale("en");
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(type: "telegram" | "discord" = "telegram") {
    const ipcSend = vi.fn();
    const notifyAlert = vi.fn().mockResolvedValue({
      messageId: "clear-message",
      chatId: "fleet-group",
      threadId: "worker-topic",
    });
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      id: `${type}-main`,
      type,
      notifyAlert,
      editMessageRemoveButtons,
      editMessage,
      sendText: vi.fn().mockResolvedValue({ messageId: "notice", chatId: "fleet-group" }),
    } as any;
    const fm = new FleetManager(dir);
    fm.fleetConfig = {
      defaults: {},
      channels: [{
        id: `${type}-main`,
        type,
        mode: "topic",
        group_id: "fleet-group",
        bot_token_env: "TEST_TOKEN",
        access: { mode: "locked", allowed_users: ["admin"] },
      }],
      instances: {
        worker: { backend: "codex", topic_id: "worker-topic", working_directory: dir },
      },
    } as any;
    fm.adapter = adapter;
    fm.worlds.set(`${type}-main`, {
      id: `${type}-main`,
      adapter,
      groupId: "fleet-group",
      channelConfig: fm.fleetConfig.channels![0],
    } as any);
    fm.instanceIpcClients.set("worker", { connected: true, send: ipcSend } as any);
    return { fm, adapter, ipcSend, notifyAlert, editMessageRemoveButtons, editMessage };
  }

  function callback(id: string, type: "telegram" | "discord" = "telegram", userId = "admin") {
    return {
      callbackData: id,
      chatId: "fleet-group",
      threadId: "worker-topic",
      messageId: "clear-message",
      userId,
    };
  }

  it.each(["telegram", "discord"] as const)("posts localized inline buttons through the %s adapter", async (type) => {
    setLocale("zh-TW");
    const { fm, adapter, ipcSend, notifyAlert } = setup(type);

    expect(await fm.promptClearConfirmation(
      "worker", "worker-topic", adapter, "fleet-group", "worker-topic",
    )).toBeNull();

    expect(notifyAlert).toHaveBeenCalledWith(
      "fleet-group",
      expect.objectContaining({
        type: "clear_confirm",
        instanceName: "worker",
        message: "⚠️ 確定要清空 worker 的對話記錄嗎？此操作不可逆。",
        choices: [
          expect.objectContaining({ label: "✅ 確認清空" }),
          expect.objectContaining({ label: "❌ 取消" }),
        ],
      }),
      { threadId: "worker-topic" },
    );
    const ids = notifyAlert.mock.calls[0][1].choices.map((choice: { id: string }) => choice.id);
    expect(ids[0]).toMatch(/^clear-confirm:[0-9a-f]{32}:confirm$/);
    expect(ids[1]).toMatch(/^clear-confirm:[0-9a-f]{32}:cancel$/);
    expect(ipcSend).not.toHaveBeenCalled();
  });

  it("sends raw_paste only after an authorized Confirm, and consumes it once", async () => {
    const { fm, adapter, ipcSend, notifyAlert, editMessage } = setup();
    await fm.promptClearConfirmation(
      "worker", "worker-topic", adapter, "fleet-group", "worker-topic",
    );
    const confirmId = notifyAlert.mock.calls[0][1].choices[0].id as string;

    await (fm as any).handleClearConfirmation(callback(confirmId), "telegram-main");
    await (fm as any).handleClearConfirmation(callback(confirmId), "telegram-main");

    expect(ipcSend).toHaveBeenCalledOnce();
    expect(ipcSend).toHaveBeenCalledWith({ type: "raw_paste", content: "/clear" });
    expect(editMessage).toHaveBeenCalledWith(
      "fleet-group",
      "clear-message",
      "🧹 Clear command sent (`/clear`).",
      "worker-topic",
    );
  });

  it("Cancel removes the buttons without sending the clear command", async () => {
    const { fm, adapter, ipcSend, notifyAlert, editMessageRemoveButtons } = setup();
    await fm.promptClearConfirmation(
      "worker", "worker-topic", adapter, "fleet-group", "worker-topic",
    );
    const cancelId = notifyAlert.mock.calls[0][1].choices[1].id as string;

    await (fm as any).handleClearConfirmation(callback(cancelId), "telegram-main");

    expect(ipcSend).not.toHaveBeenCalled();
    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "fleet-group",
      "clear-message",
      "❌ Clear cancelled for worker.",
      "worker-topic",
    );
  });

  it("expires after 15 seconds and cannot clear on a late click", async () => {
    vi.useFakeTimers();
    const { fm, adapter, ipcSend, notifyAlert, editMessageRemoveButtons } = setup();
    await fm.promptClearConfirmation(
      "worker", "worker-topic", adapter, "fleet-group", "worker-topic",
    );
    const confirmId = notifyAlert.mock.calls[0][1].choices[0].id as string;

    await vi.advanceTimersByTimeAsync(15_000);
    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "fleet-group",
      "clear-message",
      "⌛ Clear confirmation for worker expired.",
      "worker-topic",
    );

    await (fm as any).handleClearConfirmation(callback(confirmId), "telegram-main");
    expect(ipcSend).not.toHaveBeenCalled();
  });

  it("a non-admin click does not consume the confirmation", async () => {
    const { fm, adapter, ipcSend, notifyAlert } = setup();
    await fm.promptClearConfirmation(
      "worker", "worker-topic", adapter, "fleet-group", "worker-topic",
    );
    const confirmId = notifyAlert.mock.calls[0][1].choices[0].id as string;

    await (fm as any).handleClearConfirmation(callback(confirmId, "telegram", "user"), "telegram-main");
    expect(ipcSend).not.toHaveBeenCalled();
    await (fm as any).handleClearConfirmation(callback(confirmId), "telegram-main");
    expect(ipcSend).toHaveBeenCalledOnce();
  });

  it("allows an authorized Classic admin to confirm in the Classic channel", async () => {
    const { fm, adapter, ipcSend, notifyAlert } = setup();
    fm.fleetConfig!.defaults.backend = "codex";
    (fm as any).classicChannels = {
      getChannelIdByInstance: (name: string) => name === "classic-worker" ? "classic-room" : undefined,
      getBackendByInstance: () => "codex",
      getInstanceByChannel: (channelId: string) => channelId === "classic-room" ? "classic-worker" : undefined,
      isAdmin: (userId: string) => userId === "classic-admin",
    };
    fm.instanceIpcClients.set("classic-worker", { connected: true, send: ipcSend } as any);
    await fm.promptClearConfirmation(
      "classic-worker", "classic-room", adapter, "classic-room",
    );
    const confirmId = notifyAlert.mock.calls[0][1].choices[0].id as string;

    await (fm as any).handleClearConfirmation({
      callbackData: confirmId,
      chatId: "classic-room",
      messageId: "clear-message",
      userId: "classic-admin",
    }, "telegram-main");

    expect(ipcSend).toHaveBeenCalledWith({ type: "raw_paste", content: "/clear" });
  });
});
