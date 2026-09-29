/**
 * #1005 phase 3.1: delivery-status emojis come from config — instance
 * `status_emojis` → channel `options.status_emojis` → the platform built-in.
 * The value a bot reacts with, the one it later removes, the reactions the
 * fleet drops as its own stamps, and the list the instructions tell agents to
 * avoid must all be the same resolved value. Everything below drives the real
 * FleetManager status path against a recording adapter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { AdapterWorld } from "../src/adapter-world.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { EventLog } from "../src/event-log.js";
import { buildFleetInstructions } from "../src/instructions.js";
import { validateFleetConfig } from "../src/config-validator.js";
import {
  displayForm, normalizeEmoji, reactionForm, resolveStatusEmojis, statusEmojiProblem, textForm,
} from "../src/status-emojis.js";
import type { ChannelAdapter, InboundReaction } from "../src/channel/types.js";
import type { ChannelConfig } from "../src/types.js";

const INBOX = "<:inbox:111111111111111111>";
const DONE = "<a:done:222222222222222222>";
const FAIL = "fail:333333333333333333";

const dirs: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  for (const l of logs.splice(0)) l.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function recorder(id: string, type: "discord" | "telegram") {
  const visible = new Set<string>();
  const react = vi.fn(async (_c: string, _m: string, e: string) => { visible.add(e); });
  const unreact = vi.fn(async (_c: string, _m: string, e: string) => { visible.delete(e); });
  return { adapter: { id, type, react, unreact } as unknown as ChannelAdapter, react, unreact, visible };
}

function telegramRecorder(id: string) {
  let visible: string[] = [];
  const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
  Object.assign(adapter, {
    id,
    telegramReactions: new Map(),
    bot: { api: { setMessageReaction: async (_c: number, _m: number, values: Array<{ emoji: string }>) => { visible = values.map(v => v.emoji); } } },
  });
  return { adapter: adapter as unknown as ChannelAdapter, visible: () => visible };
}

interface WorldSpec { id: string; type: "discord" | "telegram"; adapter: ChannelAdapter; botUserId?: string; options?: Record<string, unknown> }

function makeFleet(worlds: WorldSpec[], instances: Record<string, Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), "agend-1005-"));
  dirs.push(dir);
  const fleet = new FleetManager(dir);
  const channels: ChannelConfig[] = worlds.map(w => ({
    id: w.id, type: w.type, mode: "topic", bot_token_env: "FAKE", access: { mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 0 },
    ...(w.options ? { options: w.options } : {}),
  }));
  const internals = fleet as unknown as {
    fleetConfig: unknown; adapter: ChannelAdapter; eventLog: EventLog;
    resolveSlashTarget(channelId: string, adapterId?: string): string | undefined;
    handleInboundReaction(r: InboundReaction): Promise<void>;
    logger: { warn: (...a: unknown[]) => void; debug: (...a: unknown[]) => void; info: (...a: unknown[]) => void };
  };
  internals.fleetConfig = { channels, defaults: {}, instances };
  internals.adapter = worlds[0]!.adapter;
  for (const [i, w] of worlds.entries()) {
    const world = new AdapterWorld(w.id, w.adapter, new AccessManager(channels[i]!.access, join(dir, `access-${w.id}.json`)), channels[i]!);
    if (w.botUserId) world.botUserId = w.botUserId;
    fleet.worlds.set(w.id, world);
  }
  const eventLog = new EventLog(join(dir, "events.db"));
  logs.push(eventLog);
  internals.eventLog = eventLog;
  internals.resolveSlashTarget = () => "alpha";
  const warn = vi.fn();
  internals.logger = { ...internals.logger, warn, debug: () => {}, info: () => {} };
  return { fleet, internals, eventLog, warn };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe("normalising a configured value (#1005)", () => {
  it("accepts the three Discord custom forms and reacts/unreacts with name:id", () => {
    expect(normalizeEmoji(INBOX)).toEqual({ kind: "custom", name: "inbox", id: "111111111111111111", animated: false });
    expect(normalizeEmoji(DONE)).toEqual({ kind: "custom", name: "done", id: "222222222222222222", animated: true });
    expect(normalizeEmoji(FAIL)).toEqual({ kind: "custom", name: "fail", id: "333333333333333333", animated: false });
    expect(reactionForm("discord", INBOX)).toBe("inbox:111111111111111111");
    expect(reactionForm("discord", DONE)).toBe("done:222222222222222222");
    expect(displayForm(DONE)).toBe(":done:");
    expect(textForm("discord", FAIL)).toBe("<:fail:333333333333333333>");
  });

  it("refuses words, several emojis' worth of text, and custom emoji on Telegram", () => {
    for (const bad of ["ok", "done!", "👍 👍", "", ":inbox:"]) expect(normalizeEmoji(bad)).toBeNull();
  });

  it("takes exactly one emoji grapheme: two adjacent emojis are refused, ZWJ/flag/skin-tone sequences kept", () => {
    // 👀✅ cannot be stamped as one reaction; accepting it silently lost that status.
    for (const two of ["👀✅", "🇹🇼🇯🇵", "👍🏽👍", "❤️🔥"]) {
      expect(normalizeEmoji(two), two).toBeNull();
      expect(statusEmojiProblem("discord", "delivered", two), two).toMatch(/not an emoji/);
    }
    for (const one of ["👨‍👩‍👧‍👦", "🏳️‍🌈", "🇹🇼", "👍🏽", "❤️", "❤‍🔥"]) {
      expect(normalizeEmoji(one), one).toEqual({ kind: "unicode", value: one });
    }
    // And the resolver falls back instead of reacting with the pair.
    const onInvalid = vi.fn();
    expect(resolveStatusEmojis({ platform: "discord", platformConfig: { delivered: "👀✅" }, onInvalid }).delivered).toBe("✅");
    expect(onInvalid).toHaveBeenCalledOnce();
    expect(statusEmojiProblem("telegram", "delivered", INBOX)).toMatch(/no server custom emoji/);
    expect(statusEmojiProblem("telegram", "delivered", "✅")).toMatch(/allowed reaction set/);
    expect(statusEmojiProblem("telegram", "delivered", "👌")).toBeNull();
    expect(statusEmojiProblem("discord", "delivered", "✅")).toBeNull();
  });

  it("resolves per key: instance, then platform, then built-in", () => {
    const r = resolveStatusEmojis({
      platform: "discord",
      platformConfig: { received: INBOX, delivered: "🎯" },
      instanceConfig: { delivered: "🦊" },
    });
    expect(r).toMatchObject({ received: INBOX, queued: "⏳", processing: "👀", delivered: "🦊", failed: "❌" });
  });
});

describe("the status path reacts with the resolved value (#1005)", () => {
  it("discord: a custom received/delivered/failed ladder, and the failed one comes off with the same form", async () => {
    const d = recorder("discord", "discord");
    const { fleet } = makeFleet([{ id: "discord", type: "discord", adapter: d.adapter, options: { status_emojis: { received: INBOX, delivered: DONE, failed: FAIL } } }], { alpha: {} });
    fleet.reactMessageStatus("alpha", "g", "m", "received", "t");
    fleet.reactMessageStatus("alpha", "g", "m", "failed", "t");
    await flush();
    expect(d.react.mock.calls.map(c => c[2])).toEqual(["inbox:111111111111111111", "fail:333333333333333333"]);
    fleet.finishDeliveryStatus("alpha", "g", "m", "delivered", "t");
    await flush();
    expect(d.unreact).toHaveBeenCalledWith("t", "m", "fail:333333333333333333", "t");
    expect([...d.visible]).toEqual(["inbox:111111111111111111", "done:222222222222222222"]);
  });

  it("an instance override beats its channel's map", async () => {
    const d = recorder("discord", "discord");
    const { fleet } = makeFleet([{ id: "discord", type: "discord", adapter: d.adapter, options: { status_emojis: { delivered: "🎯" } } }],
      { alpha: { status_emojis: { delivered: "🦊" } }, beta: {} });
    fleet.finishDeliveryStatus("alpha", "g", "m1", "delivered");
    fleet.finishDeliveryStatus("beta", "g", "m2", "delivered");
    await flush();
    expect(d.react.mock.calls.map(c => [c[1], c[2]])).toEqual([["m1", "🦊"], ["m2", "🎯"]]);
  });

  it("telegram: an invalid value warns once and falls back; a valid one is used, spelled as Telegram spells it", async () => {
    const t = telegramRecorder("telegram");
    const { fleet, warn } = makeFleet([{ id: "telegram", type: "telegram", adapter: t.adapter, options: { status_emojis: { delivered: "✅", failed: "❤️" } } }], { alpha: {} });
    fleet.finishDeliveryStatus("alpha", "100", "1", "delivered");
    await flush();
    expect(t.visible()).toEqual(["👀"]); // built-in Telegram delivered
    fleet.finishDeliveryStatus("alpha", "100", "2", "delivered");
    await flush();
    expect(warn.mock.calls.filter(c => String(c[1]).includes("status_emojis.delivered"))).toHaveLength(1);
    fleet.finishDeliveryStatus("alpha", "100", "3", "failed");
    await flush();
    expect(t.visible()).toEqual(["❤"]);
  });
});

describe("the reaction filter follows config (#1005 point 3)", () => {
  const r = (over: Partial<InboundReaction>): InboundReaction => ({
    source: "discord", adapterId: "discord", chatId: "g", threadId: "t", messageId: "m",
    userId: "someone", username: "someone", emoji: "👍", action: "add", timestamp: new Date(), ...over,
  });

  it("drops a sibling bot's custom status stamp but keeps its other reactions and every human reaction", async () => {
    const a = recorder("bot-a", "discord"); const b = recorder("bot-b", "discord");
    const { internals, eventLog } = makeFleet([
      { id: "bot-a", type: "discord", adapter: a.adapter, botUserId: "uid-a", options: { status_emojis: { received: INBOX } } },
      { id: "bot-b", type: "discord", adapter: b.adapter, botUserId: "uid-b" },
    ], { alpha: { channel_id: "bot-a" }, beta: { channel_id: "bot-b" } });
    // bot-a stamps its custom received emoji: Discord reports name + id.
    await internals.handleInboundReaction(r({ userId: "uid-a", username: "bot-a", emoji: "inbox", emojiId: "111111111111111111", messageId: "m1" }));
    await internals.handleInboundReaction(r({ userId: "uid-a", username: "bot-a", emoji: "✅", messageId: "m2" }));
    expect(eventLog.pendingReactions("alpha")).toBeNull();
    // An agent signal from the same bot passes.
    await internals.handleInboundReaction(r({ userId: "uid-a", username: "bot-a", emoji: "🎯", messageId: "m3" }));
    // A human's ✅ and 👀 are opinions, not plumbing.
    await internals.handleInboundReaction(r({ userId: "human", username: "han", emoji: "✅", messageId: "m4" }));
    // bot-b never stamps :inbox:, so from bot-b it is a real reaction.
    await internals.handleInboundReaction(r({ userId: "uid-b", username: "bot-b", emoji: "inbox", emojiId: "111111111111111111", messageId: "m5" }));
    const summary = eventLog.pendingReactions("alpha")!.summary;
    expect(summary).toContain("🎯 from bot-a");
    expect(summary).toContain("✅ from han");
    expect(summary).toContain("inbox from bot-b");
  });

  it("without every bot id, falls back to the emoji — configured custom stamps included", async () => {
    const a = recorder("bot-a", "discord");
    const { internals, eventLog } = makeFleet([
      { id: "bot-a", type: "discord", adapter: a.adapter, options: { status_emojis: { delivered: DONE } } },
    ], { alpha: {} });
    await internals.handleInboundReaction(r({ emoji: "done", emojiId: "222222222222222222", messageId: "m1" }));
    await internals.handleInboundReaction(r({ emoji: "❌", messageId: "m2" }));
    expect(eventLog.pendingReactions("alpha")).toBeNull();
    // Same name, different id: somebody else's emoji.
    await internals.handleInboundReaction(r({ emoji: "done", emojiId: "999999999999999999", messageId: "m3" }));
    await internals.handleInboundReaction(r({ emoji: "👎", messageId: "m4" }));
    const summary = eventLog.pendingReactions("alpha")!.summary;
    expect(summary).toContain("m3: done");
    expect(summary).toContain("m4: 👎");
  });
});

describe("the instructions and progress text use the same map (#1005)", () => {
  it("tells each instance to avoid its own status set, custom emoji as :name:", () => {
    const d = recorder("discord", "discord");
    const { fleet } = makeFleet([{ id: "discord", type: "discord", adapter: d.adapter, options: { status_emojis: { received: INBOX, delivered: DONE } } }],
      { alpha: {}, beta: { status_emojis: { received: "👀", delivered: "✅" } } });
    const alpha = fleet.statusEmojiAvoidList("alpha");
    expect(alpha).toEqual([":inbox:", "⏳", "👀", ":done:", "❌"]);
    const text = buildFleetInstructions({ instanceName: "alpha", workingDirectory: "/w", statusEmojis: alpha });
    expect(text).toContain("avoid these AgEnD system emojis: :inbox: ⏳ 👀 :done: ❌ (used for delivery status)");
    expect(text).not.toContain("👀 ⏳ ✅ ❌");
    // The built-in set leaves the template exactly as it was.
    const beta = buildFleetInstructions({ instanceName: "beta", workingDirectory: "/w", statusEmojis: fleet.statusEmojiAvoidList("beta") });
    expect(beta).toContain("avoid these AgEnD system emojis: 👀 ⏳ ✅ ❌ (used for delivery status)");
  });

  it("leads the progress bubble with progress_prefix, in the channel's text form", () => {
    expect(FleetManager.progressText(1_000, null, 30_000, "<:inbox:111111111111111111>")).toBe("<:inbox:111111111111111111> 處理中…");
    expect(FleetManager.progressText(40_000, null, 30_000, "🦊")).toBe("🦊 處理中… (已進行 0m 40s)");
    const d = recorder("discord", "discord");
    const { fleet } = makeFleet([{ id: "discord", type: "discord", adapter: d.adapter, options: { status_emojis: { progress_prefix: FAIL } } }], { alpha: {}, });
    const prefix = (fleet as unknown as { progressPrefixFor(n: string): string | undefined }).progressPrefixFor("alpha");
    expect(prefix).toBe("<:fail:333333333333333333>");
  });
});

describe("validate status_emojis (#1005)", () => {
  const base = (extra: Record<string, unknown>, options?: Record<string, unknown>) => ({
    channels: [{ id: "tg", type: "telegram", mode: "topic", bot_token_env: "T", access: { mode: "open" }, ...(options ? { options } : {}) }],
    defaults: {}, instances: { alpha: { working_directory: "/w", ...extra } },
  });
  it("warns (not errors) on an emoji the platform cannot use; errors on a malformed map", () => {
    const res = validateFleetConfig(base({ status_emojis: { delivered: "✅" } }, { status_emojis: { failed: INBOX, bogus: "👍" } }));
    expect(res.errors).toEqual([]);
    expect(res.warnings.map(w => w.path)).toEqual(expect.arrayContaining([
      "channels[0].options.status_emojis.failed", "channels[0].options.status_emojis.bogus", "instances.alpha.status_emojis.delivered",
    ]));
    const bad = validateFleetConfig(base({ status_emojis: ["👍"] }, { status_emojis: { delivered: 5 } }));
    expect(bad.errors.map(e => e.path)).toEqual(expect.arrayContaining(["instances.alpha.status_emojis", "channels[0].options.status_emojis.delivered"]));
  });
});

describe("daemon delivery events name the status, not an emoji (#1005)", () => {
  it("queued / delivered→processing / confirmed→delivered / failed", async () => {
    const { InstanceLifecycle } = await import("../src/instance-lifecycle.js");
    const { EventEmitter } = await import("node:events");
    const react = vi.fn(); const finish = vi.fn();
    const lifecycle = new InstanceLifecycle({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      reactMessageStatus: react, finishDeliveryStatus: finish,
    } as any);
    const daemon = new EventEmitter();
    lifecycle.attachDeliveryStatusHandlers("alpha", daemon as any);
    const data = { chatId: "c", messageId: "m", threadId: "t" };
    for (const e of ["message_queued", "message_delivered", "message_confirmed", "message_failed"]) daemon.emit(e, data);
    expect(react.mock.calls.map(c => c[3])).toEqual(["queued", "processing"]);
    expect(finish.mock.calls.map(c => c[3])).toEqual(["delivered", "failed"]);
  });
});

describe("the instance's instructions carry its resolved avoid-list (#1005 addendum 1)", () => {
  it("lifecycle.start wires the list, and the daemon's system prompt names :inbox: instead of 👀", async () => {
    const { Daemon } = await import("../src/daemon.js");
    const root = mkdtempSync(join(tmpdir(), "agend-1005-life-"));
    dirs.push(root);
    const wd = join(root, "w");
    const fleet = new FleetManager(join(root, "fleet"));
    const worker = { backend: "claude-code", working_directory: wd } as any;
    (fleet as any).fleetConfig = {
      channels: [{ id: "discord", type: "discord", mode: "topic", bot_token_env: "FAKE", access: { mode: "open" }, options: { status_emojis: { received: INBOX, processing: INBOX } } }],
      defaults: {}, instances: { worker },
    };
    let built: string | undefined;
    vi.spyOn(Daemon.prototype, "start").mockImplementation(async function (this: InstanceType<typeof Daemon>) {
      built = (this as any).buildBackendConfig().instructions;
      throw new Error("stop before spawning");
    });
    try {
      await fleet.lifecycle.start("worker", worker, false).catch(() => {});
    } finally {
      vi.restoreAllMocks();
    }
    expect(built).toContain("avoid these AgEnD system emojis: :inbox: ⏳ ✅ ❌ (used for delivery status)");
  });
});

describe("classic bots stamp the configured received emoji (#1005 point 4)", () => {
  it("/chat in a classic channel reacts with the channel's received value", async () => {
    const { ClassicChannelManager } = await import("../src/classic-channel-manager.js");
    const logMessage = vi.spyOn(ClassicChannelManager, "logMessage").mockImplementation(() => {});
    const d = recorder("discord", "discord");
    const { fleet } = makeFleet([{ id: "discord", type: "discord", adapter: d.adapter, options: { status_emojis: { received: INBOX } } }], {});
    const internals = fleet as unknown as {
      classicChannels: unknown;
      forwardToClassicInstance: (...a: unknown[]) => Promise<void>;
      handleClassicChannelMessage(name: string, msg: unknown): Promise<void>;
    };
    internals.classicChannels = { isCollab: () => false, getAll: () => [] };
    internals.forwardToClassicInstance = vi.fn(async () => {});
    try {
      await internals.handleClassicChannelMessage("classic-room", {
        source: "discord", adapterId: "discord", chatId: "guild", threadId: "channel-1", messageId: "m-1",
        userId: "u", username: "han", text: "/chat hello", timestamp: new Date(),
      });
      expect(d.react).toHaveBeenCalledWith("channel-1", "m-1", "inbox:111111111111111111");
    } finally {
      logMessage.mockRestore();
    }
  });
});
