// Hub PR A (#3226): the right-hand rail's frame — the AI usage rail's (#1673) layout, shared so the Hub's context panel is
// the same thing: a column beside the page with its title, the caller's tools and × on top, and its body below
// (`.u-rail`, `.u-rail-head`, `.u-rail-body`; app.css). Drawing only: whether it shows, what × does and what is inside
// are the caller's (UsageRail keeps its shown/hidden choice per device in agend_usage_rail).
import { html } from "./app-html.js";
import { Icon } from "./ui-icons.js";

/** `trust`: the region's data-trust; `label`: its accessible name; `title`: the heading; `tools`: beside the heading. */
export function RailFrame({ trust, label, title, tools = null, closeLabel, onClose, children }) {
  return html`<aside data-trust=${trust} class="u-rail" aria-label=${label}>
    <div class="u-rail-head"><h2>${title}</h2>${tools}
      <button type="button" class="icon-btn" onClick=${onClose} aria-label=${closeLabel} title=${closeLabel}><${Icon} name="close" size=${16} /></button></div>
    <div class="u-rail-body">${children}</div>
  </aside>`;
}
