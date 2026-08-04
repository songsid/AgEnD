import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { AccessManager } from "../src/channel/access-manager.js";

describe("Discord outbound reactions", () => {
  function adapterWith(client: unknown): DiscordAdapter {
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    Object.assign(adapter as any, { client });
    return adapter;
  }

  it("uses the exact topic thread and succeeds through the direct REST path", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const adapter = adapterWith({ rest: { put } });

    await adapter.react("guild", "message-1", "👍", "topic-1");

    expect(put).toHaveBeenCalledWith(
      "/channels/topic-1/messages/message-1/reactions/%F0%9F%91%8D/@me",
    );
  });

  it("falls back safely when the direct REST reaction fails", async () => {
    const put = vi.fn().mockRejectedValue(new Error("stale route"));
    const react = vi.fn().mockResolvedValue(undefined);
    const fetchMessage = vi.fn().mockResolvedValue({ react });
    const fetchChannel = vi.fn().mockResolvedValue({
      isTextBased: () => true,
      messages: { fetch: fetchMessage },
    });
    const adapter = adapterWith({ rest: { put }, channels: { fetch: fetchChannel } });

    await expect(adapter.react("guild", "message-2", "🫡", "topic-2")).resolves.toBeUndefined();
    expect(fetchChannel).toHaveBeenCalledWith("topic-2");
    expect(fetchMessage).toHaveBeenCalledWith("message-2");
    expect(react).toHaveBeenCalledWith("🫡");
  });

  it("rejects instead of falsely returning ok when both reaction paths fail", async () => {
    const adapter = adapterWith({
      rest: { put: vi.fn().mockRejectedValue(new Error("REST denied")) },
      channels: { fetch: vi.fn().mockRejectedValue(new Error("channel unavailable")) },
    });

    await expect(adapter.react("guild", "missing", "👍", "topic"))
      .rejects.toThrow("Discord reaction failed: channel unavailable");
  });
});

describe("Discord inbound reaction listener", () => {
  it("registers add/remove and emits a sibling bot reaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-discord-reaction-"));
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
      guildId: "guild-1",
      registerCommands: false,
    });
    const client = (adapter as any).client;
    Object.defineProperty(client, "user", { value: { id: "self-bot" }, configurable: true });

    try {
      expect(client.listenerCount("messageReactionAdd")).toBeGreaterThan(0);
      expect(client.listenerCount("messageReactionRemove")).toBeGreaterThan(0);

      const seen = new Promise(resolve => adapter.once("reaction", resolve));
      client.emit("messageReactionAdd", {
        partial: false,
        message: {
          id: "message-3",
          channelId: "topic-3",
          guildId: "guild-1",
          author: { id: "self-bot" },
        },
        emoji: { name: "🎯", toString: () => "🎯" },
      }, {
        id: "sibling-bot",
        username: "sibling",
        bot: true,
      });

      await expect(seen).resolves.toMatchObject({
        adapterId: "discord",
        threadId: "topic-3",
        messageId: "message-3",
        userId: "sibling-bot",
        emoji: "🎯",
        action: "add",
      });
    } finally {
      await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
