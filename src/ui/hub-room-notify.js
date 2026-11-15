// Hub rooms desktop notifications (hub-rooms-ux.md §12: 和 Fleet 聊天相同的桌面通知（要先允許）).
// Pure gate: shouldNotify in hub-room-unread.js (imported, never copied); the opt-in rule: notifyOn in app-needs.js.
import { notifyOn, notifySupport, notifyStore, refreshNotify, setNotify } from "/assets/app-needs.js";
import { html, useEffect } from "/assets/app-html.js";
import { useStore } from "/assets/app-store.js";
import { Icon } from "/assets/ui-icons.js";
import { counts, shouldNotify } from "./hub-room-unread.js";
import { hroom } from "./hub-room-strings.js";

/**
 * Which live events earn a desktop ping (web-claude M-3117: only what is about me): an @ to me, an answer to
 * a question I asked (`answerTo` mine, matched by the server-set `askedBy`; a missing `askedBy` is not mine),
 * a new invitation, and any new message in a direct (1:1) room (`opts.direct`). A group room's chatter and
 * answers to other people's questions only count toward unread (the list and the tab title show them).
 */
export function notifyKind(event, me, opts = {}) {
  const c = counts(event, me);
  if (!c || c.unread <= 0) return null;
  if (c.invitation) return "invitation";
  if (c.mentioned) return "mention";
  const m = event && event.message;
  if (m && m.stage === "answered" && m.answerTo && m.askedBy && me && m.askedBy === me.id) return "answer";
  if (opts.direct && event.type === "message.added") return "direct";
  return null;
}

const excerpt = (text) => {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

function pingBody(kind, event, room) {
  if (kind === "invitation") {
    const inv = (event && event.invitation) || {};
    const name = (inv.room && inv.room.name) || inv.id || "";
    return hroom("notifyInvite", String(name));
  }
  const m = (event && event.message) || {};
  const who = (m.author && m.author.name) || "";
  if (kind === "direct") return hroom("notifyDirect", String(who), excerpt(m.text));
  return hroom(kind === "mention" ? "notifyMention" : "notifyAnswer", String(who), String(room), excerpt(m.text));
}

/**
 * This person's member id per room for the page-level watcher (counts() matches message authors and @mentions
 * by id, and every room mints its own member ids — one room's me.id never identifies this person in another).
 * The Hub session carries only login and display name. Set per room from a room detail the page reads, or lazily
 * on live events — and cleared wholesale when the signed-in login changes, so a sign-out and sign-in as someone
 * else on the same tab never matches the next person with the previous one's ids.
 */
const meByRoom = new Map();
/** Keeps the id for one room, from its detail or the lazy resolve; ignores empty values. */
export function noteHubMeId(roomId, id) { if (typeof roomId === "string" && roomId && typeof id === "string" && id) meByRoom.set(roomId, id); }
/** Forgets every room's id: the signed-in login changed (signed out, or in as someone else). */
export function clearHubMeId() { meByRoom.clear(); }
/** The remembered id for one room, or null while unknown. */
export function rememberedMeId(roomId) { return meByRoom.get(roomId) || null; }

let stopPrev = null;
/** The live starter's generation: a lazy resolve from a replaced or stopped watcher never writes. */
let liveGen = 0;

/**
 * Ping while a Hub tab is open but hidden (a visible page shows the rows; what it showed is seen).
 * `me(roomId)`: { id } for that room, or an accessor returning it (null until the page learns it:
 * message rows cannot be matched before that, while an invitation — which carries no author — still pings).
 * `setMe(roomId, { id })`: keeps what `resolveMe(roomId)` learns; `resolveMe`: one async attempt per room id,
 * retried on the next event while still unknown (only while opted in, so an opted-out page never reads for it).
 * `roomName(roomId)`: the ping's title; `roomKind(roomId)`: the list's kind for it (`"direct"` rooms ping
 * on any new message); `open(roomId)`: where a click goes. Returns the stop function;
 * a second start replaces the first.
 */
export function startHubRoomNotifier({ client, me, setMe, resolveMe, roomName, roomKind, open, env = globalThis, doc = typeof document !== "undefined" ? document : null } = {}) {
  if (stopPrev) stopPrev();
  const gen = ++liveGen;
  const seen = new Set();
  const resolving = new Map();
  const meOf = (roomId) => (typeof me === "function" ? me(roomId) : me);
  // Starts (or joins) the lazy resolve for a room; returns its promise, or null when no resolve applies.
  const ensureMe = (roomId) => {
    if (!roomId) return null;
    const m = meOf(roomId);
    if (m && m.id) return null;
    if (typeof resolveMe !== "function" || typeof setMe !== "function" || !notifyOn(env)) return null;
    if (!resolving.has(roomId)) {
      resolving.set(roomId, Promise.resolve()
        .then(() => resolveMe(roomId))
        // A resolve that lands after a restart (sign-in change) or stop belongs to the old watcher: drop it,
        // or B would inherit A's id right after the clear.
        .then((got) => { if (gen === liveGen && got && got.id) setMe(roomId, got); }, () => {})
        .finally(() => { resolving.delete(roomId); }));
    }
    return resolving.get(roomId) ?? null;
  };
  const onEvent = (type) => (data, replayed) => {
    const event = { type, ...(data && typeof data === "object" ? data : {}) };
    const focus = !(doc && doc.hidden);
    // Member ids are per room: match each event against that room's own remembered id, so an @mention or
    // answer in any other room still pings, while my own rows (including from another device) never do.
    const self = meOf(event.roomId);
    let kind = null;
    if (self) {
      if (!shouldNotify(event, self, focus, env)) return;
      const direct = typeof roomKind === "function" && roomKind(event.roomId) === "direct";
      kind = notifyKind(event, self, { direct });
    } else {
      // The page has not learned this person's id for this room yet: message rows cannot be matched now.
      // A new invitation (no author) still pings at once under the hidden-tab rule; any other first event
      // in the room is replayed through the normal path once the resolve lands (seen-key dedupe stops a
      // double ping), so the first @mention is never the one that stays silent.
      if (!replayed) {
        const pending = ensureMe(event.roomId);
        if (pending) pending.then(() => {
          if (gen === liveGen && doc && doc.hidden && notifyOn(env)) onEvent(type)(data, true);
        });
      }
      if (focus || !notifyOn(env)) return;
      const inv = event.invitation;
      if (event.type !== "invitation.changed" || !inv || typeof inv !== "object" || !(inv.id || inv.room)) return;
      kind = "invitation";
    }
    if (!kind) return;
    const id = self ? (counts(event, self).id || `${type}:${event.roomId || ""}`)
      : String((event.invitation && event.invitation.id) || `${type}:invitation`);
    // One ping per row per kind: an @mention and the row's later answer are two moments; the tab's
    // tag stays the row id, so the answer replaces the mention ping instead of stacking (Fleet: tag = item id).
    const seenKey = `${kind}:${id}`;
    if (seen.has(seenKey)) return;
    seen.add(seenKey);
    try {
      const room = typeof roomName === "function" ? roomName(event.roomId) || "" : "";
      const n = new env.Notification(room || "AgEnD Hub", { body: pingBody(kind, event, room), tag: String(id) });
      n.onclick = () => {
        try { if (env.focus) env.focus(); } catch { /* the tab is already there */ }
        if (event.roomId && typeof open === "function") open(event.roomId);
        try { n.close(); } catch { /* already gone */ }
      };
    } catch { /* a browser that refuses at the last moment: the unread count still shows it */ }
  };
  const off = client && typeof client.subscribeRooms === "function"
    ? client.subscribeRooms({ "message.added": onEvent("message.added"), "message.updated": onEvent("message.updated"), "invitation.changed": onEvent("invitation.changed") })
    : () => {};
  stopPrev = () => { stopPrev = null; liveGen++; try { off(); } catch { /* already stopped */ } };
  return stopPrev;
}

/** The Hub header's compact Notify-me button: this device's choice (notifyStore), asking on click. */
export function HubNotifyToggle() {
  const support = notifySupport();
  const { state, asking } = useStore(notifyStore);
  useEffect(() => { refreshNotify(); }, []);
  const on = state === "on";
  const label = hroom("notifyTitle");
  const note = support !== "ok" ? hroom("notifyUnavailable") : state === "denied" ? hroom("notifyDenied") : on ? hroom("notifyOn") : hroom("notifyOff");
  const title = `${label} — ${note}`;
  if (support !== "ok") {
    return html`<span class="icon-btn hub-notify" aria-disabled="true" title=${title} aria-label=${title}><${Icon} name="bell" size=${16} /></span>`;
  }
  return html`<button type="button" class="icon-btn hub-notify" aria-pressed=${on ? "true" : "false"} aria-label=${label} title=${title}
    disabled=${asking} onClick=${() => { void setNotify(!on); }}><${Icon} name="bell" size=${16} /></button>`;
}
