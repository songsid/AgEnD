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

const R = () => globalThis.AgendChatRender;
const P = () => globalThis.AgendPreview;
const COPY = '<svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

/** Escapes & " ' < >: safe for text and inside a quoted attribute. */
export function escAttr(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
export const msgKey = (x) => `${x.boot}-${x.id}`;

/**
 * Bind a renderer to `list` (the thread element) inside `scroller`. opts: { t, tf, isUser(x), onJump({show, unseen}),
 * setPreviewOptIn(on), copyText(text) → Promise<boolean>, download(code) }.
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
  const cardRefresh = new WeakMap(); // card node → re-read availability (weak: a card that left takes its source with it)
  const tr = opts.t, trf = opts.tf;
  const stopIn = (node) => (P() ? P().stopIn(node) : []);

  const TICKS = () => ({ queued: tr("chat.tick_queued"), processing: tr("chat.tick_processing"), delivered: tr("chat.tick_delivered"), failed: tr("chat.tick_failed"), cancelled: tr("chat.tick_cancelled") });

  function msgHtml(x) {
    const u = opts.isUser(x);
    const time = x.ts ? new Date(x.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    // renderMarkdown escapes the whole text before it adds any tag of its own (chat-render.js).
    const ticks = u && x.delivery ? R().deliveryHtml(x.delivery, TICKS()) : "";
    const tools = u ? "" : `<div class="msg-tools"><button type="button" class="chip-btn icon-only" data-act="copyMsg" data-arg="${escAttr(msgKey(x))}" title="${escAttr(tr("chat.copyMessage"))}" aria-label="${escAttr(tr("chat.copyMessage"))}">${COPY}</button></div>`;
    return `<div class="msg ${u ? "user" : "agent"}"><div class="meta"><span class="sender">${escAttr(x.sender)}</span><span class="time">${time}</span>${ticks}</div><div class="body"><div class="md">${R().renderMarkdown(x.text, x.role === "agent" ? { htmlCards: true } : undefined)}</div>${R().attachmentsHtml(x.attachments)}</div>${tools}</div>`;
  }
  function msgNode(html, x, stoppedKeys) {
    const tpl = list.ownerDocument.createElement("template");
    tpl.innerHTML = html;
    const node = tpl.content.firstElementChild;
    decorateCode(node);
    if (x) decorateHtmlCards(node, x, stoppedKeys || []);
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

  // HTML cards (#1306): each ```html fence of a server-marked agent message gets a card under its code block. Building
  // a card makes no frame; Preview does (AgendPreview.start → mountPreview).
  function decorateHtmlCards(node, x, stoppedKeys) {
    const doc = list.ownerDocument;
    const fences = R().htmlFences(x.text);
    for (const ph of node.querySelectorAll(".html-card[data-card]")) {
      const n = Number(ph.dataset.card), fence = fences[n];
      if (!fence) continue;
      const key = `${msgKey(x)}:f${n}`;
      ph.textContent = "";
      if (ph.classList.contains("truncated") || !fence.terminated) {
        const note = doc.createElement("div"); note.className = "pv-note"; note.textContent = tr("chat.pvTruncated"); ph.append(note);
        continue;
      }
      const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
      const head = el("div", "pv-head");
      const label = el("span", "pv-label", tr("chat.pvHtml"));
      const run = el("button", "btn btn-sm pv-run", tr("chat.pvPreview")); run.type = "button";
      const stopB = el("button", "btn btn-sm pv-stop", tr("chat.pvStop")); stopB.type = "button"; stopB.hidden = true;
      const dl = el("button", "btn btn-sm btn-ghost pv-dl", tr("chat.pvDownload")); dl.type = "button";
      const menu = el("details", "pv-menu");
      const sum = el("summary", null, "⋯"); sum.title = tr("chat.pvMenu"); sum.setAttribute("aria-label", tr("chat.pvMenu"));
      const optB = el("button", "chip-btn pv-opt"); optB.type = "button";
      const neverB = el("button", "chip-btn pv-never"); neverB.type = "button";
      menu.append(sum, optB, neverB);
      head.append(label, run, stopB, dl, menu);
      const note = el("div", "pv-note");
      const banner = el("div", "pv-banner", P().BANNER); banner.hidden = true;
      const holder = el("div", "pv-holder");
      ph.append(head, note, banner, holder);
      let state = "idle";
      const refresh = (reason) => {
        const a = P().availability();
        const going = state === "starting" || state === "running";
        run.hidden = !a.ok || going;
        stopB.hidden = !going;
        banner.hidden = !going;
        note.textContent = reason != null ? reason : going ? (state === "starting" ? tr("chat.pvStarting") : "") : a.ok ? "" : a.reason;
        optB.textContent = P().optedIn() ? tr("chat.pvDisallow") : tr("chat.pvAllow");
        neverB.textContent = P().never() ? tr("chat.pvNeverUndo") : tr("chat.pvNever");
      };
      const ui = { state: (name, reason) => { state = name === "starting" || name === "running" ? name : "idle"; refresh(reason || null); } };
      run.onclick = () => P().start(key, holder, fence.code, ui);
      stopB.onclick = () => P().stop(key, "stopped", "");
      dl.onclick = () => opts.download(fence.code);
      optB.onclick = () => { menu.open = false; opts.setPreviewOptIn(!P().optedIn()); };
      neverB.onclick = () => { menu.open = false; P().setNever(!P().never()); refreshCards(); };
      cardRefresh.set(ph, refresh);
      refresh(stoppedKeys.includes(key) ? tr("chat.pvChanged") : null);
    }
  }
  /** Re-read this device's preview choice on every card in this thread. */
  function refreshCards() {
    for (const node of list.querySelectorAll(".html-card[data-card]")) { const f = cardRefresh.get(node); if (f) f(); }
  }

  const nearBottom = () => R().isNearBottom(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight);
  function reportJump() { opts.onJump({ show: !nearBottom(), unseen }); }
  function toBottom() { scroller.scrollTop = scroller.scrollHeight; pinned = true; lastTop = scroller.scrollTop; }
  // Sizes change without a scroll event (layout after the render): follow them while pinned.
  const resized = () => { if (pinned && !nearBottom()) toBottom(); reportJump(); };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resized) : null;
  if (ro) { ro.observe(list); ro.observe(scroller); }

  /** Draw `next` (this instance's messages). `restore`: the scroll position to return to (null = the bottom). */
  function render(next, renderOpts = {}) {
    const stick = pinned || nearBottom();
    msgs = next || [];
    if (!msgs.length) {
      for (const v of nodes.values()) stopIn(v.node);
      nodes.clear();
      list.textContent = "";
      opts.onEmpty(true);
      return;
    }
    opts.onEmpty(false);
    const keep = new Set(msgs.map(msgKey));
    for (const [k, v] of nodes) if (!keep.has(k)) { stopIn(v.node); v.node.remove(); nodes.delete(k); }
    let prev = null, added = 0;
    for (const x of msgs) {
      const key = msgKey(x), html = msgHtml(x);
      let have = nodes.get(key);
      if (!have || have.html !== html) {
        const stopped = have ? stopIn(have.node) : [];
        const node = msgNode(html, x, stopped);
        if (have) have.node.replaceWith(node); else added++;
        have = { html, node }; nodes.set(key, have);
      }
      const want = prev ? prev.nextSibling : list.firstChild;
      // A node already in the list is being moved: its preview stops first. A new node (still in its template) has none.
      if (have.node !== want) { if (have.node.parentNode === list) stopIn(have.node); list.insertBefore(have.node, want); }
      prev = have.node;
    }
    if ("restore" in renderOpts) {
      unseen = 0;
      if (renderOpts.restore == null) toBottom();
      else { scroller.scrollTop = renderOpts.restore; pinned = nearBottom(); lastTop = scroller.scrollTop; }
    } else if (stick) toBottom();
    else unseen += added;
    reportJump();
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
  /** The thread's own buttons (Copy, Wrap, fold), delegated from the thread element. */
  function onClick(e) {
    const el = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!el || !list.contains(el)) return;
    const act = el.dataset.act;
    if (act === "copyMsg") { const x = msgs.find(y => msgKey(y) === el.dataset.arg); if (x) copyFrom(el, x.text); }
    else if (act === "copyCode") { const pre = el.closest(".codeblock")?.querySelector("pre"); if (pre) copyFrom(el, pre.textContent); }
    else if (act === "toggleFold") {
      const box = el.closest(".codeblock"); if (!box) return;
      const folded = box.classList.toggle("folded");
      el.textContent = folded ? trf("chat.showAll", el.dataset.lines) : tr("chat.showLess");
    } else if (act === "toggleWrap") opts.toggleWrap();
  }

  /** The thread goes (the chat left, or another instance opened): every preview in it stops first. */
  function dispose() {
    if (ro) ro.disconnect();
    if (P()) P().stopAll("leave");
    nodes.clear();
  }

  return { render, onScroll, onClick, jumpLatest, refreshCards, dispose, nodes, get unseen() { return unseen; } };
}
