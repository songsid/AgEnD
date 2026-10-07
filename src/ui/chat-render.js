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

  /** How deep a list may nest: deeper items stay at the deepest level (a message cannot build an unbounded tree). */
  var MAX_LIST_DEPTH = 6;
  /** The widest table rendered as a table; a wider one stays text. */
  var MAX_TABLE_COLUMNS = 20;

  /** Leading whitespace as columns: a tab counts four. */
  function indentOf(ws) { var n = 0; for (var i = 0; i < ws.length; i++) n += ws[i] === "\t" ? 4 : 1; return n; }

  /**
   * A run of list items as nested lists. An item indented deeper than the one before opens a list inside that
   * item; a shallower one closes lists back to its level; at the same level a change of kind (- vs 1.) starts a
   * new list. Every tag is the renderer's own; item text goes through inline() like any other text.
   */
  function renderList(items, store) {
    var html = "";
    var stack = [];   // { indent, tag }
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      while (stack.length && it.indent < stack[stack.length - 1].indent) html += "</li></" + stack.pop().tag + ">";
      var top = stack[stack.length - 1];
      if (!top || (it.indent > top.indent && stack.length < MAX_LIST_DEPTH)) {
        html += "<" + it.tag + ">";
        stack.push({ indent: it.indent, tag: it.tag });
      } else if (top.tag !== it.tag) {
        html += "</li></" + top.tag + "><" + it.tag + ">";
        top.tag = it.tag;
      } else {
        html += "</li>";
      }
      html += "<li>" + inline(it.text, store);
    }
    while (stack.length) html += "</li></" + stack.pop().tag + ">";
    return html;
  }

  /** The cells of one table row (escaped text). A leading/trailing pipe is optional; `\|` is a literal pipe. */
  function tableCells(line) {
    var t = line.trim();
    if (t.charAt(0) === "|") t = t.slice(1);
    if (t.charAt(t.length - 1) === "|" && t.charAt(t.length - 2) !== "\\") t = t.slice(0, -1);
    var cells = [];
    var cur = "";
    for (var i = 0; i < t.length; i++) {
      if (t[i] === "\\" && t[i + 1] === "|") { cur += "|"; i++; continue; }
      if (t[i] === "|") { cells.push(cur.trim()); cur = ""; continue; }
      cur += t[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  /** The alignments of a separator row (`|---|:--:|--:|`), or null when the line is not one. */
  function tableAligns(line) {
    if (line.indexOf("-") === -1 || !/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line)) return null;
    return tableCells(line).map(function (c) {
      var l = c.charAt(0) === ":", r = c.charAt(c.length - 1) === ":";
      return l && r ? "c" : r ? "r" : l ? "l" : "";
    });
  }

  function renderTable(header, aligns, rows, store) {
    function cell(tag, text, i) {
      var a = aligns[i] ? ' class="al-' + aligns[i] + '"' : "";
      return "<" + tag + a + ">" + inline(text, store) + "</" + tag + ">";
    }
    function row(tag, cells) {
      var out = "";
      for (var i = 0; i < aligns.length; i++) out += cell(tag, cells[i] === undefined ? "" : cells[i], i);
      return "<tr>" + out + "</tr>";
    }
    return '<div class="tbl"><table><thead>' + row("th", header) + "</thead><tbody>" +
      rows.map(function (r) { return row("td", r); }).join("") + "</tbody></table></div>";
  }

  /** Block Markdown (headings, lists, tables, quotes, rules, paragraphs) over one run of non-code text. */
  function blocks(text, store) {
    var lines = escapeHtml(text).split("\n");
    var out = [];
    var para = [];
    var list = [];    // [{ indent, tag, text }]
    var quote = [];
    function flushPara() { if (para.length) { out.push("<p>" + para.map(function (l) { return inline(l, store); }).join("<br>") + "</p>"); para = []; } }
    function flushList() { if (list.length) { out.push(renderList(list, store)); list = []; } }
    function flushQuote() { if (quote.length) { out.push("<blockquote>" + quote.map(function (l) { return inline(l, store); }).join("<br>") + "</blockquote>"); quote = []; } }
    function flushAll() { flushPara(); flushList(); flushQuote(); }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m;
      if (/^\s*$/.test(line)) { flushAll(); continue; }
      // A table: a header row with a pipe, then a separator row with the same number of columns.
      if (line.indexOf("|") !== -1 && i + 1 < lines.length) {
        var aligns = tableAligns(lines[i + 1]);
        var header = aligns && tableCells(line);
        if (aligns && header.length === aligns.length && aligns.length <= MAX_TABLE_COLUMNS) {
          flushAll();
          var rows = [];
          var j = i + 2;
          for (; j < lines.length && lines[j].indexOf("|") !== -1 && !/^\s*$/.test(lines[j]); j++) rows.push(tableCells(lines[j]));
          out.push(renderTable(header, aligns, rows, store));
          i = j - 1;
          continue;
        }
      }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flushAll(); var n = Math.min(m[1].length + 2, 6); out.push("<h" + n + ">" + inline(m[2], store) + "</h" + n + ">"); continue; }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); out.push("<hr>"); continue; }
      if ((m = /^&gt;\s?(.*)$/.exec(line))) { flushPara(); flushList(); quote.push(m[1]); continue; }
      if ((m = /^([ \t]*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line))) {
        flushPara(); flushQuote();
        list.push({ indent: indentOf(m[1]), tag: /\d/.test(m[2]) ? "ol" : "ul", text: m[3] });
        continue;
      }
      flushList(); flushQuote();
      para.push(line);
    }
    flushAll();
    return out.join("");
  }

  // ── Code highlighting: a small tokenizer, never a library. Every token is escaped and wrapped in one of four
  //    fixed classes; what is not recognised stays plain escaped text. Unknown languages are not highlighted. ──
  var KEYWORDS = {
    js: "break case catch class const continue default delete do else export extends false finally for function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield async await",
    py: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield",
    sh: "if then else elif fi for while until do done case esac function in return local export set unset echo exit",
    json: "true false null"
  };
  KEYWORDS.ts = KEYWORDS.js + " interface type enum implements private public protected readonly declare namespace keyof as";
  var LANG_ALIAS = { javascript: "js", jsx: "js", mjs: "js", cjs: "js", typescript: "ts", tsx: "ts", python: "py", bash: "sh", shell: "sh", zsh: "sh", console: "sh" };
  var TOKEN_RE = {
    js: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g,
    py: /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g,
    sh: /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'[^']*')|(\b\d+\b)|([A-Za-z_][\w-]*)/g,
    json: /(\u0001)|("(?:[^"\\\n]|\\.)*")|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_]\w*)/g
  };
  TOKEN_RE.ts = TOKEN_RE.js;

  /** Code as highlighted HTML for a known language, or null (then the caller escapes it as before). */
  function highlight(code, lang) {
    var key = String(lang || "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LANG_ALIAS, key)) key = LANG_ALIAS[key];
    if (!Object.prototype.hasOwnProperty.call(TOKEN_RE, key)) return null;
    var words = {};
    KEYWORDS[key].split(" ").forEach(function (w) { words[w] = true; });
    var re = new RegExp(TOKEN_RE[key].source, "g");
    var out = "";
    var last = 0;
    var m;
    while ((m = re.exec(code)) !== null) {
      if (m[0] === "") { re.lastIndex++; continue; }
      out += escapeHtml(code.slice(last, m.index));
      var cls = m[1] ? "tk-c" : m[2] ? "tk-s" : m[3] ? "tk-n" : (m[4] && Object.prototype.hasOwnProperty.call(words, m[4])) ? "tk-k" : null;
      out += cls ? '<span class="' + cls + '">' + escapeHtml(m[0]) + "</span>" : escapeHtml(m[0]);
      last = re.lastIndex;
    }
    return out + escapeHtml(code.slice(last));
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
      var code = m[2].replace(/\n$/, "");
      var lit = highlight(code, m[1]);
      html += "<pre" + lang + "><code>" + (lit === null ? escapeHtml(code) : lit) + "</code></pre>";
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
      var k = key(m);
      if (seen[k] !== undefined) {
        // The same message again (history after the stream): the copy that got further shows its ticks.
        var had = out[seen[k]];
        var next = nextDeliveryState(had.delivery, m.delivery);
        if (next !== had.delivery) out[seen[k]] = Object.assign({}, had, { delivery: next });
        return;
      }
      seen[k] = out.length;
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

  /**
   * The delivery ticks of a web user's message (web track C3) — the same order the fleet keeps
   * (web-chat-history.ts nextDeliveryState): a report that arrives late or twice never moves a tick back;
   * delivered and failed are final, cancelled gives way to what the agent actually got.
   */
  var DELIVERY_RANK = { queued: 1, processing: 2, cancelled: 3, delivered: 4, failed: 4 };
  function nextDeliveryState(prev, next) {
    if (!Object.prototype.hasOwnProperty.call(DELIVERY_RANK, next)) return prev;
    if (prev === undefined || !Object.prototype.hasOwnProperty.call(DELIVERY_RANK, prev)) return next;
    return DELIVERY_RANK[next] > DELIVERY_RANK[prev] ? next : prev;
  }

  /** The list after a delivery report for `messageId`: the same list when nothing moved, else a copy. */
  function applyDelivery(list, messageId, delivery) {
    var msgs = list || [];
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (!msgs[i] || msgs[i].messageId !== messageId) continue;
      var next = nextDeliveryState(msgs[i].delivery, delivery);
      if (next === msgs[i].delivery) return msgs;
      var out = msgs.slice();
      out[i] = Object.assign({}, msgs[i], { delivery: next });
      return out;
    }
    return msgs;
  }

  var TICK_GLYPH = { queued: "◷", processing: "✓", delivered: "✓✓", failed: "!", cancelled: "⊘" };
  /** The ticks for one state, labelled for a screen reader as well as a pointer; "" when there is none. */
  function deliveryHtml(state, labels) {
    if (!Object.prototype.hasOwnProperty.call(TICK_GLYPH, state)) return "";
    var label = escapeHtml((labels && labels[state]) || state);
    return '<span class="tick tick-' + state + '" role="img" aria-label="' + label + '" title="' + label + '">' + TICK_GLYPH[state] + "</span>";
  }

  /** Whether the chat shows "working" and its Stop button for an instance in this execution state. */
  function isBusy(state) { return state === "working" || state === "stuck"; }

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

  /** The upload limits the server enforces (web-upload.ts UPLOAD_LIMITS); checked here first only to say so early. */
  var FILE_LIMITS = { maxFileBytes: 10 * 1024 * 1024, maxFiles: 5, maxTotalBytes: 25 * 1024 * 1024 };

  function formatSize(n) {
    var b = Number(n) || 0;
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10 * 1024 ? 1 : 0) + " KB";
    return (b / 1024 / 1024).toFixed(1) + " MB";
  }

  /**
   * Which of `adding` can join `pending` on one message: within the count, per-file and total limits.
   * Returns the files kept (pending first, then the accepted new ones) and, for each refused one, why.
   */
  function checkFiles(pending, adding) {
    var kept = (pending || []).slice();
    var total = 0;
    kept.forEach(function (f) { total += Number(f.size) || 0; });
    var rejected = [];
    (adding || []).forEach(function (f) {
      var size = Number(f.size) || 0;
      if (size === 0) rejected.push({ name: f.name, reason: "empty" });
      else if (size > FILE_LIMITS.maxFileBytes) rejected.push({ name: f.name, reason: "too-large" });
      else if (kept.length >= FILE_LIMITS.maxFiles) rejected.push({ name: f.name, reason: "too-many" });
      else if (total + size > FILE_LIMITS.maxTotalBytes) rejected.push({ name: f.name, reason: "too-much" });
      else { kept.push(f); total += size; }
    });
    return { kept: kept, rejected: rejected };
  }

  /**
   * The files shown with a message. Only an id the fleet issued (32 hex) becomes a URL, and only under
   * /ui/file/; a name is text. Images are shown (and open full size), other files are download links.
   */
  function attachmentsHtml(attachments) {
    if (!Array.isArray(attachments)) return "";
    var out = [];
    attachments.forEach(function (a) {
      if (!a || typeof a.id !== "string" || !/^[0-9a-f]{32}$/.test(a.id)) return;
      var url = "/ui/file/" + a.id;
      var name = escapeHtml(a.name || "file");
      if (a.kind === "photo") {
        out.push('<a class="att-img" href="' + url + '" target="_blank" rel="noopener noreferrer"><img src="' + url + '" alt="' + name + '" loading="lazy"></a>');
      } else {
        out.push('<a class="att-file" href="' + url + '" download="' + name + '">📎 ' + name + ' <span class="att-size">' + escapeHtml(formatSize(a.size)) + "</span></a>");
      }
    });
    return out.length ? '<div class="atts">' + out.join("") + "</div>" : "";
  }

  return {
    renderMarkdown: renderMarkdown, escapeHtml: escapeHtml, mergeMessages: mergeMessages, composerKey: composerKey,
    settleFailedSend: settleFailedSend, putBack: putBack,
    FILE_LIMITS: FILE_LIMITS, formatSize: formatSize, checkFiles: checkFiles, attachmentsHtml: attachmentsHtml,
    nextDeliveryState: nextDeliveryState, applyDelivery: applyDelivery, deliveryHtml: deliveryHtml, isBusy: isBusy,
  };
});
