/**
 * #1990: messages that send people to another topic link to it. The one helper (src/topic-link.ts): link forms per
 * surface, place tokens and their per-surface rendering, the plain-text fallback, Telegram `text_link` entities on the
 * real adapter (stub Bot API), the adapters' strip of a leftover token, the DM membership check, and the fleet's send
 * helper rendering a token for its world.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GroupMembership, hasPlaceRefs, instanceLink, messageLink, placeRef, placeSuffix, renderPlaceRefs, stripPlaceRefs,
  textLinksWithin, topicUrl, type PlaceLink, type PlaceTarget,
} from "../src/topic-link.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { FleetManager } from "../src/fleet-manager.js";

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }),
}));

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "topic-link-1990-")); dirs.push(d); return d; };

const GUILD = "111111111111111111", CHAN = "222222222222222222";
const TG = { type: "telegram", groupId: "-1001234567890" };

describe("link forms", () => {
  it("Telegram: the private form, or the public one when the group has a @username", () => {
    expect(topicUrl(TG, "42")).toBe("https://t.me/c/1234567890/42");
    expect(topicUrl({ ...TG, username: "agend_fleet" }, "42")).toBe("https://t.me/agend_fleet/42");
    expect(topicUrl({ ...TG, username: "bad name" }, "42")).toBe("https://t.me/c/1234567890/42");   // not a username: ignored
    expect(topicUrl({ ...TG, username: "ab" }, "42")).toBe("https://t.me/c/1234567890/42");         // too short to be one
    expect(messageLink({ ...TG, username: "agend_fleet" }, { chatId: TG.groupId, threadId: "42", messageId: "7" })).toBe("https://t.me/agend_fleet/42/7");
    // A message in another chat is never given the group's public name.
    expect(messageLink({ ...TG, username: "agend_fleet" }, { chatId: "-1009999", messageId: "7" })).toBe("https://t.me/c/9999/7");
  });
  it("Telegram's General topic (1) is linked only as General, never as an instance's topic", () => {
    expect(topicUrl(TG, "1")).toBeUndefined();
    expect(instanceLink(TG, "1")).toBeUndefined();
    expect(topicUrl(TG, "1", { general: true })).toBe("https://t.me/c/1234567890/1");
  });
  it("no link from an id that is not one", () => {
    expect(topicUrl({ type: "telegram", groupId: "12345" }, "42")).toBeUndefined();          // not a supergroup
    expect(topicUrl(TG, "4x")).toBeUndefined();
    expect(topicUrl({ type: "discord", groupId: "javascript:x" }, CHAN)).toBeUndefined();
    expect(topicUrl({ type: "discord", groupId: GUILD }, "general")).toBeUndefined();
    expect(topicUrl({ type: "web" }, "42")).toBeUndefined();
    expect(topicUrl(undefined, "42")).toBeUndefined();
  });
  it("Discord: a channel mention in place, a URL for a browser", () => {
    expect(instanceLink({ type: "discord", groupId: GUILD }, CHAN)).toBe(`<#${CHAN}>`);
    expect(topicUrl({ type: "discord", groupId: GUILD }, CHAN)).toBe(`https://discord.com/channels/${GUILD}/${CHAN}`);
  });
});

const general: PlaceTarget = { kind: "general" };
const dev: PlaceTarget = { kind: "instance", name: "dev-a" };
const URL_G = "https://t.me/c/1234567890/1";
const URL_DEV = "https://t.me/c/1234567890/42";
const tgResolve = (t: PlaceTarget): PlaceLink | undefined => t.kind === "general" ? { url: URL_G } : t.name === "dev-a" ? { url: URL_DEV } : undefined;
const dcResolve = (t: PlaceTarget): PlaceLink | undefined => t.kind === "general" ? { mention: "<#1>" } : t.name === "dev-a" ? { mention: "<#42>" } : undefined;

describe("place tokens", () => {
  const text = `ℹ️ /web works in the General topic — please use it there.${placeSuffix(general, "General")}`;

  it("Telegram: plain text, the label carrying a text_link at its UTF-16 offset", () => {
    const out = renderPlaceRefs(text, "telegram", tgResolve);
    expect(out.text).toBe("ℹ️ /web works in the General topic — please use it there. → General");
    expect(out.textLinks).toEqual([{ offset: out.text.length - "General".length, length: "General".length, url: URL_G }]);
    expect(out.text.slice(out.textLinks[0].offset, out.textLinks[0].offset + out.textLinks[0].length)).toBe("General");
  });
  it("Discord: an arrow and the mention; an inline name keeps its label", () => {
    expect(renderPlaceRefs(text, "discord", dcResolve).text).toBe("ℹ️ /web works in the General topic — please use it there. → <#1>");
    expect(renderPlaceRefs(`${placeRef(dev, "dev-a")} stopped.`, "discord", dcResolve)).toEqual({ text: "dev-a (<#42>) stopped.", textLinks: [] });
    // A URL (a DM) is wrapped in <> so Discord adds no embed.
    expect(renderPlaceRefs(`${placeRef(dev, "dev-a")} stopped.`, "discord", () => ({ url: "https://discord.com/channels/1/2" })).text)
      .toBe("dev-a (<https://discord.com/channels/1/2>) stopped.");
  });
  it("plain, or a target that cannot be linked: the label stays, a suffix goes with its space", () => {
    expect(renderPlaceRefs(text, "plain", tgResolve)).toEqual({ text: "ℹ️ /web works in the General topic — please use it there.", textLinks: [] });
    expect(renderPlaceRefs(text, "telegram", () => undefined).text).toBe("ℹ️ /web works in the General topic — please use it there.");
    const unknown: PlaceTarget = { kind: "instance", name: "ghost" };
    expect(renderPlaceRefs(`${placeRef(unknown, "ghost")} and ${placeRef(dev, "dev-a")}`, "telegram", tgResolve)).toEqual({
      text: "ghost and dev-a", textLinks: [{ offset: "ghost and ".length, length: 5, url: URL_DEV }],
    });
    expect(stripPlaceRefs(`${placeRef(dev, "dev-a")} is waiting.${placeSuffix(general, "General")}`)).toBe("dev-a is waiting.");
  });
  it("offsets count UTF-16 units: emoji, CJK and astral characters before a link", () => {
    const t = `🧑‍💻 「測試」𝒳 ${placeRef(dev, "dev-a")} 等你 ${placeRef(general, "總部")}`;
    const out = renderPlaceRefs(t, "telegram", tgResolve);
    expect(out.text).toBe("🧑‍💻 「測試」𝒳 dev-a 等你 總部");
    expect(out.textLinks.map(l => out.text.slice(l.offset, l.offset + l.length))).toEqual(["dev-a", "總部"]);
  });
  it("the rest of the text is copied byte for byte: nothing to escape on either platform", () => {
    const hostile = "a & b < c > d _e_ *f* [g](h) ~i~ `j` | k \\ l <#9> <@1> **m**";
    for (const surface of ["telegram", "discord", "plain"] as const) {
      const out = renderPlaceRefs(`${hostile} ${placeRef(dev, "dev-a")} ${hostile}`, surface, surface === "discord" ? dcResolve : tgResolve);
      expect(out.text.startsWith(`${hostile} `)).toBe(true);
      expect(out.text.endsWith(` ${hostile}`)).toBe(true);
    }
  });
  it("a label cannot carry a marker, and a stray marker is not a token", () => {
    const forged = placeRef(dev, "xy");
    expect(renderPlaceRefs(forged, "telegram", tgResolve).text).toBe("xy");
    expect(renderPlaceRefs("a  b", "telegram", tgResolve)).toEqual({ text: "a  b", textLinks: [] });
    expect(hasPlaceRefs("plain")).toBe(false);
  });
  it("a name with any characters round-trips through the token", () => {
    const odd: PlaceTarget = { kind: "instance", name: "a b/ç:%" };
    let seen: PlaceTarget | undefined;
    renderPlaceRefs(placeRef(odd, "x"), "telegram", t => { seen = t; return undefined; });
    expect(seen).toEqual(odd);
  });
  it("text links per chunk: re-based, and one across the boundary dropped", () => {
    const links = [{ offset: 2, length: 3, url: "https://a" }, { offset: 9, length: 4, url: "https://b" }, { offset: 12, length: 2, url: "https://c" }];
    expect(textLinksWithin(links, 0, 10)).toEqual([{ offset: 2, length: 3, url: "https://a" }]);
    expect(textLinksWithin(links, 10, 20)).toEqual([{ offset: 2, length: 2, url: "https://c" }]);
  });
});

describe("GroupMembership: a DM links only for a confirmed member", () => {
  const clock = () => { let t = 0; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

  it("member: true; not a member, an error, or no way to ask: false", async () => {
    const c = clock();
    const m = new GroupMembership({ now: c.now });
    expect(await m.isMember({ isGroupMember: async () => true }, "g", "u")).toBe(true);
    expect(await m.isMember({ isGroupMember: async () => false }, "g", "u2")).toBe(false);
    expect(await m.isMember({ isGroupMember: async () => { throw new Error("403"); } }, "g", "u3")).toBe(false);
    expect(await m.isMember({ isGroupMember: () => { throw new Error("sync"); } }, "g", "u4")).toBe(false);
    expect(await m.isMember({}, "g", "u5")).toBe(false);
    expect(await m.isMember({ isGroupMember: async () => true }, "", "u6")).toBe(false);
  });
  it("one read per (group, user) per 10 minutes, failures included; concurrent asks share it", async () => {
    const c = clock();
    const m = new GroupMembership({ now: c.now });
    const ask = vi.fn(async () => true);
    await Promise.all([m.isMember({ isGroupMember: ask }, "g", "u"), m.isMember({ isGroupMember: ask }, "g", "u")]);
    expect(ask).toHaveBeenCalledTimes(1);
    c.advance(9 * 60_000);
    await m.isMember({ isGroupMember: ask }, "g", "u");
    expect(ask).toHaveBeenCalledTimes(1);
    c.advance(61_000);
    await m.isMember({ isGroupMember: ask }, "g", "u");
    expect(ask).toHaveBeenCalledTimes(2);
    const fail = vi.fn(async () => { throw new Error("x"); });
    await m.isMember({ isGroupMember: fail }, "g", "v");
    await m.isMember({ isGroupMember: fail }, "g", "v");
    expect(fail).toHaveBeenCalledTimes(1);
  });
  it("a read that does not answer in time is a no, and does not hold the caller", async () => {
    vi.useFakeTimers();
    const m = new GroupMembership({ now: () => 0, deadlineMs: 5_000 });
    const answer = m.isMember({ isGroupMember: () => new Promise<boolean>(() => {}) }, "g", "u");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await answer).toBe(false);
  });
  it("the cache is bounded", async () => {
    const m = new GroupMembership({ now: () => 0, maxEntries: 2 });
    const ask = vi.fn(async () => true);
    for (const u of ["a", "b", "c"]) await m.isMember({ isGroupMember: ask }, "g", u);
    await m.isMember({ isGroupMember: ask }, "g", "a");   // evicted: asked again
    await m.isMember({ isGroupMember: ask }, "g", "c");   // still cached
    expect(ask).toHaveBeenCalledTimes(4);
  });
});

/** The real Telegram adapter over a stub Bot API: what each method sends. */
function telegram(answers: Record<string, (payload: any) => unknown> = {}) {
  const calls: Array<{ method: string; payload: any }> = [];
  const adapter = new TelegramAdapter({ id: "tg", botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", accessManager: { isAllowed: () => ({ allowed: true }) } as never, inboxDir: tmp() });
  const bot = adapter.getBot();
  (bot as any).botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
  (bot as any).api.config.use(async (_prev: unknown, method: string, payload: any) => {
    calls.push({ method, payload });
    const answer = answers[method];
    if (answer) return { ok: true, result: await answer(payload) };
    return { ok: true, result: { message_id: calls.length, date: 1, chat: { id: Number(payload.chat_id), type: "supergroup" }, text: payload.text } };
  });
  return { adapter, calls };
}

describe("Telegram adapter: text_link entities", () => {
  const rendered = renderPlaceRefs(`dev-a is waiting. ${placeRef(general, "General")} & <b>`, "telegram", tgResolve);

  it("a plain send carries the links as entities, no parse mode, no preview", async () => {
    const { adapter, calls } = telegram();
    await adapter.sendText("-1001234567890", rendered.text, { threadId: "42", textLinks: rendered.textLinks });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("sendMessage");
    expect(calls[0].payload).toMatchObject({
      text: "dev-a is waiting. General & <b>", message_thread_id: 42,
      entities: [{ type: "text_link", offset: 18, length: 7, url: URL_G }], link_preview_options: { is_disabled: true },
    });
    expect(calls[0].payload.parse_mode).toBeUndefined();
  });
  it("sendDirect, a button alert and its edit carry them too", async () => {
    const { adapter, calls } = telegram({ editMessageText: () => true });
    await adapter.sendDirect("777", rendered.text, { textLinks: rendered.textLinks });
    await adapter.notifyAlert("-1001234567890", { type: "needs_you", instanceName: "", message: rendered.text, choices: [{ id: "c", label: "OK" }] }, { textLinks: rendered.textLinks });
    await adapter.editAlert("-1001234567890", "5", { type: "needs_you", instanceName: "", message: rendered.text, choices: [] }, { textLinks: rendered.textLinks });
    expect(calls.map(c => c.method)).toEqual(["sendMessage", "sendMessage", "editMessageText"]);
    for (const c of calls) expect(c.payload.entities).toEqual([{ type: "text_link", offset: 18, length: 7, url: URL_G }]);
  });
  it("no entities for markdown/html, a link outside the text or not https, or a text longer than one message", async () => {
    const { adapter, calls } = telegram();
    await adapter.sendText("-100123", "hello", { format: "html", textLinks: [{ offset: 0, length: 5, url: URL_G }] });
    await adapter.sendText("-100123", "hello", { textLinks: [{ offset: 3, length: 5, url: URL_G }] });
    await adapter.sendText("-100123", "hello", { textLinks: [{ offset: 0, length: 5, url: "tg://resolve?domain=x" }] });
    await adapter.sendText("-100123", "x".repeat(30), { chunkLimit: 20, textLinks: [{ offset: 0, length: 5, url: URL_G }] });
    for (const c of calls) expect(c.payload.entities).toBeUndefined();
  });
  it("a token that reaches the adapter unrendered goes out as its label, never raw", async () => {
    const { adapter, calls } = telegram({ editMessageText: () => true });
    const raw = `${placeRef(dev, "dev-a")} stopped.${placeSuffix(general, "General")}`;
    await adapter.sendText("-100123", raw);
    await adapter.sendDirect("777", raw);
    await adapter.notifyAlert("-100123", { type: "x", instanceName: "", message: raw, choices: [{ id: "c", label: "OK" }] } as any);
    await adapter.editMessage("-100123", "5", raw);
    for (const c of calls) expect(c.payload.text).toBe("dev-a stopped.");
  });
  it("membership: member, admin, owner and a restricted member are in; left, kicked and a restricted non-member are not", async () => {
    for (const [status, extra, expected] of [
      ["member", {}, true], ["administrator", {}, true], ["creator", {}, true], ["restricted", { is_member: true }, true],
      ["restricted", { is_member: false }, false], ["left", {}, false], ["kicked", {}, false],
    ] as const) {
      const { adapter, calls } = telegram({ getChatMember: () => ({ status, user: { id: 9, is_bot: false, first_name: "u" }, ...extra }) });
      expect(await adapter.isGroupMember("-1001234567890", "9")).toBe(expected);
      expect(calls[0].payload).toMatchObject({ chat_id: -1001234567890, user_id: 9 });
    }
    const { adapter, calls } = telegram();
    expect(await adapter.isGroupMember("-100123", "not-a-user")).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("the group's @username: read once in the background, never waited on", async () => {
    const { adapter, calls } = telegram({ getChat: () => ({ id: -1001234567890, type: "supergroup", title: "Fleet", username: "agend_fleet" }) });
    expect(adapter.groupUsername("-1001234567890")).toBeUndefined();   // not read yet: no waiting
    await new Promise(r => setImmediate(r));
    expect(adapter.groupUsername("-1001234567890")).toBe("agend_fleet");
    expect(calls.filter(c => c.method === "getChat")).toHaveLength(1);
    expect(adapter.groupUsername("12345")).toBeUndefined();           // not a supergroup: not asked
    expect(calls.filter(c => c.method === "getChat")).toHaveLength(1);
  });
});

describe("Discord adapter: guild membership and the leftover-token strip", () => {
  function discord(fetchMember: (arg: unknown) => Promise<unknown>) {
    const a = new DiscordAdapter({ id: "discord", botToken: "t", accessManager: { canRead: () => true, canWrite: () => true } as any, inboxDir: tmp(), guildId: GUILD } as any);
    const guilds = { fetch: vi.fn(async (id: string) => { expect(id).toBe(GUILD); return { members: { fetch: fetchMember } }; }) };
    (a as any).readyClient = async () => ({ guilds });
    return { a, guilds };
  }
  it("a member read for this guild only; an unknown member or any error rejects", async () => {
    expect(await discord(async () => ({ id: "1" })).a.isGroupMember(GUILD, "123456789012345678")).toBe(true);
    await expect(discord(async () => { throw new Error("Unknown Member"); }).a.isGroupMember(GUILD, "123456789012345678")).rejects.toThrow();
    const other = discord(async () => ({ id: "1" }));
    expect(await other.a.isGroupMember("999999999999999999", "123456789012345678")).toBe(false);   // another guild: never asked
    expect(await other.a.isGroupMember(GUILD, "not-an-id")).toBe(false);
    expect(other.guilds.fetch).not.toHaveBeenCalled();
  });
  it("#1997 review: always a read from Discord — a member still in the cache who has left is not one", async () => {
    // discord.js returns a cached member for fetch(id) / force:false without asking Discord; with force it asks.
    const fetchMember = vi.fn(async (arg: unknown) => {
      if (typeof arg === "string" || !(arg as { force?: boolean }).force) return { id: "123456789012345678" };
      throw Object.assign(new Error("Unknown Member"), { code: 10007 });
    });
    const { a } = discord(fetchMember);
    await expect(a.isGroupMember(GUILD, "123456789012345678")).rejects.toThrow("Unknown Member");
    expect(fetchMember).toHaveBeenCalledWith({ user: "123456789012345678", force: true });
    // …and GroupMembership turns that rejection into no links.
    expect(await new GroupMembership({ now: () => 0 }).isMember(a, GUILD, "123456789012345678")).toBe(false);
  });
  it("a token that reaches sendText unrendered goes out as its label", async () => {
    const { a } = discord(async () => ({}));
    const send = vi.fn(async (c: unknown) => ({ id: "m1", content: c }));
    (a as any)._fetchTextChannel = async () => ({ send });
    await a.sendText(GUILD, `${placeRef(dev, "dev-a")} stopped.${placeSuffix(general, "General")}`, { threadId: CHAN });
    expect(send).toHaveBeenCalledWith("dev-a stopped.");
  });
});

describe("the fleet's send helper renders tokens for its world", () => {
  function fleet(type: "telegram" | "discord") {
    const fm = new FleetManager(tmp()) as any;
    const group = type === "telegram" ? "-1001234567890" : GUILD;
    const cfg = { id: type, type, mode: "topic", group_id: group };
    fm.fleetConfig = {
      defaults: {}, channels: [cfg],
      instances: {
        general: { general_topic: true, topic_id: type === "telegram" ? "1" : "333333333333333333" },
        "dev-a": { topic_id: type === "telegram" ? "42" : CHAN },
        classic: {},
        elsewhere: { topic_id: "77", channel_id: "second" },
      },
    };
    const sendText = vi.fn().mockResolvedValue({});
    fm.worlds.set(type, { id: type, type, adapter: { id: type, sendText }, channelConfig: cfg, groupId: group });
    fm.adapter = fm.worlds.get(type).adapter;
    return { fm, sendText };
  }

  it("Telegram: links to General and to another instance's topic as entities", () => {
    const { fm, sendText } = fleet("telegram");
    fm.notifyInstanceTopic("dev-a", `${placeRef({ kind: "instance", name: "dev-a" }, "dev-a")} needs you.${placeSuffix(general, "General")}`);
    expect(sendText).toHaveBeenCalledWith("-1001234567890", "dev-a needs you. → General", {
      threadId: "42",
      textLinks: [{ offset: 0, length: 5, url: URL_DEV }, { offset: "dev-a needs you. → ".length, length: 7, url: URL_G }],
    });
  });
  it("Discord: channel mentions", () => {
    const { fm, sendText } = fleet("discord");
    fm.notifyInstanceTopic("dev-a", `${placeRef({ kind: "instance", name: "dev-a" }, "dev-a")} needs you.${placeSuffix(general, "General")}`);
    expect(sendText).toHaveBeenCalledWith(GUILD, `dev-a (<#${CHAN}>) needs you. → <#333333333333333333>`, { threadId: CHAN });
  });
  it("an instance with no fleet topic, or one the fleet does not know, is named in plain text", () => {
    const { fm, sendText } = fleet("telegram");
    fm.notifyInstanceTopic("dev-a", `${placeRef({ kind: "instance", name: "classic" }, "classic")} / ${placeRef({ kind: "instance", name: "nope" }, "nope")}`);
    expect(sendText).toHaveBeenCalledWith("-1001234567890", "classic / nope", { threadId: "42" });
  });
  it("an instance in another world (another bot or platform) is named in plain text", () => {
    const { fm, sendText } = fleet("telegram");
    fm.notifyInstanceTopic("dev-a", `${placeRef({ kind: "instance", name: "elsewhere" }, "elsewhere")} replied`);
    expect(sendText).toHaveBeenCalledWith("-1001234567890", "elsewhere replied", { threadId: "42" });
  });
  it("a notice into a ClassicBot room names places in plain text (its readers need not be in the group)", () => {
    const { fm, sendText } = fleet("discord");
    fm.classicChannels = { getChannelIdByInstance: (n: string) => n === "room" ? "444444444444444444" : undefined, getAdapterIdByInstance: () => "discord" };
    fm.notifyInstanceTopic("room", `${placeRef({ kind: "instance", name: "dev-a" }, "dev-a")} is waiting.${placeSuffix(general, "General")}`);
    expect(sendText).toHaveBeenCalledWith("444444444444444444", "dev-a is waiting.", undefined);
  });
  it("a text without tokens is sent exactly as before", () => {
    const { fm, sendText } = fleet("telegram");
    fm.notifyInstanceTopic("dev-a", "plain notice");
    expect(sendText).toHaveBeenCalledWith("-1001234567890", "plain notice", { threadId: "42" });
  });
});
