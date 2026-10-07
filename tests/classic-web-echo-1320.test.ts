/** ClassicBot web echo (#1320 part B): opt-in, per-entry send, no re-entry.
 * Real HTTP send → FleetManager → real Telegram adapters (stub Bot API).
 * No fleet startup, polling, CLI/tmux or external network. */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Collection, type Client } from "discord.js";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { validateClassicBotConfig } from "../src/config-validator.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { WEB_ECHO_PREFIX, formatWebChannelEcho } from "../src/web-channel-echo.js";
import { setLocale } from "../src/locale.js";

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }),
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

const BOT_A = "111", BOT_B = "222", CHANNEL = "-1001";

function telegramAdapter(id: string, dir: string, botId: string, sent: Array<{ chatId: string; text: string; opts: unknown }>) {
  const adapter = new TelegramAdapter({ id, botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", accessManager: { isAllowed: () => ({ allowed: true }) } as never, inboxDir: dir });
  const bot = adapter.getBot();
  (bot as any).botInfo = { id: Number(botId), is_bot: true, first_name: "Bot", username: "bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
  (bot as any).api.config.use(async (_prev: unknown, method: string, payload: any) => {
    if (method !== "sendMessage") throw new Error(`unexpected Bot API ${method}`);
    sent.push({ chatId: String(payload.chat_id), text: payload.text, opts: { entities: payload.entities, parse_mode: payload.parse_mode } });
    return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: Number(CHANNEL), type: "group" }, text: payload.text } };
  });
  return { adapter, bot };
}

async function harness(opts: { aEcho?: boolean; bEcho?: boolean; bCollab?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "classic-echo-1320-")); dirs.push(dir);
  vi.stubEnv("AGEND_HOME", dir);
  writeFileSync(join(dir, "classicBot.yaml"), yaml.dump({
    defaults: {},
    channels: {
      [`${CHANNEL}#tg-a`]: { channelId: CHANNEL, adapterId: "tg-a", instanceName: "classic-a", collab: true, ...(opts.aEcho ? { web_echo: true } : {}) },
      [`${CHANNEL}#tg-b`]: { channelId: CHANNEL, adapterId: "tg-b", instanceName: "classic-b", collab: opts.bCollab ?? true, ...(opts.bEcho ? { web_echo: true } : {}) },
    },
  }));
  const fm = new FleetManager(dir); managers.push(fm); const s = fm as any;
  const sentA: Array<{ chatId: string; text: string; opts: unknown }> = [];
  const sentB: Array<{ chatId: string; text: string; opts: unknown }> = [];
  const { adapter: adapterA, bot: botA } = telegramAdapter("tg-a", dir, BOT_A, sentA);
  const { adapter: adapterB, bot: botB } = telegramAdapter("tg-b", dir, BOT_B, sentB);
  const manager = new ClassicChannelManager(dir, s.logger ?? { info() {}, warn() {}, error() {}, debug() {} });
  manager.configureAdapters([{ id: "tg-a", type: "telegram" }, { id: "tg-b", type: "telegram" }]);
  s.classicChannels = manager;
  s.adapter = adapterA;
  s.worlds.set("tg-a", { id: "tg-a", adapter: adapterA, groupId: CHANNEL, botUserId: BOT_A, accessManager: new AccessManager(OPEN, join(dir, "a-access.json")) });
  s.worlds.set("tg-b", { id: "tg-b", adapter: adapterB, groupId: CHANNEL, botUserId: BOT_B, accessManager: new AccessManager(OPEN, join(dir, "b-access.json")) });
  s.fleetConfig = { defaults: {}, channels: [], instances: {} };
  s.routing.rebuild(s.fleetConfig);
  s.logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  vi.spyOn(s, "webToken", "get").mockReturnValue(TOKEN);
  s.lifecycle.isPaused = vi.fn(() => false);
  s.getInstanceIdle = () => true;
  s.topicCommands.handleInstanceCommand = vi.fn(async () => false);
  s.topicCommands.handleGeneralCommand = vi.fn(async () => false);
  s.emitSseEvent = vi.fn();
  const delivered: unknown[] = [];
  s.instanceIpcClients.set("classic-a", { connected: true, send: (m: any) => { delivered.push(m); return true; } });
  s.instanceIpcClients.set("classic-b", { connected: true, send: (m: any) => { delivered.push(m); return true; } });
  const forward = vi.spyOn(fm as any, "forwardToClassicInstance").mockImplementation(async (...args: unknown[]) => { delivered.push(args[0]); });
  let id = 0;
  const feed = async (bot: typeof botA, fromId: number, text: string, isBot: boolean) => {
    const message = { message_id: ++id, date: 1, chat: { id: Number(CHANNEL), type: "group" }, from: { id: fromId, is_bot: isBot, first_name: "u" }, text };
    await bot.handleUpdate({ update_id: id, message } as never); await flush(); await flush();
  };
  return { fm, s, botA, botB, sentA, sentB, delivered, deliver: forward, feed };
}

function postSend(fm: FleetManager, instance: string, message = "hello") {
  const req = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/send", headers: { "x-agend-token": TOKEN }, destroy() {} });
  const done = deferred<{ status: number; body: any }>(); let status = 0;
  const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(body: string) { done.resolve({ status, body: JSON.parse(body) }); } };
  expect(handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL(req.url, "http://localhost"), fm as unknown as WebApiContext)).toBe(true);
  req.emit("data", Buffer.from(JSON.stringify({ instance, message, attachments: [] }))); req.emit("end");
  return done.promise;
}

describe("classic web echo opt-in (#1320 B)", () => {
  it("posts to the opted-in entry's own adapter with a neutralised prefix", async () => {
    const h = await harness({ aEcho: true });
    expect((await postSend(h.fm, "classic-a", "hi <@222> everyone")).status).toBe(200);
    await flush(); await flush();
    expect(h.sentA).toHaveLength(1);
    expect(h.sentA[0].chatId).toBe(CHANNEL);
    expect(h.sentA[0].text.startsWith(WEB_ECHO_PREFIX)).toBe(true);
    expect(h.sentA[0].text).toContain("[mention: 222]");
    expect(h.sentA[0].text).not.toContain("<@222>");
    expect(h.sentB).toHaveLength(0);
  });

  it("off or absent posts nothing and delivery still succeeds", async () => {
    for (const opts of [{}, { aEcho: false }]) {
      const h = await harness(opts);
      expect((await postSend(h.fm, "classic-a")).status).toBe(200);
      await flush(); await flush();
      expect(h.sentA).toHaveLength(0);
      expect(h.delivered.length).toBeGreaterThan(0);
    }
  });

  it("one entry failing does not block the other", async () => {
    const h = await harness({ aEcho: true });
    (h.fm.classicChannels as any).channels.set("-1002#tg-b", {
      channelId: "-1002", adapterId: "tg-b", instanceName: "classic-a", webEcho: true,
    } as never);
    vi.spyOn(h.s.worlds.get("tg-b").adapter, "sendText").mockRejectedValueOnce(new Error("down"));
    expect((await postSend(h.fm, "classic-a", "ping")).status).toBe(200);
    await flush(); await flush();
    expect(h.sentA).toHaveLength(1);
    expect(h.s.logger.warn).toHaveBeenCalled();
  });

  it("mention suppression is set on the platform send", async () => {
    const h = await harness({ aEcho: true });
    expect((await postSend(h.fm, "classic-a", "ping")).status).toBe(200);
    await flush(); await flush();
    expect(h.sentA[0].opts).toMatchObject({ entities: undefined, parse_mode: undefined });
  });
});

describe("classic echo never re-enters a sibling bot (#1320 B)", () => {
  // The <@id> trigger vector runs through the threadId-routed collab path
  // (Discord guild channels): the echo reaches handleClassicChannelMessage,
  // whose text.includes(<@botId>) check would fire without the provenance
  // gate in front of it. These tests drive that exact path with real
  // Discord adapters.
  const GUILD = "guild-1", DCHAN = "chan-1";
  async function dharness() {
    const dir = mkdtempSync(join(tmpdir(), "classic-echo-d-")); dirs.push(dir);
    vi.stubEnv("AGEND_HOME", dir);
    writeFileSync(join(dir, "classicBot.yaml"), yaml.dump({
      defaults: {},
      channels: {
        [`${DCHAN}#da`]: { channelId: DCHAN, adapterId: "da", instanceName: "classic-a", collab: true, web_echo: true },
        [`${DCHAN}#db`]: { channelId: DCHAN, adapterId: "db", instanceName: "classic-b", collab: true },
      },
    }));
    const fm = new FleetManager(dir); managers.push(fm); const s = fm as any;
    const sent: Array<{ text: string; opts: unknown }> = [];
    const mkAdapter = (id: string, botId: string) => {
      const client = Object.assign(new EventEmitter(), {
        user: { id: botId, username: "Bot" }, isReady: () => true,
        channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send: async (value: any) => { sent.push({ text: typeof value === "string" ? value : value.content, opts: value?.allowedMentions }); return { id: "m" }; } })) },
      });
      const adapter = new DiscordAdapter({ id, botToken: "fake", accessManager: {} as never, inboxDir: dir, guildId: GUILD, registerCommands: false, clientFactory: () => client as unknown as Client });
      return { adapter, client };
    };
    const { adapter: adapterA } = mkAdapter("da", BOT_A);
    const { adapter: adapterB, client: clientB } = mkAdapter("db", BOT_B);
    const manager = new ClassicChannelManager(dir, { info() {}, warn() {}, error() {}, debug() {} } as never);
    manager.configureAdapters([{ id: "da", type: "discord" }, { id: "db", type: "discord" }]);
    s.classicChannels = manager;
    s.adapter = adapterA;
    s.fleetConfig = { defaults: {}, channels: [], instances: {} };
    s.worlds.set("da", { id: "da", adapter: adapterA, groupId: GUILD, botUserId: BOT_A, accessManager: new AccessManager(OPEN, join(dir, "a.json")) });
    s.worlds.set("db", { id: "db", adapter: adapterB, groupId: GUILD, botUserId: BOT_B, accessManager: new AccessManager(OPEN, join(dir, "b.json")) });
    s.routing.rebuild(s.fleetConfig);
    s.logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    s.lifecycle.isPaused = vi.fn(() => false);
    s.getInstanceIdle = () => true;
    s.topicCommands.handleInstanceCommand = vi.fn(async () => false);
    s.topicCommands.handleGeneralCommand = vi.fn(async () => false);
    s.emitSseEvent = vi.fn();
    s.instanceIpcClients.set("classic-a", { connected: true, send: () => true });
    s.instanceIpcClients.set("classic-b", { connected: true, send: () => true });
    const forward = vi.spyOn(fm as any, "forwardToClassicInstance").mockImplementation(async () => undefined);
    const inbound: Promise<void>[] = [];
    adapterB.on("message", (msg: any) => { inbound.push(s.handleInboundMessage(msg)); });
    return { fm, s, forward, clientB, inbound };
  }

  async function flushAll(h: { inbound: Promise<void>[] }) {
    for (let i = 0; i < 6 && h.inbound.length === 0; i++) await flush();
    await Promise.all(h.inbound.splice(0));
    await flush(); await flush();
  }

  let discordId = 0;
  async function emitDiscord(client: any, channelId: string, guildId: string, authorId: string, content: string, bot: boolean) {
    client.emit("messageCreate", {
      id: `dm${++discordId}`, channelId, guildId,
      author: { id: authorId, username: "u", bot },
      content, createdTimestamp: 1, createdAt: new Date(1000),
      embeds: [], attachments: new Collection(),
      channel: { id: channelId, isTextBased: () => true },
    });
  }

  it("A's echo with B's mention never reaches B; human copy flows normally", async () => {
    const h = await dharness();
    // A's echo, authored by A's bot, carrying B's mention — B's adapter sees it.
    const echo = formatWebChannelEcho("web-user", `hello <@${BOT_B}>`);
    await emitDiscord(h.clientB, DCHAN, GUILD, BOT_A, echo, true);
    await flushAll(h);
    expect(h.forward).not.toHaveBeenCalled();
    // Human copy of the prefix plus a live mention: not a fleet-bot author,
    // so the echo gate passes and normal collab mention rules deliver it.
    await emitDiscord(h.clientB, DCHAN, GUILD, "999", `${WEB_ECHO_PREFIX}web-user: hi <@${BOT_B}>`, false);
    await flushAll(h);
    expect(h.forward).toHaveBeenCalledTimes(1);
  });

  it("non-fleet bot with the prefix follows existing collab rules", async () => {
    const h = await dharness();
    const echo = formatWebChannelEcho("web-user", "hi");
    await emitDiscord(h.clientB, DCHAN, GUILD, "444", echo, true);
    await flushAll(h);
    // Not dropped as an echo (444 is no fleet bot): collab mention rules apply.
    // No <@222> mention inside → B is not triggered, but it was evaluated.
    expect(h.forward).not.toHaveBeenCalled();
    await emitDiscord(h.clientB, DCHAN, GUILD, "444", `${echo} <@${BOT_B}>`, true);
    await flushAll(h);
    expect(h.forward).toHaveBeenCalledTimes(1);
  });

  it("prefixed live mention from a fleet bot is dropped by provenance alone", async () => {
    // A form the neutraliser could miss (or a raw pre-fix replay): live
    // <@222> under the echo prefix, authored by fleet bot A. Only the
    // ingress provenance gate stands between it and B — it must drop it.
    const h = await dharness();
    await emitDiscord(h.clientB, DCHAN, GUILD, BOT_A, `${WEB_ECHO_PREFIX}web-user: hi <@${BOT_B}>`, true);
    await flushAll(h);
    expect(h.forward).not.toHaveBeenCalled();
  });

  it("replayed echo after restart is still dropped by author identity", async () => {
    const echo = formatWebChannelEcho("web-user", "again");
    const h = await dharness();
    await emitDiscord(h.clientB, DCHAN, GUILD, BOT_A, echo, true);
    await flushAll(h);
    expect(h.forward).not.toHaveBeenCalled();
    // Fresh manager, same config: no cache, same verdict.
    const h2 = await dharness();
    await emitDiscord(h2.clientB, DCHAN, GUILD, BOT_A, echo, true);
    await flushAll(h2);
    expect(h2.forward).not.toHaveBeenCalled();
  });
});

describe("classic echo settings (#1320 B)", () => {
  function settingsCtx(dir: string, channels: unknown) {
    writeFileSync(join(dir, "classicBot.yaml"), yaml.dump({ defaults: {}, channels }));
    const ctx = {
      dataDir: dir,
      logger: { warn: vi.fn(), info: vi.fn() },
      restartClassicInstanceFromSettings: vi.fn(async () => undefined),
    } as unknown as SettingsApiContext;
    return ctx;
  }
  function patch(ctx: SettingsApiContext, key: string, body: unknown) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
      req.method = "PATCH"; req.destroy = () => undefined;
      let status = 0;
      const res = { writeHead(code: number) { status = code; }, end(payload: string) { resolve({ status, body: JSON.parse(payload) }); } };
      try {
        expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost/api/settings/classic/channels/${key}`, "http://localhost"), ctx)).toBe(true);
        queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
      } catch (err) { reject(err); }
    });
  }

  it("accepts a boolean opt-in and restarts the channel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "classic-echo-settings-")); dirs.push(dir);
    const ctx = settingsCtx(dir, { "chan": { channelId: "-1001", instanceName: "classic-a" } });
    const res = await patch(ctx, "chan", { web_echo: true });
    expect(res.status).toBe(200);
    expect(res.body.restarted).toBe(true);
    const saved = yaml.load(readFileSync(join(dir, "classicBot.yaml"), "utf-8")) as any;
    expect(saved.channels.chan.web_echo).toBe(true);
  });

  it("rejects a non-boolean opt-in and leaves the file alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "classic-echo-settings-")); dirs.push(dir);
    const ctx = settingsCtx(dir, { "chan": { channelId: "-1001", instanceName: "classic-a" } });
    for (const bad of ["yes", 1]) {
      const res = await patch(ctx, "chan", { web_echo: bad });
      expect(res.status).toBe(400);
    }
    const saved = yaml.load(readFileSync(join(dir, "classicBot.yaml"), "utf-8")) as any;
    expect(saved.channels.chan.web_echo).toBeUndefined();
  });
});

describe("classic echo config (#1320 B)", () => {
  it("validator rejects non-boolean web_echo", () => {
    const bad = validateClassicBotConfig({ channels: { c: { web_echo: "yes" } } });
    expect(bad.valid).toBe(false);
    expect(bad.errors.map(e => e.path)).toContain("channels.c.web_echo");
    const good = validateClassicBotConfig({ channels: { c: { web_echo: true } } });
    expect(good.valid).toBe(true);
  });

  it("manager loads strict-true and round-trips only true", () => {
    const dir = mkdtempSync(join(tmpdir(), "classic-echo-yaml-")); dirs.push(dir);
    writeFileSync(join(dir, "classicBot.yaml"), yaml.dump({ channels: {
      on: { channelId: "-1", instanceName: "a", web_echo: true },
      off: { channelId: "-2", instanceName: "b" },
      weird: { channelId: "-3", instanceName: "c", web_echo: "yes" },
    }}));
    const manager = new ClassicChannelManager(dir, { info() {}, warn() {}, error() {}, debug() {} } as never);
    manager.configureAdapters([{ id: "tg", type: "telegram" }]);
    const byInstance = Object.fromEntries(manager.getAll().map(c => [c.instanceName, c]));
    expect(byInstance["a"]?.webEcho).toBe(true);
    expect(byInstance["b"]?.webEcho).toBe(false);
    expect(byInstance["c"]?.webEcho).toBe(false);
    (manager as any).save();
    const saved = yaml.load(readFileSync(join(dir, "classicBot.yaml"), "utf-8")) as any;
    const channels = Object.values(saved.channels) as any[];
    expect(channels.find(c => c.instanceName === "a").web_echo).toBe(true);
    expect(channels.find(c => c.instanceName === "b").web_echo).toBeUndefined();
    expect(channels.find(c => c.instanceName === "c").web_echo).toBeUndefined();
  });
});
