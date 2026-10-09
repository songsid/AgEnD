/**
 * #1005 phase 3.2: the Settings status-emoji picker and preview.
 *
 * The page never resolves an emoji itself. It asks the server, which runs the reaction path's own code, so what is
 * picked is stored in the form the bot reacts with, and what the preview shows is what gets stamped. The tests drive
 * the real routes and the real FleetManager cache and Discord adapter call. The page's own code is rendered in the
 * mini DOM (#1408 step 3: StatusEmojiEditor, the connection and agent editors in the panel), and its requests go to
 * those real routes.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { FleetManager } from "../src/fleet-manager.js";
import { AdapterWorld } from "../src/adapter-world.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { previewStatusEmojis, TELEGRAM_REACTION_EMOJIS } from "../src/status-emojis.js";
import type { ChannelAdapter } from "../src/channel/types.js";
import type { ChannelConfig } from "../src/types.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-1005-picker-")); dirs.push(d); return d; };

function request(path: string, ctx: SettingsApiContext, method = "GET", body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
    req.method = method;
    req.destroy = () => undefined;
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, setHeader() {}, end(payload: string) { resolve({ status, body: JSON.parse(payload) }); } };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${path}`), ctx)).toBe(true);
      if (body !== undefined) queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    } catch (err) { reject(err); }
  });
}

const DISCORD: ChannelConfig = {
  id: "dc", type: "discord", mode: "topic", bot_token_env: "FAKE", group_id: "guild-1",
  access: { mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 0 },
  options: { status_emojis: { received: "<:inbox:111111111111111111>" } },
};
const TELEGRAM: ChannelConfig = { ...DISCORD, id: "tg", type: "telegram", options: {} };

function context(extra: Partial<SettingsApiContext> = {}) {
  return {
    fleetConfig: { channels: [DISCORD, TELEGRAM], defaults: {}, instances: { worker: { working_directory: "/w", channel_id: "dc" } } },
    configPath: "/tmp/fleet.yaml", dataDir: "/tmp",
    logger: { warn: vi.fn(), info: vi.fn() },
    getRawFleetConfig: () => ({}), saveFleetConfig: vi.fn(),
    ...extra,
  } as unknown as SettingsApiContext;
}

describe("status-emoji catalog and preview routes (#1005 phase 3.2)", () => {
  it("serves the keys, both platforms' built-ins and Telegram's whole reaction set", async () => {
    const r = await request("/api/settings/status-emojis", context());
    expect(r.status).toBe(200);
    expect(r.body.keys).toEqual(["received", "queued", "processing", "delivered", "failed", "progress_prefix", "photo", "attachment"]);
    expect(r.body.builtins.discord).toMatchObject({ photo: "📸", attachment: "📎" });
    expect(r.body.builtins.telegram).toMatchObject({ photo: "👌", attachment: "👍" });
    expect(r.body.builtins.telegram.failed).toBe("👎");
    expect(r.body.builtins.discord.delivered).toBe("✅");
    expect(r.body.telegram_allowed).toEqual([...TELEGRAM_REACTION_EMOJIS]);
  });

  it("previews an instance override on top of its connection's map, with where each came from", async () => {
    const r = await request("/api/settings/status-emojis/preview", context(), "POST", {
      channel_id: "dc", instance_config: { delivered: "<a:done:222222222222222222>", failed: "👀✅" },
    });
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.entries.map((e: any) => [e.key, e]));
    expect(by.received).toMatchObject({ source: "platform", applied: "inbox:111111111111111111", display: ":inbox:", image_url: "https://cdn.discordapp.com/emojis/111111111111111111.png" });
    expect(by.delivered).toMatchObject({ source: "instance", applied: "done:222222222222222222", image_url: "https://cdn.discordapp.com/emojis/222222222222222222.gif" });
    expect(by.failed).toMatchObject({ source: "builtin", value: "❌", image_url: null });
    expect(r.body.problems).toEqual([expect.objectContaining({ source: "instance", key: "failed", value: "👀✅" })]);
    expect(r.body.avoid).toEqual([":inbox:", "⏳", "👀", ":done:", "❌"]);
  });

  it("previews a Telegram map against Telegram's rules", async () => {
    const r = await request("/api/settings/status-emojis/preview", context(), "POST", {
      channel_id: "tg", platform: "telegram", channel_config: { delivered: "✅", failed: "❤️" },
    });
    const by = Object.fromEntries(r.body.entries.map((e: any) => [e.key, e]));
    expect(by.delivered).toMatchObject({ source: "builtin", value: "👀" });
    expect(by.failed).toMatchObject({ source: "platform", applied: "❤" });
    expect(r.body.problems.map((p: any) => p.key)).toEqual(["delivered"]);
  });
});

describe("guild emoji listing (#1005 phase 3.2)", () => {
  function fleetWithDiscord(get: (route: string) => Promise<unknown>) {
    const dir = tmp();
    const fleet = new FleetManager(dir);
    const adapter = new DiscordAdapter({
      id: "dc", botToken: "fake-token", accessManager: new AccessManager(DISCORD.access, join(dir, "a.json")),
      inboxDir: dir, guildId: "guild-1", registerCommands: false,
    });
    vi.spyOn(adapter as any, "readyClient").mockResolvedValue({ rest: { get } });
    fleet.worlds.set("dc", new AdapterWorld("dc", adapter, new AccessManager(DISCORD.access, join(dir, "b.json")), DISCORD));
    const tgAdapter = { id: "tg", type: "telegram" } as unknown as ChannelAdapter;
    fleet.worlds.set("tg", new AdapterWorld("tg", tgAdapter, new AccessManager(TELEGRAM.access, join(dir, "c.json")), TELEGRAM));
    return { fleet, adapter };
  }

  it("asks Discord for the bound server's emojis once, caches them, and refetches on refresh", async () => {
    const get = vi.fn(async () => [
      { id: "333333333333333333", name: "done", animated: true, available: true, roles: [], user: { id: "x" } },
      { id: "444444444444444444", name: "old", animated: false, available: false },
    ]);
    const { fleet, adapter } = fleetWithDiscord(get);
    try {
      const [a, b] = await Promise.all([fleet.listGuildEmojis("dc"), fleet.listGuildEmojis("dc")]);
      expect(get).toHaveBeenCalledTimes(1); // concurrent callers share one fetch
      expect(get).toHaveBeenCalledWith("/guilds/guild-1/emojis");
      expect(a).toEqual(b);
      expect(a).toMatchObject({ ok: true, emojis: [
        { id: "333333333333333333", name: "done", animated: true, available: true },
        { id: "444444444444444444", name: "old", animated: false, available: false },
      ] });
      expect((a as any).emojis[0]).not.toHaveProperty("user");
      await fleet.listGuildEmojis("dc");
      expect(get).toHaveBeenCalledTimes(1);
      await fleet.listGuildEmojis("dc", true);
      expect(get).toHaveBeenCalledTimes(2);
      expect(await fleet.listGuildEmojis("tg")).toEqual({ ok: false, error: "only Discord has server custom emoji" });
      expect(await fleet.listGuildEmojis("nope")).toMatchObject({ ok: false });
    } finally {
      await adapter.stop();
    }
  });

  it("serves them in the stored config form with a CDN image, and says why when it cannot", async () => {
    const listGuildEmojis = vi.fn(async (_c: string, refresh?: boolean) => refresh
      ? { ok: false as const, error: "Missing Access" }
      : { ok: true as const, fetched_at: 1, emojis: [{ id: "333333333333333333", name: "done", animated: true, available: true }] });
    const ctx = context({ listGuildEmojis });
    const ok = await request("/api/settings/status-emojis/guild-emojis?channel=dc", ctx);
    expect(ok.status).toBe(200);
    expect(ok.body.emojis).toEqual([{ id: "333333333333333333", name: "done", animated: true, available: true,
      value: "<a:done:333333333333333333>", image_url: "https://cdn.discordapp.com/emojis/333333333333333333.gif" }]);
    const refused = await request("/api/settings/status-emojis/guild-emojis?channel=dc&refresh=1", ctx);
    expect(listGuildEmojis).toHaveBeenLastCalledWith("dc", true);
    expect(refused).toEqual({ status: 409, body: { error: "Missing Access" } });
    expect((await request("/api/settings/status-emojis/guild-emojis", ctx)).status).toBe(400);
  });
});

describe("saving status_emojis from Settings (#1005 phase 3.2)", () => {
  it("writes the map on an instance and removes it on null", async () => {
    const ctx = context();
    const set = await request("/api/settings/fleet/instances/worker", ctx, "PATCH", { status_emojis: { delivered: "<a:done:333333333333333333>" } });
    expect(set.status).toBe(200);
    expect(ctx.fleetConfig!.instances.worker!.status_emojis).toEqual({ delivered: "<a:done:333333333333333333>" });
    const cleared = await request("/api/settings/fleet/instances/worker", ctx, "PATCH", { status_emojis: null });
    expect(cleared.status).toBe(200);
    expect(ctx.fleetConfig!.instances.worker).not.toHaveProperty("status_emojis");
    expect(ctx.saveFleetConfig).toHaveBeenLastCalledWith([{ path: ["instances", "worker", "status_emojis"], value: null, remove: true }]);
  });
});


// ── The page's editors, rendered in the mini DOM ──────────────────────────────

const quick = () => new Promise(r => setTimeout(r, 260));      // the preview waits 150ms before it asks
/** Wait until `cond` holds (a server answer arrives over the fake fetch); the test fails if it never does. */
const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise(r => setTimeout(r, 20));
};
const schema = buildSettingsImpactSchema();
let p: AppPage;
let mods: { SettingsPanel: any; StatusEmojiEditor: any };
/** The server the page's status-emoji requests reach (the real routes). */
let server: SettingsApiContext;
/** What the panel reads for its own sections. */
let world: { fleet: any; instances: unknown[] };
let calls: Array<{ method: string; path: string; body?: any }> = [];
const realFetch = (globalThis as any).fetch;

async function pageFetch(path: string, init: { method?: string; body?: string } = {}) {
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, path, body });
  if (path.startsWith("/api/settings/status-emojis")) {
    const r = await request(path, server, method, body);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  }
  if (method !== "GET") return { ok: true, status: 200, json: async () => (method === "POST" ? { id: "job-1", status: "done", targets: [] } : { ok: true }) };
  const reply: unknown = ({
    "/api/settings/schema": schema,
    "/api/settings/fleet/raw": world.fleet,
    "/api/settings/classic": { channels: {}, defaults: {} },
    "/api/settings/connections": [],
    "/api/settings/provider-secrets": [],
    "/api/fleet": { version: "2.1.12", instances: world.instances },
  } as Record<string, unknown>)[path] ?? [];
  return { ok: true, status: 200, json: async () => reply };
}

function uiHooks() {
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19280/settings" });
    (globalThis as any).fetch = pageFetch;
    mods = {
      SettingsPanel: (await import("/ui/js/panel-settings.js")).SettingsPanel,
      StatusEmojiEditor: (await import("/ui/js/settings-dialogs.js")).StatusEmojiEditor,
    };
  });
  afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
  beforeEach(() => {
    calls = []; world = { fleet: { defaults: {}, instances: {}, channels: [] }, instances: [] };
    (globalThis as any).confirm = () => true;
    p.window.confirm = () => true;
  });
  afterEach(async () => {
    await p.unmount();
    const { resetOperation } = await import("/ui/js/settings-apply.js");
    const { resetConfirmations } = await import("/ui/js/settings-confirm.js");
    resetOperation(); resetConfirmations();
  });
}

/** The editor on its own, with the page's props; `changes` is what it reported (value, baseline) so far. */
async function mountEditor(props: { own?: unknown; platform: string; channel: string; previewBody: (map: unknown) => unknown }) {
  const changes: Array<{ value: any; baseline: any }> = [];
  await p.unmount();
  await p.mount(h(mods.StatusEmojiEditor, { ...props, onChange: (c: any) => changes.push(c) }));
  await quick();
  return { value: () => changes.at(-1)?.value ?? null, baseline: () => changes.at(-1)?.baseline ?? null };
}
const input = (key: string) => p.root.querySelector(`#se-${key}`)!;
const row = (key: string) => input(key).closest(".se-row")!;
const byText = (label: string, root: any = p.root) => { const found = root.querySelectorAll("button").filter((b: any) => b.textContent.trim() === label); expect(found.length, `button ${label}`).toBeGreaterThan(0); return found[0]; };
const byAria = (label: string, root: any) => root.querySelectorAll("button").find((b: any) => b.getAttribute("aria-label") === label);
const click = async (el: any) => { fire(el, "click"); await settle(); };
const type = async (el: any, value: string) => { el.value = value; fire(el, "input"); await settle(); };
const pick = async (key: string, emoji: string) => {
  await click(byText("Pick…", row(key)));
  await quick();
  await click(row(key).querySelectorAll("button").find((b: any) => b.getAttribute("title") === emoji));
  await quick();
};
const shownEntries = () => p.root.querySelectorAll(".se-preview .se-item");
const shown = () => Object.fromEntries(shownEntries().map((e: any) => String(e.getAttribute("title")).split(": ") as [string, string]));
const sourceOf = () => Object.fromEntries(shownEntries().map((e: any) => [String(e.getAttribute("title")).split(": ")[0]!, e.querySelector(".tag")?.textContent ?? "(none)"]));
const previews = () => calls.filter(c => c.path === "/api/settings/status-emojis/preview");
const writes = () => calls.filter(c => c.method !== "GET");

/** The panel: a section, with its one connection or agent's dialog opened. */
async function mountSection(section: "agents" | "bots") {
  await p.unmount();
  await p.mount(h(mods.SettingsPanel, { route: { panel: "settings", section }, navKey: `settings:${section}` }));
  await settle(12);
}

describe("the Settings editor: picked == previewed == reacted (#1005 addendum 3)", () => {
  uiHooks();

  it("picking a server emoji stores <a:name:id>, previews its CDN image, and the bot reacts with name:id", async () => {
    server = context({ listGuildEmojis: async () => ({ ok: true, fetched_at: 1, emojis: [{ id: "333333333333333333", name: "done", animated: true, available: true }] }) });
    const editor = await mountEditor({ platform: "discord", channel: "dc-picked",
      previewBody: (map: unknown) => ({ channel_id: "dc", instance_config: map }) });
    expect(editor.value()).toBeNull();
    await click(byText("Pick…", row("delivered")));
    await quick();
    const serverButton = row("delivered").querySelectorAll("button").find((b: any) => b.getAttribute("title") === ":done:")!;
    const img = serverButton.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://cdn.discordapp.com/emojis/333333333333333333.gif");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    await click(serverButton);
    await quick();

    expect(editor.value()).toEqual({ delivered: "<a:done:333333333333333333>" });
    const lastPreview = previews().at(-1)!;
    expect(lastPreview.body).toEqual({ channel_id: "dc", instance_config: { delivered: "<a:done:333333333333333333>" } });
    expect(p.root.querySelectorAll(".se-preview img").map((i: any) => i.getAttribute("src"))).toContain("https://cdn.discordapp.com/emojis/333333333333333333.gif");

    // Store what was picked, then react through the real status path.
    const dir = tmp();
    const fleet = new FleetManager(dir);
    const react = vi.fn(async () => {});
    const adapter = { id: "dc", type: "discord", react, unreact: vi.fn(async () => {}) } as unknown as ChannelAdapter;
    (fleet as any).fleetConfig = { channels: [DISCORD], defaults: {}, instances: { worker: { channel_id: "dc", status_emojis: editor.value() } } };
    (fleet as any).adapter = adapter;
    fleet.worlds.set("dc", new AdapterWorld("dc", adapter, new AccessManager(DISCORD.access, join(dir, "a.json")), DISCORD));
    fleet.finishDeliveryStatus("worker", "guild-1", "m", "delivered", "t");
    await settle();
    const preview = await request("/api/settings/status-emojis/preview", server, "POST", lastPreview.body);
    const applied = preview.body.entries.find((e: any) => e.key === "delivered").applied;
    expect(react).toHaveBeenCalledWith("t", "m", applied, "t");
    expect(applied).toBe("done:333333333333333333");
  });

  it("shows an unavailable server emoji but will not pick it", async () => {
    // Discord marks an emoji unavailable when the server loses the Boost tier
    // it needs; a bot cannot react with it, so storing it would fail silently.
    server = context({ listGuildEmojis: async () => ({ ok: true, fetched_at: 1, emojis: [
      { id: "444444444444444444", name: "old", animated: false, available: false },
      { id: "333333333333333333", name: "done", animated: true, available: true },
    ] }) });
    const editor = await mountEditor({ own: { delivered: "✅" }, platform: "discord", channel: "dc-unavailable",
      previewBody: (map: unknown) => ({ channel_id: "dc", instance_config: map }) });
    await click(byText("Pick…", row("delivered")));
    await quick();
    const unavailable = row("delivered").querySelectorAll("button").find((b: any) => b.getAttribute("title") === ":old: (unavailable)")!;
    expect(unavailable.hasAttribute("disabled")).toBe(true);
    await click(unavailable);
    await quick();
    expect(editor.value()).toEqual({ delivered: "✅" });
    expect(row("delivered").querySelector(".se-picker")).not.toBeNull();     // still open: nothing was chosen
    // The available one next to it still picks.
    await click(row("delivered").querySelectorAll("button").find((b: any) => b.getAttribute("title") === ":done:"));
    await quick();
    expect(editor.value()).toEqual({ delivered: "<a:done:333333333333333333>" });
  });

  it("offers only Telegram's reaction set on a Telegram connection, and blanks mean the default", async () => {
    server = context();
    const editor = await mountEditor({ own: { failed: "👎" }, platform: "telegram", channel: "tg",
      previewBody: (map: unknown) => ({ channel_id: "tg", platform: "telegram", channel_config: map }) });
    expect(editor.value()).toEqual({ failed: "👎" });
    expect(editor.baseline()).toEqual(editor.value());
    await click(byText("Pick…", row("delivered")));
    await quick();
    const offered = row("delivered").querySelector(".se-grid")!.querySelectorAll("button").map((b: any) => b.textContent);
    expect(offered).toEqual([...TELEGRAM_REACTION_EMOJIS]);
    expect(offered).not.toContain("✅");
    expect(row("delivered").textContent).not.toContain("Server emojis");
    await click(byAria("Use the default", row("failed")));
    expect(editor.value()).toBeNull();
  });

  it("shows the server's reason when a value cannot be used", async () => {
    server = context();
    await mountEditor({ own: { delivered: "👀✅" }, platform: "discord", channel: "dc-reason",
      previewBody: (map: unknown) => ({ channel_id: "dc", instance_config: map }) });
    const problem = p.root.querySelectorAll(".feedback.error").find((f: any) => f.textContent.includes("Delivered"))!;
    expect(problem.getAttribute("class")).toBe("feedback error");
    expect(problem.textContent).toContain("not an emoji");
    expect(problem.textContent).toContain("the default is used instead");
  });
});

describe("the connection editor stages its status emojis into PUT /fleet/channels (#1005)", () => {
  uiHooks();

  it("an emoji-only edit stages a channel write that carries the map and keeps the other options", async () => {
    const channel = { id: "dc", type: "discord", mode: "topic", bot_token_env: "FAKE", group_id: "guild-1", access: DISCORD.access,
      options: { general_channel_id: "gen-1", status_emojis: { received: "<:inbox:111111111111111111>" } } };
    world.fleet = { defaults: {}, instances: {}, channels: [channel] };
    server = context();
    await mountSection("bots");
    await click(byText("Settings"));
    // Unchanged → nothing staged.
    await click(byText("Stage change"));
    expect(p.root.querySelector("[role=region]")).toBeNull();
    await mountSection("bots");
    await click(byText("Settings"));
    await type(input("delivered"), "🦊");
    await click(byText("Stage change"));
    const bar = p.root.querySelector("[role=region]")!;
    expect(bar.textContent).toContain("Restart AgEnD");
    calls = [];
    await click(byText("Apply changes", bar));
    const put = writes().find(c => c.path === "/api/settings/fleet/channels")!;
    expect(put.method).toBe("PUT");
    expect(put.body).toEqual([expect.objectContaining({
      id: "dc", access: DISCORD.access,
      options: { general_channel_id: "gen-1", status_emojis: { received: "<:inbox:111111111111111111>", delivered: "🦊" } },
    })]);
  });
});

describe("the agent editor stages its status emojis into the instance PATCH (#1005)", () => {
  uiHooks();

  it("writes the override map, then null when every key is blanked", async () => {
    world.fleet = { defaults: {}, channels: [DISCORD], instances: { worker: { working_directory: "/w", channel_id: "dc", status_emojis: { failed: "🦊" } } } };
    world.instances = [{ name: "worker", status: "running" }];
    server = context();
    await mountSection("agents");
    await click(byText("Settings"));
    await type(input("delivered"), "<:done:333333333333333333>");
    await click(byText("Stage change"));
    calls = [];
    await click(byText("Apply changes", p.root.querySelector("[role=region]")));
    expect(writes().find(c => c.path === "/api/settings/fleet/instances/worker")).toEqual({
      method: "PATCH", path: "/api/settings/fleet/instances/worker",
      body: { status_emojis: { delivered: "<:done:333333333333333333>", failed: "🦊" } },
    });

    await mountSection("agents");
    await click(byText("Settings"));
    await click(byAria("Use the default", row("failed")));
    await click(byText("Stage change"));
    calls = [];
    await click(byText("Apply changes", p.root.querySelector("[role=region]")));
    expect(writes().find(c => c.path === "/api/settings/fleet/instances/worker")!.body).toEqual({ status_emojis: null });
  });
});

describe("the Settings editor binds by status name, never by position", () => {
  uiHooks();
  const KEYS = ["received", "queued", "processing", "delivered", "failed", "progress_prefix", "photo", "attachment"] as const;
  const BUILTIN: Record<string, string> = { received: "👀", queued: "⏳", processing: "👀", delivered: "✅", failed: "❌", progress_prefix: "👀", photo: "📸", attachment: "📎" };
  const PICKS = ["🦊", "🍎", "🐱", "🐶", "🐼", "🦉", "🐙", "🌟"];

  // The editor under test: the connection editor's shape (the map being edited *is* the channel's).
  async function open() {
    server = context();
    const editor = await mountEditor({ platform: "discord", channel: "dc-binds",
      previewBody: (map: unknown) => ({ channel_id: "dc", platform: "discord", channel_config: map }) });
    return { editor, input, pick, shown };
  }

  it("the user's case: pick Received then Queued — Processing keeps its own built-in, and only two keys are stored", async () => {
    const { editor } = await open();
    expect(shown()).toEqual(BUILTIN);                     // before anything is picked, 👀 is already under Processing

    await pick("received", "🦊");
    await pick("queued", "🍎");

    expect(shown()).toEqual({ ...BUILTIN, received: "🦊", queued: "🍎" });
    expect(editor.value()).toEqual({ received: "🦊", queued: "🍎" });
    const sent = previews().at(-1)!.body as { channel_config: Record<string, string> };
    expect(sent).toEqual({ channel_id: "dc", platform: "discord", channel_config: { received: "🦊", queued: "🍎" } });
    expect(Object.keys(sent.channel_config)).toEqual(["received", "queued"]);
    // Each box holds what belongs to it; an untouched one is empty, its default only a placeholder.
    for (const key of KEYS) expect(input(key).value, key).toBe({ received: "🦊", queued: "🍎" }[key as string] ?? "");
    for (const key of ["processing", "delivered", "failed", "progress_prefix"]) expect(input(key).getAttribute("placeholder"), key).toBe(BUILTIN[key]);
  });

  it("says where each preview value comes from — the built-in ones too, so a default 👀 is not mistaken for a moved one", async () => {
    await open();
    expect(sourceOf()).toEqual({ received: "default", queued: "default", processing: "default", delivered: "default", failed: "default", progress_prefix: "default", photo: "default", attachment: "default" });

    await pick("received", "🦊");
    await pick("queued", "🍎");

    expect(sourceOf()).toEqual({ received: "connection", queued: "connection", processing: "default", delivered: "default", failed: "default", progress_prefix: "default", photo: "default", attachment: "default" });
  });

  it("every pair of picks — alternating which is picked first — lands on its own keys and leaves the other four alone", async () => {
    let n = 0;
    for (let a = 0; a < KEYS.length; a++) {
      for (let b = a + 1; b < KEYS.length; b++) {
        const [first, second] = n++ % 2 === 0 ? [a, b] : [b, a];
        const { editor } = await open();
        await pick(KEYS[first]!, PICKS[first]!);
        await pick(KEYS[second]!, PICKS[second]!);

        const expected = { ...BUILTIN, [KEYS[a]!]: PICKS[a]!, [KEYS[b]!]: PICKS[b]! };
        const label = `${KEYS[first]} then ${KEYS[second]}`;
        expect(shown(), label).toEqual(expected);
        expect(editor.value(), label).toEqual(Object.fromEntries(KEYS.filter(k => k === KEYS[a] || k === KEYS[b]).map(k => [k, expected[k]])));
        for (const k of KEYS) expect(input(k).value, `${k} after ${label}`).toBe(k === KEYS[a] || k === KEYS[b] ? expected[k] : "");
      }
    }
    expect(n).toBe(28);   // C(8,2) pairs
  }, 120_000);

  it("clearing one picks its default back without moving another", async () => {
    const { editor } = await open();
    await pick("queued", "🍎");
    await pick("failed", "🐱");
    await click(byAria("Use the default", row("queued")));
    await quick();
    expect(editor.value()).toEqual({ failed: "🐱" });
    expect(shown()).toEqual({ ...BUILTIN, failed: "🐱" });
    expect(input("queued").value).toBe("");
    expect(input("failed").value).toBe("🐱");
  });

  it("the server resolves a subset per key too: the layers of a map never shift each other", () => {
    const entries = previewStatusEmojis({ platform: "discord", platformConfig: { received: "🦊", queued: "🍎" } }).entries;
    expect(Object.fromEntries(entries.map(e => [e.key, e.value]))).toEqual({ ...BUILTIN, received: "🦊", queued: "🍎" });
    expect(Object.fromEntries(entries.map(e => [e.key, e.source]))).toEqual({
      received: "platform", queued: "platform", processing: "builtin", delivered: "builtin", failed: "builtin", progress_prefix: "builtin", photo: "builtin", attachment: "builtin",
    });
  });
});

describe("the picker lists each server the bot is in that ClassicBot admits (#1021)", () => {
  const EMOJIS: Record<string, unknown[]> = {
    "/guilds/guild-1/emojis": [{ id: "111111111111111111", name: "home", animated: false, available: true }],
    "/guilds/guild-2/emojis": [{ id: "222222222222222222", name: "away", animated: true, available: true }],
    "/guilds/guild-3/emojis": [{ id: "333333333333333333", name: "blocked", animated: false, available: true }],
  };
  /** A running Discord connection whose bot is in three servers; `allowed` is ClassicBot's allowed_guilds. */
  function fleetInThreeServers(allowed: string[] | undefined, get = vi.fn(async (route: string) => EMOJIS[route] ?? [])) {
    const dir = tmp();
    if (allowed) writeFileSync(join(dir, "classicBot.yaml"), `defaults:\n  allowed_guilds: [${allowed.map(g => `"${g}"`).join(", ")}]\n`);
    const fleet = new FleetManager(dir);
    fleet.classicChannels = new ClassicChannelManager(dir, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any);
    const adapter = new DiscordAdapter({
      id: "dc", botToken: "fake-token", accessManager: new AccessManager(DISCORD.access, join(dir, "a.json")),
      inboxDir: dir, guildId: "guild-1", registerCommands: false,
    });
    // Gateway cache order is not primary-first; the listing must be.
    const cache = new Map([["guild-3", { id: "guild-3", name: "Elsewhere" }], ["guild-2", { id: "guild-2", name: "Classic HQ" }], ["guild-1", { id: "guild-1", name: "Main" }]]);
    vi.spyOn(adapter as any, "readyClient").mockResolvedValue({ rest: { get }, guilds: { cache } });
    fleet.worlds.set("dc", new AdapterWorld("dc", adapter, new AccessManager(DISCORD.access, join(dir, "b.json")), DISCORD));
    return { fleet, adapter, get };
  }

  it("primary first, then allowed_guilds servers; a server the whitelist excludes is not listed or fetched", async () => {
    const { fleet, adapter, get } = fleetInThreeServers(["guild-2"]);
    try {
      const r = await fleet.listGuildEmojis("dc");
      expect(r).toMatchObject({ ok: true, guilds: [
        { id: "guild-1", name: "Main", primary: true, emojis: EMOJIS["/guilds/guild-1/emojis"] },
        { id: "guild-2", name: "Classic HQ", primary: false, emojis: EMOJIS["/guilds/guild-2/emojis"] },
      ] });
      expect((r as any).guilds).toHaveLength(2);
      expect((r as any).emojis.map((e: any) => e.name)).toEqual(["home", "away"]);
      expect(get.mock.calls.map(c => c[0]).sort()).toEqual(["/guilds/guild-1/emojis", "/guilds/guild-2/emojis"]);
    } finally { await adapter.stop(); }
  });

  it("an unset allowed_guilds retains the metadata inventory, not start permission (#1418)", async () => {
    const { fleet, adapter } = fleetInThreeServers(undefined);
    try {
      const r = await fleet.listGuildEmojis("dc");
      expect((r as any).guilds.map((g: any) => g.id)).toEqual(["guild-1", "guild-3", "guild-2"]);
    } finally { await adapter.stop(); }
  });

  it("the primary server is listed even when the whitelist leaves it out", async () => {
    const { fleet, adapter } = fleetInThreeServers(["guild-3"]);
    try {
      expect(((await fleet.listGuildEmojis("dc")) as any).guilds.map((g: any) => g.id)).toEqual(["guild-1", "guild-3"]);
    } finally { await adapter.stop(); }
  });

  it("caches per server, refresh refetches each, and one server refusing does not hide the others", async () => {
    const get = vi.fn(async (route: string) => {
      if (route === "/guilds/guild-2/emojis") throw new Error("Missing Access");
      return EMOJIS[route] ?? [];
    });
    const { fleet, adapter } = fleetInThreeServers(["guild-2"], get);
    try {
      const r = await fleet.listGuildEmojis("dc");
      expect(r).toMatchObject({ ok: true, guilds: [
        { id: "guild-1", emojis: EMOJIS["/guilds/guild-1/emojis"] },
        { id: "guild-2", error: "Discord refused the emoji list: Missing Access" },
      ] });
      expect((r as any).guilds[1]).not.toHaveProperty("emojis");
      expect(get).toHaveBeenCalledTimes(2);
      await fleet.listGuildEmojis("dc");
      // guild-1 is cached; the refusal is not, so guild-2 is asked again.
      expect(get.mock.calls.map(c => c[0])).toEqual(["/guilds/guild-1/emojis", "/guilds/guild-2/emojis", "/guilds/guild-2/emojis"]);
      await fleet.listGuildEmojis("dc", true);
      expect(get).toHaveBeenCalledTimes(5);
    } finally { await adapter.stop(); }
  });

  it("fails as a whole only when no server could be read", async () => {
    const get = vi.fn(async () => { throw new Error("Missing Access"); });
    const { fleet, adapter } = fleetInThreeServers(["guild-2"], get);
    try {
      expect(await fleet.listGuildEmojis("dc")).toEqual({ ok: false, error: "Discord refused the emoji list: Missing Access" });
    } finally { await adapter.stop(); }
  });

  it("the route serves each server's emojis in the stored form, and a refused server with its reason", async () => {
    const ctx = context({ listGuildEmojis: async () => ({ ok: true as const, fetched_at: 1,
      emojis: [{ id: "111111111111111111", name: "home", animated: false, available: true }],
      guilds: [
        { id: "guild-1", name: "Main", primary: true, fetched_at: 1, emojis: [{ id: "111111111111111111", name: "home", animated: false, available: true }] },
        { id: "guild-2", name: "Classic HQ", primary: false, error: "Discord refused the emoji list: Missing Access" },
      ] }) });
    const r = await request("/api/settings/status-emojis/guild-emojis?channel=dc", ctx);
    expect(r.status).toBe(200);
    expect(r.body.guilds).toEqual([
      { id: "guild-1", name: "Main", primary: true, emojis: [{ id: "111111111111111111", name: "home", animated: false, available: true,
        value: "<:home:111111111111111111>", image_url: "https://cdn.discordapp.com/emojis/111111111111111111.png" }] },
      { id: "guild-2", name: "Classic HQ", primary: false, error: "Discord refused the emoji list: Missing Access" },
    ]);
  });

  describe("the editor groups the servers, as rendered (#1021)", () => {
    uiHooks();

    it("the editor groups by server; an emoji picked from another server is stored and previewed in the form the bot reacts with", async () => {
      const { fleet, adapter } = fleetInThreeServers(["guild-2"]);
      try {
        server = context({ listGuildEmojis: (c: string, refresh?: boolean) => fleet.listGuildEmojis(c, refresh) });
        const editor = await mountEditor({ platform: "discord", channel: "dc",
          previewBody: (map: unknown) => ({ channel_id: "dc", instance_config: map }) });
        await click(byText("Pick…", row("delivered")));
        await until(() => row("delivered").querySelectorAll("button").some((b: any) => b.getAttribute("title") === ":away:"));
        const headings = row("delivered").querySelectorAll(".se-guild").map((e: any) => e.textContent);
        expect(headings).toEqual(["Main primary", "Classic HQ"]);
        const hints = row("delivered").querySelectorAll("p.note").filter((e: any) => e.textContent.startsWith("Another server's emoji"));
        expect(hints).toHaveLength(1);
        const away = row("delivered").querySelectorAll("button").find((b: any) => b.getAttribute("title") === ":away:")!;
        expect(away.querySelector("img")!.getAttribute("src")).toBe("https://cdn.discordapp.com/emojis/222222222222222222.gif");
        await click(away);
        await quick();
        expect(editor.value()).toEqual({ delivered: "<a:away:222222222222222222>" });
        const preview = await request("/api/settings/status-emojis/preview", server, "POST", { channel_id: "dc", instance_config: editor.value() });
        expect(preview.body.entries.find((e: any) => e.key === "delivered")).toMatchObject({ applied: "away:222222222222222222", source: "instance" });
      } finally { await adapter.stop(); }
    });

    it("a single server keeps the plain grid, with no server headings", async () => {
      const { fleet, adapter } = fleetInThreeServers(["guild-9"]);
      try {
        server = context({ listGuildEmojis: (c: string, refresh?: boolean) => fleet.listGuildEmojis(c, refresh) });
        await mountEditor({ platform: "discord", channel: "dc",
          previewBody: (map: unknown) => ({ channel_id: "dc", instance_config: map }) });
        await click(byText("Pick…", row("delivered")));
        // The page keeps each channel's server list for its life (the first test asked already): refresh it to ask again.
        await click(byAria("Refresh", row("delivered")));
        await until(() => calls.some(c => c.path.includes("refresh=1")));
        await quick();
        expect(row("delivered").querySelectorAll(".se-guild")).toEqual([]);
        expect(row("delivered").querySelectorAll("p.note").filter((e: any) => e.textContent.startsWith("Another server's emoji"))).toEqual([]);
        expect(row("delivered").querySelectorAll("button").filter((b: any) => b.getAttribute("title") === ":home:")).toHaveLength(1);
      } finally { await adapter.stop(); }
    });
  });
});
