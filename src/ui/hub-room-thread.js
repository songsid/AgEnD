import {hp} from "./hub-personal-agent-strings.js";
// M-3092 PR 2 (Hub rooms, track U): one room of a Hub with rooms, on the Fleet chat's own thread (/assets/chat-thread.js
// through panel-hub.js's HubThread). docs/design/hub-rooms-ux.md §3 says only where a room differs from the Fleet chat:
// - every message says who wrote it — a person by name (mine: on the right, no name), an agent as 「name · owner 的 Agent」,
//   the room assistant as 「房間助理 · Hub 提供」; the room's own lines (created, joined …) are the thread's status rows;
// - an answer is a reply to the message that asked for it (the thread's own quote, jumping to it);
// - under a message that asked several agents, one line of progress, live: 「已回答 7 · 處理中 2 · 稍後回覆 3」 → 「12 個
//   都回答了」; one agent: the Fleet's delivery marks on my own message; an answer still to come is not a row of its own.
// The store reads the room (seam 1 of docs/design/hub-rooms-split.md), keeps it live from the tab's one stream, sends with
// an idempotency key, and answers HubThread's store interface.
import { html, useEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { agentStopText, hra } from "./hub-room-agent-strings.js";
import { WorkBarView } from "/assets/chat-composer.js";
import { RailFrame } from "/assets/side-rail.js";
import { Icon } from "/assets/ui-icons.js";
import { Empty } from "/assets/ui-states.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Menu } from "/assets/ui-menu.js";
import { toast } from "/assets/ui-toast.js";
import { register, t } from "/assets/app-i18n.js";
import "./hub-strings.js";
import { firstCharacter } from "/assets/instance-nav.js";
import { hroom } from "./hub-room-strings.js";
import {ha} from "./hub-ai-apps-strings.js";
import { RoomComposer } from "./hub-room-composer.js";
import { TextSizeButton } from "/assets/header-tools.js";
import { HubNotifyToggle } from "./hub-room-notify.js";
import { createHubButtonActions } from "./hub-button-actions.js";
import { linkRoomsU2Css } from "./hub-room-new-strings.js";
import { workingLine } from "./hub-room-working.js";
import { roomSource, mountSourceAuthor } from "./hub-room-source.js";
import { countsLine } from "./hub-room-list.js";
import { PendingFiles, hf, hubFileAttachment, pageCarriesFiles, roomTakesFiles, uploadChosen } from "./hub-attachments.js";
import { LightboxHost, openLightbox } from "/assets/image-lightbox.js";
// M-3125 PR3: the one quote target an annotated room picture has (here, so a page with an older dictionary has the words).
register("hubRoomAnnotate", { en: { quote: "Quote in this room" }, "zh-TW": { quote: "引用到這個房間" } });

linkRoomsU2Css();   // M-3127: the reaction chips and picker are drawn from hub-rooms-u2.css (a room opened before any U2 panel)
/** M-3127 C: the message a search hit opens (`?room=…&m=<id>`), or null. */
export const jumpParam = () => { try { const v = new URLSearchParams(location.search).get("m"); return v && /^[A-Za-z0-9-]{1,64}$/.test(v) ? v : null; } catch { return null; } };
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined);
const BOOT = "room";

/**
 * One room message's author line (spec §3). `mine`: no name (the thread puts it on the right). The assistant is named by
 * its flag, never by its stored name (Ridge: that is an older renderer's fallback): 「房間助理 · Hub 提供」 in a room,
 * 「Hub 助理」 in its own one-to-one (`direct`).
 */
export function authorLine(author, mine = false, direct = false) {
  if (!author) return "";
  if (author.via?.name) return hra("via", String(author.name || ""), String(author.via.name));
  if (mine) return "";
  if (author.kind === "assistant") return direct ? hroom("hubAssistant") : hroom("authorAssistant");
  if (author.kind === "agent") {
    if (!author.owner?.name) return String(author.name || "");
    // 「Alex 的 Agent」: a Latin owner name keeps a space before a CJK word that follows it (Lumen); 「林小華的 Agent」 none.
    const owner = String(author.owner.name), plain = hroom("authorAgent", "\u0001", "\u0002");
    return hroom("authorAgent", String(author.name || ""), /[A-Za-z0-9)]$/.test(owner) && /\u0002[\u3400-\u9fff]/.test(plain) ? `${owner} ` : owner);
  }
  return String(author.name || "");
}
/**
 * A room's own line in this viewer's words (Ridge: `system` { kind, name } beside the stored text): a kind this page does
 * not know, or an older row without `system`, keeps the stored text.
 */
const SYSTEM = { "room-created": "createdSys", "member-joined": "sysJoined", "admin-joined": "sysAdminJoined", "poll-closed": "sysPollClosed" };
export function systemText(m) {
  if(m?.system?.kind==="app-rate-limited")return ha("rateLimited",m.system.name||"");
  if (m?.system?.kind === "agent-mention-stopped") return agentStopText(m.system) ?? String(m.text || "");
  const key = m && m.system && SYSTEM[m.system.kind];
  return key && typeof m.system.name === "string" ? hroom(key, m.system.name) : String((m && m.text) || "");
}
/**
 * The progress of a message that asked agents (spec §3, Lumen): one agent → its delivery mark; several → one line, its
 * parts without a 0 ("Answered 1 · Working 1"); every one answered → the delivered tick again, no line. Failed (!) and
 * blocked (⊘) use the Fleet ticks: `failed` / `blocked` on `ask` when the server sends them, else a `not-answered`
 * child counts as failed.
 */
const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const REASON = { expired: "reasonExpired", unavailable: "reasonUnavailable", interrupted: "reasonInterrupted", retired: "reasonRetired", unknown: "reasonUnknown" };
export function askReason(code) { return REASON[code] ? hroom(REASON[code]) : ""; }
export function askState(ask) {
  if (!ask || !Number.isSafeInteger(ask.total) || ask.total < 1) return null;
  const answered = count(ask.answered), working = count(ask.working), later = count(ask.later);
  const failed = count(ask.failed), blocked = count(ask.blocked);
  const reason = typeof ask.reason === "string" && ask.reason ? ask.reason : "";
  const parts = [[answered, "progAnswered"], [working, "progWorking"], [later, "progLater"], [failed, "progFailed"], [blocked, "progBlocked"]]
    .filter(([n]) => n > 0).map(([n, k]) => hroom(k, String(n)));
  const allIn = answered + failed + blocked >= ask.total && working < 1 && later < 1;
  if (ask.total === 1 || (allIn && failed < 1 && blocked < 1)) {
    const delivery = answered >= ask.total ? "delivered" : working >= 1 ? "processing" : failed >= 1 ? "failed" : blocked >= 1 ? "cancelled" : "queued";
    return { delivery, ...(reason && (delivery === "failed" || delivery === "cancelled") ? { reason } : {}) };
  }
  return { line: parts.join(" · "), ...(reason ? { reason } : {}) };
}
/** When the server has not yet named failed/blocked, a stored `not-answered` child is failed. */
function askOf(m, messages) {
  const ask = m && m.ask;
  if (!ask) return ask;
  if (Number.isSafeInteger(ask.failed) || Number.isSafeInteger(ask.blocked)) return ask;
  const notAns = messages.filter((x) => x.answerTo === m.id && x.stage === "not-answered").length;
  return notAns ? { ...ask, failed: notAns } : ask;
}
/**
 * M-3127: a message's reactions as the thread's chips — `mine` from my member id, the label naming who (from the room's
 * members; someone no longer listed counts among "others"): 「Alex、Bob 和其他 3 人 回應了 👍」.
 */
export function reactionBar(reactions, { meId = "", names = new Map() } = {}) {
  if (!Array.isArray(reactions)) return undefined;
  return reactions.filter((r) => r && typeof r.emoji === "string" && Number(r.count) > 0).map((r) => {
    const members = Array.isArray(r.members) ? r.members : [], mine = members.includes(meId);
    const known = members.filter((id) => id !== meId && names.has(id)).map((id) => names.get(id));
    const who = [...(mine ? [hroom("reactYou")] : []), ...known].slice(0, 3), rest = Number(r.count) - who.length;
    const list = who.join(hroom("listSep"));
    return { emoji: r.emoji, count: Number(r.count), mine, label: hroom("reactedWith", rest > 0 ? (who.length ? hroom("reactMore", list, String(rest)) : String(r.count)) : list, r.emoji) };
  });
}
/**
 * M-3127 B: an answer's buttons as the thread draws them. A poll is everyone's. Plain buttons answer only the question's
 * asker: anyone else sees them shut, with whose they are (「只有 Alex 能回答」); the asker sees them open.
 */
export function roomButtons(b, meId = "") {
  if (!b || typeof b.id !== "string" || !Array.isArray(b.labels)) return undefined;
  const { asker, ...view } = b;
  if (view.poll || !asker || asker.id === meId || view.state !== "open") return view;
  return { ...view, state: "locked", note: hroom("onlyAsker", String(asker.name || "")) };
}
/** How many answers of one question show when they are folded, and from how many they fold (Lumen: all up to 5). */
export const ANSWERS_SHOWN = 3, FOLD_FROM = 6;

/**
 * Seam-1 messages (newest last) → the thread's messages. `ids`: a Map from a message id to its number in this thread
 * (the thread's keys and quotes are numbers), extended here in arrival order and kept by the caller.
 */
export function toThreadMessages(messages, { meId, ids, direct = false, expanded = new Set(), summarise = false, names = new Map() }) {
  const stops = messages.filter(m => m?.system?.kind === "agent-mention-stopped"), ordered = messages.filter(m => !stops.includes(m));
  for (const stop of stops) { const parent = ordered.findIndex(m => m.id === stop.system.sourceId); if (parent < 0) ordered.push(stop); else { let i = parent + 1; while (ordered[i]?.system?.sourceId === stop.system.sourceId) i++; ordered.splice(i, 0, stop); } }
  const out = [], byId = new Map(messages.map((m) => [m.id, m]));
  // Each question's answers that have text, in arrival order: past ANSWERS_SHOWN they wait behind one 「展開其餘 N 則」.
  const answersOf = new Map();
  const drawn = (m) => !!m.text || (Array.isArray(m.files) && m.files.length > 0) || m.stage === "not-answered";   // its text or files (M-3125), or that none came (Ridge)
  for (const m of messages) if (m && m.answerTo && drawn(m)) answersOf.set(m.answerTo, [...(answersOf.get(m.answerTo) || []), m.id]);
  const num = (id) => { if (!ids.has(id)) ids.set(id, ids.size * 2 + 2); return ids.get(id); };
  for (const m of ordered) {
    if (!m || typeof m.id !== "string") continue;
    const author = m.author || {}, kind = author.kind;
    // An answer still to come (queued, or being worked on: the working bar says who) is never an empty bubble.
    if (m.answerTo && !m.text && (m.stage === "queued" || m.stage === "working")) continue;
    // A question with FOLD_FROM answers or more shows its first ANSWERS_SHOWN; the rest wait behind one link right under the
    // last one shown (until it is opened). Fewer than FOLD_FROM: every answer shows.
    let foldAfter = null, lastShown = false;
    if (m.answerTo) {
      const list = answersOf.get(m.answerTo) || [], at = list.indexOf(m.id);
      const folded = !direct && !expanded.has(m.answerTo) && list.length >= FOLD_FROM;
      if (folded && at >= ANSWERS_SHOWN) continue;
      if (folded && at === ANSWERS_SHOWN - 1) foldAfter = { label: hroom("expandRest", String(list.length - ANSWERS_SHOWN)), arg: m.answerTo };
      lastShown = at >= 0 && at === (folded ? ANSWERS_SHOWN - 1 : list.length - 1);
    }
    const id = num(m.id), mine = kind === "person" && !author.via && author.id === meId;
    if (kind === "system") { out.push({ boot: BOOT, id, role: "status", sender: "", ...(m.system?.kind === "agent-mention-stopped" ? { wrap: true } : { ts: iso(m.at) }), text: systemText(m), bare: true }); continue; }
    // An answer is a reply to the message that asked for it (the Fleet's reply reference): replyTo, else answerTo.
    // The quote chip keeps a stable key even when that original is not in this page (scroll-up / findQuoted loads it).
    const quotedId = m.replyTo || m.answerTo || "";
    const quoted = quotedId ? byId.get(quotedId) : null;
    const state = askState(askOf(m, messages)), sourceBadge = roomSource(author);
    out.push({ boot: BOOT, id, role: kind === "person" && !author.via ? "user" : "agent", sender: authorLine(author, mine, direct), ts: iso(m.at), text: String(m.text || ""), mine,
      ...(sourceBadge ? { sourceBadge } : {}),
      ...(kind === "person" && !mine && !author.via ? { person: true } : {}),   // Lumen (spec §3): someone else's words, a bubble on the left
      roomMessage: m.id, ...(mine && state?.delivery ? { delivery: state.delivery } : {}),
      // M-3125: a post's files, as the 1:1 chat maps them (images inline through the Hub's own route; HTML gets its preview card).
      ...(() => { const files = Array.isArray(m.files) ? m.files.map(hubFileAttachment).filter(Boolean) : []; return files.length ? { attachments: files } : {}; })(),
      ...(!direct && Array.isArray(m.reactions) && m.reactions.length ? { reactionBar: reactionBar(m.reactions, { meId, names }) } : {}),
      ...(!direct && kind !== "person" && m.buttons ? { buttons: roomButtons(m.buttons, meId) } : {}),
      ...(quotedId ? { replyTo: { boot: BOOT, id: num(quotedId), sender: quoted ? authorLine(quoted.author, quoted.author?.id === meId, direct) : "", text: quoted ? String(quoted.text || "").slice(0, 120) : "" } } : {}),
      ...(m.stage === "not-answered" ? { text: hroom("noAnswer") } : {}) });
    if (foldAfter) out.push({ boot: BOOT, id: num(`expand:${foldAfter.arg}`), role: "status", sender: "", text: "", bare: true, fold: true, action: foldAfter });
    // Spec §10: once an @所有 Agent has answers, under the last one shown, 「請房間助理整理」 (it sends 「@房間助理 整理上面的回答」).
    if (summarise && lastShown && byId.get(m.answerTo)?.mentions?.includes("all"))
      out.push({ boot: BOOT, id: num(`summarise:${m.answerTo}`), role: "status", sender: "", text: "", bare: true, action: { label: hroom("askSummarise"), arg: `summarise:${m.answerTo}` } });
    const line = state?.line, why = !line && mine ? askReason(state?.reason) : "";
    // Its status, not an event: under it, without a time of its own.
    if (line) out.push({ boot: BOOT, id: id + 1, role: "status", sender: "", text: line, progressOf: m.id, bare: true });
    else if (why) out.push({ boot: BOOT, id: id + 1, role: "status", sender: "", text: why, progressOf: m.id, bare: true });
    if (mine && m.warning === "assistant-unavailable") out.push({ boot: BOOT, id: id + 1, role: "status", sender: "", ts: iso(m.at), text: hroom("errAssistant"), bare: true });
  }
  return out;
}

/**
 * One room's store: `subscribe(fn)` → unsubscribe; `detail()` (the room GET: room, me, members, settings), `messages()`
 * (the thread's), `raw()` (seam-1 messages), `loaded()`, `error()`, `closed()` (archived, or I am no longer in it), `room()`;
 * `send(text, { mentions, replyTo })` → the client's answer (a refusal's code is the caller's to word; a soft warning is
 * stored and drawn), `older()`, `findQuoted(key)`, `markRead()`, `refresh()`, `stop()`. M-3127 B: `clickButton` / `vote` / `busy` / `mine` are the direct chat's button actions (hub-button-actions.js), on group rooms only.
 */
export function createRoomStore(roomId, { client, meId = "" } = {}) {
  const subs = new Set(), ids = new Map(), expanded = new Set();
  const st = { live: true, detail: null, messages: [], loaded: false, error: null, removed: false, more: false, view: [] };
  let loadingOlder = false;
  // The room's committed order (Ridge: `sequence`, from the stored row): a waiting answer replaced in place, or an event that
  // arrives out of order, is drawn where the room has it. Rows without it (a direct chat, an older Hub) keep arrival order.
  const closedNow = () => st.removed || st.detail?.room?.archived === true;
  const ordered = () => { if (st.messages.length && st.messages.every((m) => Number.isSafeInteger(m.sequence))) st.messages.sort((a, b) => a.sequence - b.sequence); };
  const changed = () => { ordered(); st.view = toThreadMessages(st.messages, { meId: st.detail?.me?.id || meId, ids, direct: st.detail?.room?.kind === "direct", expanded,
    summarise: st.detail?.room?.kind === "group" && (st.detail?.members || []).some((x) => x.kind === "assistant") && !closedNow(),
    names: new Map((st.detail?.members || []).filter((x) => x && typeof x.id === "string").map((x) => [x.id, x.kind === "assistant" ? hroom("roomAssistant") : String(x.name || "")])) }); for (const fn of [...subs]) { try { fn(); } catch { /* a subscriber's own failure */ } } };
  const upsert = (m) => {
    if (!m || m.roomId !== roomId || typeof m.id !== "string") return;
    const i = st.messages.findIndex((x) => x.id === m.id || (m.idempotencyKey && x.idempotencyKey === m.idempotencyKey));
    // The server always sends the whole message: one without reactions has none left (M-3127), never the old ones.
    if (i >= 0) { const next = { ...st.messages[i], ...m }; if (!("reactions" in m)) delete next.reactions; st.messages[i] = next; } else st.messages.push(m);
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
  // M-3127 B: an answer's buttons and polls — the direct chat's own actions (one key per intent, my vote kept in this tab),
  // on this room's messages; the Hub says who may press (403 not-asker) and closes polls.
  const actions = createHubButtonActions({ id: roomId, get features() { return closedNow() || st.detail?.room?.kind !== "group" ? [] : ["buttons-v1"]; } }, {
    client, entries: () => st.view, refresh: () => refresh(), changed: () => { for (const fn of [...subs]) { try { fn(); } catch { /* a subscriber's own failure */ } } },
  });
  const unsubscribe = typeof client.subscribeRooms === "function" ? client.subscribeRooms({
    "message.added": on((d) => upsert(d.message)),
    "message.updated": on((d) => { upsert(d.message); if (d.parent) { const p = st.messages.find((x) => x.id === d.parent.id); if (p) p.ask = d.parent.ask; } }),
    // The member's live state as sent: presence, and its note and reason only while the event carries them (a reason
    // alone updates it; an event without one clears it — never a stale reason).
    "presence.changed": on((d) => { const m = st.detail?.members?.find((x) => x.id === d.memberId); if (m) { m.presence = d.presence;
      for (const k of ["presenceNote", "presenceReason"]) { if (d[k]) m[k] = d[k]; else delete m[k]; } } }),
    "member.changed": on(() => { void readDetail().then(changed); }),
    "room.changed": on((d) => { if (d.removed) st.removed = true; else if (d.room && st.detail) st.detail = { ...st.detail, room: { ...st.detail.room, ...d.room } }; }),
  }) : () => {};
  /** One page older than what is held (the server's `before=`). False when there was nothing to fetch. */
  async function older() {
    if (!st.live || loadingOlder || !st.more) return false;
    const first = st.messages[0]; if (!first) return false;
    loadingOlder = true;
    let did = false;
    try {
      const page = await client.roomMessages(roomId, { before: first.id, limit: 50 });
      if (!st.live || !page.ok) return false;
      const incoming = (page.messages || []).filter((m) => !st.messages.some((x) => x.id === m.id));
      if (!incoming.length) st.more = false;
      else { st.messages = [...incoming, ...st.messages]; st.more = page.more === true; did = true; }
    } finally { loadingOlder = false; }
    changed();
    return did;
  }
  /** The thread's quote key (`room-N`) or a stored message id: load pages until that row is held, then true. */
  async function findQuoted(key) {
    if (typeof key !== "string" || !key) return false;
    const wanted = st.messages.some((m) => m.id === key) ? key : (() => {
      const n = Number(key.startsWith(`${BOOT}-`) ? key.slice(BOOT.length + 1) : key);
      if (!Number.isSafeInteger(n)) return null;
      for (const [id, v] of ids) if (v === n) return id;
      return null;
    })();
    if (!wanted) return false;
    while (st.live && !st.messages.some((m) => m.id === wanted) && st.more) {
      const n = st.messages.length;
      await older();
      if (st.messages.length === n) break;
    }
    return st.messages.some((m) => m.id === wanted);
  }
  void refresh();
  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    detail: () => st.detail, raw: () => st.messages, messages: () => st.view, loaded: () => st.loaded, error: () => st.error,
    closed: closedNow, removed: () => st.removed, more: () => st.more,
    room: () => ({ ...(st.detail?.room || {}), ownerName: "" }),
    // M-3125: this store carries files (pageCarriesFiles reads the mark), sent as the post's `files`.
    filesV1: true,
    async send(text, { mentions = [], replyTo, files } = {}) {
      const idempotencyKey = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9-]/g, "");
      const r = await client.sendRoomMessage(roomId, { text, mentions, replyTo, idempotencyKey, ...(files?.length ? { files } : {}) });
      // The stored message, as the Hub answers it: `{ message }`, or the message itself (Ridge's server) — drawn at once,
      // whether or not the stream is up yet (a first send after opening the room must not vanish).
      const { ok, ...bare } = r || {};
      const sent = r && r.message ? r.message : ok && typeof bare.id === "string" && typeof bare.roomId === "string" ? bare : null;
      if (ok && sent) { upsert(sent); changed(); }
      return r;
    },
    older, findQuoted,
    /**
     * M-3127 C: the thread key of message `messageId`, loading older pages (at most 40) until it is here, and opening its
     * question's folded answers when it is one of them; null when this room no longer has it (or I may not see it).
     */
    async find(messageId) {
      for (let i = 0; i <= 40 && st.live; i++) {
        const m = st.messages.find((x) => x.id === messageId);
        if (m) {
          if (m.answerTo && !expanded.has(m.answerTo)) { expanded.add(m.answerTo); changed(); }
          const x = st.view.find((v) => v.roomMessage === messageId);
          return x ? `${x.boot}-${x.id}` : null;
        }
        if (!st.more) return null;
        const before = st.messages.length; await older();
        if (st.messages.length === before) return null;   // a page that failed or brought nothing new
      }
      return null;
    },
    /** 「展開其餘 N 則」: show every answer of that question. */
    expand(messageId) { if (typeof messageId === "string" && !expanded.has(messageId)) { expanded.add(messageId); changed(); } },
    /** Who is working on an answer in this room now (its answer row has no text yet): their names, in arrival order. */
    working() { return this.workers().map((w) => w.name); },
    /** The same, as members ({ kind, name }) — what workingLine() words (the room assistant by its own name). */
    workers() { return st.messages.filter((m) => m.answerTo && !m.text && m.stage === "working" && m.author?.name).map((m) => ({ kind: m.author.kind === "assistant" ? "assistant" : "agent", name: String(m.author.name) })); },
    /**
     * M-3127: add or take back my reaction on a message of this group room. The answer's reactions are drawn at once (the
     * stream's message.updated brings the same); a refusal leaves the message as it was → the client's answer.
     */
    async react(messageId, emoji, on) {
      if (closedNow() || st.detail?.room?.kind !== "group" || typeof client.reactRoomMessage !== "function") return { ok: false, code: "closed" };
      const r = await client.reactRoomMessage(roomId, messageId, emoji, on);
      const m = st.messages.find((x) => x.id === messageId);
      if (st.live && r?.ok && m && Array.isArray(r.reactions)) { if (r.reactions.length) m.reactions = r.reactions; else delete m.reactions; changed(); }
      return r;
    },
    markRead() { const last = st.messages.at(-1); return last ? client.markRoomRead(roomId, last.id) : Promise.resolve({ ok: true }); },
    refresh, clickButton: actions.clickButton, vote: actions.vote, busy: actions.busy, mine: actions.mine,
    stop() { st.live = false; subs.clear(); unsubscribe(); actions.stop(); },
  };
}

/**
 * Wide enough for the side rail: the shared stylesheet hides `.u-rail` below 1200 px (app.css), so a narrower page shows
 * the members panel in a sheet instead (spec §2: on a phone, a bottom drawer) — the Fleet's rail rule itself unchanged.
 */
const RAIL_QUERY = "(min-width: 1200px)";
function useRailWide() {
  const q = typeof matchMedia === "function" ? matchMedia(RAIL_QUERY) : null;
  const [wide, setWide] = useState(() => !!q?.matches);
  useEffect(() => { if (!q) return undefined; const on = () => setWide(!!q.matches); q.addEventListener?.("change", on); return () => q.removeEventListener?.("change", on); }, []);
  return wide;
}
/** dev-claude2's members panel (hub-room-members.js), when this Hub serves it; otherwise the rail stays closed. */
function useMembersPanel() {
  const [Panel, setPanel] = useState(null);
  useEffect(() => { let live = true; import("./hub-room-members.js").then((m) => { if (live && typeof m.RoomMembersPanel === "function") setPanel(() => m.RoomMembersPanel); }, () => {}); return () => { live = false; }; }, []);
  return Panel;
}

/**
 * A room of a Hub with rooms (spec §3–§5): its header (a square avatar, its name, "3 人 · 12 個 Agent · 房間助理"), the
 * Fleet chat's thread (panel-hub.js's HubThread, given as `Thread`: the thread wiring is one), the room's composer, and
 * the members panel on the right. `client`: the Hub client; `me`: { id } from the session.
 */
export function HubRoomPage({ roomId, listed = null, Thread, client, meId = "", rooms = [], openRoom = () => {}, goList = () => {}, onLeft = () => {}, onMe = () => {} }) {
  const store = useMemo(() => createRoomStore(roomId, { client, meId }), [roomId]);
  useEffect(() => () => store.stop(), [store]);
  const [, tick] = useState(0);
  // The first read may land before this subscribes: read once more on subscribing.
  useEffect(() => { const off = store.subscribe(() => tick((n) => n + 1)); tick((n) => n + 1); return off; }, [store]);
  const [reply, setReply] = useState(null), [rail, setRail] = useState(true), [sheet, setSheet] = useState(false);
  // M-3125: the room's pending files, as in a 1:1 chat (hub-attachments.js): Attach left of the box, chips inside it.
  // The ref moves with every set, not on the next render: uploadChosen reads it between its own sets (as panel-hub.js does).
  const [files, setFilesState] = useState([]), filesRef = useRef([]), alive = useRef(true), [fileMsg, setFileMsg] = useState("");
  const setFiles = (next) => { filesRef.current = next; setFilesState(next); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setFiles([]); setFileMsg(""); }, [roomId]);
  const wide = useRailWide();
  const input = useRef(null), threadRef = useRef(null), insert = useRef(null);
  const Panel = useMembersPanel();
  // dev-claude2's room settings (hub-room-settings.js), opened from the header or the members panel.
  const [settings, setSettings] = useState(null);
  const openSettings = () => { import("./hub-room-settings.js").then((m) => { if (typeof m.RoomSettings === "function") setSettings(() => m.RoomSettings); }, () => {}); };
  // Lumen (spec §3, §7): 「離開房間」 for everyone in a group room, through U2's leaveRoom (the last manager is told why not).
  const [leaveError, setLeaveError] = useState("");
  const leave = async () => {
    setLeaveError("");
    const m = await import("./hub-room-settings.js").catch(() => null);
    if (typeof m?.leaveRoom !== "function") return;
    const r = await m.leaveRoom(client, roomId, store.detail()?.me?.id || meId);
    if (r.ok) onLeft(); else setLeaveError(r.text);
  };
  const detail = store.detail(), room = detail?.room || listed || {}, group = room.kind === "group";
  // The page-level rooms notifier learns this person's id for this room from its detail (§12; member
  // ids are per room, so the id is kept under this room's id).
  useEffect(() => { const id = detail && detail.me && detail.me.id; if (id) onMe(roomId, id); }, [detail && detail.me && detail.me.id]);
  // M-3125: Attach only where this page and this room carry files and the room is open; chosen files ride the next send.
  const takesFiles = pageCarriesFiles(client, store) && roomTakesFiles(room) && !store.closed();
  const attach = takesFiles ? { title: hf("attach"), onFiles: async (list) => {
    setFileMsg("");
    const refused = await uploadChosen(client, room.id || roomId, list, { current: () => filesRef.current, set: setFiles, alive: () => alive.current });
    if (alive.current && refused.length) setFileMsg(refused.join(" "));
  } } : null;
  const pending = files.length || fileMsg ? html`<${PendingFiles} files=${files} onRemove=${(key) => setFiles(filesRef.current.filter((f) => f.key !== key))}
    formatSize=${(n) => (globalThis.AgendChatRender?.formatSize ? globalThis.AgendChatRender.formatSize(n) : `${n} B`)} />${fileMsg ? html`<p class="note" role="alert">${fileMsg}</p>` : null}` : null;
  // The composer sends through the store; this one adds the ready files, waits for uploads, and clears only what was sent.
  const annotateRef = useRef(null);
  annotateRef.current = (img) => {
    if (!takesFiles || typeof File !== "function") return null;
    const key = img?.closest?.(".msg[data-key]")?.getAttribute("data-key") || "";
    const message = store.messages().find((x) => `${x.boot}-${x.id}` === key) || null;
    return { notice: (text) => setFileMsg(text), targets: [{ key: "self", label: t("hubRoomAnnotate.quote"), quote: (file, live = () => true) => {
      if (!live() || !alive.current || store.closed()) return false;
      void uploadChosen(client, room.id || roomId, [file], { current: () => filesRef.current, set: setFiles, alive: () => alive.current })
        .then((refused) => { if (alive.current && refused.length) setFileMsg(refused.join(" ")); });
      if (message) setReply(message);
      setTimeout(() => input.current?.focus(), 0);
      return true;
    } }] };
  };
  const sendStore = useMemo(() => ({ ...store, send: async (text, opts = {}) => {
    if (filesRef.current.some((f) => f.state === "uploading")) { setFileMsg(hf("waitUpload")); return { ok: false, code: "uploading" }; }
    const chosen = filesRef.current.filter((f) => f.state === "ready");
    const r = await store.send(text, { ...opts, ...(chosen.length ? { files: chosen.map((f) => f.id) } : {}) });
    if (r?.ok && chosen.length) { const sent = new Set(chosen.map((f) => f.key)); setFiles(filesRef.current.filter((f) => !sent.has(f.key))); }
    return r;
  } }), [store]);
  // The Hub assistant's one-to-one is named by its flag, in this viewer's words (its stored name is a fallback).
  const title = room.assistant ? hroom("hubAssistant") : String(room.name || "");
  const hasAssistant = (detail?.members || []).some((m) => m.kind === "assistant");
  // M-3127 C: a search hit opens the room at its message — loaded back to it, scrolled to and flashed (the thread's reveal),
  // then the address loses `m` (a reload does not jump again). Read each render: a hit in the room already open jumps too.
  const jump = jumpParam();
  useEffect(() => {
    if (!jump) return undefined;
    let live = true;
    void (async () => {
      if (!store.loaded()) await new Promise((done) => { const off = store.subscribe(() => { if (store.loaded() || store.error()) { off(); done(); } }); });
      const key = live ? await store.find(jump) : null;
      if (!live) return;
      if (key) setTimeout(() => threadRef.current?.reveal(key), 60); else toast(hroom("jumpMissing"), false);
      try { const u = new URL(location.href); u.searchParams.delete("m"); history.replaceState(history.state, "", `${u.pathname}${u.search}${u.hash}`); } catch { /* the address stays */ }
    })();
    return () => { live = false; };
  }, [store, jump]);
  // Read when shown: the latest message once loaded and again as messages arrive while the page is visible.
  const count = store.raw().length;
  useEffect(() => { if (store.loaded() && (typeof document === "undefined" || !document.hidden)) void store.markRead(); }, [store.loaded(), count]);
  // The room's own mention labels, accented in every bubble as 「@Notes」 is (Lumen): @所有 Agent, the assistant, each member —
  // read when the thread draws (the thread keeps its options from its first render, before the room's members are known).
  const labels = () => [hroom("mentionAll"), hroom("mentionAssistant"), ...(store.detail()?.members || []).filter((m) => m.kind !== "assistant").map((m) => `@${m.name}`)];
  const extra = {
    isUser: (x) => x.mine === true, canReply: () => !store.closed(),
    senderBadge: mountSourceAuthor,
    mentionLabels: labels,
    // A line's one action: 「展開其餘 N 則」, or 「請房間助理整理」 (spec §10: the same as sending 「@房間助理 整理上面的回答」).
    statusAction: (arg) => { if (String(arg).startsWith("summarise:")) { if (!store.closed()) void store.send(hroom("summarisePrompt"), { mentions: ["assistant"] }); } else store.expand(arg); },
    startReply: (x) => { setReply(x); setTimeout(() => input.current?.focus(), 0); },
    findQuoted: (key) => store.findQuoted(key),
    // M-3127: people's reactions — a group room's messages (not a room line), while the room is open to me. Read when the
    // thread draws: these options are kept from the first render, before the room's kind is known.
    react: (x, emoji, on) => { void store.react(x.roomMessage, emoji, on).then((r) => { if (!r?.ok && r?.code !== "closed") toast(hroom("reactFailed"), false); }); },
    canReact: () => store.detail()?.room?.kind === "group" && !store.closed(),
    reactText: (k) => (k === "add" ? hroom("reactAdd") : k === "pick" ? hroom("reactPick") : ""),
    reactLabel: hroom("reactAdd"),   // the message menu's React (web-claude's HubThread, M-3117 PR 2: phones)
    // M-3125 PR3: a room picture opens full size in the page; 「標註」 then quotes the marked-up copy here — it joins this
    // composer's files (uploaded like any chosen file) and the reply quotes the message it came from. Read at click time
    // (the thread keeps its options from its first render).
    openImage: (links, img) => openLightbox(links, img, annotateRef.current(img)),
  };
  const line2 = group ? `${countsLine(room.people, room.agents)}${hasAssistant ? ` · ${hroom("roomAssistant")}` : ""}`
    : room.assistant ? hroom("providedByHub") : room.agent?.answerOnly ? hp("answerOnlyAsker") : String(room.agent?.owner?.name || "");
  const showRail = wide && rail && Panel && group && detail;
  // The Fleet chat's working bar (Lumen): 「Notes 正在處理」, or 「2 個 Agent 正在處理」 — the answer row only when it arrives.
  // Who: this room's answers being worked on; the words: workingLine() (#3857), the one place that says it.
  const working = workingLine({ members: store.workers().map((w) => ({ ...w, presence: "working" })) });
  const panel = Panel && detail ? html`<${Panel} client=${client} roomId=${roomId} detail=${detail}
        onMention=${(m) => { setSheet(false); insert.current?.(`@${m.name}`); }}
        onOpenChat=${(m) => { const direct = rooms.find((r) => r.kind === "direct" && r.agent?.exposureId === m.id); if (direct) openRoom(direct.id); }}
        onSettings=${() => { setSheet(false); openSettings(); }} />` : null;
  return html`<div class=${`hub-chat hub-room-page${showRail ? " with-rail" : ""}`} data-room=${roomId}>
    <${LightboxHost} />
    <section class="hub-chat-main">
      <header class="hub-chat-head" data-trust="panel-content">
        ${/* Lumen (spec §2): on a phone the header starts with the Fleet chat's back to the list. */ ""}
        <a class="icon-btn hub-back only-narrow" href="/ui/hub" aria-label=${t("hub.back")} title=${t("hub.back")}
          onClick=${(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); goList(); }}><${Icon} name="back" /></a>
        <span class=${`av${group ? " av-square" : ""}`} aria-hidden="true"><span class="av-text">${firstCharacter(title || "?") || "?"}</span></span>
        <span class="hub-chat-title"><strong>${title}</strong><span class=${`s${room.agent?.answerOnly?" hub-answer-only-note":""}`}>${line2}</span></span>
        <span class="hub-head-tools"><${TextSizeButton} /><${HubNotifyToggle} /></span>
        ${group && Panel ? html`<button type="button" class="icon-btn hub-room-rail-toggle" aria-pressed=${(wide ? rail : sheet) ? "true" : "false"} title=${hroom("members")} aria-label=${hroom("members")}
          onClick=${() => (wide ? setRail(!rail) : setSheet(true))}><${Icon} name="team" size=${18} /></button>` : null}
        ${group && detail?.me ? html`<${Menu} cls="hub-room-menu" label=${hroom("menu")} fit=${true} ownerKey=${roomId} items=${[
          detail.me.role === "manager" ? { key: "settings", label: hroom("roomSettings"), icon: "settings", onSelect: openSettings } : null,
          { key: "leave", label: hroom("leaveRoom"), icon: "close", onSelect: () => { void leave(); } },
        ].filter(Boolean)} />` : null}
      </header>
      ${leaveError ? html`<p class="err hub-room-leave-err" role="alert">${leaveError}</p>` : null}
      <${Thread} store=${store} name=${title} panelKey=${`hub-room:${roomId}`} threadRef=${threadRef} extra=${extra}
        emptyView=${room.assistant ? html`<div class="hub-assistant-empty"><${Empty} icon="bot" title=${hroom("hubAssistant")} hint=${hroom("hubAssistantEmpty")} /></div>`
          : group ? html`<p class="note">${hroom("composerHint")}</p>` : null} />
      ${/* M-3117: under the thread, the Fleet chat's dock — its column, its padding, the working line and the box in it. */ ""}
      <div class="dock hub-dock" data-trust="composer"><div class="dock-col">
        ${working ? html`<${WorkBarView} kind="working" label=${working.text} elapsed="" elapsedTitle="" />` : null}
        <${RoomComposer} store=${sendStore} detail=${detail} reply=${reply} onReply=${setReply} closed=${store.closed()} inputRef=${input} insertRef=${insert}
          attach=${attach} pending=${pending} canSendEmpty=${files.some((f) => f.state === "ready")} />
      </div></div>
    </section>
    ${showRail ? html`<${RailFrame} trust="hub-context" label=${hroom("members")} title=${hroom("members")} closeLabel=${hroom("cancel")} onClose=${() => setRail(false)}>${panel}</${RailFrame}>` : null}
    ${!wide && sheet && panel && group ? html`<${Dialog} title=${hroom("members")} label=${hroom("members")} onClose=${() => setSheet(false)}><div class="hub-rail-sheet">${panel}</div></${Dialog}>` : null}
    ${settings && detail ? html`<${settings} client=${client} roomId=${roomId} detail=${detail} assistant=${hasAssistant}
      onClose=${() => setSettings(null)} onChanged=${() => { void store.refresh(); }} />` : null}
  </div>`;
}
