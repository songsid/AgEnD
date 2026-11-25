// M-3722 (#4453 review): Fleet's tabs are icons only on a phone, so each tab has its own icon — Cache, Usage and Host
// health no longer share "chart". Those three drawings live here, not in the shared ui-icons.js: a page still holding an
// older ui-icons.js (cached by URL) would draw nothing for an unknown name, and a phone's tab, its name hidden, would be
// blank. Every other tab's icon is the shared one.
import { html } from "/assets/app-html.js";
import { Icon } from "/assets/ui-icons.js";

const OWN = {
  database: () => html`<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>`,
  gauge: () => html`<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>`,
  pulse: () => html`<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`,
};

/** A Fleet tab's icon: one of the three drawn here, else the shared Icon (same size, stroke and look). */
export function TabIcon({ name, size = 16 }) {
  if (!OWN[name]) return html`<${Icon} name=${name} size=${size} />`;
  return html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${OWN[name]()}</svg>`;
}
