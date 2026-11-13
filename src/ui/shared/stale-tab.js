// #3822: a tab left open across an AgEnD update keeps the modules it already loaded. A module it loads later comes from the
// new version, and when that one imports a name the tab's older copy of a module does not have, the browser refuses to
// link it (SyntaxError: "… does not provide an export named …"). Trying again cannot help: the old copy stays in the
// tab. Only a reload does. Where a lazily loaded part of a page fails that way, it says so in place, with Reload,
// instead of a Retry that cannot work or a loading skeleton that never ends.
// A file of its own with its own words: a brand-new module is always fetched fresh, so an older tab never meets it half
// updated. Shared components: error-state, btn.
import { html } from "./app-html.js";
import { register, t } from "./app-i18n.js";
import { Icon } from "./ui-icons.js";

register("staleTab", {
  en: {
    title: "This tab is older than AgEnD now.",
    hint: "AgEnD was updated while this tab was open. Reload the tab to use the new version; nothing you saved is lost.",
    reload: "Reload this tab",
  },
  "zh-TW": {
    title: "這個分頁比 AgEnD 舊。",
    hint: "這個分頁開著時 AgEnD 已更新。重新載入分頁即可使用新版，已儲存的內容不會遺失。",
    reload: "重新載入這個分頁",
  },
});

/**
 * A lazily loaded module that could not be linked or parsed: what a tab older than the server meets (a missing export,
 * or code its older modules cannot run) — the browser's own rejection, or one a loader wrapped with it as its `cause`. A
 * network failure is not this (a TypeError): Retry still fits that.
 */
export function isStaleModuleError(err) {
  return err instanceof SyntaxError || (!!err && typeof err === "object" && err.cause instanceof SyntaxError);
}

/** A phone or a coarse pointer: the button is a full touch target (style guide rule 7). */
const TOUCH = "(max-width: 899px), (pointer: coarse)";
const touch = () => { try { return typeof globalThis.matchMedia === "function" && globalThis.matchMedia(TOUCH).matches; } catch { return false; } };

/**
 * In place of what could not load: why, and one button that reloads the tab. On a phone the button's own style makes it
 * a touch target: the tab that shows this kept its OLD app.css (the rule for .stale-tab there is new), and --tap is a
 * token every version has.
 */
export function StaleTabPrompt({ reload = () => globalThis.location?.reload() } = {}) {
  const size = touch() ? { minHeight: "var(--tap, 44px)", minWidth: "var(--tap, 44px)" } : undefined;
  return html`<div class="error-state stale-tab" role="alert" data-stale-tab="1"><${Icon} name="alert" size=${24} />
    <p>${t("staleTab.title")}</p><p class="muted">${t("staleTab.hint")}</p>
    <button type="button" class="btn btn-primary" style=${size} onClick=${() => reload()}>${t("staleTab.reload")}</button></div>`;
}
