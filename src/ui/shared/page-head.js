// Hub PR A (#3226): a page's head as Settings draws it (#1408: `.s-page-head`) — the title with its scope beside it, the
// lead under them and the page's actions on the right — shared so the Hub's owner and admin pages are the same thing.
// Drawing only: the words are the caller's (Settings' SettingsPageHead passes its own).
import { html } from "./app-html.js";

export function PageHead({ title, scope, lead, children }) {
  return html`<header class="s-page-head"><div><div class="s-page-title"><h2>${title}</h2><span class="s-scope">${scope}</span></div><p class="s-page-lead">${lead}</p></div>${children ? html`<div class="s-page-actions">${children}</div>` : null}</header>`;
}
