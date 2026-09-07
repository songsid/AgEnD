import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchFullRestartHelper } from "../src/full-restart.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { FleetManager } from "../src/fleet-manager.js";
import { RestartProgress } from "../src/restart-progress.js";
import { TopicCommands } from "../src/topic-commands.js";
import { TmuxManager } from "../src/tmux-manager.js";
import {
  beginFullRestartProgress,
  readUpdateProgress,
  updateProgressOperation,
} from "../src/update-marker.js";
import type { ChannelAdapter } from "../src/channel/types.js";

const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-restart-full-"));
  dirs.push(dir);
  return dir;
}

function inbound(text: string, userId = "admin") {
  return {
    text,
    chatId: "logical-chat",
    threadId: "1",
    messageId: "incoming",
    userId,
    adapterId: "telegram-main",
    username: "operator",
    timestamp: new Date(),
  } as any;
}

describe("/restart full command surface", () => {
  it("preserves bare /restart and accepts the Telegram bot-suffixed full variant", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const sendText = vi.fn().mockResolvedValue({
      messageId: "progress-1",
      chatId: "actual-chat",
      threadId: undefined,
    });
    const requestFullRestart = vi.fn().mockResolvedValue(true);
    const adapter = { id: "telegram-main", type: "telegram", sendText } as unknown as ChannelAdapter;
    const commands = new TopicCommands({
      adapter,
      adapters: new Map([["telegram-main", adapter]]),
      fleetConfig: { channel: { access: { allowed_users: ["admin"] } } },
      requestFullRestart,
    } as any);

    expect(await commands.handleGeneralCommand(inbound("/restart"))).toBe(true);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGUSR2");
    expect(requestFullRestart).not.toHaveBeenCalled();

    kill.mockClear();
    expect(await commands.handleGeneralCommand(inbound("/restart@AgEnDBot full"))).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    expect(requestFullRestart).toHaveBeenCalledWith(
      adapter,
      "actual-chat",
      undefined,
      "progress-1",
    );
  });

  it("makes only Discord's full variant public and forwards the selected mode", async () => {
    const dir = tempDir();
    const access = new AccessManager({
      mode: "open",
      allowed_users: [],
      max_pending_codes: 0,
      code_expiry_minutes: 10,
    }, join(dir, "access.json"));
    const adapter = new DiscordAdapter({
      id: "discord-main",
      botToken: "test-token",
      accessManager: access,
      inboxDir: dir,
      guildId: "guild",
      registerCommands: false,
    });
    const events: any[] = [];
    adapter.on("slash_command", event => events.push(event));

    const interaction = (mode: string | null) => ({
      isButton: () => false,
      isStringSelectMenu: () => false,
      isChatInputCommand: () => true,
      commandName: "restart",
      channelId: "channel",
      channel: { name: "general" },
      guildId: "guild",
      user: { id: "admin", username: "operator" },
      options: {
        getString: (name: string) => name === "mode" ? mode : null,
        data: mode ? [{ name: "mode", value: mode }] : [],
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue({ id: mode ? "full-message" : "normal-message" }),
      deleteReply: vi.fn().mockResolvedValue(undefined),
    });

    const full = interaction("full");
    (adapter as any).client.emit("interactionCreate", full);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(full.deferReply).toHaveBeenCalledWith({ ephemeral: false });
    expect(events[0]).toMatchObject({ command: "restart", options: { mode: "full" } });

    const normal = interaction(null);
    (adapter as any).client.emit("interactionCreate", normal);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(normal.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(events[1]).toMatchObject({ command: "restart", options: {} });

    await adapter.stop();
  });

  it("binds a Discord full restart to the public response in its real channel", async () => {
    const fleet = new FleetManager(tempDir());
    fleet.fleetConfig = {
      defaults: {},
      channels: [{
        id: "discord-main",
        type: "discord",
        mode: "topic",
        group_id: "guild",
        access: { allowed_users: ["admin"] },
      }],
      instances: {},
    } as any;
    const adapter = { id: "discord-main", type: "discord" } as ChannelAdapter;
    fleet.adapters.set("discord-main", adapter);
    const request = vi.spyOn(fleet, "requestFullRestart").mockResolvedValue(true);
    const respond = vi.fn().mockResolvedValue("public-progress");

    await (fleet as any).handleRestartSlash({
      command: "restart",
      channelId: "channel",
      channelName: "general",
      userId: "admin",
      options: { mode: "full" },
      respond,
    }, "discord-main");

    expect(respond).toHaveBeenCalledWith(expect.stringContaining("Full process reload requested"));
    expect(request).toHaveBeenCalledWith(adapter, "guild", "channel", "public-progress");
  });

  it("rejects unknown modes and non-admins without signalling or launching", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const sendText = vi.fn().mockResolvedValue({ messageId: "m", chatId: "logical-chat", threadId: "1" });
    const requestFullRestart = vi.fn();
    const adapter = { id: "telegram-main", type: "telegram", sendText } as unknown as ChannelAdapter;
    const commands = new TopicCommands({
      adapter,
      fleetConfig: { channel: { access: { allowed_users: ["admin"] } } },
      requestFullRestart,
    } as any);

    await commands.handleGeneralCommand(inbound("/restart hard"));
    await commands.handleGeneralCommand(inbound("/restart full", "reader"));

    expect(sendText.mock.calls[0][1]).toContain("/restart full");
    expect(sendText.mock.calls[1][1]).toMatch(/not authorized|無權限/i);
    expect(kill).not.toHaveBeenCalled();
    expect(requestFullRestart).not.toHaveBeenCalled();
  });
});

describe("full-restart helper hand-off", () => {
  it("spawns the environment-aware CLI wrapper and acknowledges only the spawn event", async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawnProcess = vi.fn(() => child as any);
    const launching = launchFullRestartHelper(spawnProcess, "/opt/agend/dist/cli.js");
    let settled = false;
    void launching.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit("spawn");
    const handle = await launching;
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ["/opt/agend/dist/cli.js", "fleet", "restart", "--reload"],
      { detached: true, stdio: "ignore" },
    );
    expect(child.unref).toHaveBeenCalledOnce();

    child.emit("exit", 7, null);
    await expect(handle.completion).resolves.toEqual({ code: 7, signal: null });
  });

  it("rejects a synchronous spawn throw and an error before spawn", async () => {
    await expect(launchFullRestartHelper(() => { throw new Error("spawn unavailable"); }, "/cli.js"))
      .rejects.toThrow("spawn unavailable");

    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const launching = launchFullRestartHelper(() => child as any, "/cli.js");
    child.emit("error", new Error("ENOENT"));
    await expect(launching).rejects.toThrow("ENOENT");
    expect(child.unref).not.toHaveBeenCalled();
  });
});

describe("full-restart cross-process progress", () => {
  it("persists an operation discriminator while treating old markers as updates", () => {
    const dir = tempDir();
    expect(beginFullRestartProgress(dir, {
      adapterId: "discord-main",
      chatId: "guild",
      threadId: "channel",
      messageId: "progress",
    }, 1234)).toBe(true);
    const marker = readUpdateProgress(dir);
    expect(marker).toMatchObject({
      startedAt: 1234,
      progress: {
        operation: "full-restart",
        stage: "stopping",
        target: { adapterId: "discord-main", chatId: "guild", threadId: "channel", messageId: "progress" },
      },
    });
    expect(updateProgressOperation(marker!.progress)).toBe("full-restart");
    expect(updateProgressOperation({ stage: "starting", target: marker!.progress.target })).toBe("update");
  });

  it("adopts and completes the original message with reload-specific text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = { editMessage } as unknown as ChannelAdapter;
    const progress = new RestartProgress(1, 0, { warn: vi.fn(), error: vi.fn() }, { mode: "reload" });

    expect(await progress.resume({ adapter, chatId: "fleet", threadId: "general" }, "restart-1")).toBe(true);
    expect(editMessage).toHaveBeenLastCalledWith(
      "fleet", "restart-1", "🚀 Full reload — starting the new fleet process... (5s)", "general",
    );
    progress.markReady();
    vi.setSystemTime(8_000);
    expect(await progress.finish({ running: 1, total: 1, version: "2.1.5", pausedNames: [] })).toBe(true);
    expect(editMessage).toHaveBeenLastCalledWith(
      "fleet", "restart-1", "✅ Full process reload complete — v2.1.5, 1/1 instances running (8s)", "general",
    );
  });

  it("refuses to launch when the marker cannot be persisted", async () => {
    const dataDir = join(tempDir(), "missing", "nested");
    const fleet = new FleetManager(dataDir);
    const launch = vi.fn();
    (fleet as any).fullRestartLauncher = launch;
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "telegram-main", type: "telegram", editMessage, sendText: vi.fn() } as unknown as ChannelAdapter;

    await expect(fleet.requestFullRestart(adapter, "chat", undefined, "progress")).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith(
      "chat", "progress", expect.stringContaining("could not start"), undefined,
    );
  });

  it("marks a helper that exits before hand-off as failed for the live progress monitor", async () => {
    const dir = tempDir();
    const fleet = new FleetManager(dir);
    let complete!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { complete = resolve; });
    (fleet as any).fullRestartLauncher = vi.fn().mockResolvedValue({ completion });
    const adapter = {
      id: "discord-main",
      type: "discord",
      editMessage: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn(),
    } as unknown as ChannelAdapter;

    expect(await fleet.requestFullRestart(adapter, "guild", "channel", "progress")).toBe(true);
    complete({ code: 1, signal: null });
    await vi.waitFor(() => expect(readUpdateProgress(dir)?.progress.stage).toBe("failed"));
    expect(readUpdateProgress(dir)?.progress.error).toContain("exited before process hand-off");
    if ((fleet as any).updateProgressTimer) clearInterval((fleet as any).updateProgressTimer);
  });

  it("reports a helper spawn failure and removes the marker without signalling the fleet", async () => {
    const dir = tempDir();
    const fleet = new FleetManager(dir);
    (fleet as any).fullRestartLauncher = vi.fn().mockRejectedValue(new Error("spawn failed"));
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      id: "discord-main",
      type: "discord",
      editMessage,
      sendText: vi.fn(),
    } as unknown as ChannelAdapter;

    await expect(fleet.requestFullRestart(adapter, "guild", "channel", "progress")).resolves.toBe(false);
    expect(readUpdateProgress(dir)).toBeNull();
    expect(editMessage).toHaveBeenCalledWith(
      "guild", "progress", expect.stringContaining("current fleet is still running"), "channel",
    );
  });

  it("keeps the tracked message during graceful reload shutdown instead of posting a duplicate", async () => {
    const dir = tempDir();
    beginFullRestartProgress(dir, {
      adapterId: "telegram-main",
      chatId: "chat",
      messageId: "progress",
    });
    const fleet = new FleetManager(dir);
    const sendText = vi.fn();
    (fleet as any).adapter = { sendText };
    fleet.fleetConfig = { defaults: {}, channel: { group_id: "chat" }, instances: {} } as any;
    fleet.daemons.set("general", { waitForIdle: vi.fn().mockResolvedValue(true) } as any);
    vi.spyOn(fleet, "stopAll").mockResolvedValue(undefined);
    vi.spyOn(TmuxManager, "listWindows").mockResolvedValue([{ id: "@1", name: "foreign" }, { id: "@2", name: "general" }] as any);

    await fleet.gracefulShutdownForReload();

    expect(sendText).not.toHaveBeenCalled();
    expect(readUpdateProgress(dir)?.progress.stage).toBe("stopping");
  });
});
