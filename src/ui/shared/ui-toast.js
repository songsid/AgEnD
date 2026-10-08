// Toasts: one stack in a corner (under the header on a phone), each gone after a few seconds. Text only.
import { html, useEffect, useState } from "./app-html.js";
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
  return html`<div class="toasts" role="status" aria-live="polite">${list.map(x => html`<div key=${x.id} class=${`toast ${x.ok ? "ok" : "err"}`}>${x.text}</div>`)}</div>`;
}
