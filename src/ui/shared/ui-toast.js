// Toasts: one stack in a corner (under the header on a phone; above the tabs on the task board), each gone after a few
// seconds. Text only. A manual popover, so it stands in the top layer above an open dialog (#2299).
import { html, useEffect, useRef, useState } from "./app-html.js";
import { createStore } from "./app-store.js";

const toasts = createStore([]);
let seq = 0;

export function toast(text, ok = true) {
  const id = ++seq;
  toasts.set(list => [...list, { id, text: String(text), ok }]);
  setTimeout(() => toasts.set(list => list.filter(x => x.id !== id)), 4000);
}

export function Toasts() {
  const [list, setList] = useState(toasts.get());
  useEffect(() => toasts.subscribe(setList), []);
  // #2299: a manual popover — in the top layer, so an open modal dialog's backdrop does not dim a toast (it did: grey on
  // grey in the dark theme). Shown again on every new toast, so it is above a dialog opened since. Without popover
  // support it stays an ordinary fixed box, as before.
  const box = useRef(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof el.showPopover !== "function") return;
    try {
      if (el.matches(":popover-open")) el.hidePopover();
      if (list.length) el.showPopover();
    } catch { /* a popover that cannot be shown stays where it is */ }
  }, [list]);
  return html`<div ref=${box} popover="manual" data-trust="toast" class="toasts" role="status" aria-live="polite">${list.map(x => html`<div key=${x.id} class=${`toast ${x.ok ? "ok" : "err"}`}>${x.text}</div>`)}</div>`;
}
