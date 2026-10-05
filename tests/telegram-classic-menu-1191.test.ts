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
  ["status", "🔒 "], ["sysinfo", ""], ["dashboard", "🔒 "], ["ctx", ""], ["compact", ""], ["steer", ""], ["btw", ""],
  ["clear", "🔒 "], ["model", "🔒 "], ["effort", "🔒 "], ["pause", "🔒 "], ["wake", "🔒 "], ["restart", "🔒 "],
  ["collab", ""], ["update", "🔒 "], ["doctor", "🔒 "], ["login", "🔒 "], ["usage", ""], ["tips", ""],
];
const CLASSIC_MENU = [
  ["start", ""], ["stop", "🔒 "], ["compact", "🔒 "], ["steer", ""], ["btw", ""], ["clear", "🔒 "], ["model", "🔒 "],
  ["pause", "🔒 "], ["wake", "🔒 "], ["ctx", ""],
];

describe("the menus come from the command table (#1177)", () => {
  it("each command with the lock its Telegram cells say", () => {
    expect(telegramMenu("fleet").map(e => [e.name, e.lock])).toEqual(FLEET_MENU);
    expect(telegramMenu("classic").map(e => [e.name, e.lock])).toEqual(CLASSIC_MENU);
  });

  it("the three hand-typed locks #1177 found wrong are gone, and the Classic menu has no /effort", () => {
    const lock = (menu: "fleet" | "classic", name: string) => telegramMenu(menu).find(e => e.name === name)?.lock;
    expect(lock("fleet", "collab"), "Telegram fleet /collab has no gate").toBe("");
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
    expect(isLockedOnTelegram(at("compact"), ["general", "fleet"])).toBe(false); // anyone in both
    expect(isLockedOnTelegram(at("compact"), ["classic"])).toBe(true);         // classic-admin
    expect(isLockedOnTelegram(at("clear"), ["classic"])).toBe(true);           // channel-admin
    expect(isLockedOnTelegram(at("start"), ["classic", "none"])).toBe(false);  // handler
    expect(isLockedOnTelegram(at("stop"), ["none"])).toBe(false);              // a refusal is not a level
    expect(isLockedOnTelegram(at("status"), ["fleet"])).toBe(false);           // passthrough
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

describe("TopicCommands.registerBotCommands (#1191)", () => {
  function commands(channels: ChannelConfig[]) {
    vi.stubEnv(TOKEN_ENV, "test-only");
    const info = vi.fn(), warn = vi.fn();
    const tc = new TopicCommands({ fleetConfig: { channels }, logger: { info, warn } } as any);
    return { tc, info, warn };
  }

  it("no group_id: the ClassicBot menu on all_group_chats and default — and nothing for a forum group it does not have", async () => {
    const { sent } = stubTelegram();
    const { tc, info, warn } = commands([tg()]);
    await tc.registerBotCommands();
    expect(sent().map(p => p.scope)).toEqual([{ type: "all_group_chats" }, { type: "default" }]);
    for (const p of sent()) {
      expect(p.url).toBe("https://api.telegram.org/bottest-only/setMyCommands");
      expect(names(p.commands)).toEqual(CLASSIC_MENU.map(([n]) => n));
    }
    expect(sent()[0]!.commands.find((c: { command: string }) => c.command === "stop").description).toBe("🔒 Stop the agent in this channel");
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: "tg-classic", fleetCommandCount: 0, classicCommandCount: 10, scopes: ["all_group_chats", "default"] }),
      expect.stringContaining("no group_id"),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("with a group_id: the fleet menu on the group's chat and chat_administrators, and the ClassicBot menu as above", async () => {
    const { sent } = stubTelegram();
    const { tc } = commands([tg({ group_id: "-1001234567890" })]);
    await tc.registerBotCommands();
    expect(sent().map(p => p.scope)).toEqual([
      { type: "chat", chat_id: "-1001234567890" }, { type: "chat_administrators", chat_id: "-1001234567890" },
      { type: "all_group_chats" }, { type: "default" },
    ]);
    expect(names(sent()[0]!.commands)).toEqual(FLEET_MENU.map(([n]) => n));
    expect(names(sent()[1]!.commands)).toEqual(FLEET_MENU.map(([n]) => n));
    expect(names(sent()[3]!.commands)).toEqual(CLASSIC_MENU.map(([n]) => n));
    expect(sent()[0]!.commands.find((c: { command: string }) => c.command === "collab").description).not.toContain("🔒");
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
    expect(sent().map(p => p.url.split("/")[3])).toEqual(["bottest-only", "bottest-only", "botother-only", "botother-only"]);
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
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: "tg-classic", err: expect.objectContaining({ message: expect.stringContaining("chat not found") }) }),
      "Failed to register bot commands (non-fatal)",
    );
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
