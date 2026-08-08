import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { setLocale } from "../src/locale.js";

describe("normal CLI exit restart controls", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agend-exit-restart-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setLocale("en");
    rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const sendText = vi.fn().mockResolvedValue({ messageId: "instance-notice", chatId: "fleet-group" });
    const notifyAlert = vi.fn().mockResolvedValue({
      messageId: "exit-message",
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
    fm.lifecycle.daemons.set("general", {} as any);
    const restartSingleInstance = vi.spyOn(fm, "restartSingleInstance").mockResolvedValue(undefined);
    return { fm, sendText, notifyAlert, editMessageRemoveButtons, editMessage, restartSingleInstance };
  }

  function callback(id: string, userId = "admin") {
    return {
      callbackData: id,
      chatId: "fleet-group",
      threadId: "general-topic",
      messageId: "exit-message",
      userId,
    };
  }

  it("posts localized buttons in same-world General and a plain instance notice", async () => {
    setLocale("zh-TW");
    const { fm, sendText, notifyAlert } = setup();

    await fm.notifyNormalExit("worker");

    expect(sendText).toHaveBeenCalledWith(
      "fleet-group",
      expect.stringMatching(/worker.*正常退出.*General/s),
      { threadId: "worker-topic" },
    );
    expect(notifyAlert).toHaveBeenCalledWith(
      "fleet-group",
      expect.objectContaining({
        type: "exit_restart",
        instanceName: "worker",
        message: "🛑 worker 已停止（正常退出）。要重新啟動嗎？",
        choices: [
          expect.objectContaining({ label: "重啟" }),
          expect.objectContaining({ label: "忽略" }),
        ],
      }),
      { threadId: "general-topic" },
    );
  });

  it("admin Restart is consumed once and restarts the stopped instance", async () => {
    const { fm, notifyAlert, editMessageRemoveButtons, editMessage, restartSingleInstance } = setup();
    await fm.notifyNormalExit("worker");
    const restartId = notifyAlert.mock.calls[0][1].choices[0].id as string;

    await (fm as any).handleExitRestartPrompt(callback(restartId), "telegram-main");
    await (fm as any).handleExitRestartPrompt(callback(restartId), "telegram-main");

    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "fleet-group",
      "exit-message",
      "🔄 Restarting worker...",
      "general-topic",
    );
    expect(restartSingleInstance).toHaveBeenCalledOnce();
    expect(restartSingleInstance).toHaveBeenCalledWith("worker");
    expect(editMessage).toHaveBeenCalledWith(
      "fleet-group",
      "exit-message",
      "✅ worker restarted.",
      "general-topic",
    );
  });

  it("Ignore removes buttons, while a non-admin click cannot consume the action", async () => {
    const { fm, notifyAlert, editMessageRemoveButtons, restartSingleInstance } = setup();
    await fm.notifyNormalExit("worker");
    const ignoreId = notifyAlert.mock.calls[0][1].choices[1].id as string;

    await (fm as any).handleExitRestartPrompt(callback(ignoreId, "user"), "telegram-main");
    expect(editMessageRemoveButtons).not.toHaveBeenCalled();
    await (fm as any).handleExitRestartPrompt(callback(ignoreId), "telegram-main");

    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "fleet-group",
      "exit-message",
      expect.stringContaining("ignored"),
      "general-topic",
    );
    expect(restartSingleInstance).not.toHaveBeenCalled();
  });

  it("expires and removes controls after 15 minutes", async () => {
    vi.useFakeTimers();
    const { fm, editMessageRemoveButtons } = setup();
    await fm.notifyNormalExit("worker");

    await vi.advanceTimersByTimeAsync(15 * 60_000);

    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "fleet-group",
      "exit-message",
      expect.stringContaining("expired"),
      "general-topic",
    );
  });

  it("only exit code 0 offers restart controls; crash supervision does not", async () => {
    const notifyNormalExit = vi.fn().mockResolvedValue(undefined);
    const notifyInstanceTopic = vi.fn();
    const ctx = {
      fleetConfig: { defaults: {}, instances: {} },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      dataDir: dir,
      eventLog: { insert: vi.fn() },
      isPlannedRestart: () => false,
      notifyNormalExit,
      notifyInstanceTopic,
      setTopicIcon: vi.fn(),
      webhookEmit: vi.fn(),
      clearCancelButton: vi.fn(),
      checkModelFailover: vi.fn(),
      restartSingleInstance: vi.fn(),
    } as unknown as LifecycleContext;
    const lifecycle = new InstanceLifecycle(ctx);
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn() });
    lifecycle.attachIncidentHandlers("worker", daemon as any);

    daemon.emit("supervision_ended", { name: "worker", reason: "crashed", remedy: "inspect logs", exitCode: 1 });
    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenCalledOnce());
    expect(notifyNormalExit).not.toHaveBeenCalled();

    daemon.emit("supervision_ended", { name: "worker", reason: "normal", remedy: "restart", exitCode: 0 });
    await vi.waitFor(() => expect(notifyNormalExit).toHaveBeenCalledOnce());
  });
});
