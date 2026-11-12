// #1408 §3: navigation without reloads. Links stay real <a href>s; a plain left click on one that names a route of the
// app is taken over (pushState), and Back/Forward follow (popstate). A modified or middle click, a download, another
// origin, or a path that is not a page of the app is left to the browser.
// Every navigation bumps `seq`: panels key their lease (app-ctx.js) on the route, so work from the route left behind
// can no longer land.
// A panel with work that leaving would lose (Settings' staged changes, §5) sets a leave guard: every navigation of
// the app asks it first, Back/Forward included (the address bar is put back when it says no).
import { parseRoute, legacyHashTarget, legacySettingsTarget } from "./app-route.js";
import { createStore } from "./app-store.js";

export const navStore = createStore({ route: null, seq: 0 });

let win = null;
let guard = null;
const paneGuards = new Set();
let here = null;                                 // the path the app shows now (popstate has already changed the address)
let navigation = null;
// Optional, versioned host. Older assets have no host and keep the original single-panel route and history.
export function installNavigation(host) {
  if (navigation) throw new Error("navigation host already installed");
  navigation = host;
  // Installation alone must not retire the current panel/lease. The host restores an explicit URL through navigate,
  // which runs the same leave guards before its first mounted layout is published.
  return () => { if (navigation === host) navigation = null; };
}
function target(url, mode, opts = {}) {
  return navigation?.resolve(url, navStore.get(), { mode, opts }) || { route: parseRoute(url.pathname), path: url.pathname + url.search + url.hash };
}
function publish(next) {
  navigation?.beforePublish?.(next, navStore.get());
  navStore.set(s => ({ ...next, seq: s.seq + 1 }));
}

/**
 * `fn(route, path)` → false keeps the app where it is. A guard that has to ask (the app's own dialog, which answers
 * later) returns false at once and, on a yes, goes on with `navigate(path, { force: true })`. One guard at a time;
 * returns the remover, which only removes this one.
 */
export function setLeaveGuard(fn) {
  guard = fn;
  return () => { if (guard === fn) guard = null; };
}
/** Pane guards coexist; disposing one never removes another pane's staged-change protection. */
export function addLeaveGuard(fn) { paneGuards.add(fn); return () => paneGuards.delete(fn); }
const mayLeave = (route, path, skip, next) => (!guard || guard === skip || guard(route, path, next) !== false)
  && [...paneGuards].every(fn => fn === skip || fn(route, path, next) !== false);

/** Start following the address bar. An old /ui#instance=<name> link becomes /ui/chat/<name> before the first render. */
export function startRouter(w = window) {
  win = w;
  let legacy = legacyHashTarget(w.location.pathname, w.location.hash) || legacySettingsTarget(w.location.pathname);
  // An old Settings address with a place of its own (/settings/web#guests) keeps it when its new one names none.
  if (legacy && w.location.hash && !legacy.includes("#") && legacySettingsTarget(w.location.pathname)) legacy += w.location.hash;
  if (legacy) w.history.replaceState(null, "", legacy);
  here = w.location.pathname + w.location.search;
  if (navigation) publish(target(new URL(w.location.href), "restore"));
  else navStore.set({ route: parseRoute(w.location.pathname), seq: 1 });
  w.addEventListener("popstate", () => {
    const next = target(new URL(w.location.href), "restore");
    if (!mayLeave(next.route, next.path, null, next)) { w.history.pushState(null, "", here); return; }
    here = next.path;
    if (navigation) publish(next); else navStore.set(s => ({ route: next.route, seq: s.seq + 1 }));
  });
  w.document.addEventListener("click", onLinkClick);
}

/** Go to `path`. A path that is not a route of the app is a full load. `force` skips the leave guard (it said yes). */
export function navigate(path, opts = {}) {
  let url = new URL(path, win.location.href);
  // #2347: an old Settings address goes to its section's new one.
  const moved = url.origin === win.location.origin ? legacySettingsTarget(url.pathname) : null;
  if (moved) { const hash = url.hash; url = new URL(moved, win.location.href); if (!url.hash && hash) url.hash = hash; }
  const route = parseRoute(url.pathname);
  if (!route || url.origin !== win.location.origin) { win.location.assign(url.href); return; }
  const next = target(url, "navigate", opts);
  if (navigation) url = new URL(next.path, win.location.href);
  const workspaceChange = navStore.get().workspace || next.workspace;
  if (!opts.force && !mayLeave(next.route, url.pathname + url.search + (workspaceChange ? url.hash : ""), opts.skipGuard, next)) return;
  if (url.pathname + url.search !== win.location.pathname + win.location.search || (url.hash && url.hash !== win.location.hash)) {
    win.history[opts.replace ? "replaceState" : "pushState"](null, "", url.pathname + url.search + url.hash);
  }
  here = url.pathname + url.search;
  if (navigation) publish(next); else navStore.set(s => ({ route, seq: s.seq + 1 }));
}

/** The same route again (Retry, a language switch): a new lease, no history entry. */
export function renavigate() { navStore.set(s => navigation?.refresh?.(s) || ({ route: s.route, seq: s.seq + 1 })); }

export function onLinkClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
  if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
  // A link to a place on this page (the skip link, #main) is the browser's: it moves focus and scrolls, and is not
  // a navigation of the app (#1425 review).
  if ((a.getAttribute("href") || "").startsWith("#")) return;
  const url = new URL(a.getAttribute("href"), win.location.href);
  if (url.hash && url.pathname === win.location.pathname && url.search === win.location.search) return;
  if (url.origin !== win.location.origin || !parseRoute(url.pathname)) return;
  e.preventDefault();
  navigate(url.pathname + url.search + (navigation && (navStore.get().workspace || url.searchParams.has("compare")) ? url.hash : ""));
}
