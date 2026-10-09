/**
 * #1266: the real Telegram and Discord adapters put a reply's buttons where they belong — on the text's last message —
 * and show how a set ended. The platform APIs are stubbed with the limits the real ones enforce:
 * Telegram sendMessage (text ≤ 4096; callback_data 1–64 bytes), Discord channel.send (content ≤ 2000; ≤ 5 rows of ≤ 5
 * buttons; label ≤ 80; custom_id ≤ 100).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramAdapter, telegramReplyKeyboard, REPLY_BUTTONS_CLOSED } from "../src/channel/adapters/telegram.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { replyButtonCallback } from "../src/reply-buttons.js";

const dirs: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const SET = "a".repeat(32);
const buttons = (n: number, label = (i: number) => `Option ${i}`) => Array.from({ length: n }, (_, i) => ({ id: replyButtonCallback(SET, i), label: label(i) }));

// ── Telegram ──

function telegram() {
  const calls: Array<{ method: string; chatId: number; text?: string; opts: any }> = [];
  let id = 100;
  const assertKeyboard = (markup: any) => {
    for (const row of markup.inline_keyboard) for (const b of row) {
      const bytes = Buffer.byteLength(b.callback_data ?? "", "utf8");
      if (bytes < 1 || bytes > 64) throw new Error("Bad Request: BUTTON_DATA_INVALID");
    }
  };
  const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
  Object.assign(adapter, {
    id: "tg",
    bot: { api: {
      sendMessage: async (chatId: number, text: string, opts: any) => {
        if (text.length > 4096) throw new Error("Bad Request: message is too long");
        if (opts?.reply_markup) assertKeyboard(opts.reply_markup);
        calls.push({ method: "sendMessage", chatId, text, opts });
        return { message_id: ++id };
      },
      editMessageReplyMarkup: async (chatId: number, messageId: number, opts: any) => {
        assertKeyboard(opts.reply_markup);
        calls.push({ method: "editMessageReplyMarkup", chatId, opts: { messageId, ...opts } });
        return true;
      },
    } },
  });
  return { adapter, calls };
}

describe("Telegram", () => {
  it("a short reply: one sendMessage with the keyboard; short labels three to a row", async () => {
    const { adapter, calls } = telegram();
    expect(adapter.supportsReplyButtons).toBe(true);
    const sent = await adapter.sendText("-100", "Deploy now?", { threadId: "42", replyButtons: buttons(4, i => `B${i}`) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.message_thread_id).toBe(42);
    expect(calls[0]!.opts.reply_markup.inline_keyboard.map((r: any[]) => r.map(b => b.text))).toEqual([["B0", "B1", "B2"], ["B3"]]);
    expect(calls[0]!.opts.reply_markup.inline_keyboard[0][0].callback_data).toBe(`rb:${SET}:0`);
    expect(sent).toEqual({ messageId: "101", chatId: "-100", threadId: "42", buttonsMessageId: "101" });
  });
  it("a long reply: every part is sent in order, the keyboard only on the last, and that is the message named", async () => {
    const { adapter, calls } = telegram();
    const text = "x".repeat(4096) + "y".repeat(100);
    const sent = await adapter.sendText("-100", text, { replyButtons: buttons(2, i => `a long label number ${i}`) });
    expect(calls.map(c => [c.text!.length, !!c.opts.reply_markup])).toEqual([[4096, false], [100, true]]);
    expect(calls[1]!.opts.reply_markup.inline_keyboard.map((r: any[]) => r.length), "long labels: one per row").toEqual([1, 1]);
    expect(sent).toMatchObject({ messageId: "101", buttonsMessageId: "102" });
  });
  it("a callback over 64 bytes is an error before anything is sent", () => {
    expect(() => telegramReplyKeyboard([{ id: `rb:${"a".repeat(62)}`, label: "x" }])).toThrow(/callback_data over 64 bytes/);
  });
  it("settled: one inert button says who chose what (or that it expired)", async () => {
    const { adapter, calls } = telegram();
    await adapter.settleReplyButtons!("-100", "101", "42", ["Deploy", "Wait"], { chosenIndex: 0, by: "alice" });
    await adapter.settleReplyButtons!("-100", "102", "42", ["Deploy"], { expired: true });
    expect(calls.map(c => c.opts.reply_markup.inline_keyboard)).toEqual([
      [[{ text: "✓ Deploy — alice", callback_data: REPLY_BUTTONS_CLOSED }]],
      [[{ text: "⌛ Expired — reply in text", callback_data: REPLY_BUTTONS_CLOSED }]],
    ]);
    expect(calls.map(c => c.opts.messageId)).toEqual([101, 102]);
  });
});

// ── Discord ──

function discord() {
  const dir = mkdtempSync(join(tmpdir(), "agend-1266-dc-"));
  dirs.push(dir);
  const adapter = new DiscordAdapter({
    id: "dc", botToken: "fake-token", accessManager: new AccessManager({ mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 0 } as any, join(dir, "a.json")),
    inboxDir: dir, guildId: "guild-1", registerCommands: false,
  } as any);
  stops.push(() => adapter.stop());
  const sends: any[] = [];
  const edits: any[] = [];
  let id = 0;
  const validate = (payload: any) => {
    const content = typeof payload === "string" ? payload : payload.content ?? "";
    if (content.length > 2000) throw new Error("Invalid Form Body: content");
    const rows = (payload.components ?? []).map((r: any) => (typeof r.toJSON === "function" ? r.toJSON() : r));
    if (rows.length > 5) throw new Error("Invalid Form Body: components (max 5 rows)");
    for (const row of rows) {
      if (row.components.length > 5) throw new Error("Invalid Form Body: components (max 5 per row)");
      for (const c of row.components) {
        if ((c.label ?? "").length > 80) throw new Error("Invalid Form Body: label");
        if ((c.custom_id ?? "").length > 100) throw new Error("Invalid Form Body: custom_id");
      }
    }
    return rows;
  };
  const channel = {
    send: async (payload: any) => { const rows = validate(payload); sends.push({ payload, rows }); return { id: `m${++id}` }; },
    messages: { fetch: async (messageId: string) => ({ edit: async (p: any) => { edits.push({ messageId, rows: validate(p) }); } }) },
  };
  vi.spyOn(adapter as any, "_fetchTextChannel").mockResolvedValue(channel);
  return { adapter, sends, edits };
}

describe("Discord", () => {
  it("components on the last part only; rows of five; that message is the one named", async () => {
    const { adapter, sends } = discord();
    expect(adapter.supportsReplyButtons).toBe(true);
    const text = "x".repeat(1990) + "\n" + "y".repeat(50);
    const sent = await adapter.sendText("guild-1", text, { threadId: "chan", replyButtons: buttons(7) });
    expect(sends).toHaveLength(2);
    expect(sends[0].rows).toEqual([]);
    expect(sends[1].rows.map((r: any) => r.components.length)).toEqual([5, 2]);
    expect(sends[1].rows[0].components[0]).toMatchObject({ custom_id: `rb:${SET}:0`, label: "Option 0" });
    expect(sent).toEqual({ messageId: "m1", chatId: "guild-1", threadId: "chan", buttonsMessageId: "m2" });
  });
  it("more than 25 buttons is an error before anything is sent", async () => {
    const { adapter, sends } = discord();
    await expect(adapter.sendText("guild-1", "x", { replyButtons: buttons(26) })).rejects.toThrow(/at most 25 buttons/);
    expect(sends).toEqual([]);
  });
  it("settled: the same buttons, all disabled; the chosen one marked with who chose it", async () => {
    const { adapter, edits } = discord();
    await adapter.settleReplyButtons!("guild-1", "m2", "chan", ["Deploy", "Wait"], { chosenIndex: 1, by: "alice" });
    const [row] = edits[0].rows;
    expect(row.components.map((c: any) => [c.label, c.disabled, c.style])).toEqual([["Deploy", true, 2], ["✓ Wait — alice", true, 3]]);
    await adapter.settleReplyButtons!("guild-1", "m3", "chan", ["Deploy"], { expired: true });
    expect(edits[1].rows[0].components.map((c: any) => [c.label, c.disabled])).toEqual([["Deploy", true]]);
  });
});
