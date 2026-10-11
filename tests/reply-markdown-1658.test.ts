/**
 * #1658 (baseline: the issue body): on Telegram, reply with format "markdown" sent the raw text with parse_mode HTML on
 * the plain path — `a<b` or `&` was refused and **bold** showed literally. "markdown" now reaches the adapter as
 * markdown and the plain path converts it escape-first (the converter from #1651's follow-up), with one plain-text
 * retry on a markup refusal. The rich path (tables, code, headings → sendRichMessage) is unchanged, and format "html"
 * (internal callers' own HTML) is unchanged. The real tool router and the real TelegramAdapter with its Bot API stubbed.
 */
import { describe, expect, it, vi } from "vitest";
import { GrammyError, HttpError } from "grammy";
import { routeToolCall } from "../src/channel/tool-router.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";

const PARSE = "Bad Request: can't parse entities: Can't find end tag corresponding to start tag \"b\"";
const refusal = (description: string, error_code = 400) =>
  new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code, description }, "sendMessage", {});

describe("the tool router passes reply's markdown as markdown", () => {
  const route = (args: Record<string, unknown>) => {
    const sendText = vi.fn(async () => ({ messageId: "1", chatId: "c1" }));
    routeToolCall({ sendText } as never, "reply", { chat_id: "c1", text: "**hi**", ...args }, "th1", () => {});
    return sendText.mock.calls.map((c) => (c as unknown[])[2] as { format?: string });
  };
  it("markdown → { format: \"markdown\" }; text or none → no format", () => {
    expect([route({ format: "markdown" })[0]!.format, route({ format: "text" })[0]!.format, route({})[0]!.format])
      .toEqual(["markdown", undefined, undefined]);
  });
});

describe("Telegram reply, plain path", () => {
  type Api = { sendMessage: ReturnType<typeof vi.fn>; raw: { sendRichMessage: ReturnType<typeof vi.fn> } };
  const make = (sendMessage?: (...a: unknown[]) => Promise<unknown>) => {
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    let id = 40;
    const api: Api = {
      sendMessage: vi.fn(sendMessage ?? (async () => ({ message_id: ++id }))),
      raw: { sendRichMessage: vi.fn(async () => ({ message_id: 99 })) },
    };
    const enqueue = vi.fn();
    Object.assign(adapter as object, { bot: { api }, queue: { enqueue } });
    return { adapter, api, enqueue };
  };

  it("`a<b`, `&`, bold, code and a link: converted, sent with parse_mode HTML", async () => {
    const t = make();
    await t.adapter.sendText("100", "x < 3 & a<b, **bold** `c<d` [docs](https://x.test/?a=1&b=2)", { format: "markdown" });
    expect(t.api.sendMessage.mock.calls).toEqual([[100,
      "x &lt; 3 &amp; a&lt;b, <b>bold</b> <code>c&lt;d</code> <a href=\"https://x.test/?a=1&amp;b=2\">docs</a>",
      { parse_mode: "HTML" }]]);
  });

  it("an HTML tag in markdown is shown as text", async () => {
    const t = make();
    await t.adapter.sendText("100", "<b>hi</b> & <i>x</i>", { format: "markdown" });
    expect(t.api.sendMessage.mock.calls).toEqual([[100, "&lt;b&gt;hi&lt;/b&gt; &amp; &lt;i&gt;x&lt;/i&gt;", { parse_mode: "HTML" }]]);
  });

  it("a markup refusal is sent once more as the original plain text, and that message is the result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = make(async (_c, _t, o) => {
        if ((o as { parse_mode?: string }).parse_mode === "HTML") throw refusal(PARSE);
        return { message_id: 51 };
      });
      const sent = await t.adapter.sendText("100", "**hi** <", { format: "markdown", threadId: "7" });
      expect([t.api.sendMessage.mock.calls, sent.messageId]).toEqual([[
        [100, "<b>hi</b> &lt;", { message_thread_id: 7, parse_mode: "HTML" }],
        [100, "**hi** <", { message_thread_id: 7, parse_mode: undefined }],
      ], "51"]);
    } finally { warn.mockRestore(); }
  });

  it("any other failure is the caller's error — no second send", async () => {
    for (const err of [refusal("Bad Request: chat not found"), refusal(PARSE, 429), new HttpError("network down", new Error("ECONNRESET"))]) {
      const t = make(async () => { throw err; });
      const outcome = await t.adapter.sendText("100", "a<b", { format: "markdown" }).then(() => "resolved", (e) => e);
      expect([outcome, t.api.sendMessage.mock.calls.length], String(err)).toEqual([err, 1]);
    }
  });

  it("a long reply is cut before converting: the first part is the converted first 4096 characters", async () => {
    const t = make();
    await t.adapter.sendText("100", "&".repeat(5000), { format: "markdown" });
    expect([t.api.sendMessage.mock.calls[0]![1], t.enqueue.mock.calls]).toEqual(["&amp;".repeat(4096),
      [["100", undefined, { type: "content", text: "&".repeat(904) }]]]);
  });

  it("format html (internal callers) is still sent as the caller's HTML", async () => {
    const t = make();
    await t.adapter.sendText("100", "<b>a&amp;b</b>", { format: "html" });
    expect(t.api.sendMessage.mock.calls).toEqual([[100, "<b>a&amp;b</b>", { parse_mode: "HTML" }]]);
  });

  it("no format: plain text, as always", async () => {
    const t = make();
    await t.adapter.sendText("100", "**a<b**");
    expect(t.api.sendMessage.mock.calls).toEqual([[100, "**a<b**", { parse_mode: undefined }]]);
  });

  it("the rich path is untouched: a heading goes to sendRichMessage as the agent's markdown", async () => {
    const t = make();
    const text = "# Report\n\na<b & **bold**";
    await t.adapter.sendText("100", text, { format: "markdown" });
    expect([t.api.raw.sendRichMessage.mock.calls, t.api.sendMessage.mock.calls.length])
      .toEqual([[[{ chat_id: 100, rich_message: { markdown: text } }]], 0]);
  });

  it("a reply with buttons: each part converted, the keyboard on the last; a refused part is resent plain", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let n = 0;
      const t = make(async (_c, text) => { if (text === "<b>b</b>") throw refusal(PARSE); return { message_id: ++n }; });
      const sent = await t.adapter.sendText("100", "**b**<x", { format: "markdown", chunkLimit: 5, replyButtons: [{ id: "rb:s:0", label: "OK" }] });
      const keyboard = { reply_markup: { inline_keyboard: [[{ text: "OK", callback_data: "rb:s:0" }]] } };
      expect([t.api.sendMessage.mock.calls, sent]).toEqual([[
        [100, "<b>b</b>", { parse_mode: "HTML" }],
        [100, "**b**", { parse_mode: undefined }],
        [100, "&lt;x", { parse_mode: "HTML", ...keyboard }],
      ], { messageId: "1", chatId: "100", threadId: undefined, buttonsMessageId: "2" }]);
    } finally { warn.mockRestore(); }
  });
});
