// #1408 §3: the app's routes on the client. The same table as the server's classifier (src/web-shell-routes.ts;
// a test runs both over one list of cases). Pure: no DOM, no history.

export const FLEET_TABS = ["tasks", "schedules", "teams", "config"];
const MAX_INSTANCE_NAME = 128;
const PATH_SEPARATOR_OR_CONTROL = /[/\\\u0000-\u001f\u007f]/;

/** Not empty, no separator, no control character, no traversal — the rule instance paths are held to. */
export function isSafeInstanceName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= MAX_INSTANCE_NAME
    && !PATH_SEPARATOR_OR_CONTROL.test(name) && name !== "." && !name.includes("..");
}

/**
 * A path → the route it names: { panel: "chat", instance } | { panel: "fleet", tab } | null (not a page of the app:
 * a full load, like /view and /settings in step 1). A malformed chat path is null too; the server answers it 400.
 */
export function parseRoute(pathname) {
  if (pathname === "/ui") return { panel: "chat", instance: null };
  if (pathname === "/ui/fleet") return { panel: "fleet", tab: "tasks" };
  let m = /^\/ui\/fleet\/([^/]+)$/.exec(pathname);
  if (m) return FLEET_TABS.includes(m[1]) ? { panel: "fleet", tab: m[1] } : null;
  m = /^\/ui\/chat\/([^/]+)$/.exec(pathname);
  if (m) {
    let name = null;
    try { name = decodeURIComponent(m[1]); } catch { return null; }
    return isSafeInstanceName(name) ? { panel: "chat", instance: name } : null;
  }
  return null;
}

export function chatPath(instance) { return `/ui/chat/${encodeURIComponent(instance)}`; }
export function fleetPath(tab) { return tab && tab !== "tasks" ? `/ui/fleet/${tab}` : "/ui/fleet"; }
export function routePath(route) {
  if (!route) return "/ui";
  if (route.panel === "fleet") return fleetPath(route.tab);
  return route.instance ? chatPath(route.instance) : "/ui";
}
/** One string per route: a change of it is a new navigation (a new lease for the panel, §4). */
export function routeKey(route) { return route ? `${route.panel}:${route.panel === "fleet" ? route.tab : route.instance ?? ""}` : "none"; }

/**
 * #1408 §3: an old deep link, /ui#instance=<name>, as the new path. The fragment never reaches the server, so the app
 * (and the sign-in page, for a signed-out visit) converts it. Exactly that one form; anything else is dropped.
 */
export function legacyHashTarget(pathname, hash) {
  if (pathname !== "/ui") return null;
  const m = /^#instance=([^&#]*)$/.exec(hash || "");
  if (!m) return null;
  let name;
  try { name = decodeURIComponent(m[1]); } catch { return null; }
  return isSafeInstanceName(name) ? chatPath(name) : null;
}
