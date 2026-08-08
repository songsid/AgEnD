import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";

describe("interactive prompt General assistance", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agend-interactive-assist-"));
  });

  afterEach(() => {
    setLocale("en");
    rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const sendText = vi.fn().mockResolvedValue({ messageId: "instance-notice", chatId: "fleet-group" });
    const notifyAlert = vi.fn().mockResolvedValue({
      messageId: "assist-message",
      chatId: "fleet-group",
      threadId: "general-topic",
    });
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      id: "telegram-main",
      type: "telegram",
      sendText,
      notifyAlert,
      editMessageRemoveButtons,
      editMessage,
    } as any;
    const fm = new FleetManager(dir);
    fm.fleetConfig = {
      defaults: {},
      channels: [{
        id: "telegram-main",
        type: "telegram",
        mode: "topic",
        group_id: "fleet-group",
        bot_token_env: "TEST_TOKEN",
        access: { mode: "locked", allowed_users: ["admin"] },
      }],
      instances: {
        general: { general_topic: true, topic_id: "general-topic", working_directory: dir },
        worker: { topic_id: "worker-topic", working_directory: dir },
      },
    } as any;
    fm.adapter = adapter;
    fm.worlds.set("telegram-main", {
      id: "telegram-main",
      adapter,
      groupId: "fleet-group",
      channelConfig: fm.fleetConfig.channels![0],
    } as any);
    // findGeneralInstance intentionally requires a live coordinator.
    fm.lifecycle.daemons.set("general", {} as any);
    const ipcSend = vi.fn().mockReturnValue(true);
    fm.instanceIpcClients.set("general", { connected: true, send: ipcSend } as any);
    (fm as any).cacheInstanceExecutionState("general", {
      state: "idle",
      observedAt: Date.now(),
      stateChangedAt: Date.now(),
      unchangedForMs: 1_000,
    });
    return { fm, adapter, sendText, notifyAlert, editMessageRemoveButtons, editMessage, ipcSend };
  }

  function callback(id: string, userId = "admin") {
    return {
      callbackData: id,
      chatId: "fleet-group",
      threadId: "general-topic",
      messageId: "assist-message",
      userId,
    };
  }

  it("posts localized controls in General and a plain notice in the blocked topic", async () => {
    setLocale("zh-TW");
    const { fm, sendText, notifyAlert } = setup();

    await fm.notifyInteractivePrompt("worker", "sudo_password");

    expect(sendText).toHaveBeenCalledWith(
      "fleet-group",
      expect.stringContaining("請至 General channel"),
      { threadId: "worker-topic" },
    );
    expect(notifyAlert).toHaveBeenCalledWith(
      "fleet-group",
      expect.objectContaining({
        type: "interactive_prompt",
        instanceName: "worker",
        message: expect.stringMatching(/worker.*sudo 密碼.*General/s),
        choices: [
          expect.objectContaining({ label: "確認" }),
          expect.objectContaining({ label: "取消" }),
        ],
      }),
      { threadId: "general-topic" },
    );
  });

  it("routes controls to the General in the blocked instance's TG/DC world", async () => {
    const fm = new FleetManager(dir);
    const primaryAlert = vi.fn().mockResolvedValue({ messageId: "dc-alert", chatId: "dc-guild", threadId: "dc-general" });
    const secondaryAlert = vi.fn().mockResolvedValue({ messageId: "tg-alert", chatId: "tg-group", threadId: "tg-general" });
    const adapter = (id: string, type: string, notifyAlert: ReturnType<typeof vi.fn>) => ({
      id, type, notifyAlert,
      sendText: vi.fn().mockResolvedValue({ messageId: "notice", chatId: type === "telegram" ? "tg-group" : "dc-guild" }),
      editMessageRemoveButtons: vi.fn().mockResolvedValue(undefined),
      editMessage: vi.fn().mockResolvedValue(undefined),
    }) as any;
    const dc = adapter("discord-main", "discord", primaryAlert);
    const tg = adapter("telegram-secondary", "telegram", secondaryAlert);
    const dcConfig = { id: "discord-main", type: "discord", mode: "topic", group_id: "dc-guild", access: { mode: "locked", allowed_users: ["admin"] } } as any;
    const tgConfig = { id: "telegram-secondary", type: "telegram", mode: "topic", group_id: "tg-group", access: { mode: "locked", allowed_users: ["admin"] } } as any;
    fm.fleetConfig = {
      defaults: {}, channels: [dcConfig, tgConfig],
      instances: {
        "general-dc": { general_topic: true, channel_id: "discord-main", topic_id: "dc-general", working_directory: dir },
        "general-tg": { general_topic: true, channel_id: "telegram-secondary", topic_id: "tg-general", working_directory: dir },
        worker: { channel_id: "telegram-secondary", topic_id: "worker-topic", working_directory: dir },
      },
    } as any;
    fm.adapter = dc;
    fm.worlds.set("discord-main", { id: "discord-main", adapter: dc, groupId: "dc-guild", channelConfig: dcConfig } as any);
    fm.worlds.set("telegram-secondary", { id: "telegram-secondary", adapter: tg, groupId: "tg-group", channelConfig: tgConfig } as any);
    fm.lifecycle.daemons.set("general-dc", {} as any);
    fm.lifecycle.daemons.set("general-tg", {} as any);

    await fm.notifyInteractivePrompt("worker", "confirmation");

    expect(secondaryAlert).toHaveBeenCalledWith(
      "tg-group",
      expect.objectContaining({ instanceName: "worker" }),
      { threadId: "tg-general" },
    );
    expect(primaryAlert).not.toHaveBeenCalled();
  });

  it("atomically consumes Confirm and injects one routed message into General", async () => {
    const { fm, notifyAlert, editMessageRemoveButtons, ipcSend } = setup();
    await fm.notifyInteractivePrompt("worker", "confirmation");
    const alert = notifyAlert.mock.calls[0][1];
    const confirmId = alert.choices[0].id as string;

    await (fm as any).handleInteractivePromptAssist(callback(confirmId), "telegram-main");
    await (fm as any).handleInteractivePromptAssist(callback(confirmId), "telegram-main");

    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "fleet-group",
      "assist-message",
      expect.stringContaining("General assistance requested"),
      "general-topic",
    );
    expect(ipcSend).toHaveBeenCalledOnce();
    expect(ipcSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "fleet_inbound",
      targetSession: "general",
      content: expect.stringMatching(/worker.*Y\/N confirmation.*explicit authorization/s),
      meta: expect.objectContaining({
        chat_id: "fleet-group",
        thread_id: "general-topic",
        adapter_id: "telegram-main",
      }),
    }));
  });

  it("Cancel removes controls without delivering to General", async () => {
    const { fm, notifyAlert, editMessageRemoveButtons, ipcSend } = setup();
    await fm.notifyInteractivePrompt("worker", "press_enter");
    const cancelId = notifyAlert.mock.calls[0][1].choices[1].id as string;

    await (fm as any).handleInteractivePromptAssist(callback(cancelId), "telegram-main");

    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "fleet-group",
      "assist-message",
      expect.stringContaining("ignored"),
      "general-topic",
    );
    expect(ipcSend).not.toHaveBeenCalled();
  });

  it("still delivers Confirm when removing the buttons fails", async () => {
    const { fm, notifyAlert, editMessageRemoveButtons, ipcSend } = setup();
    await fm.notifyInteractivePrompt("worker", "confirmation");
    const confirmId = notifyAlert.mock.calls[0][1].choices[0].id as string;
    editMessageRemoveButtons.mockRejectedValueOnce(new Error("edit unavailable"));

    await (fm as any).handleInteractivePromptAssist(callback(confirmId), "telegram-main");

    expect(ipcSend).toHaveBeenCalledOnce();
  });

  it("rejects a non-admin click without consuming the valid button", async () => {
    const { fm, notifyAlert, ipcSend } = setup();
    await fm.notifyInteractivePrompt("worker", "password");
    const confirmId = notifyAlert.mock.calls[0][1].choices[0].id as string;

    await (fm as any).handleInteractivePromptAssist(callback(confirmId, "user"), "telegram-main");
    expect(ipcSend).not.toHaveBeenCalled();

    await (fm as any).handleInteractivePromptAssist(callback(confirmId), "telegram-main");
    expect(ipcSend).toHaveBeenCalledOnce();
  });
});
