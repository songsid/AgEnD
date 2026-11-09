// #1408 §6: one set of empty / loading / error states for every panel.
import { html } from "./app-html.js";
import { Icon } from "./ui-icons.js";
import { t } from "./app-i18n.js";

// Lazy panels can arrive in a shell with an older app.css. Keep the loading shapes in their own public stylesheet.
function loadingStyles() {
  if (typeof document === "undefined" || !document.head || document.querySelector('link[href="/assets/loading.css"]')) return;
  const link = document.createElement("link"); link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/loading.css");
  document.head.appendChild(link);
}
/** Initial data only: retain populated content on refresh. Existing callers still get simple text lines. */
export function Skeleton({ lines = 3, variant = "lines", label }) {
  loadingStyles();
  return html`<div class=${`skeleton sk-${variant}`} role="status" aria-busy="true" aria-label=${label || t("app.loading")}>
    <div aria-hidden="true">${Array.from({ length: lines }, (_, i) => variant === "rows" || variant === "cards"
      ? html`<div key=${i} class="sk-row"><div class="sk-line sk-thumb"></div><div class="sk-copy"><div class="sk-line"></div><div class="sk-line"></div></div><div class="sk-line sk-pill"></div></div>`
      : html`<div key=${i} class="sk-line"></div>`)}</div>
  </div>`;
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
