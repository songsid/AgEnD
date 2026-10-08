/** #1104: first /start must have the same bot-scoped dedup as registered Classic chats. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "grammy";
import type { Update } from "grammy/types";
import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { AdapterWorld } from "../src/adapter-world.js";
import { AccessManager } from "../src/channel/access-manager.js";
import type { InboundMessage } from "../src/channel/types.js";
import type { ChannelConfig } from "../src/types.js";

const GROUP = "-1003333333333";
const PRIMARY_GROUP = "-1001111111111";
const SECONDARY_GROUP = "-1002222222222";
const dirs: string[] = [];
const liveAdapters: TelegramAdapter[] = [];

afterEach(async () => {
  // No adapter.start/polling was called. Stop only the private in-memory
  // grammy object and its HTTP agents; never a fleet/process lifecycle.
  for (const adapter of liveAdapters.splice(0)) await adapter.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(sharedFleetGroup = false) {
  const dir = mkdtempSync(join(tmpdir(), "agend-start-dedup-"));
  dirs.push(dir);
  writeFileSync(join(dir, "classicBot.yaml"), `defaults:\n  allowed_groups: ["${GROUP}"]\n  allowed_users: ["42"]\n  admin_users: ["42"]\n`);
  const fleet = new FleetManager(dir);
  const state = fleet as any;
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  state.logger = log;
  const config = (id: string, group_id: string): ChannelConfig => ({
    id, type: "telegram", mode: "topic", group_id, bot_token_env: "UNUSED_TEST_TOKEN",
    access: { mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 0 },
  });
  const channels = [config("primary", PRIMARY_GROUP), config("secondary", sharedFleetGroup ? PRIMARY_GROUP : SECONDARY_GROUP)];
  const inbound: InboundMessage[] = [];
  let updateId = 0;
  const worlds = channels.map((channel, index) => {
    const access = new AccessManager(channel.access!, join(dir, `access-${channel.id}.json`));
    const adapter = new TelegramAdapter({ id: channel.id!, botToken: `${index + 100}:test-only`, accessManager: access, inboxDir: join(dir, `inbox-${index}`) });
    liveAdapters.push(adapter);
    const bot = (adapter as unknown as { bot: Bot }).bot;
    // Real grammY dispatch, supplied identity avoids getMe/init/polling.
    const username = index === 0 ? "PrimaryBot" : "TargetBot";
    bot.botInfo = {
      id: index + 100, is_bot: true, first_name: username, username,
      can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
      allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
    };
    // Every possible external call fails locally rather than reaching Telegram.
    bot.api.config.use(async () => { throw new Error("Unexpected Telegram API call in routing test"); });
    vi.spyOn(adapter, "sendText").mockImplementation(async chatId => ({ chatId, messageId: "reply" }));
    vi.spyOn(adapter, "react").mockResolvedValue(undefined);
    const world = new AdapterWorld(channel.id!, adapter, access, channel);
    world.botUsername = username;
    world.botUserId = String(index + 100);
    fleet.worlds.set(channel.id!, world);
    const pending: Promise<void>[] = [];
    adapter.on("message", (message: InboundMessage) => {
      inbound.push(message);
      pending.push(state.handleInboundMessage(message));
    });
    async function feed(text: string, messageId = 10, chatId = GROUP, threadId?: number, userId = 42) {
      const update = {
        update_id: ++updateId,
        message: {
          message_id: messageId, date: 1_800_000_000,
          from: { id: userId, is_bot: false, first_name: "Human", username: "human" },
          chat: chatId.startsWith("-") ? { id: Number(chatId), type: "supergroup", title: "Test Group" } : { id: Number(chatId), type: "private", first_name: "Human" },
          text, ...(threadId ? { message_thread_id: threadId, is_topic_message: true } : {}),
          ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}),
        },
      } as Update;
      await bot.handleUpdate(update);
      await Promise.all(pending.splice(0));
    }
    return { adapter, world, feed };
  });
  state.adapter = worlds[0]!.adapter;
  fleet.fleetConfig = { channels, defaults: { backend: "codex" }, instances: {
    worker: { backend: "codex", working_directory: dir, channel_id: "primary", topic_id: 30 },
  } } as any;
  fleet.routing.rebuild(fleet.fleetConfig!);
  const classic = new ClassicChannelManager(dir, log as any);
  classic.configureAdapters(channels);
  fleet.classicChannels = classic;
  // Exact production onboarding/registration/binding stays active. These are
  // the only calls that could otherwise spawn daemons/panes or send work.
  const start = vi.spyOn(state, "startClassicInstance").mockResolvedValue(undefined);
  vi.spyOn(state, "reregisterClassicChannels").mockImplementation(() => {});
  const select = vi.spyOn(state, "beginClassicBackendSelection").mockResolvedValue(undefined);
  const deliver = vi.spyOn(fleet, "deliverToInstance").mockResolvedValue(undefined);
  vi.spyOn(state, "sendCancelButton").mockResolvedValue(undefined);
  vi.spyOn(state.topicCommands, "handleInstanceCommand").mockResolvedValue(false);
  vi.spyOn(state.topicCommands, "handleGeneralCommand").mockResolvedValue(false);
  return { fleet, state, classic, start, select, deliver, inbound, primary: worlds[0]!, target: worlds[1]! };
}

describe("Telegram ClassicBot onboarding dedup (#1104)", () => {
  for (const order of ["sibling-first", "target-first"] as const) {
    it(`${order}: targeted /start registers/starts only the intended bot in an unregistered group`, async () => {
      const h = setup();
      expect(h.classic.hasChannel(GROUP)).toBe(false);
      const copies = order === "sibling-first" ? [h.primary, h.target] : [h.target, h.primary];
      for (const copy of copies) await copy.feed("/start@tArGeTbOt codex");
      expect(h.inbound.map(m => m.adapterId)).toEqual(copies.map(c => c.adapter.id));
      expect(h.start).toHaveBeenCalledTimes(1);
      const name = h.classic.getInstanceByChannel(GROUP, "secondary");
      expect(name).toBeDefined();
      expect(h.classic.getInstanceByChannel(GROUP, "primary")).toBeUndefined();
      expect(h.classic.getAdapterIdByInstance(name!)).toBe("secondary");
      expect(h.state.getAdapterForInstance(name!)).toBe(h.target.adapter);
      expect(h.target.adapter.sendText).toHaveBeenCalledTimes(1);
      expect(h.primary.adapter.sendText).not.toHaveBeenCalled();
    });
  }

  it("same-bot retransmission of a targeted command is still deduplicated before registration", async () => {
    const h = setup();
    await h.primary.feed("/start@TargetBot");
    await h.target.feed("/start@TargetBot");
    await h.target.feed("/start@TargetBot");
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.select).toHaveBeenCalledWith(expect.objectContaining({ command: "start", channelId: GROUP }), h.target.adapter);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.classic.hasChannel(GROUP)).toBe(false);
  });

  it("retransmission after registration does not change the dedup namespace", async () => {
    const h = setup();
    await h.target.feed("/start@TargetBot codex");
    await h.target.feed("/start@TargetBot codex");
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.target.adapter.sendText).toHaveBeenCalledTimes(1);
  });

  it("two bot private chats with equal user/chat/message ids have independent onboarding selectors", async () => {
    const h = setup();
    await h.primary.feed("/start", 10, "42");
    await h.target.feed("/start", 10, "42");
    expect(h.select).toHaveBeenCalledTimes(2);
    expect(h.select.mock.calls.map(c => (c[1] as TelegramAdapter).id)).toEqual(["primary", "secondary"]);
    expect(h.classic.hasChannel("42")).toBe(false);
  });

  it("two bot private chats still register separate instances", async () => {
    const h = setup();
    await h.primary.feed("/start codex", 10, "42");
    await h.target.feed("/start codex", 10, "42");
    expect(h.start).toHaveBeenCalledTimes(2);
    const primaryName = h.classic.getInstanceByChannel("42", "primary");
    const targetName = h.classic.getInstanceByChannel("42", "secondary");
    expect(primaryName).toBeDefined();
    expect(targetName).toBeDefined();
    expect(primaryName).not.toBe(targetName);
  });

  it("bare group slash commands remain ignored for both bots", async () => {
    const h = setup();
    await h.primary.feed("/start codex");
    await h.target.feed("/start codex");
    expect(h.start).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
    expect(h.primary.adapter.sendText).not.toHaveBeenCalled();
    expect(h.target.adapter.sendText).not.toHaveBeenCalled();
  });

  it("targeted group onboarding still refuses non-admins", async () => {
    const h = setup();
    await h.primary.feed("/start@TargetBot codex", 10, GROUP, undefined, 43);
    await h.target.feed("/start@TargetBot codex", 10, GROUP, undefined, 43);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
    expect(h.target.adapter.sendText).toHaveBeenCalledTimes(1);
    expect(h.primary.adapter.sendText).not.toHaveBeenCalled();
  });

  it("targeted non-admin onboarding still requires the group allowlist", async () => {
    const h = setup();
    await h.primary.feed("/start@TargetBot codex", 10, "-1004444444444", undefined, 43);
    await h.target.feed("/start@TargetBot codex", 10, "-1004444444444", undefined, 43);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.target.adapter.sendText).toHaveBeenCalledTimes(1);
    expect(h.primary.adapter.sendText).not.toHaveBeenCalled();
  });

  it("targeted onboarding in a foreign forum topic is also bot-scoped", async () => {
    const h = setup();
    await h.primary.feed("/start@TargetBot codex", 10, GROUP, 30);
    await h.target.feed("/start@TargetBot codex", 10, GROUP, 30);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.classic.getInstanceByChannel(GROUP, "secondary")).toBeDefined();
  });

  it("fleet topic copies on two adapters sharing a fleet group remain globally deduplicated", async () => {
    const h = setup(true);
    await h.primary.feed("hello", 10, PRIMARY_GROUP, 30);
    await h.target.feed("hello", 10, PRIMARY_GROUP, 30);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledWith("worker", expect.anything());
    expect(h.start).not.toHaveBeenCalled();
  });

  it("the fleet group's general messages without a topic also keep shared dedup", async () => {
    const h = setup(true);
    h.fleet.fleetConfig!.instances.general = {
      ...h.fleet.fleetConfig!.instances.worker!, general_topic: true, topic_id: 1,
    };
    h.state.daemons.set("general", {});
    h.fleet.routing.rebuild(h.fleet.fleetConfig!);
    await h.primary.feed("hello", 10, PRIMARY_GROUP);
    await h.target.feed("hello", 10, PRIMARY_GROUP);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledWith("general", expect.anything());
    expect([...h.state.recentMessageIds]).toEqual([`telegram:${PRIMARY_GROUP}:10`]);
  });
});
