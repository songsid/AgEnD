/**
 * #1226 — stickers (list_stickers / preview_stickers / reply.stickers, Discord + Telegram) and a lighter list_emojis.
 *
 * Nothing reaches a network: the Discord adapter runs on a stub client, the Telegram adapter's every Bot API call is
 * answered by its own api middleware, and picture downloads go to a stubbed global fetch that records each URL.
 * No fleet or tmux is started. Expectations are written out by hand.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { MessageQueue } from "../src/channel/message-queue.js";
import { downloadStickerImage, STICKER_PREVIEW_MAX_BYTES } from "../src/channel/sticker-download.js";
import { routeToolCall } from "../src/channel/tool-router.js";
import type { ChannelAdapter, StickerInfo } from "../src/channel/types.js";
import { splitFlags } from "../src/cli-flags.js";
import { validateFleetConfig } from "../src/config-validator.js";

const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const c of cleanups.splice(0)) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (p: string) => { const d = mkdtempSync(join(tmpdir(), `agend-1226-${p}-`)); dirs.push(d); return d; };

/** A global fetch that answers from a table and records every URL; anything unlisted is a test failure. */
function stubFetch(table: Record<string, () => Response>) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    expect(init?.redirect, "never follow a redirect").toBe("error");
    const hit = Object.entries(table).find(([prefix]) => String(url).startsWith(prefix));
    if (!hit) throw new Error(`unexpected fetch ${url}`);
    return hit[1]();
  }));
  return urls;
}
const image = (type: string, bytes = Buffer.from("PIC")) => () => new Response(bytes, { status: 200, headers: { "content-type": type } });

// ── Discord ─────────────────────────────────────────────────────────────────────────────────────────────────────

const G1 = "111111111111111111", G2 = "222222222222222222";
function discord(over: Record<string, unknown> = {}) {
  const sent: unknown[] = [];
  const restGets: string[] = [];
  const channelGuild: Record<string, string> = { "chan-a": G1, "thread-b": G1, "chan-other": G2 };
  const client = {
    isReady: () => true,
    guilds: { cache: new Map([[G1, { id: G1, name: "Home" }], [G2, { id: G2, name: "Elsewhere" }]]) },
    channels: {
      fetch: async (id: string) => {
        if (!(id in channelGuild)) throw new Error("Unknown Channel");
        return { id, guildId: channelGuild[id], isTextBased: () => true, send: async (m: unknown) => { sent.push(m); return { id: `m${sent.length}` }; } };
      },
    },
    rest: {
      get: async (path: string) => {
        restGets.push(path);
        if (path === `/guilds/${G1}/stickers`) {
          return [
            { id: "333333333333333331", name: "wave", tags: "wave,hello", format_type: 1 },
            { id: "333333333333333332", name: "dance", tags: "party", format_type: 3 },
            { id: "333333333333333333", name: "spin", tags: "spin", format_type: 4, available: false },
            { id: "333333333333333334", name: "glow", tags: "", format_type: 2 },
            { id: "not-a-snowflake", name: "junk", tags: "", format_type: 1 },
            null,
          ];
        }
        return [];
      },
    },
    ...over,
  };
  const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
  Object.assign(adapter as any, { client, guildId: G1 });
  return { adapter, sent, restGets };
}

describe("Discord: list_stickers is the channel's own server", () => {
  it("lists the server the channel (or its thread) is in, in the common shape; junk ids are dropped", async () => {
    const { adapter, restGets } = discord();
    const list = await adapter.listStickers({ chatId: G1, threadId: "thread-b" });
    expect(restGets).toEqual([`/guilds/${G1}/stickers`]);
    expect(list).toEqual({
      scope: "server Home",
      stickers: [
        { id: "333333333333333331", name: "wave", emoji_or_tags: "wave,hello", format: "png", available: true },
        { id: "333333333333333332", name: "dance", emoji_or_tags: "party", format: "lottie", available: true },
        { id: "333333333333333333", name: "spin", emoji_or_tags: "spin", format: "gif", available: false },
        { id: "333333333333333334", name: "glow", emoji_or_tags: "", format: "apng", available: true },
      ],
    });
  });

  it("a channel in another server lists that server; a server id stands for itself; an unknown channel is an error", async () => {
    const { adapter, restGets } = discord();
    // The reply goes to the thread, so the thread's server decides — not the chat id beside it.
    await adapter.listStickers({ chatId: "chan-other", threadId: "thread-b" });
    expect(restGets).toEqual([`/guilds/${G1}/stickers`]);
    restGets.length = 0;
    await adapter.listStickers({ chatId: "chan-other" });
    await adapter.listStickers({ chatId: G1 });
    expect(restGets).toEqual([`/guilds/${G2}/stickers`, `/guilds/${G1}/stickers`]);
    await expect(adapter.listStickers({ chatId: "nowhere" })).rejects.toThrow("cannot tell which server");
  });

  it("preview: PNG and APNG from the media CDN, GIF as .gif, none for Lottie; a non-snowflake id never becomes a URL", async () => {
    const { adapter } = discord();
    const urls = stubFetch({ "https://media.discordapp.net/stickers/": image("image/png") });
    const st = (id: string, format: StickerInfo["format"]): StickerInfo => ({ id, name: "x", emoji_or_tags: "", format, available: true });
    await expect(adapter.fetchStickerPreview(st("333333333333333331", "png"))).resolves.toEqual({ bytes: Buffer.from("PIC"), ext: "png" });
    await adapter.fetchStickerPreview(st("333333333333333334", "apng"));
    await adapter.fetchStickerPreview(st("333333333333333333", "gif"));
    await expect(adapter.fetchStickerPreview(st("333333333333333332", "lottie"))).resolves.toBeNull();
    await expect(adapter.fetchStickerPreview(st("../../evil", "png"))).rejects.toThrow("not a Discord sticker id");
    expect(urls).toEqual([
      "https://media.discordapp.net/stickers/333333333333333331.png?size=160",
      "https://media.discordapp.net/stickers/333333333333333334.png?size=160",
      "https://media.discordapp.net/stickers/333333333333333333.gif",
    ]);
  });

  it("send: stickers ride on the text's last chunk; alone when there is no text", async () => {
    const { adapter, sent } = discord();
    await adapter.sendStickers("chan-a", ["333333333333333331"], { text: "hi there" });
    await adapter.sendStickers("chan-a", ["333333333333333331", "333333333333333334"]);
    const long = "x".repeat(2100);
    const r = await adapter.sendStickers("chan-a", ["333333333333333331"], { text: long });
    expect(sent).toEqual([
      { content: "hi there", stickers: ["333333333333333331"] },
      { stickers: ["333333333333333331", "333333333333333334"] },
      expect.any(String),
      { content: expect.any(String), stickers: ["333333333333333331"] },
    ]);
    expect((sent[2] as string) + (sent[3] as { content: string }).content).toBe(long);
    expect(r.messageId).toBe("m3");
  });

  it("send: a long text — every chunk goes out, in order, the stickers on the last; the first message is the answer", async () => {
    const { adapter, sent } = discord();
    const parts = ["A", "B", "C", "D"].map(c => c.repeat(1990));
    const r = await adapter.sendStickers("chan-a", ["333333333333333331"], { text: parts.join("\n") });
    expect(sent).toHaveLength(4);
    const texts = sent.map(m => (typeof m === "string" ? m : (m as { content: string }).content));
    expect(texts.map(t => t.trim()[0])).toEqual(["A", "B", "C", "D"]);
    expect(texts.join("").replace(/\n/g, "")).toBe(parts.join(""));
    expect(sent.slice(0, 3).every(m => typeof m === "string"), "stickers only on the last message").toBe(true);
    expect(sent[3]).toEqual({ content: expect.any(String), stickers: ["333333333333333331"] });
    expect(r.messageId).toBe("m1");
  });
});

// ── Telegram ────────────────────────────────────────────────────────────────────────────────────────────────────

const TOKEN = "123456:test-only";
function telegram(onCall: (method: string, payload: any) => unknown) {
  const adapter = new TelegramAdapter({ id: "telegram", botToken: TOKEN, accessManager: { isAllowed: () => ({ allowed: true }) } as never, inboxDir: scratch("tg") });
  cleanups.push(() => { (adapter as any).httpAgent?.destroy(); (adapter as any).httpsAgent?.destroy(); });
  const calls: Array<[string, any]> = [];
  (adapter.getBot() as any).api.config.use(async (_prev: unknown, method: string, payload: any) => {
    calls.push([method, payload]);
    return { ok: true, result: await onCall(method, payload) };
  });
  return { adapter, calls };
}
const SET = {
  name: "cats_by_bot", title: "Cats", sticker_type: "regular",
  stickers: [
    { file_id: "CAACAgIAAxkBAAEstatic01", file_unique_id: "u1", type: "regular", width: 512, height: 512, is_animated: false, is_video: false, emoji: "😺" },
    { file_id: "CAACAgIAAxkBAAEanimated2", file_unique_id: "u2", type: "regular", width: 512, height: 512, is_animated: true, is_video: false, emoji: "🙀",
      thumbnail: { file_id: "AAMCAgADGQthumbnail02", file_unique_id: "t2", width: 128, height: 128 } },
    { file_id: "CAACAgIAAxkBAAEvideo0003", file_unique_id: "u3", type: "regular", width: 512, height: 512, is_animated: false, is_video: true },
  ],
};

describe("Telegram: a sticker set", () => {
  it("lists the named set in the common shape; the thumbnail id is kept for previews only", async () => {
    const { adapter, calls } = telegram(m => (m === "getStickerSet" ? SET : true));
    const list = await adapter.listStickers({ set: "cats_by_bot" });
    expect(calls).toEqual([["getStickerSet", { name: "cats_by_bot" }]]);
    expect(list).toEqual({
      scope: "set Cats",
      stickers: [
        { id: "CAACAgIAAxkBAAEstatic01", name: "cats_by_bot #1", emoji_or_tags: "😺", format: "webp", available: true },
        { id: "CAACAgIAAxkBAAEanimated2", name: "cats_by_bot #2", emoji_or_tags: "🙀", format: "tgs", available: true, thumbnailId: "AAMCAgADGQthumbnail02" },
        { id: "CAACAgIAAxkBAAEvideo0003", name: "cats_by_bot #3", emoji_or_tags: "", format: "webm", available: true },
      ],
    });
    await expect(adapter.listStickers({})).rejects.toThrow("set is required on Telegram");
  });

  it("preview: a static sticker is its own picture; an animated one its thumbnail; without one, none — and the token never leaves", async () => {
    const files: Record<string, string> = { "CAACAgIAAxkBAAEstatic01": "stickers/a.webp", "AAMCAgADGQthumbnail02": "thumbnails/b.jpg" };
    const { adapter, calls } = telegram((m, p) => (m === "getFile" ? { file_id: p.file_id, file_unique_id: "x", file_path: files[p.file_id] } : true));
    const urls = stubFetch({
      "https://api.telegram.org/file/bot123456:test-only/stickers/": () => new Response(Buffer.from("WEBP"), { status: 200, headers: { "content-type": "application/octet-stream" } }),
      "https://api.telegram.org/file/bot123456:test-only/thumbnails/": () => new Response("", { status: 404 }),
    });
    const [st, anim, vid] = (await (async () => { const { adapter: a } = telegram(() => SET); return a.listStickers({ set: "x" }); })()).stickers;
    await expect(adapter.fetchStickerPreview(st!)).resolves.toEqual({ bytes: Buffer.from("WEBP"), ext: "webp" });
    const failure = await adapter.fetchStickerPreview(anim!).catch((e: Error) => e);
    expect(String(failure)).toBe("Error: HTTP 404");
    expect(String(failure)).not.toContain("test-only");
    await expect(adapter.fetchStickerPreview(vid!)).resolves.toBeNull();
    expect(calls.map(c => [c[0], c[1].file_id])).toEqual([["getFile", "CAACAgIAAxkBAAEstatic01"], ["getFile", "AAMCAgADGQthumbnail02"]]);
    expect(urls).toHaveLength(2);
  });

  it("send: the text first, then each sticker in order, each awaited; a refused sticker is an error", async () => {
    let refuse = "";
    const { adapter, calls } = telegram((m, p) => {
      if (m === "sendSticker" && p.sticker === refuse) throw Object.assign(new Error("Bad Request: wrong file identifier"), { error_code: 400 });
      return { message_id: calls.length, date: 0, chat: { id: -100, type: "supergroup" } };
    });
    await adapter.sendStickers("-100", ["CAACAgIAAxkBAAEstatic01", "CAACAgIAAxkBAAEanimated2"], { text: "look", threadId: "7" });
    expect(calls.map(c => [c[0], c[1].text ?? c[1].sticker, c[1].message_thread_id])).toEqual([
      ["sendMessage", "look", 7], ["sendSticker", "CAACAgIAAxkBAAEstatic01", 7], ["sendSticker", "CAACAgIAAxkBAAEanimated2", 7],
    ]);
    calls.length = 0;
    await adapter.sendStickers("-100", ["CAACAgIAAxkBAAEstatic01"]);
    expect(calls.map(c => c[0])).toEqual(["sendSticker"]);
    refuse = "CAACAgIAAxkBAAEbroken99";
    await expect(adapter.sendStickers("-100", ["CAACAgIAAxkBAAEstatic01", "CAACAgIAAxkBAAEbroken99"])).rejects.toThrow("wrong file identifier");
  });

  it("send: a long text's queued chunks go out before any sticker", async () => {
    const order: string[] = [];
    const { adapter } = telegram(async (m, p) => {
      // The queued chunk is slow: a sticker that did not wait for the queue would overtake it.
      if (m === "sendMessage" && String(p.text).length === 904) await new Promise(r => setTimeout(r, 400));
      order.push(m === "sendSticker" ? `sticker` : `text:${String(p.text).length}`);
      return { message_id: order.length, date: 0, chat: { id: -100, type: "supergroup" } };
    });
    (adapter as any).queue.start();
    cleanups.push(() => (adapter as any).queue.stop());
    await adapter.sendStickers("-100", ["CAACAgIAAxkBAAEstatic01"], { text: "y".repeat(5000) });
    expect(order).toEqual(["text:4096", "text:904", "sticker"]);
  });
});

describe("MessageQueue.whenIdle", () => {
  it("waits for the chat's queue, including the item being sent; gives up with an error rather than going first", async () => {
    let release!: () => void;
    const q = new MessageQueue({
      send: () => new Promise(r => { release = () => r({ messageId: "1" }); }),
      edit: async () => {}, sendFile: async () => ({ messageId: "f" }),
    });
    q.start();
    cleanups.push(() => q.stop());
    await expect(q.whenIdle("c", undefined)).resolves.toBeUndefined();          // nothing queued
    q.enqueue("c", undefined, { type: "content", text: "a" });
    let idle = false;
    const waiting = q.whenIdle("c", undefined).then(() => { idle = true; });
    await new Promise(r => setTimeout(r, 300));
    expect(idle, "the item is in flight, not done").toBe(false);
    release();
    await waiting;
    expect(idle).toBe(true);
    q.enqueue("c", undefined, { type: "content", text: "b" });
    await expect(q.whenIdle("c", undefined, 150)).rejects.toThrow("still queued");
    release();
  });
});

describe("downloadStickerImage", () => {
  it("an image of a known type, within the size cap; never follows a redirect; never quotes the URL", async () => {
    stubFetch({ "https://ok/": image("image/gif"), "https://html/": image("text/html"), "https://big/": image("image/png", Buffer.alloc(STICKER_PREVIEW_MAX_BYTES + 1)) });
    await expect(downloadStickerImage("https://ok/x")).resolves.toEqual({ bytes: Buffer.from("PIC"), ext: "gif" });
    await expect(downloadStickerImage("https://html/x")).rejects.toThrow("not an image");
    await expect(downloadStickerImage("https://big/x")).rejects.toThrow("image too large");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed: https://secret.example/bot123:SECRET/file"); }));
    const err = await downloadStickerImage("https://secret.example/bot123:SECRET/file").catch((e: Error) => e);
    expect(String(err)).toBe("Error: download failed (TypeError)");
  });
});

// ── the reply tool ──────────────────────────────────────────────────────────────────────────────────────────────

describe("reply.stickers through routeToolCall", () => {
  const adapter = (withStickers: boolean) => {
    const calls: unknown[] = [];
    const a = {
      sendText: async (...x: unknown[]) => { calls.push(["text", ...x]); return { messageId: "t", chatId: "c" }; },
      sendFile: async () => ({ messageId: "f", chatId: "c" }),
      ...(withStickers ? { sendStickers: async (...x: unknown[]) => { calls.push(["stickers", ...x]); return { messageId: "s", chatId: "c" }; } } : {}),
    } as unknown as ChannelAdapter;
    return { a, calls };
  };
  const reply = (a: ChannelAdapter, args: Record<string, unknown>) =>
    new Promise<[unknown, string | undefined]>(res => routeToolCall(a, "reply", { chat_id: "c", ...args }, "7", (r, e) => res([r, e])));

  it("stickers go with the text through sendStickers; without stickers, sendText as before", async () => {
    const { a, calls } = adapter(true);
    expect(await reply(a, { text: "hi", stickers: ["s1"] })).toEqual([{ messageId: "s", chatId: "c" }, undefined]);
    expect(await reply(a, { text: "plain" })).toEqual([{ messageId: "t", chatId: "c" }, undefined]);
    expect(calls).toEqual([
      ["stickers", "c", ["s1"], { threadId: "7", replyTo: undefined, format: undefined, text: "hi" }],
      ["text", "c", "plain", { threadId: "7", replyTo: undefined, format: undefined }],
    ]);
  });

  it("an adapter that cannot send stickers says so; nothing is sent", async () => {
    const { a, calls } = adapter(false);
    expect(await reply(a, { text: "hi", stickers: ["s1"] })).toEqual([null, "reply: this channel cannot send stickers"]);
    expect(calls).toEqual([]);
  });
});

// ── the fleet ───────────────────────────────────────────────────────────────────────────────────────────────────

async function fleet(platform: "discord" | "telegram") {
  const { FleetManager } = await import("../src/fleet-manager.js");
  const fm = new FleetManager(scratch("fleet"));
  const any = fm as any;
  const listCalls: unknown[] = [];
  const sticker = (id: string, name: string, format: StickerInfo["format"], available = true, extra: Partial<StickerInfo> = {}): StickerInfo =>
    ({ id, name, emoji_or_tags: name === "wave" ? "hello" : "", format, available, ...extra });
  const discordList = { scope: "server Home", stickers: [sticker("333333333333333331", "wave", "png"), sticker("333333333333333332", "dance", "lottie"), sticker("333333333333333333", "spin", "gif", false)] };
  const tgLists: Record<string, StickerInfo[]> = { cats: [sticker("CAACAgIAAxkBAAEstatic01", "cats #1", "webp"), sticker("CAACAgIAAxkBAAEanimated2", "cats #2", "tgs", true, { thumbnailId: "THUMB" })], dogs: [sticker("CAACAgIAAxkBAAEdog00001", "dogs #1", "webp")] };
  const adapter = {
    id: platform, type: platform,
    listStickers: async (target: any) => {
      listCalls.push(target);
      if (platform === "discord") return discordList;
      if (!tgLists[target.set]) throw new Error("Bad Request: STICKERSET_INVALID");
      return { scope: `set ${target.set}`, stickers: tgLists[target.set] };
    },
    fetchStickerPreview: async (st: StickerInfo) => (st.format === "lottie" || (st.format === "tgs" && !st.thumbnailId) ? null : { bytes: Buffer.from(`PIC-${st.id}`), ext: "png" as const }),
    sendStickers: async () => ({ messageId: "s", chatId: "c" }),
  } as unknown as ChannelAdapter;
  const channel = { id: platform, type: platform, group_id: "-100", bot_token_env: "X", ...(platform === "telegram" ? { options: { sticker_sets: ["cats", "dogs"] } } : {}) };
  any.fleetConfig = { channels: [channel], instances: { w: { working_directory: "/tmp", topic_id: "42" } } };
  any.worlds.set(platform, { id: platform, type: platform, adapter, channelConfig: channel, groupId: "-100" });
  any.adapter = adapter;
  return { fm, any, listCalls, adapter };
}

describe("FleetManager.listStickersFor", () => {
  it("Discord: the instance's own channel's server, the common shape, no URLs; unavailable ones left out; filter and limit", async () => {
    const { fm, listCalls } = await fleet("discord");
    const r = await fm.listStickersFor("w", {});
    expect(listCalls).toEqual([{ chatId: "-100", threadId: "42" }]);
    expect(r).toEqual({
      platform: "discord",
      lists: [{ scope: "server Home", stickers: [
        { id: "333333333333333331", name: "wave", emoji_or_tags: "hello", format: "png" },
        { id: "333333333333333332", name: "dance", emoji_or_tags: "", format: "lottie" },
      ] }],
      note: expect.stringContaining("reply({ stickers: [id] })"),
    });
    expect(JSON.stringify(r)).not.toMatch(/https?:|thumbnail/i);
    expect((await fm.listStickersFor("w", { name: "HELL" }) as any).lists[0].stickers.map((s: any) => s.name)).toEqual(["wave"]);
    expect((await fm.listStickersFor("w", { limit: 1 }) as any).lists[0].stickers.map((s: any) => s.name)).toEqual(["wave"]);
    expect(listCalls, "cached").toHaveLength(1);
    await fm.listStickersFor("w", { refresh: true });
    expect(listCalls).toHaveLength(2);
  });

  it("Telegram: the named set, else the connection's sticker_sets; the limit runs across sets; a bad set is that set's error", async () => {
    const { fm, any } = await fleet("telegram");
    const all = await fm.listStickersFor("w", {}) as any;
    expect(all.lists.map((l: any) => [l.scope, l.stickers.map((s: any) => s.id)])).toEqual([
      ["set cats", ["CAACAgIAAxkBAAEstatic01", "CAACAgIAAxkBAAEanimated2"]], ["set dogs", ["CAACAgIAAxkBAAEdog00001"]],
    ]);
    expect(JSON.stringify(all)).not.toContain("THUMB");
    expect((await fm.listStickersFor("w", { limit: 2 }) as any).lists.map((l: any) => l.stickers.length)).toEqual([2, 0]);
    expect((await fm.listStickersFor("w", { set: "dogs" }) as any).lists.map((l: any) => l.scope)).toEqual(["set dogs"]);
    expect((await fm.listStickersFor("w", { set: "nope" }) as any).lists).toEqual([{ scope: "set nope", error: "cannot list stickers: Bad Request: STICKERSET_INVALID" }]);
    delete any.fleetConfig.channels[0].options;
    expect(await fm.listStickersFor("w", {})).toEqual({ error: expect.stringContaining("name a sticker set") });
  });

  it("an instance that is not ours is refused", async () => {
    const { fm } = await fleet("discord");
    expect(await fm.listStickersFor("constructor", {})).toHaveProperty("error");
  });
});

describe("FleetManager.previewStickers", () => {
  it("only stickers list_stickers returned; a picture to Read, or preview_unavailable for one with no still image", async () => {
    const { fm } = await fleet("discord");
    expect(await fm.previewStickers("w", { stickers: ["333333333333333331"] })).toEqual({
      previews: [], unavailable: [], errors: [{ sticker: "333333333333333331", error: "not a sticker list_stickers returned here; list them first" }], note: expect.any(String),
    });
    await fm.listStickersFor("w", {});
    const r = await fm.previewStickers("w", { stickers: ["333333333333333331", "333333333333333332", "999"] }) as any;
    expect(r.previews).toEqual([{ sticker: "333333333333333331", name: "wave", path: expect.stringMatching(/sticker-previews\/[0-9a-f]{24}\.png$/) }]);
    expect(readFileSync(r.previews[0].path, "utf8")).toBe("PIC-333333333333333331");
    expect(r.unavailable).toEqual([{ sticker: "333333333333333332", name: "dance", reason: "preview_unavailable: a lottie sticker has no still picture" }]);
    expect(r.errors.map((e: any) => e.sticker)).toEqual(["999"]);
  });

  it("at most 8, and a list of ids", async () => {
    const { fm } = await fleet("discord");
    expect(await fm.previewStickers("w", { stickers: Array(9).fill("x") })).toEqual({ error: expect.stringContaining("at most 8") });
    expect(await fm.previewStickers("w", { stickers: "x" })).toEqual({ error: expect.stringContaining("stickers is required") });
  });
});

describe("FleetManager.replyStickerProblem: checked before anything is sent", () => {
  it("Discord: only an available sticker of the server the reply goes to", async () => {
    const { fm, adapter, listCalls } = await fleet("discord");
    const check = (args: Record<string, unknown>) => fm.replyStickerProblem(adapter, { chat_id: "-100", ...args }, "42", "discord");
    expect(await check({ text: "hi", stickers: ["333333333333333331"] })).toBeNull();
    expect(await check({ stickers: ["444444444444444444"] })).toBe("reply: sticker 444444444444444444 cannot be sent here — only stickers of this channel's server can (server Home); call list_stickers");
    expect(listCalls.length, "a miss refetches once before refusing").toBe(2);
    expect(await check({ stickers: ["333333333333333333"] })).toBe("reply: sticker spin (333333333333333333) is unavailable on this server (it lost the boost level it needs)");
    expect(await check({ stickers: ["333333333333333331", "333333333333333331"] })).toBe("reply: the same sticker twice");
    expect(await check({ stickers: ["a", "b", "c", "d"] })).toBe("reply: at most 3 stickers per message");
    expect(await check({ stickers: [""] })).toBe("reply: stickers must be a list of sticker ids from list_stickers");
    expect(await check({ text: "" })).toBe("reply: text is required (or stickers)");
    expect(await check({ text: "only text" })).toBeNull();
  });

  it("Telegram: any file_id is sendable anywhere — only its shape is checked here", async () => {
    const { fm, adapter, listCalls } = await fleet("telegram");
    const check = (args: Record<string, unknown>) => fm.replyStickerProblem(adapter, { chat_id: "-100", ...args }, "42", "telegram");
    expect(await check({ stickers: ["CAACAgIAAxkBAAEanyone99"] })).toBeNull();
    expect(await check({ stickers: ["<:wave:1>"] })).toBe("reply: <:wave:1> is not a Telegram sticker id (use an id from list_stickers)");
    expect(listCalls).toEqual([]);
  });

  it("an adapter that cannot send stickers is refused up front", async () => {
    const { fm } = await fleet("discord");
    const bare = { id: "x", type: "discord", sendText: async () => ({}) } as unknown as ChannelAdapter;
    expect(await fm.replyStickerProblem(bare, { stickers: ["333333333333333331"] }, undefined, "x")).toBe("reply: this channel cannot send stickers");
  });
});

describe("the reply path: a refused sticker is the reply's error, and nothing is sent", () => {
  it("handleOutboundFromInstance", async () => {
    const { any } = await fleet("discord");
    const sent: unknown[] = [];
    any.worlds.get("discord").adapter.sendStickers = async (...a: unknown[]) => { sent.push(a); return { messageId: "s", chatId: "-100" }; };
    any.worlds.get("discord").adapter.sendText = async (...a: unknown[]) => { sent.push(a); return { messageId: "t", chatId: "-100" }; };
    const answers: any[] = [];
    any.instanceIpcClients.set("w", { send: (m: unknown) => { answers.push(m); return true; } });
    any.getInstanceIdle = () => true; any.clearCancelButton = () => {}; any.reactDone = () => {};
    await any.handleOutboundFromInstance("w", { tool: "reply", args: { text: "hi", stickers: ["444444444444444444"], chat_id: "-100" }, fleetRequestId: "r1" });
    expect(answers[0].error).toContain("cannot be sent here");
    expect(sent).toEqual([]);
    await any.handleOutboundFromInstance("w", { tool: "reply", args: { text: "hi", stickers: ["333333333333333331"], chat_id: "-100" }, fleetRequestId: "r2" });
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(answers[1].error).toBeUndefined();
    expect(sent).toEqual([["-100", ["333333333333333331"], expect.objectContaining({ text: "hi", threadId: "42" })]]);
  });

  it("a reply with stickers is not joined to the same text in flight without them (the dedup key has the stickers)", async () => {
    const { any } = await fleet("telegram");
    const releases: Array<() => void> = [];
    const pending = (value: unknown) => new Promise(resolve => releases.push(() => resolve(value)));
    const adapter = any.worlds.get("telegram").adapter;
    const texts: unknown[] = []; const stickerSends: unknown[] = [];
    adapter.sendText = (...a: unknown[]) => { texts.push(a); return pending({ messageId: "t", chatId: "-100" }); };
    adapter.sendStickers = (...a: unknown[]) => { stickerSends.push(a); return pending({ messageId: "s", chatId: "-100" }); };
    const answers: any[] = [];
    any.instanceIpcClients.set("w", { send: (m: unknown) => { answers.push(m); return true; } });
    any.getInstanceIdle = () => true; any.clearCancelButton = () => {}; any.reactDone = () => {};
    await any.handleOutboundFromInstance("w", { tool: "reply", args: { text: "x", chat_id: "-100" }, fleetRequestId: "r1" });
    await any.handleOutboundFromInstance("w", { tool: "reply", args: { text: "x", stickers: ["CAACAgIAAxkBAAEstatic01"], chat_id: "-100" }, fleetRequestId: "r2" });
    await vi.waitFor(() => expect(stickerSends).toHaveLength(1));
    expect(texts).toHaveLength(1);
    releases.splice(0).forEach(release => release());
    await vi.waitFor(() => expect(answers).toHaveLength(2));
  });
});

describe("list_emojis: lighter by default (#1226)", () => {
  async function emojiFleet() {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(scratch("emoji"));
    const any = fm as any;
    any.fleetConfig = { channels: [{ id: "dc", type: "discord", group_id: G1, bot_token_env: "X" }], instances: { w: { working_directory: "/tmp", topic_id: "42" } } };
    const e = (id: string, name: string) => ({ id, name, animated: false, available: true });
    const adapter = {
      id: "dc", type: "discord",
      listGuildEmojis: async (gid: string) => (gid === G1 ? [e("500000000000000001", "party_parrot"), e("500000000000000002", "thumbs"), e("500000000000000003", "parrot_sad")] : [e("600000000000000001", "parrot_far")]),
      listMemberGuilds: async () => [{ id: G1, name: "Home", primary: true }, { id: G2, name: "Far", primary: false }],
    };
    any.worlds.set("dc", { id: "dc", type: "discord", adapter, channelConfig: any.fleetConfig.channels[0] });
    any.adapter = adapter;
    any.classicChannels = { isGuildAllowed: () => true, getAll: () => [], getChannelIdByInstance: () => undefined };
    any.resolveStatusEmojisFor = () => ({ platform: "discord" });
    return fm;
  }
  const names = (r: any) => r.server_emojis.map((g: any) => [g.server, g.emojis.map((x: any) => x.value)]);

  it("no image URLs unless asked; everything when nothing is filtered", async () => {
    const fm = await emojiFleet();
    const r = await fm.listEmojisFor("w") as any;
    expect(names(r)).toEqual([
      ["Home", ["<:party_parrot:500000000000000001>", "<:thumbs:500000000000000002>", "<:parrot_sad:500000000000000003>"]],
      ["Far", ["<:parrot_far:600000000000000001>"]],
    ]);
    expect(JSON.stringify(r.server_emojis)).not.toContain("image_url");
    expect(r.server_emojis_note).toContain("preview_emojis");
    const withUrls = await fm.listEmojisFor("w", false, { with_image_urls: true }) as any;
    expect(withUrls.server_emojis[0].emojis[0]).toEqual({ value: "<:party_parrot:500000000000000001>", image_url: expect.stringContaining("500000000000000001") });
  });

  it("name filters, limit counts across servers, primary_only keeps the primary server — the CLI's strings work too", async () => {
    const fm = await emojiFleet();
    expect(names(await fm.listEmojisFor("w", false, { name: "PARROT" }))).toEqual([
      ["Home", ["<:party_parrot:500000000000000001>", "<:parrot_sad:500000000000000003>"]], ["Far", ["<:parrot_far:600000000000000001>"]],
    ]);
    expect(names(await fm.listEmojisFor("w", false, { name: "parrot", limit: 2 }))).toEqual([
      ["Home", ["<:party_parrot:500000000000000001>", "<:parrot_sad:500000000000000003>"]], ["Far", []],
    ]);
    expect(names(await fm.listEmojisFor("w", false, { primary_only: "true", limit: "1" }))).toEqual([["Home", ["<:party_parrot:500000000000000001>"]]]);
    expect(names(await fm.listEmojisFor("w", false, { limit: "junk" })).flatMap((g: any) => g[1])).toHaveLength(4);
  });
});

describe("plumbing", () => {
  it("agend-agent: reply --sticker (repeatable, anywhere), emojis and stickers flags", () => {
    expect(splitFlags(["hi", "--sticker", "a", "/tmp/f.png", "--sticker", "b"], ["--sticker"])).toEqual({ flags: { "--sticker": ["a", "b"] }, positional: ["hi", "/tmp/f.png"] });
    expect(splitFlags(["--refresh", "cats", "--limit", "5"], ["--limit"], ["--refresh"])).toEqual({ flags: { "--refresh": [], "--limit": ["5"] }, positional: ["cats"] });
    expect(splitFlags(["--limit"], ["--limit"])).toEqual({ flags: {}, positional: ["--limit"] });
  });

  it("config: options.sticker_sets is Telegram's, and a list of set names", () => {
    const issues = (channel: Record<string, unknown>) => {
      const r = validateFleetConfig({ channel: { type: "telegram", bot_token_env: "X", group_id: -1, ...channel }, instances: {} });
      return [...r.errors, ...r.warnings].filter(i => i.path.includes("sticker_sets")).map(i => i.message);
    };
    expect(issues({ options: { sticker_sets: ["cats_by_bot"] } })).toEqual([]);
    expect(issues({ options: { sticker_sets: ["no spaces"] } })).toEqual([expect.stringContaining("sticker set names")]);
    expect(issues({ options: { sticker_sets: "cats" } })).toEqual([expect.stringContaining("sticker set names")]);
    expect(issues({ type: "discord", options: { sticker_sets: ["x"] } })).toEqual([expect.stringContaining("only Telegram")]);
  });
});
