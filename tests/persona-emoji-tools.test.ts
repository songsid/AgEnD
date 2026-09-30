/**
 * An instance picks its own persona emoji (`list_emojis` + `set_persona_emoji`),
 * the way it picks its name with set_display_name. The value lands in its
 * per-instance `status_emojis` override (#1005 addendum 2), is judged by the
 * same code Settings and the react path use, and a Discord server emoji must
 * be one its bot can draw on (#1021's server list). Driven through the real
 * FleetManager, a real fleet.yaml, the real Discord adapter (REST stubbed),
 * the typed-IPC door with its permission check, the daemon's tool routing and
 * the agent endpoint.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { AdapterWorld } from "../src/adapter-world.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { Daemon } from "../src/daemon.js";
import { dispatchAgentOperation } from "../src/agent-endpoint.js";
import { TOOLS } from "../src/channel/mcp-tools.js";
import { toolsFor } from "../src/tool-permissions.js";
import type { ChannelAdapter } from "../src/channel/types.js";
import type { Logger } from "../src/logger.js";

const dirs: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const OPEN = { mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 0 };
const EMOJIS: Record<string, unknown[]> = {
  "/guilds/guild-1/emojis": [
    { id: "111111111111111111", name: "fox", animated: false, available: true },
    { id: "444444444444444444", name: "old", animated: false, available: false },
  ],
  "/guilds/guild-2/emojis": [{ id: "222222222222222222", name: "owl", animated: true, available: true }],
};

function fleet(get = vi.fn(async (route: string) => EMOJIS[route] ?? [])) {
  const dir = mkdtempSync(join(tmpdir(), "agend-persona-emoji-"));
  dirs.push(dir);
  const fleetPath = join(dir, "fleet.yaml");
  writeFileSync(fleetPath, [
    "channels:",
    "  - { id: dc, type: discord, mode: topic, bot_token_env: FAKE_DC, group_id: guild-1, access: { mode: open } }",
    "  - { id: tg, type: telegram, mode: topic, bot_token_env: FAKE_TG, group_id: \"-100\", access: { mode: open } }",
    "defaults:",
    "  backend: claude-code",
    "instances:",
    "  worker:",
    "    working_directory: /w",
    "    channel_id: dc",
    "    status_emojis:",
    "      failed: \"🐙\"",
    "  tgworker:",
    "    working_directory: /t",
    "    channel_id: tg",
    "",
  ].join("\n"));
  const fm = new FleetManager(dir);
  fm.loadConfig(fleetPath);
  writeFileSync(join(dir, "classicBot.yaml"), "defaults:\n  allowed_guilds: [\"guild-2\"]\n");
  const classic = new ClassicChannelManager(dir, pino({ level: "silent" }) as Logger);
  classic.setPrimaryAdapterId("dc");
  classic.register("555", "dc", "classic-room", "Room", "owner", "claude-code");
  fm.classicChannels = classic;
  const adapter = new DiscordAdapter({
    id: "dc", botToken: "fake-token", accessManager: new AccessManager(OPEN as any, join(dir, "a.json")),
    inboxDir: dir, guildId: "guild-1", registerCommands: false,
  });
  stops.push(() => adapter.stop());
  const cache = new Map([["guild-1", { id: "guild-1", name: "Main" }], ["guild-2", { id: "guild-2", name: "Classic HQ" }]]);
  vi.spyOn(adapter as any, "readyClient").mockResolvedValue({ rest: { get }, guilds: { cache } });
  const channels = (fm as any).fleetConfig.channels;
  fm.worlds.set("dc", new AdapterWorld("dc", adapter, new AccessManager(OPEN as any, join(dir, "b.json")), channels[0]));
  const tg = { id: "tg", type: "telegram", react: vi.fn(async () => {}), unreact: vi.fn(async () => {}) } as unknown as ChannelAdapter;
  fm.worlds.set("tg", new AdapterWorld("tg", tg, new AccessManager(OPEN as any, join(dir, "c.json")), channels[1]));
  const saved = () => (yaml.load(readFileSync(fleetPath, "utf8")) as any).instances;
  return { fm, dir, get, saved };
}

describe("set_persona_emoji writes the instance's own override, judged like Settings", () => {
  it("sets delivered by default, persists it next to what was there, and the next stamp uses it", async () => {
    const { fm, saved } = fleet();
    expect(await fm.setPersonaEmoji("worker", { emoji: " 🦊 " })).toEqual({
      status: "delivered", value: "🦊", now: "🦊", status_emojis: { failed: "🐙", delivered: "🦊" },
    });
    expect(saved().worker.status_emojis).toEqual({ failed: "🐙", delivered: "🦊" });
    expect(fm.resolveStatusEmojisFor("worker").delivered).toBe("🦊");
    // The react path, not just the resolver: the delivered stamp is the fox.
    const react = vi.fn(async () => {});
    const world = fm.worlds.get("dc")!;
    (world.adapter as any).react = react;
    (world.adapter as any).unreact = vi.fn(async () => {});
    fm.finishDeliveryStatus("worker", "guild-1", "m1", "delivered", "t1");
    await vi.waitFor(() => expect(react).toHaveBeenCalledWith("t1", "m1", "🦊", "t1"));
  });

  it("sets another status when named, and refuses a status that does not exist", async () => {
    const { fm, saved } = fleet();
    await fm.setPersonaEmoji("worker", { emoji: "🧠", status: "processing" });
    expect(saved().worker.status_emojis).toEqual({ failed: "🐙", processing: "🧠" });
    expect(await fm.setPersonaEmoji("worker", { emoji: "🦊", status: "done" })).toEqual({
      error: "status must be one of received, queued, processing, delivered, failed, progress_prefix",
    });
  });

  it("refuses what the platform cannot stamp, and stores nothing", async () => {
    const { fm, saved } = fleet();
    for (const bad of ["👀✅", "fox", "ok 🦊"]) {
      expect(await fm.setPersonaEmoji("worker", { emoji: bad })).toMatchObject({ error: expect.stringContaining("is not an emoji") });
    }
    // Telegram: only its reaction set, and no server emoji.
    expect(await fm.setPersonaEmoji("tgworker", { emoji: "🦊" })).toMatchObject({ error: expect.stringContaining("not in Telegram's allowed reaction set") });
    expect(await fm.setPersonaEmoji("tgworker", { emoji: "<:fox:111111111111111111>" })).toMatchObject({ error: expect.stringContaining("Telegram has no server custom emoji") });
    expect(saved().tgworker.status_emojis).toBeUndefined();
    expect(saved().worker.status_emojis).toEqual({ failed: "🐙" });
    expect(await fm.setPersonaEmoji("tgworker", { emoji: "🔥" })).toMatchObject({ value: "🔥" });
    expect(saved().tgworker.status_emojis).toEqual({ delivered: "🔥" });
  });

  it("takes a server emoji only from a server its bot can draw on, stored in the canonical form", async () => {
    const { fm, saved } = fleet();
    // Another allowed server's emoji, written bare with the wrong name: stored as Discord names it.
    expect(await fm.setPersonaEmoji("worker", { emoji: "whatever:222222222222222222" })).toMatchObject({ value: "<a:owl:222222222222222222>" });
    expect(saved().worker.status_emojis.delivered).toBe("<a:owl:222222222222222222>");
    expect(await fm.setPersonaEmoji("worker", { emoji: "<:ghost:999999999999999999>" })).toEqual({
      error: "<:ghost:999999999999999999> is not a server emoji this bot can use. Call list_emojis for the ones it can.",
    });
    expect(await fm.setPersonaEmoji("worker", { emoji: "<:old:444444444444444444>" })).toMatchObject({
      error: expect.stringContaining("(Discord marks it unavailable)"),
    });
    expect(saved().worker.status_emojis.delivered).toBe("<a:owl:222222222222222222>");
  });

  it("refuses a server emoji it cannot check", async () => {
    const { fm } = fleet(vi.fn(async () => { throw new Error("Missing Access"); }));
    expect(await fm.setPersonaEmoji("worker", { emoji: "<:fox:111111111111111111>" })).toEqual({
      error: "cannot check that server emoji: Discord refused the emoji list: Missing Access",
    });
  });

  it("an empty emoji removes that override; the last one removes the map", async () => {
    const { fm, saved } = fleet();
    await fm.setPersonaEmoji("worker", { emoji: "🦊" });
    expect(await fm.setPersonaEmoji("worker", { emoji: "" })).toMatchObject({ value: null, now: "✅" });
    expect(saved().worker.status_emojis).toEqual({ failed: "🐙" });
    await fm.setPersonaEmoji("worker", { emoji: "", status: "failed" });
    expect(saved().worker).not.toHaveProperty("status_emojis");
  });

  it("says why for a ClassicBot instance and for an unknown one", async () => {
    const { fm } = fleet();
    expect(await fm.setPersonaEmoji("classic-room", { emoji: "🦊" })).toEqual({
      error: "ClassicBot instances have no per-instance status emojis; an operator sets the connection's in Settings",
    });
    expect(await fm.setPersonaEmoji("nobody", { emoji: "🦊" })).toEqual({ error: "Instance 'nobody' not found" });
  });
});

describe("list_emojis shows what the instance may pick", () => {
  it("Discord: its stamps with their source, the suggestions, and each server's usable emojis", async () => {
    const { fm } = fleet();
    const r = await fm.listEmojisFor("worker");
    expect(r.platform).toBe("discord");
    expect(r.statuses).toContainEqual({ status: "failed", value: "🐙", source: "instance" });
    expect(r.statuses).toContainEqual({ status: "delivered", value: "✅", source: "builtin" });
    expect((r.standard as any).suggestions).toContain("🦊");
    expect(r.server_emojis).toEqual([
      { server: "Main", primary: true, emojis: ["<:fox:111111111111111111>"] }, // the unavailable one is left out
      { server: "Classic HQ", primary: false, emojis: ["<a:owl:222222222222222222>"] },
    ]);
  });

  it("Telegram: its reaction set, and no server emojis", async () => {
    const { fm, get } = fleet();
    const r = await fm.listEmojisFor("tgworker");
    expect(r.platform).toBe("telegram");
    expect((r.standard as any).reactions).toContain("🔥");
    expect((r.standard as any).reactions).not.toContain("🦊");
    expect(r).not.toHaveProperty("server_emojis");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("the tools reach the fleet through the doors the other identity tools use", () => {
  it("are MCP tools a worker has, and a minimal agent does not", () => {
    const names = TOOLS.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_emojis", "set_persona_emoji"]));
    expect([...toolsFor("worker")]).toEqual(expect.arrayContaining(["list_emojis", "set_persona_emoji"]));
    expect([...toolsFor("standard")]).toEqual(expect.arrayContaining(["list_emojis", "set_persona_emoji"]));
    expect([...toolsFor("minimal")]).not.toContain("set_persona_emoji");
  });

  it("the daemon forwards them as typed IPC and settles on the fleet's answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-persona-daemon-"));
    dirs.push(dir);
    const daemon = new Daemon("worker", {
      working_directory: dir, log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, dir, true, undefined, undefined, pino({ level: "silent" }) as Logger) as any;
    const broadcast = vi.fn();
    const send = vi.fn(() => true);
    daemon.ipcServer = { broadcast, send };
    const socket = { destroyed: false } as any;
    daemon.handleToolCall({ tool: "set_persona_emoji", args: { emoji: "🦊" }, requestId: 7 }, socket);
    daemon.handleToolCall({ tool: "list_emojis", args: {}, requestId: 8 }, socket);
    expect(broadcast.mock.calls.map(c => [c[0].type, c[0].payload])).toEqual([
      ["fleet_set_persona_emoji", { emoji: "🦊" }],
      ["fleet_list_emojis", {}],
    ]);
    const [setId, listId] = broadcast.mock.calls.map(c => c[0].fleetRequestId);
    daemon.routeFleetResponse({ type: "fleet_persona_emoji_response", fleetRequestId: setId, result: { value: "🦊" } });
    daemon.routeFleetResponse({ type: "fleet_persona_emoji_response", fleetRequestId: listId, error: "nope" });
    expect(send).toHaveBeenCalledWith(socket, { requestId: 7, result: { value: "🦊" }, error: undefined });
    expect(send).toHaveBeenCalledWith(socket, { requestId: 8, result: undefined, error: "nope" });
    expect(daemon.pendingIpcRequests.size).toBe(0);
  });

  it("the fleet answers the typed IPC with a result or the refusal", async () => {
    const { fm, saved } = fleet();
    const ipcSend = vi.fn();
    (fm as any).instanceIpcClients.set("worker", { send: ipcSend });
    (fm as any).dispatchTypedIpc("worker", { type: "fleet_set_persona_emoji", fleetRequestId: "e1", payload: { emoji: "🦊" } });
    (fm as any).dispatchTypedIpc("worker", { type: "fleet_set_persona_emoji", fleetRequestId: "e2", payload: { emoji: "fox" } });
    (fm as any).dispatchTypedIpc("worker", { type: "fleet_list_emojis", fleetRequestId: "e3", payload: {} });
    await vi.waitFor(() => expect(ipcSend).toHaveBeenCalledTimes(3));
    const by = Object.fromEntries(ipcSend.mock.calls.map(c => [c[0].fleetRequestId, c[0]]));
    expect(by.e1).toMatchObject({ type: "fleet_persona_emoji_response", result: { value: "🦊" } });
    expect(by.e2).toMatchObject({ type: "fleet_persona_emoji_response", error: expect.stringContaining("is not an emoji") });
    expect(by.e2).not.toHaveProperty("result");
    expect(by.e3.result.platform).toBe("discord");
    expect(saved().worker.status_emojis.delivered).toBe("🦊");
  });

  it("a refused typed message is answered on the persona-emoji response type", () => {
    const { fm } = fleet();
    const ipcSend = vi.fn();
    (fm as any).instanceIpcClients.set("worker", { send: ipcSend });
    (fm as any).refuseTypedIpc("worker", { type: "fleet_set_persona_emoji", fleetRequestId: "r1" }, "not allowed");
    expect(ipcSend).toHaveBeenCalledWith({ type: "fleet_persona_emoji_response", fleetRequestId: "r1", error: "not allowed" });
  });

  it("the agent endpoint (agent-cli) reaches the same two methods", async () => {
    const { fm, saved } = fleet();
    const ctx = Object.assign(Object.create(fm), { dataDir: "/tmp", logger: pino({ level: "silent" }) });
    ctx.fleetConfig = (fm as any).fleetConfig;
    expect(await dispatchAgentOperation(ctx, "worker", "persona-emoji", { emoji: "🧠", status: "processing" })).toMatchObject({ value: "🧠" });
    expect(saved().worker.status_emojis.processing).toBe("🧠");
    expect(await dispatchAgentOperation(ctx, "worker", "emojis", {})).toMatchObject({ platform: "discord" });
  });
});
