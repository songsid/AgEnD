// #1408 step 5: the app's own "are you sure?" — in place of the browser's confirm(), which looked like another
// program and could not say which button does what. One at a time, in the app's dialog (focus trapped, Esc and the
// backdrop say no, a bottom sheet on a phone). Text only.
import { html } from "./app-html.js";
import { createStore, useStore } from "./app-store.js";
import { Dialog } from "./ui-dialog.js";
import { t } from "./app-i18n.js";

/** Pending questions, oldest first: { id, title, message, confirmLabel, danger, resolve }. */
export const confirmStore = createStore({ queue: [] });
let seq = 0;

/**
 * Ask. Resolves true for the confirm button, false for Cancel, Esc, the backdrop or ×.
 * `message` may hold blank lines (paragraphs); it is shown as text.
 */
export function confirmDialog({ title, message, confirmLabel, danger = false } = {}) {
  return new Promise((resolve) => {
    const item = { id: ++seq, title: title || t("app.confirmTitle"), message: String(message || ""), confirmLabel: confirmLabel || t("app.confirmOk"), danger, resolve };
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
  return html`<${Dialog} key=${q.id} title=${q.title} onClose=${() => answerConfirm(q.id, false)}
    actions=${html`<button type="button" class="btn" onClick=${() => answerConfirm(q.id, false)}>${t("app.cancel")}</button>
      <button type="button" class=${`btn ${q.danger ? "btn-danger" : "btn-primary"}`} data-confirm="yes" onClick=${() => answerConfirm(q.id, true)}>${q.confirmLabel}</button>`}>
    ${paragraphs.map((p, i) => html`<p key=${i} class="confirm-text">${p}</p>`)}
  </${Dialog}>`;
}
