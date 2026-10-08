/**
 * #1408 §3: the one classifier for the web app's navigations. Every place that has to know "is this a page of the
 * app?" asks it, and none keeps a list of its own:
 * - web-api.ts serves the app shell for exactly these paths, never as a prefix fallback;
 * - the gate's sign-in fallback answers a signed-out browser navigation with the sign-in page;
 * - the public link's manifest (public-web-gateway.ts) admits these GETs.
 *
 * Client routes take only first segments the server's data routes never use (chat, fleet), so a page and a data
 * read can never be confused (a test checks both directions). /view and /settings are still pages of their own in
 * step 1; they are navigations here so the sign-in fallback keeps covering them.
 */

export const FLEET_TABS = ["tasks", "schedules", "teams", "config"] as const;
export type FleetTab = typeof FLEET_TABS[number];

export type ShellRoute =
  | { panel: "chat"; instance: string | null }
  | { panel: "fleet"; tab: FleetTab };

/** What a path is: the app shell (with its route), a malformed shell path (400), or not the shell at all (null). */
export type ShellMatch = { kind: "shell"; route: ShellRoute } | { kind: "malformed" } | null;

const PATH_SEPARATOR_OR_CONTROL = /[/\\\u0000-\u001f\u007f]/;
/** Longest instance name a path may carry; real names are far shorter. */
export const MAX_INSTANCE_NAME = 128;

/**
 * The same rule instance paths are held to (access-path.ts): not empty, no separator, no control character, no
 * traversal. A name that passes may still be unknown; that is the panel's "not found" state, never an error page.
 */
export function isSafeInstanceName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_INSTANCE_NAME && !PATH_SEPARATOR_OR_CONTROL.test(name)
    && name !== "." && !name.includes("..");
}

/** Decode one path segment; null when it is not valid percent-encoding. */
function decodeSegment(segment: string): string | null {
  try { return decodeURIComponent(segment); } catch { return null; }
}

/** The app shell's routes (#1408 §3). Only GET and HEAD are navigations. */
export function shellRoute(method: string, path: string): ShellMatch {
  if (method !== "GET" && method !== "HEAD") return null;
  if (path === "/ui") return { kind: "shell", route: { panel: "chat", instance: null } };
  if (path === "/ui/fleet") return { kind: "shell", route: { panel: "fleet", tab: "tasks" } };
  const fleet = /^\/ui\/fleet\/([^/]+)$/.exec(path);
  if (fleet) return (FLEET_TABS as readonly string[]).includes(fleet[1]!) ? { kind: "shell", route: { panel: "fleet", tab: fleet[1] as FleetTab } } : null;
  const chat = /^\/ui\/chat\/([^/]+)$/.exec(path);
  if (chat) {
    const name = decodeSegment(chat[1]!);
    return name !== null && isSafeInstanceName(name) ? { kind: "shell", route: { panel: "chat", instance: name } } : { kind: "malformed" };
  }
  // `/ui/chat` with nothing after it, or more than one segment: not a page (404 like any unknown path).
  return null;
}

/**
 * A browser navigation to a page of the web app: the shell's routes, plus /view and /settings (still their own pages
 * in step 1). The gate answers these, signed out, with the sign-in page instead of a JSON 401.
 */
export function isWebPageNavigation(path: string): boolean {
  if (path === "/view" || path === "/settings") return true;
  return shellRoute("GET", path) !== null;
}

/** The app's client-side paths, for links the server builds (#1386 links, the tour). */
export function chatPath(instance: string): string {
  return `/ui/chat/${encodeURIComponent(instance)}`;
}
