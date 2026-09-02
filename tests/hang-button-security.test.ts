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
    expect(ids[0]).toMatch(/^hang:[0-9a-f]{32}:restart$/);
    expect(ids[1]).toMatch(/^hang:[0-9a-f]{32}:wait$/);
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

describe("sol review findings — regression pins", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agend-hang-sol-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setLocale("en");
    rmSync(dir, { recursive: true, force: true });
  });

  function baseFm() {
    const notifyAlert = vi.fn(async (chatId: string, _alert: unknown, opts?: { threadId?: string }) => ({
      messageId: "m1", chatId, threadId: opts?.threadId,
    }));
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      id: "telegram-main",
      type: "telegram",
      sendText: vi.fn().mockResolvedValue({ messageId: "n", chatId: "c" }),
      notifyAlert,
      editMessageRemoveButtons,
      editMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
    const fm = new FleetManager(dir);
    fm.fleetConfig = {
      defaults: {},
      channels: [{
        id: "telegram-main", type: "telegram", mode: "topic", group_id: "fleet-group",
        bot_token_env: "TEST_TOKEN", access: { mode: "locked", allowed_users: ["admin"] },
      }],
      instances: {
        general: { general_topic: true, topic_id: "general-topic", working_directory: dir },
        worker: { topic_id: "worker-topic", working_directory: dir },
      },
    } as any;
    fm.adapter = adapter;
    fm.worlds.set("telegram-main", {
      id: "telegram-main", adapter, groupId: "fleet-group",
      channelConfig: fm.fleetConfig.channels![0],
    } as any);
    fm.lifecycle.daemons.set("general", {} as any);
    return { fm, adapter, notifyAlert, editMessageRemoveButtons };
  }

  it("addresses a Classic instance's hang alert to its own channel, not the fleet group root", async () => {
    // Classic instances are absent from fleetConfig.instances, so the previous
    // getGroupIdForInstance-only resolution posted their buttons into the fleet
    // group root (finding 1). The classic manager knows the real channel.
    const { fm, notifyAlert } = baseFm();
    (fm as any).classicChannels = {
      getChannelIdByInstance: (name: string) => (name === "classic-bot" ? "classic-channel-9" : undefined),
      getAdapterIdByInstance: () => "telegram-main",
    };

    await fm.sendHangNotification("classic-bot", 5 * 60_000);

    expect(notifyAlert).toHaveBeenCalledWith(
      "classic-channel-9",
      expect.objectContaining({ type: "hang", instanceName: "classic-bot" }),
      undefined, // no thread — Classic channels are flat
    );
  });

  it("clears a prompt that was posted WHILE the stop was in flight (TOCTOU)", async () => {
    // The teardown itself can emit events whose handlers post fresh prompts
    // after the pre-stop clear ran (finding 2). The post-stop clear in finally
    // must sweep those too.
    const { fm, notifyAlert, editMessageRemoveButtons } = baseFm();
    const restartSingleInstance = vi.spyOn(fm, "restartSingleInstance").mockResolvedValue(undefined);
    vi.spyOn(fm.lifecycle, "stop").mockImplementation(async () => {
      await fm.sendHangNotification("worker"); // teardown-triggered prompt
    });

    await fm.stopInstance("worker");

    // The mid-stop prompt was posted... and then collapsed by the finally clear.
    expect(notifyAlert).toHaveBeenCalledTimes(1);
    expect(editMessageRemoveButtons).toHaveBeenCalled();
    // The strongest assertion: nothing pending survives, so a click does nothing.
    const restartId = notifyAlert.mock.calls[0][1].choices[0].id as string;
    await (fm as any).handleHangPrompt({
      callbackData: restartId, chatId: "fleet-group", threadId: "worker-topic",
      messageId: "m1", userId: "admin",
    }, "telegram-main");
    expect(restartSingleInstance).not.toHaveBeenCalled();
    expect((fm as any).pendingNonceButtons.size).toBe(0);
  });

  it("a nonce from one prompt kind cannot drive another kind's handler (cross-kind fail closed)", async () => {
    // One shared map holds every kind (finding 4): a hang-shaped callback
    // carrying an exit-restart nonce must be treated as stale, not act.
    const { fm, notifyAlert } = baseFm();
    const restartSingleInstance = vi.spyOn(fm, "restartSingleInstance").mockResolvedValue(undefined);
    await fm.notifyNormalExit("worker");
    const exitRestartId = notifyAlert.mock.calls.at(-1)![1].choices[0].id as string;
    const nonce = exitRestartId.split(":")[1];

    await (fm as any).handleHangPrompt({
      callbackData: `hang:${nonce}:restart`, chatId: "fleet-group",
      threadId: "general-topic", messageId: "m1", userId: "admin",
    }, "telegram-main");

    expect(restartSingleInstance).not.toHaveBeenCalled();
    expect((fm as any).pendingNonceButtons.size).toBe(1); // the real entry survives
  });

  it("a confirm on an assist entry without a General target fails closed", async () => {
    const { fm, notifyAlert, editMessageRemoveButtons } = baseFm();
    const deliverToInstance = vi.spyOn(fm, "deliverToInstance").mockResolvedValue(undefined);
    await fm.notifyInteractivePrompt("worker", "login");
    const confirmId = notifyAlert.mock.calls.at(-1)![1].choices[0].id as string;
    // Simulate entry confusion: the field a correct posting always sets is gone.
    const entry = (fm as any).pendingNonceButtons.get(confirmId.split(":")[1]);
    delete entry.generalName;

    await (fm as any).handleInteractivePromptAssist({
      callbackData: confirmId, chatId: "fleet-group", threadId: "general-topic",
      messageId: "m1", userId: "admin",
    }, "telegram-main");

    // Refused: nothing delivered anywhere — especially not to the blocked pane.
    expect(deliverToInstance).not.toHaveBeenCalled();
    expect(editMessageRemoveButtons).toHaveBeenLastCalledWith(
      "fleet-group", "m1", expect.stringContaining("Could not deliver"), "general-topic",
    );
  });

  it("planned restart suppresses the claimed-task nudge, not just the alert", async () => {
    // Finding 3: the nudge ran before the planned-restart check, injecting new
    // work into a CLI that is being shut down.
    const ipcSend = vi.fn();
    const sendHangNotification = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      fleetConfig: { defaults: {}, instances: {} },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      dataDir: dir,
      eventLog: { insert: vi.fn() },
      isPlannedRestart: () => true,
      sendHangNotification,
      listClaimedTasks: () => [{ id: "t1", title: "important work" }],
      instanceIpcClients: new Map([["worker", { connected: true, send: ipcSend }]]),
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

    expect(ipcSend).not.toHaveBeenCalled();
    expect(sendHangNotification).not.toHaveBeenCalled();
  });
});
