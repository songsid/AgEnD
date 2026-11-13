// Hub rooms unread and desktop notifications (hub-rooms-ux.md §12). Pure: one live event in, counts out.
// The Fleet desktop-notify rule is notifyOn in app-needs.js — imported, never copied. Tab title is this
// helper; the Needs-you prefix in app-shell.js is a different count.
import { notifyOn } from "/assets/app-needs.js";

const NONE = { unread: 0, mentioned: false, invitation: false, id: null };

/** Browser tab title: "(3) base" while there is unread; `base` itself when the total is 0. */
export function tabTitle(base, total) {
  const n = Number(total);
  return n > 0 && Number.isFinite(n) ? `(${Math.trunc(n)}) ${base}` : base;
}

function countable(message, me) {
  const author = message && message.author;
  if (!author || !me) return false;
  if (author.id === me.id || author.kind === "system") return false;
  return !!(message.text || message.stage !== "queued");
}

/**
 * Per-event §12 counts: others' messages, an @ to me, answers from agents I @-ed, new invitations.
 * Own messages and system rows are 0. A live invitation.changed with no invitation object is a
 * removal (accept/decline) and does not count.
 * `id` is the message (or invitation) identity so a caller that sums unread keeps a Set of ids
 * rather than adding every message.updated of the same row.
 */
export function counts(event, me) {
  if (!event || typeof event !== "object") return NONE;
  if (event.type === "invitation.changed") {
    const inv = event.invitation;
    return inv && typeof inv === "object" && (inv.id || inv.room)
      ? { unread: 1, mentioned: false, invitation: true, id: inv.id || null }
      : NONE;
  }
  if (event.type !== "message.added" && event.type !== "message.updated") return NONE;
  const message = event.message;
  if (!countable(message, me)) return NONE;
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  return { unread: 1, mentioned: mentions.includes(me.id), invitation: false, id: message.id || null };
}

/** Desktop notify only for a row counts() treats as unread, and only while the tab is unfocused. */
export function shouldNotify(event, me, focus, env = globalThis) {
  return !focus && counts(event, me).unread > 0 && notifyOn(env);
}

/** Open room + scrolled to the bottom → mark read (spec §12). */
export function readWhen(atBottom, open) {
  return Boolean(open && atBottom);
}
