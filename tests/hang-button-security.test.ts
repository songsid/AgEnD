import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { setLocale } from "../src/locale.js";

// The hang Force-restart button predates the nonce-armed prompt pattern that
// #530/#534 established. Until this suite's feature branch it was: callback
// data carrying only the instance name (forgeable, reusable forever), no admin
// gate, no expiry, a hand-rolled stop+start that silently left Classic
// instances stopped while editing the message to "restarted", and edits routed
// through the primary adapter regardless of which bot posted the alert. These
// tests pin the hardened behavior to the shared helper.

describe("hang notification buttons", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agend-hang-btn-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setLocale("en");
    rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const sendText = vi.fn().mockResolvedValue({ messageId: "notice", chatId: "fleet-group" });
    const notifyAlert = vi.fn().mockResolvedValue({
      messageId: "hang-message",
      chatId: "fleet-group",
      threadId: "worker-topic",
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
    const restartSingleInstance = vi.spyOn(fm, "restartSingleInstance").mockResolvedValue(undefined);
    return { fm, notifyAlert, editMessageRemoveButtons, editMessage, restartSingleInstance };
  }

  function callback(id: string, userId = "admin") {
    return {
      callbackData: id,
      chatId: "fleet-group",
      threadId: "worker-topic",
      messageId: "hang-message",
      userId,
    };
  }

  it("posts nonce-armed, localized buttons into the instance topic", async () => {
    setLocale("zh-TW");
    const { fm, notifyAlert } = setup();

    await fm.sendHangNotification("worker", 17 * 60_000);

    expect(notifyAlert).toHaveBeenCalledWith(
      "fleet-group",
      expect.objectContaining({
        type: "hang",
        instanceName: "worker",
        message: expect.stringContaining("17 分鐘"),
        choices: [
          expect.objectContaining({ label: "🔄 強制重啟" }),
          expect.objectContaining({ label: "⏳ 繼續等待" }),
        ],
      }),
      { threadId: "worker-topic" },
    );
    // The callback data is capability-shaped, not identity-shaped: a 128-bit
    // nonce instead of the forgeable instance name.
    const ids = notifyAlert.mock.calls[0][1].choices.map((c: { id: string }) => c.id);
    expect(ids[0]).toMatch(/^hang:[0-9a-f]{16}:restart$/);
    expect(ids[1]).toMatch(/^hang:[0-9a-f]{16}:wait$/);
  });

  it("admin Force-restart is consumed once and goes through restartSingleInstance", async () => {
    const { fm, notifyAlert, editMessage, restartSingleInstance } = setup();
    await fm.sendHangNotification("worker");
    const restartId = notifyAlert.mock.calls[0][1].choices[0].id as string;

    await (fm as any).handleHangPrompt(callback(restartId), "telegram-main");
    await (fm as any).handleHangPrompt(callback(restartId), "telegram-main");

    // restartSingleInstance serializes concurrent restarts and knows how to
    // restart Classic instances — the old hand-rolled stop+start did neither.
    expect(restartSingleInstance).toHaveBeenCalledOnce();
    expect(restartSingleInstance).toHaveBeenCalledWith("worker");
    expect(editMessage).toHaveBeenCalledWith(
      "fleet-group",
      "hang-message",
      "✅ worker restarted.",
      "worker-topic",
    );
  });

  it("a non-admin click neither restarts nor consumes the nonce", async () => {
    const { fm, notifyAlert, restartSingleInstance } = setup();
    await fm.sendHangNotification("worker");
    const restartId = notifyAlert.mock.calls[0][1].choices[0].id as string;

    await (fm as any).handleHangPrompt(callback(restartId, "bystander"), "telegram-main");
    expect(restartSingleInstance).not.toHaveBeenCalled();

    // The rejection must not burn the nonce — the real admin can still act.
    await (fm as any).handleHangPrompt(callback(restartId), "telegram-main");
    expect(restartSingleInstance).toHaveBeenCalledOnce();
  });

  it("Keep waiting retires the buttons without restarting", async () => {
    const { fm, notifyAlert, editMessageRemoveButtons, restartSingleInstance } = setup();
    await fm.sendHangNotification("worker");
    const waitId = notifyAlert.mock.calls[0][1].choices[1].id as string;

    await (fm as any).handleHangPrompt(callback(waitId), "telegram-main");

    expect(restartSingleInstance).not.toHaveBeenCalled();
    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "fleet-group",
      "hang-message",
      expect.stringContaining("Continuing to wait"),
      "worker-topic",
    );
  });

  it("expires after 15 minutes and a late click gets a stale notice, not a restart", async () => {
    vi.useFakeTimers();
    const { fm, notifyAlert, editMessageRemoveButtons, restartSingleInstance } = setup();
    await fm.sendHangNotification("worker");
    const restartId = notifyAlert.mock.calls[0][1].choices[0].id as string;

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "fleet-group",
      "hang-message",
      expect.stringContaining("expired"),
      "worker-topic",
    );

    await (fm as any).handleHangPrompt(callback(restartId), "telegram-main");
    expect(restartSingleInstance).not.toHaveBeenCalled();
    // The dead button collapses instead of silently swallowing the click.
    expect(editMessageRemoveButtons).toHaveBeenLastCalledWith(
      "fleet-group",
      "hang-message",
      expect.stringContaining("expired"),
      "worker-topic",
    );
  });

  it("treats a pre-upgrade payload (hang:restart:<name>) as stale instead of acting on it", async () => {
    const { fm, editMessageRemoveButtons, restartSingleInstance } = setup();

    const handled = await (fm as any).handleHangPrompt(callback("hang:restart:worker"), "telegram-main");

    expect(handled).toBe(true);
    expect(restartSingleInstance).not.toHaveBeenCalled();
    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "fleet-group",
      "hang-message",
      expect.stringContaining("expired"),
      "worker-topic",
    );
  });

  it("reports a restart failure honestly instead of claiming success", async () => {
    const { fm, notifyAlert, editMessage, restartSingleInstance } = setup();
    restartSingleInstance.mockRejectedValueOnce(new Error("Instance not found: worker"));
    await fm.sendHangNotification("worker");
    const restartId = notifyAlert.mock.calls[0][1].choices[0].id as string;

    await (fm as any).handleHangPrompt(callback(restartId), "telegram-main");

    expect(editMessage).toHaveBeenCalledWith(
      "fleet-group",
      "hang-message",
      expect.stringContaining("Failed to restart worker"),
      "worker-topic",
    );
  });

  it("stopInstance clears the pending prompt so it cannot outlive the instance", async () => {
    const { fm, notifyAlert, editMessageRemoveButtons, restartSingleInstance } = setup();
    await fm.sendHangNotification("worker");
    const restartId = notifyAlert.mock.calls[0][1].choices[0].id as string;
    vi.spyOn(fm.lifecycle, "stop").mockResolvedValue(undefined);

    await fm.stopInstance("worker");
    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "fleet-group",
      "hang-message",
      expect.stringContaining("expired"),
      "worker-topic",
    );

    await (fm as any).handleHangPrompt(callback(restartId), "telegram-main");
    expect(restartSingleInstance).not.toHaveBeenCalled();
  });

  it("suppresses the hang notification during a planned restart (and only then)", async () => {
    const sendHangNotification = vi.fn().mockResolvedValue(undefined);
    let planned = true;
    const ctx = {
      fleetConfig: { defaults: {}, instances: {} },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      dataDir: dir,
      eventLog: { insert: vi.fn() },
      isPlannedRestart: () => planned,
      sendHangNotification,
      listClaimedTasks: () => [],
      instanceIpcClients: new Map(),
      webhookEmit: vi.fn(),
      setTopicIcon: vi.fn(),
      clearCancelButton: vi.fn(),
      checkModelFailover: vi.fn(),
    } as unknown as LifecycleContext;
    const lifecycle = new InstanceLifecycle(ctx);
    const hangDetector = new EventEmitter();
    const daemon = Object.assign(new EventEmitter(), {
      getHangDetector: () => hangDetector,
      requestPauseWhenIdle: vi.fn(),
    });
    lifecycle.attachIncidentHandlers("worker", daemon as any);

    hangDetector.emit("hang", { unchangedForMs: 60_000 });
    await new Promise(r => setTimeout(r, 10));
    expect(sendHangNotification).not.toHaveBeenCalled();

    // Positive control: the same wiring notifies when no planned restart is
    // in progress — proving the suppression assertion above is not vacuous.
    planned = false;
    hangDetector.emit("hang", { unchangedForMs: 60_000 });
    await vi.waitFor(() => expect(sendHangNotification).toHaveBeenCalledWith("worker", 60_000));
  });
});
