// #2342: undo and redo in every text field — one history per field, kept here instead of the browser's.
//
// The browser's own undo is one stack for the whole page (Chromium and WebKit alike): Ctrl+Z in one box undoes the
// last edit in whichever box had it, and any script write to a field's value (a completion, a clear, a re-render
// that differs from the box) wipes the stack. So the keys are taken here, but only in a text field:
// - undo: Ctrl+Z (⌘Z on a Mac); redo: Ctrl+Shift+Z or Ctrl+Y (⌘⇧Z on a Mac, where Ctrl+Y is not redo). Anywhere else
//   (a button, the page, a select) nothing is taken; a key with Alt, or mid-IME-composition, is left alone too.
// - a field's steps are recorded from its edits (beforeinput, input): typing is grouped into one step until a pause
//   (UNDO.PAUSE_MS), a space, a different kind of edit (typing ↔ deleting), a paste, a line break or the caret moving
//   elsewhere; an IME composition is one step, recorded when it ends.
// - the browser's own Undo and Redo commands (its Edit menu, a context menu: a trusted beforeinput historyUndo /
//   historyRedo) go through the same history: cancelled and done here. Where a browser cannot cancel them (or a script
//   runs execCommand("undo"), with no beforeinput at all), its own undo goes ahead and what it leaves resets the field's
//   history (never a step that would undo the undo).
// - a script's change to a field's value the person should be able to undo (a completion, a pick, putting text back)
//   calls recordEdit(field) first: the change becomes a step. Any other change (a clear after send, a reload after
//   save) resets the field's history, as the browser's own undo does — a sent message is never undone back into the box.
// - undo and redo write the value and the caret back and dispatch `input`, so the page's state (Preact) follows.
// - password fields are left to the browser: no secret is kept here.

import { useState } from "./app-html.js";

export const UNDO = { PAUSE_MS: 1000, MAX_STEPS: 100 };

const TEXT_TYPES = new Set(["text", "search", "url", "email", "tel", "number", ""]);
/** A field this keeps a history for: a textarea, or a text-like input (never a password) that is not read-only or disabled. */
export function isTextField(el) {
  if (!el || el.readOnly || el.disabled) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "textarea") return true;
  return tag === "input" && TEXT_TYPES.has((el.getAttribute && el.getAttribute("type") || el.type || "").toLowerCase());
}

const histories = new WeakMap();
/** The value and the caret of `el`. A number input has no selection: its caret is null. */
function snap(el) {
  let s = null, e = null;
  try { s = el.selectionStart; e = el.selectionEnd; } catch { /* a number input */ }
  return { v: String(el.value ?? ""), s: s ?? null, e: e ?? null };
}
function historyFor(el) {
  let h = histories.get(el);
  if (!h) { h = { undo: [], redo: [], last: snap(el), kind: null, at: 0, marked: null, composing: false }; histories.set(el, h); }
  return h;
}
/**
 * Bring the history up to the field's value: a change made by a script since the last edit is a step when recordEdit
 * marked it, and otherwise resets the history (what the browser does too).
 */
function sync(el, h) {
  const now = String(el.value ?? "");
  if (now === h.last.v) { h.marked = null; return; }
  if (h.marked) { push(h.undo, h.marked); h.redo = []; }
  else { h.undo = []; h.redo = []; }
  h.marked = null;
  h.last = snap(el);
  h.kind = null;
}
function push(list, s) {
  list.push(s);
  if (list.length > UNDO.MAX_STEPS) list.shift();
}

/** The kind of an edit, for grouping: consecutive typing (or deleting) of one kind is one step. */
function kindOf(e) {
  const t = e.inputType || "";
  if (t === "insertText") return e.data && /\s/.test(e.data) ? "space" : "type";
  if (t === "deleteContentBackward" || t === "deleteContentForward") return "delete";
  return "other";                                   // a paste, a drop, a cut, a line break, a word delete: its own step
}

/** Called before a script changes `el`'s value in a way the person may undo: the value now is the step to go back to. */
export function recordEdit(el) {
  if (!isTextField(el)) return;
  const h = historyFor(el);
  sync(el, h);
  h.marked = snap(el);
  h.kind = null;
}

/** The history kept for `el` (tests). */
export function historyOf(el) {
  const h = histories.get(el);
  return h ? { undo: h.undo.map((s) => s.v), redo: h.redo.map((s) => s.v), last: h.last.v } : null;
}

/** Put snapshot `s` into `el` and tell the page (an `input` event, as an edit would). */
function apply(el, s, type, win) {
  el.value = s.v;
  if (s.s != null) { try { el.setSelectionRange(s.s, s.e ?? s.s); } catch { /* a number input */ } }
  const Ev = win && typeof win.InputEvent === "function" ? win.InputEvent : win && win.Event;
  if (Ev) el.dispatchEvent(new Ev("input", { bubbles: true, ...(Ev === win.InputEvent ? { inputType: type } : {}) }));
}

/**
 * Undo (or redo) on `el`. False when there is nothing to do.
 */
export function step(el, redo, win = typeof window !== "undefined" ? window : null) {
  if (!isTextField(el)) return false;
  const h = historyFor(el);
  sync(el, h);
  const from = redo ? h.redo : h.undo, to = redo ? h.undo : h.redo;
  if (!from.length) return false;
  to.push(h.last);
  h.last = from.pop();
  h.kind = null;
  h.applying = true;
  try { apply(el, h.last, redo ? "historyRedo" : "historyUndo", win); } finally { h.applying = false; }
  h.last = snap(el);
  return true;
}

/** Which history key `e` is, or null: "undo", "redo". `mac`: ⌘ is the modifier and Ctrl+Y is not redo. */
export function historyKey(e, mac) {
  if (e.altKey || e.isComposing || e.keyCode === 229) return null;
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return null;
  const k = (e.key || "").toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && !e.shiftKey && !mac) return "redo";
  return null;
}

/**
 * Keep a history for every text field under `doc` and take the undo/redo keys in them. Returns an uninstall function.
 */
export function installTextUndo({ doc = document, win = typeof window !== "undefined" ? window : null, mac = false } = {}) {
  const field = (e) => (isTextField(e.target) ? e.target : null);
  const onBefore = (e) => {
    const el = field(e);
    // WebKit commits a composition after compositionend (deleteCompositionText, insertFromComposition): its step is
    // the one compositionstart began.
    if (!el || e.isComposing || /Composition/.test(e.inputType || "")) return;
    const h = historyFor(el);
    if (h.applying || h.composing) return;          // a browser that does not flag its composition events
    if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
      if (e.cancelable) { e.preventDefault(); step(el, e.inputType === "historyRedo", win); }
      else h.native = true;
      return;
    }
    sync(el, h);
    const kind = kindOf(e), now = Date.now(), at = snap(el);
    // The same run of typing (or deleting) goes on: one step. A space ends a word's step (the next word is a new one).
    // Anything else starts a new step from the value now.
    const same = kind === "space" ? h.kind === "type" : kind !== "other" && kind === h.kind;
    const goesOn = same && now - h.at < UNDO.PAUSE_MS && at.s === h.last.s && at.e === h.last.e;
    if (!goesOn) { push(h.undo, at); h.redo = []; }
    h.kind = kind;
    h.at = now;
  };
  const onInput = (e) => {
    const el = field(e);
    if (!el) return;
    const h = historyFor(el);
    if (h.applying) return;
    // The browser's own undo or redo went ahead (one it could not cancel, or a script's execCommand("undo"), which has no
    // beforeinput): what it left is a change of its own — the history starts afresh.
    if (h.native || e.inputType === "historyUndo" || e.inputType === "historyRedo") { h.native = false; h.undo = []; h.redo = []; h.kind = null; }
    h.last = snap(el);                              // mid-composition too: the value the next edit starts from
  };
  const onCompStart = (e) => {
    const el = field(e);
    if (!el) return;
    const h = historyFor(el);
    sync(el, h);
    push(h.undo, snap(el)); h.redo = [];
    h.composing = true; h.kind = null;
  };
  const onCompEnd = (e) => {
    const el = field(e);
    if (!el) return;
    const h = historyFor(el);
    h.composing = false;
    h.last = snap(el);                              // WebKit's last input comes after compositionend: onInput updates it again
  };
  const onKey = (e) => {
    const el = field(e);
    if (!el) return;
    const which = historyKey(e, mac);
    if (!which || historyFor(el).composing) return;
    e.preventDefault();                             // never the browser's page-wide stack, even when this field has no step
    step(el, which === "redo", win);
  };
  doc.addEventListener("beforeinput", onBefore, true);
  doc.addEventListener("input", onInput, true);
  doc.addEventListener("compositionstart", onCompStart, true);
  doc.addEventListener("compositionend", onCompEnd, true);
  doc.addEventListener("keydown", onKey, true);
  return () => {
    doc.removeEventListener("beforeinput", onBefore, true);
    doc.removeEventListener("input", onInput, true);
    doc.removeEventListener("compositionstart", onCompStart, true);
    doc.removeEventListener("compositionend", onCompEnd, true);
    doc.removeEventListener("keydown", onKey, true);
  };
}

const trimmed = (v) => v.trim();
/**
 * A field whose owner keeps its value normalized (trimmed, or a number): the box shows the text as typed and the owner
 * gets `norm(text)`. Binding the box to the normalized value would rewrite it while the person types (a space vanishes,
 * "1.50" turns into "1.5") and lose the field's undo history. When the owner's value becomes something the text does not
 * normalize to (a clear, a load), the box shows `show(value)`.
 * Returns [text for the box, onText(typed) → the normalized value].
 */
export function useTypedText(value, norm = trimmed, show = (v) => (v == null ? "" : String(v))) {
  const [raw, setRaw] = useState(null);
  const text = raw !== null && Object.is(norm(raw), value) ? raw : show(value);
  return [text, (typed) => { setRaw(typed); return norm(typed); }];
}
