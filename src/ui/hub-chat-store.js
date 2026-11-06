// #3226 B: one Hub room's chat as the shared thread (/assets/chat-thread.js) draws it — the room's entries read over the
// Hub's API (hub-client.js), turned into the fleet thread's messages (hubEntryToMessages, the one mapping D, E and F
// extend), polled while the room is shown, and the asker's own questions sent.
//
// Polling: at most once per POLL_MS (the server paces each session's room at the same rate and answers a faster read
// with backpressure), one request at a time, paused while the page is hidden. Unanswered entries are read again (from
// just before the oldest open one); answered history is kept. The messages answer carries the room itself (its state,
// its grant's end, what its link negotiated: `room.features`), fresh each poll.
import { hubFileAttachment } from "./hub-attachments.js";
import { hubClient } from "./hub-client.js";

export const POLL_MS = 10_000;
/** The server's page: at most this many entries per read, the oldest first (rooms.read LIMIT 100). */
export const PAGE = 100;
/** Settled for paging: nothing about them changes on a later read ("uncertain" stays so: it is held, never resolved here). */
const SETTLED = new Set(["answered", "rejected", "cancelled", "failed", "uncertain"]);
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined);

/** A question's stage as the thread's delivery mark: waiting (◷), at the fleet (✓), answered (✓✓), refused (!). */
export function stageMark(stage) {
  return stage === "queued" ? "queued" : stage === "delivered" || stage === "consumed" ? "processing" : stage === "answered" ? "delivered"
    : stage === "uncertain" ? "cancelled" : "failed";
}

/**
 * One entry of GET /hub/v1/rooms/:id/messages → the thread's messages: the question (the asker's own, "user"), then the
 * answer (the agent's, under the exposure's name) or, for a question that was not answered, a status line saying why.
 * `question`/`answer` are plain strings (an older tab prints them as text); the files, buttons and quote D, E and F add
 * sit beside them (#3226 seams).
 */
export function hubEntryToMessages(entry, room, { me = "", reason = (code) => code || "" } = {}) {
  if (!entry || !Number.isSafeInteger(entry.sequence)) return [];
  const stage = entry.receipt ? entry.receipt.stage : "queued", at = entry.receipt ? entry.receipt.at : undefined;
  const id = entry.sequence * 2, out = [];
  // D: a Hub file in the shared thread's shape (hub-attachments.js); one the renderer cannot take is left out.
  const files = (list) => { const a = Array.isArray(list) ? list.map(hubFileAttachment).filter(Boolean) : []; return a.length ? { attachments: a } : {}; };
  out.push({ boot: "hub", id, role: "user", sender: me, ts: iso(entry.askedAt) ?? iso(at),
    text: entry.expired && entry.question === undefined ? "" : String(entry.question ?? ""), delivery: stageMark(stage),
    ...files(entry.questionFiles), ...(entry.quote ? { quote: entry.quote } : {}) });
  if (entry.answer !== undefined) {
    out.push({ boot: "hub", id: id + 1, role: "agent", sender: (room && room.exposureName) || "", ts: iso(at), text: String(entry.answer),
      ...files(entry.answerFiles), ...(entry.buttons ? { buttons: entry.buttons } : {}) });
  } else if (stage === "rejected" || stage === "cancelled" || stage === "failed" || stage === "uncertain") {
    out.push({ boot: "hub", id: id + 1, role: "status", sender: "", ts: iso(at), text: reason(entry.receipt && entry.receipt.reasonCode, stage) });
  }
  return out;
}

/**
 * The store of one room: `subscribe(fn)` (fn() on any change) → unsubscribe; `messages()`, `room()`, `working()` (the
 * question being worked on, if any: { since }), `closed()`; `refresh()` (a read now); `send(text, extras)`;
 * F's `clickButton(setId, index)`, `vote(setId, options)`, `busy(setId)`, `mine(setId)` (stubs until F); `stop()`.
 */
export function createHubChatStore(room, { client = hubClient(), me = "", reason, timers = globalThis, doc = typeof document !== "undefined" ? document : null } = {}) {
  const subs = new Set();
  const st = { live: true, timer: 0, inflight: false, entries: [], room: { ...room }, closed: false, error: null, pending: [], full: false };
  const emit = () => { for (const fn of subs) { try { fn(); } catch { /* a subscriber's own failure */ } } };
  const merge = (got) => {
    const byId = new Map(st.entries.map((e) => [e.messageId, e]));
    for (const e of got) byId.set(e.messageId, { ...byId.get(e.messageId), ...e });
    st.entries = [...byId.values()].sort((a, b) => a.sequence - b.sequence);
  };
  const schedule = (ms) => { timers.clearTimeout(st.timer); if (st.live && !st.closed) st.timer = timers.setTimeout(poll, ms); };
  async function poll() {
    if (!st.live || st.inflight || st.closed) return;
    if (doc && doc.hidden) { schedule(POLL_MS); return; }
    st.inflight = true;
    // Unsettled entries are read again (from just before the oldest one) — but a full page means there is more after
    // it: read on from the last one first, so an old open entry can never pin the read to the same page (#3246 review).
    const last = st.entries.length ? st.entries[st.entries.length - 1].sequence : 0;
    const open = st.full ? null : st.entries.find((e) => !SETTLED.has(e.receipt && e.receipt.stage));
    const after = open ? open.sequence - 1 : last;
    let r;
    try { r = await client.read(st.room.id, after); } catch { r = { ok: false, code: "unreachable" }; }
    st.inflight = false;
    if (!st.live) return;
    if (r.ok) {
      merge(r.entries || []);
      st.full = (r.entries || []).length >= PAGE;
      // The room as the server says it now. Its quota is the server's to give: absent means withdrawn (the owner hid it,
      // the grant is gone), never "unchanged" — a band once shown must not outlive that. An answer with no room at all
      // (an older Hub) keeps what is known.
      if (r.room) { st.room = { ...st.room, ...r.room }; if (!Object.prototype.hasOwnProperty.call(r.room, "quota")) delete st.room.quota; }
      st.pending = st.pending.filter((p) => !st.entries.some((e) => e.messageId === p.messageId));
      st.error = null; emit(); schedule(POLL_MS); return;
    }
    if (r.code === "revoked" || r.code === "not-found") { st.closed = true; emit(); return; }
    st.error = r.code || "failed"; emit();
    schedule(r.code === "backpressure" ? Math.max(POLL_MS, (r.retryAfter || 10) * 1000) : POLL_MS);
  }
  const onVisible = () => { if (doc && !doc.hidden) schedule(0); };
  if (doc) doc.addEventListener("visibilitychange", onVisible);
  poll();
  const newKey = () => {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const x = [...b].map((v) => v.toString(16).padStart(2, "0")).join("");
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  };
  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    room: () => st.room,
    closed: () => st.closed,
    error: () => st.error,
    entries: () => st.entries,
    messages() {
      const shown = st.entries.flatMap((e) => hubEntryToMessages(e, st.room, { me, reason }));
      // A question just sent shows at once (the next read brings its entry and replaces it).
      const last = st.entries.length ? st.entries[st.entries.length - 1].sequence : 0;
      const pend = st.pending.flatMap((p, i) => hubEntryToMessages({ messageId: p.messageId, sequence: last + 1 + i, askedAt: p.at, receipt: { stage: "queued", at: p.at }, question: p.text }, st.room, { me, reason }));
      return [...shown, ...pend];
    },
    /** The question the agent is working on now (the oldest "consumed" one), with when it started; null when none. */
    working() {
      const w = st.entries.find((e) => e.receipt && e.receipt.stage === "consumed");
      return w ? { since: w.receipt.at } : null;
    },
    refresh() { schedule(0); },
    /** #3226 D2: send passes `extras.files` to the client as given (hub-attachments checks the mark). */
    filesV1: true,
    async send(text, extras = {}) {
      const q = String(text || "").trim();
      if (!q || st.closed) return { ok: false, code: "invalid" };
      let r;
      try { r = await client.ask(st.room.id, newKey(), q, extras); } catch { r = { ok: false, code: "unreachable" }; }
      if (!r.ok) { if (r.code === "revoked") { st.closed = true; emit(); } return r; }
      st.pending.push({ messageId: r.receipt.messageId, text: q, at: r.receipt.at || Date.now() });
      emit();
      return r;
    },
    // F (buttons and polls) fills these four (#3226 seams); until then nothing can be clicked or voted.
    async clickButton() { return { ok: false, code: "unsupported" }; },
    async vote() { return { ok: false, code: "unsupported" }; },
    busy() { return false; },
    mine() { return []; },
    stop() {
      st.live = false; timers.clearTimeout(st.timer); subs.clear();
      if (doc) doc.removeEventListener("visibilitychange", onVisible);
    },
  };
}
