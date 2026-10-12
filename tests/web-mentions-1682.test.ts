/**
 * #1682 (design: the comment on #1682): Discord mentions in the web chat as pills — `<@id>` / `<@!id>` (users), `<@&id>`
 * (roles), `<#id>` (channels) with the names the host knows (GET /ui/mentions: only the ids asked, from memory), an
 * unknown id as @user / @role / #channel, a Telegram @username styled the same, nothing inside code, names escaped.
 * The real renderer, store pieces, route handler, FleetManager sources and the Discord adapter's cache read.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/ui/chat-render.js";
import { MAX_MENTION_IDS, SeenUsers, parseMentionQuery, resolveMentions } from "../src/web-mentions.js";
import { handleWebRequest } from "../src/web-api.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { isPassiveWebRead } from "../src/web-auth.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
// @ts-expect-error — a JS module of the app, with no types
import { createMentionIndex } from "../src/ui/chat-mentions.js";

const R = () => (globalThis as any).AgendChatRender;
const USER = "368442276000694273", ROLE = "111111111111111111", CHANNEL = "222222222222222222", NOBODY = "999999999999999999";
const NAMES: Record<string, string> = { [`u:${USER}`]: "Han", [`r:${ROLE}`]: "Ops", [`c:${CHANNEL}`]: "general" };
const lookup = (kind: string, id: string) => NAMES[`${kind}:${id}`] ?? null;
const render = (text: string, names: ((k: string, id: string) => string | null) | null = lookup) => R().renderMarkdown(text, names ? { mentions: names } : {});
/** The pills of a rendered message: [kind:id, label]. */
const pills = (html: string) => [...html.matchAll(/<span class="mention(?: tg)?"(?: data-mention="([^"]+)" title="\d+")?>([^<]*)<\/span>/g)].map((m) => [m[1] ?? "tg", m[2]]);

describe("the renderer draws mentions as pills", () => {
  it("a known <@id>: a pill with the name (the id in its title), never the raw token", () => {
    const html = render(`hi <@${USER}>`);
    expect([pills(html), html.includes(`title="${USER}"`), html.includes("&lt;@")]).toEqual([[[`u:${USER}`, "@Han"]], true, false]);
  });
  it("an unknown id: @user (and @role, #channel) — never the raw token", () => {
    const html = render(`<@${NOBODY}> <@&${NOBODY}> <#${NOBODY}>`, () => null);
    expect([pills(html), html.includes("&lt;")]).toEqual([[[`u:${NOBODY}`, "@user"], [`r:${NOBODY}`, "@role"], [`c:${NOBODY}`, "#channel"]], false]);
  });
  it("<@!id>, a role <@&id> and a channel <#id>", () => {
    expect(pills(render(`<@!${USER}> <@&${ROLE}> <#${CHANNEL}>`))).toEqual([[`u:${USER}`, "@Han"], [`r:${ROLE}`, "@Ops"], [`c:${CHANNEL}`, "#general"]]);
  });
  it("a Telegram @username is styled the same (no lookup, no link); an e-mail, a URL path and a short handle are not", () => {
    const html = render("ping @telegram_user, mail han@example.com, see https://x.com/@someone and @abc");
    expect([pills(html), html.includes("<a "), (html.match(/class="mention/g) || []).length]).toEqual([[["tg", "@telegram_user"]], true, 1]);
  });
  it("#1684 r1: an @ inside a link is never touched — every URL stays a link, as on main", () => {
    const linked = ["see https://example.com/?q=@someone ok", "[x](https://example.com/?u=@someone)", "https://example.com/?a=1&b=@someone",
      "https://example.com/#@someone", "https://example.com/?x=1,@someone"].map((t) => {
      const html = render(t);
      return [(html.match(/<a href="[^"]*@someone"/g) || []).length, html.includes("mention")];
    });
    expect(linked).toEqual(Array(5).fill([1, false]));
  });
  it("#1684 r1: a package or a path is not a handle — @scope/pkg, @anthropic-ai/sdk stay text", () => {
    expect(pills(render("npm i @anthropic-ai/sdk and @scopex/pkg, then ask @telegram_user"))).toEqual([["tg", "@telegram_user"]]);
  });
  it("nothing inside code is converted — a code span or a fence keeps the token as text", () => {
    const html = render("`<@" + USER + ">` and `@telegram_user`\n\n```\n<@" + USER + "> @telegram_user\n```");
    expect([pills(html), (html.match(/&lt;@368442276000694273&gt;/g) || []).length]).toEqual([[], 2]);
  });
  it("an HTML-ish name is escaped (text, never markup)", () => {
    const html = render(`<@${USER}>`, () => `<img src=x onerror=alert(1)>&amp;`);
    expect([html.includes("<img"), pills(html)]).toEqual([false, [[`u:${USER}`, "@&lt;img src=x onerror=alert(1)&gt;&amp;amp;"]]]);
  });
  it("a name is the pill's text only: Markdown in it is not applied (the pill is done before emphasis and links)", () => {
    const html = render(`<@${USER}>`, () => "_x_ **y** https://e.com");
    expect([pills(html), html.includes("<em>"), html.includes("<strong>"), html.includes("<a ")]).toEqual([[[`u:${USER}`, "@_x_ **y** https://e.com"]], false, false, false]);
  });
  it("the screenshot case: <@id> opening an agent reply is one pill, the rest of the text as it was", () => {
    const html = render(`<@${USER}> 查完了，明天可以照計畫發。\n\n• v1.5.0 和 **origin/main**`);
    expect([pills(html), html.startsWith(`<p><span class="mention" data-mention="u:${USER}"`), html.includes("查完了"), html.includes("<strong>origin/main</strong>")])
      .toEqual([[[`u:${USER}`, "@Han"]], true, true, true]);
  });
  it("with no names known at all (the page has none yet), still pills", () => {
    expect(pills(render(`<@${USER}>`, null))).toEqual([[`u:${USER}`, "@user"]]);
  });
});

describe("the host: /ui/mentions", () => {
  it("parses ids: digits only, each once, at most 100 in all, no other parameter", () => {
    const q = (s: string) => parseMentionQuery(new URLSearchParams(s));
    const many = Array.from({ length: MAX_MENTION_IDS + 1 }, (_, i) => String(100000000000000000n + BigInt(i))).join(",");
    expect([q(`u=${USER},${USER}&r=${ROLE}&c=${CHANNEL}`), q("u=abc").ok, q("u=12").ok, q(`u=${many}`).ok, q(`x=${USER}`).ok, q("").ok])
      .toEqual([{ ok: true, query: { u: [USER], r: [ROLE], c: [CHANNEL] } }, false, false, false, false, true]);
  });
  it("remembers the people seen, bounded (the oldest go), ids that are Discord ids only", () => {
    const s = new SeenUsers(2);
    s.record("123", "short"); s.record(USER, "Han"); s.record(ROLE, "A"); s.record(CHANNEL, "B");
    expect([s.get("123"), s.get(USER), s.get(ROLE), s.get(CHANNEL), s.size]).toEqual([undefined, undefined, "A", "B", 2]);
  });
  it("names come from the sources in order, only for the ids asked", () => {
    const out = resolveMentions({ u: [USER, NOBODY], r: [ROLE], c: [] }, [
      () => ({ u: { [USER]: "From bots" } }),
      () => ({ u: { [USER]: "Later", [NOBODY]: "Second" }, r: { [ROLE]: "Ops", [CHANNEL]: "not asked" } }),
      () => { throw new Error("a broken source is skipped"); },
    ]);
    expect(out).toEqual({ u: { [USER]: "From bots", [NOBODY]: "Second" }, r: { [ROLE]: "Ops" }, c: {} });
  });
  function get(path: string, ctx: Record<string, unknown>) {
    const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { host: "127.0.0.1:19280", "x-agend-token": "t".repeat(48) } });
    let status = 0, body = "";
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => { body = String(t); } });
    handleWebRequest(req as never, res as never, new URL(path, "http://127.0.0.1:19280"), { webToken: "t".repeat(48), logger: { debug() {}, info() {}, error() {} }, ...ctx } as never);
    return { status, json: () => JSON.parse(body) };
  }
  it("answers the names of the ids asked (the query passed on as parsed); a bad query is a 400 that asks nothing", () => {
    const webMentionNames = vi.fn(() => ({ u: { [USER]: "Han" }, r: {}, c: {} }));
    const ok = get(`/ui/mentions?u=${USER}`, { webMentionNames });
    const bad = get("/ui/mentions?u=not-an-id", { webMentionNames });
    expect([ok.status, ok.json(), webMentionNames.mock.calls, bad.status]).toEqual([200, { u: { [USER]: "Han" }, r: {}, c: {} }, [[{ u: [USER], r: [], c: [] }]], 400]);
  });
  it("is offered on the public link (names only for ids it shows) and is the page's read, not the person's", () => {
    expect([isPublicWebRoute("GET", "/ui/mentions"), isPublicWebRoute("POST", "/ui/mentions"), isPassiveWebRead("GET", "/ui/mentions")]).toEqual([true, false, true]);
  });
});

describe("FleetManager's sources", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  async function fleet() {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = Object.create(FleetManager.prototype) as InstanceType<typeof FleetManager> & Record<string, any>;
    const dir = mkdtempSync(join(tmpdir(), "mentions-1682-")); dirs.push(dir);
    const cache = { mentionNames: (q: { u: string[]; r: string[]; c: string[] }) => ({ u: Object.fromEntries(q.u.filter((id) => id === NOBODY).map((id) => [id, "Cached member"])), r: { [ROLE]: "Ops" }, c: { [CHANNEL]: "general" } }) };
    Object.assign(fm, {
      dataDir: dir, fleetConfig: { instances: { sentinel: { working_directory: dir, display_name: "Sentinel" } } },
      adapters: new Map<string, unknown>([["own", { getBotUserId: () => "555555555555555555" }], ["discord", cache]]),
      seenUsers: new SeenUsers(), ownBots: () => new Map([["sentinel", "own"]]),
    });
    return fm;
  }
  it("a fleet bot is its instance's label; a person seen inbound by their name; the rest from the Discord caches", async () => {
    const fm = await fleet();
    fm.seenUsers.record(USER, "Han");
    expect(fm.webMentionNames({ u: ["555555555555555555", USER, NOBODY], r: [ROLE], c: [CHANNEL] }))
      .toEqual({ u: { "555555555555555555": "Sentinel", [USER]: "Han", [NOBODY]: "Cached member" }, r: { [ROLE]: "Ops" }, c: { [CHANNEL]: "general" } });
  });
  it("an inbound message from a person is remembered by id; a bot's is not", async () => {
    const fm = await fleet();
    Object.assign(fm, { worlds: new Map(), logger: { debug() {}, info() {}, warn() {}, error() {} } });
    await (fm as any).handleInboundMessage({ source: "discord", userId: USER, username: "Han", text: "hi", chatId: "c", messageId: "m", timestamp: new Date() } as never).catch(() => {});
    await (fm as any).handleInboundMessage({ source: "discord", userId: ROLE, username: "SomeBot", text: "hi", chatId: "c", messageId: "m2", timestamp: new Date(), isBotMessage: true } as never).catch(() => {});
    expect([fm.seenUsers.get(USER), fm.seenUsers.get(ROLE)]).toEqual(["Han", undefined]);
  });
});

describe("the Discord adapter names from its own caches (no request)", () => {
  it("a member's display name first, then the user; roles from the guilds; channels by name", () => {
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    const map = (entries: Array<[string, unknown]>) => ({ cache: new Map(entries) });
    (adapter as any).client = {
      guilds: map([["g1", { members: map([[USER, { displayName: "Han (server)" }]]), roles: map([[ROLE, { name: "Ops" }]]) }]]),
      users: map([[USER, { username: "han", globalName: "Han" }], [NOBODY, { username: "other", globalName: null }]]),
      channels: map([[CHANNEL, { name: "general" }]]),
    };
    expect(adapter.mentionNames({ u: [USER, NOBODY, "777777777777777777"], r: [ROLE, NOBODY], c: [CHANNEL, NOBODY] }))
      .toEqual({ u: { [USER]: "Han (server)", [NOBODY]: "other" }, r: { [ROLE]: "Ops" }, c: { [CHANNEL]: "general" } });
  });
});

describe("the page asks once per id, only for what its messages carry", () => {
  it("one request with the ids by kind; names applied and the thread told; an id never asked twice; >100 split", async () => {
    const calls: string[] = [];
    const idx = createMentionIndex(async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ u: { [USER]: "Han" }, r: {}, c: { [CHANNEL]: "general" } }) };
    });
    const told = vi.fn();
    idx.subscribe(told);
    const msgs = [{ text: `<@!${USER}> see <#${CHANNEL}> and <@&${ROLE}>` }, { text: "no mention here" }, { text: `<@${USER}> again` }];
    idx.ensure(msgs);
    await new Promise((r) => setTimeout(r, 0));
    idx.ensure(msgs);                                         // nothing new: no request
    await new Promise((r) => setTimeout(r, 0));
    const many = Array.from({ length: 150 }, (_, i) => ({ text: `<@${String(300000000000000000n + BigInt(i))}>` }));
    idx.ensure(many);
    await new Promise((r) => setTimeout(r, 0));
    const decoded = calls.map((u) => decodeURIComponent(u));
    expect([decoded[0], idx.name("u", USER), idx.name("c", CHANNEL), idx.name("r", ROLE), told.mock.calls.length, calls.length,
      decoded.slice(1).map((u) => (u.match(/\d{18}/g) || []).length)])
      .toEqual([`/ui/mentions?u=${USER}&r=${ROLE}&c=${CHANNEL}`, "Han", "general", null, 1, 3, [100, 50]]);
  });
});
