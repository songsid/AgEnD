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
 * - Phase 1b: a guest's request carries its guest context (bindGuestRequest) for the handlers that answer per recipient —
 *   the stream, the poll, a file — and their projections are here, default deny like the table.
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
  // The stream and the poll, projected per recipient (guestFrameData / guestPollBody); a file, bound to its stored
  // instance by the handler (404 out of scope: an id from another instance is useless).
  { methods: ["GET"], pattern: /^\/ui\/events$/, instance: null, state: "on", note: "the stream, projected for this guest (guestFrameData)" },
  { methods: ["GET"], pattern: /^\/ui\/poll$/, instance: null, state: "on", note: "the poll, projected for this guest (guestPollBody)" },
  { methods: ["GET"], pattern: /^\/ui\/file\/[^/]+$/, instance: null, state: "on", note: "a file, served only when its stored instance is in scope (the handler checks)" },
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

// ── Phase 1b: what a handler knows of a guest request, and what the stream and the poll may show it ──

type Owner = { readonly adapterId: string; readonly userId: string };
/**
 * A guest request: whose, and its scope — asked anew each time (a long-lived stream follows a narrowed scope). `current`
 * is the exact session that admitted it, still current (not revoked, expired or rotated away) — never "some cookie on the
 * request still authenticates": another device's session must not keep a revoked one's stream alive (#2049 review).
 */
export interface GuestRequest { readonly owner: Owner; scope(): ReadonlySet<string>; current(): boolean }
const guestRequests = new WeakMap<object, GuestRequest>();
/** Set by the one entry that admits a guest (FleetManager's gate); read by the handlers that answer per recipient. */
export function bindGuestRequest(req: object, guest: GuestRequest): void { guestRequests.set(req, guest); }
export function guestRequestOf(req: object): GuestRequest | undefined { return guestRequests.get(req); }

/**
 * What a guest's status frame keeps of each in-scope instance: who it is and how it looks, its state — not its model,
 * backend, effort, cost, context, description, tags or what it is waiting for (a prompt's text). And nothing of the
 * fleet: no public link, connections, uptime, host memory, revisions.
 */
const STATUS_FIELDS = ["name", "display_name", "avatar", "accent", "theme_avatar", "theme_accent", "card_v", "color", "color_show", "status", "state", "execution_state"] as const;
export function guestStatus(status: unknown, scope: ReadonlySet<string>): { instances: Array<Record<string, unknown>> } {
  const list = status && typeof status === "object" && Array.isArray((status as { instances?: unknown }).instances) ? (status as { instances: unknown[] }).instances : [];
  const instances: Array<Record<string, unknown>> = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const i = raw as Record<string, unknown>;
    if (typeof i.name !== "string" || !scope.has(i.name)) continue;
    const out: Record<string, unknown> = {};
    for (const k of STATUS_FIELDS) if (Object.prototype.hasOwnProperty.call(i, k) && i[k] !== undefined) out[k] = i[k];
    instances.push(out);
  }
  return { instances };
}

/**
 * One stream event as a guest gets it, or undefined (not sent). Default deny: only the status (projected) and an
 * in-scope instance's activity. Chat messages, live replies, delivery ticks and reply buttons wait for phase 2's rule
 * (#1920 §5.2: only what reached the channel); prompts (their nonces answer them), Needs you, the Log's ticks, traffic
 * and apply progress are never a guest's.
 */
export function guestFrameData(event: string, data: unknown, scope: ReadonlySet<string>): unknown {
  if (event === "status") return guestStatus(data, scope);
  if (event === "activity") {
    const d = data && typeof data === "object" ? data as { instance?: unknown; state?: unknown } : {};
    return typeof d.instance === "string" && scope.has(d.instance) ? { instance: d.instance, state: d.state ?? null } : undefined;
  }
  return undefined;
}

/** /ui/poll's answer for a guest: the projected status, and nothing else yet (the same rule as the stream). */
export function guestPollBody(status: unknown, scope: ReadonlySet<string>, now: number): Record<string, unknown> {
  return { status: guestStatus(status, scope), messages: [], deliveries: [], reply_buttons: [], prompts: [], needs: [], cursor: null, now };
}
