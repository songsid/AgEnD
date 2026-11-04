// #2936 (Settings content width, from app-shell.js) — #2978 merge: a module of its own, imported by the shell (which
// restores the choice at load) and by Settings' Look section. A tab opened before an upgrade has the old shell, without
// these names; the new Settings panel imports them from here instead, a module that tab loads fresh, so Settings still
// opens (the width then applies from the first change on, and at the next load).
import { createStore } from "./app-store.js";

/** Settings' reading space is this device's layout choice, never a host-kept or staged preference. */
export const SETTINGS_CONTENT_WIDTH_KEY = "agend_settings_content_width";
export const SETTINGS_CONTENT_WIDTHS = Object.freeze([1000, 1200, 1440]);
export const DEFAULT_SETTINGS_CONTENT_WIDTH = 1200;
export const settingsContentWidthStore = createStore({ width: DEFAULT_SETTINGS_CONTENT_WIDTH });
function storedSettingsContentWidth() {
  try {
    const value = globalThis.localStorage.getItem(SETTINGS_CONTENT_WIDTH_KEY);
    return SETTINGS_CONTENT_WIDTHS.find((width) => String(width) === value) ?? DEFAULT_SETTINGS_CONTENT_WIDTH;
  } catch { return DEFAULT_SETTINGS_CONTENT_WIDTH; }
}
function showSettingsContentWidth(width) {
  // The property is consumed only by Settings' content maximum; CSS still fits a narrower window or form.
  if (typeof document !== "undefined") document.documentElement.style.setProperty("--settings-width", `${width}px`);
  settingsContentWidthStore.set({ width });
}
/** A page load restores this device's choice. Unreadable or invalid storage keeps the normal 1200 px maximum. */
export function initSettingsContentWidth() { showSettingsContentWidth(storedSettingsContentWidth()); }
/** Apply immediately even when storage is unavailable; then the choice lasts for this page only. */
export function setSettingsContentWidth(width) {
  if (!SETTINGS_CONTENT_WIDTHS.includes(width)) return;
  try { globalThis.localStorage.setItem(SETTINGS_CONTENT_WIDTH_KEY, String(width)); } catch { /* this page only */ }
  showSettingsContentWidth(width);
}

