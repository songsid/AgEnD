// #1408 §2: our own icon set — 24-px line icons, 2-px stroke, currentColor. No third-party or brand assets.
// Each path is built fresh per use (a Preact vnode must not be mounted twice).
// Decorative by default (aria-hidden); the button around one carries the label.
import { html } from "./app-html.js";

const P = {
  menu: () => html`<path d="M4 6h16M4 12h16M4 18h16"/>`,
  sidebar: () => html`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>`,
  plus: () => html`<path d="M12 5v14M5 12h14"/>`,
  edit: () => html`<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>`,
  more: () => html`<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>`,
  chat: () => html`<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`,
  fleet: () => html`<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>`,
  view: () => html`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>`,
  settings: () => html`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`,
  attach: () => html`<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>`,
  send: () => html`<path d="M12 19V5M5 12l7-7 7 7"/>`,
  stop: () => html`<rect x="6" y="6" width="12" height="12" rx="2"/>`,
  copy: () => html`<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`,
  file: () => html`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>`,
  close: () => html`<path d="M18 6L6 18M6 6l12 12"/>`,
  play: () => html`<path d="M6 4l14 8-14 8z"/>`,
  restart: () => html`<path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>`,
  trash: () => html`<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`,
  info: () => html`<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>`,
  sun: () => html`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
  globe: () => html`<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>`,
  user: () => html`<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>`,
  tasks: () => html`<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>`,
  clock: () => html`<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`,
  team: () => html`<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>`,
  sliders: () => html`<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>`,
  down: () => html`<path d="M12 5v14M19 12l-7 7-7-7"/>`,
  alert: () => html`<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>`,
  chevron: () => html`<path d="M6 9l6 6 6-6"/>`,
  search: () => html`<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>`,
  type: () => html`<path d="M4 7V5h16v2M9 19h6M12 5v14"/>`,
  chart: () => html`<path d="M3 20h18M6 16v-4M11 16V8M16 16v-6"/>`,
  up: () => html`<path d="M12 19V5M5 12l7-7 7 7"/>`,
  eye: () => html`<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`,
  check: () => html`<path d="M20 6L9 17l-5-5"/>`,
  inbox: () => html`<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>`,
  bell: () => html`<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>`,
  bot: () => html`<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M9 4h6"/><path d="M9 13h.01M15 13h.01M9 17h6"/>`,
  plug: () => html`<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>`,
  room: () => html`<path d="M3 21V9l9-6 9 6v12"/><path d="M9 21v-6h6v6"/>`,
  code: () => html`<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>`,
  wand: () => html`<path d="M15 4V2M15 10V8M11 6H9M21 6h-2M18.5 3.5l-1.4 1.4M18.5 8.5l-1.4-1.4"/><path d="M3 21l11-11"/>`,
  key: () => html`<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M17 6l3 3M14 9l2 2"/>`,
  pause: () => html`<path d="M8 5v14M16 5v14"/>`,
  download: () => html`<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>`,
  org: () => html`<rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v5M5 17v-5h14v5"/>`,
  panel: () => html`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>`,
  back: () => html`<path d="M19 12H5M12 19l-7-7 7-7"/>`,
  forward: () => html`<path d="M5 12h14M12 5l7 7-7 7"/>`,
  external: () => html`<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>`,
};

/** <${Icon} name="menu" />; `size` 16 / 18 / 20 / 24. */
export function Icon({ name, size = 18, cls = "" }) {
  return html`<svg class=${`icon ${cls}`} width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] ? P[name]() : null}</svg>`;
}
export const ICON_NAMES = Object.keys(P);
