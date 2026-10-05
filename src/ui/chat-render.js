/*
 * Markdown for the web chat, safe by construction: the text is HTML-escaped FIRST, and only then are a few
 * Markdown forms turned into a fixed set of tags. Nothing in a message can produce a tag, an attribute or an
 * event handler of its own; the only attribute that carries message text is a link's href, and only an
 * http(s)/mailto URL gets one (rendered with target=_blank rel="noopener noreferrer").
 *
 * A classic script for the dashboard (window.AgendChatRender) that also exports itself for the tests.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.AgendChatRender = api;
})(this, function () {
  "use strict";

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** An escaped URL is linkable only with an explicit http(s)/mailto scheme; anything else stays text. */
  function safeHref(escapedUrl) {
    var u = escapedUrl.trim();
    if (!/^(https?:\/\/|mailto:)[^\s]+$/i.test(u)) return null;
    // A quote or an angle bracket is never part of a URL we link: such text stays text (it could only be an attempt).
    if (/&(?:quot|#39|lt|gt);/.test(u)) return null;
    // A placeholder in a URL would be expanded into markup inside the attribute: never trust one there.
    if (u.indexOf("\u0000") !== -1) return null;
    return u;
  }

  function link(href, label) {
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
  }

  // Placeholders survive the later passes untouched (they contain no Markdown characters).
  function stash(store, html) { store.push(html); return "\u0000" + (store.length - 1) + "\u0000"; }
  function unstash(store, s) {
    // A stashed fragment can hold another placeholder (a `code` span inside a link label): expand until
    // none is left. Every fragment is the renderer's own output, so this cannot introduce message markup;
    // bounded so a malformed store cannot loop.
    for (var pass = 0; pass < 4 && s.indexOf("\u0000") !== -1; pass++) {
      s = s.replace(/\u0000(\d+)\u0000/g, function (_m, i) { var f = store[Number(i)]; return f === undefined ? "" : f; });
    }
    return s;
  }

  /** Inline Markdown over ALREADY-ESCAPED text. */
  function inline(escaped, store) {
    var s = escaped;
    // `code` first: nothing inside it is Markdown.
    s = s.replace(/`([^`\n]+)`/g, function (_m, code) { return stash(store, "<code>" + code + "</code>"); });
    // [label](url)
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
      var href = safeHref(url);
      return href ? stash(store, link(href, emphasis(label))) : m;
    });
    // bare URLs
    s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+[^\s<.,;:!?)\]'"&])/g, function (m, pre, url) {
      var href = safeHref(url);
      return href ? pre + stash(store, link(href, url)) : m;
    });
    return emphasis(s);
  }

  /** Bold, strike-through and italics, over escaped text (a link's label gets them too). */
  function emphasis(s) {
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?![_\w])/g, "$1<em>$2</em>");
    return s;
  }

  /** Block Markdown (headings, lists, quotes, rules, paragraphs) over one run of non-code text. */
  function blocks(text, store) {
    var lines = escapeHtml(text).split("\n");
    var out = [];
    var para = [];
    var list = null;   // { tag: "ul" | "ol", items: [] }
    var quote = [];
    function flushPara() { if (para.length) { out.push("<p>" + para.map(function (l) { return inline(l, store); }).join("<br>") + "</p>"); para = []; } }
    function flushList() { if (list) { out.push("<" + list.tag + ">" + list.items.map(function (i) { return "<li>" + inline(i, store) + "</li>"; }).join("") + "</" + list.tag + ">"); list = null; } }
    function flushQuote() { if (quote.length) { out.push("<blockquote>" + quote.map(function (l) { return inline(l, store); }).join("<br>") + "</blockquote>"); quote = []; } }
    function flushAll() { flushPara(); flushList(); flushQuote(); }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m;
      if (/^\s*$/.test(line)) { flushAll(); continue; }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flushAll(); var n = Math.min(m[1].length + 2, 6); out.push("<h" + n + ">" + inline(m[2], store) + "</h" + n + ">"); continue; }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); out.push("<hr>"); continue; }
      if ((m = /^&gt;\s?(.*)$/.exec(line))) { flushPara(); flushList(); quote.push(m[1]); continue; }
      if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) { flushPara(); flushQuote(); if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push(m[1]); continue; }
      if ((m = /^\s*\d{1,9}[.)]\s+(.*)$/.exec(line))) { flushPara(); flushQuote(); if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; } list.items.push(m[1]); continue; }
      flushList(); flushQuote();
      para.push(line);
    }
    flushAll();
    return out.join("");
  }

  /** The whole message: fenced code blocks verbatim (escaped), everything else as Markdown. */
  function renderMarkdown(text) {
    var src = String(text == null ? "" : text).replace(/\r\n?/g, "\n").replace(/\u0000/g, "");   // \u0000 is the placeholder mark
    var store = [];
    var html = "";
    var re = /```([A-Za-z0-9_+.-]{0,32})[^\n]*\n([\s\S]*?)(?:```|$)/g;
    var last = 0;
    var m;
    while ((m = re.exec(src)) !== null) {
      html += blocks(src.slice(last, m.index), store);
      var lang = m[1] ? ' data-lang="' + escapeHtml(m[1]) + '"' : "";
      html += "<pre" + lang + "><code>" + escapeHtml(m[2].replace(/\n$/, "")) + "</code></pre>";
      last = re.lastIndex;
      if (m[0].length === 0) break;
    }
    html += blocks(src.slice(last), store);
    return unstash(store, html);
  }

  /**
   * The chat's message list after `incoming` arrives (history, a live SSE message or an SSE replay): one entry per
   * id, in id order, the newest `cap` kept. The same message can arrive twice — from /ui/history and from the
   * stream — and must show once.
   */
  function mergeMessages(existing, incoming, cap) {
    var seen = {};
    var out = [];
    // Ids restart with every fleet process; the boot generation makes them an identity again.
    function key(m) { return String(m.boot || "") + ":" + m.id; }
    function add(m) {
      if (!m || typeof m.id !== "number") return;
      if (seen[key(m)]) return;
      seen[key(m)] = true;
      out.push(m);
    }
    (existing || []).forEach(add);
    (incoming || []).forEach(add);
    // Within one boot the id is the order; across boots (a restart) the time is.
    out.sort(function (a, b) {
      if ((a.boot || "") === (b.boot || "")) return a.id - b.id;
      var ta = String(a.ts || ""), tb = String(b.ts || "");
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    var limit = typeof cap === "number" && cap > 0 ? cap : 500;
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  /** What a key in the composer does: Enter sends, Shift+Enter is a new line, nothing happens mid-IME-composition. */
  function composerKey(ev) {
    if (!ev || ev.key !== "Enter" || ev.isComposing || ev.keyCode === 229) return "none";
    if (ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return "newline";
    return "send";
  }

  /**
   * A send that failed: where does its text go? Back into the composer only if that composer is the same
   * target's, still on screen and empty; otherwise it is kept aside for that target (never put into another
   * target's composer, never over a draft someone is typing) and offered back when that chat is open.
   */
  function settleFailedSend(target, current, composerPresent, composerValue) {
    return target === current && composerPresent && !composerValue ? "restore" : "keep";
  }

  /** "Put back" for a kept message: in front of whatever is being typed now, never replacing it. */
  function putBack(failedText, draft) {
    return draft ? failedText + "\n" + draft : failedText;
  }

  return {
    renderMarkdown: renderMarkdown, escapeHtml: escapeHtml, mergeMessages: mergeMessages, composerKey: composerKey,
    settleFailedSend: settleFailedSend, putBack: putBack,
  };
});
