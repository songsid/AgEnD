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
 * reconciles: only ❌ is removed before adding the new state, serialised per
 * bot+message so a delayed ❌ can never land after a newer ✅.
 *
 * #972: other status transitions (👀→⏳, ⏳→✅) are add-only — no unreact,
 * one API call per step instead of two. 👀/⏳/✅ stacking together is harmless.
 * Telegram uses the supported 👀/👎 status pair, addressed at the supergroup
 * with the thread separate.
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

  // #972: happy-path add-only — no unreact for non-❌ transitions.
  // Mutation guard: if the condition is reverted to `prev && prev !== emoji`
  // (unconditional unreact), unreact would be called for 👀→⏳→✅, making
  // this test fail.
  it("discord: 👀 → ⏳ → ✅ happy path uses add-only — no unreact calls (#972)", async () => {
    const { adapter, react, unreact } = stubAdapter("discord");
    const fleet = makeFleet(adapter);

    fleet.reactMessageStatus("inst", "chat", "msg", "👀");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("chat", "msg", "👀", undefined));
    fleet.reactMessageStatus("inst", "chat", "msg", "⏳");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("chat", "msg", "⏳", undefined));
    fleet.reactMessageStatus("inst", "chat", "msg", "✅");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("chat", "msg", "✅", undefined));

    // Three adds, zero removes — each step is a single API call.
    expect(react).toHaveBeenCalledTimes(3);
    expect(unreact).not.toHaveBeenCalled();
  });

  // #868 core preserved: ❌ is removed when leaving failed state.
  // Mutation guard: if the condition is changed to skip unreact for ❌
  // (e.g., `prev === "never"` or `false`), this test fails — ❌ would
  // stick alongside ✅, which is the original #868 bug.
  it("discord: ❌ is removed when followed by ✅ — #868 core preserved (#972)", async () => {
    const { adapter, react, unreact } = stubAdapter("discord");
    const fleet = makeFleet(adapter);

    fleet.reactMessageStatus("inst", "chat", "msg2", "👀");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("chat", "msg2", "👀", undefined));
    fleet.reactMessageStatus("inst", "chat", "msg2", "❌");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("chat", "msg2", "❌", undefined));
    fleet.reactMessageStatus("inst", "chat", "msg2", "✅");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("chat", "msg2", "✅", undefined));

    // ❌ must be unreacted exactly once (when transitioning away from it).
    expect(unreact).toHaveBeenCalledTimes(1);
    expect(unreact).toHaveBeenCalledWith("chat", "msg2", "❌", undefined);
    // Non-❌ states (👀) must NOT be unreacted.
    expect(unreact).not.toHaveBeenCalledWith("chat", "msg2", "👀", undefined);
  });

  it("addresses discord topics at the thread, keyed across the folded id", async () => {
    const { adapter, react, unreact } = stubAdapter("discord");
    const fleet = makeFleet(adapter);

    fleet.reactMessageStatus("inst", "guild", "msg", "👀", "topic-9");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("topic-9", "msg", "👀", "topic-9"));
    fleet.reactMessageStatus("inst", "guild", "msg", "✅", "topic-9");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("topic-9", "msg", "✅", "topic-9"));

    // #972: 👀 → ✅ is add-only — no unreact call for non-❌ transitions.
    expect(unreact).not.toHaveBeenCalled();
  });

  it("telegram: central status mapping uses 👀 for progress/success and 👎 for failure", async () => {
    const sets: string[][] = [];
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(adapter, {
      id: "telegram-main",
      bot: { api: { setMessageReaction: async (_chat: number, _message: number, reactions: { emoji: string }[]) => {
        if (reactions.length > 1) throw new Error("REACTIONS_TOO_MANY");
        sets.push(reactions.map(reaction => reaction.emoji));
      } } },
    });
    const fleet = makeFleet(adapter);

    fleet.reactMessageStatus("inst", "100", "42", "👀");
    fleet.finishDeliveryStatus("inst", "100", "42", "✅");
    fleet.finishDeliveryStatus("inst", "100", "42", "❌");
    fleet.finishDeliveryStatus("inst", "100", "42", "✅");
    await vi.waitFor(() => expect(sets).toHaveLength(3));

    expect(sets).toEqual([["👀"], ["👎"], ["👀"]]);
  });

  it("preserves an agent Telegram reaction when confirmed status remains 👀", async () => {
    const sets: string[][] = [];
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(adapter, {
      id: "telegram-main",
      bot: { api: { setMessageReaction: async (_chat: number, _message: number, reactions: { emoji: string }[]) => {
        if (reactions.length > 1) throw new Error("REACTIONS_TOO_MANY");
        sets.push(reactions.map(reaction => reaction.emoji));
      } } },
    });
    const fleet = makeFleet(adapter);

    fleet.reactMessageStatus("inst", "100", "42", "👀");
    await vi.waitFor(() => expect(sets).toHaveLength(1));
    // Telegram's single slot means the ordinary reaction replaces 👀. Since
    // success maps to the already tracked 👀 state, the status update is a
    // no-op and must not overwrite the agent's reaction.
    await adapter.react("100", "42", "👍");
    fleet.finishDeliveryStatus("inst", "100", "42", "✅");
    await new Promise(r => setTimeout(r, 100));

    expect(sets).toEqual([["👀"], ["👍"]]);
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
  it("replaces one bot reaction with another without exceeding Telegram's one-reaction limit", async () => {
    const sent: string[][] = [];
    const setMessageReaction = vi.fn(async (_chat: number, _message: number, reactions: { emoji: string }[]) => {
      if (reactions.length > 1) throw new Error("REACTIONS_TOO_MANY");
      sent.push(reactions.map(reaction => reaction.emoji));
    });
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(adapter as any, { bot: { api: { setMessageReaction } } });

    // A normal agent may react more than once to the same message. Each call
    // replaces the current single bot reaction, as the Bot API specifies.
    await adapter.react("100", "42", "👍");
    await adapter.react("100", "42", "🎉");

    expect(sent).toEqual([["👍"], ["🎉"]]);
    expect(setMessageReaction).toHaveBeenCalledTimes(2);
  });

  it("does not clear a newer reaction when unreact targets a replaced one", async () => {
    const sent: string[][] = [];
    const setMessageReaction = vi.fn(async (_chat: number, _message: number, reactions: { emoji: string }[]) => {
      if (reactions.length > 1) throw new Error("REACTIONS_TOO_MANY");
      sent.push(reactions.map(reaction => reaction.emoji));
    });
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(adapter as any, { bot: { api: { setMessageReaction } } });

    await adapter.react("100", "42", "👀");
    await adapter.react("100", "42", "👍");
    await adapter.unreact("100", "42", "👀");

    expect(sent).toEqual([["👀"], ["👍"]]);
    expect(setMessageReaction).toHaveBeenCalledTimes(2);
  });
});
