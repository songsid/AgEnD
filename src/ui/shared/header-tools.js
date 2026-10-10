// #1523 N3 (§3.4, Q2 = A): the controls every page's header has, in one order on Chat, View, Details and Fleet —
//   Aa  text size, shared per device: S / M / L (View also keeps Fit, its own extra choice);
//   ◔   AI usage, unless the fleet turned it off (web.usage_panel: false — said by the page itself, no probe read).
// The size is one attribute on the root (data-text-size); CSS turns it into one custom property the chat, Details and
// Fleet read (#1300: no style attribute). View's terminal multiplies its fitted size by VIEW_SCALE, as its density did.
import { html, useState } from "./app-html.js";
import { t } from "./app-i18n.js";
import { createStore, useStore } from "./app-store.js";
import { Icon } from "./ui-icons.js";
import { UsageDialog } from "./usage-dialog.js";

export const TEXT_SIZE_KEY = "agend_text_size";
export const VIEW_FIT_KEY = "agend_view_fit";
const LEGACY_DENSITY_KEY = "agend_view_density";
export const TEXT_SIZES = ["s", "m", "l"];
/** View's terminal: its fitted size times this (S / M / L are View's old compact / – / comfortable). */
export const VIEW_SCALE = { s: 0.8, m: 1, l: 1.25 };

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* this page only */ } };

/**
 * This device's choice: `agend_text_size` (+ View's Fit), else — once — from View's `agend_view_density`:
 * comfortable → L, compact → S (Fit off); fit, or nothing → M with View on Fit (View's default, as before).
 */
export function loadTextSize() {
  let size = read(TEXT_SIZE_KEY), fit = read(VIEW_FIT_KEY);
  if (!TEXT_SIZES.includes(size)) {
    const legacy = read(LEGACY_DENSITY_KEY);
    size = legacy === "comfortable" ? "l" : legacy === "compact" ? "s" : "m";
    fit = legacy === "comfortable" || legacy === "compact" ? "0" : "1";
    write(TEXT_SIZE_KEY, size); write(VIEW_FIT_KEY, fit);
  }
  return { size, viewFit: fit !== "0" };
}

export const textSizeStore = createStore({ size: "m", viewFit: true });
function apply(st) { try { document.documentElement.dataset.textSize = st.size; } catch { /* no document */ } }
textSizeStore.subscribe(apply);
let listeningOn = null;     // the window whose storage events it follows (one page, one window)
/** A page load: this device's choice, on the root; another tab's choice follows (the storage event). */
export function initTextSize() {
  const st = loadTextSize();
  textSizeStore.set(st);
  apply(st);
  if (typeof window !== "undefined" && window !== listeningOn && typeof window.addEventListener === "function") {
    listeningOn = window;
    window.addEventListener("storage", (e) => { if (!e || e.key === TEXT_SIZE_KEY || e.key === VIEW_FIT_KEY || e.key === null) textSizeStore.set(loadTextSize()); });
  }
}
/** A size chosen anywhere is the size everywhere (View's Fit included: the last choice wins). */
export function setTextSize(size) {
  if (!TEXT_SIZES.includes(size)) return;
  write(TEXT_SIZE_KEY, size); write(VIEW_FIT_KEY, "0");
  textSizeStore.set({ size, viewFit: false });
}
export function setViewFit() { write(VIEW_FIT_KEY, "1"); textSizeStore.set((s) => ({ ...s, viewFit: true })); }

/** Aa: S → M → L → S; on View, Fit → S → M → L → Fit. */
export function TextSizeButton({ view = false }) {
  const st = useStore(textSizeStore);
  const cur = view && st.viewFit ? "fit" : st.size;
  const order = view ? ["fit", ...TEXT_SIZES] : TEXT_SIZES;
  const next = order[(order.indexOf(cur) + 1) % order.length];
  const name = t(`app.textSize_${cur}`);
  const label = t("app.textSize", name);
  return html`<button type="button" class="btn btn-ghost btn-sm hd-text" onClick=${() => (next === "fit" ? setViewFit() : setTextSize(next))}
    title=${label} aria-label=${label}><${Icon} name="type" size=${16} /><span class="hide-narrow" aria-hidden="true">${name}</span></button>`;
}

/** Whether the fleet serves the usage panel: the page says so (data-usage-panel); "0" only when turned off. */
export function usageOffered() {
  try { return document.body && document.body.dataset ? document.body.dataset.usagePanel !== "0" : true; } catch { return true; }
}

/** ◔: the usage dialog (usage-dialog.js). */
export function UsageButton() {
  const [open, setOpen] = useState(false);
  if (!usageOffered()) return null;
  return html`<button type="button" class="btn btn-ghost btn-sm hd-usage" onClick=${() => setOpen(true)} aria-label=${t("app.usage")} title=${t("app.usage")}>
      <${Icon} name="chart" size=${16} /><span class="hide-narrow" aria-hidden="true">${t("app.usage")}</span></button>
    ${open ? html`<${UsageDialog} onClose=${() => setOpen(false)} />` : null}`;
}

/** The shared controls, in the one order every page uses. */
export function HeaderTools({ view = false }) {
  return html`<${TextSizeButton} view=${view} /><${UsageButton} />`;
}
