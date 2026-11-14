// Hub rooms desktop notifications (hub-rooms-ux.md §12: 和 Fleet 聊天相同的桌面通知（要先允許）).
// Pure gate: shouldNotify in hub-room-unread.js (imported, never copied); the opt-in rule: notifyOn in app-needs.js.
import { notifyOn, notifySupport, notifyStore, refreshNotify, setNotify } from "/assets/app-needs.js";
import { html, useEffect } from "/assets/app-html.js";
import { useStore } from "/assets/app-store.js";
import { Icon } from "/assets/ui-icons.js";
import { counts, shouldNotify } from "./hub-room-unread.js";
import { hroom } from "./hub-room-strings.js";

/**
 * Which live events earn a desktop ping: an @ to me, an agent's answer, a new invitation.
 * Plain room chatter only counts toward unread (the list and the tab title show it).
 */
export function notifyKind(event, me) {
  const c = counts(event, me);
  if (!c || c.unread <= 0) return null;
  if (c.invitation) return "invitation";
  if (c.mentioned) return "mention";
  const m = event && event.message;
  return m && m.stage === "answered" ? "answer" : null;
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
  return hroom(kind === "mention" ? "notifyMention" : "notifyAnswer", String(who), String(room), excerpt(m.text));
}

let stopPrev = null;

/**
 * Ping while a Hub tab is open but hidden (a visible page shows the rows; what it showed is seen).
 * `me`: { id } or an accessor returning it (null until the page learns it: message rows cannot be
 * matched before that, while an invitation — which carries no author — still pings).
 * `setMe({ id })`: keeps what `resolveMe()` learns; `resolveMe()`: one async attempt at the id, retried
 * on the next event while still unknown (only while opted in, so an opted-out page never reads for it).
 * `roomName(roomId)`: the ping's title; `open(roomId)`: where a click goes. Returns the stop function;
 * a second start replaces the first.
 */
export function startHubRoomNotifier({ client, me, setMe, resolveMe, roomName, open, env = globalThis, doc = typeof document !== "undefined" ? document : null } = {}) {
  if (stopPrev) stopPrev();
  const seen = new Set();
  let resolving = null;
  const meOf = () => (typeof me === "function" ? me() : me);
  const ensureMe = () => {
    const m = meOf();
    if (m && m.id) return;
    if (typeof resolveMe !== "function" || typeof setMe !== "function" || !notifyOn(env)) return;
    resolving ??= Promise.resolve()
      .then(resolveMe)
      .then((got) => { if (got && got.id) setMe(got); }, () => {})
      .finally(() => { resolving = null; });
  };
  const onEvent = (type) => (data) => {
    const event = { type, ...(data && typeof data === "object" ? data : {}) };
    const focus = !(doc && doc.hidden);
    const self = meOf();
    let kind = null;
    if (self) {
      if (!shouldNotify(event, self, focus, env)) return;
      kind = notifyKind(event, self);
    } else {
      // The page has not learned this person's id yet: message rows cannot be matched, while a new
      // invitation (no author) still pings under the same opt-in + hidden-tab rule.
      ensureMe();
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
  stopPrev = () => { stopPrev = null; try { off(); } catch { /* already stopped */ } };
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
