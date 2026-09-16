import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrammyError } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramAdapter, TELEGRAM_TOPIC_GONE_HINT_DEBOUNCE_MS } from "../src/channel/adapters/telegram.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { createAdapter } from "../src/channel/factory.js";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const roots: string[] = [];

function makeAdapter(opts: { topicProbe?: "periodic" | "on-demand" } = {}): TelegramAdapter {
  const root = mkdtempSync(join(tmpdir(), "agend-tg-gone-"));
  roots.push(root);
  // Permissive access stub so a dispatched update travels the whole handler chain.
  const accessManager = { isAllowed: () => ({ allowed: true }), generateCode: () => "000000", confirmCode: () => null } as never;
  const adapter = new TelegramAdapter({ id: "telegram", botToken: TOKEN, accessManager, inboxDir: root, ...opts });
  (adapter as any).lastChatId = "-100123";
  return adapter;
}

/** The transformer installed last is the topic-gone observer; drive it like a real API call. */
function hintTransformer(adapter: TelegramAdapter) {
  const installed = adapter.getBot().api.config.installedTransformers() as any[];
  return installed[installed.length - 1] as (prev: any, method: string, payload: Record<string, unknown>) => Promise<any>;
}
const gone = { ok: false, error_code: 400, description: "Bad Request: message thread not found" };
const fine = { ok: true, result: { message_id: 1 } };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Telegram passive topic detection (#777)", () => {
  it("defaults to on-demand probing and honours the periodic opt-in", () => {
    expect(makeAdapter().topicProbePolicy()).toBe("on-demand");
    expect(makeAdapter({ topicProbe: "periodic" }).topicProbePolicy()).toBe("periodic");
  });

  it("emits topic_closed when a real topic-addressed send is answered with thread-not-found", async () => {
    const adapter = makeAdapter();
    const hints: unknown[] = [];
    adapter.on("topic_closed", hint => hints.push(hint));
    const prev = vi.fn(async () => gone);

    const res = await hintTransformer(adapter)(prev, "sendMessage", { chat_id: -100123, message_thread_id: 118, text: "hi" });

    expect(res).toBe(gone); // the delivery still fails exactly as before
    expect(hints).toEqual([{ chatId: "-100123", threadId: "118" }]);
  });

  it.each([
    ["a different API error", "sendMessage", { chat_id: -100123, message_thread_id: 118, text: "x" }, { ok: false, error_code: 400, description: "Bad Request: chat not found" }],
    ["a send without a thread id", "sendMessage", { chat_id: -100123, text: "x" }, gone],
    ["a method that does not address a topic", "deleteMessage", { chat_id: -100123, message_thread_id: 118, message_id: 5 }, gone],
    ["a successful send", "sendMessage", { chat_id: -100123, message_thread_id: 118, text: "x" }, fine],
  ])("stays silent for %s", async (_label, method, payload, response) => {
    const adapter = makeAdapter();
    const hints: unknown[] = [];
    adapter.on("topic_closed", hint => hints.push(hint));

    await hintTransformer(adapter)(vi.fn(async () => response), method, payload as Record<string, unknown>);

    expect(hints).toEqual([]);
  });

  it("debounces repeated hints for the same topic within one window", async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const hints: unknown[] = [];
    adapter.on("topic_closed", hint => hints.push(hint));
    const send = () => hintTransformer(adapter)(vi.fn(async () => gone), "sendMessage", { chat_id: -100123, message_thread_id: 118, text: "x" });

    await send(); await send(); await send();
    expect(hints).toHaveLength(1);
    vi.advanceTimersByTime(TELEGRAM_TOPIC_GONE_HINT_DEBOUNCE_MS);
    await send();
    expect(hints).toHaveLength(2);
    // Another topic is its own window.
    await hintTransformer(adapter)(vi.fn(async () => gone), "sendMessage", { chat_id: -100123, message_thread_id: 119, text: "x" });
    expect(hints).toHaveLength(3);
  });

  it("does not turn the probe's own thread-not-found into a hint", async () => {
    const adapter = makeAdapter();
    const hints: unknown[] = [];
    adapter.on("topic_closed", hint => hints.push(hint));
    // The probe goes through api.sendMessage; make the whole API chain answer "gone".
    vi.spyOn(adapter.getBot().api, "sendMessage").mockImplementation(async (chatId, _text, other) => {
      // Simulate the transformer observing this probe call before the API throws.
      await hintTransformer(adapter)(async () => gone, "sendMessage", { chat_id: chatId, ...other });
      throw new GrammyError("Call to 'sendMessage' failed!", gone as never, "sendMessage", {});
    });

    await expect(adapter.probeTopicPresence(118)).resolves.toEqual({ status: "missing", evidence: "telegram-topic-not-found" });
    expect(hints).toEqual([]);
  });

  it("no longer treats forum_topic_closed (a close, not a deletion) as a topology hint", async () => {
    const adapter = makeAdapter();
    const hints: unknown[] = [];
    adapter.on("topic_closed", hint => hints.push(hint));
    const bot = adapter.getBot() as any;
    bot.botInfo = { id: 42, is_bot: true, first_name: "agend", username: "agend_bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
    const errors: unknown[] = [];
    bot.catch((err: unknown) => errors.push(err));
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        date: 1,
        chat: { id: -100123, type: "supergroup", title: "fleet", is_forum: true },
        message_thread_id: 118,
        forum_topic_closed: {},
      },
    });
    // The update must have reached the end of the chain, otherwise this test proves nothing.
    expect(errors).toEqual([]);
    expect(hints).toEqual([]);
  });

  it("threads channels[].options.topic_probe through the adapter factory", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-tg-factory-"));
    roots.push(root);
    const opts = { id: "telegram", botToken: TOKEN, accessManager: {} as never, inboxDir: root } as any;
    const periodic = await createAdapter({ type: "telegram", bot_token_env: "T", options: { topic_probe: "periodic" } } as any, opts);
    const dflt = await createAdapter({ type: "telegram", bot_token_env: "T" } as any, opts);
    const junk = await createAdapter({ type: "telegram", bot_token_env: "T", options: { topic_probe: "hourly" } } as any, opts);
    expect(periodic.topicProbePolicy?.()).toBe("periodic");
    expect(dflt.topicProbePolicy?.()).toBe("on-demand");
    expect(junk.topicProbePolicy?.()).toBe("on-demand");
    for (const a of [periodic, dflt, junk]) { (a as any).httpAgent.destroy(); (a as any).httpsAgent.destroy(); }
  });

  it("validates channels[].options.topic_probe for Telegram only", () => {
    const base = { defaults: {}, instances: {} };
    const ok = validateFleetConfig({ ...base, channels: [{ type: "telegram", bot_token_env: "T", options: { topic_probe: "periodic" } }] });
    expect(ok.errors.filter(e => e.path.includes("topic_probe"))).toEqual([]);
    const bad = validateFleetConfig({ ...base, channels: [{ type: "telegram", bot_token_env: "T", options: { topic_probe: "hourly" } }] });
    expect(bad.errors.map(e => e.path)).toContain("channels[0].options.topic_probe");
    const discord = validateFleetConfig({ ...base, channels: [{ type: "discord", bot_token_env: "D", options: { topic_probe: "on-demand" } }] });
    expect(discord.warnings.map(w => w.path)).toContain("channels[0].options.topic_probe");
  });
});
