/**
 * #1666: a message sent from the web chat starts the same 🛑 Cancel/progress bubble in the instance's topic as a
 * platform inbound — after its echo, only when delivered, never on a web-only fleet; it retires by the same rules.
 *
 * Real HTTP send → FleetManager → the real Telegram / Discord adapter → a stub API that records every call in order.
 * The REAL sendCancelButton, clearCancelButton and afterReplyRouted run. No fleet startup, bot polling, process, CLI,
 * tmux or network.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { WEB_ECHO_PREFIX } from "../src/web-channel-echo.js";
import { setLocale } from "../src/locale.js";

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }),
  rotateLogIfNeeded: () => { throw new Error("log rotation is outside this harness"); },
  rotateLogIfNeededAsync: async () => { throw new Error("log rotation is outside this harness"); },
}));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const blocked = () => { throw new Error("process execution is outside this harness"); };
  return { ...original, spawn: blocked, spawnSync: blocked, exec: blocked, execSync: blocked, execFile: blocked, execFileSync: blocked, fork: blocked };
});

const TOKEN = "t".repeat(48), dirs: string[] = [], managers: FleetManager[] = [];
const OPEN = { mode: "open" as const, allowed_users: [] as string[], max_pending_codes: 0, code_expiry_minutes: 0 };
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise<void>(r => setImmediate(r)); };
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => {
  for (const fm of managers.splice(0)) {
    const s = fm as any;
    for (const key of ["sessionPruneTimer", "replyObligationTimer"]) clearInterval(s[key]);
    for (const e of s.cancelButtons?.values?.() ?? []) { clearInterval(e.idleCheckTimer); clearInterval(e.progressTimer); clearTimeout(e.progressTimer); }
    s.shuttingDown = true;
  }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setLocale("en");
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

interface Call { method: string; chatId?: string; thread?: string; text?: string; button?: boolean; messageId?: string }

/** One FleetManager with one instance bound to a topic of a real adapter whose API calls are recorded in order. */
async function harness(type: "telegram" | "discord", opts: { webOnly?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bubble-1666-")); dirs.push(dir);
  vi.stubEnv("AGEND_HOME", dir);
  const fm = new FleetManager(dir); managers.push(fm); const s = fm as any;
  const calls: Call[] = [];
  let holdEcho: Promise<void> | undefined, holdBubble: Promise<void> | undefined;
  let nextId = 100;
  const chatId = type === "telegram" ? "-100222" : "guild", topic = type === "telegram" ? "27" : "topic";
  let adapter: TelegramAdapter | DiscordAdapter | undefined;
  if (!opts.webOnly && type === "telegram") {
    adapter = new TelegramAdapter({ id: "owner", botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", accessManager: { isAllowed: () => ({ allowed: true }) } as never, inboxDir: dir });
    const bot = adapter.getBot();
    (bot as any).botInfo = { id: 777, is_bot: true, first_name: "Bot", username: "bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
    (bot as any).api.config.use(async (_prev: unknown, method: string, payload: any) => {
      if (method === "sendMessage" && String(payload.text).startsWith(WEB_ECHO_PREFIX) && holdEcho) await holdEcho;
      if (method === "sendMessage" && payload.reply_markup && holdBubble) await holdBubble;
      const id = String(++nextId);
      calls.push({ method, chatId: String(payload.chat_id), thread: payload.message_thread_id != null ? String(payload.message_thread_id) : undefined,
        text: payload.text, button: !!payload.reply_markup, messageId: method === "sendMessage" ? id : String(payload.message_id ?? "") });
      if (method === "sendMessage") return { ok: true, result: { message_id: Number(id), date: 1, chat: { id: Number(chatId), type: "supergroup" }, text: payload.text } };
      return { ok: true, result: true };
    });
  } else if (!opts.webOnly) {
    const channel = (id: string) => ({
      isTextBased: () => true,
      send: async (value: any) => {
        const text = typeof value === "string" ? value : value.content;
        if (String(text).startsWith(WEB_ECHO_PREFIX) && holdEcho) await holdEcho;
        const mid = String(++nextId);
        calls.push({ method: "send", chatId, thread: id, text, button: !!(value?.components?.length), messageId: mid });
        return { id: mid, edit: async () => ({ id: mid }), delete: async () => { calls.push({ method: "delete", thread: id, messageId: mid }); } };
      },
      messages: { fetch: async (mid: string) => ({ id: mid, edit: async () => ({}), delete: async () => { calls.push({ method: "delete", thread: id, messageId: mid }); } }) },
    });
    const client = Object.assign(new EventEmitter(), {
      destroy: vi.fn(async () => {}),
      user: { id: "777", username: "Bot" }, isReady: () => true,
      channels: { fetch: vi.fn(async (id: string) => channel(id)), cache: new Map() },
    });
    adapter = new DiscordAdapter({ id: "owner", botToken: "fake", accessManager: {} as never, inboxDir: dir, guildId: chatId, registerCommands: false, clientFactory: () => client as unknown as Client });
  }
  if (opts.webOnly) {
    s.fleetConfig = { defaults: {}, instances: { worker: { working_directory: dir } } };
    s.adapter = null;
  } else {
    s.fleetConfig = { defaults: {}, channels: [{ id: "owner", type, group_id: chatId, access: OPEN }], instances: { worker: { working_directory: dir, channel_id: "owner", topic_id: topic } } };
    s.adapter = adapter;
    s.worlds.set("owner", { id: "owner", adapter, groupId: chatId, channelConfig: s.fleetConfig.channels[0], accessManager: new AccessManager(OPEN, join(dir, "access.json")) });
  }
  s.routing.rebuild(s.fleetConfig);
  vi.spyOn(s, "webToken", "get").mockReturnValue(TOKEN);
  s.lifecycle.isPaused = vi.fn(() => false);
  let idle = false;
  s.getInstanceIdle = () => idle;
  s.reactDone = () => {}; s.setTopicIcon = vi.fn(); s.reactMessageStatus = vi.fn(); s.warnIfRateLimited = vi.fn();
  s.armReplyGrace = vi.fn();
  s.logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  s.emitSseEvent = vi.fn();
  const received: any[] = [];
  s.instanceIpcClients.set("worker", { connected: true, send: (m: any) => { received.push(m); return true; } });
  const bubbles = () => calls.filter(c => c.button && (c.method === "sendMessage" || c.method === "send"));
  const echoes = () => calls.filter(c => String(c.text ?? "").startsWith(WEB_ECHO_PREFIX));
  return {
    fm, s, calls, bubbles, echoes, received, chatId, topic,
    setIdle: (v: boolean) => { idle = v; },
    hold: (p?: Promise<void>) => { holdEcho = p; },
    holdBubble: (p?: Promise<void>) => { holdBubble = p; },
    reply: (text = "done") => s.handleOutboundFromInstance("worker", { requestId: 9, tool: "reply", args: { text, chat_id: chatId } }),
  };
}

/** The lane's 5 s budget runs on performance.now() and setTimeout: move both together (as #1320's orderingClock). */
function laneClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return { advance: async (ms: number) => { now += ms; await vi.advanceTimersByTimeAsync(ms); await flush(20); } };
}

function send(fm: FleetManager, message = "hello from the web") {
  const req = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/send", headers: { "x-agend-token": TOKEN }, destroy() {} });
  const done = deferred<{ status: number; body: any }>(); let status = 0;
  const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(body: string) { done.resolve({ status, body: JSON.parse(body) }); } };
  expect(handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL(req.url, "http://localhost"), fm as unknown as WebApiContext)).toBe(true);
  req.emit("data", Buffer.from(JSON.stringify({ instance: "worker", message, attachments: [] }))); req.emit("end");
  return done.promise;
}

describe("#1666: a delivered web chat message starts the topic's Cancel/progress bubble — after its echo", () => {
  it.each(["telegram", "discord"] as const)("%s: exactly one bubble, in the instance's topic, after the echo", async type => {
    const h = await harness(type);
    const r = await send(h.fm);
    expect(r.status).toBe(200);
    await flush(20);
    expect(h.echoes()).toHaveLength(1);
    expect(h.bubbles()).toHaveLength(1);
    expect(h.bubbles()[0]!.thread).toBe(h.topic);
    expect(h.calls.indexOf(h.bubbles()[0]!)).toBeGreaterThan(h.calls.indexOf(h.echoes()[0]!));
    expect(h.s.hasCancelButton("worker")).toBe(true);
  });

  it("a slow echo: the bubble waits for it (the same lane) — never above it", async () => {
    const h = await harness("telegram");
    const echo = deferred();
    h.hold(echo.promise);
    const r = await send(h.fm);
    expect(r.status).toBe(200);
    await flush(20);
    expect(h.bubbles()).toHaveLength(0);               // the echo is still in flight
    echo.resolve();
    await flush(20);
    expect(h.echoes()).toHaveLength(1);
    expect(h.bubbles()).toHaveLength(1);
    expect(h.calls.indexOf(h.bubbles()[0]!)).toBeGreaterThan(h.calls.indexOf(h.echoes()[0]!));
  });

  it("an undelivered message (503): no echo, no bubble", async () => {
    const h = await harness("telegram");
    vi.spyOn(h.s, "deliverToInstance").mockResolvedValue(false);
    const r = await send(h.fm);
    expect(r.status).toBe(503);
    await flush(20);
    expect(h.bubbles()).toHaveLength(0);
    expect(h.echoes()).toHaveLength(0);
    expect(h.s.hasCancelButton("worker")).toBe(false);
  });

  it("a web-only fleet (no channel, no topic): delivered, and no bubble anywhere", async () => {
    const h = await harness("telegram", { webOnly: true });
    const start = vi.spyOn(h.s, "startWebChatProgress");
    const r = await send(h.fm);
    expect(r.status).toBe(200);
    await flush(20);
    expect(h.calls).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
    expect(h.s.hasCancelButton("worker")).toBe(false);
  });

  it("a cancel between the delivery and the bubble's turn on the lane: no bubble (the lane's delivery epoch)", async () => {
    const h = await harness("telegram");
    const echo = deferred();
    h.hold(echo.promise);
    const r = await send(h.fm);
    expect(r.status).toBe(200);
    h.s.cancelPendingDeliveries("worker");             // what /cancel and the Cancel button do to the instance's epoch
    echo.resolve();
    await flush(20);
    expect(h.bubbles()).toHaveLength(0);
  });

  it("the agent replies while idle: the bubble retires (the platform rule), and no new one is posted", async () => {
    const h = await harness("telegram");
    await send(h.fm);
    await flush(20);
    const bubble = h.bubbles()[0]!;
    expect(bubble).toBeDefined();
    h.setIdle(true);
    await h.reply();
    await flush(20);
    expect(h.s.hasCancelButton("worker")).toBe(false);
    expect(h.calls.some(c => c.method === "deleteMessage" && c.messageId === bubble.messageId)).toBe(true);
    expect(h.bubbles()).toHaveLength(1);
  });

  it("the agent replies while still working: the bubble is re-posted below the reply (the platform rule)", async () => {
    const h = await harness("telegram");
    await send(h.fm);
    await flush(20);
    h.setIdle(false);
    await h.reply();
    await flush(20);
    expect(h.bubbles()).toHaveLength(2);
    expect(h.s.hasCancelButton("worker")).toBe(true);
  });

  it("a bubble slower than the lane's 5 s budget never drops the NEXT message's echo (it is not a copy, #1668 P2)", async () => {
    const h = await harness("telegram");
    const clock = laneClock();
    const bubble = deferred();
    h.holdBubble(bubble.promise);
    expect((await send(h.fm, "first")).status).toBe(200);
    await flush(20);
    expect(h.echoes().map(c => c.text)).toEqual([expect.stringContaining("first")]);
    expect((await send(h.fm, "second")).status).toBe(200);
    await clock.advance(5_300);
    h.holdBubble(undefined);
    bubble.resolve();
    await clock.advance(2_000);
    expect(h.echoes().map(c => c.text)).toEqual([expect.stringContaining("first"), expect.stringContaining("second")]);
    // …and the second message's own bubble, which waited behind the slow one and the second echo for more than 5 s,
    // is still posted: a non-copy's budget starts with its turn.
    expect(h.bubbles()).toHaveLength(2);
  });

  it("an echo slower than the budget never drops this message's bubble (a slow echo may leave it above the echo, #1668 P3)", async () => {
    const h = await harness("telegram");
    const clock = laneClock();
    const echo = deferred();
    h.hold(echo.promise);
    expect((await send(h.fm)).status).toBe(200);
    await clock.advance(5_300);
    echo.resolve();
    await clock.advance(2_000);
    // The echo did time out on the lane (in this fake clock grammy's own request timeout also ends the held call, so
    // whether the late echo shows is not this test's question) — and the bubble was posted anyway.
    expect(h.s.logger.warn.mock.calls.some((c: any[]) => c[1] === "Web channel echo ordering timed out")).toBe(true);
    expect(h.bubbles()).toHaveLength(1);
  });
});

describe("#1668: the echo lane's rules for an entry that is not a copy (the bubble)", () => {
  /** A lane entry whose send is held until released; records when it ran. */
  function entry(h: Awaited<ReturnType<typeof harness>>, label: string, ran: string[], copy: boolean) {
    const gate = deferred();
    const settle = h.s.reserveWebChannelEcho("worker", async () => { ran.push(label); await gate.promise; }, copy ? {} : { copy: false });
    settle(true);
    return gate;
  }

  it("a non-copy that waits in the queue longer than 5 s still runs when its turn comes (its budget starts with its turn)", async () => {
    const h = await harness("telegram"), clock = laneClock(), ran: string[] = [];
    const c = entry(h, "bubble-1", ran, false);       // runs first, held
    const a = entry(h, "echo-2", ran, true);          // a copy behind it
    entry(h, "bubble-2", ran, false);                 // behind both: waits ~10 s
    await flush(10);
    await clock.advance(5_100);                       // bubble-1's own budget ends → echo-2 starts (its budget starts now)
    expect(ran).toEqual(["bubble-1", "echo-2"]);
    await clock.advance(4_000);                       // echo-2 still held, within its budget; bubble-2 has waited 9 s
    a.resolve(); c.resolve();
    await flush(20);
    expect(ran).toEqual(["bubble-1", "echo-2", "bubble-2"]);
  });

  it("a non-copy's timeout releases the lane without dropping the copies queued behind it", async () => {
    const h = await harness("telegram"), clock = laneClock(), ran: string[] = [];
    entry(h, "bubble-1", ran, false);
    entry(h, "echo-2", ran, true).resolve();
    await flush(10);
    await clock.advance(5_100);
    expect(ran).toEqual(["bubble-1", "echo-2"]);
    expect(h.s.logger.warn.mock.calls.some((c: any[]) => c[1] === "Queued web channel echo dropped after ordering timeout")).toBe(false);
  });

  it("a copy's timeout never drops a non-copy queued behind it (it still runs)", async () => {
    const h = await harness("telegram"), clock = laneClock(), ran: string[] = [];
    entry(h, "echo-1", ran, true);                    // held past its budget
    entry(h, "bubble-1", ran, false).resolve();
    await flush(10);
    await clock.advance(5_100);
    expect(ran).toEqual(["echo-1", "bubble-1"]);
  });

  it("a copy queued behind a non-copy starts its budget when the non-copy finishes, not at its reservation", async () => {
    const h = await harness("telegram"), clock = laneClock(), ran: string[] = [];
    const b = entry(h, "bubble-1", ran, false);
    entry(h, "echo-2", ran, true).resolve();
    await flush(10);
    await clock.advance(4_000);                       // the bubble is slow, but inside its budget
    b.resolve();
    await clock.advance(2_000);                       // echo-2 reserved 6 s ago: still its turn
    expect(ran).toEqual(["bubble-1", "echo-2"]);
  });

  it("a copy further back (behind a copy behind the bubble) also starts its budget when the bubble finishes (#1668 r3)", async () => {
    const h = await harness("telegram"), clock = laneClock(), ran: string[] = [];
    const e1 = entry(h, "echo-1", ran, true);
    const b = entry(h, "bubble-1", ran, false);
    entry(h, "echo-2", ran, true).resolve();          // right behind the bubble
    entry(h, "echo-3", ran, true).resolve();          // behind a copy behind the bubble
    await flush(10);
    await clock.advance(1_000); e1.resolve(); await flush(10);   // the bubble starts at ~1 s; its budget ends ~6 s
    await clock.advance(4_200);                                  // ~5.2 s: the bubble is slow but within its budget
    b.resolve(); await flush(20);
    expect(ran).toEqual(["echo-1", "bubble-1", "echo-2", "echo-3"]);
  });

});
