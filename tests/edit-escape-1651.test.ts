/**
 * #1651 follow-up (#1654 review P3): a Telegram edit_message with format "markdown" containing `<`, `&` or `a<b` was
 * refused ("can't parse entities") once #1654 started sending parse_mode HTML. The text is now converted escape-first
 * to Telegram HTML, and a markup refusal is retried once as plain text. The real converter and the real
 * TelegramAdapter.editMessage with editMessageText stubbed.
 */
import { describe, expect, it, vi } from "vitest";
import { GrammyError, HttpError } from "grammy";
import { markdownToTelegramHtml, isTelegramParseRefusal } from "../src/channel/telegram-markdown.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";

const refusal = (description: string, error_code = 400) =>
  new GrammyError("Call to 'editMessageText' failed!", { ok: false, error_code, description }, "editMessageText", {});
const PARSE = "Bad Request: can't parse entities: Unsupported start tag \"b\" at byte offset 1";

describe("markdownToTelegramHtml escapes first", () => {
  it("`<`, `&`, `>` and `a<b` become entities", () => {
    expect(markdownToTelegramHtml("a<b & c > d")).toBe("a&lt;b &amp; c &gt; d");
    expect(markdownToTelegramHtml("if (x < 3 && y > 2)")).toBe("if (x &lt; 3 &amp;&amp; y &gt; 2)");
  });
  it("an HTML tag in the text is shown as text, never parsed", () => {
    expect(markdownToTelegramHtml("<b>hi</b> <a href=\"x\">y</a>")).toBe("&lt;b&gt;hi&lt;/b&gt; &lt;a href=\"x\"&gt;y&lt;/a&gt;");
    expect(markdownToTelegramHtml("&amp; stays literal")).toBe("&amp;amp; stays literal");
  });
  it("bold, italic, strike", () => {
    expect(markdownToTelegramHtml("**bold** *it* _it2_ ~~gone~~")).toBe("<b>bold</b> <i>it</i> <i>it2</i> <s>gone</s>");
    expect(markdownToTelegramHtml("**a<b**")).toBe("<b>a&lt;b</b>");
  });
  it("snake_case, a lone *, and 2 * 3 * 4 are left alone", () => {
    expect(markdownToTelegramHtml("my_var_name and a * b")).toBe("my_var_name and a * b");
    expect(markdownToTelegramHtml("set my_var_ = 1")).toBe("set my_var_ = 1");
    expect(markdownToTelegramHtml("2 * 3 * 4")).toBe("2 * 3 * 4");
  });
  it("inline code: escaped, and nothing inside is formatted", () => {
    expect(markdownToTelegramHtml("run `a<b && **c**` now")).toBe("run <code>a&lt;b &amp;&amp; **c**</code> now");
  });
  it("links: http(s) only, the target escaped, the text formatted", () => {
    expect(markdownToTelegramHtml("see [**docs**](https://x.test/?a=1&b=2)"))
      .toBe("see <a href=\"https://x.test/?a=1&amp;b=2\"><b>docs</b></a>");
    expect(markdownToTelegramHtml("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
    expect(markdownToTelegramHtml("[x](javascript:void) [y](ftp://h.test/f)")).toBe("[x](javascript:void) [y](ftp://h.test/f)");
    // A quote would end the href attribute early — such a target is not a link.
    expect(markdownToTelegramHtml("[x](https://e.test/a\"onclick)")).toBe("[x](https://e.test/a\"onclick)");
    expect(markdownToTelegramHtml("[x](https://e.test/**y**)")).toBe("<a href=\"https://e.test/**y**\">x</a>");
  });
  it("overlapping emphasis never misnests", () => {
    expect(markdownToTelegramHtml("**a *b** c*")).toBe("**a *b** c*");
    expect(markdownToTelegramHtml("~~a **b**~~")).toBe("~~a <b>b</b>~~");
  });

  // Any input: the only tags are the ones the converter writes, properly nested; every other & < > is an entity.
  it("output is always well-formed Telegram HTML (generated inputs)", () => {
    const alphabet = ["*", "**", "_", "~~", "`", "[", "]", "(", ")", "<", ">", "&", "a", "b", " ", "\n", "https://h.test/", "<b>", "&amp;"];
    let seed = 1651;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const bad: string[] = [];
    for (let i = 0; i < 3000; i++) {
      let input = "";
      for (let j = rand(24); j >= 0; j--) input += alphabet[rand(alphabet.length)];
      const html = markdownToTelegramHtml(input);
      const stack: string[] = [];
      let ok = true;
      const rest = html.replace(/<(\/?)(b|i|s|code|a)(?: href="https?:\/\/[^"<>\s]+")?>/g, (_m, close: string, tag: string) => {
        if (!close) stack.push(tag);
        else if (stack.pop() !== tag) ok = false;
        return "";
      });
      if (!ok || stack.length || /[<>]/.test(rest) || /&(?!amp;|lt;|gt;)/.test(rest)) bad.push(JSON.stringify(input) + " → " + JSON.stringify(html));
    }
    expect(bad).toEqual([]);
  });
});

describe("isTelegramParseRefusal", () => {
  it("only Telegram's 400 can't parse entities", () => {
    expect([
      isTelegramParseRefusal(refusal(PARSE)),
      isTelegramParseRefusal(refusal("Bad Request: message is not modified")),
      isTelegramParseRefusal(refusal(PARSE, 500)),
      isTelegramParseRefusal(new Error(PARSE)),
    ]).toEqual([true, false, false, false]);
  });
});

describe("Telegram: a markdown edit", () => {
  type Internals = { bot: { api: { editMessageText: ReturnType<typeof vi.fn> } } };
  const make = (impl?: (...a: unknown[]) => Promise<unknown>) => {
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    const editMessageText = vi.fn(impl ?? (async () => undefined));
    (adapter as unknown as Internals).bot = { api: { editMessageText } };
    return { adapter, editMessageText };
  };

  it("containing `<`, `&` and `a<b` is sent with the right entities and parse_mode HTML", async () => {
    const t = make();
    await t.adapter.editMessage("100", "7", "x < 3 & a<b, **done**", undefined, { format: "markdown" });
    expect(t.editMessageText.mock.calls).toEqual([[100, 7, "x &lt; 3 &amp; a&lt;b, <b>done</b>", { parse_mode: "HTML" }]]);
  });

  it("a markup refusal is retried once as the original plain text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = make(async (...a) => { if (a.length === 4) throw refusal(PARSE); return undefined; });
      await t.adapter.editMessage("100", "7", "**hi** <", undefined, { format: "markdown" });
      expect(t.editMessageText.mock.calls).toEqual([
        [100, 7, "<b>hi</b> &lt;", { parse_mode: "HTML" }],
        [100, 7, "**hi** <"],
      ]);
    } finally { warn.mockRestore(); }
  });

  it("any other failure is the caller's error — no second edit", async () => {
    for (const err of [refusal("Bad Request: message is not modified"), refusal(PARSE, 429), new HttpError("network down", new Error("ECONNRESET"))]) {
      const t = make(async () => { throw err; });
      const outcome = await t.adapter.editMessage("100", "7", "a<b", undefined, { format: "markdown" }).then(() => "resolved", (e) => e);
      expect([outcome, t.editMessageText.mock.calls.length], String(err)).toEqual([err, 1]);
    }
  });

  it("format html is still the caller's own HTML, unconverted", async () => {
    const t = make();
    await t.adapter.editMessage("100", "7", "<b>a&amp;b</b>", undefined, { format: "html" });
    expect(t.editMessageText.mock.calls).toEqual([[100, 7, "<b>a&amp;b</b>", { parse_mode: "HTML" }]]);
  });
});
