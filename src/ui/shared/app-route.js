// #1408 §3: the app's routes on the client. The same table as the server's classifier (src/web-shell-routes.ts;
// a test runs both over one list of cases). Pure: no DOM, no history.

export const FLEET_TABS = ["tasks", "schedules", "teams", "org", "config"];
export const SETTINGS_SECTIONS = ["agents", "bots", "classic", "general", "advanced"];
const MAX_INSTANCE_NAME = 128;
const PATH_SEPARATOR_OR_CONTROL = /[/\\\u0000-\u001f\u007f]/;

/** Not empty, no separator, no control character, no traversal — the rule instance paths are held to. */
export function isSafeInstanceName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= MAX_INSTANCE_NAME
    && !PATH_SEPARATOR_OR_CONTROL.test(name) && name !== "." && !name.includes("..");
}

/**
 * A path → the route it names: { panel: "chat" | "view", instance } | { panel: "fleet", tab } |
 * { panel: "settings", section } | null (not a page of the app: a full load). A malformed name is null too; the
 * server answers it 400.
 */
export function parseRoute(pathname) {
  if (pathname === "/ui") return { panel: "chat", instance: null };
  if (pathname === "/ui/fleet") return { panel: "fleet", tab: "tasks" };
  if (pathname === "/ui/needs") return { panel: "needs" };
  let m = /^\/ui\/fleet\/([^/]+)$/.exec(pathname);
  if (m) return FLEET_TABS.includes(m[1]) ? { panel: "fleet", tab: m[1] } : null;
  m = /^\/ui\/chat\/([^/]+)$/.exec(pathname);
  if (m) return named("chat", m[1]);
  if (pathname === "/view") return { panel: "view", instance: null };
  m = /^\/view\/([^/]+)$/.exec(pathname);
  if (m) return named("view", m[1]);
  if (pathname === "/settings") return { panel: "settings", section: "agents" };
  m = /^\/settings\/([^/]+)$/.exec(pathname);
  if (m) return SETTINGS_SECTIONS.includes(m[1]) ? { panel: "settings", section: m[1] } : null;
  return null;
}
function named(panel, segment) {
  let name = null;
  try { name = decodeURIComponent(segment); } catch { return null; }
  return isSafeInstanceName(name) ? { panel, instance: name } : null;
}

export function chatPath(instance) { return `/ui/chat/${encodeURIComponent(instance)}`; }
export function viewPath(instance) { return instance ? `/view/${encodeURIComponent(instance)}` : "/view"; }
export function fleetPath(tab) { return tab && tab !== "tasks" ? `/ui/fleet/${tab}` : "/ui/fleet"; }
export const NEEDS_PATH = "/ui/needs";
export function settingsPath(section) { return section && section !== "agents" ? `/settings/${section}` : "/settings"; }
export function routePath(route) {
  if (!route) return "/ui";
  if (route.panel === "fleet") return fleetPath(route.tab);
  if (route.panel === "settings") return settingsPath(route.section);
  if (route.panel === "needs") return NEEDS_PATH;
  if (route.panel === "view") return viewPath(route.instance);
  return route.instance ? chatPath(route.instance) : "/ui";
}
/** One string per route: a change of it is a new navigation (a new lease for the panel, §4). */
export function routeKey(route) {
  if (!route) return "none";
  if (route.panel === "needs") return "needs:";
  return `${route.panel}:${route.panel === "fleet" ? route.tab : route.panel === "settings" ? route.section : route.instance ?? ""}`;
}

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
