// #2272: a chat message's own actions, beyond the hover strip — the message menu (right-click, long-press on a phone),
// swipe left to reply (as in Telegram), and R on a focused message. One install per thread element.
//
// - Right-click on a message opens Reply / Copy text / Copy link. Shift+right-click, a right-click with text selected,
//   or one on a link, an image or a field keeps the browser's own menu.
// - A long press (500 ms without moving) opens the same menu; the click and the browser menu it would also cause are
//   swallowed. M-2789 (the leader's ruling A, "text wins on text"): a long press on a message's WORDS, or one when a
//   selection has already started inside the message, is the browser's — it selects text (then the 「引用」 pill,
//   chat-quote.js); the menu still opens from a long press anywhere else on the message (its padding, header, an empty
//   part of the bubble). Android starts its selection only after contextmenu's own default, so the press's place
//   decides, not only a selection already made. Native long-press selection can't be shown headless: confirmed on a
//   real phone before a beta.
// - Swipe left on a message: it follows the finger (up to 64 px); let go past 56 px and it is a reply. A mostly
//   vertical move is scrolling, never a reply. A swipe right is the phone drawer's (app-swipe.js), on a message too: the
//   two never fight.
// - R (no modifier) on a focused message replies; ↑/↓ move to the message before or after (one message is in the Tab
//   order); Escape closes the menu.

const LONG_PRESS_MS = 500, MOVE_TOLERANCE = 10, SWIPE_REPLY_PX = 56, SWIPE_MAX_PX = 64;
/** How long after a touch on a message's words its contextmenu is still that press's (the browser's selection). */
const WORDS_PRESS_MS = 1500;
const clock = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

/**
 * On a message's own words: the press at (x, y) lands on a glyph of its rendered text — not on the blank part of a
 * line, its padding, its header or its action strip (a paragraph's box is wider than a short line's glyphs: #3555
 * review P2-2). The browser's own hit test (caretPositionFromPoint / caretRangeFromPoint), then the glyph's box
 * beside that caret; without either API, not words (the menu, as before).
 */
const GLYPH_SLACK = 2;
function onWords(target, x, y, doc) {
  const e = target && (target.nodeType === 1 ? target : target.parentElement);
  const md = e && e.closest ? e.closest(".msg[data-key] .md") : null;
  if (!md || e.closest(".meta, .msg-actions") || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  let node = null, offset = 0;
  if (typeof doc.caretPositionFromPoint === "function") { const p = doc.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; offset = p.offset; } }
  else if (typeof doc.caretRangeFromPoint === "function") { const r = doc.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; offset = r.startOffset; } }
  if (!node || node.nodeType !== 3 || !md.contains(node) || typeof doc.createRange !== "function") return false;
  // The caret sits between two characters: the press is on words when the glyph before or after it holds the point.
  for (const at of [offset - 1, offset]) {
    if (at < 0 || at >= node.data.length || !node.data[at].trim()) continue;
    const rg = doc.createRange(); rg.setStart(node, at); rg.setEnd(node, at + 1);
    for (const b of rg.getClientRects()) {
      if (x >= b.left - GLYPH_SLACK && x <= b.right + GLYPH_SLACK && y >= b.top - GLYPH_SLACK && y <= b.bottom + GLYPH_SLACK) return true;
    }
  }
  return false;
}
/** A selection already started inside `el` (a message): the browser's, never ours. */
function selectionIn(el, doc) {
  const sel = doc.getSelection ? doc.getSelection() : null;
  if (!sel || sel.isCollapsed || !String(sel).trim()) return false;
  return !!((sel.anchorNode && el.contains(sel.anchorNode)) || (sel.focusNode && el.contains(sel.focusNode)));
}
/** The message element an event is on (a person's or an agent's message of this thread), or null. */
function messageEl(list, target) {
  const el = target && target.closest ? target.closest(".msg[data-key]") : null;
  return el && list.contains(el) ? el : null;
}
/** The browser's own menu stays for: Shift, selected text, a link, an image, a field, code. */
function keepsNativeMenu(e, doc) {
  if (e.shiftKey) return true;
  const sel = doc.getSelection ? doc.getSelection() : null;
  if (sel && !sel.isCollapsed && String(sel).trim()) return true;
  return !!(e.target && e.target.closest && e.target.closest("a[href], img, video, input, textarea, select, pre, code, [contenteditable='true']"));
}

/**
 * Install the gestures on `list` (the thread element). `deps`:
 *   messageOf(key) → the row; reply(row); copyText(text) → Promise<boolean>; linkOf(row) → string; notice(text);
 *   canReply() → boolean (false: no Reply — a page that cannot send); t(key).
 * Returns a function that removes everything (and closes an open menu).
 */
export function installMessageActions(list, deps) {
  const doc = list.ownerDocument, win = doc.defaultView;
  let menu = null, press = null, swipe = null, swallowClick = false, wordsPressAt = -Infinity;

  function closeMenu() {
    if (!menu) return;
    menu.remove(); menu = null;
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("keydown", onMenuKey, true);
    win?.removeEventListener("scroll", closeMenu, true);
    win?.removeEventListener("blur", closeMenu);
  }
  function outside(e) { if (menu && !menu.contains(e.target)) closeMenu(); }
  function onMenuKey(e) {
    if (!menu) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...menu.querySelectorAll("button")], i = items.indexOf(doc.activeElement);
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  }
  /** The message menu at (x, y), within the window; focus on its first item. */
  function openMenu(row, x, y) {
    closeMenu();
    const items = [];
    if (deps.canReply?.() !== false) items.push(["reply", deps.t("chat.reply"), () => deps.reply(row)]);
    items.push(["copyText", deps.t("chat.copyText"), async () => { const ok = await deps.copyText(String(row.click?.label ?? row.text ?? "")); deps.notice(deps.t(ok ? "chat.copied" : "chat.copyFailed"), ok); }]);
    items.push(["copyLink", deps.t("chat.copyLink"), async () => { const ok = await deps.copyText(deps.linkOf(row)); deps.notice(deps.t(ok ? "chat.copied" : "chat.copyFailed"), ok); }]);
    menu = doc.createElement("div");
    menu.className = "msg-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", deps.t("chat.msgMenu"));
    menu.setAttribute("data-trust", "menu");
    for (const [id, label, run] of items) {
      const b = doc.createElement("button");
      b.type = "button"; b.className = "menu-item"; b.setAttribute("role", "menuitem"); b.dataset.item = id; b.textContent = label;
      b.addEventListener("click", () => { closeMenu(); void run(); });
      menu.append(b);
    }
    doc.body.append(menu);
    const w = win?.innerWidth ?? 1024, h = win?.innerHeight ?? 768, r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, w - r.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, h - r.height - 4))}px`;
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("keydown", onMenuKey, true);
    win?.addEventListener("scroll", closeMenu, true);
    win?.addEventListener("blur", closeMenu);
    menu.querySelector("button")?.focus();
  }

  function onContextMenu(e) {
    if (swallowClick) { e.preventDefault(); return; }               // the long press already opened ours
    cancelPress();                                                   // Android's long press fires this itself: one menu
    const el = messageEl(list, e.target);
    if (!el || keepsNativeMenu(e, doc)) return;
    // M-2789: a long press on the words (or a selection begun in this message) is the browser's — its selection.
    if (selectionIn(el, doc) || (clock() - wordsPressAt < WORDS_PRESS_MS && onWords(e.target, e.clientX, e.clientY, doc))) return;
    const row = deps.messageOf(el.dataset.key);
    if (!row) return;
    e.preventDefault();
    openMenu(row, e.clientX, e.clientY);
  }
  function onKeyDown(e) {
    // ↑/↓ on a focused message: the one before or after it (one message is in the Tab order: the thread's rove()).
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
      && e.target && e.target.matches && e.target.matches(".msg[data-key]") && list.contains(e.target)) {
      const all = [...list.querySelectorAll(".msg[data-key]")], i = all.indexOf(e.target);
      const to = all[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (to) { e.preventDefault(); deps.rove?.(to.dataset.key); to.focus(); to.scrollIntoView?.({ block: "nearest" }); }
      return;
    }
    if (e.key !== "r" && e.key !== "R") return;
    if (e.ctrlKey || e.metaKey || e.altKey || deps.canReply?.() === false) return;
    const el = e.target && e.target.matches && e.target.matches(".msg[data-key]") && list.contains(e.target) ? e.target : null;
    const row = el ? deps.messageOf(el.dataset.key) : null;
    if (!row) return;
    e.preventDefault();
    deps.reply(row);
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1) { cancelPress(); cancelSwipe(); return; }
    const el = messageEl(list, e.target);
    if (!el) return;
    const t0 = e.touches[0];
    const native = keepsNativeMenu({ target: e.target, shiftKey: false }, doc);   // a link, an image, code: the browser's
    // M-2789: a press on the message's words is the browser's text selection, not our menu (swipe-left Reply stays).
    const words = onWords(e.target, t0.clientX, t0.clientY, doc);
    wordsPressAt = words ? clock() : -Infinity;
    press = native || words ? null : { el, x: t0.clientX, y: t0.clientY, timer: setTimeout(() => {
      const row = deps.messageOf(el.dataset.key);
      press = null;
      if (selectionIn(el, doc)) return;                              // a selection has started here: it stays the browser's
      cancelSwipe();
      if (!row) return;
      swallowClick = true; setTimeout(() => { swallowClick = false; }, 700);
      openMenu(row, t0.clientX, t0.clientY);
    }, LONG_PRESS_MS) };
    swipe = deps.canReply?.() === false || native ? null : { el, x: t0.clientX, y: t0.clientY, dx: 0, locked: null };
  }
  function onTouchMove(e) {
    const p = e.touches[0];
    if (press && (Math.abs(p.clientX - press.x) > MOVE_TOLERANCE || Math.abs(p.clientY - press.y) > MOVE_TOLERANCE)) cancelPress();
    if (!swipe) return;
    const dx = p.clientX - swipe.x, dy = p.clientY - swipe.y;
    if (swipe.locked === null && (Math.abs(dx) > MOVE_TOLERANCE || Math.abs(dy) > MOVE_TOLERANCE)) swipe.locked = dx < 0 && Math.abs(dy) < -dx / 2 ? "x" : "no";
    if (swipe.locked !== "x") return;
    swipe.dx = Math.max(0, Math.min(-dx, SWIPE_MAX_PX));               // how far left, as a positive distance
    swipe.el.style.transform = `translateX(${-swipe.dx}px)`;
    swipe.el.classList.toggle("swipe-ready", swipe.dx >= SWIPE_REPLY_PX);
  }
  function onTouchEnd() {
    cancelPress();
    if (!swipe) return;
    const { el, dx, locked } = swipe;
    cancelSwipe();
    if (locked === "x" && dx >= SWIPE_REPLY_PX) { const row = deps.messageOf(el.dataset.key); if (row) deps.reply(row); }
  }
  function cancelPress() { if (press) { clearTimeout(press.timer); press = null; } }
  function cancelSwipe() {
    if (!swipe) return;
    swipe.el.style.transform = ""; swipe.el.classList.remove("swipe-ready");
    swipe = null;
  }
  function onClickCapture(e) { if (swallowClick) { e.preventDefault(); e.stopPropagation(); } }

  // A message focused by a click or a tap becomes the one Tab comes back to.
  function onFocusIn(e) { const el = e.target && e.target.matches && e.target.matches(".msg[data-key]") ? e.target : null; if (el && list.contains(el)) deps.rove?.(el.dataset.key); }
  list.addEventListener("focusin", onFocusIn);
  list.addEventListener("contextmenu", onContextMenu);
  list.addEventListener("keydown", onKeyDown);
  list.addEventListener("touchstart", onTouchStart, { passive: true });
  list.addEventListener("touchmove", onTouchMove, { passive: true });
  list.addEventListener("touchend", onTouchEnd, { passive: true });
  list.addEventListener("touchcancel", onTouchEnd, { passive: true });
  list.addEventListener("click", onClickCapture, true);
  return () => {
    closeMenu(); cancelPress(); cancelSwipe();
    list.removeEventListener("focusin", onFocusIn);
    list.removeEventListener("contextmenu", onContextMenu);
    list.removeEventListener("keydown", onKeyDown);
    list.removeEventListener("touchstart", onTouchStart);
    list.removeEventListener("touchmove", onTouchMove);
    list.removeEventListener("touchend", onTouchEnd);
    list.removeEventListener("touchcancel", onTouchEnd);
    list.removeEventListener("click", onClickCapture, true);
  };
}
