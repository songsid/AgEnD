/**
 * #3340: in a ClassicBot room, a REPLY whose body is only the bot's @mention asks about the replied-to message. It is forwarded to the agent with that
 * message as reply_to_text. A bare @mention that is not a reply keeps today's behaviour (Discord: dropped; Telegram: forwarded as "@bot (you)").
 * Discord: ClassicBot rooms are in collab mode, where the mention-stripped empty text returned before anything (the bug). Telegram: no collab;
 * the text becomes "/chat @bot (you)" and was already forwarded (a guard of the same shape). Mocks only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { AdapterWorld } from "../src/adapter-world.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import type { ChannelAdapter } from "../src/channel/types.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
const OPEN = { mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 0 };
const QUOTED = "Can someone check why the nightly build failed?";

function discordRoom() {
  const dir = mkdtempSync(join(tmpdir(), "agend-3340-dc-")); dirs.push(dir);
  const fleetPath = join(dir, "fleet.yaml");
  writeFileSync(fleetPath, ["channels:", "  - { id: dc, type: discord, mode: topic, bot_token_env: FAKE_DC, group_id: guild-1, access: { mode: open } }",
    "defaults:", "  backend: claude-code", "instances: {}", ""].join("\n"));
  const fm = new FleetManager(dir) as any;
  fm.loadConfig(fleetPath);
  const adapter = { id: "dc", type: "discord", react: vi.fn(async () => {}), unreact: vi.fn(async () => {}) } as unknown as ChannelAdapter;
  const world = new AdapterWorld("dc", adapter, new AccessManager(OPEN as any, join(dir, "a.json")), fm.fleetConfig.channels[0]);
  world.botUserId = "BOT"; world.botUsername = "IGSHanBot";
  fm.worlds.set("dc", world);
  fm.classicChannels = { getReplyTriggers: () => true, isCollab: () => true, getInstanceByChannel: () => "classic-room" };
  vi.spyOn(ClassicChannelManager, "logMessage").mockImplementation(() => {});
  vi.spyOn(fm, "reactClassicReceived").mockResolvedValue(undefined);
  const forward = vi.fn(async () => {});
  fm.forwardToClassicInstance = forward;
  /** A person posts, as the Discord adapter emits it: a reply to someone else's message carries replyTo, replyToText and that author's id. */
  const post = (text: string, reply?: { text: string; authorId: string }) => fm.handleClassicChannelMessage("classic-room", {
    source: "discord", adapterId: "dc", chatId: "guild-1", threadId: "555", messageId: `m-${Math.random()}`, userId: "HUMAN", username: "han",
    text, humanOriginalBody: text, timestamp: new Date(), isBotMessage: false,
    ...(reply ? { replyTo: "r-1", replyToText: reply.text, replyToAuthorId: reply.authorId } : {}),
  });
  return { forward, post, react: fm.reactClassicReceived as ReturnType<typeof vi.fn> };
}

describe("#3340 Discord ClassicBot: a reply that is only @bot", () => {
  it("is forwarded, with the replied-to message as reply_to_text, and gets the received reaction", async () => {
    const r = discordRoom();
    await r.post("<@BOT>", { text: QUOTED, authorId: "ANOTHER-PERSON" });
    expect(r.forward).toHaveBeenCalledTimes(1);
    const [instance, text, msg] = r.forward.mock.calls[0] as unknown as [string, string, { replyToText?: string }];
    expect(instance).toBe("classic-room");
    expect(text).toBe("@IGSHanBot (you)");
    expect(msg.replyToText).toBe(QUOTED);
    expect(r.react).toHaveBeenCalledTimes(1);
  });
  it("a bare @bot that is not a reply: still dropped (today's behaviour), no reaction", async () => {
    const r = discordRoom();
    await r.post("<@BOT>");
    expect(r.forward).not.toHaveBeenCalled(); expect(r.react).not.toHaveBeenCalled();
  });
  it("the control: a reply with words after @bot is forwarded as before", async () => {
    const r = discordRoom();
    await r.post("<@BOT> what do you think?", { text: QUOTED, authorId: "ANOTHER-PERSON" });
    expect(r.forward).toHaveBeenCalledTimes(1);
    expect((r.forward.mock.calls[0] as unknown as unknown[])[1]).toBe("@IGSHanBot (you) what do you think?");
  });
});

describe("#3340 Telegram ClassicBot: the same shape (a reply that is only @bot)", async () => {
  const pino = (await import("pino")).default;
  const GROUP = "-1003903467272";
  function tgRoom() {
    const dir = join(tmpdir(), `agend-3340-tg-${Date.now()}-${Math.random()}`); mkdirSync(dir, { recursive: true }); dirs.push(dir);
    const fm = new FleetManager(dir) as any;
    const tgCfg: any = { id: "tg", type: "telegram", mode: "topic", group_id: "-1001111111111", access: { mode: "open", allowed_users: [] } };
    const tg = { id: "tg", type: "telegram", react: vi.fn().mockResolvedValue(undefined), unreact: vi.fn().mockResolvedValue(undefined), sendText: vi.fn().mockResolvedValue({ messageId: "m", chatId: "c" }) } as any;
    fm.adapter = tg;
    fm.worlds.set("tg", { id: "tg", adapter: tg, channelConfig: tgCfg, groupId: "-1001111111111", botUsername: "IGSHanBot" } as any);
    fm.fleetConfig = { defaults: {}, channels: [tgCfg], instances: { general: { working_directory: dir, topic_id: 1, general_topic: true } } } as any;
    fm.routing.rebuild(fm.fleetConfig);
    vi.spyOn(fm.topicCommands, "handleInstanceCommand").mockResolvedValue(false);
    vi.spyOn(fm.topicCommands, "handleGeneralCommand").mockResolvedValue(false);
    vi.spyOn(fm.topicCommands, "handleUnboundTopic").mockImplementation(() => {});
    vi.spyOn(fm, "sendCancelButton").mockResolvedValue(undefined);
    vi.spyOn(fm, "getRecentChatLog").mockReturnValue("");
    vi.spyOn(ClassicChannelManager, "logMessage").mockImplementation(() => {});
    const deliver = vi.spyOn(fm, "deliverToInstance").mockResolvedValue(undefined);
    const cm = new ClassicChannelManager(dir, pino({ level: "silent" }) as any);
    cm.setPrimaryAdapterId("tg");
    cm.register(GROUP, "tg", "classic-tg", "group", "owner", "claude-code");
    fm.classicChannels = cm;
    let seq = 0;
    const post = (text: string, replyToText?: string) => fm.handleInboundMessage({ source: "telegram", adapterId: "tg", chatId: GROUP, messageId: `t${++seq}`, userId: "u1", username: "han",
      text, timestamp: new Date(), ...(replyToText ? { replyTo: "99", replyToText } : {}) });
    return { deliver, post };
  }
  it("is forwarded with the replied-to message as reply_to_text", async () => {
    const r = tgRoom();
    await r.post("@IGSHanBot", QUOTED);
    expect(r.deliver).toHaveBeenCalledTimes(1);
    expect((r.deliver.mock.calls[0]![1] as any).meta).toMatchObject({ reply_to_text: QUOTED });
  });
});
