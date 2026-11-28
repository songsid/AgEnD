// What is new on the task board for this person (docs/design/task-board.md, "Unread"): the cards someone answered, named them on or handed
// them to confirm or answer. The server works it out per person (GET /ui/tasks/unread — a session that can write; anyone else reads
// `enabled: false` and nothing is shown or marked), so this page only keeps the answer in the app store (`taskUnread`: { loaded, enabled,
// total, cards: { "M-12": { n, reasons, entries, at, by } } }) for the sidebar's number, the board's marks and the card's "new" tags.
// Installed once per admin page (app.js; the Tasks page also asks for it when it is shown, for a tab from before an upgrade). It reads
// again on the stream's `tasks` ping (a comment, a move), on a reconnect, when the tab is shown again, and once a minute while it is (a
// page that polls hears no pings). Not on `task_wakes`: how far a delivery got is never news to the person (the card page reads it). Opening a card marks it read (POST …/read) and the answer is
// the new state. No text of any comment is ever carried here: only numbers, reasons and who.
import { appStore } from "/assets/app-store.js";

let installed = false, reading = null, again = false, timer = null, poll = null;
const DEBOUNCE_MS = 400, POLL_MS = 60_000;

/** The page's unread (what the store holds), or the empty one. */
export const unreadState = () => appStore.get().taskUnread || { loaded: false, enabled: false, total: 0, cards: {} };

function keep(d) {
  const cards = d && d.cards && typeof d.cards === "object" ? d.cards : {};
  appStore.set({ taskUnread: { loaded: true, enabled: !!(d && d.enabled), total: Number.isSafeInteger(d && d.total) ? d.total : Object.keys(cards).length, cards } });
}

/** Read it again (one read at a time; a change meanwhile reads once more). Resolves true when it was read. */
export function refreshTaskUnread() {
  if (reading) { again = true; return reading; }
  // (Started inside the chain: a page being torn down — a late timer with no `fetch` left — is a failed read, not an exception in the timer.)
  reading = Promise.resolve().then(() => fetch("/ui/tasks/unread", { headers: { Accept: "application/json" }, cache: "no-store" }))
    .then((r) => { if (!r.ok) throw new Error(`task unread: ${r.status}`); return r.json(); })
    .then((d) => { keep(d); return true; })
    .catch(() => false)
    .finally(() => { reading = null; if (again) { again = false; void refreshTaskUnread(); } });
  return reading;
}

function soon() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void refreshTaskUnread(); }, DEBOUNCE_MS);
}

/**
 * The person opened a card: what was new on it, then marked read. Resolves `{ entries, reasons }` — the comments that were new, to
 * tag on the page — or null when nothing on it was (no mark is sent; a read-only session never has any). The store takes the
 * server's answer, so the number everywhere falls at once.
 */
export async function openedCard(code) {
  if (!unreadState().loaded) await refreshTaskUnread();
  const mine = unreadState().cards[code];
  if (!mine) return null;
  try {
    const r = await fetch(`/ui/tasks/cards/${encodeURIComponent(code)}/read`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (r.ok) keep({ enabled: true, ...(await r.json()) });
  } catch { /* the number stays until the next read; the card is open all the same */ }
  return { entries: Array.isArray(mine.entries) ? mine.entries : [], reasons: Array.isArray(mine.reasons) ? mine.reasons : [] };
}

/** Once per page: read now, and again as above. Safe to call twice. */
export function installTaskUnread() {
  if (installed) return;
  installed = true;
  void refreshTaskUnread();
  const sub = appStore.get().streamOn;
  if (typeof sub === "function") {
    sub("tasks", soon);
    sub("connection", (c) => { if (c === "live" || c === "polling") soon(); });
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => { if (!document.hidden) soon(); });
    poll = setInterval(() => { if (!document.hidden) soon(); }, POLL_MS);
    if (poll && typeof poll.unref === "function") poll.unref();
  }
}
