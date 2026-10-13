import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { DiscordAPIError } from "discord.js";
import { GrammyError, HttpError } from "grammy";
import { isMessageEditLoss } from "../src/channel/message-edit-errors.js";
import { NeedsYouHub, type NeedsYouHubContext } from "../src/needs-you-hub.js";
import { RENEW_MS } from "../src/needs-you-live.js";
import { POST_MIN_MS, EDIT_MIN_MS } from "../src/needs-you-live.js";
import { setLocale, t } from "../src/locale.js";

const NO_CHANGE = {
  ok: false as const, error_code: 400,
  description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
};
const roots: string[] = [];
const adapters: TelegramAdapter[] = [];

/** Real grammY methods/transformers/error construction, with an inert transport underneath. */
function fakeTelegram() {
  const dir = mkdtempSync(join(tmpdir(), "agend-needs-refresh-1751-"));
  roots.push(dir);
  const adapter = new TelegramAdapter({ id: "tg", botToken: ["123456789", "fixture"].join(":"), accessManager: {} as never, inboxDir: dir });
  adapters.push(adapter);
  const api = adapter.getBot().api;
  const posts: Record<string, any>[] = [], edits: Record<string, any>[] = [];
  let editReply: any = NO_CHANGE;
  let sequence = 10;
  const transport = async (method: string, payload: any): Promise<any> => {
    if (method === "sendMessage") { posts.push(payload); return { ok: true, result: { message_id: ++sequence } }; }
    if (method === "editMessageText" || method === "editMessageReplyMarkup") {
      edits.push({ method, ...payload }); if (editReply instanceof Error) throw editReply; return editReply;
    }
    if (method === "deleteMessage") return { ok: true, result: true };
    throw new Error(`Unstubbed Telegram method: ${method}`);
  };
  // Appending a fake transport alone would bypass production transformers. Replay that chain over the fake base.
  const call = api.config.installedTransformers().reduce<any>((prev, transform) =>
    (method: any, payload: any, signal: any) => transform(prev, method, payload, signal), transport);
  api.config.use((_prev, method, payload, signal) => call(method, payload, signal));
  return { dir, adapter, posts, edits, reply: (value: any) => { editReply = value; } };
}

function hubRig() {
  vi.useFakeTimers();
  setLocale("zh-TW");
  const tg = fakeTelegram();
  writeFileSync(join(tg.dir, "needs-you-message.json"), JSON.stringify({ tg: { chatId: "-100123", messageId: "1" } }));
  const logs: string[] = [];
  const ctx: NeedsYouHubContext = {
    dataDir: tg.dir, now: () => Date.now(), mono: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    prompts: () => [], instances: () => [], deliveries: () => [], ownerOf: () => "tg",
    worlds: () => [{ id: "tg", adapter: tg.adapter, place: { type: "telegram", groupId: "-100123" } }],
    noticeTarget: () => ({ chatId: "-100123" }), instanceTopic: () => undefined,
    isFleetAdmin: () => true, fleetAdmins: () => [], emitSse: () => {}, acknowledge: () => false,
    settings: () => ({ liveMessage: true, dm: false }), stopping: () => false, t,
    log: (_level, message) => { logs.push(message); },
  };
  const hub = new NeedsYouHub(ctx);
  hub.start();
  return { ...tg, hub, logs, changed: () => {
    // A language-only render changes text without a new item (new items deliberately still notify by posting).
    setLocale("en");
    (hub as any).live.get("tg").renderer.changed(false);
  } };
}

afterEach(() => {
  vi.useRealTimers(); setLocale("en");
  for (const a of adapters.splice(0)) { (a as any).httpAgent.destroy(); (a as any).httpsAgent.destroy(); }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("#1751 real hub → renderer → Telegram edits", () => {
  it("twelve identical empty renewals never post another message and skip subsequent edits", async () => {
    const r = hubRig();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(12 * RENEW_MS);
    expect(r.posts).toEqual([]);
    expect(r.edits).toHaveLength(1); // The persisted pointer needs one successful render this lifecycle.
    expect(r.edits[0].text).toBe("✅ 目前沒有需要你處理的事。");
    expect(r.logs.some(x => x.includes("posting a new one"))).toBe(false);
  });

  it("a real 400 unchanged edit is a successful no-op, including button-only edits", async () => {
    const r = fakeTelegram();
    expect(await r.adapter.editAlert("-100123", "1", { type: "needs_you", instanceName: "", message: "same", choices: [] }).catch(e => e)).toBeUndefined();
    expect(await r.adapter.replaceMessageButtons("-100123", "1", [{ id: "cancel:fixture", label: "Cancel" }]).catch(e => e)).toBeUndefined();
    expect(r.posts).toEqual([]);
    expect(r.edits.map(e => e.method)).toEqual(["editMessageText", "editMessageReplyMarkup"]);
    expect(r.edits[1].reply_markup.inline_keyboard).toEqual([[{ text: "Cancel", callback_data: "cancel:fixture" }]]);
  });

  it.each(["plain", "html", "markdown", "remove-buttons", "settle", "remove-markup"])(
    "the other %s edit path uses the same no-op without another request", async kind => {
      const r = fakeTelegram();
      const operation = () => kind === "remove-buttons" ? r.adapter.editMessageRemoveButtons("-100123", "1", "same")
        : kind === "settle" ? r.adapter.settleReplyButtons("-100123", "1", undefined, ["A"], { chosenIndex: 0, by: "fixture" })
        : kind === "remove-markup" ? r.adapter.removeMessageButtons("-100123", "1")
        : r.adapter.editMessage("-100123", "1", "same", undefined, kind === "plain" ? undefined : { format: kind as "html" | "markdown" });
      expect(await operation().catch(e => e)).toBeUndefined();
      expect(r.edits).toHaveLength(1); expect(r.posts).toEqual([]);
    });

  it.each([400, 429, 500])("button edits retain other API failures (%i) and do not retry", async error_code => {
    const r = fakeTelegram();
    const description = error_code === 400 ? "Bad Request: message to edit not found" : NO_CHANGE.description;
    r.reply({ ok: false, error_code, description });
    const outcome = await r.adapter.removeMessageButtons("-100123", "1").catch(e => e);
    expect(outcome).toBeInstanceOf(GrammyError); expect(outcome.error_code).toBe(error_code);
    expect(r.edits).toHaveLength(1); expect(r.posts).toEqual([]);
  });

  it("a generic error with no-change wording is never a successful edit", async () => {
    const r = fakeTelegram(); const err = new Error(NO_CHANGE.description); r.reply(err);
    expect(await r.adapter.editMessage("-100123", "1", "same").catch(e => e)).toBe(err);
    expect(r.edits).toHaveLength(1);
  });

  it("a boxed no-change description preserves the original API error as unknown", async () => {
    const r = fakeTelegram();
    const err = new GrammyError("malformed", { ok: false, error_code: 400, description: new String(NO_CHANGE.description) } as never, "editMessageText", {});
    r.reply(err);
    expect(await r.adapter.editMessage("-100123", "1", "same").catch(e => e)).toBe(err);
  });

  it("a confirmed deleted message produces exactly one replacement", async () => {
    const r = hubRig();
    r.reply({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.posts).toHaveLength(1);
    // The successful replacement's identical render is cached, even if the old deletion response stays queued.
    await vi.advanceTimersByTimeAsync(12 * RENEW_MS);
    expect(r.posts).toHaveLength(1);
    expect(r.edits).toHaveLength(1);
  });

  it("repeated deletion is limited to one post per minute and logs the limit", async () => {
    const r = hubRig();
    r.reply({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" });
    await vi.advanceTimersByTimeAsync(0);
    r.changed();
    await vi.advanceTimersByTimeAsync(EDIT_MIN_MS);
    expect(r.posts).toHaveLength(1);
    expect(r.logs.some(x => x.includes("rate-limited"))).toBe(true);
    await vi.advanceTimersByTimeAsync(POST_MIN_MS - EDIT_MIN_MS - 1);
    expect(r.posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.posts).toHaveLength(2);
  });

  it.each([
    [429, "Too Many Requests: retry after 20"], [500, "Internal Server Error"],
    [400, "Bad Request: can't parse entities"], [400, "Bad Request: message can't be edited"],
    [401, "Unauthorized"],
  ])("a non-loss API refusal %i preserves the pointer without reposting", async (error_code, description) => {
    const r = hubRig(); r.reply({ ok: false, error_code, description });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2 * RENEW_MS);
    expect(r.posts).toEqual([]);
    expect(r.edits).toHaveLength(3);
    expect(r.logs.some(x => x.includes("keeping the existing message"))).toBe(true);
  });

  it.each([
    [400, "Bad Request: chat not found"], [400, "Bad Request: message thread not found"],
    [403, "Forbidden: bot is not a member of the supergroup chat"],
  ])("provider-confirmed destination or permission loss %i permits a replacement", async (error_code, description) => {
    const r = hubRig(); r.reply({ ok: false, error_code, description });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.posts).toHaveLength(1);
  });

  it("a transiently unavailable edit recovers before the post window without a forced repost", async () => {
    const r = hubRig(); r.reply({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" });
    await vi.advanceTimersByTimeAsync(0);
    r.changed(); await vi.advanceTimersByTimeAsync(EDIT_MIN_MS);
    r.reply({ ok: true, result: true });
    await vi.advanceTimersByTimeAsync(POST_MIN_MS);
    expect(r.posts).toHaveLength(1);
  });

  it("an uncertain failed edit invalidates the previous render cache", async () => {
    const r = hubRig(); await vi.advanceTimersByTimeAsync(0);
    r.reply({ ok: false, error_code: 500, description: "Internal Server Error" });
    r.changed(); await vi.advanceTimersByTimeAsync(EDIT_MIN_MS);
    r.reply({ ok: true, result: true }); setLocale("zh-TW");
    (r.hub as any).live.get("tg").renderer.changed(false);
    await vi.advanceTimersByTimeAsync(EDIT_MIN_MS);
    expect(r.posts).toEqual([]); expect(r.edits).toHaveLength(3);
    expect(r.edits[2].text).toBe("✅ 目前沒有需要你處理的事。");
  });

  it("forward and backward wall jumps cannot shorten the monotonic replacement limit", async () => {
    const r = hubRig(); r.reply({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" });
    await vi.advanceTimersByTimeAsync(0);
    r.changed(); vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    await vi.advanceTimersByTimeAsync(EDIT_MIN_MS);
    expect(r.posts).toHaveLength(1);
    vi.setSystemTime(Date.now() - 72 * 60 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000 - EDIT_MIN_MS - 1);
    expect(r.posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.posts).toHaveLength(2);
  });
});

describe("#1751 loss evidence", () => {
  it.each([undefined, null, 7, {}])("malformed provider descriptions (%s) are unknown, without throwing", description => {
    const err = new GrammyError("malformed", { ok: false, error_code: 403, description } as never, "editMessageText", {});
    expect(() => isMessageEditLoss(err)).not.toThrow();
    expect(isMessageEditLoss(err)).toBe(false);
  });
  it("transport and generic strings cannot prove a lost message", () => {
    expect(isMessageEditLoss(new HttpError("network", new Error("message to edit not found")))).toBe(false);
    expect(isMessageEditLoss(new Error("Bad Request: message to edit not found"))).toBe(false);
    expect(isMessageEditLoss({ error_code: 400, description: "Bad Request: chat not found" })).toBe(false);
    expect(isMessageEditLoss(new GrammyError("unavailable", { ok: false, error_code: 500, description: "Bad Request: message to edit not found" }, "editMessageText", {}))).toBe(false);
  });

  it.each([[10008,404,true],[10003,404,true],[50001,403,true],[50013,403,true],[50035,400,false],[10008,500,false]])(
    "Discord typed API code %i/status %i has loss=%s", (code,status,loss) => {
      const err = new DiscordAPIError({ code, message: "fixture" }, code, status, "PATCH", "/fixture", { body: {} });
      expect(isMessageEditLoss(err)).toBe(loss);
    });

  it("a malformed string Discord code cannot authorize replacement by coercion", () => {
    const err = new DiscordAPIError({ code: "10008", message: "fixture" } as never, "10008", 404, "PATCH", "/fixture", { body: {} });
    expect(isMessageEditLoss(err)).toBe(false);
  });
});
