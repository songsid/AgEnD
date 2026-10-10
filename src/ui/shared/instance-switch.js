// #1523 N2 (§3.2): the instance view switch — Chat | View | Details of ONE instance. Each segment is a link to that
// view's URL for the same instance, so switching keeps the instance (and the sidebar, which is never remounted).
// Desktop: links in the header; a phone: the same three as top tabs under it (app.css). The anonymous View reader
// gets none (Chat and Details need a session): the caller does not render it there.
import { html } from "./app-html.js";
import { t } from "./app-i18n.js";
import { chatPath, detailsPath, viewPath } from "./app-route.js";

/** current: "chat" | "view" | "details". */
export function InstanceSwitch({ name, current }) {
  const seg = (key, href, label) => html`<a key=${key} class=${`seg-item${current === key ? " active" : ""}`} href=${href}
    aria-current=${current === key ? "page" : undefined}>${label}</a>`;
  return html`<nav class="inst-switch seg" aria-label=${t("app.instanceViews", name)}>
    ${seg("chat", chatPath(name), t("app.chat"))}${seg("view", viewPath(name), t("app.view"))}${seg("details", detailsPath(name), t("app.details"))}
  </nav>`;
}
