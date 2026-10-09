// #1408 §2/§7: the app's frame — the sidebar (a drawer on a phone), the main area with its panel, the bottom tabs on a
// phone, the connection line, toasts. Panels render their own header through <PanelHeader>, so every panel's title,
// status and ⋯ actions sit in the same place.
import { html, useEffect, useState } from "./app-html.js";
import { Icon } from "./ui-icons.js";
import { Toasts } from "./ui-toast.js";
import { t, lang, setLang, onLang } from "./app-i18n.js";
import { appStore, createStore, useStore } from "./app-store.js";
import { navStore } from "./app-nav.js";
import { chatPath, viewPath, routeKey } from "./app-route.js";
import { SessionMenu } from "./app-session.js";
import { ErrorState, Skeleton } from "./ui-states.js";

/** Shell state shared with panels: the phone drawer, the collapsed sidebar, extensions a panel module adds. */
export const shellStore = createStore({ drawer: false, collapsed: readCollapsed(), footer: [], keyboard: false, dialog: null, side: null });

/**
 * The mounted panel's own sidebar section, in place of the instance list (View's roster: its groups, filter and order,
 * #1408 step 2). Returns the function that takes it away; take it through the panel's lease.
 */
export function setSideSection(Component) {
  const entry = { Component };
  shellStore.set({ side: entry });
  return () => { if (shellStore.get().side === entry) shellStore.set({ side: null }); };
}

/** An app-level dialog (New instance): rendered by the shell until closed, whatever panel is showing. */
export function showDialog(Component, props = {}) { shellStore.set({ dialog: { Component, props } }); }
export function closeDialog() { shellStore.set({ dialog: null }); }

function readCollapsed() { try { return localStorage.getItem("agend_sidebar") === "hidden"; } catch { return false; } }
const narrow = () => typeof matchMedia === "function" && matchMedia("(max-width: 899px)").matches;

export function openDrawer() { shellStore.set({ drawer: true }); }
export function closeDrawer() { if (shellStore.get().drawer) shellStore.set({ drawer: false }); }
export function toggleSidebar() {
  if (narrow()) { shellStore.set(s => ({ ...s, drawer: !s.drawer })); return; }
  const collapsed = !shellStore.get().collapsed;
  shellStore.set({ collapsed });
  try { localStorage.setItem("agend_sidebar", collapsed ? "hidden" : "shown"); } catch { /* this page only */ }
}
/** A panel module adds a control to the sidebar footer (the chat adds the preview opt-in and the tour). */
export function addFooterItem(key, Component) {
  shellStore.set(s => ({ ...s, footer: [...s.footer.filter(x => x.key !== key), { key, Component }] }));
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
export function setTitle(text) { if (typeof document !== "undefined") document.title = text ? `${text} · AgEnD` : "AgEnD"; }

// ── The parts ──

function statusLabel(i, exec, awaiting) {
  if (awaiting != null) return t("app.needsYou");
  if (i.status !== "running") return i.status === "crashed" ? t("app.statusCrashed") : t("app.statusStopped");
  if (exec === "working") return t("app.statusWorking");
  if (exec === "stuck") return t("app.statusStuck");
  return t("app.statusIdle");
}
export function statusClass(i, exec, awaiting) {
  if (awaiting != null) return "warn";
  if (!i || i.status !== "running") return i && i.status === "crashed" ? "bad" : "off";
  return exec === "working" ? "busy" : exec === "stuck" ? "warn" : "ok";
}
export { statusLabel };

function tooltip(i) {
  const src = (s) => (s === "instance" || s === "classic" ? "configured" : s === "fleet-default" ? "fleet default" : s);
  const model = i.model ? (i.model_source === "live" || i.model_source === "cli-default" || i.model_source === "unresolved" ? i.model : `${i.model} (${src(i.model_source)})`) : null;
  const effort = i.effort ? `effort:${i.effort}${i.effort_source ? ` (${src(i.effort_source)})` : ""}` : null;
  const ctx = i.context_pct != null ? `ctx:${Math.round(i.context_pct)}%` : null;
  const cost = i.cost > 0 ? `$${i.cost.toFixed(2)}` : null;
  return [i.name, i.backend, model, effort, ctx, cost, i.status].filter(Boolean).join(" · ");
}

function InstanceRow({ i, active, exec, awaiting }) {
  const alias = typeof i.display_name === "string" && i.display_name.trim() && i.display_name.trim() !== i.name ? i.display_name.trim() : "";
  const cls = statusClass(i, exec, awaiting);
  // Two lines: the name (never shortened to make room for a badge, #1408 rough edge 6), then the alias and/or
  // "needs you". Everything else is in the tooltip.
  return html`<li><a class=${`inst${active ? " active" : ""}`} href=${chatPath(i.name)} title=${tooltip(i)} aria-current=${active ? "page" : undefined}
      onClick=${closeDrawer}>
    <span class=${`dot ${cls}`} aria-hidden="true"></span>
    <span class="inst-text"><span class="inst-name">${i.name}</span>
      ${alias || awaiting != null ? html`<span class="inst-sub">${alias ? html`<span class="inst-alias">${alias}</span>` : null}
        ${awaiting != null ? html`<span class="badge-await" title=${awaiting || t("app.approxNote")}>${t("app.needsYou")}</span>` : null}</span>` : null}
      <span class="sr-only">${statusLabel(i, exec, awaiting)}</span></span></a></li>`;
}

/** Sign in, and come back here afterwards (the sign-in page accepts only the app's own pages). */
export function signInHref() {
  const here = typeof location !== "undefined" ? location.pathname + location.search : "/view";
  return `/signin?next=${encodeURIComponent(here)}`;
}

function Sidebar({ route, onNewInstance, viewOnly }) {
  const app = useStore(appStore);
  const shell = useStore(shellStore);
  const current = route && route.panel === "chat" ? route.instance : null;
  const on = (panel) => !!route && route.panel === panel;
  const navLink = (panel, href, icon, label) => html`<a class=${`side-row${on(panel) ? " active" : ""}`} href=${href}
    aria-current=${on(panel) ? "page" : undefined} onClick=${closeDrawer}><${Icon} name=${icon} /><span>${label}</span></a>`;
  // View-only (an anonymous reader, #1408 §3): View and a way to sign in — nothing that needs a session is rendered.
  if (viewOnly) {
    return html`<aside id="sidebar" class="sidebar" aria-label=${t("app.menu")}>
      <div class="side-head">
        <a class="brand" href="/view" onClick=${closeDrawer}>${t("app.brand")}</a>
        <button type="button" class="icon-btn side-collapse" onClick=${toggleSidebar} aria-label=${narrow() ? t("app.closeMenu") : t("app.collapse")} title=${narrow() ? t("app.closeMenu") : t("app.collapse")} aria-controls="sidebar"><${Icon} name="sidebar" /></button>
      </div>
      <nav class="side-nav" aria-label=${t("app.menu")}>${navLink("view", "/view", "view", t("app.view"))}</nav>
      ${shell.side ? html`<${shell.side.Component} />` : html`<div class="side-section"></div>`}
      <div class="side-foot">
        <${Prefs} />
        <a class="side-row" href=${signInHref()}><${Icon} name="user" /><span>${t("app.signIn")}</span></a>
      </div>
    </aside>`;
  }
  return html`<aside id="sidebar" class="sidebar" aria-label=${t("app.menu")}>
    <div class="side-head">
      <a class="brand" href="/ui" onClick=${closeDrawer}>${t("app.brand")}</a>
      <button type="button" class="icon-btn side-collapse" onClick=${toggleSidebar} aria-label=${narrow() ? t("app.closeMenu") : t("app.collapse")} title=${narrow() ? t("app.closeMenu") : t("app.collapse")} aria-controls="sidebar"><${Icon} name="sidebar" /></button>
      <button type="button" class="icon-btn" onClick=${onNewInstance} aria-label=${t("app.newInstance")} title=${t("app.newInstance")}><${Icon} name="edit" /></button>
    </div>
    <nav class="side-nav" aria-label=${t("app.menu")}>
      ${navLink("fleet", "/ui/fleet", "fleet", t("app.fleet"))}
      ${navLink("view", "/view", "view", t("app.view"))}
    </nav>
    ${shell.side ? html`<${shell.side.Component} />` : html`<div class="side-section" id="instanceList">
      <h2 class="side-label">${t("app.instances")}</h2>
      ${app.instances.length ? html`<ul class="inst-list">${app.instances.map(i => html`<${InstanceRow} key=${i.name} i=${i} active=${i.name === current}
          exec=${app.exec[i.name]} awaiting=${Object.prototype.hasOwnProperty.call(app.awaiting, i.name) ? app.awaiting[i.name] : null} />`)}</ul>`
        : html`<p class="side-empty">${t("app.noInstances")}</p>`}
    </div>`}
    <div class="side-foot">
      <a class="side-row" href="/settings"><${Icon} name="settings" /><span>${t("app.settings")}</span></a>
      ${shell.footer.map(({ key, Component }) => html`<${Component} key=${key} />`)}
      <${Prefs} />
      <${SessionMenu} />
    </div>
  </aside>`;
}

function Prefs() {
  const [theme, setTheme] = useState(typeof AgendTheme !== "undefined" ? AgendTheme.get() : "system");
  const [l, setL] = useState(lang());
  return html`<div class="prefs">
    <label class="pref"><${Icon} name="sun" size=${16} /><span class="sr-only">${t("app.theme")}</span>
      <select value=${theme} aria-label=${t("app.theme")} onChange=${(e) => { setTheme(e.target.value); if (typeof AgendTheme !== "undefined") AgendTheme.set(e.target.value); }}>
        <option value="system">${t("app.themeSystem")}</option><option value="light">${t("app.themeLight")}</option><option value="dark">${t("app.themeDark")}</option></select></label>
    <label class="pref"><${Icon} name="globe" size=${16} /><span class="sr-only">${t("app.language")}</span>
      <select value=${l} aria-label=${t("app.language")} onChange=${(e) => { setL(e.target.value); setLang(e.target.value); }}>
        <option value="en">English</option><option value="zh-TW">中文</option></select></label>
  </div>`;
}

/** The header every panel shows: ☰ (phone, or a collapsed sidebar), its title and status, then its actions. */
export function PanelHeader({ title, sub, children, headingRef }) {
  const shell = useStore(shellStore);
  return html`<header class=${`panel-head${shell.collapsed ? " collapsed" : ""}`}>
    <button type="button" class="icon-btn sb-open" onClick=${() => (narrow() ? openDrawer() : toggleSidebar())}
      aria-label=${narrow() ? t("app.openMenu") : t("app.expand")} title=${narrow() ? t("app.openMenu") : t("app.expand")} aria-controls="sidebar" aria-expanded=${shell.drawer ? "true" : "false"}><${Icon} name="menu" /></button>
    <div class="panel-title"><h1 ref=${headingRef} tabindex="-1">${title}</h1>${sub ? html`<div class="panel-sub">${sub}</div>` : null}</div>
    <div class="panel-actions">${children}</div>
  </header>`;
}

function BottomTabs({ route, viewOnly }) {
  const app = useStore(appStore);
  let last = null;
  try { last = localStorage.getItem("agend_last_instance"); } catch { /* none */ }
  const chatHref = route && route.panel === "chat" && route.instance ? chatPath(route.instance) : last ? chatPath(last) : "/ui";
  const anyAwaiting = Object.keys(app.awaiting).length;
  const tab = (href, icon, label, active, badge) => html`<a class=${`tab${active ? " active" : ""}`} href=${href} aria-current=${active ? "page" : undefined}>
    <${Icon} name=${icon} size=${20} /><span>${label}</span>${badge ? html`<span class="tab-badge" aria-label=${t("app.needsYou")}>${badge}</span>` : null}</a>`;
  let lastView = null;
  try { lastView = localStorage.getItem("agend_last_view"); } catch { /* none */ }
  const viewHref = route && route.panel === "view" && route.instance ? viewPath(route.instance) : viewPath(lastView);
  if (viewOnly) {
    return html`<nav class="tabs" aria-label=${t("app.menu")}>
      ${tab(viewHref, "view", t("app.view"), route && route.panel === "view")}
      ${tab(signInHref(), "user", t("app.signIn"), false)}
    </nav>`;
  }
  return html`<nav class="tabs" aria-label=${t("app.menu")}>
    ${tab(chatHref, "chat", t("app.chat"), route && route.panel === "chat", anyAwaiting)}
    ${tab("/ui/fleet", "fleet", t("app.fleet"), route && route.panel === "fleet")}
    ${tab(viewHref, "view", t("app.view"), route && route.panel === "view")}
    ${tab("/settings", "settings", t("app.settings"), false)}
  </nav>`;
}

function ConnectionLine() {
  const { connection, hydration, retryHydration } = useStore(appStore);
  // A late catch-up that is not done: the chat may be missing what was open before it loaded (#1425 review).
  if (hydration === "retrying" || hydration === "failed") {
    return html`<div class="conn" role="status">${hydration === "failed" ? t("app.hydrateFailed") : t("app.hydrating")}
      ${hydration === "failed" && retryHydration ? html` <button type="button" class="btn btn-sm" onClick=${() => retryHydration()}>${t("app.retry")}</button>` : null}</div>`;
  }
  if (connection === "live" || connection === "none") return null;
  const text = connection === "polling" ? t("app.connPolling") : connection === "down" ? t("app.connDown") : null;
  return text ? html`<div class="conn" role="status">${text}</div>` : null;
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

export function Shell({ panels, onNewInstance, viewOnly = false }) {
  const nav = useStore(navStore);
  const shell = useStore(shellStore);
  const [, relang] = useState(0);
  // A language switch re-renders everything and gives the panel a new lease (its key includes the language).
  useEffect(() => onLang(() => relang(n => n + 1)), []);
  useEffect(() => { closeDrawer(); }, [nav.seq]);
  // The bottom tabs give their room to the keyboard on a phone.
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return undefined;
    const onResize = () => shellStore.set({ keyboard: window.innerHeight - vv.height > 150 });
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);
  const cls = ["shell", shell.collapsed ? "sb-collapsed" : "", shell.drawer ? "sb-open" : "", shell.keyboard ? "kb-open" : ""].filter(Boolean).join(" ");
  return html`<div class=${cls}>
    <a class="skip" href="#main">${t("app.skip")}</a>
    <${Sidebar} route=${nav.route} onNewInstance=${onNewInstance} viewOnly=${viewOnly} />
    <div class="scrim" onClick=${closeDrawer} aria-hidden="true"></div>
    <main id="main" class="main" tabindex="-1" inert=${shell.drawer && narrow() ? true : undefined}>
      <${ConnectionLine} />
      <${Outlet} route=${nav.route} seq=${nav.seq} panels=${panels} />
    </main>
    <${BottomTabs} route=${nav.route} viewOnly=${viewOnly} />
    ${shell.dialog ? html`<${shell.dialog.Component} ...${shell.dialog.props} onClose=${closeDialog} />` : null}
    <${Toasts} />
  </div>`;
}

