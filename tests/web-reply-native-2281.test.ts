/**
 * #2281: a web chat reply's copy in Discord or Telegram is a native reply there, when the message it quotes is known in
 * that same place; otherwise it keeps the quoted line (#2272), as before.
 *
 * - The adapters honour `SendOpts.replyTo`: Discord `reply.messageReference` (failIfNotExists: false), Telegram
 *   `reply_parameters` (allow_sending_without_reply), on a message's first part only; a refusal over the reply itself
 *   is sent again plain once (nothing was posted); any other failure is the send's own.
 * - Web history keeps each message's platform posts beside the row (inbound, an agent reply that landed in the topic, a
 *   web message's channel copy), on disk too, validated on restore — never in a row, so no page, guest or public link
 *   ever sees one.
 * - The echo (topic and ClassicBot room) replies natively when the quoted message has a post in that same place.
 *
 * Real adapters with their platform API stubbed; the real FleetManager web server on a scratch home (nothing started).
 */
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "agend-native-reply-home-"));
process.env.AGEND_HOME = home;

const { TelegramAdapter } = await import("../src/channel/adapters/telegram.js");
const { DiscordAdapter } = await import("../src/channel/adapters/discord.js");
const { WebChatHistory, WEB_CHAT_POSTS_MAX } = await import("../src/web-chat-history.js");

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

describe("Telegram: SendOpts.replyTo is a native reply", () => {
  function tg(answer: (payload: any, n: number) => unknown = () => null) {
    const dir = mkdtempSync(join(tmpdir(), "agend-native-reply-tg-")); dirs.push(dir);
    const adapter = new TelegramAdapter({ id: "tg", botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", accessManager: { isAllowed: () => ({ allowed: true }) } as never, inboxDir: dir });
    const calls: any[] = [];
    (adapter.getBot() as any).api.config.use(async (_prev: unknown, method: string, payload: any) => {
      if (method !== "sendMessage") throw new Error(`unexpected Bot API ${method}`);
      calls.push(payload);
      const special = answer(payload, calls.length);
      if (special) return special;
      return { ok: true, result: { message_id: 100 + calls.length, date: 1, chat: { id: -100123, type: "supergroup" }, text: payload.text } };
    });
    return { adapter, calls };
  }
  it("the first part replies to the message (allow_sending_without_reply: sent anyway if it was deleted); later parts do not", async () => {
    const { adapter, calls } = tg();
    const sent = await adapter.sendText("-100123", "a".repeat(10), { threadId: "77", replyTo: "555", chunkLimit: 4, replyButtons: [{ id: "rb:s:0", label: "OK" }] });
    expect([calls.map(c => c.reply_parameters ?? null), calls[0].message_thread_id, sent.messageId]).toEqual([
      [{ message_id: 555, allow_sending_without_reply: true }, null, null], 77, "101"]);
  });
  it("a plain send too; an id that is not Telegram's is no reply", async () => {
    const { adapter, calls } = tg();
    await adapter.sendText("-100123", "hello", { replyTo: "555", format: "text" });
    await adapter.sendText("-100123", "hello", { replyTo: "web-1700000000000", format: "text" });
    expect(calls.map(c => c.reply_parameters ?? null)).toEqual([{ message_id: 555, allow_sending_without_reply: true }, null]);
  });
  it("a refusal over the reply itself is sent again once without it; any other failure is the send's own (no second send)", async () => {
    const refused = tg((p) => (p.reply_parameters ? { ok: false, error_code: 400, description: "Bad Request: message to be replied not found" } : null));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent = await refused.adapter.sendText("-100123", "hello", { replyTo: "555", format: "text" });
    const other = tg(() => ({ ok: false, error_code: 403, description: "Forbidden: bot was kicked" }));
    await expect(other.adapter.sendText("-100123", "hello", { replyTo: "555", format: "text" })).rejects.toThrow(/kicked/);
    // A 400 over something else — the keyboard (reply markup) — is refused plain too: not sent again.
    const markup = tg(() => ({ ok: false, error_code: 400, description: "Bad Request: REPLY_MARKUP_INVALID" }));
    await expect(markup.adapter.sendText("-100123", "hello", { replyTo: "555", replyButtons: [{ id: "rb:s:0", label: "OK" }] })).rejects.toThrow(/REPLY_MARKUP/);
    expect([refused.calls.map(c => c.reply_parameters ? "reply" : "plain"), sent.messageId, other.calls.length, markup.calls.length]).toEqual([["reply", "plain"], "102", 1, 1]);
  });
});

describe("Discord: SendOpts.replyTo is a native reply", () => {
  function dc(send: (payload: unknown, n: number) => unknown) {
    const dir = mkdtempSync(join(tmpdir(), "agend-native-reply-dc-")); dirs.push(dir);
    const calls: unknown[] = [];
    const channel = { isTextBased: () => true, send: vi.fn(async (p: unknown) => { calls.push(p); return send(p, calls.length); }) };
    const fetch = vi.fn(async () => channel);
    const a = new DiscordAdapter({
      id: "dc", botToken: "t", accessManager: { canRead: () => true, canWrite: () => true } as any, inboxDir: dir, guildId: "1496407196106494055", registerCommands: false,
      clientFactory: () => ({ isReady: () => true, channels: { fetch }, on: () => {}, once: () => {}, destroy: vi.fn(async () => {}) }) as any,
    } as any);
    return { a, calls };
  }
  const SNOW = "1503382159321464899";
  it("the first part carries reply.messageReference with failIfNotExists: false; later parts are plain", async () => {
    const { a, calls } = dc((_p, n) => ({ id: `m${n}` }));
    const quiet = { parse: [] as Array<"users"> };                        // every part an object: a stray reply would show
    const sent = await a.sendText("1496407196106494055", "abcdefgh", { threadId: "1503382159321460000", replyTo: SNOW, chunkLimit: 4, allowedMentions: quiet });
    expect([calls, sent.messageId]).toEqual([[{ content: "abcd", allowedMentions: quiet, reply: { messageReference: SNOW, failIfNotExists: false } }, { content: "efgh", allowedMentions: quiet }], "m1"]);
  });
  it("an id that is not a snowflake is no reply (sent plain)", async () => {
    const { a, calls } = dc((_p, n) => ({ id: `m${n}` }));
    await a.sendText("1496407196106494055", "hi", { threadId: "1503382159321460000", replyTo: "web-1700000000000" });
    expect(calls).toEqual(["hi"]);
  });
  it("Discord refusing the reference (50035 / 10008 / 160002 no history access) is sent again once plain; another failure is thrown, sent once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const history = dc((p, n) => { if (n === 1) throw Object.assign(new Error("Cannot reply without permission to read message history"), { code: 160002 }); return { id: "h2" }; });
    expect((await history.a.sendText("1496407196106494055", "hi", { threadId: "1503382159321460000", replyTo: SNOW })).messageId).toBe("h2");
    const refused = dc((p, n) => { if (n === 1) throw Object.assign(new Error("Invalid Form Body"), { code: 50035 }); return { id: "m2" }; });
    const sent = await refused.a.sendText("1496407196106494055", "hi", { threadId: "1503382159321460000", replyTo: SNOW });
    const other = dc(() => { throw Object.assign(new Error("Missing Permissions"), { code: 50013 }); });
    await expect(other.a.sendText("1496407196106494055", "hi", { threadId: "1503382159321460000", replyTo: SNOW })).rejects.toThrow(/Missing Permissions/);
    expect([refused.calls, sent.messageId, other.calls.length]).toEqual([[{ content: "hi", reply: { messageReference: SNOW, failIfNotExists: false } }, "hi"], "m2", 1]);
  });
});

describe("web history: a message's platform posts, beside the row", () => {
  const post = { adapterId: "tg", chatId: "-100123", threadId: "77", messageId: "555" };
  it("recorded, kept on disk and restored — never a field of the row (nothing projects or broadcasts it)", () => {
    // The post ids are ones no other text in a row can hold by chance: "555" once turned up in a row's random boot id
    // (1 run in 100 went red, #2465 follow-up).
    const POST_ID = "25552555255525552555", REPLY_POST_ID = "25562556255625562556";
    const post = { adapterId: "tg", chatId: "-100123", threadId: "77", messageId: POST_ID };
    let saved: unknown[] = [];
    const a = new WebChatHistory({ store: { schedule: (_i: string, rows: () => unknown[]) => { saved = rows(); }, remove: async () => {} } });
    const row = a.record({ instance: "w", sender: "Ann", text: "deploy?", ts: "t", posts: [post] });
    const reply = a.record({ instance: "w", sender: "You", text: "yes", ts: "t", messageId: "web-1" });
    a.addPosts("w", "web-1", [{ adapterId: "tg", chatId: "-100123", threadId: "77", messageId: REPLY_POST_ID }]);
    const b = new WebChatHistory();
    b.restore("w", JSON.parse(JSON.stringify(saved)));
    const [r1, r2] = b.list("w");
    expect([a.postsOf(row), Object.hasOwn(row, "posts"), JSON.stringify(row).includes(POST_ID), a.postsOf(reply).map(p => p.messageId), b.postsOf(r1!), b.postsOf(r2!).map(p => p.messageId), JSON.stringify(r1).includes("posts")])
      .toEqual([[post], false, false, [REPLY_POST_ID], [post], [REPLY_POST_ID], false]);
  });
  it("validated on restore: anything not ours in shape is dropped, never repaired; at most WEB_CHAT_POSTS_MAX", () => {
    const h = new WebChatHistory();
    const bad = [{ adapterId: "tg", chatId: "-100123", messageId: "not-digits" }, { adapterId: "a b", chatId: "1", messageId: "1" }, { adapterId: "tg", chatId: "1", threadId: "x", messageId: "1" }, null, "str"];
    const many = Array.from({ length: WEB_CHAT_POSTS_MAX + 3 }, (_, i) => ({ adapterId: "tg", chatId: "-1", messageId: String(i + 1) }));
    h.restore("w", [{ boot: "ab", id: 1, instance: "w", role: "user", sender: "A", text: "x", ts: "t", posts: [...bad, post] }, { boot: "ab", id: 2, instance: "w", role: "user", sender: "A", text: "y", ts: "t", posts: many }]);
    const [r1, r2] = h.list("w");
    expect([h.postsOf(r1!), h.postsOf(r2!).length]).toEqual([[post], WEB_CHAT_POSTS_MAX]);
  });
});

// ── the echo, through the real web server ─────────────────────────────────────────────────────────────────────────
const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = ""; res.on("data", (c: Buffer) => { b += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject); r.end(body);
  });
}
let fm: any, port = 0, dir: string;
const sent: Array<{ chatId: string; text: string; opts: any }> = [];
const fake = { id: "tg", type: "telegram", react: vi.fn(async () => {}), sendText: vi.fn(async (chatId: string, text: string, opts: any) => { sent.push({ chatId, text, opts }); return { messageId: String(900 + sent.length), chatId, threadId: opts?.threadId }; }) };
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-native-reply-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  a:\n    working_directory: ${dir}\n    backend: claude-code\n    topic_id: 77\n`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  fm.getAdapterForInstance = () => fake;
  fm.getGroupIdForInstance = () => "-100123";
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
  fm.instanceIpcClients.set("a", { connected: true, send: () => true });
}, 30_000);
afterAll(async () => { await new Promise<void>((r) => fm.healthServer?.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { sent.length = 0; vi.restoreAllMocks(); });
const session = () => fm.webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!) }).sessionId as string;
const write = (sid: string) => ({ cookie: `${WEB_SESSION_COOKIE}=${sid}`, origin: `http://127.0.0.1:${port}`, [WEB_CSRF_HEADER]: csrfTokenFor(sid), "content-type": "application/json" });
/** A person's platform message in the topic (as emitPlatformInbound records it), with or without where it is. */
function quoted(text: string, posts?: unknown[]) {
  fm.emitSseEvent("message", { instance: "a", sender: "Ann", role: "user", text, ts: new Date().toISOString(), channel: true, ...(posts ? { posts } : {}) });
  return fm.webChatHistory.list("a").at(-1);
}
async function replyTo(row: any, message: string) {
  vi.spyOn(fm, "deliverHumanToInstance").mockImplementation(async () => true);
  const r = await raw(port, "POST", "/ui/send", write(session()), JSON.stringify({ instance: "a", message, replyTo: { boot: row.boot, id: row.id } }));
  expect(r.status, r.body).toBe(200);
  await vi.waitFor(() => expect(sent.length).toBe(1));
  return { echo: sent[0]!, messageId: JSON.parse(r.body).messageId as string };
}

describe("the web echo of a reply", () => {
  it("the quoted message is in this topic: a native reply to it, without the quoted line; its own copy is kept as a post", async () => {
    const row = quoted("Shall I deploy?", [{ adapterId: "tg", chatId: "-100123", threadId: "77", messageId: "555" }]);
    const { echo, messageId } = await replyTo(row, "Yes, go ahead");
    const mine = fm.webChatHistory.findByMessageId("a", messageId);
    expect([echo.opts.replyTo, echo.opts.threadId, echo.text.includes("Shall I deploy"), echo.text.includes("Yes, go ahead"), fm.webChatHistory.postsOf(mine)])
      .toEqual(["555", "77", false, true, [{ adapterId: "tg", chatId: "-100123", threadId: "77", messageId: "901" }]]);
  });
  it("fallback — no known post (an old row, a web-only message), or one elsewhere (another topic, another connection): the quoted line, no reply", async () => {
    const results: unknown[] = [];
    for (const posts of [undefined, [{ adapterId: "tg", chatId: "-100123", threadId: "78", messageId: "555" }], [{ adapterId: "dc", chatId: "-100123", threadId: "77", messageId: "555" }]]) {
      const { echo } = await replyTo(quoted("Shall I deploy?", posts), "Yes");
      results.push([echo.opts.replyTo ?? null, echo.text.includes("Shall I deploy")]);
      sent.length = 0; vi.restoreAllMocks();
    }
    expect(results).toEqual([[null, true], [null, true], [null, true]]);
  });
  it("no page sees a post: the stream's frame and /ui/history carry none", async () => {
    // #2465: the post's id is one no other text can hold by chance. "777" was found in another row's random id or
    // millisecond timestamp (/ui/history holds the file's earlier rows; the frame only this one): main went red with no leak.
    const POST_ID = "22812281228122812281";
    const writes: string[] = [];
    const res = { write: (s: string) => { writes.push(s); return true; }, writableEnded: false, destroyed: false, on() {}, once() {}, end() {} };
    fm.sseClients.add(res);
    try {
      const row = quoted("with a post", [{ adapterId: "tg", chatId: "-100123", threadId: "77", messageId: POST_ID }]);
      // The post is recorded (beside the row): without it this test would prove nothing.
      expect(fm.webChatHistory.postsOf(row)).toEqual([{ adapterId: "tg", chatId: "-100123", threadId: "77", messageId: POST_ID }]);
      const history = (await raw(port, "GET", "/ui/history?instance=a&limit=50", { cookie: `${WEB_SESSION_COOKIE}=${session()}` })).body;
      const frames = writes.join("").split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
      const hasPosts = (v: unknown): boolean => !!v && typeof v === "object" && (Object.hasOwn(v, "posts") || Object.values(v).some(hasPosts));
      expect(frames.length, "the frame was written").toBeGreaterThan(0);
      expect([writes.join("").includes(POST_ID), frames.some(hasPosts), history.includes(POST_ID), hasPosts(JSON.parse(history))]).toEqual([false, false, false, false]);
    } finally { fm.sseClients.delete(res); }
  });
});

describe("where a message is: recorded where it is known", () => {
  it("a person's platform message (the thread it really came from, #1085), and an agent's reply that landed in the topic", async () => {
    fm.emitPlatformInbound("a", { username: "Ann", adapterId: "tg", userId: "1", chatId: "-100123", threadId: "-100123", transportThreadId: "77", messageId: "601" }, "hi");
    const inbound = fm.webChatHistory.list("a").at(-1);
    await fm.afterReplyRouted("a", { text: "done" }, undefined, null, true, { adapterId: "tg", result: { chatId: "-100123", threadId: "77", messageId: "602" } });
    const reply = fm.webChatHistory.list("a").at(-1);
    // A reply that did not land in the instance's own place (another chat, the web-only sink) records nowhere.
    await fm.afterReplyRouted("a", { text: "elsewhere" }, undefined, null, false, { adapterId: "tg", result: { chatId: "-100999", messageId: "603" } });
    const elsewhere = fm.webChatHistory.list("a").at(-1);
    expect([fm.webChatHistory.postsOf(inbound), reply.role, fm.webChatHistory.postsOf(reply), elsewhere.text, fm.webChatHistory.postsOf(elsewhere)]).toEqual([
      [{ adapterId: "tg", chatId: "-100123", threadId: "77", messageId: "601" }], "agent", [{ adapterId: "tg", chatId: "-100123", threadId: "77", messageId: "602" }], "elsewhere", []]);
  });
});

describe("a ClassicBot room's echo", () => {
  it("the room that has the quoted message gets a native reply (without the line); another room the quoted line", async () => {
    const roomSent: Array<{ chatId: string; text: string; opts: any }> = [];
    const room = { id: "tg", type: "telegram", react: async () => {}, sendText: async (chatId: string, text: string, opts: any) => { roomSent.push({ chatId, text, opts }); return { messageId: "88", chatId }; } };
    const saved = { classic: fm.classicChannels, worlds: fm.worlds };
    fm.classicChannels = { getAll: () => [{ instanceName: "a", channelId: "-1001", adapterId: "tg", webEcho: true }, { instanceName: "a", channelId: "-1002", adapterId: "tg", webEcho: true }] };
    fm.worlds = new Map([["tg", { adapter: room }]]);
    try {
      const copies: any[] = [];
      // -1002 has the same chat id on another connection: not the original's place.
      const posted = await fm.sendClassicWebEcho("a", "↩ Ann: deploy?\nyes", "You", copies, { posts: [{ adapterId: "tg", chatId: "-1001", messageId: "5" }, { adapterId: "tg2", chatId: "-1002", messageId: "6" }], text: "yes" });
      expect([posted, roomSent.map(s => [s.chatId, s.text, s.opts.replyTo ?? null]), copies.map(c => c.adapterId)]).toEqual([2,
        [["-1001", "yes", "5"], ["-1002", "↩ Ann: deploy?\nyes", null]], ["tg", "tg"]]);
    } finally { fm.classicChannels = saved.classic; fm.worlds = saved.worlds; }
  });
});
