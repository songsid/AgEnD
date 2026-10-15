/**
 * #1630 (design: the comment on #1630), through the real FleetManager: the status frame's `avatar` / `accent` (the
 * fallback order, #1867's speaking bot after an own bot, the ring only on an own bot's face), the same-origin image routes
 * (only a bot some instance speaks through, a known instance's upload, an emoji of the fleet's servers), session-gated, passive, and on the public link's
 * read-only allowlist. Fake adapters and a stubbed fetch for Discord's CDN — no platform is called; nothing forks.
 */
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn(() => { throw new Error("must not fork"); }), execFileSync: vi.fn(() => { throw new Error("must not fork"); }),
  spawn: vi.fn(() => { throw new Error("must not fork"); }), spawnSync: vi.fn(() => { throw new Error("must not fork"); }),
}));

const { FleetManager } = await import("../src/fleet-manager.js");
const { handleWebRequest } = await import("../src/web-api.js");
const { isPassiveWebRead } = await import("../src/web-auth.js");
const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
const { handleViewRequest } = await import("../src/view-api.js");

const TOKEN = "t".repeat(48);
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const PNG = (n: number) => ({ bytes: Buffer.alloc(12, n), ext: "png" as const });

/** A fleet: discord (primary, shared by a and b), discord-2 (solo's own bot), telegram-2 (shared by p1 and p2). */
function fleet(opts: { soloAvatar?: () => Promise<{ bytes: Buffer; ext: "png" } | null>; sharedAvatar?: null; accent?: string | null; persona?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-1630-fm-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  fm.fleetConfig = {
    defaults: { backend: "claude-code" },
    channels: [{ id: "discord", type: "discord" }, { id: "discord-2", type: "discord" }, { id: "telegram-2", type: "telegram" }],
    instances: {
      a: { working_directory: dir, display_name: "Alpha", ...(opts.persona?.a ? { status_emojis: { delivered: opts.persona.a } } : {}) },
      b: { working_directory: dir },
      solo: { working_directory: dir, channel_id: "discord-2", topic_id: "555" },
      p1: { working_directory: dir, channel_id: "telegram-2" }, p2: { working_directory: dir, channel_id: "telegram-2" },
    },
  };
  const calls = { avatar: 0, accent: [] as Array<string | undefined>, primaryAvatar: 0 };
  const shared = (n: number) => async () => { calls.primaryAvatar++; return opts.sharedAvatar === null ? null : PNG(n); };
  fm.adapters.set("discord", { getBotUserId: () => "100000000000000001", fetchBotAvatar: shared(1), botAccentColor: async () => { calls.accent.push("shared"); return "#ff0000"; } });
  fm.adapters.set("discord-2", {
    getBotUserId: () => "111111111111111111",
    fetchBotAvatar: async () => { calls.avatar++; return opts.soloAvatar ? opts.soloAvatar() : PNG(2); },
    botAccentColor: async (channel?: string) => { calls.accent.push(channel); return opts.accent === undefined ? "#E91E63" : opts.accent; },
  });
  fm.adapters.set("telegram-2", { getBotUserId: () => "300000000", fetchBotAvatar: shared(3) });
  fm.classicChannels = { getAll: () => [], getChannelIdByInstance: () => undefined, getBackendByInstance: () => "claude-code", getModel: () => undefined, getAdapterIdByInstance: () => undefined, getDefaults: () => ({}), isGuildAllowed: () => true };
  vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
  const frame = () => Object.fromEntries((fm.getUiStatus() as { instances: Array<{ name: string; avatar: unknown; accent?: string }> }).instances.map(i => [i.name, { avatar: i.avatar, accent: i.accent }]));
  return { dir, fm, calls, frame };
}
function uploadProfile(dir: string, name: string, file: string, bytes: Buffer) {
  mkdirSync(join(dir, "avatars"), { recursive: true });
  writeFileSync(join(dir, "avatars", file), bytes);
  const db = new Database(join(dir, "profiles.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS instance_profile (instance_name TEXT PRIMARY KEY, display_name TEXT, avatar_path TEXT, role TEXT, description TEXT, updated_at INTEGER);`);
  db.prepare("INSERT INTO instance_profile (instance_name, avatar_path, updated_at) VALUES (?, ?, 0)").run(name, file);
  db.close();
}
/** GET through the real route, with the fleet's real methods behind it. */
function get(fm: any, path: string, opts: { token?: boolean } = {}) {
  return new Promise<{ status: number; type?: string; body: Buffer; headers: Record<string, unknown> }>(resolve => {
    let status = 0; const headers: Record<string, unknown> = {};
    const res: any = { headersSent: false, destroyed: false, setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
      writeHead(code: number, h?: Record<string, unknown>) { status = code; res.headersSent = true; for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = v; },
      end(b?: string | Buffer) { resolve({ status, type: headers["content-type"] as string | undefined, body: Buffer.from(b ?? ""), headers }); } } as unknown as ServerResponse;
    const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: opts.token === false ? {} : { "x-agend-token": TOKEN }, destroy() {}, resume() {} }) as unknown as IncomingMessage;
    const ctx = { webToken: TOKEN, sseClients: new Set(), fleetConfig: fm.fleetConfig, logger: { info() {}, debug() {}, warn() {}, error() {} }, getUiStatus: () => ({}),
      webImage: (k: "bot" | "avatar", key: string) => fm.webImage(k, key), webEmoji: (id: string) => fm.webEmoji(id), webEmojiList: () => fm.webEmojiList() };
    expect(handleWebRequest(req, res, new URL(`http://127.0.0.1:19280${path}`), ctx as never)).toBe(true);
  });
}

describe("the status frame: what stands for each instance", () => {
  it("nothing cached yet: the fallbacks at once, the own bot's avatar fetched behind — then its picture, versioned", async () => {
    const f = fleet();
    const first = f.frame();
    expect(first.solo).toEqual({ avatar: { kind: "initial", text: "S" }, accent: undefined });
    await flush();
    const second = f.frame();
    expect(second.solo!.avatar).toEqual({ kind: "image", src: expect.stringMatching(/^\/ui\/img\/bot\/discord-2\?v=[0-9a-z]+$/) });
    expect(f.calls.avatar).toBe(1);
  });
  it("#1867: an instance without its own bot shows the bot it speaks through — the primary, or one it shares — with no ring", async () => {
    const f = fleet();
    f.frame(); await flush(); f.frame(); await flush();
    const frame = f.frame();
    const bot = (c: string) => ({ avatar: { kind: "image", src: expect.stringMatching(new RegExp(`^/ui/img/bot/${c}\\?v=[0-9a-z]+$`)) }, accent: undefined });
    expect([frame.a, frame.b, frame.p1, frame.p2]).toEqual([bot("discord"), bot("discord"), bot("telegram-2"), bot("telegram-2")]);
    expect(f.calls.primaryAvatar, "one fetch per shared bot, whoever is on it").toBe(2);
    expect(f.calls.accent, "a shared bot's colour is never read").toEqual(["555"]);
  });
  it("#1867: the own bot still wins over the bot everyone shares", async () => {
    const f = fleet();
    f.frame(); await flush();
    expect(f.frame().solo!.avatar).toEqual({ kind: "image", src: expect.stringMatching(/^\/ui\/img\/bot\/discord-2\?v=/) });
  });
  it("#1867: a web-only instance (no connection configured for it) gets the primary's face", async () => {
    const f = fleet();
    f.fm.fleetConfig.instances.web = { working_directory: f.dir, channel_id: "gone" };
    f.frame(); await flush();
    expect(f.frame().web!.avatar).toEqual({ kind: "image", src: expect.stringMatching(/^\/ui\/img\/bot\/discord\?v=/) });
  });
  it("#1867: a ClassicBot room shows its room's bot, the same rule", async () => {
    const f = fleet();
    Object.assign(f.fm.classicChannels, { getAll: () => [{ instanceName: "room" }], getChannelIdByInstance: (n: string) => (n === "room" ? "777" : undefined),
      getAdapterIdByInstance: (n: string) => (n === "room" ? "telegram-2" : undefined) });
    f.frame(); await flush();
    expect(f.frame().room).toEqual({ avatar: { kind: "image", src: expect.stringMatching(/^\/ui\/img\/bot\/telegram-2\?v=/) }, accent: undefined });
  });
  it("#1867: a shared bot with no avatar set falls through — to the persona emoji, then the first character", async () => {
    const f = fleet({ sharedAvatar: null, persona: { a: "🦊" } });
    f.frame(); await flush();
    const frame = f.frame();
    expect([frame.a!.avatar, frame.b!.avatar, frame.p1!.avatar]).toEqual([{ kind: "emoji", text: "🦊" }, { kind: "initial", text: "B" }, { kind: "initial", text: "P" }]);
    expect(f.calls.primaryAvatar).toBe(2);
  });
  it("a bot with no avatar set falls through (to the persona emoji or the first character)", async () => {
    const f = fleet({ soloAvatar: async () => null });
    f.frame(); await flush();
    expect(f.frame().solo).toEqual({ avatar: { kind: "initial", text: "S" }, accent: undefined });
  });
  it("a failed fetch falls back too, and keeps a picture it already had", async () => {
    const fail = fleet({ soloAvatar: async () => { throw new Error("HTTP 500"); } });
    fail.frame(); await flush();
    expect(fail.frame().solo!.avatar).toEqual({ kind: "initial", text: "S" });
  });
  it("the persona emoji (status_emojis.delivered), then the display name's first character", () => {
    const f = fleet({ persona: { a: "🦊" } });
    expect(f.frame().a!.avatar).toEqual({ kind: "emoji", text: "🦊" });
    const g = fleet({ persona: { a: "<:blob:123456789012345678>" } });
    expect(g.frame().a!.avatar).toEqual({ kind: "emoji", src: "/ui/img/emoji/123456789012345678", alt: ":blob:" });
  });
  it("the picture uploaded in View comes first, before even the own bot or the shared one", async () => {
    const f = fleet();
    uploadProfile(f.dir, "solo", "solo.png", Buffer.alloc(9, 4));
    uploadProfile(f.dir, "a", "a.png", Buffer.alloc(9, 5));
    f.frame(); await flush();
    const frame = f.frame();
    expect(frame.solo).toEqual({ avatar: { kind: "image", src: expect.stringMatching(/^\/ui\/img\/avatar\/solo\?v=/) }, accent: undefined });
    expect(frame.a).toEqual({ avatar: { kind: "image", src: expect.stringMatching(/^\/ui\/img\/avatar\/a\?v=/) }, accent: undefined });
  });
  it("the ring: the bot's colour in the instance's own channel, only on the bot's own face; none when Discord has none", async () => {
    const f = fleet();
    f.frame(); await flush(); f.frame(); await flush();
    const frame = f.frame();
    expect([frame.solo!.accent, frame.a!.accent, frame.b!.accent]).toEqual(["#e91e63", undefined, undefined]);
    expect(f.calls.accent).toEqual(["555"]);
    const none = fleet({ accent: null });
    none.frame(); await flush(); none.frame(); await flush();
    expect(none.frame().solo!.accent).toBeUndefined();
  });
  it("an avatar is decorative: whatever fails deciding it, the frame is still served (every instance its first character)", () => {
    const f = fleet();
    vi.spyOn(f.fm, "webBots").mockImplementation(() => { throw new Error("broken connection table"); });
    vi.spyOn(f.fm, "webIdentityImage").mockImplementation(() => { throw new Error("broken avatar"); });
    let frame: Record<string, { avatar: unknown }> | string;
    try { frame = f.frame(); } catch (err) { frame = `the frame failed: ${(err as Error).message}`; }
    expect(typeof frame === "string" ? frame : Object.values(frame).map(i => i.avatar)).toEqual(["A", "B", "S", "P", "P"].map(text => ({ kind: "initial", text })));
  });
  it("every image in the frame is a same-origin /ui/img URL", async () => {
    const f = fleet({ sharedAvatar: null, persona: { a: "<:blob:123456789012345678>" } });
    uploadProfile(f.dir, "b", "b.webp", Buffer.alloc(9, 4));
    f.frame(); await flush();
    const srcs = Object.values(f.frame()).map(i => (i.avatar as { src?: string }).src).filter(Boolean);
    expect(srcs.length).toBe(3);
    for (const src of srcs) expect(src).toMatch(/^\/ui\/img\/(bot|avatar|emoji)\//);
  });
});

// ── #1630 follow-ups (hxhsandy, 2026-10-14): a primary kept for General alone; removing an uploaded picture ──

describe("a primary that serves one instance is that instance's own bot (#1630 follow-up)", () => {
  const generalOnly = (f: ReturnType<typeof fleet>) => {
    f.fm.fleetConfig.instances = { general: { working_directory: f.dir, topic_id: "1" }, solo: { working_directory: f.dir, channel_id: "discord-2", topic_id: "555" } };
  };
  it("General alone on the primary: the primary's face and its colour as the ring, like any own bot", async () => {
    const f = fleet();
    generalOnly(f);
    f.frame(); await flush(); f.frame(); await flush();
    const frame = f.frame();
    expect(frame.general).toEqual({ avatar: { kind: "image", src: expect.stringMatching(/^\/ui\/img\/bot\/discord\?v=/) }, accent: "#ff0000" });
    expect(frame.solo!.accent).toBe("#e91e63");
    expect((await get(f.fm, "/ui/img/bot/discord")).status).toBe(200);
  });
  it("a primary several instances use is nobody's own: its face through the speaking bot, no ring, its colour never read", async () => {
    const f = fleet();                                                // a and b share the primary
    f.frame(); await flush(); f.frame(); await flush();
    const frame = f.frame();
    expect([frame.a!.accent, frame.b!.accent, (frame.a!.avatar as { src?: string }).src]).toEqual([undefined, undefined, expect.stringMatching(/^\/ui\/img\/bot\/discord\?v=/)]);
    expect(f.calls.accent).toEqual(["555"]);
  });
  it("a ClassicBot room on the primary makes it shared again: General loses the ring", async () => {
    const f = fleet();
    generalOnly(f);
    Object.assign(f.fm.classicChannels, { getAll: () => [{ instanceName: "room" }], getChannelIdByInstance: (n: string) => (n === "room" ? "777" : undefined) });
    f.frame(); await flush(); f.frame(); await flush();
    const frame = f.frame();
    expect([frame.general!.accent, frame.room!.accent]).toEqual([undefined, undefined]);
    expect((frame.general!.avatar as { src?: string }).src).toMatch(/^\/ui\/img\/bot\/discord\?v=/);
  });
});

describe("removing an uploaded picture (DELETE /api/avatar/:instance, #1630 follow-up)", () => {
  const del = (f: ReturnType<typeof fleet>, name: string) => new Promise<{ status: number; body: string }>(resolve => {
    let status = 0;
    const res: any = { headersSent: false, setHeader() {}, writeHead(c: number) { status = c; res.headersSent = true; return res; }, end(b?: string) { resolve({ status, body: String(b ?? "") }); } };
    const req = Object.assign(new EventEmitter(), { method: "DELETE", url: `/api/avatar/${name}`, headers: { "x-agend-token": TOKEN }, destroy() {}, resume() {} });
    const ctx = { webToken: TOKEN, dataDir: f.dir, fleetConfig: f.fm.fleetConfig, classicChannels: null, logger: { debug() {}, info() {}, warn() {}, error() {} },
      getInstanceStatus: () => "running", getUiStatus: () => ({ instances: [] }) };
    expect(handleViewRequest(req as never, res, new URL(`http://127.0.0.1${req.url}`), ctx as never)).toBe(true);
  });
  const avatarPath = (dir: string, name: string) => {
    const db = new Database(join(dir, "profiles.db"));
    try { return (db.prepare("SELECT avatar_path FROM instance_profile WHERE instance_name = ?").get(name) as { avatar_path: string | null }).avatar_path; } finally { db.close(); }
  };
  it("clears the row and deletes the file; the avatar falls through — own bot (with its ring), speaking bot, emoji", async () => {
    const f = fleet({ persona: { a: "🦊" } });
    f.fm.fleetConfig.instances.p1.status_emojis = { delivered: "🐙" };
    for (const n of ["solo", "a", "p1"]) uploadProfile(f.dir, n, `${n}.png`, Buffer.alloc(9, 4));
    f.fm.adapters.get("telegram-2").fetchBotAvatar = async () => null;   // p1's speaking bot has no avatar
    f.frame(); await flush(); f.frame(); await flush();
    expect(Object.values(f.frame()).filter(i => /\/ui\/img\/avatar\//.test((i.avatar as { src?: string }).src ?? "")).length).toBe(3);
    for (const n of ["solo", "a", "p1"]) {
      const r = await del(f, n);
      expect([r.status, JSON.parse(r.body)], n).toEqual([200, { ok: true, removed: true }]);
      expect([avatarPath(f.dir, n), existsSync(join(f.dir, "avatars", `${n}.png`))], n).toEqual([null, false]);
      expect((await get(f.fm, `/ui/img/avatar/${n}`)).status, n).toBe(404);
    }
    f.frame(); await flush();
    const frame = f.frame();
    expect(frame.solo).toEqual({ avatar: { kind: "image", src: expect.stringMatching(/^\/ui\/img\/bot\/discord-2\?v=/) }, accent: "#e91e63" });
    expect(frame.a).toEqual({ avatar: { kind: "image", src: expect.stringMatching(/^\/ui\/img\/bot\/discord\?v=/) }, accent: undefined });
    expect(frame.p1).toEqual({ avatar: { kind: "emoji", text: "🐙" }, accent: undefined });
  });
  it("an upload replaces only this instance's own files — never a.b's when a uploads (names may hold a dot)", async () => {
    const f = fleet();
    f.fm.fleetConfig.instances["a.b"] = { working_directory: f.dir };
    const post = (name: string, type: string, bytes: Buffer) => new Promise<number>(resolve => {
      let status = 0;
      const res: any = { headersSent: false, setHeader() {}, writeHead(c: number) { status = c; res.headersSent = true; return res; }, end() { resolve(status); } };
      const req = Object.assign(Readable.from([bytes]), { method: "POST", url: `/api/avatar/${name}`, headers: { "x-agend-token": TOKEN, "content-type": type } });
      const ctx = { webToken: TOKEN, dataDir: f.dir, fleetConfig: f.fm.fleetConfig, classicChannels: null, logger: { debug() {}, info() {}, warn() {}, error() {} },
        getInstanceStatus: () => "running", getUiStatus: () => ({ instances: [] }) };
      handleViewRequest(req as never, res, new URL(`http://127.0.0.1${req.url}`), ctx as never);
    });
    const files = () => readdirSync(join(f.dir, "avatars")).sort();
    expect(await post("a.b", "image/png", Buffer.alloc(4, 1))).toBe(200);
    expect(await post("a", "image/png", Buffer.alloc(4, 2))).toBe(200);
    expect(files(), "a's upload left a.b's").toEqual(["a.b.png", "a.png"]);
    expect(await post("a", "image/webp", Buffer.alloc(4, 3))).toBe(200);
    expect(files(), "a's old picture (another extension) replaced; a.b's kept").toEqual(["a.b.png", "a.webp"]);
    // A row recording an older name (an upload from before filenames were stored bare) is replaced too.
    uploadProfile(f.dir, "solo", "legacy-solo.gif", Buffer.alloc(4, 4));
    expect(await post("solo", "image/png", Buffer.alloc(4, 5))).toBe(200);
    expect(files()).toEqual(["a.b.png", "a.webp", "solo.png"]);
    expect([avatarPath(f.dir, "a"), avatarPath(f.dir, "a.b"), avatarPath(f.dir, "solo")]).toEqual(["a.webp", "a.b.png", "solo.png"]);
  });
  it("only this instance's recorded file goes; nothing uploaded: 200, removed false; an unknown instance: 404", async () => {
    const f = fleet();
    uploadProfile(f.dir, "a", "a.png", Buffer.alloc(9, 4));
    uploadProfile(f.dir, "b", "b.png", Buffer.alloc(9, 5));
    writeFileSync(join(f.dir, "avatars", "a.extra.png"), Buffer.alloc(3));
    expect((await del(f, "a")).status).toBe(200);
    expect([existsSync(join(f.dir, "avatars", "b.png")), existsSync(join(f.dir, "avatars", "a.extra.png")), avatarPath(f.dir, "b")]).toEqual([true, true, "b.png"]);
    expect(JSON.parse((await del(f, "a")).body)).toEqual({ ok: true, removed: false });
    expect(JSON.parse((await del(f, "solo")).body)).toEqual({ ok: true, removed: false });
    expect((await del(f, "ghost")).status).toBe(404);
  });
});

describe("the image routes", () => {
  it("a speaking bot's cached avatar is served, typed, nosniff, private — own, primary or shared (#1867); a connection nobody speaks through or an unknown name: 404", async () => {
    const f = fleet();
    f.fm.fleetConfig.channels.push({ id: "discord-3", type: "discord" });
    f.fm.adapters.set("discord-3", { getBotUserId: () => "400000000000000004", fetchBotAvatar: async () => PNG(4) });
    f.frame(); await flush();
    const own = await get(f.fm, "/ui/img/bot/discord-2");
    expect([own.status, own.type, own.body.equals(Buffer.alloc(12, 2)), own.headers["x-content-type-options"], own.headers["cache-control"]])
      .toEqual([200, "image/png", true, "nosniff", "private, max-age=86400"]);
    for (const [k, n] of [["discord", 1], ["telegram-2", 3]] as const) {
      const r = await get(f.fm, `/ui/img/bot/${k}`);
      expect([r.status, r.body.equals(Buffer.alloc(12, n))], k).toEqual([200, true]);
    }
    for (const k of ["discord-3", "nope", "__proto__", "..%2F..%2Fetc"]) expect((await get(f.fm, `/ui/img/bot/${k}`)).status, k).toBe(404);
  });
  it("an own bot that becomes shared (a second instance joins its connection): its face stays, on both, and loses the ring", async () => {
    const f = fleet();
    f.frame(); await flush(); f.frame(); await flush();
    expect(f.frame().solo!.accent).toBe("#e91e63");
    f.fm.fleetConfig.instances.duo = { working_directory: f.dir, channel_id: "discord-2" };
    expect((await get(f.fm, "/ui/img/bot/discord-2")).status).toBe(200);
    const frame = f.frame();
    const face = { avatar: { kind: "image", src: expect.stringMatching(/^\/ui\/img\/bot\/discord-2\?v=/) }, accent: undefined };
    expect([frame.solo, frame.duo]).toEqual([face, face]);
    expect(f.calls.avatar, "the same cache entry").toBe(1);
  });
  it("the route never fetches: before the frame asked, there is nothing to serve", async () => {
    const f = fleet();
    expect((await get(f.fm, "/ui/img/bot/discord-2")).status).toBe(404);
    expect(f.calls.avatar).toBe(0);
  });
  it("a known instance's uploaded picture; an unknown or inherited name, or no upload: 404", async () => {
    const f = fleet();
    uploadProfile(f.dir, "a", "a.jpg", Buffer.alloc(5, 8));
    const ok = await get(f.fm, "/ui/img/avatar/a");
    expect([ok.status, ok.type, ok.body.equals(Buffer.alloc(5, 8))]).toEqual([200, "image/jpeg", true]);
    for (const k of ["b", "ghost", "constructor", "__proto__"]) expect((await get(f.fm, `/ui/img/avatar/${k}`)).status, k).toBe(404);
    uploadProfile(f.dir, "gone", "gone.png", Buffer.alloc(5, 1));      // a profile left behind by a removed instance
    expect((await get(f.fm, "/ui/img/avatar/gone")).status).toBe(404);
  });
  it("a server emoji of the fleet's Discord bots: fetched once from the CDN, then from the host cache; any other id: 404", async () => {
    const f = fleet();
    f.fm.worlds.set("discord", { type: "discord", adapter: { listGuildEmojis: async () => [{ id: "123456789012345678", name: "blob", animated: false, available: true }, { id: "223456789012345678", name: "dance", animated: true, available: true }] } });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { fetched.push(url); return new Response(Buffer.alloc(10, 6), { status: 200, headers: { "content-type": url.includes(".gif") ? "image/gif" : "image/png" } }); }));
    expect((await get(f.fm, "/ui/emojis")).body.toString()).toBe(JSON.stringify({ emojis: [{ id: "123456789012345678", name: "blob", animated: false }, { id: "223456789012345678", name: "dance", animated: true }] }));
    const one = await get(f.fm, "/ui/img/emoji/123456789012345678");
    const again = await get(f.fm, "/ui/img/emoji/123456789012345678");
    const gif = await get(f.fm, "/ui/img/emoji/223456789012345678");
    expect([one.status, one.type, again.status, gif.type]).toEqual([200, "image/png", 200, "image/gif"]);
    expect(fetched).toEqual(["https://cdn.discordapp.com/emojis/123456789012345678.png?size=64", "https://cdn.discordapp.com/emojis/223456789012345678.gif?size=64"]);
    for (const id of ["999999999999999999", "abc", "1"]) expect((await get(f.fm, `/ui/img/emoji/${id}`)).status, id).toBe(404);
    expect(fetched.length, "an unknown id is never fetched").toBe(2);
  });
  it("no Discord bot: an empty emoji list", async () => {
    const f = fleet();
    expect((await get(f.fm, "/ui/emojis")).body.toString()).toBe('{"emojis":[]}');
  });
  it("session-gated: without a credential, 401 and no picture", async () => {
    const f = fleet();
    f.frame(); await flush();
    for (const p of ["/ui/img/bot/discord-2", "/ui/img/emoji/123456789012345678", "/ui/emojis"]) {
      const r = await get(f.fm, p, { token: false });
      expect([r.status, String(r.type).startsWith("image/")], p).toEqual([401, false]);
    }
  });
  it("loading a picture is not a person's activity (passive), and the public link may read them — only read", () => {
    for (const p of ["/ui/img/bot/discord-2", "/ui/img/avatar/a", "/ui/img/emoji/1", "/ui/emojis"]) {
      expect([isPassiveWebRead("GET", p), isPublicWebRoute("GET", p), isPublicWebRoute("POST", p)], p).toEqual([true, true, false]);
    }
    expect([isPassiveWebRead("GET", "/ui/img/other/x"), isPublicWebRoute("GET", "/ui/img/other/x")]).toEqual([false, false]);
    // #1630 follow-up: removing an upload is allowed over the public link exactly as uploading it is (a cosmetic edit).
    expect(["POST", "DELETE"].map(m => isPublicWebRoute(m, "/api/avatar/a"))).toEqual([true, true]);
    expect(isPublicWebRoute("DELETE", "/api/profile/a"), "only the picture").toBe(false);
  });
});

// ── #1635 review: ownership is the configured connection AND the bot actually behind it; answers re-checked ──

const B_ID = "222222222222222222";
const held = <T,>() => { let release!: (v: T) => void; const promise = new Promise<T>(r => { release = r; }); return { promise, release }; };

describe("an own bot is a configured connection, and the bot that is there now (#1635 review)", () => {
  it("a connection removed from fleet.yaml is nobody's bot — even if an instance still names it (it falls back to the primary, #1867)", async () => {
    const f = fleet();
    f.frame(); await flush();
    expect((await get(f.fm, "/ui/img/bot/discord-2")).status).toBe(200);
    f.fm.fleetConfig.channels = f.fm.fleetConfig.channels.filter((c: { id: string }) => c.id !== "discord-2");
    expect((await get(f.fm, "/ui/img/bot/discord-2")).status).toBe(404);
    expect(f.frame().solo).toEqual({ avatar: { kind: "image", src: expect.stringMatching(/^\/ui\/img\/bot\/discord\?v=/) }, accent: undefined });
  });
  it("a bot put in its place (a replaced token, same connection id) gets its own picture, never the old one's", async () => {
    const f = fleet();
    f.frame(); await flush();                                     // bot A's picture (bytes 2) cached
    let bReads = 0;
    f.fm.adapters.set("discord-2", { getBotUserId: () => B_ID, fetchBotAvatar: async () => { bReads++; return PNG(9); }, botAccentColor: async () => "#00ff00" });
    expect(f.frame().solo!.avatar, "not A's face while B's is fetched").toEqual({ kind: "initial", text: "S" });
    expect((await get(f.fm, "/ui/img/bot/discord-2")).status, "nor A's picture on the route").toBe(404);
    await flush();
    const r = await get(f.fm, "/ui/img/bot/discord-2");
    expect([r.status, r.body.equals(Buffer.alloc(12, 9)), bReads]).toEqual([200, true, 1]);
  });
  it("the old bot's late answer is not the new bot's: A's fetch released after B took over changes nothing", async () => {
    const a = held<{ bytes: Buffer; ext: "png" }>();
    const f = fleet({ soloAvatar: () => a.promise, sharedAvatar: null });   // only discord-2 can put a file in the cache
    f.frame(); await flush();                                     // A's fetch is out
    f.fm.adapters.set("discord-2", { getBotUserId: () => B_ID, fetchBotAvatar: async () => PNG(9) });
    f.frame(); await flush();                                     // B's picture cached
    a.release(PNG(2)); await flush();
    const r = await get(f.fm, "/ui/img/bot/discord-2");
    expect([r.status, r.body.equals(Buffer.alloc(12, 9))]).toEqual([200, true]);
    expect(readdirSync(join(f.dir, "cache", "avatars")).length, "A's late answer was not kept either").toBe(1);
  });
  it("the ring too: A's colour arriving after B took over is not B's; B's own colour is read", async () => {
    const f = fleet();
    const aColour = held<string>();
    f.fm.adapters.set("discord-2", { getBotUserId: () => "111111111111111111", fetchBotAvatar: async () => PNG(2), botAccentColor: () => aColour.promise });
    f.frame(); await flush(); f.frame(); await flush();          // A's picture shown, A's colour read held
    let bColourReads = 0;
    f.fm.adapters.set("discord-2", { getBotUserId: () => B_ID, fetchBotAvatar: async () => PNG(9), botAccentColor: async () => { bColourReads++; return "#00ff00"; } });
    f.frame(); await flush(); f.frame(); await flush();
    aColour.release("#E91E63"); await flush();
    expect([f.frame().solo!.accent, bColourReads]).toEqual(["#00ff00", 1]);
  });
  it("control: the same bot's held fetch is read once and then shown", async () => {
    const a = held<{ bytes: Buffer; ext: "png" }>();
    const f = fleet({ soloAvatar: () => a.promise });
    f.frame(); await flush(); f.frame(); await flush();
    a.release(PNG(2)); await flush();
    expect([f.calls.avatar, (f.frame().solo!.avatar as { kind: string }).kind]).toEqual([1, "image"]);
  });
});

describe("an answer that waited is re-checked before it is sent (#1635 review)", () => {
  const EMOJI = "123456789012345678";
  const discordWorld = (f: ReturnType<typeof fleet>, list: () => Promise<unknown[]>) =>
    f.fm.worlds.set("discord", { type: "discord", adapter: { listGuildEmojis: list } });
  it("an emoji whose server left while it was downloaded: 404, not the old picture", async () => {
    const f = fleet();
    discordWorld(f, async () => [{ id: EMOJI, name: "blob", animated: false, available: true }]);
    const cdn = held<Response>();
    vi.stubGlobal("fetch", vi.fn(() => cdn.promise));
    const pending = get(f.fm, `/ui/img/emoji/${EMOJI}`);
    await flush();
    f.fm.worlds.delete("discord");
    cdn.release(new Response(Buffer.alloc(10, 6), { status: 200, headers: { "content-type": "image/png" } }));
    expect((await pending).status).toBe(404);
  });
  it("a server list that arrives after its connection went is not the fleet's", async () => {
    const f = fleet();
    const list = held<unknown[]>();
    discordWorld(f, () => list.promise);
    const pending = get(f.fm, "/ui/emojis");
    await flush();
    f.fm.worlds.delete("discord");
    list.release([{ id: EMOJI, name: "blob", animated: false, available: true }]);
    expect((await pending).body.toString()).toBe('{"emojis":[]}');
  });

  // r2: two Discord connections — A's list arrives at once, B's is awaited; A goes (or is replaced) meanwhile.
  const A_EMOJI = { id: EMOJI, name: "blob", animated: false, available: true };
  it.each(["removed", "replaced"] as const)("the list: A %s while B's list was awaited → A's emoji is not in it (r2)", async how => {
    const f = fleet();
    const b = held<unknown[]>();
    f.fm.worlds.set("discord", { type: "discord", adapter: { listGuildEmojis: async () => [A_EMOJI] } });
    f.fm.worlds.set("discord-2", { type: "discord", adapter: { listGuildEmojis: () => b.promise } });
    const pending = get(f.fm, "/ui/emojis");
    await flush();
    if (how === "removed") f.fm.worlds.delete("discord");
    else f.fm.worlds.set("discord", { type: "discord", adapter: { listGuildEmojis: async () => [] } });
    b.release([]);
    expect((await pending).body.toString()).toBe('{"emojis":[]}');
  });
  it("control: both worlds stay → both lists", async () => {
    const f = fleet();
    const b = held<unknown[]>();
    f.fm.worlds.set("discord", { type: "discord", adapter: { listGuildEmojis: async () => [A_EMOJI] } });
    f.fm.worlds.set("discord-2", { type: "discord", adapter: { listGuildEmojis: () => b.promise } });
    const pending = get(f.fm, "/ui/emojis");
    await flush();
    b.release([{ id: "223456789012345678", name: "dance", animated: true, available: true }]);
    expect(JSON.parse((await pending).body.toString()).emojis.map((e: { id: string }) => e.id)).toEqual([EMOJI, "223456789012345678"]);
  });
  it.each([true, false])("the picture: the final membership check awaits B while A goes → 404 (A removed: %s; control 200)", async removeA => {
    const f = fleet();
    let bCalls = 0; const bSecond = held<unknown[]>();
    f.fm.worlds.set("discord", { type: "discord", adapter: { listGuildEmojis: async () => [A_EMOJI] } });
    f.fm.worlds.set("discord-2", { type: "discord", adapter: { listGuildEmojis: () => (++bCalls === 1 ? Promise.resolve([]) : bSecond.promise) } });
    const cdn = held<Response>();
    vi.stubGlobal("fetch", vi.fn(() => cdn.promise));
    const pending = get(f.fm, `/ui/img/emoji/${EMOJI}`);
    await flush();                                                // first list done; the download is out
    f.fm.guildEmojiCache.clear();                                 // the lists' 10-minute cache has run out meanwhile
    cdn.release(new Response(Buffer.alloc(10, 6), { status: 200, headers: { "content-type": "image/png" } }));
    await flush();                                                // the final check: A's list taken, B's awaited
    if (removeA) f.fm.worlds.delete("discord");
    bSecond.release([]);
    expect((await pending).status).toBe(removeA ? 404 : 200);
    expect(bCalls, "the final check really read B again").toBe(2);
  });

  /** A signed-in browser (a local session cookie, or a public-link session on its exposure) — no header token. */
  async function asSession(f: ReturnType<typeof fleet>, path: string, opts: { gateway: boolean; revoke: boolean; hold: "list" | "cdn" }) {
    const { WebSessionStore, tokenEpoch } = await import("../src/web-session.js");
    const { bindGatewayRequest } = await import("../src/web-request-context.js");
    const store = new WebSessionStore();
    const s = store.create({ tier: "admin", surface: opts.gateway ? "gateway" : "local", ...(opts.gateway ? { exposureId: "e".repeat(32) } : {}), label: "t", tokenEpoch: tokenEpoch(TOKEN) });
    const list = held<unknown[]>(), cdn = held<Response>();
    discordWorld(f, () => (opts.hold === "list" ? list.promise : Promise.resolve([{ id: EMOJI, name: "blob", animated: false, available: true }])));
    vi.stubGlobal("fetch", vi.fn(() => cdn.promise));
    const done = new Promise<{ status: number; type?: string }>(resolve => {
      let status = 0; const headers: Record<string, unknown> = {};
      const res: any = { headersSent: false, destroyed: false, setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
        writeHead(code: number) { status = code; res.headersSent = true; }, end() { resolve({ status, type: headers["content-type"] as string | undefined }); } };
      const host = opts.gateway ? "sample.trycloudflare.com" : "127.0.0.1:19280";
      const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { host, cookie: `${opts.gateway ? "__Host-agend_session" : "agend_session"}=${s.sessionId}` }, destroy() {}, resume() {} });
      if (opts.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://sample.trycloudflare.com", isCurrent: () => true });
      const ctx = { webToken: TOKEN, webSessions: store, sseClients: new Set(), fleetConfig: f.fm.fleetConfig, logger: { info() {}, debug() {}, warn() {}, error() {} }, getUiStatus: () => ({}),
        webImage: (k: "bot" | "avatar", key: string) => f.fm.webImage(k, key), webEmoji: (id: string) => f.fm.webEmoji(id), webEmojiList: () => f.fm.webEmojiList() };
      expect(handleWebRequest(req as never, res, new URL(`http://${host}${path}`), ctx as never)).toBe(true);
    });
    await flush();
    if (opts.revoke) store.revokeById(s.sessionId);
    list.release([{ id: EMOJI, name: "blob", animated: false, available: true }]);
    cdn.release(new Response(Buffer.alloc(10, 6), { status: 200, headers: { "content-type": "image/png" } }));
    return done;
  }
  it.each([false, true])("a session revoked while the answer was out gets 401 and nothing (public link: %s); the same session not revoked gets it", async gateway => {
    for (const [path, hold] of [["/ui/emojis", "list"], [`/ui/img/emoji/${EMOJI}`, "cdn"]] as const) {
      const revoked = await asSession(fleet(), path, { gateway, revoke: true, hold });
      expect([revoked.status, String(revoked.type).startsWith("image/")], `${path} revoked`).toEqual([401, false]);
      const kept = await asSession(fleet(), path, { gateway, revoke: false, hold });
      expect(kept.status, `${path} control`).toBe(200);
    }
  });
});
