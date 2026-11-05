/**
 * M-2395: Telegram messages sent while AgEnD was stopped must survive restart.
 * drop_pending_updates stays false; the mock honours deleteWebhook(drop);
 * recent pending updates go through the existing handlers once; a crash
 * mid-batch cannot inject a duplicate; older than 2h become Needs-you;
 * stale queued callback_query is ignored.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTelegramMock, type TelegramMock } from "../e2e/mock-servers/telegram-mock.js";
import { getFreePort, waitFor } from "../e2e/mock-servers/shared.js";
import {
  TELEGRAM_GETUPDATES_LIMIT,
  TELEGRAM_PENDING_LIVE_MAX_MS,
  TELEGRAM_UPDATE_ID_FLOOR_MAX_AGE_MS,
  TelegramAdapter,
  telegramLastUpdateIdPath,
  type MissedOfflineInbound,
} from "../src/channel/adapters/telegram.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { MissedOfflineStore } from "../src/missed-offline.js";
import { deriveNeedsYou, renderLiveMessage, type MissedOfflineInput, type NeedsYouInputs } from "../src/needs-you.js";
import type { InboundMessage } from "../src/channel/types.js";

const GROUP = -1001234567890;
const USER = 111222333;
const SRC = "src/channel/adapters/telegram.ts";

let mock: TelegramMock;
let dir: string;
let inbox: string;
let adapter: TelegramAdapter | undefined;

function newAdapter(id = "t"): TelegramAdapter {
  const access = new AccessManager(
    { mode: "locked", allowed_users: [USER], max_pending_codes: 5, code_expiry_minutes: 10 },
    join(dir, "access.json"),
  );
  adapter = new TelegramAdapter({
    id, botToken: "123456:FAKE_TOKEN", accessManager: access, inboxDir: inbox, apiRoot: `http://localhost:${mock.port}`,
  });
  return adapter;
}

async function startListening(): Promise<{ messages: InboundMessage[]; missed: MissedOfflineInbound[]; callbacks: unknown[] }> {
  const messages: InboundMessage[] = [];
  const missed: MissedOfflineInbound[] = [];
  const callbacks: unknown[] = [];
  const a = adapter ?? newAdapter();
  a.on("message", (m: InboundMessage) => messages.push(m));
  a.on("missed_offline", (m: MissedOfflineInbound) => missed.push(m));
  a.on("callback_query", (c: unknown) => callbacks.push(c));
  await a.start();
  await waitFor(() => mock.getCallsFor("getUpdates").length > 0, { timeout: 5000, interval: 20, label: "first poll" });
  return { messages, missed, callbacks };
}

/** First empty getUpdates has returned; later injects are live, not a start backlog page. */
async function startDrained(): Promise<{ messages: InboundMessage[]; missed: MissedOfflineInbound[]; callbacks: unknown[] }> {
  const result = await startListening();
  await waitFor(() => mock.getCallsFor("getUpdates").length >= 2, { timeout: 8000, interval: 50, label: "queue drained" });
  return result;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tg2395-"));
  inbox = join(dir, "inbox");
  mkdirSync(inbox, { recursive: true });
  mock = createTelegramMock({ port: await getFreePort() });
  await mock.start();
});
afterEach(async () => {
  await adapter?.stop().catch(() => {});
  adapter = undefined;
  await mock.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("Telegram mock deleteWebhook(drop_pending_updates)", () => {
  async function bot(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${mock.port}/bot123456:FAKE_TOKEN/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params),
    });
    return (await res.json() as { result: unknown }).result;
  }

  it("drop true clears the queue; drop false keeps it", async () => {
    mock.injectMessage({ text: "queued", chatId: GROUP, userId: USER });
    await bot("deleteWebhook", { drop_pending_updates: false });
    expect(await bot("getUpdates")).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.objectContaining({ text: "queued" }) })]));

    mock.injectMessage({ text: "again", chatId: GROUP, userId: USER });
    await bot("deleteWebhook", { drop_pending_updates: true });
    expect(await bot("getUpdates")).toEqual([]);
  });
});

describe("TelegramAdapter pending updates after a restart (M-2395)", () => {
  it("a mutation turning drop_pending_updates back on must fail", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toMatch(/drop_pending_updates:\s*false/);
    expect(src).not.toMatch(/drop_pending_updates:\s*attempt\s*===\s*1/);
    expect(TELEGRAM_PENDING_LIVE_MAX_MS).toBe(2 * 60 * 60 * 1000);
    expect(TELEGRAM_UPDATE_ID_FLOOR_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(TELEGRAM_GETUPDATES_LIMIT).toBe(100);
  });

  it("a message queued while stopped is delivered once through the existing handlers", async () => {
    mock.injectMessage({ text: "hello after restart", chatId: GROUP, userId: USER, threadId: 101, username: "han" });
    const { messages, missed } = await startListening();
    await waitFor(() => messages.length === 1, { timeout: 5000, interval: 20, label: "queued inbound" });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe("hello after restart");
    expect(messages[0]!.threadId).toBe("101");
    expect(missed).toEqual([]);
    await new Promise(r => setTimeout(r, 200));
    expect(messages).toHaveLength(1);
    const drops = mock.getCallsFor("deleteWebhook");
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.some(c => c.params.drop_pending_updates === true)).toBe(false);
  });

  it("a mutation that dropped the queue would lose the queued message (mock drop true)", async () => {
    mock.injectMessage({ text: "would be lost", chatId: GROUP, userId: USER });
    await fetch(`http://127.0.0.1:${mock.port}/bot123456:FAKE_TOKEN/deleteWebhook`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ drop_pending_updates: true }),
    });
    const { messages } = await startListening();
    await new Promise(r => setTimeout(r, 400));
    expect(messages).toEqual([]);
  });

  it("duplicate skipped after a crash mid-batch (recorded before acting)", async () => {
    writeFileSync(telegramLastUpdateIdPath(inbox, "t"), `${JSON.stringify({ update_id: 5 })}\n`);
    mock.injectMessage({ text: "already claimed", chatId: GROUP, userId: USER, updateId: 5 });
    mock.injectMessage({ text: "next after crash", chatId: GROUP, userId: USER, updateId: 6 });
    const { messages } = await startListening();
    await waitFor(() => messages.length === 1, { timeout: 5000, interval: 20, label: "replay after crash" });
    expect(messages.map(m => m.text)).toEqual(["next after crash"]);
  });

  it("older than TELEGRAM_PENDING_LIVE_MAX_MS becomes missed_offline, never a message", async () => {
    const date = Math.floor(Date.now() / 1000) - Math.ceil(TELEGRAM_PENDING_LIVE_MAX_MS / 1000) - 60;
    mock.injectMessage({ text: "from yesterday", chatId: GROUP, userId: USER, threadId: 7, username: "han", date });
    const { messages, missed } = await startListening();
    await waitFor(() => missed.length === 1, { timeout: 5000, interval: 20, label: "missed offline" });
    expect(messages).toEqual([]);
    expect(missed).toHaveLength(1);
    expect(missed[0]!.preview).toBe("from yesterday");
    expect(missed[0]!.username).toBe("han");
    expect(missed[0]!.threadId).toBe("7");
    expect(missed[0]!.chatId).toBe(String(GROUP));
  });

  it("a live handleUpdate with a stub date is inbound, not missed_offline", async () => {
    const a = newAdapter();
    const bot = a.getBot() as { botInfo?: { id: number; is_bot: boolean; first_name: string; username: string; can_join_groups: boolean; can_read_all_group_messages: boolean; supports_inline_queries: boolean }; handleUpdate: (u: unknown) => Promise<void> };
    bot.botInfo = { id: 1, is_bot: true, first_name: "bot", username: "bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
    const messages: InboundMessage[] = [];
    const missed: MissedOfflineInbound[] = [];
    a.on("message", (m: InboundMessage) => messages.push(m));
    a.on("missed_offline", (m: MissedOfflineInbound) => missed.push(m));
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 7, date: 1, chat: { id: GROUP, type: "supergroup" },
        from: { id: USER, is_bot: false, first_name: "han" }, text: "stub date",
      },
    });
    expect(messages.map(m => m.text)).toEqual(["stub date"]);
    expect(missed).toEqual([]);
  });

  it("a queued callback_query is ignored even when the card is recent", async () => {
    mock.injectCallbackQuery({ data: "needs-ack:dead", chatId: GROUP, messageId: 9, date: Math.floor(Date.now() / 1000) });
    const { callbacks, messages } = await startListening();
    await new Promise(r => setTimeout(r, 400));
    expect(callbacks).toEqual([]);
    expect(messages).toEqual([]);
  });

  it("a live click on an old button after the backlog drained is delivered", async () => {
    const { callbacks } = await startDrained();
    mock.injectCallbackQuery({
      data: "needs-ack:live", chatId: GROUP, messageId: 9,
      date: Math.floor(Date.now() / 1000) - Math.ceil(TELEGRAM_PENDING_LIVE_MAX_MS / 1000) - 60,
    });
    await waitFor(() => callbacks.length === 1, { timeout: 5000, interval: 20, label: "live old-card click" });
  });

  it("a week-old floor is ignored so a random lower update_id is delivered", async () => {
    writeFileSync(telegramLastUpdateIdPath(inbox, "t"), `${JSON.stringify({
      update_id: 999_999, bot_id: 123456789,
      recorded_at: Date.now() - TELEGRAM_UPDATE_ID_FLOOR_MAX_AGE_MS - 60_000,
    })}\n`);
    const { messages } = await startDrained();
    mock.injectMessage({ text: "after a week", chatId: GROUP, userId: USER, updateId: 3 });
    await waitFor(() => messages.length === 1, { timeout: 5000, interval: 20, label: "week-old floor" });
    expect(messages.map(m => m.text)).toEqual(["after a week"]);
  });

  it("a floor from a different bot id is ignored", async () => {
    writeFileSync(telegramLastUpdateIdPath(inbox, "t"), `${JSON.stringify({
      update_id: 999_999, bot_id: 1, recorded_at: Date.now(),
    })}\n`);
    const { messages } = await startDrained();
    mock.injectMessage({ text: "new bot", chatId: GROUP, userId: USER, updateId: 3 });
    await waitFor(() => messages.length === 1, { timeout: 5000, interval: 20, label: "bot-id mismatch" });
    expect(messages.map(m => m.text)).toEqual(["new bot"]);
  });

  it("a getUpdates page fully below a fresh same-bot floor re-bases", async () => {
    writeFileSync(telegramLastUpdateIdPath(inbox, "t"), `${JSON.stringify({
      update_id: 999_999, bot_id: 123456789, recorded_at: Date.now(),
    })}\n`);
    mock.injectMessage({ text: "re-base a", chatId: GROUP, userId: USER, updateId: 3 });
    mock.injectMessage({ text: "re-base b", chatId: GROUP, userId: USER, updateId: 4 });
    const { messages } = await startListening();
    await waitFor(() => messages.length === 2, { timeout: 5000, interval: 20, label: "re-base page" });
    expect(messages.map(m => m.text)).toEqual(["re-base a", "re-base b"]);
  });

  it("old messages past the first getUpdates page stay missed_offline", async () => {
    const date = Math.floor(Date.now() / 1000) - Math.ceil(TELEGRAM_PENDING_LIVE_MAX_MS / 1000) - 60;
    for (let i = 0; i < TELEGRAM_GETUPDATES_LIMIT + 1; i++) {
      mock.injectMessage({ text: `old-${i}`, chatId: GROUP, userId: USER, date });
    }
    const { messages, missed } = await startListening();
    await waitFor(() => missed.length === TELEGRAM_GETUPDATES_LIMIT + 1, { timeout: 8000, interval: 20, label: "paged backlog" });
    expect(messages).toEqual([]);
  });
});

describe("Needs you missed-offline derivation", () => {
  const inputs = (over: Partial<NeedsYouInputs> = {}): NeedsYouInputs => ({
    prompts: [], instances: [], deliveries: [], ownerOf: () => "tg", ...over,
  });
  const missed = (over: Partial<MissedOfflineInput> = {}): MissedOfflineInput => ({
    id: "missed:tg:9", instance: "ccm", owner: "tg", username: "han", place: "Test Group · #101",
    preview: "hello after restart", since: 1_000, ...over,
  });

  it("old → Needs-you item with who, where, preview, Acknowledge", () => {
    const items = deriveNeedsYou(inputs({ missedOffline: [missed()] }));
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("missed");
    expect(items[0]!.reason).toBe("missed_offline");
    expect(items[0]!.instance).toBe("ccm");
    expect(items[0]!.detail).toContain("han");
    expect(items[0]!.detail).toContain("Test Group");
    expect(items[0]!.detail).toContain("hello after restart");
    const t = (k: string, ...a: Array<string | number>) => `${k}${a.length ? `(${a.join(",")})` : ""}`;
    const { ackable, text } = renderLiveMessage([{ item: items[0]!, title: "Missed while AgEnD was offline" }], 2_000, t);
    expect(ackable.map(a => a.id)).toEqual(["missed:tg:9"]);
    expect(text).toContain("ccm");
  });
});

describe("MissedOfflineStore", () => {
  it("acknowledge removes the row; a duplicate id is not added twice", () => {
    const store = new MissedOfflineStore(dir);
    const row = { id: "missed:tg:1", adapterId: "tg", instance: "ccm", username: "han", place: "#101", preview: "hi", since: Date.now() };
    store.add(row);
    store.add(row);
    expect(store.list(Date.now())).toHaveLength(1);
    expect(store.acknowledge("missed:tg:1", "web:x")).toBe(true);
    expect(store.list(Date.now())).toEqual([]);
    expect(store.acknowledge("missed:tg:1", "web:x")).toBe(false);
  });
});
