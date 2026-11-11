// M-2789 (the user, 11-09): answer a long, multi-part message passage by passage. Select text in ONE message of the thread
// → a small 「引用」 pill → the passage goes into the composer as a Markdown quote ("> …") at the caret, on its own lines,
// the caret left on the next line for the answer. Repeatable: quote, answer, quote the next passage, answer…
//
// - Desktop: the pill is anchored to where the selection ends (a pointer at the exact spot), below that line — clear of
//   the browser's own menu above a selection (Edge's mini menu sits there, and a page can't turn it off; M-2872) — and
//   above it only when there is no room below in the thread's visible box. After a quote the composer takes the focus.
// - Phone (a coarse pointer): the pill 「引用選取的文字」 docks above the composer's whole box inside the 16-px gutter — clear
//   of the system's own copy toolbar (above a selection) and of the finger — or at the top of the thread when the
//   passage sits there. The keyboard does NOT open after a quote (the user's choice): more passages can be selected;
//   the composer's own scroller shows the caret and the newest quote.
// - No pill for a selection across messages, outside the thread, or on a page that can't send; no keyboard shortcut
//   (the user's choice). The whole-message Reply (#2272) is unchanged, and so is the browser's menu on selected text.
// - What is sent is the composer's text as typed: the agent reads the "> " lines as written; the web renders them as
//   blockquotes (chat-render.js); Discord's mirror shows them as quotes, Telegram's as the same plain lines.
//
// Its own words and drawing (a page that loaded an older chat-strings.js or ui-icons.js still draws it), CSSOM only
// (no style attribute: #1300), the shared popover look (.msg-menu) with the shared border and shadow tokens.
import { register, t } from "/assets/app-i18n.js";

register("chatQuote", {
  en: { quote: "Quote", quotePhone: "Quote selection", label: "Quote the selected text in your message" },
  "zh-TW": { quote: "引用", quotePhone: "引用選取的文字", label: "把選取的文字引用到你的訊息裡" },
});
const tq = (k) => t(`chatQuote.${k}`);

/**
 * Where the person's caret was in the composer when it last lost the focus — what a quote goes in at. A field's own
 * selectionStart can't be trusted after the page's selection moved into the thread (Chrome resets it), so it is kept
 * here, with the text it belongs to (a caret for another text is no caret).
 */
const remembered = new WeakMap();
export function composerCaret(field, value) {
  if (!field) return value.length;
  const r = remembered.get(field);
  if (r && r.value === value) return r.caret;
  const doc = field.ownerDocument;
  if (doc && doc.activeElement === field && field.value === value) return field.selectionStart ?? value.length;
  return value.length;
}

/** The passage as Markdown quote lines: each line "> line" (an empty one "> " keeps the quote one block). */
export function quoteBlock(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  // A run of empty lines inside the passage becomes one quoted empty line.
  const out = [];
  for (const l of lines) { if (!l.trim() && out.length && out[out.length - 1] === ">") continue; out.push(l.trim() ? `> ${l}` : ">"); }
  return out.join("\n");
}

/**
 * Put the passage into `value` at `caret`, on its own lines: a blank line before it when text precedes on the line or
 * just above, the caret on the line after it (for the answer), and a line break before any text that follows.
 * Returns { value, caret }, or null for a passage with nothing to quote.
 */
export function insertQuote(value, caret, text) {
  const block = quoteBlock(text);
  if (!block) return null;
  const v = String(value ?? "");
  const at = Math.max(0, Math.min(Number.isInteger(caret) ? caret : v.length, v.length));
  const before = v.slice(0, at), after = v.slice(at);
  const lead = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const head = before + lead + block + "\n";
  // Text after the caret starts its own line below the answer's (its leading spaces dropped with the break).
  const tail = after && !after.startsWith("\n") ? "\n" + after.replace(/^[ \t]+/, "") : after;
  return { value: head + tail, caret: head.length };
}

/** The selected passage when it lies inside one message's text of `list`, else null. { text, el, rects }. */
export function selectedPassage(list, sel) {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = String(sel.toString() || "");
  if (!text.trim()) return null;
  const msg = (n) => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return e && e.closest ? e.closest(".msg[data-key]") : null; };
  // The message's own words, not its header (sender, time) or its action strip.
  const inBody = (n) => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return !!(e && e.closest && e.closest(".body, .md") && !e.closest(".meta, .msg-actions")); };
  // Every range of the selection (a browser may keep several: #3555 review P3) in the same message's words — what is
  // quoted is the whole selection's text.
  const range = sel.getRangeAt(0), a = msg(range.startContainer);
  if (!a || !list.contains(a)) return null;
  for (let i = 0; i < sel.rangeCount; i++) {
    const rg = sel.getRangeAt(i);
    if (msg(rg.startContainer) !== a || msg(rg.endContainer) !== a || !inBody(rg.startContainer) || !inBody(rg.endContainer)) return null;
  }
  return { text, el: a, range };
}

/**
 * Where the composer's caret sits, in px from the top of its text (a mirror of the field's text box up to the caret).
 * Used to show the caret without focusing the field (a phone: the keyboard stays down).
 */
export function caretTop(field, pos) {
  const doc = field.ownerDocument, win = doc.defaultView;
  if (!win || !win.getComputedStyle) return 0;
  const cs = win.getComputedStyle(field);
  const m = doc.createElement("div");
  for (const p of ["box-sizing", "width", "padding-top", "padding-right", "padding-bottom", "padding-left", "border-top-width", "border-right-width",
    "border-bottom-width", "border-left-width", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "word-spacing", "tab-size"]) {
    m.style.setProperty(p, cs.getPropertyValue(p));
  }
  for (const [k, v] of [["position", "absolute"], ["visibility", "hidden"], ["top", "0"], ["left", "-9999px"], ["white-space", "pre-wrap"], ["overflow-wrap", "break-word"], ["height", "auto"]]) m.style.setProperty(k, v);
  m.textContent = field.value.slice(0, pos);
  const mark = doc.createElement("span"); mark.textContent = "​"; m.append(mark);
  doc.body.append(m);
  const y = mark.offsetTop, h = mark.offsetHeight;
  m.remove();
  return { y, h };
}

/** Scroll the field's own scroller so the caret (and the lines just above it: the newest quote) are in view. */
export function showCaret(field, pos) {
  // At the end (the usual case: the newest quote is the last thing in the box): the bottom.
  if (pos >= field.value.length) { field.scrollTop = field.scrollHeight; return; }
  const c = caretTop(field, pos);
  if (!c || typeof c !== "object") { field.scrollTop = field.scrollHeight; return; }
  const view = field.clientHeight;
  if (c.y + c.h > field.scrollTop + view) field.scrollTop = Math.max(0, c.y + c.h - view + 4);
  else if (c.y < field.scrollTop) field.scrollTop = Math.max(0, c.y - 4);
}

// The quote mark: two marks on the shared 24-px grid, 2-px stroke, currentColor (as ui-icons.js draws).
const ICON = "M4 11h5v6H4v-6zm0 0c0-3 1.5-5 4-6M14 11h5v6h-5v-6zm0 0c0-3 1.5-5 4-6";
function iconEl(doc) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(NS, "svg");
  for (const [k, v] of [["class", "icon"], ["width", "16"], ["height", "16"], ["viewBox", "0 0 24 24"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"],
    ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"], ["focusable", "false"]]) svg.setAttribute(k, v);
  const p = doc.createElementNS(NS, "path"); p.setAttribute("d", ICON); svg.append(p);
  return svg;
}

const overlap = (a, z) => Math.max(0, Math.min(a.right, z.right) - Math.max(a.left, z.left)) * Math.max(0, Math.min(a.bottom, z.bottom) - Math.max(a.top, z.top));

/**
 * Install the pill on `list` (the thread element). `deps`:
 *   field() → the composer's text field (marked data-touched once it has had the focus: its caret is the person's);
 *   canQuote() → boolean (a page that can send); insert(text) (the composer's side: see panel-chat.js);
 *   phone() → boolean (a coarse pointer); composerBox() → the composer's whole box (Element) or null; threadBox() → Element.
 * Returns a function that removes everything.
 */
export function installQuoteSelection(list, deps) {
  const doc = list.ownerDocument, win = doc.defaultView;
  let pop = null, timer = null, down = false, current = null, drawnFor = "";

  function hide() {
    current = null; drawnFor = "";
    if (!pop) return;
    pop.remove(); pop = null;
  }
  function place(passage) {
    const phone = !!deps.phone?.();
    if (!pop) {
      pop = doc.createElement("div");
      pop.className = "msg-menu quote-pop";
      pop.setAttribute("role", "toolbar"); pop.setAttribute("data-trust", "menu"); pop.setAttribute("aria-label", tq("label"));
      const b = doc.createElement("button");
      b.type = "button"; b.className = "menu-item quote-pick";
      b.append(iconEl(doc));
      const span = doc.createElement("span"); b.append(span);
      // A press on the pill must not collapse the selection it is about (mousedown's default does, pointerdown's
      // preventDefault alone doesn't); the passage is the one the pill was drawn for, whatever the selection did since.
      b.addEventListener("pointerdown", (e) => { e.preventDefault(); });
      b.addEventListener("mousedown", (e) => { e.preventDefault(); });
      b.addEventListener("click", (e) => { e.preventDefault(); const text = drawnFor; hide(); if (text) { deps.insert(text); doc.getSelection?.()?.removeAllRanges?.(); } });
      pop.append(b);
      doc.body.append(pop);
    }
    pop.classList.toggle("is-phone", phone);
    const label = pop.querySelector(".quote-pick span"); label.textContent = tq(phone ? "quotePhone" : "quote");
    pop.querySelector(".quote-tip")?.remove();
    const pr = pop.getBoundingClientRect();
    const vw = win?.innerWidth ?? 1024;
    const rects = [...(passage.range.getClientRects?.() ?? [])].filter((x) => x.width > 0);
    if (!rects.length) { hide(); return; }
    const last = rects[rects.length - 1];
    let left, top, tip = null;
    if (!phone) {
      // Room is the thread's visible box (the chat scroller, above the composer), within the window.
      const th = deps.threadBox?.()?.getBoundingClientRect?.();
      const vh = win?.innerHeight ?? 800;
      const box = th && th.bottom > th.top ? th : { top: 0, bottom: vh };
      const floor = Math.min(vh, box.bottom) - 4, ceil = Math.max(0, box.top) + 4;
      left = Math.max(8, Math.min(last.right - pr.width / 2, vw - pr.width - 8));
      const aboveTop = last.top - pr.height - 10, belowTop = last.bottom + 10;
      // Below unless it would run out of the box and above fits (with no room either side, below).
      const under = belowTop + pr.height <= floor || aboveTop < ceil;
      top = under ? belowTop : aboveTop;
      tip = { side: under ? "up" : "down", x: Math.max(10, Math.min(last.right - left - 5, pr.width - 20)) };
    } else {
      const box = deps.composerBox?.()?.getBoundingClientRect?.();
      left = Math.max(16, vw - 16 - pr.width);
      top = box ? box.top - pr.height - 12 : (win?.innerHeight ?? 800) - pr.height - 120;
      const at = { left, right: left + pr.width, top: top - 8, bottom: top + pr.height + 8 };
      if (rects.some((q) => overlap(at, q) > 0)) {
        const th = deps.threadBox?.()?.getBoundingClientRect?.();
        top = Math.max(th ? th.top : 0, 0) + 12;
      }
    }
    if (tip) {
      const s = doc.createElement("span"); s.className = `quote-tip ${tip.side}`; s.setAttribute("aria-hidden", "true");
      s.style.setProperty("left", `${tip.x}px`);
      pop.append(s);
    }
    pop.style.setProperty("left", `${Math.round(left)}px`);
    pop.style.setProperty("top", `${Math.round(top)}px`);
  }
  function check() {
    timer = null;
    if (down || deps.canQuote?.() === false) { hide(); return; }
    const passage = selectedPassage(list, doc.getSelection?.());
    if (!passage) { hide(); return; }
    current = passage; drawnFor = passage.text;
    place(passage);
  }
  function soon() { if (timer) clearTimeout(timer); timer = setTimeout(check, 120); }
  const onSelection = () => soon();
  const onDown = (e) => { if (pop && pop.contains(e.target)) return; down = true; hide(); };
  // A gesture the browser took over (a touch scroll: pointerdown → pointercancel, no pointerup — #3555 review P2-1)
  // ends the press as a pointerup does; the selection then decides.
  const onUp = () => { if (!down) return; down = false; soon(); };
  const onKey = (e) => { if (e.key === "Escape" && pop) { hide(); } };
  const onScroll = () => { if (pop && current) place(current); };
  const onFocusIn = (e) => { const f = deps.field?.(); if (f && e.target === f) f.dataset.touched = "1"; };
  // The caret as the person leaves it: kept on every move inside the composer and when it loses the focus.
  const keep = (e) => { const f = deps.field?.(); if (f && e.target === f) remembered.set(f, { value: f.value, caret: f.selectionStart ?? f.value.length }); };
  const KEEP = ["focusout", "input", "keyup", "mouseup", "select"];
  doc.addEventListener("focusin", onFocusIn);
  for (const k of KEEP) doc.addEventListener(k, keep, true);
  doc.addEventListener("selectionchange", onSelection);
  list.addEventListener("pointerdown", onDown);
  doc.addEventListener("pointerup", onUp);
  doc.addEventListener("pointercancel", onUp);
  doc.addEventListener("keydown", onKey);
  win?.addEventListener("scroll", onScroll, true);
  win?.addEventListener("resize", onScroll);
  return () => {
    if (timer) clearTimeout(timer);
    hide();
    doc.removeEventListener("focusin", onFocusIn);
    for (const k of KEEP) doc.removeEventListener(k, keep, true);
    doc.removeEventListener("selectionchange", onSelection);
    list.removeEventListener("pointerdown", onDown);
    doc.removeEventListener("pointerup", onUp);
    doc.removeEventListener("pointercancel", onUp);
    doc.removeEventListener("keydown", onKey);
    win?.removeEventListener("scroll", onScroll, true);
    win?.removeEventListener("resize", onScroll);
  };
}
