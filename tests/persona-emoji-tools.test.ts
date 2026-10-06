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
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
import { mayUseTool, toolsFor } from "../src/tool-permissions.js";
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
      error: "status must be one of received, queued, processing, delivered, failed, progress_prefix, photo, attachment",
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

describe("#1039 review: a concurrent change survives, and a malformed call clears nothing", () => {
  it("another status changed while Discord was being asked is kept; only the named key changes", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const get = vi.fn(async (route: string) => { await gate; return EMOJIS[route] ?? []; });
    const { fm, saved } = fleet(get);
    const pending = fm.setPersonaEmoji("worker", { emoji: "<:fox:111111111111111111>" });
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    // Meanwhile: another set_persona_emoji on another key, then a Settings
    // save that replaces the instance's config object outright.
    await fm.setPersonaEmoji("worker", { emoji: "🧠", status: "processing" });
    const cfg = (fm as any).fleetConfig;
    cfg.instances.worker = { ...cfg.instances.worker, status_emojis: { ...cfg.instances.worker.status_emojis, queued: "⌛" } };
    release();
    expect(await pending).toMatchObject({ value: "<:fox:111111111111111111>" });
    const expected = { failed: "🐙", processing: "🧠", queued: "⌛", delivered: "<:fox:111111111111111111>" };
    expect(cfg.instances.worker.status_emojis).toEqual(expected);
    expect(saved().worker.status_emojis).toEqual(expected);
  });

  it("a missing, non-string or blank emoji is refused and leaves the override alone; only exactly \"\" clears", async () => {
    const { fm, saved } = fleet();
    await fm.setPersonaEmoji("worker", { emoji: "🦊" });
    for (const args of [{}, { emoji: undefined }, { emoji: null }, { emoji: 5 }, { status: "delivered" }]) {
      expect(await fm.setPersonaEmoji("worker", args as any)).toEqual({
        error: 'emoji is required: one emoji, a <:name:id> from list_emojis, or "" to remove your override',
      });
    }
    // Whitespace only is not an explicit "" either.
    for (const emoji of [" ", "\t", "\n", "  \t\n "]) {
      expect(await fm.setPersonaEmoji("worker", { emoji })).toEqual({
        error: 'emoji is blank: pass one emoji, a <:name:id> from list_emojis, or exactly "" to remove your override',
      });
    }
    expect(saved().worker.status_emojis.delivered).toBe("🦊");
    // The doors that run no schema: typed IPC and the agent endpoint.
    const ipcSend = vi.fn();
    (fm as any).instanceIpcClients.set("worker", { send: ipcSend });
    (fm as any).dispatchTypedIpc("worker", { type: "fleet_set_persona_emoji", fleetRequestId: "m1", payload: {} });
    await vi.waitFor(() => expect(ipcSend).toHaveBeenCalledOnce());
    expect(ipcSend.mock.calls[0]![0]).toMatchObject({ fleetRequestId: "m1", error: expect.stringContaining("emoji is required") });
    const ctx = Object.assign(Object.create(fm), { dataDir: "/tmp", logger: pino({ level: "silent" }) });
    ctx.fleetConfig = (fm as any).fleetConfig;
    expect(await dispatchAgentOperation(ctx, "worker", "persona-emoji", {})).toMatchObject({ error: expect.stringContaining("emoji is required") });
    expect(await dispatchAgentOperation(ctx, "worker", "persona-emoji", { emoji: " " })).toMatchObject({ error: expect.stringContaining("emoji is blank") });
    expect(saved().worker.status_emojis.delivered).toBe("🦊");
    expect(await dispatchAgentOperation(ctx, "worker", "persona-emoji", { emoji: "" })).toMatchObject({ value: null });
    expect(saved().worker.status_emojis).toEqual({ failed: "🐙" });
  });

  it("agent-cli refuses `persona-emoji` with no argument instead of sending a clear, and sends an explicit \"\"", async () => {
    const posts: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => { posts.push(JSON.parse(body)); res.end(JSON.stringify({ ok: true })); });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    const home = mkdtempSync(join(tmpdir(), "agend-persona-cli-"));
    dirs.push(home);
    const run = (...argv: string[]) => new Promise<{ code: number; out: string }>(resolve => {
      execFile(process.execPath, ["--import", "tsx", join(process.cwd(), "src/agent-cli.ts"), ...argv], {
        env: { ...process.env, AGEND_PORT: String(port), AGEND_INSTANCE_NAME: "worker", AGEND_HOME: home },
        timeout: 30_000,
      }, (err, stdout) => resolve({ code: err ? (err as any).code ?? 1 : 0, out: stdout }));
    });
    try {
      const missing = await run("persona-emoji");
      expect(missing.code).toBe(1);
      expect(missing.out).toContain("Usage: agend-agent persona-emoji");
      expect(posts).toEqual([]);
      const cleared = await run("persona-emoji", "");
      expect(cleared.code).toBe(0);
      expect(posts).toEqual([{ instance: "worker", op: "persona-emoji", args: { emoji: "" } }]);
    } finally {
      await new Promise(r => server.close(r));
    }
  }, 60_000);
});

describe("list_emojis shows what the instance may pick", () => {
  it("Discord: its stamps with their source, the suggestions, and each server's usable emojis", async () => {
    const { fm } = fleet();
    const r = await fm.listEmojisFor("worker");
    expect(r.platform).toBe("discord");
    expect(r.statuses).toContainEqual({ status: "failed", value: "🐙", source: "instance" });
    expect(r.statuses).toContainEqual({ status: "delivered", value: "✅", source: "builtin" });
    expect((r.standard as any).suggestions).toContain("🦊");
    // #1226: no image URLs unless asked for (preview_emojis is how an agent looks at one).
    expect(r.server_emojis).toEqual([
      // the unavailable one is left out
      { server: "Main", primary: true, emojis: [{ value: "<:fox:111111111111111111>" }] },
      { server: "Classic HQ", primary: false, emojis: [{ value: "<a:owl:222222222222222222>" }] },
    ]);
    const withUrls = await fm.listEmojisFor("worker", false, { with_image_urls: true });
    expect(withUrls.server_emojis).toEqual([
      { server: "Main", primary: true, emojis: [{ value: "<:fox:111111111111111111>", image_url: "https://cdn.discordapp.com/emojis/111111111111111111.png" }] },
      { server: "Classic HQ", primary: false, emojis: [{ value: "<a:owl:222222222222222222>", image_url: "https://cdn.discordapp.com/emojis/222222222222222222.gif" }] },
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

// ── #1040: preview_emojis ──────────────────────────────────────────────────

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // a PNG signature + IHDR start
function cdn(opts: { type?: string; body?: Uint8Array; status?: number } = {}) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(new Uint8Array(opts.body ?? PNG), {
    status: opts.status ?? 200, headers: { "content-type": opts.type ?? "image/png" },
  }));
}

describe("preview_emojis downloads a few server emojis for the agent to look at (#1040)", () => {
  it("fetches each from the CDN URL it builds from the listed id, and returns a path to Read", async () => {
    const { fm, dir } = fleet();
    const fetchMock = cdn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await fm.previewEmojis("worker", { emojis: ["<:fox:111111111111111111>", "anything:222222222222222222"] });
    expect(r.errors).toEqual([]);
    expect(r.previews).toEqual([
      { emoji: "<:fox:111111111111111111>", path: join(dir, "inbox", "emoji-previews", "111111111111111111.png") },
      { emoji: "<a:owl:222222222222222222>", path: join(dir, "inbox", "emoji-previews", "222222222222222222.png") },
    ]);
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual([
      "https://cdn.discordapp.com/emojis/111111111111111111.png?size=96",
      "https://cdn.discordapp.com/emojis/222222222222222222.png?size=96", // static PNG, animated too
    ]);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    expect(readFileSync((r.previews as any)[0].path)).toEqual(PNG);
    // Cached by id: asking again downloads nothing.
    await fm.previewEmojis("worker", { emojis: ["<:fox:111111111111111111>"] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("never fetches anything the bot cannot use, and takes no URL", async () => {
    const { fm } = fleet();
    const fetchMock = cdn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await fm.previewEmojis("worker", { emojis: [
      "<:ghost:999999999999999999>", "<:old:444444444444444444>",
      "https://169.254.169.254/latest/meta-data", "🦊",
    ] });
    expect(r.previews).toEqual([]);
    expect(r.errors).toEqual([
      { emoji: "<:ghost:999999999999999999>", error: "not a server emoji this bot can use" },
      { emoji: "<:old:444444444444444444>", error: "not a server emoji this bot can use" },
      { emoji: "https://169.254.169.254/latest/meta-data", error: "not a server emoji (a standard emoji needs no preview)" },
      { emoji: "🦊", error: "not a server emoji (a standard emoji needs no preview)" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("refuses a malformed or oversized request, Telegram, and ClassicBot, before any download", async () => {
    const { fm } = fleet();
    const fetchMock = cdn();
    vi.stubGlobal("fetch", fetchMock);
    for (const emojis of [undefined, [], "<:fox:111111111111111111>", [5]]) {
      expect(await fm.previewEmojis("worker", { emojis } as any)).toEqual({ error: "emojis is required: a list of <:name:id> values from list_emojis" });
    }
    expect(await fm.previewEmojis("worker", { emojis: Array(9).fill("<:fox:111111111111111111>") }))
      .toEqual({ error: "at most 8 at a time: narrow them down by name first" });
    expect(await fm.previewEmojis("tgworker", { emojis: ["👍"] }))
      .toEqual({ error: "only Discord server emojis need a preview; standard emojis are what they look like" });
    expect(await fm.previewEmojis("nobody", { emojis: ["<:fox:111111111111111111>"] }))
      .toEqual({ error: "Instance 'nobody' not found" });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("keeps nothing that is not a small PNG", async () => {
    const { fm, dir } = fleet();
    const file = join(dir, "inbox", "emoji-previews", "111111111111111111.png");
    for (const [cdnReply, error] of [
      [{ type: "text/html" }, "download failed: not a PNG"],
      [{ status: 404, type: "application/json" }, "download failed: HTTP 404"],
      [{ body: new Uint8Array(256 * 1024 + 1) }, "download failed: image too large"],
    ] as const) {
      vi.stubGlobal("fetch", cdn(cdnReply));
      expect(await fm.previewEmojis("worker", { emojis: ["<:fox:111111111111111111>"] }))
        .toMatchObject({ previews: [], errors: [{ emoji: "<:fox:111111111111111111>", error }] });
      expect(existsSync(file)).toBe(false);
    }
    vi.unstubAllGlobals();
  });

  it("a stale preview is pruned and fetched again", async () => {
    const { fm } = fleet();
    const fetchMock = cdn();
    vi.stubGlobal("fetch", fetchMock);
    const first = await fm.previewEmojis("worker", { emojis: ["<:fox:111111111111111111>"] });
    const path = (first.previews as any)[0].path;
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    utimesSync(path, old, old);
    await fm.previewEmojis("worker", { emojis: ["<:fox:111111111111111111>"] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("reaches the fleet through the same doors as the other persona-emoji tools", async () => {
    expect(TOOLS.map(t => t.name)).toContain("preview_emojis");
    expect([...toolsFor("worker")]).toContain("preview_emojis");
    expect([...toolsFor("standard")]).toContain("preview_emojis");
    // v2.1.9: every profile can see the server's emojis.
    expect([...toolsFor("general")]).toContain("preview_emojis");
    expect([...toolsFor("minimal")]).toContain("preview_emojis");

    const dir = mkdtempSync(join(tmpdir(), "agend-preview-daemon-"));
    dirs.push(dir);
    const daemon = new Daemon("worker", {
      working_directory: dir, log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, dir, true, undefined, undefined, pino({ level: "silent" }) as Logger) as any;
    const broadcast = vi.fn();
    daemon.ipcServer = { broadcast, send: vi.fn(() => true) };
    daemon.handleToolCall({ tool: "preview_emojis", args: { emojis: ["<:fox:111111111111111111>"] }, requestId: 1 }, { destroyed: false });
    expect(broadcast.mock.calls[0]![0]).toMatchObject({ type: "fleet_preview_emojis", payload: { emojis: ["<:fox:111111111111111111>"] } });

    const { fm } = fleet();
    vi.stubGlobal("fetch", cdn());
    const ipcSend = vi.fn();
    (fm as any).instanceIpcClients.set("worker", { send: ipcSend });
    (fm as any).dispatchTypedIpc("worker", { type: "fleet_preview_emojis", fleetRequestId: "p1", payload: { emojis: ["<:fox:111111111111111111>"] } });
    await vi.waitFor(() => expect(ipcSend).toHaveBeenCalledOnce());
    expect(ipcSend.mock.calls[0]![0]).toMatchObject({ type: "fleet_persona_emoji_response", fleetRequestId: "p1", result: { previews: [{ emoji: "<:fox:111111111111111111>" }] } });
    (fm as any).refuseTypedIpc("worker", { type: "fleet_preview_emojis", fleetRequestId: "p2" }, "no");
    expect(ipcSend).toHaveBeenLastCalledWith({ type: "fleet_persona_emoji_response", fleetRequestId: "p2", error: "no" });
    const ctx = Object.assign(Object.create(fm), { dataDir: "/tmp", logger: pino({ level: "silent" }) });
    ctx.fleetConfig = (fm as any).fleetConfig;
    expect(await dispatchAgentOperation(ctx, "worker", "emoji-preview", { emojis: ["<:fox:111111111111111111>"] }))
      .toMatchObject({ previews: [{ emoji: "<:fox:111111111111111111>" }] });
    vi.unstubAllGlobals();
  });

  it("agent-cli refuses `emoji-preview` with nothing to preview, and sends the list it was given", async () => {
    const posts: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => { posts.push(JSON.parse(body)); res.end("{}"); });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    const home = mkdtempSync(join(tmpdir(), "agend-preview-cli-"));
    dirs.push(home);
    const run = (...argv: string[]) => new Promise<{ code: number; out: string }>(resolve => {
      execFile(process.execPath, ["--import", "tsx", join(process.cwd(), "src/agent-cli.ts"), ...argv], {
        env: { ...process.env, AGEND_PORT: String(port), AGEND_INSTANCE_NAME: "worker", AGEND_HOME: home },
        timeout: 30_000,
      }, (err, stdout) => resolve({ code: err ? (err as any).code ?? 1 : 0, out: stdout }));
    });
    try {
      const none = await run("emoji-preview");
      expect(none.code).toBe(1);
      expect(none.out).toContain("Usage: agend-agent emoji-preview");
      expect(posts).toEqual([]);
      expect((await run("emoji-preview", "<:fox:111111111111111111>", "<a:owl:222222222222222222>")).code).toBe(0);
      expect(posts).toEqual([{ instance: "worker", op: "emoji-preview", args: { emojis: ["<:fox:111111111111111111>", "<a:owl:222222222222222222>"] } }]);
    } finally {
      await new Promise(r => server.close(r));
    }
  }, 60_000);
});


describe("persona-emoji tools per profile (v2.1.9: every instance can see server emojis)", () => {
  const SEE = ["list_emojis", "preview_emojis"];
  const SET = "set_persona_emoji";
  it("every profile can see: list_emojis and preview_emojis", () => {
    for (const profile of ["general", "minimal", "worker", "standard", "coordinator", "full"] as const) {
      for (const tool of SEE) expect(mayUseTool(profile, tool), `${profile}/${tool}`).toBe(true);
    }
  });
  it("setting a stamp: every profile but minimal", () => {
    for (const profile of ["general", "worker", "standard", "coordinator", "full"] as const) {
      expect(mayUseTool(profile, SET), profile).toBe(true);
    }
    expect(mayUseTool("minimal", SET)).toBe(false);
  });
  it("minimal stays minimal otherwise: no mutating identity tools", () => {
    for (const tool of ["set_persona_emoji", "set_display_name", "set_description"]) {
      expect(mayUseTool("minimal", tool), tool).toBe(false);
    }
  });
});

// ── #1080: the photo / attachment stamps are persona emoji too ───────────────

describe("set_persona_emoji / list_emojis cover the photo and attachment stamps (#1080)", () => {
  it("sets photo and attachment in the instance's own override, judged like every other status", async () => {
    const { fm, saved } = fleet();
    expect(await fm.setPersonaEmoji("worker", { emoji: "🦊", status: "photo" })).toEqual({
      status: "photo", value: "🦊", now: "🦊", status_emojis: { failed: "🐙", photo: "🦊" },
    });
    expect(await fm.setPersonaEmoji("worker", { emoji: "<:fox:111111111111111111>", status: "attachment" })).toMatchObject({
      status: "attachment", value: "<:fox:111111111111111111>",
    });
    expect(saved().worker.status_emojis).toEqual({ failed: "🐙", photo: "🦊", attachment: "<:fox:111111111111111111>" });
    expect(fm.resolveStatusEmojisFor("worker")).toMatchObject({ photo: "🦊", attachment: "<:fox:111111111111111111>", delivered: "✅" });
  });

  it("refuses several emojis, text, and (on Telegram) a non-reaction, exactly as for delivered", async () => {
    const { fm, saved } = fleet();
    for (const status of ["photo", "attachment"]) {
      expect(await fm.setPersonaEmoji("worker", { emoji: "🦊🍎", status })).toMatchObject({ error: expect.stringContaining("not an emoji") });
      expect(await fm.setPersonaEmoji("worker", { emoji: "fox", status })).toMatchObject({ error: expect.stringContaining("not an emoji") });
      expect(await fm.setPersonaEmoji("tgworker", { emoji: "🦊", status })).toMatchObject({ error: expect.stringContaining("not in Telegram's allowed reaction set") });
      expect(await fm.setPersonaEmoji("tgworker", { emoji: "<:fox:111111111111111111>", status })).toMatchObject({ error: expect.stringContaining("Telegram has no server custom emoji") });
    }
    expect(await fm.setPersonaEmoji("worker", { emoji: "<:ghost:999999999999999999>", status: "photo" })).toMatchObject({ error: expect.stringContaining("not a server emoji this bot can use") });
    expect(saved().worker.status_emojis).toEqual({ failed: "🐙" });
    expect(saved().tgworker.status_emojis).toBeUndefined();
    // a Telegram reaction is accepted (unlike 📸/📎 themselves, which Telegram does not have)
    expect(await fm.setPersonaEmoji("tgworker", { emoji: "🔥", status: "photo" })).toMatchObject({ value: "🔥" });
    expect(await fm.setPersonaEmoji("tgworker", { emoji: "📸", status: "photo" })).toMatchObject({ error: expect.stringContaining("not in Telegram's allowed reaction set") });
  });

  it('exactly "" removes just that override, and the built-in stamp is back', async () => {
    const { fm, saved } = fleet();
    await fm.setPersonaEmoji("worker", { emoji: "🦊", status: "photo" });
    await fm.setPersonaEmoji("worker", { emoji: "🍎", status: "attachment" });
    expect(await fm.setPersonaEmoji("worker", { emoji: "", status: "photo" })).toMatchObject({ status: "photo", value: null, now: "📸" });
    expect(saved().worker.status_emojis).toEqual({ failed: "🐙", attachment: "🍎" });
  });

  it("list_emojis names both stamps with their source — builtin until the instance sets one", async () => {
    const { fm } = fleet();
    let r = await fm.listEmojisFor("worker");
    expect(r.statuses).toContainEqual({ status: "photo", value: "📸", source: "builtin" });
    expect(r.statuses).toContainEqual({ status: "attachment", value: "📎", source: "builtin" });
    await fm.setPersonaEmoji("worker", { emoji: "🦊", status: "photo" });
    r = await fm.listEmojisFor("worker");
    expect(r.statuses).toContainEqual({ status: "photo", value: "🦊", source: "instance" });
    expect(r.statuses).toContainEqual({ status: "attachment", value: "📎", source: "builtin" });
    const tg = await fm.listEmojisFor("tgworker");
    expect(tg.statuses).toContainEqual({ status: "photo", value: "👌", source: "builtin" });
    expect(tg.statuses).toContainEqual({ status: "attachment", value: "👍", source: "builtin" });
  });

  it("they are stamps on a saved file, not delivery statuses: the avoid list and the own-reaction ladder do not grow", async () => {
    const { fm } = fleet();
    await fm.setPersonaEmoji("worker", { emoji: "🦊", status: "photo" });
    await fm.setPersonaEmoji("worker", { emoji: "🍎", status: "attachment" });
    expect(fm.statusEmojiAvoidList("worker")).toEqual(["👀", "⏳", "✅", "🐙"]);
    const { previewStatusEmojis } = await import("../src/status-emojis.js");
    expect(previewStatusEmojis({ platform: "discord", instanceConfig: { photo: "🦊" } }).avoid).toEqual(["👀", "⏳", "✅", "❌"]);
  });

  it("is still the same tool for the same roles, and the schema takes the two new statuses", async () => {
    const { SetPersonaEmojiArgs } = await import("../src/outbound-schemas.js");
    for (const status of ["photo", "attachment", "delivered", "progress_prefix"]) {
      expect(SetPersonaEmojiArgs.safeParse({ emoji: "🦊", status }).success, status).toBe(true);
    }
    expect(SetPersonaEmojiArgs.safeParse({ emoji: "🦊", status: "video" }).success).toBe(false);
    expect([...toolsFor("worker")]).toEqual(expect.arrayContaining(["list_emojis", "set_persona_emoji"]));
    expect([...toolsFor("standard")]).toEqual(expect.arrayContaining(["list_emojis", "set_persona_emoji"]));
  });
});

describe("the four saved-attachment stamps read the configured emoji (#1080)", () => {
  type Msg = Record<string, unknown>;
  interface Internals {
    classicChannels: { isCollab: (c: string, a?: string) => boolean };
    saveClassicAttachment: (n: string, m: Msg) => Promise<unknown>;
    forwardToClassicInstance: (...a: unknown[]) => Promise<void>;
    handleClassicChannelMessage(name: string, msg: Msg): Promise<void>;
  }

  /** The four code paths that stamp a saved photo / file, each as the message that reaches it. */
  const SITES = [
    { name: "collab, not @mentioned", collab: true, text: "look at this", mention: false },
    { name: "collab, @mentioned", collab: true, text: "<@BOT> look at this", mention: true },
    { name: "plain classic, no /chat", collab: false, text: "look at this", mention: false },
    { name: "plain classic, /chat", collab: false, text: "/chat look at this", mention: false },
  ] as const;

  async function run(
    site: typeof SITES[number], kind: "photo" | "document",
    opts: { instance?: string; world?: "dc" | "tg"; channelOptions?: Record<string, unknown>; instanceOverride?: Record<string, string> } = {},
  ) {
    vi.spyOn(ClassicChannelManager, "logMessage").mockImplementation(() => {});
    const { fm } = fleet();
    const instance = opts.instance ?? "classic-room";
    const worldId = opts.world ?? "dc";
    const world = fm.worlds.get(worldId)!;
    const react = vi.fn(async (..._a: unknown[]) => {});
    (world.adapter as any).react = react;
    world.botUserId = "BOT";
    if (opts.channelOptions) (world.channelConfig as any).options = { status_emojis: opts.channelOptions };
    if (opts.instanceOverride) (fm as any).fleetConfig.instances[instance] = { working_directory: "/c", status_emojis: opts.instanceOverride };
    const internals = fm as unknown as Internals;
    internals.classicChannels = { isCollab: () => site.collab } as any;
    internals.saveClassicAttachment = vi.fn(async () => ({ path: "/inbox/f", paths: ["/inbox/f"], kind }));
    internals.forwardToClassicInstance = vi.fn(async () => {});
    await internals.handleClassicChannelMessage(instance, {
      source: worldId === "tg" ? "telegram" : "discord", adapterId: worldId, chatId: "guild-1", threadId: "555", messageId: "m-1",
      userId: "u", username: "han", text: site.text, timestamp: new Date(),
      attachments: [{ kind, fileId: "f1", filename: "x" }],
    });
    // the received 👀 is stamped too; the saved-attachment stamp is the other call
    return react.mock.calls.map(c => c[2] as string);
  }

  it.each(SITES.map(s => [s.name, s] as const))("%s: the built-in stamp is unchanged without an override (📸 / 📎)", async (_n, site) => {
    expect(await run(site, "photo")).toContain("📸");
    expect(await run(site, "document")).toContain("📎");
  });

  it.each(SITES.map(s => [s.name, s] as const))("%s: a connection override is used for each kind", async (_n, site) => {
    const options = { photo: "🦊", attachment: "🍎" };
    const photo = await run(site, "photo", { channelOptions: options });
    expect(photo).toContain("🦊");
    expect(photo).not.toContain("📸");
    expect(photo).not.toContain("🍎");
    const file = await run(site, "document", { channelOptions: options });
    expect(file).toContain("🍎");
    expect(file).not.toContain("📎");
    expect(file).not.toContain("🦊");
  });

  it.each(SITES.map(s => [s.name, s] as const))("%s: the instance's own override wins over the connection's, and only for its kind", async (_n, site) => {
    const photo = await run(site, "photo", { instance: "worker", channelOptions: { photo: "🦊", attachment: "🍎" }, instanceOverride: { photo: "🐙" } });
    expect(photo).toContain("🐙");
    expect(photo).not.toContain("🦊");
    const file = await run(site, "document", { instance: "worker", channelOptions: { photo: "🦊", attachment: "🍎" }, instanceOverride: { photo: "🐙" } });
    expect(file).toContain("🍎");            // no instance attachment override → the connection's
  });

  it.each(SITES.map(s => [s.name, s] as const))("%s: a Discord server emoji is reacted with as name:id", async (_n, site) => {
    const photo = await run(site, "photo", { channelOptions: { photo: "<:fox:111111111111111111>" } });
    expect(photo).toContain("fox:111111111111111111");
  });

  it.each(SITES.map(s => [s.name, s] as const))("%s: on Telegram the stamp stays 👌 / 👍 unless a valid reaction is configured; an invalid one falls back", async (_n, site) => {
    // The shared fixture's tg adapter is a plain stub; make it a real TelegramAdapter so the platform resolves to telegram.
    const { TelegramAdapter } = await import("../src/channel/adapters/telegram.js");
    vi.spyOn(ClassicChannelManager, "logMessage").mockImplementation(() => {});
    const go = async (kind: "photo" | "document", options?: Record<string, unknown>) => {
      const { fm } = fleet();
      const tgWorld = fm.worlds.get("tg")!;
      const react = vi.fn(async (..._a: unknown[]) => {});
      const adapter = Object.assign(Object.create(TelegramAdapter.prototype), { id: "tg", react, unreact: vi.fn(async () => {}) });
      (tgWorld as any).adapter = adapter;
      tgWorld.botUserId = "BOT";
      if (options) (tgWorld.channelConfig as any).options = { status_emojis: options };
      const internals = fm as unknown as Internals;
      internals.classicChannels = { isCollab: () => site.collab } as any;
      internals.saveClassicAttachment = vi.fn(async () => ({ path: "/i/f", paths: ["/i/f"], kind }));
      internals.forwardToClassicInstance = vi.fn(async () => {});
      await internals.handleClassicChannelMessage("classic-room", {
        source: "telegram", adapterId: "tg", chatId: "-100", threadId: "7", messageId: "m-1", userId: "u", username: "han",
        text: site.text, timestamp: new Date(), attachments: [{ kind, fileId: "f1", filename: "x" }],
      });
      return react.mock.calls.map(c => c[2] as string);
    };
    const photoDefault = await go("photo");
    const fileDefault = await go("document");
    expect(photoDefault).toContain("👌");
    expect(fileDefault).toContain("👍");
    expect(await go("photo", { photo: "🔥" })).toContain("🔥");
    expect(await go("document", { attachment: "🎉" })).toContain("🎉");
    const bad = await go("photo", { photo: "📸" });            // not a Telegram reaction → ignored, built-in used
    expect(bad).toContain("👌");
    expect(bad).not.toContain("📸");
  });
});


describe("ClassicBot instances can see emojis; only setting a stamp is refused (beta.11 report)", () => {
  it("list_emojis: server emojis and standard emojis, with the connection's statuses and a Settings note", async () => {
    const { fm } = fleet();
    const r = await fm.listEmojisFor("classic-room");
    expect(r).not.toHaveProperty("error");
    expect(r.platform).toBe("discord");
    expect(r.standard).toMatchObject({ note: "any single emoji works" });
    const servers = r.server_emojis as Array<{ server: string; emojis?: Array<{ value: string }> }>;
    expect(servers.flatMap(g => g.emojis ?? []).map(e => e.value)).toEqual(
      expect.arrayContaining(["<:fox:111111111111111111>", "<a:owl:222222222222222222>"]));
    // No per-instance layer: nothing comes from an instance config.
    expect((r.statuses as Array<{ source: string }>).every(e => e.source !== "instance")).toBe(true);
    expect(r.note).toEqual(expect.stringContaining("Settings"));
  });

  it("preview_emojis: works with a value from that list", async () => {
    const { fm, dir } = fleet();
    const fetchMock = cdn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await fm.previewEmojis("classic-room", { emojis: ["<:fox:111111111111111111>"] });
    expect(r.errors).toEqual([]);
    expect(r.previews).toEqual([{ emoji: "<:fox:111111111111111111>", path: join(dir, "inbox", "emoji-previews", "111111111111111111.png") }]);
    vi.unstubAllGlobals();
  });

  it("set_persona_emoji is still refused for ClassicBot, pointing at Settings", async () => {
    const { fm } = fleet();
    expect(await fm.setPersonaEmoji("classic-room", { emoji: "🦊" })).toEqual({
      error: "ClassicBot instances have no per-instance status emojis; an operator sets the connection's in Settings",
    });
  });

  it("an unknown instance is still refused by list and preview", async () => {
    const { fm } = fleet();
    expect(await fm.listEmojisFor("nobody")).toEqual({ error: "Instance 'nobody' not found" });
    expect(await fm.previewEmojis("nobody", { emojis: ["<:fox:111111111111111111>"] })).toEqual({ error: "Instance 'nobody' not found" });
  });

  it("a fleet-topic instance is unchanged: its own override still shows as source instance, no ClassicBot note", async () => {
    const { fm } = fleet();
    const r = await fm.listEmojisFor("worker");
    expect((r.statuses as Array<{ status: string; source: string }>).find(e => e.status === "failed")).toMatchObject({ source: "instance" });
    expect(r).not.toHaveProperty("note");
  });
});


describe("inherited names are not instances (#1083 review)", () => {
  it("constructor, __proto__, toString: all three tools refuse, with no REST or CDN call", async () => {
    const get = vi.fn(async (route: string) => EMOJIS[route] ?? []);
    const { fm } = fleet(get);
    const fetchMock = cdn();
    vi.stubGlobal("fetch", fetchMock);
    for (const name of ["constructor", "__proto__", "toString"]) {
      const missing = { error: `Instance '${name}' not found` };
      expect(await fm.listEmojisFor(name), name).toEqual(missing);
      expect(await fm.previewEmojis(name, { emojis: ["<:fox:111111111111111111>"] }), name).toEqual(missing);
      expect(await fm.setPersonaEmoji(name, { emoji: "🦊" }), name).toEqual(missing);
    }
    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
