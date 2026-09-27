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
 * tracks the last emoji per message and removes it before applying the next
 * one, on both adapters (Discord REST DELETE, Telegram setMessageReaction([])).
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function stubAdapter(type: "discord" | "telegram", extra: Record<string, unknown> = {}) {
  const react = vi.fn(async () => {});
  const unreact = vi.fn(async () => {});
  const adapter = { id: `${type}-main`, type, react, unreact, ...extra } as unknown as ChannelAdapter;
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
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("chat", "msg", "❌"));
    fleet.reactMessageStatus("inst", "chat", "msg", "✅");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("chat", "msg", "✅"));

    expect(unreact).toHaveBeenCalledTimes(1);
    expect(unreact).toHaveBeenCalledWith("chat", "msg", "❌");
    // Removal lands before the replacement add, never after.
    expect(unreact.mock.invocationCallOrder[0]).toBeLessThan(react.mock.invocationCallOrder[1]);
  });

  it("telegram: ❌ then ✅ removes ❌ before adding ✅", async () => {
    const { adapter, react, unreact } = stubAdapter("telegram");
    const fleet = makeFleet(adapter);

    fleet.reactMessageStatus("inst", "100", "42", "❌");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("100", "42", "❌"));
    fleet.reactMessageStatus("inst", "100", "42", "✅");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("100", "42", "✅"));

    expect(unreact).toHaveBeenCalledTimes(1);
    expect(unreact).toHaveBeenCalledWith("100", "42", "❌");
    expect(unreact.mock.invocationCallOrder[0]).toBeLessThan(react.mock.invocationCallOrder[1]);
  });

  it("repeating the same status does not remove anything", async () => {
    const { adapter, react, unreact } = stubAdapter("discord");
    const fleet = makeFleet(adapter);

    fleet.reactMessageStatus("inst", "chat", "msg", "⏳");
    await vi.waitFor(() => expect(react).toHaveBeenCalledTimes(1));
    fleet.reactMessageStatus("inst", "chat", "msg", "⏳");
    await vi.waitFor(() => expect(react).toHaveBeenCalledTimes(2));

    expect(unreact).not.toHaveBeenCalled();
  });

  it("forgets ✅ so a later ❌ starts fresh instead of removing ✅", async () => {
    const { adapter, react, unreact } = stubAdapter("discord");
    const fleet = makeFleet(adapter);

    fleet.reactMessageStatus("inst", "chat", "msg", "❌");
    await vi.waitFor(() => expect(react).toHaveBeenCalledTimes(1));
    fleet.reactMessageStatus("inst", "chat", "msg", "✅");
    await vi.waitFor(() => expect(react).toHaveBeenCalledTimes(2));
    // A new failure after the terminal ✅: nothing tracked to remove.
    fleet.reactMessageStatus("inst", "chat", "msg", "❌");
    await vi.waitFor(() => expect(react).toHaveBeenCalledTimes(3));

    expect(unreact).toHaveBeenCalledTimes(1);
    expect(unreact).toHaveBeenCalledWith("chat", "msg", "❌");
  });

  it("adapters without unreact fall back to a plain add", async () => {
    const react = vi.fn(async () => {});
    const adapter = { id: "legacy", type: "discord", react } as unknown as ChannelAdapter;
    const fleet = makeFleet(adapter);

    fleet.reactMessageStatus("inst", "chat", "msg", "❌");
    await vi.waitFor(() => expect(react).toHaveBeenCalledTimes(1));
    fleet.reactMessageStatus("inst", "chat", "msg", "✅");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("chat", "msg", "✅"));

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

  it("falls back to discord.js removal when REST fails", async () => {
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
    expect(fetchMessage).toHaveBeenCalledWith("message-2");
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

describe("Telegram adapter unreact", () => {
  it("clears the bot's reactions with an empty setMessageReaction list", async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(adapter as any, { bot: { api: { setMessageReaction } } });

    await adapter.unreact!("100", "42", "❌");

    expect(setMessageReaction).toHaveBeenCalledWith(100, 42, []);
  });
});
