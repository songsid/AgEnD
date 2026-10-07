/** Real HTTP send → FleetManager IPC/reply path → actual adapter → stub API.
 * No fleet startup, bot polling, process/CLI/tmux or external network. */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Collection, type Client } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { WEB_ECHO_PREFIX, formatWebChannelEcho, neutralizeWebEchoText, isWebChannelEcho } from "../src/web-channel-echo.js";
import { setLocale } from "../src/locale.js";

// Fail fast if a regression escapes the intended in-process/IO seams.
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }),
  rotateLogIfNeeded: () => { throw new Error("log rotation is outside this harness"); },
  rotateLogIfNeededAsync: async () => { throw new Error("log rotation is outside this harness"); },
}));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const blocked = () => { throw new Error("process execution is outside this harness"); };
  return { ...original, spawn: blocked, spawnSync: blocked, exec: blocked, execSync: blocked, execFile: blocked, execFileSync: blocked, fork: blocked };
});


const TOKEN = "t".repeat(48), dirs: string[] = [], managers: FleetManager[] = [];
const OPEN = { mode: "open" as const, allowed_users: [] as string[], max_pending_codes: 0, code_expiry_minutes: 0 };
const flush = () => new Promise<void>(r => setImmediate(r));
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => {
  for (const fm of managers.splice(0)) {
    const s = fm as any;
    for (const key of ["sessionPruneTimer", "replyObligationTimer"]) clearInterval(s[key]);
  }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setLocale("en");
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

async function harness(type: "telegram" | "discord", botId = "777") {
  const peerId = botId === "777" ? "888" : "777";
  const dir = mkdtempSync(join(tmpdir(), "echo-1320-")); dirs.push(dir);
  vi.stubEnv("AGEND_HOME", dir);
  const fm = new FleetManager(dir); managers.push(fm); const s = fm as any;
  const sent: Array<{ chatId: string; topic: string; text: string }> = [], discordPayloads: any[] = [], telegramPayloads: any[] = [], ingress: unknown[] = [], received: any[] = [];
  let holdEcho: Promise<void> | undefined, failEcho: "throw" | "reject" | undefined;
  const api = vi.fn(async (chatId: string, topic: string, text: string) => {
    if (text.startsWith(WEB_ECHO_PREFIX) && holdEcho) await holdEcho;
    if (text.startsWith(WEB_ECHO_PREFIX) && failEcho === "reject") throw new Error("stub API refused");
    sent.push({ chatId, topic, text });
    return { messageId: String(sent.length), chatId, threadId: topic };
  });
  let adapter: TelegramAdapter | DiscordAdapter; let feed: (text: string, sender?: "self" | "human" | "peer" | "external", rich?: boolean) => Promise<void>;
  const chatId = type === "telegram" ? "-100222" : "guild", topic = type === "telegram" ? "27" : "topic";
  if (type === "telegram") {
    adapter = new TelegramAdapter({ id: "owner", botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", accessManager: { isAllowed: () => ({ allowed: true }) } as never, inboxDir: dir });
    const bot = adapter.getBot();
    (bot as any).botInfo = { id: Number(botId), is_bot: true, first_name: "EchoBot", username: "echo_bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
    (bot as any).api.config.use(async (_prev: unknown, method: string, payload: any) => {
      telegramPayloads.push(payload);
      if (method !== "sendMessage") throw new Error(`unexpected Bot API ${method}`);
      const result = await api(String(payload.chat_id), String(payload.message_thread_id), payload.text);
      return { ok: true, result: { message_id: Number(result.messageId), date: 1, chat: { id: Number(chatId), type: "supergroup" }, text: payload.text } };
    });
    let id = 0;
    feed = async (text, sender = "self", rich = false) => {
      const message = { message_id: ++id, date: 1, chat: { id: Number(chatId), type: "supergroup", is_forum: true }, message_thread_id: Number(topic), from: { id: sender === "self" ? Number(botId) : sender === "peer" ? Number(peerId) : sender === "external" ? 444 : 999, is_bot: sender !== "human", first_name: sender }, ...(rich ? { rich_message: { blocks: [{ type: "text", text }] } } : { text }) };
      await bot.handleUpdate({ update_id: id, message } as never); await flush();
    };
  } else {
    const client = Object.assign(new EventEmitter(), {
      user: { id: botId, username: "EchoBot" }, isReady: () => true,
      channels: { fetch: vi.fn(async (id: string) => ({ isTextBased: () => true, send: async (value: string | { content: string }) => { discordPayloads.push(value); const text = typeof value === "string" ? value : value.content; const result = await api(chatId, id, text); return { id: result.messageId }; } })) },
    });
    adapter = new DiscordAdapter({ id: "owner", botToken: "fake", accessManager: {} as never, inboxDir: dir, guildId: chatId, registerCommands: false, clientFactory: () => client as unknown as Client });
    let id = 0;
    feed = async (text, sender = "self") => {
      client.emit("messageCreate", { id: String(++id), guildId: chatId, channelId: topic, author: { id: sender === "self" ? botId : sender === "peer" ? peerId : sender === "external" ? "444" : "999", username: sender, bot: sender !== "human" }, content: text, embeds: [], attachments: new Collection(), createdAt: new Date() });
      await flush(); await flush();
    };
  }
  const primary = { id: "primary", type, getBotUserId: (): string | undefined => peerId, sendText: vi.fn(async () => { throw new Error("wrong world"); }) };
  s.fleetConfig = { defaults: {}, channels: [{ id: "primary", type, group_id: type === "telegram" ? "-100111" : "wrong-guild", access: OPEN }, { id: "owner", type, group_id: chatId, access: OPEN }], instances: { worker: { working_directory: dir, channel_id: "owner", topic_id: topic } } };
  s.adapter = primary; vi.spyOn(s, "webToken", "get").mockReturnValue(TOKEN);
  s.worlds.set("primary", { id: "primary", adapter: primary, groupId: "wrong" });
  s.worlds.set("owner", { id: "owner", adapter, groupId: chatId, channelConfig: s.fleetConfig.channels[1], accessManager: new AccessManager(OPEN, join(dir, "access.json")) });
  s.routing.rebuild(s.fleetConfig);
  s.lifecycle.isPaused = vi.fn(() => false);
  s.getInstanceIdle = () => true; s.clearCancelButton = () => {}; s.reactDone = () => {};
  s.sendCancelButton = vi.fn(async () => {}); s.setTopicIcon = vi.fn(); s.reactMessageStatus = vi.fn();
  s.warnIfRateLimited = vi.fn(); s.afterReplyRouted = vi.fn();
  s.topicCommands.handleInstanceCommand = vi.fn(async () => false); s.topicCommands.handleGeneralCommand = vi.fn(async () => false);
  s.logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  s.emitSseEvent = vi.fn();
  s.instanceIpcClients.set("worker", { connected: true, send: (m: any) => { received.push(m); return true; } });
  const inbound: Promise<void>[] = [];
  adapter.on("message", msg => { ingress.push(msg); inbound.push(s.handleInboundMessage(msg)); });
  const realSend = adapter.sendText.bind(adapter);
  vi.spyOn(adapter, "sendText").mockImplementation((...args) => { if (failEcho === "throw" && args[1].startsWith(WEB_ECHO_PREFIX)) throw new Error("sync failure"); return realSend(...args); });
  return { fm, s, adapter, primary, sent, received, ingress, api, chatId, topic, discordPayloads, telegramPayloads,
    feed: async (...args: Parameters<typeof feed>) => { await feed(...args); await Promise.all(inbound.splice(0)); },
    hold: (promise?: Promise<void>) => { holdEcho = promise; }, fail: (how: "throw" | "reject") => { failEcho = how; },
    reply: (text = "done") => s.handleOutboundFromInstance("worker", { requestId: 9, tool: "reply", args: { text, chat_id: chatId } }),
  };
}
function send(fm: FleetManager, message = "hello", attachments: string[] = []) {
  const req = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/send", headers: { "x-agend-token": TOKEN }, destroy() {} });
  const done = deferred<{ status: number; body: any }>(); let status = 0;
  const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(body: string) { done.resolve({ status, body: JSON.parse(body) }); } };
  expect(handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL(req.url, "http://localhost"), fm as unknown as WebApiContext)).toBe(true);
  req.emit("data", Buffer.from(JSON.stringify({ instance: "worker", message, attachments }))); req.emit("end");
  return done.promise;
}

function orderingClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return {
    jump: (ms: number) => { now += ms; },
    advance: async (ms: number) => { now += ms; await vi.advanceTimersByTimeAsync(ms); await flush(); },
  };
}

describe("web echo review boundaries (#1325 r2)", () => {
  for (const type of ["telegram", "discord"] as const) {
    it(`${type}: never-settling echo releases the real reply at the 5s total budget`, async () => {
      const h = await harness(type), clock = orderingClock();
      h.hold(new Promise<void>(() => {}));
      expect((await send(h.fm)).status).toBe(200); await flush();
      const reply = h.reply(); await flush();
      await clock.advance(4999); expect(h.sent).toEqual([]);
      await clock.advance(1);
      expect(h.sent.map(m => m.text)).toEqual(["done"]); await reply;
      expect(h.s.webChannelEchoTails.size).toBe(0);
      expect(h.s.logger.warn).toHaveBeenCalledWith({ instanceName: "worker", inFlight: true }, "Web channel echo ordering timed out");
      expect(vi.getTimerCount()).toBe(0);
    });
    it(`${type}: a long rate-limit wait may finish late without retaining reply ordering`, async () => {
      const h = await harness(type), clock = orderingClock();
      h.hold(new Promise<void>(resolve => setTimeout(resolve, 60_000)));
      await send(h.fm); await flush(); const reply = h.reply();
      await clock.advance(5000);
      expect(h.sent.map(m => m.text)).toEqual(["done"]); await reply;
      await clock.advance(55_000);
      expect(h.sent.map(m => m.text)).toEqual(["done", formatWebChannelEcho("web-user", "hello")]);
      expect(h.s.logger.warn).toHaveBeenCalledWith({ instanceName: "worker" }, "Web channel echo completed late after ordering timeout");
      expect(h.s.webChannelEchoTails.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    });
    it(`${type}: timeout drops queued echoes; a subsequent echo and reply still run in order`, async () => {
      const h = await harness(type), clock = orderingClock(), first = deferred(), next = deferred();
      h.hold(first.promise); await send(h.fm, "first"); await flush();
      await clock.advance(1000); await send(h.fm, "drop this queued copy"); await flush();
      const reply = h.reply(); await clock.advance(4000);
      expect(h.api.mock.calls.map(call => call[2])).toEqual([formatWebChannelEcho("web-user", "first"), "done"]); await reply;
      expect(h.s.logger.warn).toHaveBeenCalledWith({ instanceName: "worker" }, "Queued web channel echo dropped after ordering timeout");
      h.hold(next.promise); await send(h.fm, "next"); await flush();
      const nextReply = h.reply("next done"); await flush();
      // An old physical ACK cannot clear the new queue or release its reply.
      first.resolve(); await flush(); expect(h.s.webChannelEchoTails.size).toBe(1);
      expect(h.sent.map(m => m.text)).toEqual(["done", formatWebChannelEcho("web-user", "first")]);
      next.resolve(); await nextReply; await flush();
      expect(h.sent.map(m => m.text)).toEqual(["done", formatWebChannelEcho("web-user", "first"), formatWebChannelEcho("web-user", "next"), "next done"]);
      expect(h.api.mock.calls.map(call => call[2])).not.toContain(formatWebChannelEcho("web-user", "drop this queued copy"));
      expect(vi.getTimerCount()).toBe(0);
    });
    it(`${type}: unknown configured identity quarantines bot echoes before trigger evaluation, then uses exact identity`, async () => {
      const h = await harness(type, "888"), echo = formatWebChannelEcho("web-user", "@other_bot /chat");
      h.primary.getBotUserId = () => undefined;
      expect(h.s.worlds.get("primary").botUserId).toBeUndefined();
      await h.feed(echo, "peer");
      expect(h.received).toEqual([]);
      expect(h.s.topicCommands.handleInstanceCommand).not.toHaveBeenCalled();
      expect(h.s.topicCommands.handleGeneralCommand).not.toHaveBeenCalled();
      expect(h.s.logger.debug).toHaveBeenCalledWith({ source: type, adapterId: "owner" }, "Web echo candidate quarantined while bot identities are pending");
      await h.feed(echo, "human"); expect(h.received).toHaveLength(1);
      await h.feed("ordinary peer input", "peer"); expect(h.received).toHaveLength(2);
      h.primary.getBotUserId = () => "777";
      await h.feed(echo, "peer"); expect(h.received).toHaveLength(2);
      await h.feed(echo, "external"); expect(h.received).toHaveLength(3);
      h.s.fleetConfig.channels[1].access = { ...OPEN, mode: "locked" };
      await h.feed(echo, "external"); expect(h.received).toHaveLength(3);
    });
    it(`${type}: an unregistered configured world also quarantines replays, without crossing platforms`, async () => {
      const h = await harness(type, "888"), echo = formatWebChannelEcho("web-user", "replayed");
      h.s.fleetConfig.channels.push({ id: "not-started", type, group_id: "absent", access: OPEN });
      await h.feed(echo, "external"); expect(h.received).toEqual([]);
      await h.feed(echo, "human"); expect(h.received).toHaveLength(1);
      h.s.worlds.set("not-started", { adapter: { type, getBotUserId: () => "333" } });
      await h.feed(echo, "external"); expect(h.received).toHaveLength(2);
      h.s.fleetConfig.channels.push({ id: "foreign-unknown", type: type === "telegram" ? "discord" : "telegram" });
      await h.feed(echo, "external"); expect(h.received).toHaveLength(3);
    });
  }
  it("the budget includes unresolved admission and cannot resurrect a timed-out reservation", async () => {
    const h = await harness("telegram"), clock = orderingClock(), echo = vi.fn(async () => {});
    const decide = h.fm.reserveWebChannelEcho("worker", echo), reply = h.reply();
    await clock.advance(5000);
    expect(h.sent.map(m => m.text)).toEqual(["done"]); await reply; expect(echo).not.toHaveBeenCalled();
    decide(true); await flush(); expect(echo).not.toHaveBeenCalled(); expect(h.s.webChannelEchoTails.size).toBe(0);
  });
  it("a queued copy cannot start after its monotonic deadline before the timer callback runs", async () => {
    const h = await harness("telegram"), clock = orderingClock(), echo = vi.fn(async () => {});
    const decide = h.fm.reserveWebChannelEcho("worker", echo);
    clock.jump(5000); decide(true); await flush();
    expect(echo).not.toHaveBeenCalled(); expect(h.s.webChannelEchoTails.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("an early timer rechecks monotonic time and a late rejection is consumed and tagged", async () => {
    const h = await harness("telegram"), clock = orderingClock();
    let reject!: (reason: Error) => void;
    h.hold(new Promise<void>((_resolve, r) => { reject = r; })); await send(h.fm); await flush();
    const reply = h.reply();
    await vi.advanceTimersByTimeAsync(5000); await flush(); // monotonic clock has not advanced
    expect(h.sent).toEqual([]);
    await clock.advance(5000);
    expect(h.sent.map(m => m.text)).toEqual(["done"]); await reply; reject(new Error("late rate-limit failure")); await flush();
    expect(h.s.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ instanceName: "worker", err: expect.any(Error) }), "Web channel echo failed late after ordering timeout");
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["ipc", "adapter", "group", "topic"])("timeout still respects the reply %s fence", async kind => {
    const h = await harness("telegram"), clock = orderingClock(); h.hold(new Promise<void>(() => {}));
    await send(h.fm); await flush(); const reply = h.reply(); await flush();
    const replacement = { connected: true, send: vi.fn(() => true) };
    if (kind === "ipc") h.s.instanceIpcClients.set("worker", replacement);
    if (kind === "adapter") h.s.worlds.get("owner").adapter = h.primary;
    if (kind === "group") h.s.worlds.get("owner").groupId = "-100333";
    if (kind === "topic") h.s.fleetConfig.instances.worker.topic_id = "99";
    await clock.advance(5000); await reply;
    expect(h.sent).toEqual([]); expect(replacement.send).not.toHaveBeenCalled();
    if (kind !== "ipc") expect(h.received.at(-1).error).toContain("Channel binding changed");
  });
});

describe("fleet-topic web echo (#1320 A)", () => {
  for (const type of ["telegram", "discord"] as const) {
    it(`${type}: owning world/topic and receipt metadata, own echo never becomes agent input`, async () => {
      const h = await harness(type); expect((await send(h.fm)).status).toBe(200); await flush();
      expect(h.sent).toEqual([{ chatId: h.chatId, topic: h.topic, text: formatWebChannelEcho("web-user", "hello") }]);
      expect(h.primary.sendText).not.toHaveBeenCalled();
      await h.s.handleInboundMessage({ source: type, adapterId: "primary", chatId: h.chatId, threadId: h.topic, messageId: "sibling-echo", userId: "777", username: "EchoBot", text: h.sent[0].text, isBotMessage: true, timestamp: new Date() });
      expect(h.received).toHaveLength(1);
      expect(h.received[0].meta).toMatchObject({ chat_id: h.chatId, thread_id: h.topic, adapter_id: "owner", source: "web" });
      await h.feed(h.sent[0].text); await h.feed("ordinary own message"); expect(h.ingress).toEqual([]); expect(h.received).toHaveLength(1);
      await h.feed("human control", "human"); await h.feed("peer bot control", "peer");
      expect(h.ingress).toHaveLength(2); expect(h.received.filter(m => m.type === "fleet_inbound")).toHaveLength(3);
    });
    it(`${type}: web HTTP does not wait for echo, but even an immediate agent reply does`, async () => {
      const h = await harness(type), gate = deferred(); h.hold(gate.promise);
      let reply!: Promise<void>;
      const ipc = h.s.instanceIpcClients.get("worker"); const original = ipc.send;
      ipc.send = (m: any) => { const result = original(m); if (m.type === "fleet_inbound") reply = h.reply(); return result; };
      expect((await send(h.fm)).status).toBe(200); await flush(); expect(h.sent).toEqual([]);
      gate.resolve(); await reply; await flush();
      expect(h.sent.map(m => m.text)).toEqual([formatWebChannelEcho("web-user", "hello"), "done"]);
    });
    for (const failure of ["throw", "reject"] as const) it(`${type}: ${failure} is logged, does not fail delivery or prevent the reply`, async () => {
      const h = await harness(type); h.fail(failure);
      expect((await send(h.fm)).status).toBe(200); await h.reply(); await flush();
      expect(h.sent.map(m => m.text)).toEqual(["done"]); expect(h.s.logger.warn).toHaveBeenCalledOnce();
      expect(h.received[0].type).toBe("fleet_inbound"); expect(h.s.webChannelEchoTails.size).toBe(0);
    });
  }
  for (const type of ["telegram", "discord"] as const) {
    it(`${type}: direct mentions, attachment names and replayed echoes never enter a sibling bot`, async () => {
      const h = await harness(type), gate = deferred(); h.hold(gate.promise);
      const typed = "/danger@other_bot <@888> <@!888> <@&888> @everyone @here @other_bot\n/restart";
      const filename = "@other_bot <@888> @everyone.txt";
      h.s.webFiles = { takeForMessage: () => ({ ok: true, entries: [{ id: "a".repeat(32), name: filename, path: "/private/opaque", kind: "document", mime: "text/plain", size: 3 }] }), commit: vi.fn(), release: vi.fn() };
      expect((await send(h.fm, typed, ["a".repeat(32)])).status).toBe(200); await flush();
      // This is the actual platform payload, observed before its send ACK.
      const echo = type === "telegram" ? h.telegramPayloads[0].text : h.discordPayloads[0].content;
      expect(h.sent).toEqual([]);
      expect(echo).toContain("[at: other_bot]"); expect(echo).toContain("[command: danger at other_bot]");
      expect(echo.normalize("NFKC").replace(/[\p{Cf}]/gu, "")).not.toMatch(/@|\//);
      expect(echo).toContain(neutralizeWebEchoText(filename)); expect(h.received[0].content).toContain(typed);
      if (type === "discord") expect(h.discordPayloads[0].allowedMentions).toEqual({ parse: [] });
      else { expect(h.telegramPayloads[0].entities).toBeUndefined(); expect(h.telegramPayloads[0].parse_mode).toBeUndefined(); }
      // A's real author id 777, received by sibling B (888). No receipt/ACK cache.
      const sibling = await harness(type, "888"); await sibling.feed(echo, "peer");
      expect(sibling.ingress).toHaveLength(1); expect(sibling.received).toEqual([]);
      expect(sibling.s.topicCommands.handleInstanceCommand).not.toHaveBeenCalled();
      expect(sibling.s.topicCommands.handleGeneralCommand).not.toHaveBeenCalled();
      gate.resolve(); await flush(); expect(h.sent[0].text).toBe(echo);
      await sibling.feed(echo, "peer"); expect(sibling.received).toEqual([]);
      const restarted = await harness(type, "888"); restarted.s.fleetConfig.web = { echo_to_channel: false };
      expect(restarted.s.worlds.get("owner").botUserId).toBeUndefined();
      expect(restarted.adapter.getBotUserId()).toBe("888");
      await restarted.feed(echo, "peer"); expect(restarted.received).toEqual([]);
      restarted.s.worlds.get("primary").botUserId = "777";
      restarted.primary.getBotUserId = () => undefined;
      await restarted.s.handleInboundMessage({ source: type, adapterId: "owner", chatId: restarted.chatId, threadId: restarted.topic,
        messageId: "old-replay-without-bot-flag", userId: "777", username: "sibling", text: echo, timestamp: new Date(), isBotMessage: false });
      expect(restarted.received).toEqual([]);
      await restarted.feed("ordinary peer message", "peer"); expect(restarted.received).toHaveLength(1);
      // Numeric platform ids can collide: the other platform is not authority.
      restarted.s.worlds.set("foreign", { id: "foreign", adapter: { type: type === "telegram" ? "discord" : "telegram", getBotUserId: () => "999" } });
      await restarted.feed(echo, "human"); expect(restarted.received).toHaveLength(2);
      await restarted.feed(echo, "external"); expect(restarted.received).toHaveLength(3);
      // A non-fleet bot with the prefix is still governed by existing collab.
      restarted.s.fleetConfig.channels[1].access = { ...OPEN, mode: "locked" };
      await restarted.feed(echo, "external"); expect(restarted.received).toHaveLength(3);
    });
  }

  it("an old reply waiting for echo cannot cross an IPC replacement", async () => {
    const h = await harness("telegram"), gate = deferred(); h.hold(gate.promise); await send(h.fm);
    const reply = h.reply(); await flush();
    const replacement = { connected: true, send: vi.fn(() => true) }; h.s.instanceIpcClients.set("worker", replacement);
    gate.resolve(); await reply; await flush();
    expect(h.sent.map(m => m.text)).toEqual([formatWebChannelEcho("web-user", "hello")]); expect(replacement.send).not.toHaveBeenCalled();
  });
  it.each(["adapter", "group", "topic"])("a reply waiting for echo refuses a changed %s binding", async kind => {
    const h = await harness("telegram"), gate = deferred(); h.hold(gate.promise); await send(h.fm);
    const reply = h.reply(); await flush();
    if (kind === "adapter") h.s.worlds.get("owner").adapter = h.primary;
    if (kind === "group") h.s.worlds.get("owner").groupId = "-100333";
    if (kind === "topic") h.s.fleetConfig.instances.worker.topic_id = "99";
    gate.resolve(); await reply; await flush();
    expect(h.sent.map(m => m.text)).toEqual([formatWebChannelEcho("web-user", "hello")]);
    expect(h.received.at(-1).error).toContain("Channel binding changed"); expect(h.primary.sendText).not.toHaveBeenCalled();
  });
  it("shared formatting is visible ASCII and provenance is fleet author identity", () => {
    expect(WEB_ECHO_PREFIX).toBe("🌐 web · ");
    expect(neutralizeWebEchoText("@everyone @here <@123> <@!123> <@&123> /start@bot /cancel")).toBe("[at: everyone] [at: here] [mention: 123] [mention: 123] [role: 123] [command: start at bot] [command: cancel]");
    const echo = formatWebChannelEcho("web-user", "/cmd@other_bot"), ownIds = new Set(["777", "888"]);
    expect(isWebChannelEcho(echo, "777", ownIds)).toBe(true);
    expect(isWebChannelEcho(echo, "999", ownIds)).toBe(false);
    expect(isWebChannelEcho(echo, "444", ownIds)).toBe(false);
    expect(isWebChannelEcho(echo, "777", new Set())).toBe(false);
    expect(isWebChannelEcho("ordinary peer message", "777", ownIds)).toBe(false);
    expect(echo).toBe("🌐 web · web-user: [command: cmd at other_bot]");
    expect(echo).not.toMatch(/[\p{Cf}]/u);
  });
  it("normalisation and format stripping cannot restore mention or command syntax", () => {
    const raw = "＠eve\u200bryone ＜＠！１２３＞ ＜＠＆３００＞ ／cmd＠b\u200bot @u\u200bser";
    const display = neutralizeWebEchoText(raw);
    expect(display).toBe("[at: everyone] [mention: 123] [role: 300] [command: cmd at bot] [at: user]");
    expect(display.normalize("NFKC").replace(/[\p{Cf}]/gu, "")).not.toMatch(/@|\//);
    expect(display).not.toMatch(/[\uFF01-\uFF5E]/u);
  });
  it("token boundaries preserve URLs, email local parts and path slashes", () => {
    const raw = "https://host/@user/cmd@bot ftp://user@mail.example/a/b user+tag@example.com user@localhost a/b /usr/bin @user /cmd@bot";
    expect(neutralizeWebEchoText(raw)).toBe("https://host/@user/cmd@bot ftp://user@mail.example/a/b user+tag@example.com user@localhost a/b /usr/bin [at: user] [command: cmd at bot]");
    expect(neutralizeWebEchoText("inside@word foo/@user (/cmd@bot) @everyoneElse")).toBe("inside@word foo/[at: user] ([command: cmd at bot]) [at: everyoneElse]");
  });
  it("protected data tokens cannot swallow adjacent active mentions", () => {
    expect(neutralizeWebEchoText("[doc](https://host.test/x)@everyone <@123> <#123>")).toBe("[doc](https://host.test/x)[at: everyone] [mention: 123] [channel: 123]");
    expect(neutralizeWebEchoText("[doc](https://host.test/a(b)/@user)<@!123>")).toBe("[doc](https://host.test/a(b)/@user)[mention: 123]");
    expect(neutralizeWebEchoText("@here@example.com")).toBe("[at: here][at: example].com");
    expect(neutralizeWebEchoText('"who@here"@example.com')).toBe('"who@here"@example.com');
  });
  it("post-normalisation truncation cannot split a Unicode scalar", () => {
    const note = " … (full text in web chat)", header = `${WEB_ECHO_PREFIX}web-user: `;
    const cutAt = 1800 - header.length - note.length;
    const echo = formatWebChannelEcho("web-user", "x".repeat(cutAt - 1) + "😀" + "x".repeat(100));
    expect(echo).not.toMatch(/[\uD800-\uDFFF]/u); expect(echo).toHaveLength(1799); expect(echo.endsWith(note)).toBe(true);
  });
  it.each(["en", "zh-TW"] as const)("%s: expanding labels keep a single prefixed platform message", async locale => {
    setLocale(locale); const h = await harness("discord");
    const fileName = "@a ".repeat(150) + ".txt";
    h.s.webFiles = { takeForMessage: () => ({ ok: true, entries: [{ id: "a".repeat(32), name: fileName, path: "/private/opaque", kind: "document", mime: "text/plain", size: 3 }] }), commit: vi.fn(), release: vi.fn() };
    expect((await send(h.fm, "/a ".repeat(166), ["a".repeat(32)])).status).toBe(200); await flush();
    expect(h.discordPayloads).toHaveLength(1); expect(h.sent[0].text.length).toBeLessThanOrEqual(1800);
    expect(h.sent[0].text.startsWith(WEB_ECHO_PREFIX)).toBe(true);
    expect(h.sent[0].text).toContain(locale === "en" ? "full text in web chat" : "完整內容請看 web chat");
  });
  it("Telegram rich-only own messages are dropped before either ingress middleware", async () => {
    const h = await harness("telegram"); await h.feed("web echo", "self", true); expect(h.ingress).toEqual([]); expect(h.received).toEqual([]);
  });
  it.each(["disabled", "classic", "web-only", "no-topic"])("%s skips echoes and leaves delivery intact", async kind => {
    const h = await harness("telegram");
    if (kind === "disabled") h.s.fleetConfig.web = { echo_to_channel: false };
    if (kind === "classic") h.s.isClassicInstance = () => true;
    if (kind === "web-only") { delete h.s.fleetConfig.channels; h.s.adapter = null; h.s.worlds.clear(); }
    if (kind === "no-topic") delete h.s.fleetConfig.instances.worker.topic_id;
    expect((await send(h.fm)).status).toBe(200); await flush(); expect(h.sent).toEqual([]); expect(h.received).toHaveLength(1);
  });
  it.each([false, "throw"])("failed delivery (%s) posts no echo and releases the lane", async outcome => {
    const h = await harness("telegram"); vi.spyOn(h.fm, "deliverToInstance").mockImplementation(async () => { if (outcome === "throw") throw new Error("not sent"); return false; });
    expect((await send(h.fm)).status).toBe(503); await flush(); expect(h.sent).toEqual([]); expect(h.s.webChannelEchoTails.size).toBe(0);
  });
  it("FIFO, unrelated targets, and stale delivery epochs", async () => {
    const h = await harness("telegram"), gate = deferred(); h.hold(gate.promise);
    await send(h.fm, "first"); await send(h.fm, "second"); await flush(); expect(h.api).toHaveBeenCalledTimes(1);
    const unrelated = vi.fn(async () => {}); h.fm.reserveWebChannelEcho("other", unrelated)(true); await flush(); expect(unrelated).toHaveBeenCalledOnce();
    gate.resolve(); await flush(); await flush(); expect(h.sent.map(m => m.text)).toEqual([formatWebChannelEcho("web-user", "first"), formatWebChannelEcho("web-user", "second")]);
    const stale = vi.fn(async () => {}), settle = h.fm.reserveWebChannelEcho("worker", stale);
    h.s.cancelPendingDeliveries("worker"); settle(true); await flush(); expect(stale).not.toHaveBeenCalled();
  });
  it.each(["adapter", "topic", "group"])("a changed %s binding cannot send the reserved echo to the old route", async kind => {
    const h = await harness("telegram"), admission = deferred<boolean>();
    vi.spyOn(h.fm, "deliverToInstance").mockReturnValue(admission.promise);
    const response = send(h.fm);
    if (kind === "adapter") h.s.worlds.get("owner").adapter = h.primary;
    if (kind === "topic") h.s.fleetConfig.instances.worker.topic_id = "99";
    if (kind === "group") h.s.worlds.get("owner").groupId = "-100999";
    admission.resolve(true); expect((await response).status).toBe(200); await flush(); expect(h.sent).toEqual([]); expect(h.primary.sendText).not.toHaveBeenCalled();
  });
  it.each(["en", "zh-TW"] as const)("%s: long text stays bounded with a full-web-text note; names, not paths", async locale => {
    setLocale(locale);
    const h = await harness("telegram");
    h.s.webFiles = { takeForMessage: () => ({ ok: true, entries: [{ id: "a".repeat(32), name: "report.txt", path: "/private/secret/opaque-upload-id", kind: "document", mime: "text/plain", size: 3 }] }), commit: vi.fn(), release: vi.fn() };
    expect((await send(h.fm, "x".repeat(16000), ["a".repeat(32)])).status).toBe(200); await flush();
    expect(h.sent[0].text).toContain("x".repeat(500)); expect(h.sent[0].text).toContain("report.txt"); expect(h.sent[0].text).not.toContain("/private/"); expect(h.sent[0].text).toContain(locale === "en" ? "full text in web chat" : "完整內容請看 web chat"); expect(h.sent[0].text.length).toBeLessThan(1600);
  });
});
