// Hub PR A (#3226): the chat composer's and WorkBar's drawing, shared by the fleet's chat (panel-chat.js) and the Hub's.
// Drawing only: what the words are, what Send does, whether files may be attached and what a key does are the caller's
// (props); nothing here reads a store, a route or a string table, so the Hub listener can serve it from /assets/.
//
// ComposerInput is the composer's row: Attach (when `attach` is given) with its hidden file input, the text box with its
// drawn placeholder, and Send. M-2904: Stop is not in this row — it is WorkBarView's (above): a Stop that came and went
// here took the box's width away, and a draft re-wrapped under the person's fingers whenever the agent started or stopped. The box is the IME's while it composes (Zhuyin, Pinyin, kana…): between
// compositionstart and compositionend nothing here writes it, re-renders it or grows it — each one moved the box, and iOS
// redrew the candidate bar on every keystroke — and what it holds is handed over once, at compositionend (or a blur that
// ends one that never ended). It grows with the text up to 240px, through the CSSOM (#1300: never a style attribute).
import { html, useLayoutEffect, useRef } from "./app-html.js";
import { Icon } from "./ui-icons.js";

/**
 * Grow the box with its text, up to 240px; empty, it is one line. M-3206 (the user, iPhone, beta.5: typing flickered):
 * the box was collapsed ("auto") and measured again on every key, two writes to the focused field's own style per
 * keystroke even when its height stayed — on iOS a change to the focused field redraws the keyboard's bars, and the
 * page followed them. Now a key that only adds text writes nothing unless the text no longer fits (a new line); only a
 * deletion, a replaced draft, or a box with no height of its own yet collapses and measures it.
 */
export function fitComposerHeight(el, value, before) {
  if (!el?.style) return;
  const cap = 240;
  const set = (px) => { const next = px == null ? "auto" : `${px}px`; if (el.style.height !== next) el.style.height = next; };
  if (!value) { set(null); return; }
  const grew = typeof before === "string" && value.length > before.length && el.style.height !== "";
  if (grew) {
    if (el.scrollHeight > el.clientHeight) set(Math.min(el.scrollHeight, cap));
    return;
  }
  el.style.height = "auto";
  set(Math.min(el.scrollHeight, cap));
}

/** A coarse pointer (a phone, a tablet): Enter makes a new line there and the box says "enter" to the keyboard. */
export const touchScreen = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/**
 * The composer's row. `value`: the draft; `onValue(text)`: the draft changed (never while composing). `placeholder`: the
 * words drawn in the empty box (also its accessible name). `inputRef`: the caller's ref to the box (focus, undo).
 * `attach`: { title, onFiles(fileList) } or null (no Attach). `stop`: accepted from older callers and not drawn (M-2904).
 * `send`: { hidden, disabled, label, onClick } — keep it shown (disabled when there is nothing to send) so the box keeps one width. `controls` / `expanded` / `activeDescendant`: the box's palette ARIA.
 */
export function ComposerInput({ inputRef, value, placeholder, onValue, onKeyDown, onPaste, attach = null, stop, send,
  controls, expanded = false, activeDescendant, ids = {}, tools = null }) {
  const own = useRef(null), input = inputRef || own, fileIn = useRef(null);
  const composing = useRef(false);
  // A render while composing (another part of the page changed) gives the box what it holds, so it never writes it.
  const boxValue = composing.current && input.current ? input.current.value : value;
  // Grow with the text, up to a limit. Empty, it is one line (#2478 — a long name's placeholder made the box two lines).
  const fitted = useRef(null);
  useLayoutEffect(() => {
    const el = input.current; if (!el || composing.current) return;
    fitComposerHeight(el, value, fitted.current); fitted.current = value;
  }, [value]);
  const onInput = (e) => { if (composing.current || e.isComposing) return; onValue(e.target.value); };
  const onCompositionStart = () => { composing.current = true; };
  // The composed text is the draft now (some engines send no input after it); a blur ends one that never ended.
  // Lower-case props below: an element has no oncomposition… property, so Preact would listen for "CompositionStart".
  const onCompositionEnd = (e) => { if (!composing.current) return; composing.current = false; onValue(e.target.value); };
  return html`<div class="composer">
      ${attach ? html`<button id=${ids.attachBtn || "attachBtn"} type="button" class="icon-btn" title=${attach.title} aria-label=${attach.title} onClick=${() => fileIn.current && fileIn.current.click()}><${Icon} name="attach" /></button>
      <input ref=${fileIn} type="file" multiple hidden
        onChange=${(e) => { attach.onFiles(e.target.files); e.target.value = ""; }} />` : null}
      ${/* #2478: the placeholder is drawn beside the box, one line ending in "…" — a textarea's own placeholder is clipped,
          never ellipsized, and a long name wrapped it to two lines. The box keeps the words as its accessible name. Its own
          placeholder is one space: :placeholder-shown hides the drawn one (app.css) the moment the box holds text, an
          IME's composing text included, with no change to the page. */ ""}
      <span class="composer-field"><textarea id=${ids.msgIn || "msgIn"} ref=${input} rows="1" value=${boxValue} aria-label=${placeholder}
        enterkeyhint=${touchScreen() ? "enter" : undefined} autocomplete="off" aria-controls=${controls} aria-expanded=${expanded ? "true" : "false"}
        aria-activedescendant=${activeDescendant} onInput=${onInput} onKeyDown=${onKeyDown} onPaste=${onPaste}
        oncompositionstart=${onCompositionStart} oncompositionend=${onCompositionEnd} onBlur=${onCompositionEnd}
        placeholder=" "></textarea><span class="composer-ph" aria-hidden="true">${placeholder}</span></span>
      ${/* M-3115 (phone v2): what the row holds beside the box (the Fleet chat's context ring and model picker); none elsewhere. */ ""}
      ${tools || null}
      ${/* M-3115: `send.stop` — the button stops the reply instead (a phone's empty box while the agent works). */ ""}
      <button id=${ids.sendBtn || "sendBtn"} type="button" class=${`btn btn-primary btn-send${send.stop ? " is-stop" : ""}`} hidden=${send.hidden} disabled=${send.disabled}
        onMouseDown=${(e) => e.preventDefault()}
        aria-label=${send.label} title=${send.title || send.label} onClick=${send.onClick}><${Icon} name=${send.stop ? "stop" : "send"} size=${16} /><span class="send-label">${send.label}</span></button>
    </div>`;
}

/**
 * The bar above the composer while the agent works (`kind`: working, stuck, stopping) or waits on something it cannot
 * see (`awaiting`, with `note`). `elapsed`: the time it has been at it, as the caller words it (it ticks the caller's way).
 * `stop` (M-2904): { disabled, title, label, onClick } — Stop, beside what it stops; null: none.
 */
export function WorkBarView({ kind, label, note, noteTitle, elapsed, elapsedTitle, stop = null, ids = {} }) {
  return html`<div class=${`work-bar ${kind}`}><span class="pulse" aria-hidden="true"></span><span class="lbl">${label}</span>
    ${kind === "awaiting" ? html`<span class="note" title=${noteTitle}>${note}</span>`
      : html`<span class="elapsed" title=${elapsedTitle} aria-hidden="true">${elapsed}</span>`}
    ${stop ? html`<button id=${ids.stopBtn || "stopBtn"} type="button" class="btn btn-sm btn-stop" title=${stop.title} aria-label=${stop.label}
      disabled=${stop.disabled} onClick=${stop.onClick}><${Icon} name="stop" size=${14} /><span class="stop-label">${stop.label}</span></button>` : null}</div>`;
}

// Namespace/capability checks let an old cached composer keep the legacy single-pane path.
ComposerInput.paneIds = true;
WorkBarView.paneIds = true;
