import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { handleWebRequest, sseFrame, broadcastSseEvent, type WebApiContext } from "../src/web-api.js";
import { WebChatHistory, WEB_CHAT_TEXT_MAX, parseLastEventId } from "../src/web-chat-history.js";

/**
 * Web chat, first step towards Telegram parity (C1): messages render as Markdown (safely), a reload or a dropped
 * stream no longer empties the chat, and the composer takes several lines. Expectations are written by hand.
 */

// ── chat-render.js, as served ──────────────────────────────────────────────────────────────────────────────────

interface Render {
  renderMarkdown(text: unknown): string;
  escapeHtml(text: unknown): string;
  mergeMessages(existing: unknown[] | undefined, incoming: unknown[], cap?: number): Array<{ id: number }>;
  composerKey(ev: unknown): "send" | "newline" | "none";
  settleFailedSend(target: string, current: string | null, composerPresent: boolean, composerValue: string): "restore" | "keep";
  putBack(failed: string, draft: string): string;
}
const SRC = readFileSync(join(process.cwd(), "src", "ui", "chat-render.js"), "utf8");
function asScript(): Render { const c = vm.createContext({}); vm.runInContext(SRC, c); return (c as { AgendChatRender: Render }).AgendChatRender; }
function asModule(): Render { const module = { exports: {} as Render }; vm.runInContext(SRC, vm.createContext({ module })); return module.exports; }

describe.each([["a classic script", asScript], ["a CommonJS module", asModule]])("chat-render.js as %s", (_n, load) => {
  const { renderMarkdown: md, mergeMessages, composerKey, settleFailedSend, putBack } = load();

  describe("no message can produce markup of its own", () => {
    it.each([
      ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
      ['<img src=x onerror="alert(1)">', "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"],
      ["<a href='javascript:alert(1)'>x</a>", "&lt;a href=&#39;javascript:alert(1)&#39;&gt;x&lt;/a&gt;"],
      ["&lt;b&gt; stays text", "&amp;lt;b&amp;gt; stays text"],
    ])("%j", (input, escaped) => {
      const html = md(input);
      expect(html).toBe(`<p>${escaped}</p>`);
    });

    it.each([
      "[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x](data:text/html,<script>alert(1)</script>)",
      "[x](vbscript:msgbox)", "[x](//evil.example/path)", "[x](/relative)", "[x](file:///etc/passwd)",
    ])("a link to %j is not a link", input => {
      expect(md(input)).not.toMatch(/<a /);
    });

    it("a quote in a URL cannot leave the href attribute", () => {
      const html = md('[x](https://e.example/"onmouseover="alert(1))');
      expect(html).not.toMatch(/"\s*onmouseover=/);
      const bare = md('see https://e.example/a"onmouseover="alert(1) now');
      expect(bare).not.toMatch(/"\s*onmouseover=/);
      expect(bare).not.toMatch(/<a [^>]*onmouseover/);
    });

    it("every tag in any output is one of the renderer's own", () => {
      const nasty = ["<svg/onload=alert(1)>", "```\n<script>x</script>\n```", "`<b>`", "**<i>x</i>**", "> <iframe>", "- <style>", "# <h1>", "[<b>](https://a.example)", "\u0000 0 \u0000",
        "| <img src=x onerror=alert(1)> | b |", "|---|---|", "| <script> | `<b>` |", "  - <svg>", "```js\nconst s = \"<script>alert(1)</script>\"; // <b>\n```"].join("\n");
      const tags = [...md(nasty).matchAll(/<\/?([a-z0-9]+)/g)].map(m => m[1]);
      for (const tag of tags) expect(["p", "br", "pre", "code", "a", "strong", "em", "del", "ul", "ol", "li", "blockquote", "h3", "h4", "h5", "h6", "hr", "div", "table", "thead", "tbody", "tr", "th", "td", "span"]).toContain(tag);
      // The only attributes ever written are the renderer's own fixed ones.
      const attrs = [...md(nasty).matchAll(/<[a-z0-9]+ ([^>]*)>/g)].map(m => m[1]!.replace(/="[^"]*"/g, "")).join(" ").split(/\s+/).filter(Boolean);
      for (const a of attrs) expect(["href", "target", "rel", "class", "data-lang"]).toContain(a);
    });

    it("the placeholder character cannot be used to pull in another link's markup", () => {
      const html = md("[a](https://a.example) \u00000\u0000");
      expect((html.match(/<a /g) ?? []).length).toBe(1);
    });
  });

  describe("what Telegram users already get", () => {
    it.each([
      ["**bold** and *em* and _em_ and ~~gone~~", "<p><strong>bold</strong> and <em>em</em> and <em>em</em> and <del>gone</del></p>"],
      ["use `npm test` now", "<p>use <code>npm test</code> now</p>"],
      ["`**not bold**`", "<p><code>**not bold**</code></p>"],
      ["snake_case_name stays", "<p>snake_case_name stays</p>"],
      ["2 * 3 * 4", "<p>2 * 3 * 4</p>"],
      ["line one\nline two", "<p>line one<br>line two</p>"],
      ["para one\n\npara two", "<p>para one</p><p>para two</p>"],
      ["- a\n- b", "<ul><li>a</li><li>b</li></ul>"],
      ["1. a\n2. b", "<ol><li>a</li><li>b</li></ol>"],
      ["> quoted\n> more", "<blockquote>quoted<br>more</blockquote>"],
      ["# Title", "<h3>Title</h3>"],
      ["---", "<hr>"],
      ["[docs](https://agend.example/docs?a=1&b=2)", '<p><a href="https://agend.example/docs?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">docs</a></p>'],
      ["see https://agend.example/x.", '<p>see <a href="https://agend.example/x" target="_blank" rel="noopener noreferrer">https://agend.example/x</a>.</p>'],
      ["mail [me](mailto:a@b.example)", '<p>mail <a href="mailto:a@b.example" target="_blank" rel="noopener noreferrer">me</a></p>'],
    ])("%j", (input, html) => {
      expect(md(input)).toBe(html);
    });

    it("a fenced code block is verbatim and escaped, its language kept as data (a language it does not highlight)", () => {
      expect(md("before\n```rust\nconst a = 1 < 2 && **x**;\n```\nafter")).toBe(
        '<p>before</p><pre data-lang="rust"><code>const a = 1 &lt; 2 &amp;&amp; **x**;</code></pre><p>after</p>');
    });

    it("an unclosed fence still renders the rest as code (a reply cut mid-block)", () => {
      expect(md("```\nopen <b>")).toBe("<pre><code>open &lt;b&gt;</code></pre>");
    });

    it("a `code` span inside a link label keeps its text (a placeholder inside a placeholder is expanded)", () => {
      expect(md("[`src/foo.ts`](https://agend.example/foo)")).toBe(
        '<p><a href="https://agend.example/foo" target="_blank" rel="noopener noreferrer"><code>src/foo.ts</code></a></p>');
      expect(md("see [**`x`** and `y`](https://a.example)")).toContain("<strong><code>x</code></strong> and <code>y</code></a>");
      expect(md("[a](https://a.example)")).not.toContain("\u0000");
    });

    it("a placeholder is never expanded inside an href: a URL that holds one is not linked", () => {
      const html = md("[x](https://a.example/`<b>`)");
      expect(html).not.toMatch(/href="[^"]*<code>/);
      expect(html).not.toMatch(/href="[^"]*\u0000/);
    });

    it("every link opens in a new tab without a reference to this page", () => {
      for (const a of md("[a](https://a.example) https://b.example").match(/<a [^>]*>/g)!) {
        expect(a).toContain('target="_blank"');
        expect(a).toContain('rel="noopener noreferrer"');
      }
    });

    it("nested lists: deeper items open a list inside the item; shallower ones close back; - and 1. mix", () => {
      expect(md("- one\n  - two\n    1. three\n- four")).toBe(
        "<ul><li>one<ul><li>two<ol><li>three</li></ol></li></ul></li><li>four</li></ul>");
      expect(md("1. a\n   - b\n   - c\n2. d")).toBe("<ol><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ol>");
      expect(md("- a\n\t- tab-indented")).toBe("<ul><li>a<ul><li>tab-indented</li></ul></li></ul>");
      expect(md("- a\n- b\n1. c")).toBe("<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>");
      expect(md("- **bold** item\n  - [link](https://a.example)")).toBe(
        '<ul><li><strong>bold</strong> item<ul><li><a href="https://a.example" target="_blank" rel="noopener noreferrer">link</a></li></ul></li></ul>');
    });

    it("nesting is capped: an item deeper than six levels stays at the sixth, and every list is closed", () => {
      const deep = Array.from({ length: 12 }, (_, i) => `${" ".repeat(i * 2)}- l${i}`).join("\n");
      const html = md(deep);
      expect((html.match(/<ul>/g) ?? []).length).toBe(6);
      expect((html.match(/<ul>/g) ?? []).length).toBe((html.match(/<\/ul>/g) ?? []).length);
      expect((html.match(/<li>/g) ?? []).length).toBe((html.match(/<\/li>/g) ?? []).length);
    });

    it("tables: header, alignment as fixed classes, cells through the inline Markdown, ragged rows evened out", () => {
      // As on GitHub, a pipe inside `code` still splits the row unless it is escaped (\\|).
      expect(md("| Name | Qty | Note |\n|:-----|----:|:----:|\n| **a** | 2 | `x\\|y` |\n| b |")).toBe(
        '<div class="tbl"><table><thead><tr><th class="al-l">Name</th><th class="al-r">Qty</th><th class="al-c">Note</th></tr></thead><tbody>' +
        '<tr><td class="al-l"><strong>a</strong></td><td class="al-r">2</td><td class="al-c"><code>x|y</code></td></tr>' +
        '<tr><td class="al-l">b</td><td class="al-r"></td><td class="al-c"></td></tr></tbody></table></div>');
      expect(md("a | b\n--|--\n1 | 2")).toBe('<div class="tbl"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>');
      expect(md("| a \\| b |\n|---|\n| c |")).toBe('<div class="tbl"><table><thead><tr><th>a | b</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table></div>');
    });

    it("not a table: no separator, a separator with another column count, or more than 20 columns — those stay text", () => {
      expect(md("a | b\nc | d")).toBe("<p>a | b<br>c | d</p>");
      expect(md("| a | b |\n|---|")).toBe("<p>| a | b |<br>|---|</p>");
      const wide = Array.from({ length: 21 }, (_, i) => `c${i}`).join(" | ");
      expect(md(`${wide}\n${Array.from({ length: 21 }, () => "-").join("|")}`)).not.toContain("<table>");
      // A table ends at the first line without a pipe.
      expect(md("before\n| a |\n|---|\n| 1 |\nafter")).toBe('<p>before</p><div class="tbl"><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table></div><p>after</p>');
    });

    it("a crafted separator row or unclosed strings render in bounded time (<1 s), up to the 16,000-character message cap (#1287 review)", () => {
      const inputs = [
        "h|h\n" + " ".repeat(1600) + "-" + " ".repeat(1600) + "x",             // the reviewed repro: seconds before
        "h|h\n" + " ".repeat(7990) + "-" + " ".repeat(7990) + "x",             // near the cap: never finished before
        "h|h\n" + "| - ".repeat(3990) + "x",
        "```js\n" + '"a '.repeat(5300) + "\n```",                               // thousands of unclosed quotes
        "```js\n/*" + " /*".repeat(5300) + "\n```",                              // thousands of unclosed comments
        "```py\n'''" + "a\n".repeat(7990) + "```",
        "```js\n`" + "a\n".repeat(7990) + "```",
      ];
      for (const input of inputs) {
        expect(input.length).toBeLessThanOrEqual(16_000);
        const t0 = performance.now();
        md(input);
        // A generous bound (a loaded CI runner must not flake it) that still catches the ~3.4 s regression.
        expect(performance.now() - t0, input.slice(0, 24)).toBeLessThan(1_000);
      }
      // …and the bad separator is still not a table.
      expect(md(inputs[0]!)).not.toContain("<table>");
    });

    it("the tokenizer consumes an unclosed string or comment once — a scanner invariant, not a timing (#1287 review)", () => {
      // The quadratic case was an unclosed construct that failed to match and was re-scanned from every later
      // opener. Linear means each one is consumed by ONE match: one span for the rest of the code (a block comment,
      // a template literal, a triple-quoted string), or one per line (a line-bounded quote). The old tokenizer made
      // none of these spans at all, so this is deterministic, with no clock involved.
      const spans = (html: string, cls: string) => (html.match(new RegExp(`<span class="${cls}">`, "g")) ?? []).length;
      expect(spans(md("```js\n" + "/*\n".repeat(1000) + "```"), "tk-c"), "unclosed /* … to the end: one comment").toBe(1);
      expect(spans(md("```js\n`" + "a\n".repeat(1000) + "```"), "tk-s"), "unclosed template literal: one string").toBe(1);
      expect(spans(md("```py\n'''" + "a\n".repeat(1000) + "```"), "tk-s"), "unclosed triple quote: one string").toBe(1);
      expect(spans(md("```js\n" + '"a\n'.repeat(1000) + "```"), "tk-s"), "unclosed \" stops at its line: one per line").toBe(1000);
    });

    it("separator rows: only dashes with optional colons per cell; anything else is not a table", () => {
      for (const sep of ["| -- | x |", "|--|-- -|", "| : |---|", "|---|:-:x|", "--- ---"]) {
        expect(md(`| a | b |\n${sep}`), sep).not.toContain("<table>");
      }
      expect(md("| a | b |\n|  :---  |  ---:  |")).toContain('<th class="al-l">a</th><th class="al-r">b</th>');
    });

    it("code highlighting: keywords, strings, numbers and comments in fixed classes; everything escaped", () => {
      expect(md('```js\nconst s = "<b>"; // 1 < 2\nreturn 42\n```')).toBe(
        '<pre data-lang="js"><code><span class="tk-k">const</span> s = <span class="tk-s">&quot;&lt;b&gt;&quot;</span>; <span class="tk-c">// 1 &lt; 2</span>\n<span class="tk-k">return</span> <span class="tk-n">42</span></code></pre>');
      expect(md("```python\ndef f(): # x\n    return 'y'\n```")).toBe(
        '<pre data-lang="python"><code><span class="tk-k">def</span> f(): <span class="tk-c"># x</span>\n    <span class="tk-k">return</span> <span class="tk-s">&#39;y&#39;</span></code></pre>');
      expect(md('```json\n{"a": true, "n": -1.5}\n```')).toBe(
        '<pre data-lang="json"><code>{<span class="tk-s">&quot;a&quot;</span>: <span class="tk-k">true</span>, <span class="tk-s">&quot;n&quot;</span>: <span class="tk-n">-1.5</span>}</code></pre>');
      expect(md("```bash\necho \"$HOME\" # x\n```")).toContain('<span class="tk-k">echo</span>');
      // Markup between two tokens, and after the last one, is escaped too.
      expect(md("```js\nx <img src=y onerror=z> w <\n```")).toBe('<pre data-lang="js"><code>x &lt;img src=y onerror=z&gt; w &lt;</code></pre>');
    });

    it("an unknown, hostile or prototype-named language is not highlighted — escaped text as before", () => {
      for (const lang of ["", "brainfuck", "constructor", "__proto__", "toString"]) {
        expect(md("```" + lang + "\nconst <b>\n```")).toContain("<code>const &lt;b&gt;</code>");
      }
      // A string that never closes cannot swallow the rest of the block into one span.
      expect(md('```js\nconst a = "open\nlet b = 2\n```')).toContain('<span class="tk-k">let</span>');
    });

    it("empty and missing text render as nothing", () => {
      expect([md(""), md(null), md(undefined)]).toEqual(["", "", ""]);
    });
  });

  describe("mergeMessages", () => {
    const m = (id: number) => ({ id, instance: "w", sender: "s", text: `t${id}`, ts: "" });

    it("one entry per id, in id order — history and the stream can both bring the same message", () => {
      expect(mergeMessages([m(3), m(1)], [m(2), m(3), m(1)]).map(x => x.id)).toEqual([1, 2, 3]);
    });

    it("ids restart with every fleet process: the same id from another boot is another message, and both stay", () => {
      const before = { boot: "aaa", id: 1, instance: "w", sender: "s", text: "before restart", ts: "2026-10-05T01:00:00Z" };
      const after = { boot: "bbb", id: 1, instance: "w", sender: "s", text: "after restart", ts: "2026-10-05T02:00:00Z" };
      const merged = mergeMessages([before], [after]) as unknown as Array<{ text: string }>;
      expect(merged.map(m => m.text)).toEqual(["before restart", "after restart"]);
      // ...and the same message twice (history + stream) is still one entry.
      expect(mergeMessages(merged, [after, before])).toHaveLength(2);
    });

    it("orders by id within a boot and by time across boots", () => {
      const msgs = [
        { boot: "b", id: 2, ts: "2026-10-05T02:00:02Z" }, { boot: "a", id: 9, ts: "2026-10-05T01:00:09Z" },
        { boot: "b", id: 1, ts: "2026-10-05T02:00:01Z" }, { boot: "a", id: 3, ts: "2026-10-05T01:00:03Z" },
      ];
      expect(mergeMessages([], msgs).map(m => `${(m as unknown as { boot: string }).boot}${m.id}`)).toEqual(["a3", "a9", "b1", "b2"]);
    });

    it("keeps the newest `cap`", () => {
      expect(mergeMessages([], [m(1), m(2), m(3), m(4)], 2).map(x => x.id)).toEqual([3, 4]);
    });

    it("ignores anything without a numeric id, and an undefined list", () => {
      expect(mergeMessages(undefined, [m(1), { id: "2" }, null, {}]).map(x => x.id)).toEqual([1]);
    });
  });

  describe("a failed send", () => {
    it.each([
      ["w", "w", true, "", "restore"],           // its own composer, on screen, empty
      ["w", "w", true, "new draft", "keep"],     // never over what is being typed
      ["w", "x", true, "", "keep"],              // never into another chat's composer
      ["w", null, false, "", "keep"],            // the chat view is gone
      ["w", "w", false, "", "keep"],             // re-rendered: the composer it came from is not there
    ])("target %s, on screen %s, composer present %s, value %j → %s", (target, current, present, value, expected) => {
      expect(settleFailedSend(target as string, current as string | null, present as boolean, value as string)).toBe(expected);
    });

    it("put back goes in front of a draft and never replaces it", () => {
      expect(putBack("lost", "")).toBe("lost");
      expect(putBack("lost", "typing")).toBe("lost\ntyping");
    });
  });

  describe("composerKey", () => {
    it.each([
      [{ key: "Enter" }, "send"],
      [{ key: "Enter", shiftKey: true }, "newline"], [{ key: "Enter", altKey: true }, "newline"],
      [{ key: "Enter", ctrlKey: true }, "newline"], [{ key: "Enter", metaKey: true }, "newline"],
      [{ key: "Enter", isComposing: true }, "none"], [{ key: "Enter", keyCode: 229 }, "none"],
      [{ key: "a" }, "none"], [null, "none"],
    ])("%j → %s", (ev, expected) => { expect(composerKey(ev)).toBe(expected); });
  });
});

// ── WebChatHistory ──────────────────────────────────────────────────────────────────────────────────────────────

const msg = (instance: string, text = "hi") => ({ instance, sender: "u", text, ts: "2026-10-05T00:00:00Z" });

describe("WebChatHistory", () => {
  it("gives every message a new id, across instances, starting at 1", () => {
    const h = new WebChatHistory();
    expect([h.record(msg("a")).id, h.record(msg("b")).id, h.record(msg("a")).id]).toEqual([1, 2, 3]);
    expect(h.lastId).toBe(3);
  });

  it("lists one instance's most recent messages, oldest first", () => {
    const h = new WebChatHistory();
    for (const t of ["1", "2", "3"]) h.record(msg("a", t));
    h.record(msg("b", "x"));
    expect(h.list("a").map(x => x.text)).toEqual(["1", "2", "3"]);
    expect(h.list("a", 2).map(x => x.text)).toEqual(["2", "3"]);
    expect(h.list("nobody")).toEqual([]);
    expect(h.list("a", 0)).toEqual([]);
  });

  it("is bounded by count and by size per instance — the newest stay", () => {
    const h = new WebChatHistory({ perInstance: 3, perInstanceChars: 10 });
    for (const t of ["a", "b", "c", "d"]) h.record(msg("x", t));
    expect(h.list("x").map(m => m.text)).toEqual(["b", "c", "d"]);
    expect(h.after(0).filter(m => m.instance === "x").map(m => m.text), "the oldest is really gone, not just hidden by list()").toEqual(["b", "c", "d"]);
    h.record(msg("y", "12345")); h.record(msg("y", "67890")); h.record(msg("y", "!"));
    expect(h.list("y").map(m => m.text)).toEqual(["67890", "!"]);
    const big = new WebChatHistory({ perInstanceChars: 3 });
    big.record(msg("z", "0123456789"));
    expect(big.list("z").map(m => m.text), "one oversized message is still kept").toEqual(["0123456789"]);
  });

  it("cuts a text at WEB_CHAT_TEXT_MAX (the web used to cut at 2000; Telegram sends it all)", () => {
    expect(WEB_CHAT_TEXT_MAX).toBe(16_000);
    const h = new WebChatHistory();
    expect(h.record(msg("a", "x".repeat(20_000))).text).toHaveLength(16_000);
    expect(h.record(msg("a", "y".repeat(5000))).text).toHaveLength(5000);
  });

  it("after(): what a reconnecting stream missed, across instances, in order, at most replayMax", () => {
    const h = new WebChatHistory({ replayMax: 2 });
    for (const i of ["a", "b", "a", "b"]) h.record(msg(i));
    expect(h.after(1).map(m => m.id)).toEqual([3, 4]);       // replayMax keeps the newest
    const all = new WebChatHistory();
    for (const i of ["a", "b", "a"]) all.record(msg(i));
    expect(all.after(1).map(m => m.id)).toEqual([2, 3]);
    expect(all.after(0).map(m => m.id)).toEqual([1, 2, 3]);
    expect(all.after(3)).toEqual([]);
  });

  it("after(): bad ids get nothing", () => {
    const h = new WebChatHistory();
    h.record(msg("a"));
    expect(h.after(1)).toEqual([]);
    expect(h.after(-1)).toEqual([]);
    expect(h.after(Number.NaN)).toEqual([]);
  });

  it("every message carries its boot; the cursor is <boot>-<id>", () => {
    const h = new WebChatHistory({ boot: "abc123" });
    const m = h.record(msg("a"));
    expect(m.boot).toBe("abc123");
    expect(h.cursorOf(m)).toBe("abc123-1");
    expect(new WebChatHistory().boot).toMatch(/^[0-9a-f]{12}$/);
    expect(new WebChatHistory().boot).not.toBe(new WebChatHistory().boot);
  });

  it("replayFor(): the same boot replays after its id; another boot (a restart) gets this boot's whole backlog", () => {
    const h = new WebChatHistory({ boot: "new" });
    for (const t of ["x", "y", "z"]) h.record(msg("w", t));
    expect(h.replayFor({ boot: "new", id: 1 }).map(m => m.text)).toEqual(["y", "z"]);
    expect(h.replayFor({ boot: "new", id: 3 })).toEqual([]);
    // The old process had handed out id 50; the new one only 3. Nothing of the new one was seen.
    expect(h.replayFor({ boot: "old", id: 50 }).map(m => m.text)).toEqual(["x", "y", "z"]);
    expect(h.replayFor({ boot: "old", id: 1 }).map(m => m.text)).toEqual(["x", "y", "z"]);
    expect(h.replayFor(null)).toEqual([]);
  });

  it("forget() drops an instance", () => {
    const h = new WebChatHistory();
    h.record(msg("a"));
    h.forget("a");
    expect(h.list("a")).toEqual([]);
  });
});

describe("parseLastEventId", () => {
  it.each([
    ["ab12-7", { boot: "ab12", id: 7 }], [" ab12-12 ", { boot: "ab12", id: 12 }], ["f-0", { boot: "f", id: 0 }], [["ab-5"], { boot: "ab", id: 5 }],
    [undefined, null], ["", null], ["7", null], ["ab-", null], ["-1", null], ["AB-1", null], ["ab-1.5", null], ["ab--1", null],
    ["ab-1e3", null], [`ab-${"9".repeat(16)}`, null], [`${"a".repeat(33)}-1`, null], ["a b-1", null],
  ])("%j → %j", (input, expected) => { expect(parseLastEventId(input as string)).toEqual(expected); });
});

// ── the routes ──────────────────────────────────────────────────────────────────────────────────────────────────

const TOKEN = "c".repeat(48);
function fakeRes() {
  const res = Object.assign(new EventEmitter(), {
    status: 0, body: "", writes: [] as string[], headers: {} as Record<string, unknown>,
    writeHead(status: number, headers?: Record<string, unknown>) { res.status = status; Object.assign(res.headers, headers ?? {}); return res; },
    setHeader(k: string, v: unknown) { res.headers[k] = v; },
    write(chunk: string) { res.writes.push(String(chunk)); return true; },
    end(chunk?: unknown) { if (chunk) res.body += String(chunk); return res; },
  });
  return res;
}
function fakeReq(url: string, headers: Record<string, string> = {}) {
  return Object.assign(new EventEmitter(), { method: "GET", url, headers: { "x-agend-token": TOKEN, ...headers } });
}
function ctxWith(history?: WebChatHistory): WebApiContext {
  return {
    webToken: TOKEN, dataDir: "/tmp", sseClients: new Set(), fleetConfig: { instances: {} },
    getUiStatus: () => ({ ok: true }), emitSseEvent: () => {}, logger: { info() {}, debug() {}, error() {} },
    ...(history ? { webChatHistory: history } : {}),
  } as unknown as WebApiContext;
}
function call(url: string, ctx: WebApiContext, headers?: Record<string, string>) {
  const req = fakeReq(url, headers);
  const res = fakeRes();
  expect(handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL(url, "http://localhost"), ctx)).toBe(true);
  return { req, res };
}

describe("GET /ui/history", () => {
  it("returns an instance's recent messages and the newest id", () => {
    const h = new WebChatHistory({ boot: "b1" });
    h.record(msg("w", "one")); h.record(msg("other", "x")); h.record(msg("w", "two"));
    const { res } = call("/ui/history?instance=w", ctxWith(h));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual(["one", "two"]);
    expect(body.messages.map((m: { id: number; boot: string }) => `${m.boot}-${m.id}`)).toEqual(["b1-1", "b1-3"]);
    expect(body.boot).toBe("b1");
    expect(body.lastId).toBe(3);
  });

  it("limit picks the newest", () => {
    const h = new WebChatHistory();
    for (const t of ["1", "2", "3"]) h.record(msg("w", t));
    expect(JSON.parse(call("/ui/history?instance=w&limit=2", ctxWith(h)).res.body).messages.map((m: { text: string }) => m.text)).toEqual(["2", "3"]);
  });

  it.each(["/ui/history", "/ui/history?instance=", `/ui/history?instance=${"x".repeat(129)}`, "/ui/history?instance=w&limit=0",
    "/ui/history?instance=w&limit=501", "/ui/history?instance=w&limit=2.5", "/ui/history?instance=w&limit=abc"])("%s → 400", url => {
    expect(call(url, ctxWith(new WebChatHistory())).res.status).toBe(400);
  });

  it("needs the same credentials as every other /ui route", () => {
    const req = fakeReq("/ui/history?instance=w", { "x-agend-token": "wrong".padEnd(48, "x") });
    const res = fakeRes();
    handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL("http://localhost/ui/history?instance=w"), ctxWith(new WebChatHistory()));
    expect(res.status).toBe(401);
    expect(res.body).not.toContain("messages");
  });

  it("a context without a chat answers with an empty list, not an error", () => {
    expect(JSON.parse(call("/ui/history?instance=w", ctxWith()).res.body)).toEqual({ messages: [], boot: null, lastId: 0 });
  });
});

describe("GET /ui/events with Last-Event-ID", () => {
  const replayed = (writes: string[]) => writes.filter(w => w.includes("event: message"));

  it("a reconnecting stream is first sent what it missed, each frame with its cursor", () => {
    const h = new WebChatHistory({ boot: "b1" });
    for (const t of ["a", "b", "c"]) h.record(msg("w", t));
    const { req, res } = call("/ui/events", ctxWith(h), { "last-event-id": "b1-1" });
    const frames = replayed(res.writes);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatch(/^id: b1-2\nevent: message\ndata: /);
    expect(JSON.parse(frames[1]!.split("data: ")[1]!).text).toBe("c");
    expect(res.writes[0]).toMatch(/^event: status/);                 // status first, then the replay
    req.emit("close");
  });

  it("no Last-Event-ID (a fresh page) sends no replay — the page asks /ui/history", () => {
    const h = new WebChatHistory();
    h.record(msg("w"));
    const { req, res } = call("/ui/events", ctxWith(h));
    expect(replayed(res.writes)).toEqual([]);
    req.emit("close");
  });

  it("a Last-Event-ID from before a restart gets everything this boot has said (none of it was seen)", () => {
    const h = new WebChatHistory({ boot: "b2" });
    for (const t of ["a", "b"]) h.record(msg("w", t));
    const { req, res } = call("/ui/events", ctxWith(h), { "last-event-id": "b1-99" });
    expect(replayed(res.writes).map(f => JSON.parse(f.split("data: ")[1]!).text)).toEqual(["a", "b"]);
    req.emit("close");
  });

  it.each(["abc", "-1", "99", "b1-"])("a Last-Event-ID of %j replays nothing", id => {
    const h = new WebChatHistory({ boot: "b1" });
    h.record(msg("w"));
    const { req, res } = call("/ui/events", ctxWith(h), { "last-event-id": id });
    expect(replayed(res.writes)).toEqual([]);
    req.emit("close");
  });
});

describe("SSE frames", () => {
  it("sseFrame puts the id first, and omits it when there is none", () => {
    expect(sseFrame("message", { a: 1 }, "b1-7")).toBe('id: b1-7\nevent: message\ndata: {"a":1}\n\n');
    expect(sseFrame("status", { a: 1 })).toBe('event: status\ndata: {"a":1}\n\n');
  });

  it("broadcastSseEvent writes the id when given", () => {
    const res = fakeRes();
    broadcastSseEvent(new Set([res as unknown as ServerResponse]), "message", { x: 1 }, undefined, "b1-3");
    expect(res.writes).toEqual(['id: b1-3\nevent: message\ndata: {"x":1}\n\n']);
  });
});

// ── FleetManager: every chat message goes through the history ──────────────────────────────────────────────────

describe("FleetManager.emitSseEvent", () => {
  it("records a chat message and broadcasts it with its id; other events are untouched", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "c1-"));
    try {
      const fm = new FleetManager(dir);
      const res = fakeRes();
      (fm as unknown as { sseClients: Set<unknown> }).sseClients.add(res);
      fm.emitSseEvent("message", { instance: "w", sender: "agent", text: "x".repeat(17_000), ts: "t" });
      fm.emitSseEvent("status", { ok: 1 });
      expect(res.writes[0]).toBe(`${res.writes[0]!.split("\n")[0]}\n${res.writes[0]!.split("\n").slice(1).join("\n")}`);
      expect(res.writes[0]).toMatch(new RegExp(`^id: ${fm.webChatHistory.boot}-1\nevent: message\n`));
      expect(JSON.parse(res.writes[0]!.split("data: ")[1]!).text).toHaveLength(16_000);
      expect(res.writes[1]).toBe('event: status\ndata: {"ok":1}\n\n');
      expect(fm.webChatHistory.list("w").map(m => m.id)).toEqual([1]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("deleting an instance forgets its chat — only once the removal succeeded", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { authorizeExplicitInstanceRemoval } = await import("../src/instance-removal.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "c1-rm-"));
    try {
      const fm = new FleetManager(dir);
      const any = fm as unknown as Record<string, any>;
      fm.webChatHistory.record({ instance: "w", sender: "u", text: "secret plan", ts: "t" });
      fm.webChatHistory.record({ instance: "keep", sender: "u", text: "other", ts: "t" });
      any.lifecycle = { remove: async () => { throw new Error("lifecycle refused"); } };
      await expect(fm.removeInstance("w", authorizeExplicitInstanceRemoval("dashboard-confirmed"))).rejects.toThrow("lifecycle refused");
      expect(fm.webChatHistory.list("w").map(m => m.text), "a failed removal keeps the history").toEqual(["secret plan"]);
      any.lifecycle = { remove: async () => {} };
      any.statuslineWatcher = { unwatch() {} };
      await fm.removeInstance("w", authorizeExplicitInstanceRemoval("dashboard-confirmed"));
      expect(fm.webChatHistory.list("w")).toEqual([]);
      expect(fm.webChatHistory.after(0).map(m => m.instance), "and is not replayed either").toEqual(["keep"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the places the fleet pushes chat text no longer cut it at 2000 characters", () => {
    const src = readFileSync(join(process.cwd(), "src", "fleet-manager.ts"), "utf8");
    expect(src).not.toMatch(/\.slice\(0, 2000\)/);
    // Inbound General, inbound instance, a routed reply — and a web-only fleet's daemon status line (C4).
    expect(src.match(/slice\(0, WEB_CHAT_TEXT_MAX\)/g)).toHaveLength(4);
  });
});

// ── the page ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("dashboard.html", () => {
  const html = readFileSync(join(process.cwd(), "src", "ui", "dashboard.html"), "utf8");

  it("loads the renderer before its own script, and renders message text only through it", () => {
    expect(html.indexOf('<script src="/ui/js/chat-render.js"></script>')).toBeGreaterThan(-1);
    expect(html.indexOf('<script src="/ui/js/chat-render.js"></script>')).toBeLessThan(html.indexOf("<script>\n"));
    expect(html).toContain("AgendChatRender.renderMarkdown(x.text)");
    expect(html).not.toContain("${esc(x.text)}");
    expect(html).not.toMatch(/innerHTML\s*=\s*[^;]*x\.text(?!\))/);
  });

  it("has a multi-line composer, and asks /ui/history when a chat is opened", () => {
    expect(html).toMatch(/<textarea id="msgIn"/);
    expect(html).not.toMatch(/<input id="msgIn"/);
    expect(html).toContain("AgendChatRender.composerKey(e)");
    expect(html).toMatch(/function sel\(name\)[^\n]*loadHistory\(name\)/);
    expect(html).toContain("AgendChatRender.mergeMessages(");
  });

  it("a failed send goes through settleFailedSend for the chat it was sent from, and kept text is offered back", () => {
    expect(html).toContain("const target = cur;");
    expect(html).toContain('AgendChatRender.settleFailedSend(target, cur, !!now, now ? now.value : "")');
    expect(html).toContain("failedSends[target] = failedSends[target] ?");
    expect(html).toContain("AgendChatRender.putBack(kept, inp.value)");
    expect(html).toMatch(/inp\.value = drafts\[cur\] \|\| "";/);
  });
});

// ── the page's own script, run against a fake DOM: failed sends ───────────────────────────────────────────────

describe("dashboard sendMsg (the real page script)", () => {
  const PAGE = readFileSync(join(process.cwd(), "src", "ui", "dashboard.html"), "utf8").match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  function page() {
    const composer = () => ({ value: "", style: {} as Record<string, string>, scrollHeight: 20, focus() {} });
    const nodes: Record<string, any> = { msgIn: composer(), messages: { innerHTML: "", scrollHeight: 0 }, uptime: { textContent: "" }, failedSend: { className: "", textContent: "", append() {} } };
    const toasts: string[] = [];
    const sse: Record<string, (e: { data: string; lastEventId?: string }) => void> = {};
    const timers: Array<() => void> = [];
    const fetched: string[] = [];
    let pollReply: (url: string) => unknown = () => ({});
    const c = vm.createContext({
      localStorage: { getItem: () => null }, navigator: { language: "en" },
      document: { getElementById: (n: string) => nodes[n] ?? null, createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {} } },
      setTimeout: (f: () => void) => { timers.push(f); return timers.length; }, clearTimeout() {},
      setInterval: (f: () => void) => { timers.push(f); return timers.length; }, clearInterval() {},
      fetch: async (url: string) => { fetched.push(url); const body = pollReply(url); return { ok: true, json: async () => body }; },
      EventSource: class { addEventListener(k: string, f: (e: { data: string; lastEventId?: string }) => void) { sse[k] = f; } },
    });
    vm.runInContext(SRC, c);
    vm.runInContext(PAGE, c);
    (c as any).captureToast = (m: string) => toasts.push(m);
    vm.runInContext('toast=(m)=>captureToast(m);renderMsgs=()=>{};renderList=()=>{};cur="w";', c);
    let release!: (v: unknown) => void;
    (c as any).pending = new Promise(r => { release = r; });
    vm.runInContext("api=()=>pending", c);
    return { c, nodes, toasts, composer, release, sse, timers, fetched, setPollReply: (f: (url: string) => unknown) => { pollReply = f; }, read: (s: string) => vm.runInContext(s, c) };
  }

  it("the plain failure: the text goes back into the same composer", async () => {
    const p = page();
    p.nodes.msgIn.value = "hello";
    const send = p.read("sendMsg()");
    expect(p.nodes.msgIn.value).toBe("");
    p.release({ error: "offline" });
    await send;
    expect(p.nodes.msgIn.value).toBe("hello");
    expect(p.read("failedSends.w")).toBeUndefined();
    expect(p.toasts).toEqual(["offline"]);
  });

  it("a new draft typed meanwhile is kept; the failed text is kept beside it for that chat, not lost", async () => {
    const p = page();
    p.nodes.msgIn.value = "failed first";
    const send = p.read("sendMsg()");
    p.nodes.msgIn.value = "new draft";
    p.release({ error: "offline" });
    await send;
    expect(p.nodes.msgIn.value).toBe("new draft");
    expect(p.read("failedSends.w")).toBe("failed first");
    expect(p.read("AgendChatRender.putBack(failedSends.w, 'new draft')")).toBe("failed first\nnew draft");
  });

  it("the chat was re-rendered meanwhile: the text goes into the composer that is on screen now, not the detached one", async () => {
    const p = page();
    p.nodes.msgIn.value = "failed first";
    const send = p.read("sendMsg()");
    const old = p.nodes.msgIn;
    p.nodes.msgIn = p.composer();
    p.release({ error: "offline" });
    await send;
    expect(p.nodes.msgIn.value).toBe("failed first");
    expect(old.value).toBe("");
  });

  it("another chat was opened meanwhile: the text is not put into ITS composer, it is kept for the chat it was sent to", async () => {
    const p = page();
    p.nodes.msgIn.value = "for w";
    const send = p.read("sendMsg()");
    p.read('cur="x"');
    p.nodes.msgIn = p.composer();
    p.release({ error: "offline" });
    await send;
    expect(p.nodes.msgIn.value).toBe("");
    expect(p.read("failedSends.w")).toBe("for w");
    expect(p.read("failedSends.x")).toBeUndefined();
  });

  it("a successful send keeps nothing and says nothing", async () => {
    const p = page();
    p.nodes.msgIn.value = "ok";
    const send = p.read("sendMsg()");
    p.release({ sent: true });
    await send;
    expect(p.nodes.msgIn.value).toBe("");
    expect(p.read("failedSends.w")).toBeUndefined();
    expect(p.toasts).toEqual([]);
  });

  it("the page's SSE message handler keeps a new boot's message that reuses an old id, and still dedupes a repeat", () => {
    const p = page();
    const before = new WebChatHistory({ boot: "aaa" }).record({ instance: "w", sender: "s", text: "before restart", ts: "2026-10-05T01:00:00Z" });
    const after = new WebChatHistory({ boot: "bbb" }).record({ instance: "w", sender: "s", text: "after restart", ts: "2026-10-05T02:00:00Z" });
    expect(before.id).toBe(after.id);
    p.sse.message!({ data: JSON.stringify(before) });
    p.sse.message!({ data: JSON.stringify(after) });
    p.sse.message!({ data: JSON.stringify(after) });
    expect(p.read("msgs.w.map(m => m.text)")).toEqual(["before restart", "after restart"]);
  });

  it("first fallback with ZERO stream messages: a message that arrived while the stream was silent is not skipped (#1251 review)", async () => {
    // The real page script, and the real /ui/history and /ui/poll handlers over one real history. The stream only
    // ever sent a status frame — no message event, so the page has no cursor of its own.
    const p = page();
    const h = new WebChatHistory({ boot: "b1" });
    const ctx = { ...ctxWith(h), getUiStatus: () => ({ instances: [], uptime: 1 }) } as unknown as WebApiContext;
    const viaHandler = (url: string) => JSON.parse(call(url, ctx).res.body);
    h.record(msg("w", "one"));
    p.sse.status!({ data: JSON.stringify({ instances: [], uptime: 1 }) });
    // The chat is opened: its history is loaded (through the real handler) — "one".
    (p.c as any).historyVia = viaHandler;
    p.read("api = async (_m, path) => historyVia(path)");
    await p.read('loadHistory("w")');
    expect(p.read("msgs.w.map(m => m.text)")).toEqual(["one"]);
    expect(p.read("lastCursor")).toBe("");
    // The stream goes quiet; meanwhile "two" is said. Then the first poll.
    h.record(msg("w", "two"));
    p.setPollReply(viaHandler);
    await p.read("pollOnce()");
    expect(p.fetched.at(-1)).toBe("/ui/poll?after=");
    expect(p.read("msgs.w.map(m => m.text)"), "two is shown, one is not doubled").toEqual(["one", "two"]);
    expect(p.read("lastCursor")).toBe("b1-2");
    // From the cursor on, polling goes on as usual.
    h.record(msg("w", "three"));
    await p.read("pollOnce()");
    expect(p.fetched.at(-1)).toBe("/ui/poll?after=b1-2");
    expect(p.read("msgs.w.map(m => m.text)")).toEqual(["one", "two", "three"]);
    expect(p.sse.message, "no stream message was ever delivered").toBeDefined();
  });

  it("dashboard polling: uses the stream's cursor, and a message seen on both paths shows once", async () => {
    const p = page();
    const h = new WebChatHistory({ boot: "b1" });
    const one = h.record({ instance: "w", sender: "agent", text: "one", ts: "t1" });
    const two = h.record({ instance: "w", sender: "agent", text: "two", ts: "t2" });
    // The stream delivers "one" with its cursor, then goes quiet.
    p.sse.message!({ data: JSON.stringify(one), lastEventId: h.cursorOf(one) });
    expect(p.read("lastCursor")).toBe("b1-1");
    // The poll asks from exactly there, and gets "one" again (a replay) plus "two".
    p.setPollReply(() => ({ status: { instances: [], uptime: 1 }, messages: [one, two], cursor: "b1-2" }));
    p.read("pollOnce()");
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(p.fetched.at(-1)).toBe("/ui/poll?after=b1-1");
    expect(p.read("msgs.w.map(m => m.text)")).toEqual(["one", "two"]);
    expect(p.read("lastCursor")).toBe("b1-2");
    // The stream comes back with "two" (already shown by the poll): still once.
    p.sse.message!({ data: JSON.stringify(two), lastEventId: h.cursorOf(two) });
    expect(p.read("msgs.w.map(m => m.text)")).toEqual(["one", "two"]);
  });
});
