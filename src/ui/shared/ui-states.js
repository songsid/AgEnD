// #1408 §6: one set of empty / loading / error states for every panel.
import { html } from "./app-html.js";
import { Icon } from "./ui-icons.js";
import { t } from "./app-i18n.js";

/** Placeholder lines while something loads. Shown only after 300 ms (CSS), so a fast load never flashes. */
export function Skeleton({ lines = 3 }) {
  return html`<div class="skeleton" aria-busy="true" aria-label=${t("app.loading")}>${Array.from({ length: lines }, (_, i) => html`<div key=${i} class="sk-line"></div>`)}</div>`;
}

export function Empty({ icon = "info", title, hint, action }) {
  return html`<div class="empty"><${Icon} name=${icon} size=${32} cls="empty-icon" />
    <p class="empty-title">${title}</p>${hint ? html`<p class="empty-hint">${hint}</p>` : null}${action || null}</div>`;
}

export function ErrorState({ message, onRetry }) {
  return html`<div class="error-state" role="alert"><${Icon} name="alert" size=${24} />
    <p>${message || t("app.loadFailed")}</p>
    ${onRetry ? html`<button type="button" class="btn" onClick=${onRetry}>${t("app.retry")}</button>` : null}</div>`;
}
