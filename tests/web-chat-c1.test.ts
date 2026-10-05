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
}
const SRC = readFileSync(join(process.cwd(), "src", "ui", "chat-render.js"), "utf8");
function asScript(): Render { const c = vm.createContext({}); vm.runInContext(SRC, c); return (c as { AgendChatRender: Render }).AgendChatRender; }
function asModule(): Render { const module = { exports: {} as Render }; vm.runInContext(SRC, vm.createContext({ module })); return module.exports; }

describe.each([["a classic script", asScript], ["a CommonJS module", asModule]])("chat-render.js as %s", (_n, load) => {
  const { renderMarkdown: md, mergeMessages, composerKey } = load();

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
      const nasty = ["<svg/onload=alert(1)>", "```\n<script>x</script>\n```", "`<b>`", "**<i>x</i>**", "> <iframe>", "- <style>", "# <h1>", "[<b>](https://a.example)", "\u0000 0 \u0000"].join("\n");
      const tags = [...md(nasty).matchAll(/<\/?([a-z0-9]+)/g)].map(m => m[1]);
      for (const tag of tags) expect(["p", "br", "pre", "code", "a", "strong", "em", "del", "ul", "ol", "li", "blockquote", "h3", "h4", "h5", "h6", "hr"]).toContain(tag);
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

    it("a fenced code block is verbatim and escaped, its language kept as data", () => {
      expect(md("before\n```ts\nconst a = 1 < 2 && **x**;\n```\nafter")).toBe(
        '<p>before</p><pre data-lang="ts"><code>const a = 1 &lt; 2 &amp;&amp; **x**;</code></pre><p>after</p>');
    });

    it("an unclosed fence still renders the rest as code (a reply cut mid-block)", () => {
      expect(md("```\nopen <b>")).toBe("<pre><code>open &lt;b&gt;</code></pre>");
    });

    it("every link opens in a new tab without a reference to this page", () => {
      for (const a of md("[a](https://a.example) https://b.example").match(/<a [^>]*>/g)!) {
        expect(a).toContain('target="_blank"');
        expect(a).toContain('rel="noopener noreferrer"');
      }
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

    it("keeps the newest `cap`", () => {
      expect(mergeMessages([], [m(1), m(2), m(3), m(4)], 2).map(x => x.id)).toEqual([3, 4]);
    });

    it("ignores anything without a numeric id, and an undefined list", () => {
      expect(mergeMessages(undefined, [m(1), { id: "2" }, null, {}]).map(x => x.id)).toEqual([1]);
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

  it("after(): an id the fleet never handed out (from before a restart) gets nothing", () => {
    const h = new WebChatHistory();
    h.record(msg("a"));
    expect(h.after(4)).toEqual([]);
    expect(h.after(1)).toEqual([]);
    expect(h.after(-1)).toEqual([]);
    expect(h.after(Number.NaN)).toEqual([]);
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
    ["7", 7], [" 12 ", 12], ["0", 0], [["5"], 5],
    [undefined, null], ["", null], ["-1", null], ["1.5", null], ["abc", null], ["1e3", null], ["9".repeat(16), null],
  ])("%j → %s", (input, expected) => { expect(parseLastEventId(input as string)).toBe(expected); });
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
    const h = new WebChatHistory();
    h.record(msg("w", "one")); h.record(msg("other", "x")); h.record(msg("w", "two"));
    const { res } = call("/ui/history?instance=w", ctxWith(h));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual(["one", "two"]);
    expect(body.messages.map((m: { id: number }) => m.id)).toEqual([1, 3]);
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
    expect(JSON.parse(call("/ui/history?instance=w", ctxWith()).res.body)).toEqual({ messages: [], lastId: 0 });
  });
});

describe("GET /ui/events with Last-Event-ID", () => {
  const replayed = (writes: string[]) => writes.filter(w => w.includes("event: message"));

  it("a reconnecting stream is first sent what it missed, each frame with its id", () => {
    const h = new WebChatHistory();
    for (const t of ["a", "b", "c"]) h.record(msg("w", t));
    const { req, res } = call("/ui/events", ctxWith(h), { "last-event-id": "1" });
    const frames = replayed(res.writes);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatch(/^id: 2\nevent: message\ndata: /);
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

  it.each(["abc", "-1", "99"])("a Last-Event-ID of %j replays nothing", id => {
    const h = new WebChatHistory();
    h.record(msg("w"));
    const { req, res } = call("/ui/events", ctxWith(h), { "last-event-id": id });
    expect(replayed(res.writes)).toEqual([]);
    req.emit("close");
  });
});

describe("SSE frames", () => {
  it("sseFrame puts the id first, and omits it when there is none", () => {
    expect(sseFrame("message", { a: 1 }, 7)).toBe('id: 7\nevent: message\ndata: {"a":1}\n\n');
    expect(sseFrame("status", { a: 1 })).toBe('event: status\ndata: {"a":1}\n\n');
  });

  it("broadcastSseEvent writes the id when given", () => {
    const res = fakeRes();
    broadcastSseEvent(new Set([res as unknown as ServerResponse]), "message", { x: 1 }, undefined, 3);
    expect(res.writes).toEqual(['id: 3\nevent: message\ndata: {"x":1}\n\n']);
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
      expect(res.writes[0]).toMatch(/^id: 1\nevent: message\n/);
      expect(JSON.parse(res.writes[0]!.split("data: ")[1]!).text).toHaveLength(16_000);
      expect(res.writes[1]).toBe('event: status\ndata: {"ok":1}\n\n');
      expect(fm.webChatHistory.list("w").map(m => m.id)).toEqual([1]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the three places the fleet pushes chat text no longer cut it at 2000 characters", () => {
    const src = readFileSync(join(process.cwd(), "src", "fleet-manager.ts"), "utf8");
    expect(src).not.toMatch(/\.slice\(0, 2000\)/);
    expect(src.match(/slice\(0, WEB_CHAT_TEXT_MAX\)/g)).toHaveLength(3);
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

  it("gives the text back when a send fails", () => {
    expect(html).toMatch(/if \(!r \|\| r\.error\) \{ if \(!inp\.value\) \{ inp\.value = txt;/);
  });
});
