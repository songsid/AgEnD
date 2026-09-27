import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import type { ChannelAdapter } from "../src/channel/types.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function makeFleet(adapter: ChannelAdapter) {
  const dir = mkdtempSync(join(tmpdir(), "agend-review956-")); dirs.push(dir);
  const fleet = new FleetManager(dir);
  fleet.adapter = adapter;
  return { fleet, dir };
}
function discord(id = "discord-main") {
  const messages = new Map<string, Set<string>>();
  const visible = (chat = "chat", msg = "msg") => {
    const key = `${chat}:${msg}`;
    if (!messages.has(key)) messages.set(key, new Set());
    return messages.get(key)!;
  };
  const react = vi.fn(async (chat: string, msg: string, emoji: string) => { visible(chat, msg).add(emoji); });
  const unreact = vi.fn(async (chat: string, msg: string, emoji: string) => { visible(chat, msg).delete(emoji); });
  return { adapter: { id, type: "discord", react, unreact } as unknown as ChannelAdapter, visible, react, unreact };
}
async function status(fleet: FleetManager, emoji: string, msg = "msg", instance = "inst") {
  fleet.reactMessageStatus(instance, "chat", msg, emoji);
  await flush();
}

describe("review #956 adversarial status transitions", () => {
  it("serializes a delayed old add before a newer confirmation on Discord", async () => {
    const d = discord(); const { fleet } = makeFleet(d.adapter); const gate = deferred();
    d.react.mockImplementation(async (chat, msg, emoji) => {
      if (emoji === "❌") await gate.promise;
      d.visible(chat, msg).add(emoji);
    });
    fleet.reactMessageStatus("inst", "chat", "msg", "❌");
    fleet.reactMessageStatus("inst", "chat", "msg", "✅");
    await flush(); gate.resolve(); await flush();
    expect([...d.visible()]).toEqual(["✅"]);
  });

  it("keeps the last accepted Telegram status when a later status emoji is unsupported", async () => {
    // Telegram accepts 👀, but not ✅. The rejected status must not be sent to
    // the Bot API or clear the last accepted reaction.
    const gate = deferred(); let visible: string[] = [];
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(adapter, { id: "tg", bot: { api: { setMessageReaction: async (_c: number, _m: number, values: any[]) => {
      if (values[0]?.emoji === "👀") await gate.promise;
      visible = values.map(v => v.emoji);
    } } } });
    const { fleet } = makeFleet(adapter);
    fleet.reactMessageStatus("inst", "100", "42", "👀");
    fleet.reactMessageStatus("inst", "100", "42", "✅");
    await flush(); gate.resolve(); await flush();
    expect(visible).toEqual(["👀"]);
  });

  it("keeps bot A's failed state when bot B completes the same message", async () => {
    const a = discord("a"); const b = discord("b"); const { fleet } = makeFleet(a.adapter);
    vi.spyOn(fleet, "getAdapterForInstance").mockImplementation(name => name === "a" ? a.adapter : b.adapter);
    await status(fleet, "❌", "msg", "a");
    await status(fleet, "✅", "msg", "b");
    await status(fleet, "✅", "msg", "a");
    expect([...a.visible()]).toEqual(["✅"]);
    expect(b.unreact).not.toHaveBeenCalled();
  });

  it("never displays a forgotten terminal success alongside a later failure", async () => {
    const d = discord(); const { fleet } = makeFleet(d.adapter);
    await status(fleet, "❌"); await status(fleet, "✅"); await status(fleet, "❌");
    expect(d.visible().size).toBe(1);
  });

  it("can replace a failure after its tracking entry was evicted", async () => {
    const d = discord(); const { fleet } = makeFleet(d.adapter);
    await status(fleet, "❌", "old");
    for (let i = 0; i < 1_000; i++) await status(fleet, "⏳", `new-${i}`);
    await status(fleet, "✅", "old");
    expect([...d.visible("chat", "old")]).toEqual(["✅"]);
  });

  it("removes the actual inbound acknowledgement when wake fails", async () => {
    const d = discord(); const { fleet, dir } = makeFleet(d.adapter);
    fleet.fleetConfig = { defaults: {}, instances: { inst: { working_directory: dir, topic_id: "chat" } } } as any;
    vi.spyOn(fleet, "getAdapterForInstance").mockReturnValue(d.adapter);
    vi.spyOn(fleet as any, "governingAccess").mockReturnValue({ authoritative: false });
    vi.spyOn(fleet.routing, "resolve").mockReturnValue({ kind: "topic", name: "inst" } as any);
    vi.spyOn((fleet as any).topicCommands, "handleInstanceCommand").mockResolvedValue(false);
    vi.spyOn(fleet, "touchActivity").mockImplementation(() => {});
    vi.spyOn(fleet, "setTopicIcon").mockImplementation(async () => {});
    vi.spyOn(fleet as any, "warnIfRateLimited").mockImplementation(() => {});
    vi.spyOn(fleet, "deliverToInstance").mockRejectedValue(new Error("wake failed"));
    await (fleet as any).handleInboundMessage({
      source: "discord", chatId: "guild", threadId: "chat", messageId: "msg",
      userId: "human", username: "human", text: "hello", timestamp: new Date(),
    });
    await flush();
    expect(d.react.mock.calls.map(c => c[2])).toEqual(["👀", "❌"]);
    expect([...d.visible()]).toEqual(["❌"]);
  });

  it("retains unrelated Discord reactions during a status replacement (control)", async () => {
    const d = discord(); const { fleet } = makeFleet(d.adapter);
    await d.adapter.react("chat", "msg", "👍");
    await status(fleet, "❌"); await status(fleet, "✅");
    expect([...d.visible()]).toEqual(["👍", "✅"]);
  });
});

describe("review #956 adapter contracts", () => {
  it("routes daemon Telegram forum status to the supergroup, not topic id", async () => {
    const setMessageReaction = vi.fn(async () => true);
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(adapter, { id: "telegram", bot: { api: { setMessageReaction } } });
    const { fleet, dir } = makeFleet(adapter);
    const daemon = new Daemon("inst", {
      working_directory: dir,
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "error",
    }, dir, true, undefined, undefined, fleet.logger);
    (daemon as any).tmux = {};
    daemon.on("message_delivered", ({ chatId, messageId }) => fleet.reactMessageStatus("inst", chatId, messageId, "👀"));
    (daemon as any).deliverMessage = async (_text: string, data: { chatId: string; messageId: string }) => {
      daemon.emit("message_delivered", data); return true;
    };
    daemon.pushChannelMessage("hello", {
      chat_id: "-1001234567890", thread_id: "245", message_id: "42", source: "telegram", user: "human",
    });
    await (daemon as any).pasteLock; await flush();
    expect(setMessageReaction).toHaveBeenCalledWith(-1001234567890, 42, [{ type: "emoji", emoji: "👀" }]);
  });

  it("sends only Telegram-supported status emoji without clearing a valid reaction first", async () => {
    const require = createRequire(import.meta.url);
    const types = readFileSync(join(require.resolve("@grammyjs/types/package.json"), "..", "message.d.ts"), "utf8");
    const emojiUnion = types.match(/export interface ReactionTypeEmoji\s*\{[\s\S]*?\n\s*emoji: ([^;]+);/)![1];
    const allowed = new Set([...emojiUnion.matchAll(/"([^"]+)"/g)].map(m => m[1]));
    expect(allowed.has("👀")).toBe(true);
    expect(allowed.has("👎")).toBe(true);
    let visible: string[] = []; const rejected: string[] = [];
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(adapter, { id: "telegram", bot: { api: { setMessageReaction: async (_c: number, _m: number, values: any[]) => {
      for (const { emoji } of values) if (!allowed.has(emoji)) {
        rejected.push(emoji); throw new Error("400: REACTION_INVALID");
      }
      visible = values.map(v => v.emoji);
    } } } });
    const { fleet } = makeFleet(adapter);
    fleet.reactMessageStatus("inst", "100", "42", "👀");
    fleet.finishDeliveryStatus("inst", "100", "42", "✅");
    fleet.finishDeliveryStatus("inst", "100", "42", "❌");
    await flush();
    expect(rejected).toEqual([]);
    expect(visible).toEqual(["👎"]);
  });

  it("does not remove a later ordinary Telegram reaction when asked to remove an old status", async () => {
    let visible: string[] = [];
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(adapter, { bot: { api: { setMessageReaction: async (_c: number, _m: number, values: any[]) => {
      visible = values.map(v => v.emoji);
    } } } });
    await adapter.react("100", "42", "👀");
    await adapter.react("100", "42", "👍");
    await adapter.unreact("100", "42", "👀");
    expect(visible).toEqual(["👍"]);
  });

  it("does not treat a stale Discord cache miss as successful server removal", async () => {
    let serverHasOldReaction = true;
    const del = vi.fn().mockRejectedValue(new Error("temporary API error"));
    const remove = vi.fn(async () => { serverHasOldReaction = false; });
    const fetchMessage = vi.fn(async (options: any) => ({ reactions: {
      resolve: () => options?.force ? { users: { remove } } : undefined,
    } }));
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    Object.assign(adapter, { client: { rest: { delete: del }, channels: { fetch: async () => ({
      isTextBased: () => true, messages: { fetch: fetchMessage },
    }) } } });
    // discord.js fetch(messageId) uses an existing complete cached Message.
    // REST react() bypassed that cache; a missing reaction there proves nothing.
    await adapter.unreact("chat", "msg", "❌");
    expect(serverHasOldReaction).toBe(false);
  });
});
