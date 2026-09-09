import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { FleetManager } from "../src/fleet-manager.js";
import { setAuthCheckRunnerForTests } from "../src/login-flows.js";

describe("/login auth pre-check", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `login-precheck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    setAuthCheckRunnerForTests(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup() {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { ...{ defaults: {}, instances: {} }, login: { mode: "relay" } } as any;   // legacy relay path under test; web mode is covered by login-controller.test.ts
    const notifyAlert = vi.fn(async (chatId: string, _alert: unknown, opts?: { threadId?: string }) => ({
      messageId: "prompt-1", chatId, threadId: opts?.threadId,
    }));
    const sendText = vi.fn().mockResolvedValue({ messageId: "m1" });
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "discord", type: "discord", notifyAlert, sendText, editMessageRemoveButtons } as any;
    const launch = vi.spyOn(fm as any, "launchLoginSession").mockResolvedValue("launched");
    vi.spyOn(fm, "isFleetAdmin").mockReturnValue(true);
    const chat = { adapter, adapterId: "discord", chatId: "chat", threadId: "topic" };
    return { fm, adapter, notifyAlert, sendText, launch, chat };
  }

  it("valid auth posts the re-login confirmation instead of launching", async () => {
    const { fm, notifyAlert, launch, chat } = setup();
    setAuthCheckRunnerForTests(async () => ({ code: 0, output: "ok" }));
    const result = await fm.startLoginSession("codex", chat);
    expect(result).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    expect(notifyAlert).toHaveBeenCalledTimes(1);
    const alert = notifyAlert.mock.calls[0][1];
    expect(alert.choices.map((c: { id: string }) => c.id))
      .toEqual([expect.stringMatching(/^login-confirm:[0-9a-f]{32}:go$/), expect.stringMatching(/^login-confirm:[0-9a-f]{32}:cancel$/)]);
  });

  it("invalid auth launches immediately without asking", async () => {
    const { fm, notifyAlert, launch, chat } = setup();
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: "Not logged in" }));
    expect(await fm.startLoginSession("codex", chat)).toBe("launched");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(notifyAlert).not.toHaveBeenCalled();
  });

  it("an uncertain check (timeout) launches immediately", async () => {
    const { fm, launch, chat } = setup();
    setAuthCheckRunnerForTests(async () => ({ code: null, output: "" }));
    expect(await fm.startLoginSession("grok", chat)).toBe("launched");
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("confirm button launches with the pre-check skipped; cancel retires only", async () => {
    const { fm, notifyAlert, launch, chat, adapter } = setup();
    const runner = vi.fn(async () => ({ code: 0, output: "ok" }));
    setAuthCheckRunnerForTests(runner);
    await fm.startLoginSession("codex", chat);
    const goId = notifyAlert.mock.calls[0][1].choices[0].id as string;

    const click = { chatId: "chat", threadId: "topic", messageId: "prompt-1", userId: "admin", callbackData: goId } as any;
    expect(await (fm as any).handleLoginConfirm(click, "discord", adapter)).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    // skipAuthCheck path: the runner ran once (for the original command), not twice.
    expect(runner).toHaveBeenCalledTimes(1);

    // Cancel path on a fresh prompt. The mocked launcher never ends its
    // session, so hand the fleet-wide window back first (what onDone does).
    launch.mockClear();
    (fm as any).loginWindow.release((fm as any).loginWindow.current);
    await fm.startLoginSession("codex", chat);
    const cancelId = notifyAlert.mock.calls[1][1].choices[1].id as string;
    expect(await (fm as any).handleLoginConfirm({ ...click, callbackData: cancelId }, "discord", adapter)).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    expect(adapter.editMessageRemoveButtons).toHaveBeenCalled();
  });

  it("post-login recovery wakes paused and restarts running instances of that backend", async () => {
    const { fm } = setup();
    fm.fleetConfig = {
      defaults: { backend: "codex" },
      instances: {
        "codex-running": { working_directory: "/tmp/a" },
        "codex-paused-live": { working_directory: "/tmp/b" },
        "codex-paused-marker": { working_directory: "/tmp/c" },
        "codex-stopped": { working_directory: "/tmp/d" },
        "other-claude": { working_directory: "/tmp/e", backend: "claude-code" },
      },
    } as any;
    const statuses: Record<string, string> = {
      "codex-running": "running",
      "codex-paused-live": "paused",
      "codex-paused-marker": "paused",
      "codex-stopped": "stopped",
      "other-claude": "running",
    };
    vi.spyOn(fm, "getInstanceStatus").mockImplementation(name => statuses[name] as any);
    fm.lifecycle.daemons.set("codex-paused-live", {} as any);
    const wake = vi.spyOn(fm.lifecycle, "wake").mockResolvedValue(undefined as any);
    const startPersisted = vi.spyOn(fm, "startPersistedPausedInstance").mockResolvedValue(undefined);
    const restart = vi.spyOn(fm, "restartSingleInstance").mockResolvedValue(undefined);

    const result = await (fm as any).recoverBackendInstances("codex");
    expect(result).toEqual({ woken: ["codex-paused-live", "codex-paused-marker"], restarted: ["codex-running"] });
    expect(wake).toHaveBeenCalledWith("codex-paused-live", 30_000);
    expect(startPersisted).toHaveBeenCalledWith("codex-paused-marker");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith("codex-running");
  });

  it("post-login recovery includes ClassicBot instances of the same backend without reviving stopped or crashed ones", async () => {
    const { fm } = setup();
    fm.fleetConfig = {
      defaults: { backend: "codex" },
      instances: {
        "fleet-kiro": { working_directory: "/tmp/fleet-kiro", backend: "kiro-cli" },
        "duplicate-kiro": { working_directory: "/tmp/duplicate", backend: "kiro-cli" },
        "fleet-other": { working_directory: "/tmp/fleet-other" },
      },
    } as any;
    const classicBackends: Record<string, string> = {
      "classic-running": "kiro-cli",
      "classic-paused-live": "kiro-cli",
      "classic-paused-marker": "kiro-cli",
      "classic-stopped": "kiro-cli",
      "classic-crashed": "kiro-cli",
      "classic-other": "claude-code",
      "duplicate-kiro": "kiro-cli",
    };
    fm.classicChannels = {
      getAll: () => Object.keys(classicBackends).map((instanceName, index) => ({
        instanceName,
        channelId: `classic-${index}`,
        adapterId: "discord",
      })),
      getBackendByInstance: (name: string, fallback?: string) => classicBackends[name] ?? fallback ?? "claude-code",
    } as any;
    const statuses: Record<string, string> = {
      "fleet-kiro": "running",
      "duplicate-kiro": "running",
      "fleet-other": "running",
      "classic-running": "running",
      "classic-paused-live": "paused",
      "classic-paused-marker": "paused",
      "classic-stopped": "stopped",
      "classic-crashed": "crashed",
      "classic-other": "running",
    };
    vi.spyOn(fm, "getInstanceStatus").mockImplementation(name => statuses[name] as any);
    fm.lifecycle.daemons.set("classic-paused-live", {} as any);
    const wake = vi.spyOn(fm.lifecycle, "wake").mockResolvedValue(undefined as any);
    const startPersisted = vi.spyOn(fm, "startPersistedPausedInstance").mockResolvedValue(undefined);
    const restart = vi.spyOn(fm, "restartSingleInstance").mockResolvedValue(undefined);

    const result = await (fm as any).recoverBackendInstances("kiro-cli");

    expect(result).toEqual({
      woken: ["classic-paused-live", "classic-paused-marker"],
      restarted: ["fleet-kiro", "duplicate-kiro", "classic-running"],
    });
    expect(wake).toHaveBeenCalledExactlyOnceWith("classic-paused-live", 30_000);
    expect(startPersisted).toHaveBeenCalledExactlyOnceWith("classic-paused-marker");
    expect(restart.mock.calls.map(([name]) => name)).toEqual([
      "fleet-kiro",
      "duplicate-kiro",
      "classic-running",
    ]);
  });

  it("a duplicate fleet/Classic name uses the fleet backend and is recovered only once", async () => {
    const { fm } = setup();
    fm.fleetConfig = {
      defaults: { backend: "codex" },
      instances: { shared: { working_directory: "/tmp/shared" } },
    } as any;
    fm.classicChannels = {
      getAll: () => [{ instanceName: "shared", channelId: "classic-shared", adapterId: "discord" }],
      getBackendByInstance: () => "kiro-cli",
    } as any;
    vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
    const restart = vi.spyOn(fm, "restartSingleInstance").mockResolvedValue(undefined);

    expect(await (fm as any).recoverBackendInstances("kiro-cli"))
      .toEqual({ woken: [], restarted: [] });
    expect(await (fm as any).recoverBackendInstances("codex"))
      .toEqual({ woken: [], restarted: ["shared"] });
    expect(restart).toHaveBeenCalledExactlyOnceWith("shared");
  });

  it("the bare /login chooser includes a backend used only by a ClassicBot", async () => {
    const { fm, notifyAlert, chat } = setup();
    fm.fleetConfig = {
      defaults: { backend: "codex" },
      instances: { worker: { working_directory: "/tmp/worker" } },
    } as any;
    fm.classicChannels = {
      getAll: () => [{ instanceName: "classic-kiro", channelId: "classic-kiro", adapterId: "discord" }],
      getBackendByInstance: () => "kiro-cli",
    } as any;

    await fm.promptLoginBackends(chat);

    const choiceIds = notifyAlert.mock.calls[0][1].choices.map((choice: { id: string }) => choice.id);
    expect(choiceIds).toEqual([
      expect.stringMatching(/:codex$/),
      expect.stringMatching(/:kiro-cli$/),
    ]);
  });

  it("the post-login restart rebuilds a ClassicBot with its own runtime settings", async () => {
    vi.useFakeTimers();
    try {
      const { fm } = setup();
      fm.fleetConfig = { defaults: { backend: "codex", model: "fleet-model" }, instances: {} } as any;
      fm.classicChannels = {
        getAll: () => [{ instanceName: "classic-kiro", channelId: "classic-channel", adapterId: "discord" }],
        getChannelIdByInstance: () => "classic-channel",
        getAdapterIdByInstance: () => "discord",
        getBackendByInstance: () => "kiro-cli",
        getPreTaskCommand: () => "prepare-classic",
        getModel: () => "classic-model",
        getAutoPauseAfter: () => 42,
      } as any;
      const stop = vi.spyOn(fm, "stopInstance").mockResolvedValue(undefined);
      const startClassic = vi.spyOn(fm as any, "startClassicInstance").mockResolvedValue(undefined);

      const restart = (fm as any).doRestartSingleInstance("classic-kiro");
      await vi.advanceTimersByTimeAsync(1_000);
      await restart;

      expect(stop).toHaveBeenCalledExactlyOnceWith("classic-kiro");
      expect(startClassic).toHaveBeenCalledExactlyOnceWith(
        "classic-kiro",
        "kiro-cli",
        "prepare-classic",
        "classic-model",
        42,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a backend without remote login still reports unsupported before any check", async () => {
    const { fm, launch, chat } = setup();
    const runner = vi.fn(async () => ({ code: 0, output: "ok" }));
    setAuthCheckRunnerForTests(runner);
    expect(await fm.startLoginSession("opencode", chat)).toContain("opencode");
    expect(runner).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
});
