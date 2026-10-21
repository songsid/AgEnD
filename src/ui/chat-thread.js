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
import { effectTrialMessage } from "./effect-trial-offer.js";
import { loadHtmlAttachment } from "./html-attachment.js";
import { chatTime, chatTimeFull, onDayChange } from "./chat-time.js";
import { textLinkSegments } from "/assets/app-route.js";

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
const REPLY = '<svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
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
/** #2158: a reader's scroll (smooth, momentum) is theirs until it has been this quiet since their last input or scroll. */
export const READER_QUIET_MS = 250;
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "]);

/**
 * #2053: a message's rendered Markdown, kept across renders and chat switches. A draw compares each message's html with
 * its node's, so every render of a thread rendered every drawn message's Markdown again (~320 calls per 200-message
 * switch). renderMarkdown's output depends only on the text, whether its HTML cards are on (an agent's message), and —
 * for a text that has them — whether the page knows each server-emoji id and the name it has for each mention: the key
 * holds exactly those, so a cached html is always what renderMarkdown would return now. Bounded: least recently used out.
 */
export const MD_CACHE_MAX = 4000;
const mdCache = new Map();
const EMOJI_IDS = /<a?:[A-Za-z0-9_]{2,32}:(\d{15,25})>/g;
const MENTION_IDS = /<(@!?|@&|#)(\d{15,25})>/g;
const MENTION_KINDS = { "@": "u", "@!": "u", "@&": "r", "#": "c" };
export function renderedMarkdown(text, cards, emojis, mentions) {
  const src = typeof text === "string" ? text : String(text == null ? "" : text);
  let sig = cards ? "c" : "-";
  if (src.includes("<")) {
    // Read as renderMarkdown reads it: it drops NUL first (its placeholder mark), so "<@\0id>" is a mention there too.
    const seen = src.includes("\u0000") ? src.replace(/\u0000/g, "") : src;
    for (const m of seen.matchAll(EMOJI_IDS)) sig += `|e${m[1]}${emojis && emojis(m[1]) ? 1 : 0}`;
    for (const m of seen.matchAll(MENTION_IDS)) { const name = mentions ? mentions(MENTION_KINDS[m[1]], m[2]) : null; sig += `|m${m[1]}${m[2]}=${typeof name === "string" ? name.length + ":" + name : "-"}`; }
  }
  const key = `${sig}\u0000${src}`;
  let html = mdCache.get(key);
  if (html === undefined) html = R().renderMarkdown(src, { htmlCards: cards, emojis, mentions });
  else mdCache.delete(key);
  mdCache.set(key, html);
  while (mdCache.size > MD_CACHE_MAX) mdCache.delete(mdCache.keys().next().value);
  return html;
}
/** Tests only: forget every rendered Markdown. */
export function clearRenderedMarkdown() { mdCache.clear(); }

/**
 * Bind a renderer to `list` (the thread element) inside `scroller`. opts: { t, tf, isUser(x), onJump({show, unseen}),
 * setPreviewOptIn(on), copyText(text) → Promise<boolean>, download(code), panel? }. panel (#1481): { shown() → the card
 * key the side panel shows, or null; open(spec, { run }); version(); claim(); claims() } — without it a card has no "Open in panel".
 */
export function createThread(list, scroller, opts) {
  const nodes = new Map();          // key → { html, node }
  // A server emoji's picture that does not load reads `:name:` (its alt) instead of an empty box (error does not bubble:
  // caught on the way down).
  list.addEventListener("error", (e) => {
    const img = e.target;
    if (!img || img.tagName !== "IMG" || !img.classList || !img.classList.contains("emoji")) return;
    const span = list.ownerDocument.createElement("span");
    span.className = "emoji-text";
    span.textContent = img.getAttribute("alt") || "";
    span.title = img.getAttribute("title") || span.textContent;
    img.replaceWith(span);
  }, true);
  let msgs = [];
  let unseen = 0;
  // The reader is at the newest message. While pinned, content that grows after it was drawn — an image loading, a
  // preview card, the composer growing — keeps the view at the bottom (#1269); a reader who scrolled up is never moved.
  // Only a move UP unpins: the browser's own scroll anchoring also fires scroll events when content grows (the view
  // moves down or stays), and those must not count as the reader leaving the bottom. Reaching the bottom pins again.
  let pinned = true;
  // Where the view was (and how tall it was) at the last scroll the page saw or made: a move up from there unpins.
  let lastTop = 0, lastView = 0;
  const mark = () => { lastTop = scroller.scrollTop; lastView = scroller.clientHeight; };
  // The oldest message drawn (by key): everything after it is drawn, so new messages never push the window. Null: none
  // drawn yet — the next render draws the newest THREAD_TAIL and the rest follows (grow).
  let firstKey = null;
  let growTimer = null, growFrame = null, disposed = false, parked = false;
  const cardRefresh = new WeakMap(); // card node → re-read availability (weak: a card that left takes its source with it)
  const cardDrop = new WeakMap();    // card node → drop the HTML read it is waiting on (the chat left: park)
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
  let offDay = null, trialTimer = null;
  function armDay() {
    if (nodes.size && !offDay) offDay = onDayChange(() => { for (const v of nodes.values()) timeLabel(v.node); });
    else if (!nodes.size && offDay) { offDay(); offDay = null; }
  }

  const TICKS = () => ({ queued: tr("chat.tick_queued"), processing: tr("chat.tick_processing"), delivered: tr("chat.tick_delivered"), failed: tr("chat.tick_failed"), cancelled: tr("chat.tick_cancelled") });

  function msgHtml(x) {
    // #1770: the label ("17:38", "Yesterday 17:38", "10/11 17:38") depends on today, so it is not part of the html a node
    // is kept by: it is written into the node (timeLabels) — crossing midnight relabels in place and reloads no preview.
    const time = x.ts ? `<span class="time" data-ts="${escAttr(x.ts)}" title="${escAttr(chatTimeFull(x.ts))}"></span>` : `<span class="time"></span>`;
    const trial = effectTrialMessage(x);
    if (trial) return trialHtml(trial, time, x);
    if (x.role === "status") return statusHtml(x, time);
    const u = opts.isUser(x);
    // renderMarkdown escapes the whole text before it adds any tag of its own (chat-render.js).
    const ticks = u && x.delivery ? R().deliveryHtml(x.delivery, TICKS()) : "";
    const tools = u ? "" : `<div data-trust="thread-control" class="msg-tools"><button type="button" class="chip-btn icon-only" data-act="copyMsg" data-arg="${escAttr(msgKey(x))}" title="${escAttr(tr("chat.copyMessage"))}" aria-label="${escAttr(tr("chat.copyMessage"))}">${COPY}</button></div>`;
    const buttons = x.role === "agent" ? replyButtonsHtml(x.buttons) : "";
    // A person's click on a reply button shows as the button's label, never the line the agent was given (its value).
    const clicked = x.role === "user" && x.click && typeof x.click.label === "string";
    // #2272: reply to it — a hover strip at its top right (phones: swipe left or long-press; R on a focused message).
    const key = msgKey(x);
    const act = opts.canReply?.() === false ? "" : `<div data-trust="thread-control" class="msg-actions"><button type="button" class="chip-btn icon-only" data-act="reply" data-arg="${escAttr(key)}" title="${escAttr(tr("chat.reply"))}" aria-label="${escAttr(tr("chat.reply"))}">${REPLY}</button></div>`;
    return `<div class="msg ${u ? "user" : "agent"}" data-key="${escAttr(key)}" tabindex="-1">${act}<div class="meta"><span class="sender">${escAttr(x.sender)}</span>${time}${ticks}</div>${quoteHtml(x.replyTo)}<div class="body">${clicked ? clickHtml(x.click) : `<div class="md">${renderedMarkdown(x.text, x.role === "agent", opts.emojis, opts.mentions)}</div>`}${R().attachmentsHtml(x.attachments, { htmlCards: x.role === "agent", goneTitle: tr("chat.attGone"), goneLabel: tr("chat.attUnavailable"), inlinePreviews: !PUBLIC_LINK() })}${buttons}</div>${R().reactionsHtml(x.reactions, tr("chat.reactedBy", x.instance || ""))}${tools}</div>`;
  }
  /**
   * #2272: what a reply quotes, above its body — the quoted sender and first words (or that it had files), as the server
   * read them when it was sent; a button that shows that message. A guest that may not see it gets only "an earlier
   * message". Text only: everything is escaped.
   */
  function quoteHtml(q) {
    if (!q || typeof q !== "object" || typeof q.boot !== "string" || typeof q.id !== "number") return "";
    const words = q.hidden ? tr("chat.replyHidden")
      : (typeof q.text === "string" && q.text) || (q.media === "photo" ? tr("chat.replyPhoto") : q.media === "document" ? tr("chat.replyFile") : "");
    const who = !q.hidden && typeof q.sender === "string" && q.sender ? `<span class="quote-sender">${escAttr(q.sender)}</span> ` : "";
    return `<button type="button" data-trust="thread-control" class="msg-quote" data-act="jumpQuote" data-arg="${escAttr(`${q.boot}-${q.id}`)}" title="${escAttr(tr("chat.replyJump"))}"><span class="quote-mark">${REPLY}</span> ${who}<span class="quote-text">${escAttr(words)}</span></button>`;
  }
  /**
   * A button click as a chip: 🔘 and the label (escaped: the label is the agent's text). With `of` (live, while its
   * reply is in this thread) it is a button that shows that reply; restored from disk, plain.
   */
  function clickHtml(click) {
    const inner = `<span class="click-mark" aria-hidden="true">🔘</span><span class="sr-only">${escAttr(tr("chat.clicked"))} </span>${escAttr(click.label)}`;
    const of = typeof click.of === "string" && /^[0-9a-f]{32}$/.test(click.of) ? click.of : null;
    return `<div class="click-chip" data-trust="thread-control">${of
      ? `<button type="button" class="click-link" data-act="showButtons" data-arg="${escAttr(of)}" title="${escAttr(tr("chat.clickShow"))}">${inner}</button>`
      : `<span class="click-text">${inner}</span>`}</div>`;
  }
  function trialNow() { try { const t = opts.serverNow ? opts.serverNow() : Date.now(); return Number.isFinite(t) ? t : Infinity; } catch { return Infinity; } }
  const trialReasons = new Set(["checking", "localAdmin", "chatChanged", "busy", "safe", "effectsOff", "reducedMotion", "saveData", "unsupported", "transport", "inactive", "dialog", "expired"]);
  function trialStatus(message) {
    const reason = opts.effectTrialStatus?.(message);
    return reason === "ready" || trialReasons.has(reason) ? reason : opts.canTryEffect?.(message) === true ? "ready" : "localAdmin";
  }
  function trialHtml(offer, time, message) {
    const reason = trialNow() >= offer.expiresAt ? "expired" : PUBLIC_LINK() ? "localAdmin" : trialStatus(message);
    const rawFailure = opts.effectTrialFailure?.(message), failure = typeof rawFailure === "string" ? rawFailure.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80) : null;
    const available = reason === "ready", fix = !PUBLIC_LINK() && !available && reason !== "expired" && reason !== "checking" && typeof opts.fixEffectTrial === "function";
    const label = available ? "chat.effectTrialStart" : reason === "busy" ? "chat.effectTrialStopOther" : reason === "localAdmin" ? "chat.effectTrialSignIn" : reason === "reducedMotion" ? "chat.effectTrialPlayMotion" : "chat.effectTrialSettings";
    const button = available || fix ? `<button type="button" class="btn btn-sm effect-trial-start" data-act="effectTrial" data-arg="${escAttr(msgKey(message))}">${escAttr(tr(label))}</button>` : "";
    return `<div class="msg status-line"><div class="meta">${time}</div><div class="body"><div class="effect-trial-offer" data-trust="thread-control"><strong>${escAttr(tr("chat.effectTrial"))}: ${escAttr(offer.title)}</strong><div>${escAttr(tr(available ? "chat.effectTrialLocal" : "chat.effectTrialReason_" + reason))}</div>${failure ? `<div class="effect-trial-failure" role="status">${escAttr(tr("chat.effectTrialStopped"))}: ${escAttr(failure)}</div>` : ""}${button}</div></div></div>`;
  }
  function armTrials() {
    if (trialTimer !== null) clearTimeout(trialTimer); trialTimer = null;
    const now = trialNow(), next = msgs.map(x => effectTrialMessage(x)).filter(x => x && x.expiresAt > now).reduce((n, x) => Math.min(n, x.expiresAt), Infinity);
    if (Number.isFinite(next)) trialTimer = setTimeout(() => { trialTimer = null; render(msgs); }, Math.max(1, Math.min(2147483647, next - now)));
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
      ? `<button data-trust="thread-control" type="button" class="st-more" data-act="toggleFold"${manyLines ? ` data-lines="${escAttr(lines)}"` : ""}>${escAttr(manyLines ? trf("chat.showAll", lines) : tr("chat.showMore"))}</button>`
      : "";
    const tools = `<div data-trust="thread-control" class="msg-tools"><button type="button" class="chip-btn icon-only" data-act="copyMsg" data-arg="${escAttr(msgKey(x))}" title="${escAttr(tr("chat.copyMessage"))}" aria-label="${escAttr(tr("chat.copyMessage"))}">${COPY}</button></div>`;
    // #1990: the other instance's name opens its chat (an in-app link the router takes: no target).
    const body = textLinkSegments(text, x.links).map(sg => sg.href ? `<a data-trust="link" class="st-link" href="${escAttr(sg.href)}">${escAttr(sg.text)}</a>` : escAttr(sg.text)).join("");
    return `<div class="msg status-line${more ? " folded" : ""}"><div class="meta">${time}</div><div class="body"><div class="st-text">${body}</div>${more}</div>${tools}</div>`;
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
    return `<div data-trust="reply" class="rb-row" role="group" aria-label="${escAttr(tr("chat.rbGroup"))}">${items}${note ? `<span class="rb-note">${escAttr(note)}</span>` : ""}</div>`;
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
      ? `<ul data-trust="reply" class="poll-voters" aria-label="${escAttr(tr("chat.pollVoters"))}">${b.labels.map((label, i) => `<li>${escAttr(`${label}: ${(p.voters[i] || []).join(", ") || "—"}`)}</li>`).join("")}</ul>`
      : "";
    return `<div data-trust="reply" class="rb-row poll" role="group" aria-label="${escAttr(tr("chat.pollGroup"))}">${items}<span class="rb-note">${status}</span></div>${voters}`;
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
      const head = doc.createElement("div"); head.className = "cb-head"; head.setAttribute("data-trust", "thread-control");
      const lang = doc.createElement("span"); lang.className = "cb-lang"; lang.textContent = pre.dataset.lang || "text";
      const wrap = doc.createElement("button"); wrap.type = "button"; wrap.className = "chip-btn"; wrap.dataset.act = "toggleWrap"; wrap.textContent = tr("chat.wrap");
      const copy = doc.createElement("button"); copy.type = "button"; copy.className = "chip-btn"; copy.dataset.act = "copyCode"; copy.textContent = tr("chat.copy");
      head.append(lang, wrap, copy);
      pre.replaceWith(box); box.append(head, pre);
      const lines = R().lineCount(pre.textContent);
      if (lines > R().CODE_FOLD_LINES) {
        box.classList.add("folded");
        const more = doc.createElement("button"); more.type = "button"; more.className = "cb-more"; more.setAttribute("data-trust", "thread-control"); more.dataset.act = "toggleFold";
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
        const note = doc.createElement("div"); note.className = "pv-note"; note.setAttribute("data-trust", "thread-control"); note.textContent = tr("chat.pvTruncated"); ph.append(note);
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
    const head = el("div", "tc-head"); head.setAttribute("data-trust", "thread-control");
    const label = el("span", "tc-label", att.name);
    const show = el("button", "btn btn-sm tc-show", tr("chat.tcShow")); show.type = "button";
    const dl = el("a", "btn btn-sm tc-dl", tr("chat.tcDownload")); dl.href = `/ui/file/${att.id}`; dl.setAttribute("download", att.name);
    head.append(label, show, dl);
    const note = el("div", "pv-note"); note.setAttribute("data-trust", "thread-control");
    const body = el("div", "tc-body"); body.hidden = true;
    ph.append(head, note, body);
    let text = null, reading = 0, reads = 0, all = false;
    const draw = () => {
      body.textContent = "";
      const lines = text.split(/\r?\n/);
      const cut = !all && lines.length > TEXT_PREVIEW_LINES;
      const shown = cut ? lines.slice(0, TEXT_PREVIEW_LINES) : lines;
      const src = shown.join("\n");
      // Formatting is built only within TEXT_PREVIEW_NODES: the markup is measured as a string first, never as DOM.
      const plain = () => {
        const pre = el("pre", "tc-pre"), code = el("code", null, src);
        const note = el("div", "pv-note", tr("chat.tcPlain")); note.setAttribute("data-trust", "thread-control");
        pre.append(code); body.append(note, pre);
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
        const more = el("button", "btn btn-sm tc-more", trf("chat.tcShowAll", lines.length)); more.setAttribute("data-trust", "thread-control"); more.type = "button";
        more.onclick = () => { all = true; draw(); };
        body.append(more);
      }
    };
    // #2053: as an HTML card's read (cardDrop), one still waiting when the chat left is dropped, the card not left Loading.
    cardDrop.set(ph, () => { if (reading) { reading = 0; note.textContent = ""; } });
    show.onclick = async () => {
      if (reading) return;
      if (text !== null) { body.hidden = !body.hidden; show.textContent = tr(body.hidden ? "chat.tcShow" : "chat.tcHide"); return; }
      const mine = reading = ++reads; note.textContent = tr("chat.pvLoading");
      const r = await loadHtmlAttachment({ id: att.id, name: att.name, size: att.size });
      if (reading !== mine) return;                      // dropped (its chat left meanwhile): a new click reads again
      reading = 0;
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
    const head = el("div", "pv-head"); head.setAttribute("data-trust", "thread-control");
    const label = el("span", "pv-label", att ? `${tr("chat.pvHtml")} · ${att.name}` : tr("chat.pvHtml"));
    const run = el("button", "btn btn-sm pv-run", tr("chat.pvPreview")); run.type = "button";
    const stopB = el("button", "btn btn-sm pv-stop", tr("chat.pvStop")); stopB.type = "button"; stopB.hidden = true;
    // An attachment already has its download link (the file itself) right above the card.
    const dl = att ? null : el("button", "btn btn-sm btn-ghost pv-dl", tr("chat.pvDownload"));
    if (dl) dl.type = "button";
    const panel = opts.panel || null;
    const toPanel = panel ? el("button", "btn btn-sm btn-ghost pv-open", tr("chat.pvOpenPanel")) : null;
    if (toPanel) toPanel.type = "button";
    const menu = el("details", "pv-menu"); menu.setAttribute("data-trust", "preview-menu");
    const sum = el("summary", null, "⋯"); sum.title = tr("chat.pvMenu"); sum.setAttribute("aria-label", tr("chat.pvMenu"));
    const optB = el("button", "chip-btn pv-opt"); optB.type = "button";
    const neverB = el("button", "chip-btn pv-never"); neverB.type = "button";
    menu.append(sum, optB, neverB);
    head.append(label, run, stopB, ...(toPanel ? [toPanel] : []), ...(dl ? [dl] : []), menu);
    const note = el("div", "pv-note"); note.setAttribute("data-trust", "thread-control");
    // #1568: the banner, with its "I understand" (hidden until the next sign-in; the frame's border stays).
    const banner = el("div", "pv-banner"); banner.setAttribute("data-trust", "thread-control"); banner.hidden = true;
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
    // #2053: a kept card is shown again later. A read still waiting when its chat left is dropped then: its answer —
    // whenever it comes — starts nothing (no preview, no panel without a new click), and the card is not left Loading
    // (shown again, it is refreshed: refreshCards).
    cardDrop.set(ph, () => { reading = 0; });
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
  function toBottom() { snap(); scroller.scrollTop = scroller.scrollHeight; pinned = true; mark(); }
  /**
   * #2184: a thread's height is rarely a whole number of pixels, and a pinned view's offset is: so each time older messages
   * were drawn above, the whole view moved by the change in that fraction (0.6–0.7 px — the faint jitter of a chat
   * opened cold). A sub-pixel margin above the list keeps the thread's height whole, so the bottom never moves.
   */
  // #2188: one read (the list's box excludes its own margin, so nothing is reset first) and a write only on a change —
  // a reset-then-measure laid a 200-message thread out twice on every pinned draw (2.3 s at 4× CPU on a kept chat).
  let snapped = null;
  function snap() {
    const h = list.getBoundingClientRect().height, f = h - Math.floor(h);
    const want = f > 0.001 && f < 0.999 ? (1 - f) + "px" : "0px";
    if (want !== snapped) { snapped = want; list.style.setProperty("--thread-snap", want); }
  }
  // Sizes change without a scroll event (layout after the render, the dock under the thread): while pinned, the view
  // stays flush with the bottom; a reader who scrolled up is never moved.
  const resized = () => { if (pinned && !atBottom()) toBottom(); reportJump(); };
  let ro = typeof ResizeObserver === "function" ? new ResizeObserver(resized) : null;
  if (ro) { ro.observe(list); ro.observe(scroller); }
  // #2158: the reader's own hand on the thread — a wheel, a touch, the scrollbar (a pointer held), a scrolling key
  // outside a text field — and the scroll that follows it until it has been quiet READER_QUIET_MS.
  let inputAt = -Infinity, held = false;
  const touched = () => { inputAt = performance.now(); };
  const hold = (on) => () => { held = on; touched(); };
  const onKey = (ev) => {
    const el = ev.target;
    if (SCROLL_KEYS.has(ev.key) && !(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || "")))) touched();
  };
  const onScroller = [["wheel", touched], ["touchstart", hold(true)], ["touchend", hold(false)], ["touchcancel", hold(false)], ["pointerdown", hold(true)]];
  const onDocument = [["pointerup", hold(false)], ["pointercancel", hold(false)], ["keydown", onKey]];
  /** Listen for the reader's input on `sc` (and its document: a pointer let go anywhere, a key), or stop. */
  function watchReader(sc, on) {
    const doc = sc.ownerDocument, how = on ? "addEventListener" : "removeEventListener";
    for (const [type, fn] of onScroller) sc[how](type, fn, { passive: true });
    if (doc) for (const [type, fn] of onDocument) doc[how](type, fn, true);
    if (!on) held = false;
  }
  const readerActive = () => held || performance.now() - inputAt < READER_QUIET_MS;
  watchReader(scroller, true);

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
    if (disposed || parked) return;       // the chat left: nothing more is drawn (a kept one fills in when shown again)
    const at = startIndex();
    if (at <= 0) return;
    firstKey = msgKey(msgs[Math.max(0, at - THREAD_CHUNK)]);
    const fromBottom = scroller.scrollHeight - scroller.scrollTop;
    draw({ older: true });                // drawn above the reader: never "new below" (render alone counts those)
    if (pinned) toBottom();
    else { scroller.scrollTop = scroller.scrollHeight - fromBottom; mark(); }
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
    armTrials();
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
      else { scroller.scrollTop = renderOpts.restore; pinned = nearBottom(); mark(); }
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
        have = { html, node, x, trialButton: node.querySelector(".effect-trial-offer > button.effect-trial-start") }; nodes.set(key, have);
      } else { have.x = x; timeLabel(have.node); }
      const want = prev ? prev.nextSibling : list.firstChild;
      // A node already in the list is being moved: its preview stops first. A new node (still in its template) has none.
      if (have.node !== want) { if (have.node.parentNode === list) stopIn(have.node); list.insertBefore(have.node, want); }
      prev = have.node;
    }
    armDay();
    armPolls();
    rove();
    return added;
  }
  /**
   * #2272 (review): one message in the thread is in the Tab order — the last one focused while it is still drawn, else
   * the newest; ↑/↓ move between messages (chat-msg-actions.js). The rest are -1, so Tab passes the thread in one step.
   */
  let roving = null;
  function rove(key) {
    if (key !== undefined) roving = key;
    const at = (roving && nodes.has(roving) ? nodes.get(roving).node : null) || [...list.querySelectorAll(".msg[data-key]")].at(-1) || null;
    for (const el of list.querySelectorAll('.msg[data-key][tabindex="0"]')) if (el !== at) el.setAttribute("tabindex", "-1");
    if (at) at.setAttribute("tabindex", "0");
  }

  function onScroll() {
    // #2158: the thread got shorter under a pinned view (text settling on a cold load, a card) and the browser clamped
    // scrollTop to its new end — for the view as tall as it was then; the view got shorter too before WebKit sent that
    // clamp's scroll event (it comes before the ResizeObserver). A view resting exactly at the bottom of the view as it
    // was at the last mark, with no hand of the reader's on the thread, was put there by the browser: still pinned, back
    // at the bottom. Geometry alone can't tell (a reader's move up by the dock's growth lands there too): any input of
    // theirs, and the scroll after it, is theirs and unpins as before. The page's own scrolls (reveal) have no input but
    // don't land there.
    const reader = readerActive();
    if (reader) touched();                // the reader's scroll goes on (smooth, momentum): still theirs while it does
    else if (pinned && !atBottom() && Math.abs(scroller.scrollHeight - lastView - scroller.scrollTop) <= 1) toBottom();
    const bottom = nearBottom(), top = scroller.scrollTop;
    // #2087: pinned only at the exact bottom — a reader still wheeling through the last 48 px was pinned there, so
    // the next resize (a picture, a card, the dock) pulled the view the rest of the way down under them. Near the bottom
    // still counts for a new message (render follows it) and for the pill; nothing else moves a view the reader moves.
    if (atBottom()) pinned = true;
    else if (top < lastTop) pinned = false;
    mark();
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
    } else if (act === "effectTrial") {
      // Only the current host-produced keyed card and a real local click can request admission. No token is read from DOM.
      const key = el.dataset.arg, row = msgs.find(x => msgKey(x) === key), owner = nodes.get(key), node = owner?.node, offer = effectTrialMessage(row);
      if (PUBLIC_LINK() || e.defaultPrevented || e.isTrusted !== true || owner?.trialButton !== el || el.className !== "btn btn-sm effect-trial-start" || !node?.contains(el) || el.closest(".effect-trial-offer")?.getAttribute("data-trust") !== "thread-control"
        || !offer || trialNow() >= offer.expiresAt) return;
      if (trialStatus(row) === "ready" && opts.canTryEffect?.(row) === true) opts.startEffectTrial?.(row);
      else opts.fixEffectTrial?.(row, trialStatus(row));
    } else if (act === "showButtons") { const x = msgs.find(y => y.buttons && y.buttons.id === el.dataset.arg); if (x) reveal(msgKey(x)); }
    else if (act === "reply") { const x = msgs.find(y => msgKey(y) === el.dataset.arg); if (x) opts.startReply?.(x); }
    else if (act === "jumpQuote") void jumpTo(el.dataset.arg);
  }
  /**
   * #2272: show the message a reply quotes, flashed — drawn now, or after the chat reads back the longest history the
   * server keeps; otherwise it says it is no longer there.
   */
  async function jumpTo(key) {
    if (typeof key !== "string" || !key) return;
    if (reveal(key)) return;
    const found = opts.findQuoted ? await opts.findQuoted(key) : false;
    if (!found || !reveal(key)) opts.notice?.(tr("chat.replyGone"));
  }
  /** #2272: a drawn message's row (for the message menu and gestures), or undefined. */
  function messageOf(key) { return msgs.find(y => msgKey(y) === key); }

  /** The thread goes (the chat left, or another instance opened): every preview in it stops first. */
  /**
   * #2053: kept for a later visit — the chat left as it always did (every preview stops: "leave"), but its drawn nodes
   * stay. Nothing of it runs meanwhile: no timer (day labels, polls, effect trials, filling in), no size observer; the
   * caller drops its subscriptions. Shown again: attach, then render — only what changed is drawn.
   */
  function park() {
    parked = true;
    watchReader(scroller, false);
    if (P()) P().stopAll("leave");
    for (const node of list.querySelectorAll(".html-card[data-att], .text-card[data-att]")) { const f = cardDrop.get(node); if (f) f(); }
    if (ro) { ro.disconnect(); ro = null; }
    if (trialTimer !== null) clearTimeout(trialTimer); trialTimer = null;
    if (growFrame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(growFrame);
    if (growTimer !== null) clearTimeout(growTimer);
    growTimer = growFrame = null;
    if (offDay) { offDay(); offDay = null; }
    if (pollTick) { clearInterval(pollTick); pollTick = null; }
  }
  /** In view in `sc` (the view's scroller): sizes watched there from now on; the caller restores the position. */
  function attach(sc) {
    if (!parked) watchReader(scroller, false);   // moved from the scroller it was made with
    parked = false;
    scroller = sc;
    watchReader(sc, true);
    if (ro) ro.disconnect();
    ro = typeof ResizeObserver === "function" ? new ResizeObserver(resized) : null;
    if (ro) { ro.observe(list); ro.observe(sc); }
  }
  /** `own`: only this thread's previews stop (a thread let go while another chat is in view); else every one, as leaving. */
  function dispose(own = false) {
    disposed = true;
    if (!parked) watchReader(scroller, false);
    if (trialTimer !== null) clearTimeout(trialTimer); trialTimer = null;
    if (ro) ro.disconnect();
    if (P()) { if (own) P().stopIn(list); else P().stopAll("leave"); }
    nodes.clear();
    armDay();
    armPolls();
  }

  return { render, onScroll, onClick, jumpLatest, reveal, jumpTo, messageOf, rove, refreshCards, park, attach, dispose, nodes, get unseen() { return unseen; } };
}
