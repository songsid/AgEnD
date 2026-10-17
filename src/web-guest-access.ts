/**
 * #1920 phase 1: what a guest web session may reach — default deny. A guest is a non-admin signed in as their own
 * Discord or Telegram account; its scope (the instances it may see) is derived on every request (phase 2) and never
 * stored. This module is the table and the decision; FleetManager applies it at the one entry every web request passes
 * (the local listener and the public link's gateway), before any handler.
 *
 * - A route not on GUEST_ROUTES: 403 `guest_forbidden` — a new route is closed to guests until someone classifies it.
 * - A route on it that names an instance out of scope: 404 (another instance's name is never confirmed).
 * - An entry is `on` only once what it serves is safe for a guest. `later` entries are the design's (#1920 §4) and say
 *   which phase opens them; until then they answer 403 like any other route.
 *
 * The `/auth/*` self routes (who am I, my devices, sign out) are not here: they are public by path and answer each
 * caller about their own account only (auth-api.ts).
 */
import { shellRoute } from "./web-shell-routes.js";

export type GuestRouteState = "on" | "later";
export interface GuestRoute {
  readonly methods: readonly string[];
  readonly pattern: RegExp;
  /** Where the instance is: a path group (decoded), a query parameter, or nothing (static, not per instance). */
  readonly instance: { readonly group: number } | { readonly query: string } | null;
  readonly state: GuestRouteState;
  /** Why it is open, or which phase opens it and what it waits for. */
  readonly note: string;
}

const READS = ["GET", "HEAD"] as const;
const NAME = "([^/]+)";

/** The design's table (#1920 §4). Everything else is 403 for a guest. */
export const GUEST_ROUTES: readonly GuestRoute[] = [
  // The app shell and its code: static (the shell boots in guest mode in phase 3).
  { methods: READS, pattern: /^\/ui$/, instance: null, state: "on", note: "the app shell (static)" },
  { methods: READS, pattern: new RegExp(`^/ui/chat/${NAME}$`), instance: { group: 1 }, state: "on", note: "the app shell for one chat (static; out of scope: 404)" },
  { methods: ["GET"], pattern: /^\/ui\/js\/[a-z0-9_-]+\.js$/, instance: null, state: "on", note: "the panels' code (static)" },
  // What a member of the channel already sees of the instance: its profile, avatar, identity card and theme pictures.
  { methods: READS, pattern: new RegExp(`^/api/(?:profile|avatar)/${NAME}$`), instance: { group: 1 }, state: "on", note: "the instance's profile and avatar" },
  { methods: READS, pattern: new RegExp(`^/api/card/${NAME}(?:/(?:portrait|banner))?$`), instance: { group: 1 }, state: "on", note: "the instance's identity card" },
  { methods: ["GET"], pattern: new RegExp(`^/ui/img/(?:avatar|bot)/${NAME}$`), instance: { group: 1 }, state: "on", note: "the instance's face in the sidebar" },
  { methods: ["GET"], pattern: new RegExp(`^/ui/img/theme/${NAME}/[0-9a-f]{32}$`), instance: { group: 1 }, state: "on", note: "the instance's theme pictures" },
  { methods: ["GET"], pattern: /^\/ui\/effect-posters$/, instance: { query: "instance" }, state: "on", note: "the instance's static effect posters (the list)" },
  // Opened by phase 1b: the stream and the poll filtered per recipient; a file bound to its instance.
  { methods: ["GET"], pattern: /^\/ui\/events$/, instance: null, state: "later", note: "phase 1b: the stream, filtered per recipient (today every client gets every instance)" },
  { methods: ["GET"], pattern: /^\/ui\/poll$/, instance: null, state: "later", note: "phase 1b: the poll, filtered per recipient (its cursorless read is the whole history)" },
  { methods: ["GET"], pattern: /^\/ui\/file\/[^/]+$/, instance: null, state: "later", note: "phase 1b: a file bound to its stored instance (today an id is a bearer capability)" },
  { methods: ["GET"], pattern: /^\/ui\/effect-posters\/[0-9a-f]{32}\.png$/, instance: null, state: "later", note: "phase 1b: a poster bound to its instance" },
  // Opened by phase 2: what needs the guest's own identity, authority and the history rule.
  { methods: ["GET"], pattern: /^\/ui\/history$/, instance: { query: "instance" }, state: "later", note: "phase 2: history rows as the channel showed them (#1920 §5.2)" },
  { methods: ["POST"], pattern: /^\/ui\/send$/, instance: null, state: "later", note: "phase 2: guest chat (web.guests.chat), authority none" },
  { methods: ["POST"], pattern: /^\/ui\/upload$/, instance: { query: "instance" }, state: "later", note: "phase 2: guest chat's uploads" },
  { methods: ["POST"], pattern: /^\/ui\/reply-button$/, instance: null, state: "later", note: "phase 2: reply buttons, as on the platform" },
  { methods: ["POST"], pattern: new RegExp(`^/ui/cancel/${NAME}$`), instance: { group: 1 }, state: "later", note: "phase 2: Cancel, as the platform's button" },
  { methods: ["GET", "POST"], pattern: /^\/ui\/prefs$/, instance: null, state: "later", note: "phase 2: the guest's own preferences, never the host's" },
  { methods: ["GET", "POST"], pattern: /^\/ui\/profile$/, instance: null, state: "later", note: "phase 2: the guest's own web name" },
];

export type GuestRouteDecision =
  | { readonly kind: "allow"; readonly route: GuestRoute }
  | { readonly kind: "deny"; readonly status: 403 | 404; readonly error: "guest_forbidden" | "not found" };

/** An instance name from a path segment, or null when it is not one (the shell's own rule). */
function segmentName(path: string): string | null {
  const m = shellRoute("GET", `/ui/chat/${path}`);
  return m && m.kind === "shell" && m.route.panel === "chat" ? m.route.instance : null;
}

/**
 * A guest's request: allowed (an `on` route, its instance in `scope`), 404 (an `on` per-instance route whose instance is
 * not in scope, or is not a name at all), or 403 (anything else).
 */
export function guestRouteDecision(method: string, url: URL, scope: ReadonlySet<string>): GuestRouteDecision {
  const m = (method || "GET").toUpperCase();
  for (const route of GUEST_ROUTES) {
    if (!route.methods.includes(m)) continue;
    const match = route.pattern.exec(url.pathname);
    if (!match) continue;
    if (route.state !== "on") break;
    if (route.instance === null) return { kind: "allow", route };
    const name = "group" in route.instance ? segmentName(match[route.instance.group]!) : url.searchParams.get(route.instance.query);
    if (name && scope.has(name)) return { kind: "allow", route };
    return { kind: "deny", status: 404, error: "not found" };
  }
  return { kind: "deny", status: 403, error: "guest_forbidden" };
}

/** The same Discord or Telegram account (both sessions name one), for a guest's "my own sessions". */
export function sameAccount(a: { readonly adapterId: string; readonly userId: string } | undefined, b: { readonly adapterId: string; readonly userId: string } | undefined): boolean {
  return !!a && !!b && a.adapterId === b.adapterId && a.userId === b.userId;
}
