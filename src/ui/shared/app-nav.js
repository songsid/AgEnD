// #1408 §3: navigation without reloads. Links stay real <a href>s; a plain left click on one that names a route of the
// app is taken over (pushState), and Back/Forward follow (popstate). A modified or middle click, a download, another
// origin, or a path that is not a page of the app is left to the browser.
// Every navigation bumps `seq`: panels key their lease (app-ctx.js) on the route, so work from the route left behind
// can no longer land.
// A panel with work that leaving would lose (Settings' staged changes, §5) sets a leave guard: every navigation of
// the app asks it first, Back/Forward included (the address bar is put back when it says no).
import { parseRoute, legacyHashTarget } from "./app-route.js";
import { createStore } from "./app-store.js";

export const navStore = createStore({ route: null, seq: 0 });

let win = null;
let guard = null;
let here = null;                                 // the path the app shows now (popstate has already changed the address)

/**
 * `fn(route)` → false keeps the app where it is (it asked the person, who said no). One guard at a time; returns the
 * remover, which only removes this one.
 */
export function setLeaveGuard(fn) {
  guard = fn;
  return () => { if (guard === fn) guard = null; };
}
const mayLeave = (route) => !guard || guard(route) !== false;

/** Start following the address bar. An old /ui#instance=<name> link becomes /ui/chat/<name> before the first render. */
export function startRouter(w = window) {
  win = w;
  const legacy = legacyHashTarget(w.location.pathname, w.location.hash);
  if (legacy) w.history.replaceState(null, "", legacy);
  here = w.location.pathname + w.location.search;
  navStore.set({ route: parseRoute(w.location.pathname), seq: 1 });
  w.addEventListener("popstate", () => {
    const route = parseRoute(w.location.pathname);
    if (!mayLeave(route)) { w.history.pushState(null, "", here); return; }
    here = w.location.pathname + w.location.search;
    navStore.set(s => ({ route, seq: s.seq + 1 }));
  });
  w.document.addEventListener("click", onLinkClick);
}

/** Go to `path`. A path that is not a route of the app is a full load. */
export function navigate(path, opts = {}) {
  const url = new URL(path, win.location.href);
  const route = parseRoute(url.pathname);
  if (!route || url.origin !== win.location.origin) { win.location.assign(url.href); return; }
  if (!mayLeave(route)) return;
  if (url.pathname + url.search !== win.location.pathname + win.location.search) {
    win.history[opts.replace ? "replaceState" : "pushState"](null, "", url.pathname + url.search);
  }
  here = url.pathname + url.search;
  navStore.set(s => ({ route, seq: s.seq + 1 }));
}

/** The same route again (Retry, a language switch): a new lease, no history entry. */
export function renavigate() { navStore.set(s => ({ route: s.route, seq: s.seq + 1 })); }

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
  navigate(url.pathname + url.search);
}
