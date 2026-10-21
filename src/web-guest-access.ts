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
import type { WebChatButtons, WebChatHistory, WebChatMessage, WebDeliveryState } from "./web-chat-history.js";

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
  { methods: ["GET"], pattern: /^\/ui\/effects\/placements$/, instance: { query: "instance" }, state: "on", note: "current in-scope Chat effect metadata only, with a session epoch" },
  { methods: ["GET"], pattern: /^\/ui\/effects\/resource\/[0-9a-f]{32}$/, instance: { query: "instance" }, state: "on", note: "a current in-scope Chat effect resource, never library or personal-slot reads" },
  // Opened by phase 1b: the stream and the poll filtered per recipient; a file bound to its instance.
  // The stream and the poll, projected per recipient (guestFrameData / guestPollBody); a file, bound to its stored
  // instance by the handler (404 out of scope: an id from another instance is useless).
  { methods: ["GET"], pattern: /^\/ui\/events$/, instance: null, state: "on", note: "the stream, projected for this guest (guestFrameData)" },
  { methods: ["GET"], pattern: /^\/ui\/poll$/, instance: null, state: "on", note: "the poll, projected for this guest (guestPollBody)" },
  { methods: ["GET"], pattern: /^\/ui\/file\/[^/]+$/, instance: null, state: "on", note: "a file, served only when its stored instance is in scope (the handler checks)" },
  { methods: ["GET"], pattern: /^\/ui\/effect-posters\/[0-9a-f]{32}\.png$/, instance: { query: "instance" }, state: "on", note: "a placed effect's static poster, bound to its instance by the query" },
  // Opened by phase 2: what needs the guest's own identity, authority and the history rule.
  { methods: ["GET"], pattern: /^\/ui\/history$/, instance: { query: "instance" }, state: "on", note: "an in-scope instance's history, as its channel showed it (guestHistory, #1920 §5.2)" },
  // Phase 2 (step 2b): chat as on the platform — authority none, never a command (guestChatRefusal, in the handlers).
  { methods: ["POST"], pattern: /^\/ui\/send$/, instance: null, state: "on", note: "a message to an in-scope instance (the handler checks the body's instance and web.guests.chat); never a command" },
  { methods: ["POST"], pattern: /^\/ui\/upload$/, instance: { query: "instance" }, state: "on", note: "a file for an in-scope instance's message (web.guests.chat)" },
  { methods: ["POST"], pattern: /^\/ui\/reply-button$/, instance: null, state: "on", note: "a click on a reply the guest may see (the handler checks; web.guests.chat)" },
  { methods: ["POST"], pattern: new RegExp(`^/ui/cancel/${NAME}$`), instance: { group: 1 }, state: "on", note: "Cancel, as the platform's button lets anyone allowed there (web.guests.chat)" },
  { methods: ["GET"], pattern: /^\/ui\/prefs$/, instance: null, state: "on", note: "the host's look (theme, language, shown settings) and the guest's own — nothing that names an instance (guestPrefs)" },
  { methods: ["POST"], pattern: /^\/ui\/prefs$/, instance: null, state: "later", note: "phase 3: what a guest may keep of its own" },
  { methods: ["GET", "POST"], pattern: /^\/ui\/profile$/, instance: null, state: "on", note: "the guest's own web name (its account's, never anyone else's)" },
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
export interface GuestRequest {
  readonly owner: Owner;
  scope(): ReadonlySet<string>;
  current(): boolean;
  /** #1920 §5.2: an instance whose every message is this guest's to see — its own Telegram private room. */
  ownRoom?(instance: string): boolean;
  /** #1920 §5.2: the kept messages, to show a tick or a reply's buttons only on a message the guest may see. */
  history?(): WebChatHistory | null;
  /** #1920 §5.1: guests may chat (web.guests.chat, default true); false: read-only. Absent: read-only. */
  chat?(): boolean;
  /** #1920 §3.2: its stream connected — its rooms' membership is read again, in the background. */
  streamOpened?(): void;
}

/**
 * #1920 §5.1 (step 2b): why a guest may not write to `instance` now, or null (not a guest, or allowed): out of scope is
 * "not found" (another instance's name is never confirmed); read-only when the host says so.
 */
export function guestChatRefusal(guest: GuestRequest | undefined, instance: unknown): { status: 403 | 404; error: string } | null {
  if (!guest) return null;
  if (typeof instance !== "string" || !guest.scope().has(instance)) return { status: 404, error: "not found" };
  if (guest.chat?.() !== true) return { status: 403, error: "guest_read_only" };
  return null;
}
/** A guest never sends a command: text that starts (after spaces) with "/" is the platform's admin or command syntax. */
export const guestCommandText = (text: string): boolean => /^\s*\//.test(text);

/**
 * #1920 §4 (step 2b): the preferences a guest reads — the host's look and the guest's own; never one that names an
 * instance (the sidebar's order, favourites, a card's size, the sidebar widget, names, the filter).
 */
export const GUEST_PREF_KEYS: ReadonlySet<string> = new Set(["theme", "lang", "fx.show", "card.size", "color.show", "color.off", "fx.sidebar", "fx.header", "fx.page", "fx.box", "fx.cursor"]);
export function guestPrefs<T extends { values: Record<string, unknown> }>(view: T): T {
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(view.values)) if (GUEST_PREF_KEYS.has(k)) values[k] = v;
  return { ...view, values };
}
const guestRequests = new WeakMap<object, GuestRequest>();
/** Set by the one entry that admits a guest (FleetManager's gate); read by the handlers that answer per recipient. */
export function bindGuestRequest(req: object, guest: GuestRequest): void { guestRequests.set(req, guest); }
export function guestRequestOf(req: object): GuestRequest | undefined { return guestRequests.get(req); }

/**
 * What a guest's status frame keeps of each in-scope instance: who it is and how it looks, its state — not its model,
 * backend, effort, cost, context, description, tags or what it is waiting for (a prompt's text). And nothing of the
 * fleet identity: no public link, connections, uptime, host memory, revisions. The public CW capability bit is
 * retained so a guest also stops playback when the administrator disables it.
 */
const STATUS_FIELDS = ["name", "display_name", "avatar", "accent", "theme_avatar", "theme_accent", "card_v", "effect_chat_v", "color", "color_show", "status", "state", "execution_state"] as const;
export function guestStatus(status: unknown, scope: ReadonlySet<string>): { instances: Array<Record<string, unknown>>; canvas_worker: boolean } {
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
  // This public capability bit carries no fleet identity; guests need it for live enable/disable too.
  return { instances, canvas_worker: !!status && typeof status === "object" && (status as { canvas_worker?: unknown }).canvas_worker === true };
}

// ── Phase 2: the chat, as the channel showed it (#1920 §5.2) ──

const accountOf = (o: Owner): string => `${o.adapterId}:${o.userId}`;
/**
 * Whether a guest sees one kept message: an in-scope instance's message that reached its channel (what the channel's
 * members already saw), the guest's own, or anything in its own private room. Never someone else's web-only exchange,
 * a cross-instance notice, a fleet status line, or a row kept from before these were recorded (they have no mark).
 */
export function guestSeesMessage(m: WebChatMessage, guest: GuestRequest, scope: ReadonlySet<string>): boolean {
  if (!scope.has(m.instance)) return false;
  return m.channel === true || m.from === accountOf(guest.owner) || guest.ownRoom?.(m.instance) === true;
}
/**
 * A message as a guest gets it: without whose account wrote it (`mine` says it was the guest), and without another
 * person's message id and ticks; never an effect Try (effects stay admin-only). A reply's quote (#2272) only when the
 * guest may see the message it quotes — otherwise just that it replies to an earlier message (`hidden`).
 */
export function guestMessage(m: WebChatMessage, guest: GuestRequest, scope?: ReadonlySet<string>): Record<string, unknown> {
  const { from, channel: _channel, messageId, delivery, effectTrial: _trial, seenSeq: _seen, replyTo, ...rest } = m;
  void _channel; void _trial; void _seen;
  const mine = from === accountOf(guest.owner);
  // #2085 review: a click's `text` is what the agent was given — the button's value too, which the platform never
  // shows. A guest gets the label, as the channel showed it.
  const click = rest.click ? { text: rest.click.label } : {};
  const quotedRow = replyTo && scope ? guest.history?.()?.find(m.instance, replyTo.boot, replyTo.id) : undefined;
  const quote = !replyTo ? {} : quotedRow && scope && guestSeesMessage(quotedRow, guest, scope)
    ? { replyTo } : { replyTo: { boot: replyTo.boot, id: replyTo.id, hidden: true } };
  return { ...rest, ...click, ...quote, ...(mine ? { mine: true } : {}), ...(mine && messageId ? { messageId } : {}), ...(mine && delivery ? { delivery } : {}) };
}
const visibleList = (rows: readonly WebChatMessage[], guest: GuestRequest, scope: ReadonlySet<string>) =>
  rows.filter((m) => !m.effectTrial && guestSeesMessage(m, guest, scope)).map((m) => guestMessage(m, guest, scope));

/**
 * One stream event as a guest gets it, or undefined (not sent). Default deny:
 * - the status (projected) and an in-scope instance's activity;
 * - a chat message it may see (§5.2), a tick on one of its own messages, the buttons of a reply it may see;
 * - never: the live reply receipt (effects), prompts (their nonces answer them), Needs you, the Log's ticks, traffic or
 *   apply progress.
 * Without `guest` (no context) only the status and activity pass.
 */
export function guestFrameData(event: string, data: unknown, scope: ReadonlySet<string>, guest?: GuestRequest): unknown {
  if (event === "status") return guestStatus(data, scope);
  const d = data && typeof data === "object" ? data as Record<string, unknown> : {};
  if (event === "activity") return typeof d.instance === "string" && scope.has(d.instance) ? { instance: d.instance, state: d.state ?? null } : undefined;
  if (!guest) return undefined;
  if (event === "message") {
    const m = data as WebChatMessage;
    return typeof m?.instance === "string" && guestSeesMessage(m, guest, scope) ? guestMessage(m, guest, scope) : undefined;
  }
  const history = guest.history?.();
  if (!history || typeof d.instance !== "string" || !scope.has(d.instance)) return undefined;
  if (event === "delivery") {
    const own = typeof d.messageId === "string" ? history.findByMessageId(d.instance, d.messageId) : undefined;
    return own && own.from === accountOf(guest.owner) ? { instance: d.instance, messageId: d.messageId, delivery: d.delivery } : undefined;
  }
  // #2305: a reaction, on a message the guest may see.
  if (event === "reactions") {
    const row = typeof d.boot === "string" && typeof d.id === "number" ? history.find(d.instance, d.boot, d.id) : undefined;
    return row && guestSeesMessage(row, guest, scope) ? { instance: d.instance, boot: d.boot, id: d.id, reactions: d.reactions } : undefined;
  }
  if (event === "reply_buttons") {
    const id = d.buttons && typeof d.buttons === "object" ? (d.buttons as { id?: unknown }).id : undefined;
    const row = typeof id === "string" ? history.findByButtons(d.instance, id) : undefined;
    return row && guestSeesMessage(row, guest, scope) ? { instance: d.instance, buttons: d.buttons } : undefined;
  }
  return undefined;
}

/** The ticks a guest is caught up with: its own messages' only. */
export function guestDeliveries(history: WebChatHistory, guest: GuestRequest, scope: ReadonlySet<string>): Array<{ instance: string; messageId: string; delivery: WebDeliveryState }> {
  return history.deliveries().filter((t) => scope.has(t.instance) && history.findByMessageId(t.instance, t.messageId)?.from === accountOf(guest.owner));
}
/** The ended (or open-poll) buttons a guest is caught up with: on replies it may see. */
export function guestButtonStates(history: WebChatHistory, guest: GuestRequest, scope: ReadonlySet<string>): Array<{ instance: string; buttons: WebChatButtons }> {
  return history.buttonStates().filter((b) => { const row = history.findByButtons(b.instance, b.buttons.id); return !!row && guestSeesMessage(row, guest, scope); });
}
/** A guest's replay (a reconnecting stream, a poll): what it may see of `rows`. */
export function guestMessages(rows: readonly WebChatMessage[], guest: GuestRequest, scope: ReadonlySet<string>): Array<Record<string, unknown>> {
  return visibleList(rows, guest, scope);
}
/** /ui/history for a guest: the newest `limit` messages of one instance that it may see. */
export function guestHistory(history: WebChatHistory, instance: string, limit: number, guest: GuestRequest, scope: ReadonlySet<string>): Array<Record<string, unknown>> {
  return visibleList(history.list(instance), guest, scope).slice(-limit);
}

/**
 * /ui/poll's answer for a guest: the projected status, and the chat it may see (the same rule as its stream) — with the
 * cursor every poll hands out. Never prompts or Needs you.
 */
export function guestPollBody(status: unknown, scope: ReadonlySet<string>, now: number, guest?: GuestRequest, after?: string | null, replay?: (after: string | null) => readonly WebChatMessage[]): Record<string, unknown> {
  const history = guest?.history?.() ?? null;
  if (!guest || !history || !replay) return { status: guestStatus(status, scope), messages: [], deliveries: [], reply_buttons: [], reactions: [], prompts: [], needs: [], cursor: null, now };
  return {
    status: guestStatus(status, scope),
    messages: guestMessages(replay(after ?? null), guest, scope),
    deliveries: guestDeliveries(history, guest, scope),
    reply_buttons: guestButtonStates(history, guest, scope),
    reactions: history.reactionStates().filter((r) => { const row = history.find(r.instance, r.boot, r.id); return !!row && guestSeesMessage(row, guest, scope); }),
    prompts: [], needs: [],
    cursor: history.pollCursor(),
    now,
  };
}
