import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import type { ChannelAdapter } from "../src/channel/types.js";

/**
 * #868: a delivery-status ❌ used to stick forever — react() only adds, so a
 * later ✅ landed next to it instead of replacing it. The status path now
 * reconciles: every update removes the other group members (👀/⏳/✅/❌)
 * before adding the new one, serialised per bot+message so a delayed ❌ can
 * never land after a newer ✅. Telegram only ever carries 👀 (the Bot API
 * rejects the rest), addressed at the supergroup with the thread separate.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function stubAdapter(type: "discord" | "telegram") {
  const react = vi.fn(async () => {});
  const unreact = vi.fn(async () => {});
  const adapter = { id: `${type}-main`, type, react, unreact } as unknown as ChannelAdapter;
  return { adapter, react, unreact };
}

function makeFleet(adapter: ChannelAdapter) {
  const dir = mkdtempSync(join(tmpdir(), "agend-status-react-"));
  dirs.push(dir);
  const fleet = new FleetManager(dir);
  (fleet as unknown as { adapter: ChannelAdapter }).adapter = adapter;
  return fleet;
}

describe("delivery-status reaction replaces the previous status", () => {
  it("discord: ❌ then ✅ removes ❌ before adding ✅", async () => {
    const { adapter, react, unreact } = stubAdapter("discord");
    const fleet = makeFleet(adapter);

    fleet.reactMessageStatus("inst", "chat", "msg", "❌");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("chat", "msg", "❌", undefined));
    fleet.reactMessageStatus("inst", "chat", "msg", "✅");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("chat", "msg", "✅", undefined));

    expect(unreact).toHaveBeenCalledTimes(1);
    expect(unreact).toHaveBeenCalledWith("chat", "msg", "❌", undefined);
    // The removal lands before the replacement add, never after.
    expect(unreact.mock.invocationCallOrder[0]).toBeLessThan(react.mock.invocationCallOrder[1]);
  });

  it("addresses discord topics at the thread, keyed across the folded id", async () => {
    const { adapter, react, unreact } = stubAdapter("discord");
    const fleet = makeFleet(adapter);

    fleet.reactMessageStatus("inst", "guild", "msg", "👀", "topic-9");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("topic-9", "msg", "👀", "topic-9"));
    fleet.reactMessageStatus("inst", "guild", "msg", "✅", "topic-9");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("topic-9", "msg", "✅", "topic-9"));

    // The earlier 👀 is found and cleared at the same folded address.
    expect(unreact).toHaveBeenCalledWith("topic-9", "msg", "👀", "topic-9");
  });

  it("telegram: only 👀 is ever sent, other statuses stay silent", async () => {
    const { adapter, react } = stubAdapter("telegram");
    // instanceof drives the Telegram policy, so use a real prototype object.
    Object.setPrototypeOf(adapter, TelegramAdapter.prototype);
    const fleet = makeFleet(adapter);

    for (const emoji of ["👀", "⏳", "❌", "✅"]) {
      fleet.reactMessageStatus("inst", "100", "42", emoji);
    }
    await vi.waitFor(() => expect(react).toHaveBeenCalledTimes(1));
    expect(react).toHaveBeenCalledWith("100", "42", "👀", undefined);
    await new Promise(r => setTimeout(r, 100));
    expect(react).toHaveBeenCalledTimes(1);
  });

  it("adapters without unreact fall back to a plain add", async () => {
    const react = vi.fn(async () => {});
    const adapter = { id: "legacy", type: "discord", react } as unknown as ChannelAdapter;
    const fleet = makeFleet(adapter);

    fleet.reactMessageStatus("inst", "chat", "msg", "❌");
    await vi.waitFor(() => expect(react).toHaveBeenCalledTimes(1));
    fleet.reactMessageStatus("inst", "chat", "msg", "✅");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("chat", "msg", "✅", undefined));

    expect(react).toHaveBeenCalledTimes(2);
  });
});

describe("Discord adapter unreact", () => {
  function adapterWith(client: unknown): DiscordAdapter {
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    Object.assign(adapter as any, { client });
    return adapter;
  }

  it("removes the bot's own reaction through the direct REST path", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const adapter = adapterWith({ rest: { delete: del } });

    await adapter.unreact!("guild", "message-1", "❌", "topic-1");

    expect(del).toHaveBeenCalledWith(
      "/channels/topic-1/messages/message-1/reactions/%E2%9D%8C/@me",
    );
  });

  it("falls back to a forced fresh discord.js fetch when REST fails", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const resolve = vi.fn().mockReturnValue({ users: { remove } });
    const fetchMessage = vi.fn().mockResolvedValue({ reactions: { resolve } });
    const fetchChannel = vi.fn().mockResolvedValue({
      isTextBased: () => true,
      messages: { fetch: fetchMessage },
    });
    const adapter = adapterWith({
      rest: { delete: vi.fn().mockRejectedValue(new Error("stale route")) },
      channels: { fetch: fetchChannel },
    });

    await adapter.unreact!("guild", "message-2", "❌", "topic-2");

    expect(fetchChannel).toHaveBeenCalledWith("topic-2");
    // Forced: a cached message predating the REST-added reaction proves nothing.
    expect(fetchMessage).toHaveBeenCalledWith({ message: "message-2", force: true });
    expect(resolve).toHaveBeenCalledWith("❌");
    expect(remove).toHaveBeenCalledWith();
  });

  it("treats a never-applied emoji as already removed", async () => {
    const fetchMessage = vi.fn().mockResolvedValue({ reactions: { resolve: () => undefined } });
    const fetchChannel = vi.fn().mockResolvedValue({
      isTextBased: () => true,
      messages: { fetch: fetchMessage },
    });
    const adapter = adapterWith({
      rest: { delete: vi.fn().mockRejectedValue(new Error("stale route")) },
      channels: { fetch: fetchChannel },
    });

    await expect(adapter.unreact!("guild", "message-3", "👀", "topic-3")).resolves.toBeUndefined();
  });
});

describe("Telegram adapter reaction memory", () => {
  it("re-sends the surviving list so unreact keeps an ordinary reaction", async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(adapter as any, { bot: { api: { setMessageReaction } } });

    await adapter.react("100", "42", "👀");
    await adapter.react("100", "42", "👍");
    await adapter.unreact("100", "42", "👀");

    expect(setMessageReaction).toHaveBeenLastCalledWith(100, 42, [
      { type: "emoji", emoji: "👍" },
    ]);
  });
});
