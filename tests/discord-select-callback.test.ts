import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { AccessManager } from "../src/channel/access-manager.js";

describe("Discord ClassicBot backend selection", () => {
  const dirs: string[] = [];
  const adapters: DiscordAdapter[] = [];

  afterEach(async () => {
    await Promise.all(adapters.splice(0).map(adapter => adapter.stop()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeAdapter(): DiscordAdapter {
    const dir = join(tmpdir(), `agend-discord-select-${process.pid}-${Date.now()}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const access = new AccessManager({
      mode: "open",
      allowed_users: [],
      max_pending_codes: 0,
      code_expiry_minutes: 10,
    }, join(dir, "access.json"));
    const adapter = new DiscordAdapter({
      id: "discord",
      botToken: "test-token",
      accessManager: access,
      inboxDir: dir,
      guildId: "primary-guild",
      registerCommands: false,
    });
    adapters.push(adapter);
    return adapter;
  }

  it("routes the /start StringSelect callback before a secondary-guild channel is open", async () => {
    const adapter = makeAdapter();
    const callback = vi.fn();
    adapter.on("callback_query", callback);
    const deferUpdate = vi.fn().mockResolvedValue(undefined);

    (adapter as any).client.emit("interactionCreate", {
      isButton: () => false,
      isStringSelectMenu: () => true,
      customId: "classic-start-backend",
      values: ["classic-backend:abc123:codex"],
      guildId: "allowed-secondary-guild",
      channelId: "new-classic-channel",
      message: { id: "menu-message" },
      user: { id: "owner" },
      deferUpdate,
    });

    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    expect(deferUpdate).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({
      callbackData: "classic-backend:abc123:codex",
      chatId: "primary-guild",
      threadId: "new-classic-channel",
      messageId: "menu-message",
      userId: "owner",
    });
  });

  it("still rejects unrelated select menus from unopened secondary-guild channels", async () => {
    const adapter = makeAdapter();
    const callback = vi.fn();
    adapter.on("callback_query", callback);

    (adapter as any).client.emit("interactionCreate", {
      isButton: () => false,
      isStringSelectMenu: () => true,
      customId: "unrelated-menu",
      values: ["anything"],
      guildId: "secondary-guild",
      channelId: "closed-channel",
      message: { id: "menu-message" },
      user: { id: "owner" },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(callback).not.toHaveBeenCalled();
  });
});
