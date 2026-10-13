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
import { routeToolCall } from "../src/channel/tool-router.js";

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
  // #1657 review P2: a fence or multi-backtick span keeps its text exactly — escaped, never formatted.
  it("fenced code and multi-backtick spans stay literal (escaped only); outside them bold and `code` still render", () => {
    expect(markdownToTelegramHtml("**outside**\n```js\nconst marker = '**literal**';\n```\nand `a<b`"))
      .toBe("<b>outside</b>\n```js\nconst marker = '**literal**';\n```\nand <code>a&lt;b</code>");
    expect(markdownToTelegramHtml("```a<b && **literal**```")).toBe("```a&lt;b &amp;&amp; **literal**```");
    expect(markdownToTelegramHtml("``x `y` _z_`` then _it_")).toBe("``x `y` _z_`` then <i>it</i>");
    // An unclosed fence is only its own backticks; the rest is ordinary text.
    expect(markdownToTelegramHtml("``` then **b**")).toBe("``` then <b>b</b>");
    // A run closes only on a run of the same length.
    expect(markdownToTelegramHtml("```a``b```**c**")).toBe("```a``b```<b>c</b>");
    expect(markdownToTelegramHtml("``a ```b`` **c**")).toBe("``a ```b`` <b>c</b>");
    expect(markdownToTelegramHtml("``a ```b **c**``")).toBe("``a ```b **c**``");
    // A single backtick pairs only with a single backtick on the same line.
    expect(markdownToTelegramHtml("`a ``b`` c")).toBe("`a ``b`` c");
    expect(markdownToTelegramHtml("`a\nb` **c**")).toBe("`a\nb` <b>c</b>");
  });
  it("overlapping emphasis never misnests", () => {
    expect(markdownToTelegramHtml("**a *b** c*")).toBe("**a *b** c*");
    expect(markdownToTelegramHtml("~~a **b**~~")).toBe("~~a <b>b</b>~~");
  });

  // Any input: the only tags are the ones the converter writes, properly nested; every other & < > is an entity.
  it("output is always well-formed Telegram HTML (generated inputs)", () => {
    const alphabet = ["*", "**", "_", "~~", "`", "``", "```", "```js\n", "[", "]", "(", ")", "<", ">", "&", "a", "b", " ", "\n", "https://h.test/", "<b>", "&amp;"];
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

// #1657 review P1: the converter runs on the fleet's event loop before any API call, on text as long as a tool
// argument allows (262144 characters) — so it must stay linear for adversarial input, not rely on Telegram's limit.
describe("the converter is linear on schema-sized input", () => {
  const N = 262_144;
  const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const shapes = ["[", "[a", "[a]", "[a](", "[a](https://x", "`", "`a", "`a\n", "``a", "```a", "`".repeat(3) + "a``", "*", "*a", "**a", "_a", "a_", "~~a", "<", "&",
    // every run length once (unclosed fences of distinct lengths)
    Array.from({ length: 700 }, (_, k) => "`".repeat(k + 2) + "a").join("")];
  it("each adversarial shape converts in well under a second", () => {
    const slow: string[] = [];
    for (const shape of shapes) {
      const text = fill(shape);
      const t0 = performance.now();
      markdownToTelegramHtml(text);
      const ms = performance.now() - t0;
      if (ms > 1000) slow.push(`${JSON.stringify(shape.slice(0, 12))}: ${Math.round(ms)}ms`);
    }
    expect(slow).toEqual([]);
  });
  it("through the real router and adapter: a 262144-character edit reaches editMessageText promptly", async () => {
    const editMessageText = vi.fn(async () => undefined);
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    (adapter as unknown as { bot: unknown }).bot = { api: { editMessageText } };
    const text = fill("[");
    const t0 = performance.now();
    const result = await new Promise((resolve) => {
      routeToolCall(adapter, "edit_message", { chat_id: "100", message_id: "7", text, format: "markdown" }, undefined, (r, e) => resolve(e ?? r));
    });
    expect([result, editMessageText.mock.calls.length, (editMessageText.mock.calls[0] as unknown[])[2] === text, performance.now() - t0 < 2000])
      .toEqual(["ok", 1, true, true]);
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
    for (const err of [refusal("Bad Request: chat not found"), refusal(PARSE, 429), new HttpError("network down", new Error("ECONNRESET"))]) {
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
