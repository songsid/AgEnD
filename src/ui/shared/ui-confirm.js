// #1408 step 5: the app's own "are you sure?" — in place of the browser's confirm(), which looked like another
// program and could not say which button does what. One at a time, in the app's dialog (focus trapped, Esc and the
// backdrop say no, a bottom sheet on a phone). Text only.
import { html } from "./app-html.js";
import { createStore, useStore } from "./app-store.js";
import { Dialog } from "./ui-dialog.js";
import { t } from "./app-i18n.js";

/** Pending questions, oldest first: { id, title, message, confirmLabel, danger, more, even, resolve }. */
export const confirmStore = createStore({ queue: [] });
let seq = 0;

/**
 * Ask. Resolves true for the confirm button, false for Cancel, Esc, the backdrop or ×.
 * `message` may hold blank lines (paragraphs); it is shown as text.
 */
/** S-255: `notice` — words to read, not a question: one button, no Cancel (Esc, the backdrop and × still close it). */
export function confirmDialog({ title, message, confirmLabel, danger = false, more = null, even = false, notice = false } = {}) {
  return new Promise((resolve) => {
    // M-3387: `more` { label, lines } — a list closed under the text until opened (e.g. every tool name a switch stops).
    const extra = more && more.label && Array.isArray(more.lines) && more.lines.length ? { label: String(more.label), lines: more.lines.map(String) } : null;
    const item = { id: ++seq, title: title || t("app.confirmTitle"), message: String(message || ""), confirmLabel: confirmLabel || t("app.confirmOk"), danger, more: extra, even: !!even, notice: !!notice, resolve };
    confirmStore.set((s) => ({ queue: [...s.queue, item] }));
  });
}

/** Answer the oldest question (the host's buttons; tests may call it too). */
export function answerConfirm(id, yes) {
  const item = confirmStore.get().queue.find((q) => q.id === id);
  if (!item) return;
  confirmStore.set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
  item.resolve(!!yes);
}

/** The shell renders this once: the oldest question as a dialog. */
export function ConfirmHost() {
  const { queue } = useStore(confirmStore);
  const q = queue[0];
  if (!q) return null;
  const paragraphs = q.message.split(/\n{2,}/);
  // `even`: the two buttons share the row's width on every screen (as a phone's bottom sheet always does).
  return html`<${Dialog} key=${q.id} title=${q.title} cls=${q.even ? "dlg-even" : ""} onClose=${() => answerConfirm(q.id, false)}
    actions=${html`${q.notice ? null : html`<button type="button" class="btn" onClick=${() => answerConfirm(q.id, false)}>${t("app.cancel")}</button>`}
      <button type="button" class=${`btn ${q.danger ? "btn-danger" : "btn-primary"}`} data-confirm="yes" onClick=${() => answerConfirm(q.id, true)}>${q.confirmLabel}</button>`}>
    ${paragraphs.map((p, i) => html`<p key=${i} class="confirm-text">${p}</p>`)}
    ${q.more ? html`<details class="confirm-more"><summary>${q.more.label}</summary><ul>${q.more.lines.map((l, i) => html`<li key=${i} class="mono">${l}</li>`)}</ul></details>` : null}
  </${Dialog}>`;
}
