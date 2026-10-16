// #1408 §0/§4: the conversation thread — the keyed DOM renderer #1307 and #1306 reviewed, now owned by the chat panel
// through a ref. Preact never manages these children: a node here may hold a live preview iframe, and an iframe that
// is moved or re-parented reloads. So:
// - a new message is appended; a changed one (its ticks) is replaced; the rest are left alone — an opened code block
//   stays open, a selection survives, where the reader scrolled stays theirs;
// - before ONE node is replaced, moved or removed: AgendPreview.stopIn(that node) — frames elsewhere keep running;
// - when the whole thread goes (the chat left, another instance opened): AgendPreview.stopAll("leave").
// Unrelated updates (a new message, another message's tick) stop nothing (#1306 §6.2, #1408 §4).
import "./chat-render.js";
import "./preview.js";
import { loadHtmlAttachment } from "./html-attachment.js";
import { chatTime, chatTimeFull, onDayChange } from "./chat-time.js";

const R = () => globalThis.AgendChatRender;
/** #1589: the public link shows attachments as downloads only (its page says so: <body data-public-link="1">). */
const PUBLIC_LINK = () => globalThis.document?.body?.dataset?.publicLink === "1";
/** #1589: how much of a text attachment is shown before "Show all". */
export const TEXT_PREVIEW_LINES = 200;
/** #1589: the most elements one formatted text card may build (table cells, highlight spans, Markdown elements), Show all
 *  included. Lines and the 1 MiB read do not bound it (one 200 KB line can be 100,000 cells): past it the card is plain
 *  text, one text node. */
export const TEXT_PREVIEW_NODES = 4000;
/** A csv/tsv wider than this is shown as text, as Markdown tables are capped at 20 columns. */
export const TEXT_PREVIEW_COLUMNS = 50;
const P = () => globalThis.AgendPreview;
/** #1672: a status line longer than this (lines, or characters) is folded until it is opened. */
export const STATUS_FOLD_LINES = 6;
export const STATUS_FOLD_CHARS = 600;
const COPY = '<svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

/** Escapes & " ' < >: safe for text and inside a quoted attribute. */
export function escAttr(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
export const msgKey = (x) => `${x.boot}-${x.id}`;
/**
 * Board 00ef2430: a thread opens with only its newest messages drawn — enough for a screen — so switching chats paints
 * at once; the older ones are drawn after that, a chunk at a time between frames, the reader's place kept.
 */
export const THREAD_TAIL = 24;
export const THREAD_CHUNK = 40;

/**
 * Bind a renderer to `list` (the thread element) inside `scroller`. opts: { t, tf, isUser(x), onJump({show, unseen}),
 * setPreviewOptIn(on), copyText(text) → Promise<boolean>, download(code), panel? }. panel (#1481): { shown() → the card
 * key the side panel shows, or null; open(spec, { run }); version(); claim(); claims() } — without it a card has no "Open in panel".
 */
export function createThread(list, scroller, opts) {
  const nodes = new Map();          // key → { html, node }
  let msgs = [];
  let unseen = 0;
  // The reader is at the newest message. While pinned, content that grows after it was drawn — an image loading, a
  // preview card, the composer growing — keeps the view at the bottom (#1269); a reader who scrolled up is never moved.
  // Only a move UP unpins: the browser's own scroll anchoring also fires scroll events when content grows (the view
  // moves down or stays), and those must not count as the reader leaving the bottom. Reaching the bottom pins again.
  let pinned = true;
  let lastTop = 0;
  // The oldest message drawn (by key): everything after it is drawn, so new messages never push the window. Null: none
  // drawn yet — the next render draws the newest THREAD_TAIL and the rest follows (grow).
  let firstKey = null;
  let growTimer = null, growFrame = null, disposed = false;
  const cardRefresh = new WeakMap(); // card node → re-read availability (weak: a card that left takes its source with it)
  const tr = opts.t, trf = opts.tf;
  const stopIn = (node) => (P() ? P().stopIn(node) : []);
  /** #1770: write a message node's time label for now; unchanged text is not touched. */
  function timeLabel(node) {
    const el = node.querySelector(".meta .time[data-ts]");
    if (!el) return;
    const v = chatTime(el.dataset.ts, { yesterday: (hm) => trf("chat.yesterdayAt", hm) });
    if (el.textContent !== v) el.textContent = v;
  }
  // #1770: "today" ends at the fleet's midnight; the labels are rewritten then (and on every render), while there are any.
  let offDay = null;
  function armDay() {
    if (nodes.size && !offDay) offDay = onDayChange(() => { for (const v of nodes.values()) timeLabel(v.node); });
    else if (!nodes.size && offDay) { offDay(); offDay = null; }
  }

  const TICKS = () => ({ queued: tr("chat.tick_queued"), processing: tr("chat.tick_processing"), delivered: tr("chat.tick_delivered"), failed: tr("chat.tick_failed"), cancelled: tr("chat.tick_cancelled") });

  function msgHtml(x) {
    // #1770: the label ("17:38", "Yesterday 17:38", "10/11 17:38") depends on today, so it is not part of the html a node
    // is kept by: it is written into the node (timeLabels) — crossing midnight relabels in place and reloads no preview.
    const time = x.ts ? `<span class="time" data-ts="${escAttr(x.ts)}" title="${escAttr(chatTimeFull(x.ts))}"></span>` : `<span class="time"></span>`;
    if (x.role === "status") return statusHtml(x, time);
    const u = opts.isUser(x);
    // renderMarkdown escapes the whole text before it adds any tag of its own (chat-render.js).
    const ticks = u && x.delivery ? R().deliveryHtml(x.delivery, TICKS()) : "";
    const tools = u ? "" : `<div class="msg-tools"><button type="button" class="chip-btn icon-only" data-act="copyMsg" data-arg="${escAttr(msgKey(x))}" title="${escAttr(tr("chat.copyMessage"))}" aria-label="${escAttr(tr("chat.copyMessage"))}">${COPY}</button></div>`;
    const buttons = x.role === "agent" ? replyButtonsHtml(x.buttons) : "";
    // A person's click on a reply button shows as the button's label, never the line the agent was given (its value).
    const clicked = x.role === "user" && x.click && typeof x.click.label === "string";
    return `<div class="msg ${u ? "user" : "agent"}"><div class="meta"><span class="sender">${escAttr(x.sender)}</span>${time}${ticks}</div><div class="body">${clicked ? clickHtml(x.click) : `<div class="md">${R().renderMarkdown(x.text, { htmlCards: x.role === "agent", emojis: opts.emojis, mentions: opts.mentions })}</div>`}${R().attachmentsHtml(x.attachments, { htmlCards: x.role === "agent", goneTitle: tr("chat.attGone"), goneLabel: tr("chat.attUnavailable"), inlinePreviews: !PUBLIC_LINK() })}${buttons}</div>${tools}</div>`;
  }
  /**
   * A button click as a chip: 🔘 and the label (escaped: the label is the agent's text). With `of` (live, while its
   * reply is in this thread) it is a button that shows that reply; restored from disk, plain.
   */
  function clickHtml(click) {
    const inner = `<span class="click-mark" aria-hidden="true">🔘</span><span class="sr-only">${escAttr(tr("chat.clicked"))} </span>${escAttr(click.label)}`;
    const of = typeof click.of === "string" && /^[0-9a-f]{32}$/.test(click.of) ? click.of : null;
    return `<div class="click-chip">${of
      ? `<button type="button" class="click-link" data-act="showButtons" data-arg="${escAttr(of)}" title="${escAttr(tr("chat.clickShow"))}">${inner}</button>`
      : `<span class="click-text">${inner}</span>`}</div>`;
  }
  /**
   * #1672: a status line (another instance's message, a daemon notice) is muted, read-only plain text — never Markdown,
   * a preview card, a button or a person's bubble. Checked before isUser, which reads the sender: a fleet name need not
   * start with "agend". A long one is folded until it is opened.
   */
  function statusHtml(x, time) {
    const text = String(x.text == null ? "" : x.text);
    const lines = R().lineCount(text);
    const manyLines = lines > STATUS_FOLD_LINES;
    const more = manyLines || text.length > STATUS_FOLD_CHARS
      ? `<button type="button" class="st-more" data-act="toggleFold"${manyLines ? ` data-lines="${escAttr(lines)}"` : ""}>${escAttr(manyLines ? trf("chat.showAll", lines) : tr("chat.showMore"))}</button>`
      : "";
    const tools = `<div class="msg-tools"><button type="button" class="chip-btn icon-only" data-act="copyMsg" data-arg="${escAttr(msgKey(x))}" title="${escAttr(tr("chat.copyMessage"))}" aria-label="${escAttr(tr("chat.copyMessage"))}">${COPY}</button></div>`;
    return `<div class="msg status-line${more ? " folded" : ""}"><div class="meta">${time}</div><div class="body"><div class="st-text">${escAttr(text)}</div>${more}</div>${tools}</div>`;
  }
  /**
   * #1266: an agent reply's buttons. Labels are text (escaped, never Markdown); the click names the set and the index,
   * nothing else. Ended (chosen / expired) or a click in flight: every button off; the chosen one marked, and who.
   */
  function replyButtonsHtml(b) {
    if (!b || typeof b.id !== "string" || !Array.isArray(b.labels) || !b.labels.length) return "";
    if (b.poll && typeof b.poll === "object") return pollHtml(b);
    const busy = !!(opts.replyButtonBusy && opts.replyButtonBusy(b.id));
    const off = b.state !== "open" || busy;
    const items = b.labels.map((label, i) => {
      const chosen = b.state === "chosen" && b.chosen === i;
      return `<button type="button" class="btn btn-sm rb-btn${chosen ? " chosen" : ""}" data-act="replyButton" data-arg="${escAttr(`${b.id}:${i}`)}"${off ? " disabled" : ""}>${escAttr(chosen ? `✓ ${label}` : label)}</button>`;
    }).join("");
    const note = b.state === "chosen" ? trf("chat.rbChosen", b.by || "") : b.state === "expired" ? tr("chat.rbExpired") : "";
    return `<div class="rb-row" role="group" aria-label="${escAttr(tr("chat.rbGroup"))}">${items}${note ? `<span class="rb-note">${escAttr(note)}</span>` : ""}</div>`;
  }
  /**
   * #1823: a poll. Anyone here may click while it is open; the page marks its own vote (opts.pollMine), which no one else
   * sees. Counts only when the server sends them (revealed: live, or closed); names only at close with show_voters. The
   * time left is not in the html (a node is kept by its html): pollLeft writes it, every second.
   */
  function pollHtml(b) {
    const p = b.poll, closed = b.state === "closed";
    const busy = !!(opts.replyButtonBusy && opts.replyButtonBusy(b.id));
    const mine = (opts.pollMine && opts.pollMine(b.id)) || [];
    const counts = Array.isArray(p.counts) && p.counts.length === b.labels.length ? p.counts : null;
    const items = b.labels.map((label, i) => {
      const me = !closed && mine.includes(i);
      const tally = counts ? ` · ${counts[i]}${closed && p.answered ? ` (${Math.round((counts[i] / p.answered) * 100)}%)` : ""}` : "";
      return `<button type="button" class="btn btn-sm rb-btn${me ? " chosen" : ""}" data-act="replyButton" data-arg="${escAttr(`${b.id}:${i}`)}" aria-pressed="${me ? "true" : "false"}"${closed || busy ? " disabled" : ""}>${escAttr(`${me ? "✓ " : ""}${label}${tally}`)}</button>`;
    }).join("");
    const status = closed
      ? escAttr(trf("chat.pollClosed", p.answered))
      : `${escAttr(trf("chat.pollAnswered", p.answered))} · ⏳ <span class="poll-left" data-deadline="${escAttr(p.deadline)}" title="${escAttr(tr("chat.pollLeft"))}"></span>`;
    const voters = closed && Array.isArray(p.voters)
      ? `<ul class="poll-voters" aria-label="${escAttr(tr("chat.pollVoters"))}">${b.labels.map((label, i) => `<li>${escAttr(`${label}: ${(p.voters[i] || []).join(", ") || "—"}`)}</li>`).join("")}</ul>`
      : "";
    return `<div class="rb-row poll" role="group" aria-label="${escAttr(tr("chat.pollGroup"))}">${items}<span class="rb-note">${status}</span></div>${voters}`;
  }
  /** #1823: the time left on this node's open polls, now. */
  function pollLeft(node) {
    for (const el of node.querySelectorAll(".poll-left[data-deadline]")) {
      const v = R().pollRemaining(Number(el.dataset.deadline) - (opts.serverNow ? opts.serverNow() : Date.now()));
      if (el.textContent !== v) el.textContent = v;
    }
  }
  // #1823: while an open poll is on screen, its time left is rewritten every second.
  let pollTick = null;
  function armPolls() {
    const open = nodes.size > 0 && !!list.querySelector(".poll-left[data-deadline]");
    if (open && !pollTick) pollTick = setInterval(() => pollLeft(list), 1000);
    else if (!open && pollTick) { clearInterval(pollTick); pollTick = null; }
  }

  function msgNode(html, x, stoppedKeys) {
    const tpl = list.ownerDocument.createElement("template");
    tpl.innerHTML = html;
    const node = tpl.content.firstElementChild;
    decorateCode(node);
    timeLabel(node);
    pollLeft(node);
    if (x) decorateHtmlCards(node, x, stoppedKeys || []);
    if (x) decorateTextCards(node, x);
    return node;
  }

  // Code blocks: a header (language, Wrap, Copy); a long one is folded until opened. Built from nodes.
  function decorateCode(root) {
    const doc = list.ownerDocument;
    for (const pre of root.querySelectorAll(".md pre")) {
      const box = doc.createElement("div"); box.className = "codeblock";
      const head = doc.createElement("div"); head.className = "cb-head";
      const lang = doc.createElement("span"); lang.className = "cb-lang"; lang.textContent = pre.dataset.lang || "text";
      const wrap = doc.createElement("button"); wrap.type = "button"; wrap.className = "chip-btn"; wrap.dataset.act = "toggleWrap"; wrap.textContent = tr("chat.wrap");
      const copy = doc.createElement("button"); copy.type = "button"; copy.className = "chip-btn"; copy.dataset.act = "copyCode"; copy.textContent = tr("chat.copy");
      head.append(lang, wrap, copy);
      pre.replaceWith(box); box.append(head, pre);
      const lines = R().lineCount(pre.textContent);
      if (lines > R().CODE_FOLD_LINES) {
        box.classList.add("folded");
        const more = doc.createElement("button"); more.type = "button"; more.className = "cb-more"; more.dataset.act = "toggleFold";
        more.dataset.lines = String(lines); more.textContent = trf("chat.showAll", lines);
        box.append(more);
      }
    }
  }

  // HTML cards (#1306): each ```html fence of a server-marked agent message gets a card under its code block, and each
  // .html/.htm file it attached gets one under its files (§6.1, Q4). Building a card makes no frame and fetches
  // nothing; Preview does (AgendPreview.start → mountPreview), after reading an attachment's HTML on that click.
  function decorateHtmlCards(node, x, stoppedKeys) {
    const doc = list.ownerDocument;
    const fences = R().htmlFences(x.text);
    for (const ph of node.querySelectorAll(".html-card[data-card]")) {
      const n = Number(ph.dataset.card), fence = fences[n];
      if (!fence) continue;
      ph.textContent = "";
      if (ph.classList.contains("truncated") || !fence.terminated) {
        const note = doc.createElement("div"); note.className = "pv-note"; note.textContent = tr("chat.pvTruncated"); ph.append(note);
        continue;
      }
      buildCard(ph, x, `${msgKey(x)}:f${n}`, { n, code: fence.code }, stoppedKeys);
    }
    const atts = Array.isArray(x.attachments) ? x.attachments : [];
    for (const ph of node.querySelectorAll(".html-card[data-att]")) {
      const att = atts.find(a => a && a.id === ph.dataset.att);
      if (!att || !R().isHtmlAttachment(att)) continue;
      ph.textContent = "";
      buildCard(ph, x, `${msgKey(x)}:a${att.id}`, { att: { id: att.id, name: att.name, size: att.size } }, stoppedKeys);
    }
  }
  // #1589: a text attachment (md, csv, json, code, plain) gets a card: Show reads the file once (the same capped,
  // same-origin read as an HTML attachment's) and shows it — Markdown through renderMarkdown (it escapes first), code
  // through the highlighter (escaped), csv as a table and anything else as text, all built with textContent. Nothing in
  // the file is ever run: no frame, no script, no HTML of its own.
  function decorateTextCards(node, x) {
    const atts = Array.isArray(x.attachments) ? x.attachments : [];
    for (const ph of node.querySelectorAll(".text-card[data-att]")) {
      const att = atts.find(a => a && a.id === ph.dataset.att);
      const type = att ? R().attachmentPreviewType(att) : null;
      if (!att || !type || type !== ph.dataset.type) continue;
      buildTextCard(ph, att, type);
    }
  }
  function buildTextCard(ph, att, type) {
    const doc = list.ownerDocument;
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    ph.textContent = "";
    const head = el("div", "tc-head");
    const label = el("span", "tc-label", att.name);
    const show = el("button", "btn btn-sm tc-show", tr("chat.tcShow")); show.type = "button";
    const dl = el("a", "btn btn-sm tc-dl", tr("chat.tcDownload")); dl.href = `/ui/file/${att.id}`; dl.setAttribute("download", att.name);
    head.append(label, show, dl);
    const note = el("div", "pv-note");
    const body = el("div", "tc-body"); body.hidden = true;
    ph.append(head, note, body);
    let text = null, reading = false, all = false;
    const draw = () => {
      body.textContent = "";
      const lines = text.split(/\r?\n/);
      const cut = !all && lines.length > TEXT_PREVIEW_LINES;
      const shown = cut ? lines.slice(0, TEXT_PREVIEW_LINES) : lines;
      const src = shown.join("\n");
      // Formatting is built only within TEXT_PREVIEW_NODES: the markup is measured as a string first, never as DOM.
      const plain = () => {
        const pre = el("pre", "tc-pre"), code = el("code", null, src);
        pre.append(code); body.append(el("div", "pv-note", tr("chat.tcPlain")), pre);
      };
      if (type === "md") {
        const html = R().renderMarkdown(src);
        if (tagCount(html) > TEXT_PREVIEW_NODES) plain();
        else { const md = el("div", "md"); md.innerHTML = html; body.append(md); }
      } else if (type === "csv" || type === "tsv") {
        const table = csvTable(src, type === "tsv" ? "\t" : ",", el);
        if (table) body.append(table); else plain();
      } else {
        const lang = type === "json" ? "json" : type.startsWith("code:") ? type.slice(5) : "";
        const lit = lang ? R().highlight(src, lang) : null;
        if (lit != null && tagCount(lit) > TEXT_PREVIEW_NODES) plain();
        else {
          const pre = el("pre", "tc-pre"), code = el("code");
          if (lit != null) code.innerHTML = lit; else code.textContent = src;
          pre.append(code); body.append(pre);
        }
      }
      if (cut) {
        const more = el("button", "btn btn-sm tc-more", trf("chat.tcShowAll", lines.length)); more.type = "button";
        more.onclick = () => { all = true; draw(); };
        body.append(more);
      }
    };
    show.onclick = async () => {
      if (reading) return;
      if (text !== null) { body.hidden = !body.hidden; show.textContent = tr(body.hidden ? "chat.tcShow" : "chat.tcHide"); return; }
      reading = true; note.textContent = tr("chat.pvLoading");
      const r = await loadHtmlAttachment({ id: att.id, name: att.name, size: att.size });
      reading = false;
      if (!ph.isConnected) return;                       // the card left the page while it was read: nothing to draw
      if (!r.ok) { note.textContent = r.reason === "over" ? tr("chat.tcOver") : attReason(r.reason); return; }
      note.textContent = "";
      text = r.code;
      if (type === "json") { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* shown as written */ } }
      draw();
      body.hidden = false; show.textContent = tr("chat.tcHide");
    };
  }
  /** How many elements an HTML string would build: its opening tags (escaped text has none). */
  function tagCount(html) {
    let n = 0;
    for (let i = html.indexOf("<"); i !== -1; i = html.indexOf("<", i + 1)) { const c = html.charCodeAt(i + 1); if ((c | 32) >= 97 && (c | 32) <= 122) n++; }
    return n;
  }
  /** A csv/tsv as a table: quoted fields ("a, b", "say ""hi""") kept whole; every cell is textContent. */
  function csvTable(src, sep, el) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
        else cell += c;
      } else if (c === '"' && cell === "") quoted = true;
      else if (c === sep) { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
    // Within the card's budget, or not a table at all (the caller shows it as text).
    let cells = 0;
    for (const r of rows) { cells += r.length; if (r.length > TEXT_PREVIEW_COLUMNS || cells + rows.length > TEXT_PREVIEW_NODES) return null; }
    const table = el("table", "tc-table");
    rows.forEach((r, i) => {
      const tr_ = el("tr");
      for (const v of r) tr_.append(el(i === 0 ? "th" : "td", null, v));
      table.append(tr_);
    });
    const wrap = el("div", "tc-table-wrap"); wrap.append(table);
    return wrap;
  }
  /** Why an attachment's HTML could not be read, for the card's note. */
  const attReason = (reason) => tr(reason === "over" ? "chat.pvAttOver" : reason === "gone" ? "chat.pvAttGone" : "chat.pvAttFailed");
  /** One card: `source` is { n, code } for a fence or { att } for an attachment (its HTML read on the first click). */
  function buildCard(ph, x, key, source, stoppedKeys) {
    const doc = list.ownerDocument;
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const att = source.att || null;
    let code = att ? null : source.code;
    const head = el("div", "pv-head");
    const label = el("span", "pv-label", att ? `${tr("chat.pvHtml")} · ${att.name}` : tr("chat.pvHtml"));
    const run = el("button", "btn btn-sm pv-run", tr("chat.pvPreview")); run.type = "button";
    const stopB = el("button", "btn btn-sm pv-stop", tr("chat.pvStop")); stopB.type = "button"; stopB.hidden = true;
    // An attachment already has its download link (the file itself) right above the card.
    const dl = att ? null : el("button", "btn btn-sm btn-ghost pv-dl", tr("chat.pvDownload"));
    if (dl) dl.type = "button";
    const panel = opts.panel || null;
    const toPanel = panel ? el("button", "btn btn-sm btn-ghost pv-open", tr("chat.pvOpenPanel")) : null;
    if (toPanel) toPanel.type = "button";
    const menu = el("details", "pv-menu");
    const sum = el("summary", null, "⋯"); sum.title = tr("chat.pvMenu"); sum.setAttribute("aria-label", tr("chat.pvMenu"));
    const optB = el("button", "chip-btn pv-opt"); optB.type = "button";
    const neverB = el("button", "chip-btn pv-never"); neverB.type = "button";
    menu.append(sum, optB, neverB);
    head.append(label, run, stopB, ...(toPanel ? [toPanel] : []), ...(dl ? [dl] : []), menu);
    const note = el("div", "pv-note");
    // #1568: the banner, with its "I understand" (hidden until the next sign-in; the frame's border stays).
    const banner = el("div", "pv-banner"); banner.hidden = true;
    const ack = el("button", "btn btn-sm btn-ghost pv-ack", P().bannerAckLabel()); ack.type = "button"; ack.title = P().bannerAckTitle();
    banner.append(el("span", "pv-banner-text", P().banner()), ack);
    const holder = el("div", "pv-holder");
    ph.append(head, note, banner, holder);
    let state = "idle";
    // Reading an attachment: one read per card at a time (a second click while it reads does nothing), and a read
    // whose card was stopped, replaced or left meanwhile is dropped (`reading` moved on, or the card left the page).
    let reading = 0, reads = 0;
    const refresh = (reason) => {
      const a = P().availability();
      const going = state === "starting" || state === "running";
      const inPanel = !!panel && panel.shown() === key;   // #1481: the panel shows this block; the card points there
      run.hidden = !a.ok || going || inPanel || !!reading;
      if (toPanel) toPanel.hidden = inPanel || !!reading;
      stopB.hidden = !going && !reading;
      banner.hidden = !going || P().bannerAcked();
      note.textContent = reason != null ? reason : reading ? tr("chat.pvLoading") : going ? (state === "starting" ? tr("chat.pvStarting") : "") : inPanel ? tr("chat.pvInPanel") : a.ok ? "" : a.reason;
      optB.textContent = P().optedIn() ? tr("chat.pvDisallow") : tr("chat.pvAllow");
      neverB.textContent = P().never() ? tr("chat.pvNeverUndo") : tr("chat.pvNever");
    };
    /** The HTML, then `then(code)`: at once for a fence or an attachment already read; otherwise read it first. */
    const withCode = async (then) => {
      if (code != null) { then(code); return; }
      if (reading) return;
      const mine = reading = ++reads;
      refresh();
      const r = await loadHtmlAttachment(att);
      if (reading !== mine || !ph.isConnected) return;
      reading = 0;
      if (!r.ok) { refresh(attReason(r.reason)); return; }
      code = r.code;
      refresh();
      then(code);
    };
    const ui = { state: (name, reason) => { state = name === "starting" || name === "running" ? name : "idle"; refresh(reason || null); } };
    // Nothing is read for Preview on a device that does not allow previews: the button is not even shown there.
    // A Preview click is newer than any Open in panel still reading (#1704): it claims the panel's turn too — and, its
    // own HTML read, starts only if no newer click claimed meanwhile and no preview was started since (the panel's own
    // Preview): a late read never undoes a newer choice. A close is neither, so it does not drop this click.
    run.onclick = () => {
      if (!P().availability().ok || reading) return;     // this card already reading: that click stays the one
      const mine = panel ? (panel.claim(), panel.claims()) : 0, started = P().startCount();
      withCode((c) => {
        if ((panel && panel.claims() !== mine) || P().startCount() !== started) { refresh(); return; }
        P().start(key, holder, c, ui);
      });
    };
    stopB.onclick = () => { if (reading) { reading = 0; refresh(); } else P().stop(key, "stopped", ""); };
    // #1704: this click runs it in the panel, as Preview there would — a running preview moves (it stops here and
    // starts there), an idle one starts there. Whether it can run is the panel's to say: a device that has not allowed
    // previews is offered Allow first (and allowing runs it); where previews are off, nothing runs.
    // An attachment's HTML is read first. The click claims the panel at once, so a newer click (even one still reading)
    // wins: if the panel changed (another click, block, close) or any preview started meanwhile, this one is dropped —
    // a late read never undoes a newer click.
    if (toPanel) toPanel.onclick = () => {
      if (reading) return;                               // this card already reading: that click stays the one
      if (P().running(key)) P().stop(key, "stopped", "");
      const at = panel.claim(), started = P().startCount();
      withCode((c) => {
        if (panel.version() !== at || P().startCount() !== started) { refresh(); return; }
        panel.open({ key, instance: x.instance, msgKey: msgKey(x), ...(att ? { att } : { n: source.n }), code: c, sender: x.sender, ts: x.ts }, { run: true });
      });
    };
    if (dl) dl.onclick = () => opts.download(code);
    ack.onclick = () => P().ackBanner();      // every card and the panel hear it (onChange)
    optB.onclick = () => { menu.open = false; opts.setPreviewOptIn(!P().optedIn()); };
    neverB.onclick = () => { menu.open = false; P().setNever(!P().never()); refreshCards(); };
    cardRefresh.set(ph, refresh);
    refresh(stoppedKeys.includes(key) ? tr("chat.pvChanged") : null);
  }
  /** Re-read this device's preview choice on every card in this thread. */
  function refreshCards() {
    for (const node of list.querySelectorAll(".html-card[data-card], .html-card[data-att]")) { const f = cardRefresh.get(node); if (f) f(); }
  }

  // Near the bottom (48 px slack): where the READER counts as at the newest message — for the pill and for pinning on scroll.
  const nearBottom = () => R().isNearBottom(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight);
  // #1584: at the exact bottom — what a pinned view is kept at. The slack is the reader's, not the layout's: a dock that
  // grew by less than 48 px (the working line, a command card, the composer shrinking after a send) used to leave the
  // newest bubble clipped behind it, and the next growth past 48 px put the pill over it.
  const atBottom = () => R().isNearBottom(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight, 1);
  function reportJump() { opts.onJump({ show: !nearBottom(), unseen }); }
  function toBottom() { scroller.scrollTop = scroller.scrollHeight; pinned = true; lastTop = scroller.scrollTop; }
  // Sizes change without a scroll event (layout after the render, the dock under the thread): while pinned, the view
  // stays flush with the bottom; a reader who scrolled up is never moved.
  const resized = () => { if (pinned && !atBottom()) toBottom(); reportJump(); };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resized) : null;
  if (ro) { ro.observe(list); ro.observe(scroller); }

  /** Where drawing starts in `msgs`: at the oldest drawn message, or (none yet) the newest THREAD_TAIL. */
  function startIndex() {
    const i = firstKey === null ? -1 : msgs.findIndex((x) => msgKey(x) === firstKey);
    // Whatever is drawn stays drawn: the list may have reordered (merged across fleet restarts) or lost its oldest to
    // the cap — so the window starts at the earlier of the oldest drawn key and the first message still drawn.
    const still = nodes.size ? msgs.findIndex((x) => nodes.has(msgKey(x))) : -1;
    const at = [i, still].filter((n) => n >= 0);
    return at.length ? Math.min(...at) : Math.max(0, msgs.length - THREAD_TAIL);
  }
  /** Draw the next chunk of older messages, keeping the reader where they were; then the next, until all are drawn. */
  function grow() {
    growTimer = growFrame = null;
    if (disposed) return;                 // the chat left: nothing more is drawn
    const at = startIndex();
    if (at <= 0) return;
    firstKey = msgKey(msgs[Math.max(0, at - THREAD_CHUNK)]);
    const fromBottom = scroller.scrollHeight - scroller.scrollTop;
    draw({ older: true });                // drawn above the reader: never "new below" (render alone counts those)
    if (pinned) toBottom();
    else { scroller.scrollTop = scroller.scrollHeight - fromBottom; lastTop = scroller.scrollTop; }
    scheduleGrow();
  }
  /** After the next frame has painted (the click's own frame stays light), draw a chunk more. */
  function scheduleGrow() {
    if (growTimer !== null || growFrame !== null || startIndex() <= 0) return;
    const later = () => { growFrame = null; growTimer = setTimeout(grow, 0); };
    if (typeof requestAnimationFrame === "function") growFrame = requestAnimationFrame(later); else later();
  }
  /** Everything drawn now (a remembered scroll position, a message to show that is not drawn yet). */
  function growAll() {
    if (startIndex() <= 0) return;
    if (growFrame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(growFrame);
    if (growTimer !== null) clearTimeout(growTimer);
    growTimer = growFrame = null;
    firstKey = msgs.length ? msgKey(msgs[0]) : null;
    draw({ older: true });
  }

  /** Draw `next` (this instance's messages). `restore`: the scroll position to return to (null = the bottom). */
  function render(next, renderOpts = {}) {
    const stick = pinned || nearBottom();
    msgs = next || [];
    if (!msgs.length) {
      for (const v of nodes.values()) stopIn(v.node);
      nodes.clear();
      firstKey = null;
      armDay();
      list.textContent = "";
      opts.onEmpty(true);
      return;
    }
    opts.onEmpty(false);
    // A position to return to that is not the bottom needs the messages above it: all of them, at once (as before).
    if ("restore" in renderOpts && renderOpts.restore != null) firstKey = msgKey(msgs[0]);
    const added = draw({});
    if (firstKey === null || startIndex() > 0) { firstKey = msgKey(msgs[startIndex()]); scheduleGrow(); }
    if ("restore" in renderOpts) {
      unseen = 0;
      if (renderOpts.restore == null) toBottom();
      else { scroller.scrollTop = renderOpts.restore; pinned = nearBottom(); lastTop = scroller.scrollTop; }
    } else if (stick) toBottom();
    else unseen += added;
    reportJump();
  }
  /** Put the messages from startIndex() on in the list (nodes reused when unchanged). Returns how many are new. */
  function draw(drawOpts) {
    const shown = msgs.slice(startIndex());
    const keep = new Set(shown.map(msgKey));
    for (const [k, v] of nodes) if (!keep.has(k)) { stopIn(v.node); v.node.remove(); nodes.delete(k); }
    let prev = null, added = 0;
    for (const x of shown) {
      const key = msgKey(x);
      let have = nodes.get(key);
      // Filling in older messages: a node drawn from this very message object is current — not drawn again.
      if (drawOpts.older && have && have.x === x) { prev = have.node; continue; }
      const html = msgHtml(x);
      if (!have || have.html !== html) {
        const stopped = have ? stopIn(have.node) : [];
        const node = msgNode(html, x, stopped);
        if (have) have.node.replaceWith(node); else added++;
        have = { html, node, x }; nodes.set(key, have);
      } else { have.x = x; timeLabel(have.node); }
      const want = prev ? prev.nextSibling : list.firstChild;
      // A node already in the list is being moved: its preview stops first. A new node (still in its template) has none.
      if (have.node !== want) { if (have.node.parentNode === list) stopIn(have.node); list.insertBefore(have.node, want); }
      prev = have.node;
    }
    armDay();
    armPolls();
    return added;
  }

  function onScroll() {
    const bottom = nearBottom(), top = scroller.scrollTop;
    if (bottom) pinned = true;
    else if (top < lastTop) pinned = false;
    lastTop = top;
    if (bottom) unseen = 0;
    reportJump();
    return bottom ? null : scroller.scrollTop;
  }
  function jumpLatest() { toBottom(); unseen = 0; reportJump(); }
  /** Show one message (the panel's "from …" link, #1481): scrolled into view and briefly marked. */
  function reveal(key) {
    if (!nodes.has(key) && msgs.some((x) => msgKey(x) === key)) growAll();     // an older message not drawn yet
    const have = nodes.get(key); if (!have) return false;
    if (typeof have.node.scrollIntoView === "function") have.node.scrollIntoView({ block: "center" });
    have.node.classList.add("flash");
    setTimeout(() => { have.node.classList.remove("flash"); }, 1600);
    return true;
  }

  async function copyFrom(button, text) {
    const ok = await opts.copyText(text);
    if (button.classList.contains("icon-only")) {
      button.classList.add(ok ? "done" : "fail");
      button.title = ok ? tr("chat.copied") : tr("chat.copyFailed"); button.setAttribute("aria-label", button.title);
      setTimeout(() => { button.classList.remove("done", "fail"); button.title = tr("chat.copyMessage"); button.setAttribute("aria-label", button.title); }, 1200);
      return;
    }
    const was = button.dataset.label || button.textContent; button.dataset.label = was;
    button.textContent = ok ? tr("chat.copied") : tr("chat.copyFailed");
    setTimeout(() => { button.textContent = was; }, 1200);
  }
  /**
   * A chat image: a plain left click (or Enter on it) shows it in the page — this message's images, from the one
   * clicked. With a modifier key the link does what the browser does (a new tab, a new window, a download); a middle
   * click is not a click event at all. True when it was an image (whether or not it opened).
   */
  function onImageClick(e) {
    const img = e.target && e.target.closest ? e.target.closest("a.att-img") : null;
    if (!img || !list.contains(img)) return false;
    if (opts.openImage && !e.defaultPrevented && (e.button ?? 0) === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      const links = [...(img.closest(".atts") || img).querySelectorAll("a.att-img")];
      if (opts.openImage(links.length ? links : [img], img)) e.preventDefault();
    }
    return true;
  }
  /** The thread's own buttons (Copy, Wrap, fold), delegated from the thread element. */
  function onClick(e) {
    if (onImageClick(e)) return;
    const el = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!el || !list.contains(el)) return;
    const act = el.dataset.act;
    if (act === "copyMsg") { const x = msgs.find(y => msgKey(y) === el.dataset.arg); if (x) copyFrom(el, x.text); }
    else if (act === "copyCode") { const pre = el.closest(".codeblock")?.querySelector("pre"); if (pre) copyFrom(el, pre.textContent); }
    else if (act === "toggleFold") {
      const box = el.closest(".codeblock, .msg.status-line"); if (!box) return;
      const folded = box.classList.toggle("folded");
      el.textContent = !folded ? tr("chat.showLess") : el.dataset.lines ? trf("chat.showAll", el.dataset.lines) : tr("chat.showMore");
    } else if (act === "toggleWrap") opts.toggleWrap();
    else if (act === "replyButton") {
      const m = /^([0-9a-f]{32}):(\d{1,2})$/.exec(el.dataset.arg || "");
      if (m && opts.clickReplyButton) opts.clickReplyButton(m[1], Number(m[2]));
    } else if (act === "showButtons") { const x = msgs.find(y => y.buttons && y.buttons.id === el.dataset.arg); if (x) reveal(msgKey(x)); }
  }

  /** The thread goes (the chat left, or another instance opened): every preview in it stops first. */
  function dispose() {
    disposed = true;
    if (ro) ro.disconnect();
    if (P()) P().stopAll("leave");
    nodes.clear();
    armDay();
    armPolls();
  }

  return { render, onScroll, onClick, jumpLatest, reveal, refreshCards, dispose, nodes, get unseen() { return unseen; } };
}
