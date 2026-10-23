// #1408 §2/§7: the app's frame — the sidebar (a drawer on a phone), the main area with its panel, the bottom tabs on a
// phone, the connection line, toasts. Panels render their own header through <PanelHeader>, so every panel's title,
// status and ⋯ actions sit in the same place.
import { html, useEffect, useLayoutEffect, useRef, useState } from "./app-html.js";
import { Icon } from "./ui-icons.js";
import { Toasts } from "./ui-toast.js";
import { ConfirmHost } from "./ui-confirm.js";
import { ColorDialogHost } from "./identity-color.js";
import { t, lang, setLang, onLang } from "./app-i18n.js";
import { appStore, createStore, guestBadge, guestPage, useStore } from "./app-store.js";
import { navStore } from "./app-nav.js";
import { toast } from "./ui-toast.js";
import { chatPath, viewPath, settingsPath, routeKey, NEEDS_PATH, fleetEntryPath } from "./app-route.js";
import { SessionMenu } from "./app-session.js";
import { onPrefsChanged, savePref } from "./app-prefs.js";
import { applyPageTheme, pageNow, resolvedMode, themesStore } from "./app-themes.js";
import { ErrorState, Skeleton } from "./ui-states.js";
import { InstanceNav, RosterNav, namesStore, setNamesPrimary } from "./instance-nav.js";
import { UsageRail, usageRailStore } from "./header-tools.js";
import { OwnerCssKeepBar } from "./owner-css.js";
import { AgentWidget, fleetBinds, sidebarWidget, sidebarWidgetStore } from "./agent-widget.js";

/** Shell state shared with panels: the phone drawer, the collapsed sidebar, extensions a panel module adds. */
export const shellStore = createStore({ drawer: false, collapsed: readCollapsed(), keyboard: false, dialog: null, side: null, banner: null });

/**
 * The mounted panel's own sidebar section, in place of the instance list (View's roster: its groups, filter and order,
 * #1408 step 2). Returns the function that takes it away; take it through the panel's lease.
 */
export function setSideSection(Component) {
  const entry = { Component };
  shellStore.set({ side: entry });
  return () => { if (shellStore.get().side === entry) shellStore.set({ side: null }); };
}

// The sidebar's instance list (alpha.2, N1): one component on every page. keepActiveInView lives with it.
export { keepActiveInView } from "./instance-nav.js";

/** #1519 P7: "New agent" from anywhere (the sidebar's +, an empty chat): the app registers what opens it. */
let newInstanceOpener = null;
export function setNewInstanceOpener(fn) { newInstanceOpener = fn; }
export function requestNewInstance() { if (newInstanceOpener) newInstanceOpener(); }

/**
 * #2074: whether this page's session may make an agent — an admin's (/auth/session's tier); a guest's create is refused.
 * Asked once per page; a session that ends takes the buttons away. A display hint only: the create route decides.
 */
export const canCreateStore = createStore({ value: false });
let canCreateOf = null;                          // the AgendAuth asked (one per page)
export function useCanCreate() {
  const s = useStore(canCreateStore);
  useEffect(() => {
    const auth = typeof window !== "undefined" ? window.AgendAuth : undefined;
    if (!auth || typeof auth.canWrite !== "function" || canCreateOf === auth) return;
    canCreateOf = auth;
    canCreateStore.set({ value: false });
    Promise.resolve(auth.canWrite()).then((v) => { if (canCreateOf === auth && !auth.sessionEnded?.()) canCreateStore.set({ value: v === true }); }, () => {});
    auth.onSessionEnd?.(() => { if (canCreateOf === auth) canCreateStore.set({ value: false }); });
  }, []);
  return s.value;
}

/** An app-level dialog (New instance): rendered by the shell until closed, whatever panel is showing. */
export function showDialog(Component, props = {}) { shellStore.set({ dialog: { Component, props } }); }
export function closeDialog() { shellStore.set({ dialog: null }); }

// ── #2293: global search — an admin's. The dialog lives behind the session gate (/ui/js/search-dialog.js) and loads the
// first time it opens; the sidebar row, the header's button and the shortcuts only open it. ──
export const isMacLike = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
/** What the row and tooltips show: ⌘K on a Mac, Ctrl K elsewhere. */
export const searchShortcut = () => (isMacLike() ? "⌘K" : "Ctrl K");
/**
 * Whether this page offers search: an admin's page. A guest's never. #2478 (the user's request): over the public link
 * too, unless the fleet keeps it off there (web.search.public_link: false — the page says data-search-link="0", the
 * server refuses it), so then no entry, no shortcut, and Ctrl+F stays the browser's.
 */
export function searchOffered(admin) {
  const body = typeof document !== "undefined" ? document.body : null;
  const offLink = !!body && body.dataset.publicLink === "1" && body.dataset.searchLink === "0";
  return !!admin && !guestPage() && !offLink;
}
let searchModule = null;
/** Open search; `preset.instance`: narrowed to that agent (Ctrl+F in its chat). */
export function openSearch(preset = {}) {
  closeDrawer();
  (searchModule ??= import("/ui/js/search-dialog.js")).then(
    (m) => showDialog(m.SearchDialog, { preset }),
    () => { searchModule = null; toast(t("app.loadFailed"), false); });
}
/**
 * Ctrl+K (⌘K) anywhere opens search; Ctrl+F (⌘F) in an agent's chat opens it narrowed to that agent — elsewhere the
 * browser's own find stays. Not while another dialog is open (search, open already, has its input focused).
 */
export function handleSearchKey(e) {
  if (!searchOffered(true)) return;
  if (e.isComposing || e.altKey || e.shiftKey || !(isMacLike() ? e.metaKey : e.ctrlKey)) return;
  const key = (e.key || "").toLowerCase();
  if (key !== "k" && key !== "f") return;
  if (typeof document !== "undefined" && document.querySelector("dialog[open]")) return;
  const route = navStore.get().route;
  if (key === "f" && !(route && route.panel === "chat" && route.instance)) return;
  e.preventDefault();
  openSearch(key === "f" ? { instance: route.instance } : {});
}

function readCollapsed() { try { return localStorage.getItem("agend_sidebar") === "hidden"; } catch { return false; } }
const narrow = () => typeof matchMedia === "function" && matchMedia("(max-width: 899px)").matches;

// ── #1722: the sidebar's width — this device's (the #1665 split: a width depends on the screen), through the CSSOM ──
export const SIDEBAR_W = { min: 200, max: 480, def: 260, step: 16, mainMin: 480 };
const SIDEBAR_W_KEY = "agend_sidebar_w";
const win = () => (typeof window !== "undefined" ? window : null);
const viewportWidth = () => { const w = win(); return w && typeof w.innerWidth === "number" && w.innerWidth > 0 ? w.innerWidth : 1366; };
/** The width the sidebar may have on a viewport `vw` px wide: within [min, max], and leaving the main pane mainMin. */
export function clampSidebarWidth(w, vw) {
  const max = Math.max(SIDEBAR_W.min, Math.min(SIDEBAR_W.max, vw - SIDEBAR_W.mainMin));
  return Math.round(Math.min(max, Math.max(SIDEBAR_W.min, w)));
}
function storedSidebarWidth() { try { const v = Number(localStorage.getItem(SIDEBAR_W_KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; } }
/** { width: px | null } — null: the default width (tokens.css). */
export const sidebarWidthStore = createStore({ width: null });
/** Set the width (clamped to this viewport); `save`: this device keeps it. null: back to the default, nothing kept. */
/**
 * The room the main pane has beside the sidebar: the window, less the usage rail when it is on screen (#1673 — shown
 * open, ≥ 1200 px; its CSS width when the layout gives none). #1722 review: the sidebar never leaves main under 480.
 */
function mainBudget() {
  const vw = viewportWidth();
  if (vw < 1200 || typeof document === "undefined") return vw;
  const rail = document.querySelector(".u-rail");
  if (!rail) return vw;
  const w = Math.round(rail.getBoundingClientRect ? rail.getBoundingClientRect().width : 0) || RAIL_W;
  return vw - w;
}
const RAIL_W = 320;
/** Show a width (clamped to the room there is now) — this page only; null: the default width. Nothing is kept. */
function showSidebarWidth(w) {
  const root = document.documentElement;
  if (w == null) { root.style.removeProperty("--sidebar-w"); sidebarWidthStore.set({ width: null }); return null; }
  const v = clampSidebarWidth(w, mainBudget());
  root.style.setProperty("--sidebar-w", `${v}px`);   // CSSOM: the page's CSP allows no style attribute
  sidebarWidthStore.set({ width: v });
  return v;
}
/** Set the width (clamped to the room there is now); `save`: this device keeps it. null: back to the default, nothing kept. */
export function setSidebarWidth(w, save = false) {
  if (w == null) {
    try { localStorage.removeItem(SIDEBAR_W_KEY); } catch { /* this page only */ }
    return showSidebarWidth(null);
  }
  const v = showSidebarWidth(w);
  // Kept: the choice within the window, not the squeeze beside the rail — it comes back when the rail goes.
  if (save) { try { localStorage.setItem(SIDEBAR_W_KEY, String(clampSidebarWidth(w, viewportWidth()))); } catch { /* this page only */ } }
  return v;
}
/** A drag in progress (one at a time): its end(commit). Only it may set the width until it ends. */
let activeDrag = null;
/**
 * This device's kept width, shown within the room there is now — again whenever that changes (the window, the usage
 * rail, the page). A squeeze is shown, never kept: the device's choice comes back when there is room. On a phone (the
 * drawer) none applies, and a drag in progress is cancelled.
 */
function applyKeptSidebarWidth() {
  if (narrow()) {
    if (activeDrag) activeDrag.end(false);
    showSidebarWidth(null);
    return;
  }
  if (activeDrag) return;
  const w = storedSidebarWidth();
  if (w != null) showSidebarWidth(w);
}
const afterPaint = (fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => fn()) : setTimeout(fn, 0));
/** The separator on the sidebar's right edge: drag, ← → (16 px), Home / End, Enter or a double-click resets. */
function SidebarResize() {
  const { width } = useStore(sidebarWidthStore);
  useStore(usageRailStore);   // the rail's room is the separator's limit too
  useLayoutEffect(() => {
    applyKeptSidebarWidth();
    // The room changes with the window, the rail (opened, closed) and the page (a page with no rail): shown again,
    // once the page has drawn its change.
    const again = () => afterPaint(applyKeptSidebarWidth);
    const offRail = usageRailStore.subscribe(again);
    const offNav = navStore.subscribe(again);
    const w = win();
    if (w && typeof w.addEventListener === "function") w.addEventListener("resize", applyKeptSidebarWidth);
    return () => {
      offRail(); offNav();
      if (w && typeof w.removeEventListener === "function") w.removeEventListener("resize", applyKeptSidebarWidth);
      if (activeDrag) activeDrag.end(false);   // unmounted mid-drag: nothing kept, nothing left behind
    };
  }, []);
  const now = width ?? SIDEBAR_W.def;
  const onKey = (e) => {
    const cur = sidebarWidthStore.get().width ?? SIDEBAR_W.def;
    if (e.key === "ArrowRight") setSidebarWidth(cur + SIDEBAR_W.step, true);
    else if (e.key === "ArrowLeft") setSidebarWidth(cur - SIDEBAR_W.step, true);
    else if (e.key === "Home") setSidebarWidth(SIDEBAR_W.min, true);
    else if (e.key === "End") setSidebarWidth(SIDEBAR_W.max, true);
    else if (e.key === "Enter") setSidebarWidth(null);
    else return;
    e.preventDefault();
  };
  // One pointer owns a drag. Only its release keeps the width; a cancel, a lost capture, the drawer or an unmount
  // puts back the width shown before it and keeps nothing — and no event of it can write after it ended. What is kept
  // is where the pointer went (within the window), not what the room beside the rail let it show.
  const onDown = (e) => {
    if (e.button !== 0 || activeDrag || narrow()) return;
    e.preventDefault();
    const handle = e.currentTarget, pointerId = e.pointerId;
    const before = sidebarWidthStore.get().width;
    let chosen = null;   // the pointer's own width this drag; null: it never moved
    const left = handle.parentElement ? handle.parentElement.getBoundingClientRect().left : 0;
    const mine = {};
    const own = (ev) => activeDrag === mine && (ev.pointerId === undefined || ev.pointerId === pointerId);
    const move = (ev) => { if (own(ev)) { chosen = ev.clientX - left; showSidebarWidth(chosen); } };
    const up = (ev) => { if (own(ev)) mine.end(true); };
    const cancel = (ev) => { if (own(ev)) mine.end(false); };
    mine.end = (commit) => {
      if (activeDrag !== mine) return;
      activeDrag = null;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancel);
      handle.removeEventListener("lostpointercapture", cancel);
      handle.classList.remove("dragging");
      document.body.classList.remove("side-resizing");
      try { handle.releasePointerCapture(pointerId); } catch { /* not held */ }
      if (commit && chosen != null) setSidebarWidth(chosen, true);
      else showSidebarWidth(before);
    };
    activeDrag = mine;
    try { handle.setPointerCapture(pointerId); } catch { /* the move still works while over the handle */ }
    handle.classList.add("dragging");
    document.body.classList.add("side-resizing");
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancel);
    handle.addEventListener("lostpointercapture", cancel);
  };
  return html`<div data-trust="navigation" class="side-resize" role="separator" aria-orientation="vertical" tabindex="0" aria-controls="sidebar"
    aria-label=${t("app.resizeSidebar")} title=${t("app.resizeSidebarHint")} aria-valuemin=${String(SIDEBAR_W.min)}
    aria-valuemax=${String(clampSidebarWidth(Infinity, mainBudget()))} aria-valuenow=${String(now)}
    onKeyDown=${onKey} onPointerDown=${onDown} ondblclick=${() => setSidebarWidth(null)}></div>`;
}

export function openDrawer() { shellStore.set({ drawer: true }); }
export function closeDrawer() { if (shellStore.get().drawer) shellStore.set({ drawer: false }); }
export function toggleSidebar() {
  if (narrow()) { shellStore.set(s => ({ ...s, drawer: !s.drawer })); return; }
  const collapsed = !shellStore.get().collapsed;
  shellStore.set({ collapsed });
  try { localStorage.setItem("agend_sidebar", collapsed ? "hidden" : "shown"); } catch { /* this page only */ }
}

// ── Keys ── One document listener for the page. Esc closes what is on top first (the drawer); then the panel's own
// handlers run — only for the mounted panel, and only when the focus is inside it or on nothing (the body).
const panelKeys = new Set();
/** A panel's key handler while it is mounted; returns the off function (take it through the panel's lease). */
export function onPanelKey(fn) { panelKeys.add(fn); return () => panelKeys.delete(fn); }
export function handleKey(e) {
  if (e.key === "Escape" && !e.isComposing && shellStore.get().drawer) { e.preventDefault(); closeDrawer(); return; }
  const main = document.getElementById("main");
  const active = document.activeElement;
  if (active && active !== document.body && main && !main.contains(active)) return;
  for (const fn of [...panelKeys]) fn(e);
}

/** document.title for the panel on screen. */
/**
 * The tab's title: the panel's own, prefixed with "(N) " while N things need you (#1386 §6.1), so a background tab
 * says so. The count follows the store; the panel only names itself.
 */
let titleBase = "", titleCount = 0;
function drawTitle() {
  if (typeof document === "undefined") return;
  document.title = `${titleCount ? `(${titleCount}) ` : ""}${titleBase ? `${titleBase} · AgEnD` : "AgEnD"}`;
}
export function setTitle(text) { titleBase = text || ""; drawTitle(); }
appStore.subscribe((s) => {
  const n = Array.isArray(s.needs) ? s.needs.length : 0;
  if (n !== titleCount) { titleCount = n; drawTitle(); }
});

// ── The parts ──

function statusLabel(i, exec, awaiting) {
  if (awaiting != null) return t("app.needsYou");
  if (i.startup_phase === "queued") return t("app.statusQueued");
  if (i.startup_phase === "starting") return t("app.statusStarting");
  if (i.status !== "running") return i.status === "crashed" ? t("app.statusCrashed") : t("app.statusStopped");
  if (exec === "working") return t("app.statusWorking");
  if (exec === "stuck") return t("app.statusStuck");
  return t("app.statusIdle");
}
export function statusClass(i, exec, awaiting) {
  if (awaiting != null) return "warn";
  if (i?.startup_phase === "starting") return "busy";
  if (i?.startup_phase === "queued") return "off";
  if (!i || i.status !== "running") return i && i.status === "crashed" ? "bad" : "off";
  return exec === "working" ? "busy" : exec === "stuck" ? "warn" : "ok";
}
export { statusLabel };

/** Sign in, and come back here afterwards (the sign-in page accepts only the app's own pages). */
export function signInHref() {
  const here = typeof location !== "undefined" ? location.pathname + location.search : "/view";
  return `/signin?next=${encodeURIComponent(here)}`;
}

function Sidebar({ route, onNewInstance, viewOnly }) {
  const app = useStore(appStore);
  const shell = useStore(shellStore);
  const canCreate = useCanCreate();
  const on = (panel) => !!route && route.panel === panel;
  // A count badge is hidden at 0; its number is also in the link's accessible name.
  const navLink = (panel, href, icon, label, count = 0) => html`<a class=${`side-row${on(panel) ? " active" : ""}`} href=${href}
    aria-current=${on(panel) ? "page" : undefined} aria-label=${count ? `${label} (${t("app.needsCount", count)})` : undefined} onClick=${closeDrawer}>
    <${Icon} name=${icon} /><span class="grow">${label}</span>${count ? html`<span class="nav-count" aria-hidden="true">${count}</span>` : null}</a>`;
  const needsCount = Array.isArray(app.needs) ? app.needs.length : 0;
  // View-only (an anonymous reader, #1408 §3): View and a way to sign in — nothing that needs a session is rendered.
  if (viewOnly) {
    return html`<aside id="sidebar" class="sidebar" aria-label=${t("app.menu")}>
      <div class="side-head" data-trust="navigation">
        <a class="brand" href="/view" onClick=${closeDrawer}>${t("app.brand")}</a>
        <button type="button" class="icon-btn side-collapse" onClick=${toggleSidebar} aria-label=${narrow() ? t("app.closeMenu") : t("app.collapse")} title=${narrow() ? t("app.closeMenu") : t("app.collapse")} aria-controls="sidebar"><${Icon} name="sidebar" /></button>
      </div>
      <nav data-trust="navigation" class="side-nav" aria-label=${t("app.menu")}>${navLink("view", "/view", "view", t("app.view"))}</nav>
      ${shell.side ? html`<${shell.side.Component} />` : html`<${ViewOnlyNav} route=${route} />`}
      <div class="side-foot" data-trust="navigation">
        <a class="side-row" href=${signInHref()}><${Icon} name="user" /><span>${t("app.signIn")}</span></a>
        <${PrefsPopover} />
      </div>
      <${SidebarResize} />
    </aside>`;
  }
  // #1920 phase 3: a guest's sidebar — its own agents to pick from, who it is signed in as, and its session; no fleet,
  // Needs you, View, Settings, new agent or widget (each is an admin's, and the server refuses a guest them anyway).
  if (guestPage()) {
    return html`<aside id="sidebar" class="sidebar" aria-label=${t("app.menu")}>
      <div class="side-head" data-trust="navigation">
        <a class="brand" href="/ui" onClick=${closeDrawer}>${t("app.brand")}</a>
        <button type="button" class="icon-btn side-collapse" onClick=${toggleSidebar} aria-label=${narrow() ? t("app.closeMenu") : t("app.collapse")} title=${narrow() ? t("app.closeMenu") : t("app.collapse")} aria-controls="sidebar"><${Icon} name="sidebar" /></button>
      </div>
      <${InstanceNav} route=${route} items=${app.instances} loaded=${app.ready !== false} exec=${app.exec} awaiting=${app.awaiting} onPick=${closeDrawer} />
      <div class="side-foot" data-trust="navigation">
        <${GuestChip} />
        <${SessionMenu} />
      </div>
      <${SidebarResize} />
    </aside>`;
  }
  // #1675: the whole fleet, from anywhere — top left, so at the top of a phone's drawer too. #2183 (the user's call): the
  // one Fleet entry ("Fleet" / "Fleet 概覽"), on the tab this device used last (the Org chart the first time); an agent's
  // View, Log and Details are its header's tabs, so the sidebar has no "Fleet" (Details) or "View" row of its own.
  const onFleet = !!route && route.panel === "fleet";
  const overview = html`<a class=${`side-row side-overview${onFleet ? " active" : ""}`} href=${fleetEntryPath(route)}
    aria-current=${onFleet ? "page" : undefined} onClick=${closeDrawer}><${Icon} name="org" /><span class="grow">${t("app.fleetOverview")}</span></a>`;
  return html`<aside id="sidebar" class="sidebar" aria-label=${t("app.menu")}>
    <div class="side-head" data-trust="navigation">
      <a class="brand" href="/ui" onClick=${closeDrawer}>${t("app.brand")}</a>
      <button type="button" class="icon-btn side-collapse" onClick=${toggleSidebar} aria-label=${narrow() ? t("app.closeMenu") : t("app.collapse")} title=${narrow() ? t("app.closeMenu") : t("app.collapse")} aria-controls="sidebar"><${Icon} name="sidebar" /></button>
    </div>
    <nav data-trust="navigation" class="side-nav" aria-label=${t("app.menu")}>
      ${overview}
      ${navLink("needs", NEEDS_PATH, "inbox", t("app.needsNav"), needsCount)}
      ${searchOffered(canCreate) ? html`<button type="button" class="side-row side-search" onClick=${() => openSearch()} title=${t("app.searchTitle", searchShortcut())}
        aria-keyshortcuts=${isMacLike() ? "Meta+K" : "Control+K"}><${Icon} name="search" /><span class="grow">${t("app.search")}</span><kbd class="kbd-hint" aria-hidden="true">${searchShortcut()}</kbd></button>` : null}
      ${canCreate && onNewInstance ? html`<button type="button" class="side-row side-new" onClick=${onNewInstance}><${Icon} name="plus" /><span class="grow">${t("app.newAgent")}</span></button>` : null}
    </nav>
    ${shell.side ? html`<${shell.side.Component} />` : html`<${InstanceNav} route=${route} items=${app.instances} loaded=${app.ready !== false}
        exec=${app.exec} awaiting=${app.awaiting} onPick=${closeDrawer} />`}
    <${SidebarWidget} app=${app} />
    <div class="side-foot" data-trust="navigation">
      ${navLink("settings", settingsPath(), "settings", t("app.settings"))}
      <${SessionMenu} />
    </div>
    <${SidebarResize} />
  </aside>`;
}

/** #1920 phase 3: "Guest · <name> (<platform>)" — who this guest's page is signed in as; what a guest sees, in its title. */
const PLATFORM_NAMES = { discord: "Discord", telegram: "Telegram" };
function GuestChip() {
  const { name, platform } = guestBadge();
  const where = PLATFORM_NAMES[platform] || platform;
  const label = name ? (where ? t("app.guestAsOn", name, where) : t("app.guestAs", name)) : t("app.guestChip");
  // Inside .side-foot (a marked, stock-trusted element): no trust marker of its own — effect-stock-trust's closed inventory
  // refuses any element it does not know, which would hide a guest's static effect posters (#2101 review).
  return html`<p class="guest-chip" title=${t("app.guestHint")}><${Icon} name="user" size=${14} /><span class="grow">${label}</span></p>`;
}

/** #1629 r4-4: the person's own sidebar widget (their synced preference), with the fleet's counts. */
function SidebarWidget({ app }) {
  useStore(sidebarWidgetStore);
  const widget = sidebarWidget();
  return widget ? html`<div class="side-widget" data-trust="widget"><${AgentWidget} slot="sidebar" widget=${widget} binds=${fleetBinds(app.instances, app.exec, app.awaiting)} /></div>` : null;
}

/** The anonymous View reader's list: View's roster read (no status frames without a session), the same component. */
function ViewOnlyNav({ route }) {
  return html`<${RosterNav} route=${route} viewOnly=${true} onPick=${closeDrawer} />`;
}

/**
 * This browser's theme and language (#1604: Settings → This device; for the anonymous View reader, the footer's
 * popover). The same stores as ever: AgendTheme (theme.js) and setLang (app-i18n.js) — only where they are shown moved.
 */
export function DevicePrefs({ labels = false } = {}) {
  const [theme, setTheme] = useState(typeof AgendTheme !== "undefined" ? AgendTheme.get() : "system");
  const [l, setL] = useState(lang());
  const names = useStore(namesStore);   // #1722
  // #1665: what is in force, as it changes — another device's choice arriving while this is open is shown at once.
  useEffect(() => (typeof AgendTheme !== "undefined" && typeof AgendTheme.onChange === "function" ? AgendTheme.onChange(setTheme) : undefined), []);
  useEffect(() => onLang(setL), []);
  return html`<div class=${`prefs${labels ? " labelled" : ""}`}>
    <label class="pref"><${Icon} name="sun" size=${16} /><span class=${labels ? "pref-label" : "sr-only"}>${t("app.theme")}</span>
      <select value=${theme} aria-label=${t("app.theme")} onChange=${(e) => { setTheme(e.target.value); if (typeof AgendTheme !== "undefined") AgendTheme.set(e.target.value); savePref("theme", e.target.value); }}>
        <option value="system">${t("app.themeSystem")}</option><option value="light">${t("app.themeLight")}</option><option value="dark">${t("app.themeDark")}</option></select></label>
    <label class="pref"><${Icon} name="globe" size=${16} /><span class=${labels ? "pref-label" : "sr-only"}>${t("app.language")}</span>
      <select value=${l} aria-label=${t("app.language")} onChange=${(e) => { setL(e.target.value); setLang(e.target.value); savePref("lang", e.target.value); }}>
        <option value="en">English</option><option value="zh-TW">中文</option></select></label>
    <label class="pref"><${Icon} name="user" size=${16} /><span class=${labels ? "pref-label" : "sr-only"}>${t("app.names")}</span>
      <select value=${names.primary} aria-label=${t("app.names")} onChange=${(e) => setNamesPrimary(e.target.value)}>
        <option value="nickname">${t("app.namesNickname")}</option><option value="instance">${t("app.namesInstance")}</option></select></label>
  </div>`;
}

/** #1604: the anonymous View reader has no Settings: theme and language from one compact control beside Sign in. */
function PrefsPopover() {
  return html`<details class="prefs-pop">
    <summary class="icon-btn" aria-label=${t("app.devicePrefs")} title=${t("app.devicePrefs")}><${Icon} name="sun" /></summary>
    <div data-trust="popover" class="pop" role="group" aria-label=${t("app.devicePrefs")}><${DevicePrefs} labels=${true} /></div>
  </details>`;
}

/**
 * The header every panel shows: ☰ (phone, or a collapsed sidebar), its title and status, then its actions. `nav`
 * (#1523 N2): an instance page's view switch — beside the title on a wide screen, a row of tabs under it on a phone.
 */
export function PanelHeader({ title, sub, children, headingRef, nav, notice }) {
  const shell = useStore(shellStore);
  const admin = useCanCreate();
  const canCreate = admin && !!newInstanceOpener;
  return html`<header data-trust="header" class=${`panel-head${shell.collapsed ? " collapsed" : ""}`}>
    <button type="button" id="sbOpen" class="icon-btn sb-open" onClick=${() => (narrow() ? openDrawer() : toggleSidebar())}
      aria-label=${narrow() ? t("app.openMenu") : t("app.expand")} title=${narrow() ? t("app.openMenu") : t("app.expand")} aria-controls="sidebar" aria-expanded=${shell.drawer ? "true" : "false"}><${Icon} name="menu" /></button>
    ${canCreate && shell.collapsed ? html`<button type="button" class="icon-btn sb-new" onClick=${requestNewInstance} aria-label=${t("app.newAgent")} title=${t("app.newAgent")}><${Icon} name="plus" /></button>` : null}
    ${searchOffered(admin) ? html`<button type="button" class="icon-btn sb-search" onClick=${() => openSearch()} aria-label=${t("app.search")} title=${t("app.searchTitle", searchShortcut())}><${Icon} name="search" /></button>` : null}
    <div class="panel-title"><h1 ref=${headingRef} tabindex="-1">${title}</h1>${sub ? html`<div class="panel-sub">${sub}</div>` : null}</div>
    ${nav || null}
    <div class="panel-actions">${children}</div>
    ${notice || null}
  </header>`;
}

/**
 * #1523 N2: the instance a page is about — Chat, View, Log (#1218) or Details of it — or null. #2183: with one open, the
 * phone's Chat tab is current and goes to its chat.
 */
export function openInstanceOf(route) {
  return route && (route.panel === "chat" || route.panel === "view" || route.panel === "log" || route.panel === "details") && route.instance ? route.instance : null;
}

function BottomTabs({ route, viewOnly }) {
  const app = useStore(appStore);
  let last = null;
  try { last = localStorage.getItem("agend_last_instance"); } catch { /* none */ }
  const open = openInstanceOf(route);
  // #2183: Chat stands for the open agent's pages (its View, Log and Details are the tabs under its header), so it goes to that agent's chat.
  const chatHref = open ? chatPath(open) : last ? chatPath(last) : "/ui";
  const anyAwaiting = Object.keys(app.awaiting).length;
  const tab = (href, icon, label, active, badge, badgeLabel) => html`<a class=${`tab${active ? " active" : ""}`} href=${href} aria-current=${active ? "page" : undefined}>
    <${Icon} name=${icon} size=${20} /><span>${label}</span>${badge ? html`<span class="tab-badge" aria-label=${badgeLabel || t("app.needsYou")}>${badge}</span>` : null}</a>`;
  if (viewOnly) {
    let lastView = null;
    try { lastView = localStorage.getItem("agend_last_view"); } catch { /* none */ }
    const viewHref = route && route.panel === "view" && route.instance ? viewPath(route.instance) : viewPath(lastView);
    return html`<nav data-trust="navigation" class="tabs" aria-label=${t("app.menu")}>
      ${tab(viewHref, "view", t("app.view"), route && route.panel === "view")}
      ${tab(signInHref(), "user", t("app.signIn"), false)}
    </nav>`;
  }
  // #1920: a guest has only its chats (the drawer lists them): no tabs to switch between.
  if (guestPage()) return null;
  // #2183 (the user's call): four tabs — Chat (current on /ui and on any of an agent's pages), Needs you, Fleet (on its
  // last tab), Settings.
  return html`<nav data-trust="navigation" class="tabs" aria-label=${t("app.menu")}>
    ${tab(chatHref, "chat", t("app.chat"), !!open || (!!route && route.panel === "chat"), anyAwaiting)}
    ${tab(NEEDS_PATH, "inbox", t("app.needsTab"), route && route.panel === "needs", (app.needs || []).length, t("app.needsCount", (app.needs || []).length))}
    ${tab(fleetEntryPath(route), "fleet", t("app.fleet"), route && route.panel === "fleet")}
    ${tab(settingsPath(), "settings", t("app.settings"), route && route.panel === "settings")}
  </nav>`;
}

function ConnectionLine() {
  const { connection, hydration, retryHydration } = useStore(appStore);
  // A late catch-up that is not done: the chat may be missing what was open before it loaded (#1425 review).
  if (hydration === "retrying" || hydration === "failed") {
    return html`<div data-trust="status" class="conn" role="status">${hydration === "failed" ? t("app.hydrateFailed") : t("app.hydrating")}
      ${hydration === "failed" && retryHydration ? html` <button type="button" class="btn btn-sm" onClick=${() => retryHydration()}>${t("app.retry")}</button>` : null}</div>`;
  }
  if (connection === "reconnecting") return html`<${Reconnecting} />`;
  // #1603: polling is a working transport (the public link polls by design; a buffering proxy makes a page poll), not
  // a fault — messages still arrive, at most ~5 s late, and there is nothing to do: no strip. Live, none, and ended
  // (agend-auth's banner says that) draw nothing either; only reconnecting and a failed catch-up are shown.
  return null;
}

/** A connected fleet is still bringing up agents; this is distinct from the reconnect banner. */
export function StartupLine() {
  const { startup } = useStore(appStore);
  if (!startup) return null;
  return html`<div data-trust="status" class="conn fleet-starting" role="status">${t("app.fleetStarting", startup.ready, startup.total)}</div>`;
}
/** #1580: the fleet is not answering (a restart): said, with when the next try is — never a silent stale page. */
function Reconnecting() {
  const { retryAt } = useStore(appStore);
  useTick(true);
  const s = typeof retryAt === "number" ? Math.max(0, Math.ceil((retryAt - NOW()) / 1000)) : 0;
  return html`<div data-trust="status" class="conn reconnecting" role="status">${s > 0 ? t("app.connReconnectingIn", s) : t("app.connReconnecting")}</div>`;
}

const NOW = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
function useTick(on, ms = 1000) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const h = setInterval(() => tick(n => n + 1), ms);
    return () => clearInterval(h);
  }, [on, ms]);
}
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/**
 * #1423: Settings writes an admin has to confirm, from whichever panel made them (settings-confirm.js publishes them to
 * appStore.pendingChanges). What it asks, how to confirm it, the countdown, Withdraw — in any panel: a card in the
 * corner, except in Settings itself, which shows the same cards in its column, right under the operation (`inline`),
 * so they never cover it (alpha.2 sweep).
 */
export function PendingChanges({ inline = false } = {}) {
  const { pendingChanges } = useStore(appStore);
  const list = pendingChanges || [];
  useTick(list.some(p => p.state === "pending"));
  // #2168: inline (Settings' own column), a request that has just started waiting is brought into view — on a phone the
  // person applied far down the list, and the card that says where to confirm it sat above the screen. Once per request.
  const box = useRef(null), shown = useRef(new Set());
  useEffect(() => {
    if (!inline || !box.current) return;
    for (const p of list) {
      if (p.state !== "pending" || shown.current.has(p.id)) continue;
      shown.current.add(p.id);
      const card = box.current.querySelector(`[data-pending="${p.id}"]`);
      const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (card && typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
    }
  });
  if (!list.length) return null;
  return html`<div data-trust="confirmation" ref=${box} class=${`pending-stack${inline ? " inline" : ""}`} role="region" aria-label=${t("app.pendingTitle")}>${list.map(p => html`<section key=${p.id} data-pending=${p.id} class=${`pending-card ${p.state}`} role="status">
    <div class="pending-head"><${Icon} name=${p.state === "applied" ? "check" : p.state === "pending" || p.state === "applying" ? "clock" : "alert"} size=${16} />
      <strong>${t(`app.pending_${p.state}`)}</strong>
      ${p.state === "pending" ? html`<span class="pending-left">${t("app.pendingLeft", mmss(p.deadline - NOW()))}</span>` : null}
      ${p.dismiss ? html`<button type="button" class="icon-btn" aria-label=${t("app.close")} title=${t("app.close")} onClick=${p.dismiss}><${Icon} name="close" size=${14} /></button>` : null}</div>
    ${p.label ? html`<div class="pending-label">${p.label}</div>` : null}
    ${Array.isArray(p.summary) && p.summary.length ? html`<ul class="pending-summary">${p.summary.map((line, i) => html`<li key=${i}>${line}</li>`)}</ul>` : null}
    ${p.state === "pending" ? html`<p class="note">${p.confirmation && p.confirmation.kind === "host_cli" ? t("app.pendingHost", `agend settings confirm ${p.id}`) : t("app.pendingChat")}</p>` : null}
    ${(p.state === "applying" || p.state === "applied") && p.confirmation && p.confirmation.kind === "web" ? html`<p class="note">${t("app.pendingWeb")}</p>` : null}
    ${p.state !== "pending" && p.state !== "applying" && p.state !== "applied" && p.outcome && p.outcome.message ? html`<p class="note">${p.outcome.message}</p>` : null}
    ${p.withdraw ? html`<div class="pending-actions"><button type="button" class="btn btn-sm" onClick=${p.withdraw}>${t("app.withdraw")}</button></div>` : null}
  </section>`)}</div>`;
}

/** Settings' Apply, followed from another panel: one line, and the way back to it (§5: progress shows in any panel). */
function OperationLine({ route }) {
  const { settingsOp: op } = useStore(appStore);
  if (!op || (route && route.panel === "settings")) return null;
  const waiting = op.steps.some(s => s.status === "waiting");
  const done = op.steps.filter(s => s.status === "done").length;
  const restart = op.job && op.job.targets && op.job.targets.some(r => r.status === "restart-required");
  const failedRows = op.job && op.job.targets && op.job.targets.some(r => r.status === "failed");
  const text = op.phase === "writing" ? (waiting ? t("app.opWaiting") : t("app.opWriting", done, op.steps.length))
    : op.phase === "posting" || op.phase === "watching" ? t("app.opApplying")
    : op.phase === "failed" ? t("app.opFailed") : restart ? t("app.opRestart") : failedRows ? t("app.opPartial") : t("app.opDone");
  const busy = op.phase === "writing" || op.phase === "posting" || op.phase === "watching";
  return html`<div data-trust="status" class=${`conn op-line${busy ? "" : op.phase === "failed" || restart || failedRows ? " bad" : " ok"}`} role="status">
    <span>${text}</span> <a class="btn btn-sm" href=${settingsPath()}>${t("app.openSettings")}</a></div>`;
}

/**
 * A module loader that can be tried again: a failed attempt is forgotten (the next call loads afresh) and `attempt`
 * counts, so a retry can ask for a new URL — a browser may keep a failed module import cached under the old one.
 */
export function retryable(load) {
  let pending = null, attempt = 0;
  return () => (pending ??= load(attempt++).catch((err) => { pending = null; throw err; }));
}

/** Shows the panel for the route, loading its module the first time; Retry is a real new attempt. */
function Outlet({ route, seq, panels }) {
  const [attempt, setAttempt] = useState(0);
  const [, force] = useState(0);
  const entry = route ? panels.get(route.panel) : null;
  useEffect(() => {
    if (entry && !entry.Component && !entry.loading) {
      entry.error = null;
      entry.loading = entry.load().then(C => { entry.Component = C; entry.error = null; }, err => { entry.error = err; }).finally(() => { entry.loading = null; force(n => n + 1); });
      force(n => n + 1);
    }
  }, [entry, seq, attempt]);
  if (!route) return html`<div class="panel"><${ErrorState} message=${t("app.loadFailed")} /></div>`;
  if (entry && entry.error && !entry.loading) return html`<div class="panel"><${ErrorState} onRetry=${() => setAttempt(n => n + 1)} /></div>`;
  if (!entry || !entry.Component) return html`<div class="panel"><${Skeleton} lines=${4} /></div>`;
  const C = entry.Component;
  return html`<${C} route=${route} navKey=${`${routeKey(route)}|${seq}|${lang()}`} />`;
}

/**
 * #2196: the open agent's colours on the whole page (its theme's page section, or a person's choice), drawn on the
 * shell in the same render that opens it — no fetch (the themes are on the page already), no flash, colours only, so
 * no layout moves. Redrawn when the themes, the person's choices, the viewer's switch or the light/dark mode move.
 */
function usePageTheme(ref, route) {
  useStore(themesStore);
  const [, bump] = useState(0);
  useEffect(() => onPrefsChanged((changed) => { if (changed.has("theme.pageByInstance") || changed.has("fx.show")) bump((n) => n + 1); }), []);
  useEffect(() => {
    const T = globalThis.AgendTheme;
    const off = T && typeof T.onChange === "function" ? T.onChange(() => bump((n) => n + 1)) : null;
    let mq = null;
    try { mq = globalThis.matchMedia ? globalThis.matchMedia("(prefers-color-scheme: light)") : null; } catch { mq = null; }
    const onMq = () => bump((n) => n + 1);
    if (mq && typeof mq.addEventListener === "function") mq.addEventListener("change", onMq);
    return () => { if (typeof off === "function") off(); if (mq && typeof mq.removeEventListener === "function") mq.removeEventListener("change", onMq); };
  }, []);
  const mode = resolvedMode();
  const p = pageNow(mode, route);
  const key = p ? `${mode}|${JSON.stringify(p)}` : "";
  useLayoutEffect(() => { applyPageTheme(ref.current, p, mode); }, [key]);
  // #2199: the agent open now, as body[data-agent] — for a person's own custom CSS to follow (body[data-agent="x"]
  // { --bg-sidebar: … }); set and cleared in the same render as the page colours, whatever the themes switch says.
  const agent = openInstanceOf(route);
  useLayoutEffect(() => {
    const body = typeof document !== "undefined" ? document.body : null;
    if (!body || !body.dataset) return;
    if (agent) body.dataset.agent = agent; else delete body.dataset.agent;
  }, [agent]);
}

/** #2478: how far short of its tallest the view must be, with a text field focused, to be a keyboard (not a browser bar). */
export const KEYBOARD_MIN_PX = 150;
/** #2478: the on-screen keyboard is up — something is being typed into, and the view is well short of its tallest. */
export function keyboardUp(height, tallest, typing) { return !!typing && tallest - height > KEYBOARD_MIN_PX; }
const NOT_TYPED = /^(button|checkbox|radio|range|color|file|submit|reset|image|hidden)$/i;
/** #2478: an element the keyboard types into — a textarea, a text-like input, or an editable region. */
export function isTextEntry(el) {
  if (!el || !el.tagName) return false;
  const tag = String(el.tagName).toUpperCase();
  if (tag === "TEXTAREA") return !el.readOnly && !el.disabled;
  if (tag === "INPUT") return !NOT_TYPED.test(el.type || "text") && !el.readOnly && !el.disabled;
  return el.isContentEditable === true;
}

export function Shell({ panels, onNewInstance, viewOnly = false }) {
  const nav = useStore(navStore);
  const shell = useStore(shellStore);
  const root = useRef(null);
  usePageTheme(root, nav.route);
  const [, relang] = useState(0);
  // A language switch re-renders everything and gives the panel a new lease (its key includes the language).
  useEffect(() => onLang(() => relang(n => n + 1)), []);
  useEffect(() => { closeDrawer(); }, [nav.seq]);
  // The bottom tabs (and the line under the composer) give their room to the keyboard on a phone (#2478).
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv || typeof document === "undefined") return undefined;
    // The tallest the view has been at this width: what it is with no keyboard. innerHeight is no measure on its own —
    // it shrinks with the keyboard on iOS Safari and, under interactive-widget=resizes-content, on Android — so
    // innerHeight − height stayed near 0 and the strips stayed between the composer and the keyboard.
    // Only a touch screen (a coarse pointer) has an on-screen keyboard: a narrow desk window made shorter is not one.
    // Turned with the keyboard up and the field still focused, the new width has no height without it yet: the keyboard
    // stays up until the field is left, or the view grows from its lowest by more than a keyboard (put away).
    let width = -1, tallest = 0, held = false, lowest = 0;
    const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    const check = () => {
      const w = Math.round(vv.width), h = vv.height;
      const typing = coarse() && isTextEntry(document.activeElement);
      if (w !== width) {                                              // turned, or a new width: measured again
        held = width !== -1 && typing && shellStore.get().keyboard;
        width = w; tallest = 0; lowest = h;
      }
      if (held) {
        lowest = Math.min(lowest, h);
        if (!typing || h - lowest > KEYBOARD_MIN_PX) held = false;    // left the field, or the keyboard was put away
      }
      if (!held) tallest = Math.max(tallest, window.innerHeight || 0, typing ? 0 : h);   // the view itself only when not typing
      const up = held || keyboardUp(h, tallest, typing);
      if (up !== shellStore.get().keyboard) shellStore.set({ keyboard: up });
    };
    check();
    vv.addEventListener("resize", check);
    document.addEventListener("focusin", check);
    document.addEventListener("focusout", check);
    return () => { vv.removeEventListener("resize", check); document.removeEventListener("focusin", check); document.removeEventListener("focusout", check); };
  }, []);
  const guest = guestPage();             // #1920: a guest's page — no operations, usage, pending changes or owner CSS
  const cls = ["shell", shell.collapsed ? "sb-collapsed" : "", shell.drawer ? "sb-open" : "", shell.keyboard ? "kb-open" : "", guest ? "guest" : ""].filter(Boolean).join(" ");
  return html`<div ref=${root} class=${cls}>
    <a data-trust="navigation" class="skip" href="#main">${t("app.skip")}</a>
    <${Sidebar} route=${nav.route} onNewInstance=${onNewInstance} viewOnly=${viewOnly} />
    <div class="scrim" onClick=${closeDrawer} aria-hidden="true"></div>
    <main id="main" class="main" tabindex="-1" inert=${shell.drawer && narrow() ? true : undefined}>
      <${ConnectionLine} />
      <${StartupLine} />
      ${viewOnly || guest ? null : html`<${OperationLine} route=${nav.route} />`}
      ${viewOnly || guest || !shell.banner ? null : html`<${shell.banner} />`}
      <${Outlet} route=${nav.route} seq=${nav.seq} panels=${panels} />
    </main>
    ${guest ? null : html`<${UsageRail} route=${nav.route} />`}
    <${BottomTabs} route=${nav.route} viewOnly=${viewOnly} />
    ${shell.dialog ? html`<${shell.dialog.Component} ...${shell.dialog.props} onClose=${closeDialog} />` : null}
    ${viewOnly || guest || (nav.route && nav.route.panel === "settings") ? null : html`<${PendingChanges} />`}
    <${ConfirmHost} />
    <${ColorDialogHost} />
    ${viewOnly || guest ? null : html`<${OwnerCssKeepBar} />`}
    <${Toasts} />
  </div>`;
}

