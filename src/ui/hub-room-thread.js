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
import { WorkBarView } from "/assets/chat-composer.js";
import { RailFrame } from "/assets/side-rail.js";
import { Icon } from "/assets/ui-icons.js";
import { Empty } from "/assets/ui-states.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Menu } from "/assets/ui-menu.js";
import { t } from "/assets/app-i18n.js";
import "./hub-strings.js";
import { firstCharacter } from "/assets/instance-nav.js";
import { hroom } from "./hub-room-strings.js";
import { RoomComposer } from "./hub-room-composer.js";
import { workingLine } from "./hub-room-working.js";
import { countsLine } from "./hub-room-list.js";

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined);
const BOOT = "room";

/**
 * One room message's author line (spec §3). `mine`: no name (the thread puts it on the right). The assistant is named by
 * its flag, never by its stored name (Ridge: that is an older renderer's fallback): 「房間助理 · Hub 提供」 in a room,
 * 「Hub 助理」 in its own one-to-one (`direct`).
 */
export function authorLine(author, mine = false, direct = false) {
  if (!author || mine) return "";
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
const SYSTEM = { "room-created": "createdSys", "member-joined": "sysJoined", "admin-joined": "sysAdminJoined" };
export function systemText(m) {
  const key = m && m.system && SYSTEM[m.system.kind];
  return key && typeof m.system.name === "string" ? hroom(key, m.system.name) : String((m && m.text) || "");
}
/**
 * The progress of a message that asked agents (spec §3, Lumen): one agent → its delivery mark; several → one line, its
 * parts without a 0 ("Answered 1 · Working 1"); every one answered → the delivered tick again, no line.
 */
export function askState(ask) {
  if (!ask || !Number.isSafeInteger(ask.total) || ask.total < 1) return null;
  if (ask.total === 1 || ask.answered >= ask.total) return { delivery: ask.answered >= ask.total ? "delivered" : ask.working >= 1 ? "processing" : "queued" };
  const parts = [[ask.answered, "progAnswered"], [ask.working, "progWorking"], [ask.later, "progLater"]].filter(([n]) => Number(n) > 0).map(([n, k]) => hroom(k, String(n)));
  return { line: parts.join(" · ") };
}
/** How many answers of one question show when they are folded, and from how many they fold (Lumen: all up to 5). */
export const ANSWERS_SHOWN = 3, FOLD_FROM = 6;

/**
 * Seam-1 messages (newest last) → the thread's messages. `ids`: a Map from a message id to its number in this thread
 * (the thread's keys and quotes are numbers), extended here in arrival order and kept by the caller.
 */
export function toThreadMessages(messages, { meId, ids, direct = false, expanded = new Set(), summarise = false }) {
  const out = [], byId = new Map(messages.map((m) => [m.id, m]));
  // Each question's answers that have text, in arrival order: past ANSWERS_SHOWN they wait behind one 「展開其餘 N 則」.
  const answersOf = new Map();
  const drawn = (m) => !!m.text || m.stage === "not-answered";   // an answer that shows: its text, or that none came (Ridge)
  for (const m of messages) if (m && m.answerTo && drawn(m)) answersOf.set(m.answerTo, [...(answersOf.get(m.answerTo) || []), m.id]);
  const num = (id) => { if (!ids.has(id)) ids.set(id, ids.size * 2 + 2); return ids.get(id); };
  for (const m of messages) {
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
    const id = num(m.id), mine = kind === "person" && author.id === meId;
    if (kind === "system") { out.push({ boot: BOOT, id, role: "status", sender: "", ts: iso(m.at), text: systemText(m), bare: true }); continue; }
    // An answer is a reply to the message that asked for it (the Fleet's reply reference): replyTo, else answerTo.
    const quoted = m.replyTo ? byId.get(m.replyTo) : m.answerTo ? byId.get(m.answerTo) : null;
    const state = mine ? askState(m.ask) : null;
    out.push({ boot: BOOT, id, role: kind === "person" ? "user" : "agent", sender: authorLine(author, mine, direct), ts: iso(m.at), text: String(m.text || ""), mine,
      ...(kind === "person" && !mine ? { person: true } : {}),   // Lumen (spec §3): someone else's words, a bubble on the left
      roomMessage: m.id, ...(state?.delivery ? { delivery: state.delivery } : {}),
      ...(quoted ? { replyTo: { boot: BOOT, id: num(quoted.id), sender: authorLine(quoted.author, quoted.author?.id === meId, direct), text: String(quoted.text || "").slice(0, 120) } } : {}),
      ...(m.stage === "not-answered" ? { text: hroom("noAnswer") } : {}) });
    if (foldAfter) out.push({ boot: BOOT, id: num(`expand:${foldAfter.arg}`), role: "status", sender: "", text: "", bare: true, fold: true, action: foldAfter });
    // Spec §10: once an @所有 Agent has answers, under the last one shown, 「請房間助理整理」 (it sends 「@房間助理 整理上面的回答」).
    if (summarise && lastShown && byId.get(m.answerTo)?.mentions?.includes("all"))
      out.push({ boot: BOOT, id: num(`summarise:${m.answerTo}`), role: "status", sender: "", text: "", bare: true, action: { label: hroom("askSummarise"), arg: `summarise:${m.answerTo}` } });
    const line = askState(m.ask)?.line;
    // Its status, not an event: under it, without a time of its own.
    if (line) out.push({ boot: BOOT, id: id + 1, role: "status", sender: "", text: line, progressOf: m.id, bare: true });
    if (mine && m.warning === "assistant-unavailable") out.push({ boot: BOOT, id: id + 1, role: "status", sender: "", ts: iso(m.at), text: hroom("errAssistant"), bare: true });
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
  const subs = new Set(), ids = new Map(), expanded = new Set();
  const st = { live: true, detail: null, messages: [], loaded: false, error: null, removed: false, more: false, view: [] };
  // The room's committed order (Ridge: `sequence`, from the stored row): a waiting answer replaced in place, or an event that
  // arrives out of order, is drawn where the room has it. Rows without it (a direct chat, an older Hub) keep arrival order.
  const closedNow = () => st.removed || st.detail?.room?.archived === true;
  const ordered = () => { if (st.messages.length && st.messages.every((m) => Number.isSafeInteger(m.sequence))) st.messages.sort((a, b) => a.sequence - b.sequence); };
  const changed = () => { ordered(); st.view = toThreadMessages(st.messages, { meId: st.detail?.me?.id || meId, ids, direct: st.detail?.room?.kind === "direct", expanded,
    summarise: st.detail?.room?.kind === "group" && (st.detail?.members || []).some((x) => x.kind === "assistant") && !closedNow() }); for (const fn of [...subs]) { try { fn(); } catch { /* a subscriber's own failure */ } } };
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
    // The member's live state as sent: presence, and its note and reason only while the event carries them (a reason
    // alone updates it; an event without one clears it — never a stale reason).
    "presence.changed": on((d) => { const m = st.detail?.members?.find((x) => x.id === d.memberId); if (m) { m.presence = d.presence;
      for (const k of ["presenceNote", "presenceReason"]) { if (d[k]) m[k] = d[k]; else delete m[k]; } } }),
    "member.changed": on(() => { void readDetail().then(changed); }),
    "room.changed": on((d) => { if (d.removed) st.removed = true; else if (d.room && st.detail) st.detail = { ...st.detail, room: { ...st.detail.room, ...d.room } }; }),
  }) : () => {};
  void refresh();
  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    detail: () => st.detail, raw: () => st.messages, messages: () => st.view, loaded: () => st.loaded, error: () => st.error,
    closed: closedNow, removed: () => st.removed, more: () => st.more,
    room: () => ({ ...(st.detail?.room || {}), ownerName: "" }),
    async send(text, { mentions = [], replyTo } = {}) {
      const idempotencyKey = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9-]/g, "");
      const r = await client.sendRoomMessage(roomId, { text, mentions, replyTo, idempotencyKey });
      // The stored message, as the Hub answers it: `{ message }`, or the message itself (Ridge's server) — drawn at once,
      // whether or not the stream is up yet (a first send after opening the room must not vanish).
      const { ok, ...bare } = r || {};
      const sent = r && r.message ? r.message : ok && typeof bare.id === "string" && typeof bare.roomId === "string" ? bare : null;
      if (ok && sent) { upsert(sent); changed(); }
      return r;
    },
    async older() {
      const first = st.messages[0]; if (!first || !st.more) return;
      const page = await client.roomMessages(roomId, { before: first.id, limit: 50 });
      if (!st.live || !page.ok) return;
      st.messages = [...(page.messages || []).filter((m) => !st.messages.some((x) => x.id === m.id)), ...st.messages]; st.more = page.more === true; changed();
    },
    /** 「展開其餘 N 則」: show every answer of that question. */
    expand(messageId) { if (typeof messageId === "string" && !expanded.has(messageId)) { expanded.add(messageId); changed(); } },
    /** Who is working on an answer in this room now (its answer row has no text yet): their names, in arrival order. */
    working() { return this.workers().map((w) => w.name); },
    /** The same, as members ({ kind, name }) — what workingLine() words (the room assistant by its own name). */
    workers() { return st.messages.filter((m) => m.answerTo && !m.text && m.stage === "working" && m.author?.name).map((m) => ({ kind: m.author.kind === "assistant" ? "assistant" : "agent", name: String(m.author.name) })); },
    markRead() { const last = st.messages.at(-1); return last ? client.markRoomRead(roomId, last.id) : Promise.resolve({ ok: true }); },
    refresh, clickButton: async () => ({ ok: false, code: "stopped" }), vote: async () => ({ ok: false, code: "stopped" }), busy: () => false, mine: () => [],
    stop() { st.live = false; subs.clear(); unsubscribe(); },
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
export function HubRoomPage({ roomId, listed = null, Thread, client, meId = "", rooms = [], openRoom = () => {}, goList = () => {}, onLeft = () => {} }) {
  const store = useMemo(() => createRoomStore(roomId, { client, meId }), [roomId]);
  useEffect(() => () => store.stop(), [store]);
  const [, tick] = useState(0);
  // The first read may land before this subscribes: read once more on subscribing.
  useEffect(() => { const off = store.subscribe(() => tick((n) => n + 1)); tick((n) => n + 1); return off; }, [store]);
  const [reply, setReply] = useState(null), [rail, setRail] = useState(true), [sheet, setSheet] = useState(false);
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
  // The Hub assistant's one-to-one is named by its flag, in this viewer's words (its stored name is a fallback).
  const title = room.assistant ? hroom("hubAssistant") : String(room.name || "");
  const hasAssistant = (detail?.members || []).some((m) => m.kind === "assistant");
  // Read when shown: the latest message once loaded and again as messages arrive while the page is visible.
  const count = store.raw().length;
  useEffect(() => { if (store.loaded() && (typeof document === "undefined" || !document.hidden)) void store.markRead(); }, [store.loaded(), count]);
  // The room's own mention labels, accented in every bubble as 「@Notes」 is (Lumen): @所有 Agent, the assistant, each member —
  // read when the thread draws (the thread keeps its options from its first render, before the room's members are known).
  const labels = () => [hroom("mentionAll"), hroom("mentionAssistant"), ...(store.detail()?.members || []).filter((m) => m.kind !== "assistant").map((m) => `@${m.name}`)];
  const extra = {
    isUser: (x) => x.mine === true, canReply: () => !store.closed(),
    mentionLabels: labels,
    // A line's one action: 「展開其餘 N 則」, or 「請房間助理整理」 (spec §10: the same as sending 「@房間助理 整理上面的回答」).
    statusAction: (arg) => { if (String(arg).startsWith("summarise:")) { if (!store.closed()) void store.send(hroom("summarisePrompt"), { mentions: ["assistant"] }); } else store.expand(arg); },
    startReply: (x) => { setReply(x); setTimeout(() => input.current?.focus(), 0); },
    findQuoted: async () => { await store.older(); return false; },
  };
  const line2 = group ? `${countsLine(room.people, room.agents)}${hasAssistant ? ` · ${hroom("roomAssistant")}` : ""}`
    : room.assistant ? hroom("providedByHub") : String(room.agent?.owner?.name || "");
  const showRail = wide && rail && Panel && group && detail;
  // The Fleet chat's working bar (Lumen): 「Notes 正在處理」, or 「2 個 Agent 正在處理」 — the answer row only when it arrives.
  // Who: this room's answers being worked on; the words: workingLine() (#3857), the one place that says it.
  const working = workingLine({ members: store.workers().map((w) => ({ ...w, presence: "working" })) });
  const panel = Panel && detail ? html`<${Panel} client=${client} roomId=${roomId} detail=${detail}
        onMention=${(m) => { setSheet(false); insert.current?.(`@${m.name}`); }}
        onOpenChat=${(m) => { const direct = rooms.find((r) => r.kind === "direct" && r.agent?.exposureId === m.id); if (direct) openRoom(direct.id); }}
        onSettings=${() => { setSheet(false); openSettings(); }} />` : null;
  return html`<div class=${`hub-chat hub-room-page${showRail ? " with-rail" : ""}`} data-room=${roomId}>
    <section class="hub-chat-main">
      <header class="hub-chat-head" data-trust="panel-content">
        ${/* Lumen (spec §2): on a phone the header starts with the Fleet chat's back to the list. */ ""}
        <a class="icon-btn hub-back only-narrow" href="/ui/hub" aria-label=${t("hub.back")} title=${t("hub.back")}
          onClick=${(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); goList(); }}><${Icon} name="back" /></a>
        <span class=${`av${group ? " av-square" : ""}`} aria-hidden="true"><span class="av-text">${firstCharacter(title || "?") || "?"}</span></span>
        <span class="hub-chat-title"><strong>${title}</strong><span class="s">${line2}</span></span>
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
      ${working ? html`<${WorkBarView} kind="working" label=${working.text} elapsed="" elapsedTitle="" />` : null}
      <${RoomComposer} store=${store} detail=${detail} reply=${reply} onReply=${setReply} closed=${store.closed()} inputRef=${input} insertRef=${insert} />
    </section>
    ${showRail ? html`<${RailFrame} trust="hub-context" label=${hroom("members")} title=${hroom("members")} closeLabel=${hroom("cancel")} onClose=${() => setRail(false)}>${panel}</${RailFrame}>` : null}
    ${!wide && sheet && panel && group ? html`<${Dialog} title=${hroom("members")} label=${hroom("members")} onClose=${() => setSheet(false)}><div class="hub-rail-sheet">${panel}</div></${Dialog}>` : null}
    ${settings && detail ? html`<${settings} client=${client} roomId=${roomId} detail=${detail} assistant=${hasAssistant}
      onClose=${() => setSettings(null)} onChanged=${() => { void store.refresh(); }} />` : null}
  </div>`;
}
