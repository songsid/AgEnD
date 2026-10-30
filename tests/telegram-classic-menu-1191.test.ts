/**
 * #1191 — a Telegram connection that runs ClassicBot only (next to a Discord fleet, say) has no `group_id`, and got
 * no "/" menu at all: the whole registration was skipped without one, the ClassicBot menu with it. And registration
 * ran only from the primary adapter's start, so a secondary Telegram connection never registered its own.
 * #1177 — the menu locks were typed by hand, three of them wrong; they come from the command table now.
 *
 * fetch is stubbed (no token is real, nothing reaches Telegram); the adapters are mocks (no network, no fleet).
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelConfig, FleetConfig } from "../src/types.js";
import type { ChannelAdapter } from "../src/channel/types.js";

const adapters = vi.hoisted(() => new Map<string, ChannelAdapter>());
vi.mock("../src/channel/factory.js", () => ({
  createAdapter: vi.fn(async (_config: ChannelConfig, options: { id: string }) => adapters.get(options.id)),
}));
import { FleetManager } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { COMMANDS, TELEGRAM_MENUS, commandSpec, isLockedOnTelegram, telegramMenu } from "../src/command-table.js";
import { setLocale } from "../src/locale.js";

const TOKEN_ENV = "AGEND_TEST_TG_1191_TOKEN";
const dirs: string[] = [];
const managers: FleetManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) clearInterval((m as any).sessionPruneTimer);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setLocale("en");
  adapters.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function telegramOk(): Response {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue({ ok: true, result: true }) } as unknown as Response;
}
function stubTelegram() {
  const fetchMock = vi.fn().mockImplementation(async () => telegramOk());
  vi.stubGlobal("fetch", fetchMock);
  const sent = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), ...JSON.parse(String(init?.body)) }));
  return { fetchMock, sent };
}
const names = (cmds: Array<{ command: string }>) => cmds.map(c => c.command);
const tg = (over: Partial<ChannelConfig> = {}): ChannelConfig =>
  ({ id: "tg-classic", type: "telegram", mode: "topic", bot_token_env: TOKEN_ENV, ...over } as ChannelConfig);

// What each menu says, written out by hand from the table's Telegram column.
const FLEET_MENU = [
  ["status", "🔒 "], ["sysinfo", ""], ["web", "🔒 "], ["dashboard", "🔒 "], ["ctx", ""], ["compact", "🔒 "], ["steer", ""], ["btw", ""],
  ["clear", "🔒 "], ["model", "🔒 "], ["backend", "🔒 "], ["effort", "🔒 "], ["pause", "🔒 "], ["wake", "🔒 "], ["restart", "🔒 "],
  ["collab", "🔒 "], ["update", "🔒 "], ["profile", "🔒 "], ["doctor", "🔒 "], ["login", "🔒 "], ["usage", ""], ["tips", ""], ["visibility", "🔒 "]
];
const CLASSIC_MENU = [
  ["start", ""], ["stop", "🔒 "], ["compact", "🔒 "], ["steer", ""], ["btw", ""], ["clear", "🔒 "], ["model", "🔒 "], ["backend", "🔒 "],
  ["pause", "🔒 "], ["wake", "🔒 "], ["ctx", ""],
];

describe("the menus come from the command table (#1177)", () => {
  it("each command with the lock its Telegram cells say", () => {
    expect(telegramMenu("fleet").map(e => [e.name, e.lock])).toEqual(FLEET_MENU);
    expect(telegramMenu("classic").map(e => [e.name, e.lock])).toEqual(CLASSIC_MENU);
  });

  it("the three hand-typed locks #1177 found wrong are gone, and the Classic menu has no /effort", () => {
    const lock = (menu: "fleet" | "classic", name: string) => telegramMenu(menu).find(e => e.name === name)?.lock;
    // #754 audit: Telegram fleet /collab is channel-admin now, as on Discord — so it is locked.
    expect(lock("fleet", "collab"), "Telegram fleet /collab is channel-admin").toBe("🔒 ");
    expect(lock("classic", "start"), "private /start needs the user allowlist, not an admin").toBe("");
    expect(lock("classic", "effort"), "Telegram ClassicBot has no /effort").toBeUndefined();
  });

  it("every listed command has a Telegram handler where its menu is shown — none that does nothing when chosen", () => {
    for (const [menu, { scopes, names: listed }] of Object.entries(TELEGRAM_MENUS)) {
      for (const name of listed) {
        const spec = commandSpec(name)!;
        expect(spec, `${menu}: /${name}`).toBeDefined();
        expect(scopes.some(scope => !("passthrough" in spec.telegram[scope])), `${menu}: /${name} has no Telegram handler there`).toBe(true);
      }
    }
  });

  it("a lock is any Telegram level above anyone in the menu's scopes — the handler level is not one", () => {
    const at = (name: string) => commandSpec(name)!;
    expect(isLockedOnTelegram(at("pause"), ["general"])).toBe(true);          // fleet-admin
    expect(isLockedOnTelegram(at("compact"), ["general", "fleet"])).toBe(true);  // fleet-admin in both (#754 audit)
    expect(isLockedOnTelegram(at("steer"), ["general", "fleet"])).toBe(false);   // anyone in both
    expect(isLockedOnTelegram(at("compact"), ["classic"])).toBe(true);         // classic-admin
    expect(isLockedOnTelegram(at("clear"), ["classic"])).toBe(true);           // channel-admin
    expect(isLockedOnTelegram(at("start"), ["classic", "none"])).toBe(false);  // handler
    expect(isLockedOnTelegram(at("stop"), ["none"])).toBe(false);              // a refusal is not a level
    expect(isLockedOnTelegram(at("status"), ["fleet"])).toBe(false);           // passthrough
  });

  it("/compact keeps its argument hint in both menus (#1145), /visibility has its modes (#1302) — and nothing else has one", () => {
    for (const menu of ["fleet", "classic"] as const) {
      const entries = telegramMenu(menu);
      expect(entries.find(e => e.name === "compact")!.argHint, menu).toBe("slash.compact_arg");
      expect(entries.filter(e => e.argHint).map(e => e.name), menu).toEqual(menu === "fleet" ? ["compact", "visibility"] : ["compact"]);
    }
    expect(telegramMenu("fleet").find(e => e.name === "visibility")!.argHint).toBe("slash.visibility_arg");
  });

  it("a name the table does not know is an error, not a silent unlocked entry", () => {
    const menus = TELEGRAM_MENUS as unknown as { fleet: { names: string[] } };
    const original = menus.fleet.names;
    menus.fleet.names = [...original, "nosuchcommand"];
    try { expect(() => telegramMenu("fleet")).toThrow("/nosuchcommand"); }
    finally { menus.fleet.names = original; }
    expect(COMMANDS.some(c => c.name === "nosuchcommand")).toBe(false);
  });
});

describe("TopicCommands.registerBotCommands (#1191; #2870: the ClassicBot menu only where it answers)", () => {
  function commands(channels: ChannelConfig[], classic?: { rooms?: Array<{ adapterId?: string; channelId: string }>; defaults?: Record<string, unknown> }) {
    vi.stubEnv(TOKEN_ENV, "test-only");
    const info = vi.fn(), warn = vi.fn();
    const classicChannels = classic ? { getAll: () => classic.rooms ?? [], getDefaults: () => classic.defaults ?? {} } : null;
    const tc = new TopicCommands({ fleetConfig: { channels }, logger: { info, warn }, classicChannels } as any);
    return { tc, info, warn };
  }
  const EMPTIED = [{ type: "default" }, { type: "all_private_chats" }, { type: "all_group_chats" }];

  it("#2870: no ClassicBot chats: the broad scopes are emptied explicitly (default, all_private_chats, all_group_chats) — no menu for strangers", async () => {
    const { sent } = stubTelegram();
    const { tc, info, warn } = commands([tg()]);
    await tc.registerBotCommands();
    expect(sent().map(p => [p.scope, p.commands])).toEqual(EMPTIED.map(scope => [scope, []]));
    for (const p of sent()) expect(p.url).toBe("https://api.telegram.org/bottest-only/setMyCommands");
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: "tg-classic", fleetCommandCount: 0, classicCommandCount: 11, classicChats: 0, scopes: ["default", "all_private_chats", "all_group_chats"] }),
      expect.stringContaining("no group_id"),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("#2870: the ClassicBot menu on each chat ClassicBot answers: this bot's rooms, allowed_users, admin_users, allowed_groups — Telegram ids only, never the fleet group", async () => {
    const { sent } = stubTelegram();
    const { tc } = commands([tg({ group_id: "-1001234567890" })], {
      rooms: [{ adapterId: "tg-classic", channelId: "333" }, { adapterId: "other-bot", channelId: "444" }, { adapterId: "tg-classic", channelId: "-1005" }],
      defaults: { allowed_users: ["111", 1111, "123456789012345678"], admin_users: ["222", "111"], allowed_groups: ["-1009", "-1001234567890"] },
    });
    await tc.registerBotCommands();
    const chats = sent().filter(p => p.scope.type === "chat" && p.scope.chat_id !== "-1001234567890");
    expect(chats.map(p => p.scope.chat_id), "rooms, then the lists; a Discord snowflake and the fleet group left out; each once")
      .toEqual([333, -1005, 111, 1111, 222, -1009]);
    for (const p of chats) expect(names(p.commands)).toEqual(CLASSIC_MENU.map(([n]) => n));
    expect(sent().filter(p => EMPTIED.some(e => e.type === p.scope.type)).map(p => p.commands)).toEqual([[], [], []]);
  });

  it("with a group_id: the fleet menu on the group's chat and chat_administrators, unchanged; then the emptied broad scopes", async () => {
    const { sent } = stubTelegram();
    const { tc } = commands([tg({ group_id: "-1001234567890" })]);
    await tc.registerBotCommands();
    expect(sent().map(p => p.scope)).toEqual([
      { type: "chat", chat_id: "-1001234567890" }, { type: "chat_administrators", chat_id: "-1001234567890" }, ...EMPTIED,
    ]);
    expect(names(sent()[0]!.commands)).toEqual(FLEET_MENU.map(([n]) => n));
    expect(names(sent()[1]!.commands)).toEqual(FLEET_MENU.map(([n]) => n));
    expect(sent()[0]!.commands.find((c: { command: string }) => c.command === "collab").description).toContain("🔒");
    // The argument hint #1145 added, in the active locale.
    expect(sent()[0]!.commands.find((c: { command: string }) => c.command === "compact").description).toBe("🔒 Compact agent context window [optional summary focus — Claude Code only]");
  });

  it("the argument hint follows the locale (the ClassicBot menu of an allowed chat)", async () => {
    setLocale("zh-TW");
    const { sent } = stubTelegram();
    const { tc } = commands([tg()], { defaults: { allowed_users: ["111"] } });
    await tc.registerBotCommands();
    const chat = sent().find(p => p.scope.type === "chat")!;
    expect(chat.commands.find((c: { command: string }) => c.command === "compact").description).toBe("🔒 壓縮 Agent 的 Context [選填：摘要重點，僅 Claude Code]");
    expect(chat.commands.find((c: { command: string }) => c.command === "stop").description).toContain("🔒");
  });

  it("every call can end on its own: each carries a timeout signal", async () => {
    const { fetchMock } = stubTelegram();
    const { tc } = commands([tg({ group_id: "-100" })], { defaults: { allowed_users: ["111"] } });
    await tc.registerBotCommands();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const [, init] of fetchMock.mock.calls) expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("one scope failing does not stop the others: each is sent, and only the failure is reported", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); bodies.push(body);
      return body.scope.type === "chat" && body.scope.chat_id === "-100"
        ? { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: chat not found" }) } as unknown as Response
        : telegramOk();
    }));
    const { tc, info, warn } = commands([tg({ group_id: "-100" })]);
    await tc.registerBotCommands();
    expect(bodies.map(b => b.scope.type)).toEqual(["chat", "chat_administrators", "default", "all_private_chats", "all_group_chats"]);
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const err = warn.mock.calls[0]![0].err as AggregateError;
    expect(err.errors.map((e: Error) => e.message)).toEqual(["Telegram setMyCommands failed (400): Bad Request: chat not found"]);
  });

  it("one connection when named; every Telegram one when not; never a Discord one; nothing without a token", async () => {
    const { sent, fetchMock } = stubTelegram();
    const other = tg({ id: "tg-other", bot_token_env: "AGEND_TEST_TG_1191_OTHER" });
    const discord = { id: "dc", type: "discord", bot_token_env: TOKEN_ENV } as ChannelConfig;
    const { tc, warn } = commands([tg(), other, discord]);
    vi.stubEnv("AGEND_TEST_TG_1191_OTHER", "other-only");
    await tc.registerBotCommands(other);
    expect(new Set(sent().map(p => p.url))).toEqual(new Set(["https://api.telegram.org/botother-only/setMyCommands"]));
    fetchMock.mockClear();
    await tc.registerBotCommands();
    expect(sent().map(p => p.url.split("/")[3])).toEqual([...Array(3).fill("bottest-only"), ...Array(3).fill("botother-only")]);
    fetchMock.mockClear();
    await tc.registerBotCommands(discord);
    vi.stubEnv(TOKEN_ENV, "");
    await tc.registerBotCommands(tg());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ adapterId: "tg-classic" }, expect.stringContaining("bot token is not set"));
  });

  it("each scope is tried even when one fails, and a failure is reported, never thrown", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, json: vi.fn().mockResolvedValue({ ok: false, description: "Bad Request: chat not found" }) } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { tc, info, warn } = commands([tg({ group_id: "-100" })]);
    await expect(tc.registerBotCommands()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: "tg-classic", err: expect.objectContaining({ message: expect.stringContaining("chat not found") }) }),
      "Failed to register bot commands (non-fatal)",
    );
  });

  it("#2870: addClassicMenuChat — one chat's ClassicBot menu now; never the fleet group, a non-Telegram id or a Discord connection", async () => {
    const { sent, fetchMock } = stubTelegram();
    const discord = { id: "dc", type: "discord", bot_token_env: TOKEN_ENV } as ChannelConfig;
    const { tc, info } = commands([tg({ group_id: "-100" }), discord]);
    await tc.addClassicMenuChat("tg-classic", "555");
    expect(sent().map(p => [p.scope, names(p.commands)])).toEqual([[{ type: "chat", chat_id: 555 }, CLASSIC_MENU.map(([n]) => n)]]);
    expect(info).toHaveBeenCalledWith({ adapterId: "tg-classic" }, expect.stringContaining("newly allowed chat"));
    fetchMock.mockClear();
    for (const [a, c] of [["tg-classic", "-100"], ["tg-classic", "123456789012345678"], ["dc", "555"], ["nosuch", "555"]]) await tc.addClassicMenuChat(a!, c!);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("#2870: addClassicMenuChat failing is logged, never thrown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: chat not found" }) }));
    const { tc, warn } = commands([tg()]);
    await expect(tc.addClassicMenuChat("tg-classic", "555")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ adapterId: "tg-classic" }), expect.stringContaining("newly allowed chat"));
  });

  it("#1736: a custom telegram_api_root is used instead of api.telegram.org", async () => {
    const { sent } = stubTelegram();
    const { tc } = commands([tg({ telegram_api_root: "https://custom.tg.example.com" })]);
    await tc.registerBotCommands();
    for (const p of sent()) {
      expect(p.url).toBe("https://custom.tg.example.com/bottest-only/setMyCommands");
    }
  });

  it("#1736: a trailing slash in telegram_api_root is stripped", async () => {
    const { sent } = stubTelegram();
    const { tc } = commands([tg({ telegram_api_root: "https://custom.tg.example.com/" })]);
    await tc.registerBotCommands();
    expect(sent().every((p: { url: string }) => !p.url.includes("//bottest-only"))).toBe(true);
    expect(sent()[0]!.url).toBe("https://custom.tg.example.com/bottest-only/setMyCommands");
  });

  it("#1736: without telegram_api_root falls back to api.telegram.org (unchanged)", async () => {
    const { sent } = stubTelegram();
    const { tc } = commands([tg()]);
    await tc.registerBotCommands();
    for (const p of sent()) {
      expect(p.url).toBe("https://api.telegram.org/bottest-only/setMyCommands");
    }
  });
});

// ── the fleet: every Telegram adapter registers its own menus when it starts ───────────────────────────────

function mockAdapter(id: string, type: string) {
  const adapter = Object.assign(new EventEmitter(), {
    id, type, topology: "topics", start: vi.fn(async () => {}), stop: vi.fn(async () => {}), setChatId: vi.fn(),
    getHealthSnapshot: () => ({ status: "connected" }),
  });
  adapters.set(id, adapter as unknown as ChannelAdapter);
  return adapter;
}
function fleet(channels: ChannelConfig[]) {
  vi.stubEnv(TOKEN_ENV, "test-only");
  const dir = mkdtempSync(join(tmpdir(), "agend-1191-"));
  dirs.push(dir);
  const fm = new FleetManager(dir);
  managers.push(fm);
  const state = fm as any;
  for (const ch of channels) mockAdapter(ch.id ?? ch.type, ch.type);
  fm.fleetConfig = { channels, defaults: {}, instances: {} } as FleetConfig;
  const registered: Array<ChannelConfig | undefined> = [];
  state.topicCommands.registerBotCommands = vi.fn(async (ch?: ChannelConfig) => { registered.push(ch ? structuredClone(ch) : undefined); });
  state.probeCliEnvs = vi.fn();
  state.startTopicCleanupPoller = vi.fn();
  state.saveFleetConfig = vi.fn();
  state.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { fm, state, registered };
}
const discordPrimary = { id: "dc", type: "discord", mode: "topic", bot_token_env: TOKEN_ENV, group_id: "123456789012345678" } as ChannelConfig;

describe("FleetManager: who registers the Telegram menus (#1191)", () => {
  it("a Discord primary with a ClassicBot-only Telegram connection: the Telegram connection registers its own, at start", async () => {
    const { state, registered } = fleet([discordPrimary, tg()]);
    await state.startSharedAdapter(state.fleetConfig);
    expect(registered).toEqual([expect.objectContaining({ id: "tg-classic", type: "telegram" })]);
    expect(registered[0]!.group_id).toBeUndefined();
  });

  it("a Telegram primary registers its own; a Discord adapter never asks", async () => {
    const primary = tg({ id: "tg-main", group_id: "-100" });
    const { state, registered } = fleet([primary, { ...discordPrimary, id: "dc2" }]);
    await state.startSharedAdapter(state.fleetConfig);
    expect(registered.map(c => c?.id)).toEqual(["tg-main"]);
  });

  it("registration never holds up the adapter's login: a Telegram API that does not answer leaves start() to run", async () => {
    const { state } = fleet([discordPrimary, tg()]);
    let release!: () => void;
    state.topicCommands.registerBotCommands = vi.fn(() => new Promise<void>(r => { release = r; }));
    await state.startAdditionalAdapter(state.fleetConfig.channels[1]);
    expect(state.topicCommands.registerBotCommands).toHaveBeenCalledTimes(1);
    expect((adapters.get("tg-classic") as any).start).toHaveBeenCalledTimes(1);
    release();
  });

  it("a registration that fails is logged, never thrown into the adapter's start", async () => {
    const { state } = fleet([discordPrimary, tg()]);
    state.topicCommands.registerBotCommands = vi.fn(async () => { throw new Error("boom"); });
    await expect(state.startAdditionalAdapter(state.fleetConfig.channels[1])).resolves.toBeUndefined();
    await vi.waitFor(() => expect(state.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: "tg-classic" }), "registerBotCommands failed (non-fatal)"));
  });

  it("a secondary that failed to start registers when its retry starts it", async () => {
    const { state, registered } = fleet([discordPrimary, tg()]);
    await state.startAdditionalAdapter(state.fleetConfig.channels[1]);
    await state.startAdditionalAdapter(state.fleetConfig.channels[1]);
    expect(registered.map(c => c?.id)).toEqual(["tg-classic", "tg-classic"]);
  });

  it("Settings rotating the connection's token rebuilds it — and it registers again", async () => {
    const { state, registered } = fleet([discordPrimary, tg()]);
    await state.startSharedAdapter(state.fleetConfig);
    registered.length = 0;
    expect(await state.rebuildAdapterForSecret("tg-classic", state.fleetConfig.channels[1], true)).toBe(true);
    expect(registered.map(c => c?.id)).toEqual(["tg-classic"]);
  });

  it("Settings binding the connection to a forum group rebuilds it with the group — so the fleet menu comes with it", async () => {
    const { state, registered } = fleet([discordPrimary, tg()]);
    await state.startSharedAdapter(state.fleetConfig);
    registered.length = 0;
    state.secureConnectionChannel = (id: string) => state.fleetConfig.channels.find((c: ChannelConfig) => (c.id ?? c.type) === id);
    await state.rebuildAdapterForBinding("tg-classic", { group_id: "-1009876543210" });
    expect(registered).toEqual([expect.objectContaining({ id: "tg-classic", group_id: "-1009876543210" })]);
  });
});
