// M-3092 PR 2 (Hub rooms, track U): one room of a Hub with rooms, on the Fleet chat's own thread (/assets/chat-thread.js
// through panel-hub.js's HubThread). docs/design/hub-rooms-ux.md §3 says only where a room differs from the Fleet chat:
// - every message says who wrote it — a person by name (mine: on the right, no name), an agent as 「name · owner 的 Agent」,
//   the room assistant as 「房間助理 · Hub 提供」; the room's own lines (created, joined …) are the thread's status rows;
// - an answer is a reply to the message that asked for it (the thread's own quote, jumping to it);
// - under a message that asked several agents, one line of progress, live: 「已回答 7 · 處理中 2 · 稍後回覆 3」 → 「12 個
//   都回答了」; one agent: the Fleet's delivery marks on my own message; an answer still to come is not a row of its own.
// The store reads the room (seam 1 of docs/design/hub-rooms-split.md), keeps it live from the tab's one stream, sends with
// an idempotency key, and answers HubThread's store interface.
import { hroom } from "./hub-room-strings.js";

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined);
const BOOT = "room";

/** One room message's author line (spec §3). `mine`: no name (the thread puts it on the right). */
export function authorLine(author, mine = false) {
  if (!author || mine) return "";
  if (author.kind === "assistant") return hroom("authorAssistant");
  if (author.kind === "agent") return author.owner?.name ? hroom("authorAgent", String(author.name || ""), String(author.owner.name)) : String(author.name || "");
  return String(author.name || "");
}
/** The progress of a message that asked agents: one agent → its delivery mark; several → the line (spec §3). */
export function askState(ask) {
  if (!ask || !Number.isSafeInteger(ask.total) || ask.total < 1) return null;
  if (ask.total === 1) return { delivery: ask.answered >= 1 ? "delivered" : ask.working >= 1 ? "processing" : "queued" };
  return { line: ask.answered >= ask.total ? hroom("allAnswered", String(ask.total)) : hroom("askProgress", String(ask.answered || 0), String(ask.working || 0), String(ask.later || 0)) };
}

/**
 * Seam-1 messages (newest last) → the thread's messages. `ids`: a Map from a message id to its number in this thread
 * (the thread's keys and quotes are numbers), extended here in arrival order and kept by the caller.
 */
export function toThreadMessages(messages, { meId, ids }) {
  const out = [], byId = new Map(messages.map((m) => [m.id, m]));
  const num = (id) => { if (!ids.has(id)) ids.set(id, ids.size * 2 + 2); return ids.get(id); };
  for (const m of messages) {
    if (!m || typeof m.id !== "string") continue;
    const author = m.author || {}, kind = author.kind;
    // An answer still to come is counted in its question's progress line, not drawn as an empty bubble.
    if (m.answerTo && m.stage === "queued" && !m.text) continue;
    const id = num(m.id), mine = kind === "person" && author.id === meId;
    if (kind === "system") { out.push({ boot: BOOT, id, role: "status", sender: "", ts: iso(m.at), text: String(m.text || "") }); continue; }
    const quoted = m.replyTo ? byId.get(m.replyTo) : null;
    const state = mine ? askState(m.ask) : null;
    out.push({ boot: BOOT, id, role: kind === "person" ? "user" : "agent", sender: authorLine(author, mine), ts: iso(m.at), text: String(m.text || ""), mine,
      roomMessage: m.id, ...(state?.delivery ? { delivery: state.delivery } : {}),
      ...(quoted ? { replyTo: { boot: BOOT, id: num(quoted.id), sender: authorLine(quoted.author, quoted.author?.id === meId), text: String(quoted.text || "").slice(0, 120) } } : {}),
      ...(m.stage === "not-answered" ? { text: hroom("noAnswer") } : {}) });
    const line = askState(m.ask)?.line;
    if (line) out.push({ boot: BOOT, id: id + 1, role: "status", sender: "", ts: iso(m.at), text: line, progressOf: m.id });
    if (mine && m.warning === "assistant-unavailable") out.push({ boot: BOOT, id: id + 1, role: "status", sender: "", ts: iso(m.at), text: hroom("errAssistant") });
  }
  return out;
}

/**
 * One room's store: `subscribe(fn)` → unsubscribe; `detail()` (the room GET: room, me, members, settings), `messages()`
 * (the thread's), `raw()` (seam-1 messages), `loaded()`, `error()`, `closed()` (archived, or I am no longer in it), `room()`;
 * `send(text, { mentions, replyTo })` → the client's answer (a refusal's code is the caller's to word; a soft warning is
 * stored and drawn), `older()`, `markRead()`, `refresh()`, `stop()`. Reply buttons are not part of rooms: their calls are inert.
 */
export function createRoomStore(roomId, { client, meId = "" } = {}) {
  const subs = new Set(), ids = new Map();
  const st = { live: true, detail: null, messages: [], loaded: false, error: null, removed: false, more: false, view: [] };
  const changed = () => { st.view = toThreadMessages(st.messages, { meId: st.detail?.me?.id || meId, ids }); for (const fn of [...subs]) { try { fn(); } catch { /* a subscriber's own failure */ } } };
  const upsert = (m) => {
    if (!m || m.roomId !== roomId || typeof m.id !== "string") return;
    const i = st.messages.findIndex((x) => x.id === m.id || (m.idempotencyKey && x.idempotencyKey === m.idempotencyKey));
    if (i >= 0) st.messages[i] = { ...st.messages[i], ...m }; else st.messages.push(m);
  };
  const readDetail = async () => { const d = await client.room(roomId); if (!st.live) return; if (d.ok) st.detail = d; else if (!st.detail) st.error = d.code || "failed"; };
  async function refresh() {
    const [d, page] = await Promise.all([client.room(roomId), client.roomMessages(roomId, { limit: 50 })]);
    if (!st.live) return;
    if (d.ok) st.detail = d; else st.error = d.code || "failed";
    if (page.ok) { for (const m of page.messages || []) upsert(m); st.more = page.more === true; st.loaded = true; if (d.ok) st.error = null; }
    else st.error = page.code || "failed";
    changed();
  }
  const on = (fn) => (data) => { if (st.live && data && data.roomId === roomId) { fn(data); changed(); } };
  const unsubscribe = typeof client.subscribeRooms === "function" ? client.subscribeRooms({
    "message.added": on((d) => upsert(d.message)),
    "message.updated": on((d) => { upsert(d.message); if (d.parent) { const p = st.messages.find((x) => x.id === d.parent.id); if (p) p.ask = d.parent.ask; } }),
    "presence.changed": on((d) => { const m = st.detail?.members?.find((x) => x.id === d.memberId); if (m) { m.presence = d.presence; if (d.presenceNote) m.presenceNote = d.presenceNote; else delete m.presenceNote; } }),
    "member.changed": on(() => { void readDetail().then(changed); }),
    "room.changed": on((d) => { if (d.removed) st.removed = true; else if (d.room && st.detail) st.detail = { ...st.detail, room: { ...st.detail.room, ...d.room } }; }),
  }) : () => {};
  void refresh();
  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    detail: () => st.detail, raw: () => st.messages, messages: () => st.view, loaded: () => st.loaded, error: () => st.error,
    closed: () => st.removed || st.detail?.room?.archived === true, removed: () => st.removed, more: () => st.more,
    room: () => ({ ...(st.detail?.room || {}), ownerName: "" }),
    async send(text, { mentions = [], replyTo } = {}) {
      const idempotencyKey = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9-]/g, "");
      const r = await client.sendRoomMessage(roomId, { text, mentions, replyTo, idempotencyKey });
      if (r.ok && r.message) { upsert(r.message); changed(); }
      return r;
    },
    async older() {
      const first = st.messages[0]; if (!first || !st.more) return;
      const page = await client.roomMessages(roomId, { before: first.id, limit: 50 });
      if (!st.live || !page.ok) return;
      st.messages = [...(page.messages || []).filter((m) => !st.messages.some((x) => x.id === m.id)), ...st.messages]; st.more = page.more === true; changed();
    },
    markRead() { const last = st.messages.at(-1); return last ? client.markRoomRead(roomId, last.id) : Promise.resolve({ ok: true }); },
    refresh, clickButton: async () => ({ ok: false, code: "stopped" }), vote: async () => ({ ok: false, code: "stopped" }), busy: () => false, mine: () => [],
    stop() { st.live = false; subs.clear(); unsubscribe(); },
  };
}
