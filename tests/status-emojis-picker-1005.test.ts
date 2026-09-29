/**
 * #1005 phase 3.2: the Settings status-emoji picker and preview.
 *
 * The page never resolves an emoji itself. It asks the server, which runs the
 * reaction path's own code, so what is picked is stored in the form the bot
 * reacts with, and what the preview shows is what gets stamped. The tests
 * drive the real routes, the real FleetManager cache and Discord adapter call,
 * and the page's own editor code on a minimal DOM.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { FleetManager } from "../src/fleet-manager.js";
import { AdapterWorld } from "../src/adapter-world.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { previewStatusEmojis, TELEGRAM_REACTION_EMOJIS } from "../src/status-emojis.js";
import type { ChannelAdapter } from "../src/channel/types.js";
import type { ChannelConfig } from "../src/types.js";

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
    expect(r.body.keys).toEqual(["received", "queued", "processing", "delivered", "failed", "progress_prefix"]);
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

// ── The page's editor, on a minimal DOM ─────────────────────────────────────

const html = readFileSync(new URL("../src/ui/settings.html", import.meta.url), "utf8");

class FakeEl {
  children: Array<FakeEl | string> = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<() => void>> = {};
  parent: FakeEl | null = null;
  className = ""; value = ""; style: Record<string, string> = {};
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); if (k === "value") this.value = String(v); }
  getAttribute(k: string) { return this.attrs[k]; }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
  append(...kids: Array<FakeEl | string>) { for (const k of kids) { if (k instanceof FakeEl) k.parent = this; this.children.push(k); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  set innerHTML(_v: string) { this.children = []; }
  get textContent(): string { return this.children.map(c => typeof c === "string" ? c : c.textContent).join(""); }
  set textContent(v: string) { this.children = [String(v)]; }
  fire(type: string) { for (const fn of this.listeners[type] ?? []) fn(); }
  all(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) if (c instanceof FakeEl) { if (pred(c)) out.push(c); out.push(...c.all(pred)); }
    return out;
  }
  querySelector(sel: string) { const cls = sel.replace(/^\./, ""); return this.all(e => e.className.split(" ").includes(cls))[0] ?? null; }
}

function loadEditor(api: (path: string, opts?: { body?: string }) => Promise<{ ok: boolean; status: number; body: any }>) {
  const elLine = html.split("\n").find(l => l.includes("const el = (tag, attrs = {}, ...kids) =>"))!;
  const start = html.indexOf("  // ── Status emojis (#1005) ──");
  const end = html.indexOf("  /**\n   * One modal edits one object");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const sandbox: Record<string, unknown> = {
    document: { createElement: (tag: string) => new FakeEl(tag) },
    api, t: (k: string) => k, setTimeout, clearTimeout,
  };
  vm.runInNewContext(`${elLine}\n${html.slice(start, end)}\nthis.statusEmojiEditor = statusEmojiEditor;`, sandbox);
  return sandbox.statusEmojiEditor as (own: unknown, scope: unknown) => { box: FakeEl; value(): unknown; baseline(): unknown; refresh(): void };
}

/** The page's api() pointed at the real routes, so the editor talks to the server code. */
function realApi(ctx: SettingsApiContext) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const api = async (path: string, opts: { method?: string; body?: string } = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ path, body });
    const r = await request(path, ctx, opts.method ?? "GET", body);
    return { ok: r.status < 400, status: r.status, body: r.body };
  };
  return { api, calls };
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 170)); };
const buttons = (root: FakeEl, text: string) => root.all(e => e.tag === "button" && e.textContent === text);

describe("the Settings editor: picked == previewed == reacted (#1005 addendum 3)", () => {
  it("picking a server emoji stores <a:name:id>, previews its CDN image, and the bot reacts with name:id", async () => {
    const ctx = context({ listGuildEmojis: async () => ({ ok: true, fetched_at: 1, emojis: [{ id: "333333333333333333", name: "done", animated: true, available: true }] }) });
    const { api, calls } = realApi(ctx);
    const statusEmojiEditor = loadEditor(api);
    const editor = statusEmojiEditor(undefined, {
      platform: () => "discord", channelId: () => "dc",
      previewBody: (map: unknown) => ({ channel_id: "dc", instance_config: map }),
    });
    await settle();
    expect(editor.value()).toBeNull();
    const deliveredRow = editor.box.all(e => e.className === "se-row").find(r => r.textContent.startsWith("se_delivered"))!;
    buttons(deliveredRow, "se_pick")[0]!.fire("click");
    await settle();
    const serverButton = deliveredRow.all(e => e.tag === "button" && e.attrs.title === ":done:")[0]!;
    const img = serverButton.all(e => e.tag === "img")[0]!;
    expect(img.attrs).toMatchObject({ src: "https://cdn.discordapp.com/emojis/333333333333333333.gif", referrerpolicy: "no-referrer" });
    serverButton.fire("click");
    await settle();

    expect(editor.value()).toEqual({ delivered: "<a:done:333333333333333333>" });
    const lastPreview = calls.filter(c => c.path === "/api/settings/status-emojis/preview").at(-1)!;
    expect(lastPreview.body).toEqual({ channel_id: "dc", instance_config: { delivered: "<a:done:333333333333333333>" } });
    const previewImgs = editor.box.querySelector("se-preview")!.all(e => e.tag === "img").map(e => e.attrs.src);
    expect(previewImgs).toContain("https://cdn.discordapp.com/emojis/333333333333333333.gif");

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
    const preview = await request("/api/settings/status-emojis/preview", ctx, "POST", lastPreview.body);
    const applied = preview.body.entries.find((e: any) => e.key === "delivered").applied;
    expect(react).toHaveBeenCalledWith("t", "m", applied, "t");
    expect(applied).toBe("done:333333333333333333");
  });

  it("shows an unavailable server emoji but will not pick it", async () => {
    // Discord marks an emoji unavailable when the server loses the Boost tier
    // it needs; a bot cannot react with it, so storing it would fail silently.
    const ctx = context({ listGuildEmojis: async () => ({ ok: true, fetched_at: 1, emojis: [
      { id: "444444444444444444", name: "old", animated: false, available: false },
      { id: "333333333333333333", name: "done", animated: true, available: true },
    ] }) });
    const { api } = realApi(ctx);
    const editor = loadEditor(api)({ delivered: "✅" }, {
      platform: () => "discord", channelId: () => "dc",
      previewBody: (map: unknown) => ({ channel_id: "dc", instance_config: map }),
    });
    await settle();
    const row = editor.box.all(e => e.className === "se-row").find(r => r.textContent.startsWith("se_delivered"))!;
    buttons(row, "se_pick")[0]!.fire("click");
    await settle();
    const unavailable = row.all(e => e.tag === "button" && e.attrs.title === ":old: (se_unavailable)")[0]!;
    expect(unavailable.attrs.disabled).toBe("disabled");
    unavailable.fire("click");
    await settle();
    expect(editor.value()).toEqual({ delivered: "✅" });
    expect(row.querySelector("se-picker")).not.toBeNull(); // still open: nothing was chosen
    // The available one next to it still picks.
    row.all(e => e.tag === "button" && e.attrs.title === ":done:")[0]!.fire("click");
    expect(editor.value()).toEqual({ delivered: "<a:done:333333333333333333>" });
  });

  it("offers only Telegram's reaction set on a Telegram connection, and blanks mean the default", async () => {
    const { api } = realApi(context());
    const statusEmojiEditor = loadEditor(api);
    const editor = statusEmojiEditor({ failed: "👎" }, {
      platform: () => "telegram", channelId: () => "tg",
      previewBody: (map: unknown) => ({ channel_id: "tg", platform: "telegram", channel_config: map }),
    });
    await settle();
    expect(editor.value()).toEqual({ failed: "👎" });
    expect(editor.baseline()).toEqual(editor.value());
    const row = editor.box.all(e => e.className === "se-row").find(r => r.textContent.startsWith("se_delivered"))!;
    buttons(row, "se_pick")[0]!.fire("click");
    await settle();
    const offered = row.querySelector("se-grid")!.all(e => e.tag === "button").map(b => b.textContent);
    expect(offered).toEqual([...TELEGRAM_REACTION_EMOJIS]);
    expect(offered).not.toContain("✅");
    expect(row.all(e => e.textContent === "se_serverEmojis")).toEqual([]);
    const failedRow = editor.box.all(e => e.className === "se-row").find(r => r.textContent.startsWith("se_failed"))!;
    buttons(failedRow, "×")[0]!.fire("click");
    expect(editor.value()).toBeNull();
  });

  it("shows the server's reason when a value cannot be used", async () => {
    const { api } = realApi(context());
    const statusEmojiEditor = loadEditor(api);
    const editor = statusEmojiEditor({ delivered: "👀✅" }, {
      platform: () => "discord", channelId: () => "dc",
      previewBody: (map: unknown) => ({ channel_id: "dc", instance_config: map }),
    });
    await settle();
    const problems = editor.box.all(e => e.className.startsWith("feedback"))[0]!;
    expect(problems.className).toBe("feedback error");
    expect(problems.textContent).toContain("se_delivered");
    expect(problems.textContent).toContain("not an emoji");
  });
});

describe("the connection editor stages its status emojis into PUT /fleet/channels (#1005)", () => {
  function loadBotForm(api: (path: string, opts?: any) => Promise<any>, chs: any[]) {
    const elLine = html.split("\n").find(l => l.includes("const el = (tag, attrs = {}, ...kids) =>"))!;
    const editorStart = html.indexOf("  // ── Status emojis (#1005) ──");
    const editorEnd = html.indexOf("  /**\n   * One modal edits one object");
    const formStart = html.indexOf("  function botEditForm(ch, i) {");
    const formEnd = html.indexOf("  // ── ClassicBot Channels ──");
    const staged: Array<{ key: string; change: any }> = [];
    const sandbox: Record<string, unknown> = {
      document: { createElement: (tag: string) => new FakeEl(tag) },
      api, t: (k: string) => k, setTimeout, clearTimeout, structuredClone,
      state: { schema: { order: ["now", "instance", "fleet"] } },
      channels: () => chs, chLabel: () => "primary",
      sameValue: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
      select: (v: string) => { const s = new FakeEl("select"); s.value = v; return s; },
      chipList: () => new FakeEl("div"), drawer: (...kids: FakeEl[]) => { const d = new FakeEl("details"); d.append(...kids.slice(1)); return d; },
      impact: () => new FakeEl("span"), impactOf: (f: string) => f === "fleet.channels" || f.startsWith("fleet.channel") ? "fleet" : "instance",
      setValidation: () => true, confirmAccessChange: () => true, closeModal: () => {}, delBot: () => {},
      stageChange: (key: string, change: unknown) => staged.push({ key, change }),
    };
    vm.runInNewContext(`${elLine}\n${html.slice(editorStart, editorEnd)}\n${html.slice(formStart, formEnd)}\nthis.botEditForm = botEditForm;`, sandbox);
    return { botEditForm: sandbox.botEditForm as (ch: any, i: number) => { box: FakeEl; stage(): boolean }, staged };
  }

  it("an emoji-only edit stages a channel write that carries the map and keeps the other options", async () => {
    const chs = [structuredClone({ ...DISCORD, options: { general_channel_id: "gen-1", status_emojis: { received: "<:inbox:111111111111111111>" } } })];
    const { api } = realApi(context());
    const puts: unknown[] = [];
    const recordingApi = async (path: string, opts: any = {}) => {
      if (path === "/api/settings/fleet/channels") { puts.push(JSON.parse(opts.body)); return { ok: true, status: 200, body: { ok: true } }; }
      return api(path, opts);
    };
    const { botEditForm, staged } = loadBotForm(recordingApi, chs);
    const form = botEditForm(chs[0], 0);
    await settle();
    // Unchanged → nothing staged.
    expect(form.stage()).toBe(true);
    expect(staged).toEqual([]);
    const row = form.box.all(e => e.className === "se-row").find(r => r.textContent.startsWith("se_delivered"))!;
    const input = row.all(e => e.tag === "input")[0]!;
    input.value = "🦊"; input.fire("input");
    expect(form.stage()).toBe(true);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.change.impact).toBe("fleet");
    expect(staged[0]!.change.confirm()).toBe(true);
    await staged[0]!.change.apply();
    expect(puts).toEqual([[expect.objectContaining({
      id: "dc", access: DISCORD.access,
      options: { general_channel_id: "gen-1", status_emojis: { received: "<:inbox:111111111111111111>", delivered: "🦊" } },
    })]]);
  });
});

describe("the agent editor stages its status emojis into the instance PATCH (#1005)", () => {
  it("writes the override map, then null when every key is blanked", async () => {
    const elLine = html.split("\n").find(l => l.includes("const el = (tag, attrs = {}, ...kids) =>"))!;
    const slice = (from: string, to: string) => { const a = html.indexOf(from), b = html.indexOf(to, a); expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a); return html.slice(a, b); };
    const staged: Array<{ key: string; change: any }> = [];
    const { api } = realApi(context());
    const inst: Record<string, unknown> = { working_directory: "/w", channel_id: "dc", status_emojis: { failed: "🦊" } };
    const sandbox: Record<string, unknown> = {
      document: { createElement: (tag: string) => new FakeEl(tag) },
      api, t: (k: string) => k, tf: (k: string) => k, setTimeout, clearTimeout,
      state: { fleet: { defaults: {}, instances: { worker: inst }, channels: [DISCORD] }, schema: { order: ["now", "instance", "fleet"] } },
      BACKENDS: ["claude-code"], channelIds: () => ["dc"], chById: () => DISCORD,
      select: (v: string) => { const s = new FakeEl("select"); s.value = v; return s; },
      chipList: () => new FakeEl("div"), drawer: (...kids: FakeEl[]) => { const d = new FakeEl("details"); d.append(...kids.slice(1)); return d; },
      impact: () => new FakeEl("span"), impactOf: () => "instance", batchImpact: () => "instance",
      setValidation: () => true, shortName: (n: string) => n, renderAgents: () => {}, AGENT_MODAL_FIELDS: [],
      stageChange: (key: string, change: unknown) => staged.push({ key, change }),
    };
    vm.runInNewContext([
      elLine,
      slice("  // ── Status emojis (#1005) ──", "  /**\n   * One modal edits one object"),
      slice("  const hasOwn = ", "  function setValidation("),
      slice("  function agentEditForm(name, inst) {", "  /** Every field the agent modal shows"),
      "this.agentEditForm = agentEditForm;",
    ].join("\n"), sandbox);
    const agentEditForm = sandbox.agentEditForm as (name: string, inst: unknown) => { box: FakeEl; stage(): boolean };

    const edit = async (mutate: (rows: FakeEl[]) => void) => {
      const form = agentEditForm("worker", inst);
      await settle();
      mutate(form.box.all(e => e.className === "se-row"));
      expect(form.stage()).toBe(true);
      return staged.at(-1)!.change;
    };
    const row = (rows: FakeEl[], key: string) => rows.find(r => r.textContent.startsWith(`se_${key}`))!;

    const first = await edit(rows => { const i = row(rows, "delivered").all(e => e.tag === "input")[0]!; i.value = "<:done:333333333333333333>"; i.fire("input"); });
    const puts: unknown[] = [];
    (sandbox as any).api = async (path: string, opts: any = {}) => {
      if (!path.startsWith("/api/settings/fleet/instances/")) return api(path, opts); // previews still resolve
      puts.push({ path, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, body: {} };
    };
    // apply() closes over the module-level api binding the sandbox exposes.
    await first.apply();
    expect(puts).toEqual([{ path: "/api/settings/fleet/instances/worker", body: { status_emojis: { delivered: "<:done:333333333333333333>", failed: "🦊" } } }]);

    const second = await edit(rows => buttons(row(rows, "failed"), "×")[0]!.fire("click"));
    await second.apply();
    expect((puts.at(-1) as any).body).toEqual({ status_emojis: null });
  });
});

// A user reported "after I picked two, the 👀 that was on Received moved to Processing". It did not
// move: 👀 is the built-in for received, processing AND progress_prefix, so it was already under
// Processing before any pick. These pin what is actually true — every value is bound to its status
// *name*, a pick changes only that name, and what is left shows (and stores) its own value.
describe("the Settings editor binds by status name, never by position", () => {
  const KEYS = ["received", "queued", "processing", "delivered", "failed", "progress_prefix"] as const;
  const BUILTIN: Record<string, string> = { received: "👀", queued: "⏳", processing: "👀", delivered: "✅", failed: "❌", progress_prefix: "👀" };
  const PICKS = ["🦊", "🍎", "🐱", "🐶", "🐼", "🦉"];

  // The preview is debounced 150ms; one wait past that is enough here.
  const quick = () => new Promise(r => setTimeout(r, 260));
  async function open() {
    const { api, calls } = realApi(context());
    const editor = loadEditor(api)(undefined, {
      platform: () => "discord", channelId: () => "dc",
      // The connection editor's shape: the map being edited *is* the channel's, so the stored one is not layered under it.
      previewBody: (map: unknown) => ({ channel_id: "dc", platform: "discord", channel_config: map }),
    });
    await quick();
    const row = (key: string) => editor.box.all(e => e.className === "se-row").find(r => r.textContent.startsWith(`se_${key}`))!;
    const input = (key: string) => row(key).all(e => e.tag === "input")[0]!;
    const pick = async (key: string, emoji: string) => {
      buttons(row(key), "se_pick")[0]!.fire("click");
      await quick();
      row(key).all(e => e.tag === "button" && e.attrs.title === emoji)[0]!.fire("click");
      await quick();
    };
    const shown = () => Object.fromEntries(editor.box.querySelector("se-preview")!.all(e => e.className.split(" ").includes("se-item"))
      .map(e => String(e.attrs.title).split(": ") as [string, string]));
    return { editor, calls, input, pick, shown };
  }

  it("the user's case: pick Received then Queued — Processing keeps its own built-in, and only two keys are stored", async () => {
    const { editor, calls, input, pick, shown } = await open();
    expect(shown()).toEqual(BUILTIN);                     // before anything is picked, 👀 is already under Processing

    await pick("received", "🦊");
    await pick("queued", "🍎");

    expect(shown()).toEqual({ ...BUILTIN, received: "🦊", queued: "🍎" });
    expect(editor.value()).toEqual({ received: "🦊", queued: "🍎" });
    const last = calls.filter(c => c.path === "/api/settings/status-emojis/preview").at(-1)!;
    expect(last.body).toEqual({ channel_id: "dc", platform: "discord", channel_config: { received: "🦊", queued: "🍎" } });
    expect(Object.keys(last.body.channel_config)).toEqual(["received", "queued"]);
    // Each box holds what belongs to it; an untouched one is empty, its default only a placeholder.
    for (const key of KEYS) expect(input(key).value, key).toBe({ received: "🦊", queued: "🍎" }[key as string] ?? "");
    for (const key of ["processing", "delivered", "failed", "progress_prefix"]) expect(input(key).attrs.placeholder, key).toBe(BUILTIN[key]);
  });

  it("says where each preview value comes from — the built-in ones too, so a default 👀 is not mistaken for a moved one", async () => {
    const { pick, editor } = await open();
    const sourceOf = () => Object.fromEntries(editor.box.querySelector("se-preview")!.all(e => e.className.split(" ").includes("se-item"))
      .map(e => [String(e.attrs.title).split(": ")[0]!, e.all(x => x.className.split(" ").includes("tag"))[0]?.textContent ?? "(none)"]));
    expect(sourceOf()).toEqual({ received: "se_src_builtin", queued: "se_src_builtin", processing: "se_src_builtin", delivered: "se_src_builtin", failed: "se_src_builtin", progress_prefix: "se_src_builtin" });

    await pick("received", "🦊");
    await pick("queued", "🍎");

    expect(sourceOf()).toEqual({ received: "se_src_platform", queued: "se_src_platform", processing: "se_src_builtin", delivered: "se_src_builtin", failed: "se_src_builtin", progress_prefix: "se_src_builtin" });
    const html = readFileSync(join(process.cwd(), "src", "ui", "settings.html"), "utf8");
    expect(html).toContain("se_src_builtin: \"default\"");
    expect(html).toContain("se_src_builtin: \"預設\"");
  });

  it("every pair of picks — alternating which is picked first — lands on its own keys and leaves the other four alone", async () => {
    let n = 0;
    for (let a = 0; a < KEYS.length; a++) {
      for (let b = a + 1; b < KEYS.length; b++) {
        const [first, second] = n++ % 2 === 0 ? [a, b] : [b, a];
        const { editor, input, pick, shown } = await open();
        await pick(KEYS[first]!, PICKS[first]!);
        await pick(KEYS[second]!, PICKS[second]!);

        const expected = { ...BUILTIN, [KEYS[a]!]: PICKS[a]!, [KEYS[b]!]: PICKS[b]! };
        const label = `${KEYS[first]} then ${KEYS[second]}`;
        expect(shown(), label).toEqual(expected);
        expect(editor.value(), label).toEqual(Object.fromEntries(KEYS.filter(k => k === KEYS[a] || k === KEYS[b]).map(k => [k, expected[k]])));
        for (const k of KEYS) expect(input(k).value, `${k} after ${label}`).toBe(k === KEYS[a] || k === KEYS[b] ? expected[k] : "");
      }
    }
    expect(n).toBe(15);
  }, 120_000);

  it("clearing one picks its default back without moving another", async () => {
    const { editor, input, pick, shown } = await open();
    await pick("queued", "🍎");
    await pick("failed", "🐱");
    buttons(editor.box.all(e => e.className === "se-row").find(r => r.textContent.startsWith("se_queued"))!, "×")[0]!.fire("click");
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
      received: "platform", queued: "platform", processing: "builtin", delivered: "builtin", failed: "builtin", progress_prefix: "builtin",
    });
  });
});
