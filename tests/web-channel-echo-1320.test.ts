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
import { formatWebChannelEcho, neutralizeWebEchoText, isWebChannelEcho } from "../src/web-channel-echo.js";
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
  vi.restoreAllMocks(); vi.unstubAllEnvs(); setLocale("en");
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

async function harness(type: "telegram" | "discord") {
  const dir = mkdtempSync(join(tmpdir(), "echo-1320-")); dirs.push(dir);
  vi.stubEnv("AGEND_HOME", dir);
  const fm = new FleetManager(dir); managers.push(fm); const s = fm as any;
  const sent: Array<{ chatId: string; topic: string; text: string }> = [], discordPayloads: any[] = [], telegramPayloads: any[] = [], ingress: unknown[] = [], received: any[] = [];
  let holdEcho: Promise<void> | undefined, failEcho: "throw" | "reject" | undefined;
  const api = vi.fn(async (chatId: string, topic: string, text: string) => {
    if (isWebChannelEcho(text, true) && holdEcho) await holdEcho;
    if (isWebChannelEcho(text, true) && failEcho === "reject") throw new Error("stub API refused");
    sent.push({ chatId, topic, text });
    return { messageId: String(sent.length), chatId, threadId: topic };
  });
  let adapter: TelegramAdapter | DiscordAdapter; let feed: (text: string, sender?: "self" | "human" | "peer", rich?: boolean) => Promise<void>;
  const chatId = type === "telegram" ? "-100222" : "guild", topic = type === "telegram" ? "27" : "topic";
  if (type === "telegram") {
    adapter = new TelegramAdapter({ id: "owner", botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", accessManager: { isAllowed: () => ({ allowed: true }) } as never, inboxDir: dir });
    const bot = adapter.getBot();
    (bot as any).botInfo = { id: 777, is_bot: true, first_name: "EchoBot", username: "echo_bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
    (bot as any).api.config.use(async (_prev: unknown, method: string, payload: any) => {
      telegramPayloads.push(payload);
      if (method !== "sendMessage") throw new Error(`unexpected Bot API ${method}`);
      const result = await api(String(payload.chat_id), String(payload.message_thread_id), payload.text);
      return { ok: true, result: { message_id: Number(result.messageId), date: 1, chat: { id: Number(chatId), type: "supergroup" }, text: payload.text } };
    });
    let id = 0;
    feed = async (text, sender = "self", rich = false) => {
      const message = { message_id: ++id, date: 1, chat: { id: Number(chatId), type: "supergroup", is_forum: true }, message_thread_id: Number(topic), from: { id: sender === "self" ? 777 : sender === "peer" ? 888 : 999, is_bot: sender !== "human", first_name: sender }, ...(rich ? { rich_message: { blocks: [{ type: "text", text }] } } : { text }) };
      await bot.handleUpdate({ update_id: id, message } as never); await flush();
    };
  } else {
    const client = Object.assign(new EventEmitter(), {
      user: { id: "777", username: "EchoBot" }, isReady: () => true,
      channels: { fetch: vi.fn(async (id: string) => ({ isTextBased: () => true, send: async (value: string | { content: string }) => { discordPayloads.push(value); const text = typeof value === "string" ? value : value.content; const result = await api(chatId, id, text); return { id: result.messageId }; } })) },
    });
    adapter = new DiscordAdapter({ id: "owner", botToken: "fake", accessManager: {} as never, inboxDir: dir, guildId: chatId, registerCommands: false, clientFactory: () => client as unknown as Client });
    let id = 0;
    feed = async (text, sender = "self") => {
      client.emit("messageCreate", { id: String(++id), guildId: chatId, channelId: topic, author: { id: sender === "self" ? "777" : sender === "peer" ? "888" : "999", username: sender, bot: sender !== "human" }, content: text, embeds: [], attachments: new Collection(), createdAt: new Date() });
      await flush(); await flush();
    };
  }
  const primary = { id: "primary", type, sendText: vi.fn(async () => { throw new Error("wrong world"); }) };
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
  vi.spyOn(adapter, "sendText").mockImplementation((...args) => { if (failEcho === "throw" && isWebChannelEcho(args[1], true)) throw new Error("sync failure"); return realSend(...args); });
  return { fm, s, adapter, primary, sent, received, ingress, api, chatId, topic, discordPayloads, telegramPayloads,
    feed: async (...args: Parameters<typeof feed>) => { await feed(...args); await Promise.all(inbound.splice(0)); },
    hold: (promise: Promise<void>) => { holdEcho = promise; }, fail: (how: "throw" | "reject") => { failEcho = how; },
    reply: () => s.handleOutboundFromInstance("worker", { requestId: 9, tool: "reply", args: { text: "done", chat_id: chatId } }),
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
      const h = await harness(type);
      const typed = "/danger@other_bot <@888> <@!888> <@&888> @everyone @here @other_bot\n/restart";
      const filename = "@other_bot <@888> @everyone.txt";
      h.s.webFiles = { takeForMessage: () => ({ ok: true, entries: [{ id: "a".repeat(32), name: filename, path: "/private/opaque", kind: "document", mime: "text/plain", size: 3 }] }), commit: vi.fn(), release: vi.fn() };
      expect((await send(h.fm, typed, ["a".repeat(32)])).status).toBe(200); await flush();
      const echo = h.sent[0].text;
      expect(echo).toContain("＠other_bot");
      expect(echo).not.toMatch(/@|\//); expect(echo).toContain(neutralizeWebEchoText(filename));
      expect(h.received[0].content).toContain(typed);
      if (type === "discord") expect(h.discordPayloads[0].allowedMentions).toEqual({ parse: [] });
      else { expect(h.telegramPayloads[0].entities).toBeUndefined(); expect(h.telegramPayloads[0].parse_mode).toBeUndefined(); }
      // Different bot identity: this is not the self guard or a receipt cache.
      const sibling = await harness(type); await sibling.feed(echo, "peer");
      expect(sibling.ingress).toEqual([]); expect(sibling.received).toEqual([]);
      await sibling.feed(echo, "peer"); expect(sibling.received).toEqual([]);
      const restarted = await harness(type); await restarted.feed(echo, "peer"); expect(restarted.ingress).toEqual([]);
      await restarted.feed("ordinary peer message", "peer"); expect(restarted.received).toHaveLength(1);
      await restarted.feed(echo, "human"); expect(restarted.received).toHaveLength(2);
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
  it("shared framing neutralises syntax and cannot be injected through raw input", () => {
    expect(neutralizeWebEchoText("@everyone @here <@123> <@!123> <@&123> /start@bot")).toBe("＠everyone ＠here <＠123> <＠!123> <＠&123> ／start＠bot");
    const echo = formatWebChannelEcho("web-user", "/cmd@other_bot");
    expect(isWebChannelEcho(echo, true)).toBe(true); expect(isWebChannelEcho(echo, false)).toBe(false);
    expect(isWebChannelEcho("🌐 web · web-user: plain text", true)).toBe(false);
    expect(isWebChannelEcho(echo.slice(0, -1), true)).toBe(false);
    expect(neutralizeWebEchoText(echo)).not.toMatch(/[\p{Cf}]/u);
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
