import { hs as roomSettingsText } from "./hub-room-settings-strings.js";
import {RoomPurposeCard} from "./hub-room-purpose.js";
import { hi } from "./hub-agent-intro.js";
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
import { hroom, styleName } from "./hub-room-strings.js";
import {ha} from "./hub-ai-apps-strings.js";
import { RoomComposer } from "./hub-room-composer.js";
import { TextSizeButton, TEXT_SIZES, setTextSize, textSizeStore } from "/assets/header-tools.js";
import { useStore } from "/assets/app-store.js";
import { notifyStore, notifySupport } from "/assets/app-needs.js";
import { HubNotifyToggle } from "./hub-room-notify.js";
import { setHubNotify } from "./hub-notify-keep.js";
import { InstallAppButton, installLabel, installOffered, installStore, runInstall } from "/assets/app-install.js";
import { createHubButtonActions } from "./hub-button-actions.js";
import { linkRoomsU2Css } from "./hub-room-new-strings.js";
import { directStatus, workingLine } from "./hub-room-working.js";
import { roomSource, mountSourceAuthor } from "./hub-room-source.js";
import { countsLine } from "./hub-room-list.js";
import { DropOverlay, MAX_FILES, PendingFiles, hf, hubFileAttachment, pageCarriesFiles, putBackText, roomTakesFiles, uploadChosen, useFileDrop } from "./hub-attachments.js";
import { LightboxHost, openLightbox } from "/assets/image-lightbox.js";
import { ROOM_PINS_MAX, RoomPinsButton, RoomPinsDialog } from "./hub-room-pins.js";
import { RoomOffice } from "./hub-room-office.js";
// M-3591: an HTML page in a room opens in the side panel, as in a one-to-one chat (panel-hub.js HubRoomView).
import { PreviewPanel, closePanel, panelStore } from "/assets/preview-panel.js";
import { msgKey } from "/assets/chat-thread.js";
import { bindRoomFeedback, bootHubPreview, downloadHtml, draftWithLine, panelOpenFor, roomPanelKey, setHubPreviewOptIn } from "./hub-preview.js";
// M-3125 PR3: the one quote target an annotated room picture has (here, so a page with an older dictionary has the words).
register("hubRoomAnnotate", { en: { quote: "Quote in this room" }, "zh-TW": { quote: "引用到這個房間" } });

register("hubDirectPosts",{en:{mute:"Mute this agent’s own messages",muted:"{0}’s own messages are off.",mutedNotice:"{0}’s own messages are off; your questions still get answers.",unmuted:"This agent can send you messages again.",failed:"Could not change this preference. Please try again."},"zh-TW":{mute:"關閉這個 Agent 主動發來的訊息",muted:"已關閉 {0} 主動發來的訊息。",mutedNotice:"已關閉 {0} 主動發來的訊息；你問的問題仍會回答。",unmuted:"這個 Agent 現在可以再次主動發來訊息。",failed:"無法變更這項設定，請再試一次。"}});

linkRoomsU2Css();   // M-3127: the reaction chips and picker are drawn from hub-rooms-u2.css (a room opened before any U2 panel)
/**
 * M-3311 (3): the Fleet chat's 「全寬」 for a Hub conversation — this device's choice (as the Fleet keeps its own), its own key:
 * a Hub page has no Fleet module to share it with.
 */
const WIDE_KEY = "agend_hub_chat_wide";
export function hubChatWide() { try { return localStorage.getItem(WIDE_KEY) === "on"; } catch { return false; } }
function setHubChatWide(on) { try { if (on) localStorage.setItem(WIDE_KEY, "on"); else localStorage.removeItem(WIDE_KEY); } catch { /* this tab only */ } }
/** The Fleet chat's narrow screen (panel-chat.js narrowScreen): no 「全寬」 there — the column is the screen's already. */
const NARROW_QUERY = "(max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)";
/**
 * M-3311 (#4162 review): the narrow screen, kept current as the window is resized — hub-chat.css hides the header's text size
 * and Notify at this same width, so ⋯ gains (or drops) them at once, not at the next render.
 */
function useNarrowScreen() {
  const q = (() => { try { return typeof matchMedia === "function" ? matchMedia(NARROW_QUERY) : null; } catch { return null; } })();
  const [narrow, setNarrow] = useState(() => !!q?.matches);
  useEffect(() => { if (!q) return undefined; const on = () => setNarrow(!!q.matches); on(); q.addEventListener?.("change", on); return () => q.removeEventListener?.("change", on); }, []);
  return narrow;
}
/** M-3311 (3): a room message's address — what Copy link copies; opening it shows that message (jumpParam). */
export const messageLink = (roomId, messageId) => `${location.origin}/ui/hub?room=${encodeURIComponent(roomId)}${messageId ? `&m=${encodeURIComponent(messageId)}` : ""}`;
/** M-3311 (#4159 review): a room row's Copy link — only a message with an address (a room message's id); otherwise none. */
export const roomLinkOf = (roomId) => (x) => (x && x.roomMessage ? messageLink(roomId, x.roomMessage) : null);
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
  if(m?.system?.kind==="purpose-changed"&&typeof m.system.purpose==="string"&&typeof m.system.name==="string")return hroom(m.system.purpose?"purposeSetSys":"purposeClearedSys",m.system.name,m.system.purpose);
  if (m?.system?.kind === "office-changed" && typeof m.system.enabled === "boolean" && typeof m.system.name === "string") return hroom(m.system.enabled ? "officeOnSys" : "officeOffSys", m.system.name);
  // M-3533 R1b: the style in this reader's words (a style this page does not know: its id, as stored).
  if (m?.system?.kind === "office-style-changed" && typeof m.system.style === "string" && typeof m.system.name === "string") return hroom("officeStyleSys", m.system.name, styleName(m.system.style));
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
const REASON = { "share-needs-reshare":"noAnswerReshare", "finished-without-answer":"reasonUnanswered",expired: "reasonExpired", unavailable: "reasonUnavailable", interrupted: "reasonInterrupted", retired: "reasonRetired", unknown: "reasonUnknown" };
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
    if (m.answerTo && m.acknowledgedByReaction === true) continue;
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
      ...(sourceBadge ? { sourceBadge } : {}), ...(kind === "agent" && author.id ? { authorMember: String(author.id) } : {}),
      ...(kind === "person" && !mine && !author.via ? { person: true } : {}),   // Lumen (spec §3): someone else's words, a bubble on the left
      roomMessage: m.id, ...(mine && state?.delivery ? { delivery: state.delivery } : {}),
      // M-3125: a post's files, as the 1:1 chat maps them (images inline through the Hub's own route; HTML gets its preview card).
      ...(() => { const files = Array.isArray(m.files) ? m.files.map(hubFileAttachment).filter(Boolean) : []; return files.length ? { attachments: files } : {}; })(),
      ...(!direct && Array.isArray(m.reactions) && m.reactions.length ? { reactionBar: reactionBar(m.reactions, { meId, names }) } : {}),
      ...(!direct && kind !== "person" && m.buttons ? { buttons: roomButtons(m.buttons, meId) } : {}),
      ...(quotedId ? { replyTo: { boot: BOOT, id: num(quotedId), sender: quoted ? authorLine(quoted.author, quoted.author?.id === meId, direct) : "", text: quoted ? String(quoted.text || "").slice(0, 120) : "" } } : {}),
      ...(m.stage === "not-answered" && !(kind === "person" && m.reasonCode === "share-needs-reshare") ? { text: m.reasonCode === "owner-declined" ? hroom("noAnswerDeclined") : m.reasonCode === "share-needs-reshare" ? hroom("noAnswerReshare") : m.reasonCode === "owner-stopped-sharing" ? hroom("noAnswerStopped", author.owner?.name || "") : m.reasonCode==="finished-without-answer"?hroom("noAnswerUnanswered"):hroom("noAnswer") } : {}) });
    if (kind === "person" && m.stage === "not-answered" && m.reasonCode === "share-needs-reshare")
      out.push({ boot: BOOT, id: num(`unavailable:${m.id}`), role: "status", sender: "", text: hroom("noAnswerReshare"), bare: true, wrap: true });
    if (foldAfter) out.push({ boot: BOOT, id: num(`expand:${foldAfter.arg}`), role: "status", sender: "", text: "", bare: true, fold: true, action: foldAfter });
    // Spec §10: once an @所有 Agent has answers, under the last one shown, 「請房間助理整理」 (it sends 「@房間助理 整理上面的回答」).
    if (summarise && lastShown && byId.get(m.answerTo)?.mentions?.includes("all"))
      out.push({ boot: BOOT, id: num(`summarise:${m.answerTo}`), role: "status", sender: "", text: "", bare: true, action: { label: hroom("askSummarise"), arg: `summarise:${m.answerTo}` } });
    const line = state?.line, why = !line && mine ? askReason(state?.reason) : "";
    // Its status, not an event: under it, without a time of its own.
    if (line) out.push({ boot: BOOT, id: id + 1, role: "status", sender: "", text: line, progressOf: m.id, bare: true });
    else if (why) out.push({ boot: BOOT, id: id + 1, role: "status", sender: "", text: why, progressOf: m.id, bare: true, wrap: state?.reason === "share-needs-reshare" });
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
export function createRoomStore(roomId, { client, meId = "", pinsOn = false } = {}) {
  const subs = new Set(), ids = new Map(), expanded = new Set();
  // M-3340: `pins` — my own pins in this group room (null: this Hub offers none, or not read yet); nobody else's, ever.
  const st = { live: true, detail: null, messages: [], loaded: false, error: null, removed: false, more: false, view: [], pins: null };
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
    void readPins();
  }
  /** M-3340: my pins, read again (opening the room; my other tab or device changed them: pins.changed). A group room only. */
  async function readPins() {
    if (!pinsOn || typeof client.roomPins !== "function" || st.detail?.room?.kind !== "group") return;
    const r = await client.roomPins(roomId);
    if (!st.live) return;
    if (r?.ok && Array.isArray(r.pins)) { st.pins = r.pins.filter((p) => p && typeof p.messageId === "string"); changed(); }
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
    "pins.changed": on(() => { void readPins(); }),
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
    /** M-3596: the answer rows still without text (a 1:1 room's open question: working or queued), for its status line. */
    pendingAnswers() { return st.messages.filter((m) => m.answerTo && !m.text && (m.stage === "working" || m.stage === "queued")); },
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
    /** M-3340: my pins (newest first: { messageId, pinnedAt, message }); offered when this Hub keeps them for me. */
    pins: () => st.pins || [],
    pinsOffered: () => Array.isArray(st.pins),
    isPinned: (messageId) => (st.pins || []).some((p) => p.messageId === messageId),
    /** Pin (on) or unpin a message for me only; the Hub answers with my pins → the client's answer (pins-full past 50). */
    async setPin(messageId, on) {
      if (!Array.isArray(st.pins) || typeof client.pinRoomMessage !== "function") return { ok: false, code: "unavailable" };
      const r = await client.pinRoomMessage(roomId, messageId, on);
      if (st.live && r?.ok && Array.isArray(r.pins)) { st.pins = r.pins.filter((p) => p && typeof p.messageId === "string"); changed(); }
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
export function HubRoomPage({ roomId, listed = null, Thread, client, meId = "", rooms = [], openRoom = () => {}, openDirect = null, goList = () => {}, onLeft = () => {}, onMe = () => {}, pinsOn = false,
  view = "chat", onView = () => {}, officeHref = (v) => v }) {
  const store = useMemo(() => createRoomStore(roomId, { client, meId, pinsOn }), [roomId]);
  const [pinsOpen, setPinsOpen] = useState(false);
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
  const input = useRef(null), threadRef = useRef(null), insert = useRef(null), editDraft = useRef(null);
  const Panel = useMembersPanel();
  // M-3591: the room's side panel for its HTML pages — the one-to-one chat's (panel-hub.js HubRoomView): the previews set
  // up for this page, the panel's "Reply about this page" / Point at it lines into this room's box. Leaving the room
  // closes it (PreviewPanel closes on unmount; the page is keyed by the room).
  const split = useRef(null), panelKey = roomPanelKey(roomId);
  const [panelOpen, setPanelOpen] = useState(() => panelOpenFor(panelKey));
  useEffect(() => { bootHubPreview(); }, []);
  useEffect(() => {
    setPanelOpen(panelOpenFor(panelKey));
    const off = panelStore.subscribe(() => setPanelOpen(panelOpenFor(panelKey)));
    const release = bindRoomFeedback({
      findMsg: (key) => store.messages().find((x) => msgKey(x) === key) || null,
      addLine: (line) => editDraft.current?.((d) => draftWithLine(d, line)),
      focus: () => {
        const el = input.current; if (!el) return;
        el.focus();
        setTimeout(() => { try { const n = el.value.length; el.setSelectionRange(n, n); } catch { /* not a text field */ } }, 0);
      },
    });
    return () => { off(); release(); };
  }, [store]);
  // dev-claude2's room settings (hub-room-settings.js), opened from the header or the members panel.
  const [settings, setSettings] = useState(null);
  const [ownAgents, setOwnAgents] = useState(null);
  useEffect(() => setOwnAgents(null), [roomId]);
  const openOwnAgents = () => { import("./hub-room-settings.js").then(m => setOwnAgents(() => m.OwnRoomAgents), () => {}); };
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
  // M-3533 R1 (design §2.1): the room's office, a tab beside Chat while a manager has it on (and this Hub serves it).
  const officeOn = group && client.roomOfficeV1 === true && detail?.settings?.office?.enabled === true;
  const inOffice = officeOn && view === "office";
  // M-3533 R1: the office card's "@ it" goes back to Chat with the mention in the box, once the box is there again.
  const mentionNext = useRef(null), [officeMore, setOfficeMore] = useState(false);
  // A member as the box mentions it: the room assistant by the composer's own word for it; an agent or a person by name,
  // bound to that member (two agents of one name: this one).
  const insertMention = (m) => {
    if (!m) return;
    if (m.kind === "assistant") insert.current?.(hroom("mentionAssistant"));
    else insert.current?.(`@${m.name}`, m.kind === "agent" ? { name: String(m.name), id: m.id } : null);
  };
  useEffect(() => {
    if (inOffice || !mentionNext.current) return undefined;
    const m = mentionNext.current, h = setTimeout(() => { mentionNext.current = null; insertMention(m); }, 0);
    return () => clearTimeout(h);
  });
  // The page-level rooms notifier learns this person's id for this room from its detail (§12; member
  // ids are per room, so the id is kept under this room's id).
  useEffect(() => { const id = detail && detail.me && detail.me.id; if (id) onMe(roomId, id); }, [detail && detail.me && detail.me.id]);
  // M-3125: Attach only where this page and this room carry files and the room is open; chosen files ride the next send.
  const takesFiles = pageCarriesFiles(client, store) && roomTakesFiles(room) && !store.closed();
  // M-3311: `left` (what still fits) and `notice` serve a paste and a drop as the Fleet chat's (hub-attachments.js pasteToAttach).
  const attach = takesFiles ? { title: hf("attach"), left: () => MAX_FILES - filesRef.current.length, notice: (text) => { if (alive.current) toast(text); },
    onFiles: async (list) => {
      setFileMsg("");
      const refused = await uploadChosen(client, room.id || roomId, list, { current: () => filesRef.current, set: setFiles, alive: () => alive.current });
      if (alive.current && refused.length) setFileMsg(refused.join(" "));
      return refused;
    } } : null;
  // M-3311 (1): a file dragged onto the conversation is attached, as in the Fleet chat.
  const mainRef = useRef(null);
  useFileDrop(mainRef, inOffice ? null : attach);
  // M-3311 (3): a long paste's chip — 「改為文字」 puts its text back into the box (the Fleet chat's), and the chip goes.
  const asText = (key) => { const f = filesRef.current.find((x) => x.key === key); if (!f) return; setFiles(filesRef.current.filter((x) => x.key !== key)); putBackText(input.current, f.text); input.current?.focus(); };
  const pending = files.length || fileMsg ? html`<${PendingFiles} files=${files} onAsText=${asText} onRemove=${(key) => setFiles(filesRef.current.filter((f) => f.key !== key))}
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
  // Read when shown: the latest message once loaded, again whenever the room's newest row changes while the page is visible,
  // and when a hidden page is shown again. M-3260: not only when the count changes — an agent's answer is its waiting row,
  // answered in place and moved to the room's newest sequence (a message.updated, the same count), so with the count alone
  // the room stayed unread (its list badge 1) while the answer was on screen. A hidden tab marks nothing: it stays unread.
  const last = store.raw().at(-1);
  const newest = last ? `${last.id}|${last.sequence ?? ""}|${last.stage ?? ""}` : "";
  const shown = () => typeof document === "undefined" || !document.hidden;
  useEffect(() => { if (store.loaded() && shown()) void store.markRead(); }, [store.loaded(), newest]);
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVisible = () => { if (store.loaded() && shown()) void store.markRead(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [store]);
  // The room's own mention labels, accented in every bubble as 「@Notes」 is (Lumen): @所有 Agent, the assistant, each member —
  // read when the thread draws (the thread keeps its options from its first render, before the room's members are known).
  const labels = () => [hroom("mentionAll"), hroom("mentionAssistant"), ...(store.detail()?.members || []).filter((m) => m.kind !== "assistant").map((m) => `@${m.name}`)];
  const extra = {
    isUser: (x) => x.mine === true, canReply: () => !store.closed(),
    // M-3565: an agent's name opens its member card (its "@ it here", "Chat with it one-to-one"); its source in the card.
    senderBadge: (el, msg) => mountSourceAuthor(el, msg, (id) => focusMember(id)),
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
    // M-3311 (2): 「引用」 on a selected passage goes into this room's box (read at selection time).
    quote: { field: () => input.current, can: () => !store.closed() },
    // M-3311 (3): the Fleet chat's Copy link — a room message's address (opening it shows that message).
    linkOf: roomLinkOf(roomId),
    // M-3340: the Fleet chat's Pin / Unpin — mine only (read when the menu opens: the pins arrive after the first render).
    pin: (x) => { void togglePin(x.roomMessage); },
    pinned: (x) => store.isPinned(x.roomMessage),
    canPin: (x) => store.pinsOffered() && !!x.roomMessage && x.role !== "status",
  };
  // M-3340: pin or unpin a message for me; said in a toast either way (as the Fleet chat says it).
  async function togglePin(messageId) {
    const on = !store.isPinned(messageId), r = await store.setPin(messageId, on);
    if (r?.ok) toast(t(on ? "chat.pinned" : "chat.unpinned"));
    else toast(r?.code === "pins-full" ? hroom("pinsFull", String(ROOM_PINS_MAX)) : t("chat.pinFailed"), false);
  }
  const pinCount = store.pinsOffered() ? store.pins().length : 0;
  // M-3340: a pin's message in the room — loaded back to it, scrolled to and flashed (the search hit's way); gone: said.
  async function showPin(pin) {
    setPinsOpen(false);
    const key = await store.find(pin.messageId);
    if (key) setTimeout(() => threadRef.current?.reveal(key), 60); else toast(hroom("jumpMissing"), false);
  }
  // M-3311 (3): the header's menu — a group room's Room settings and Leave, and on a desk the Fleet chat's 「全寬」 for any room.
  const [fullWidth, setFullWidth] = useState(hubChatWide);
  const textSize = useStore(textSizeStore), notify = useStore(notifyStore), install = useStore(installStore), narrow = useNarrowScreen();
  const [muteBusy,setMuteBusy]=useState(false);
  async function toggleDirectMute(){
    if(muteBusy)return;setMuteBusy(true);
    try{const muted=!room.directMessagesMuted,r=await client.updateRoom(roomId,{directMessagesMuted:muted});
      if(r.ok){await store.refresh();toast(t(`hubDirectPosts.${muted?"muted":"unmuted"}`,title));}else toast(t("hubDirectPosts.failed"),false);
    }finally{setMuteBusy(false);}
  }
  const menuItems = [
    !group&&room.kind==="direct"&&room.state==="active"&&typeof room.directMessagesMuted==="boolean"?{key:"directMute",checkbox:true,checked:room.directMessagesMuted,disabled:muteBusy,label:t("hubDirectPosts.mute"),onSelect:()=>{void toggleDirectMute();}}:null,
    // M-3533 R1: a phone has no tab row — Office is the first item of ⋯ (in the office, its back returns to the chat).
    narrow && officeOn && !inOffice ? { key: "office", label: hroom("tabOffice"), icon: "org", onSelect: () => onView("office") } : null,
    // In the office a phone's options (hide paused, bedtime, dialogue, key, fit, fill) are one sheet, not rows over the scene.
    narrow && inOffice ? { key: "officeMore", label: hroom("officeOptions"), icon: "settings", onSelect: () => setOfficeMore(true) } : null,
    group && detail?.me?.role === "member" && detail?.settings?.membersCanAddOwnAgents === true && room.archived !== true && typeof client.roomOwnAgentCandidates === "function" ? { key: "ownAgents", label: roomSettingsText("addOwnAgents"), icon: "plus", onSelect: openOwnAgents } : null,
    group && detail?.me?.role === "manager" ? { key: "settings", label: hroom("roomSettings"), icon: "settings", onSelect: openSettings } : null,
    group && detail?.me ? { key: "leave", label: hroom("leaveRoom"), icon: "close", onSelect: () => { void leave(); } } : null,
    pinCount ? { key: "pins", label: `${t("chat.pinsTitle")} · ${pinCount}`, icon: "pin", onSelect: () => setPinsOpen(true) } : null,
    !narrow && detail?.me ? { key: "fullWidth", checkbox: true, checked: fullWidth, label: t("chat.fullWidth"), onSelect: () => { setHubChatWide(!fullWidth); setFullWidth(!fullWidth); } } : null,
    // M-3311 (4): a phone's header is one row (back, the room, members, ⋯) as the Fleet chat's — its text size and Notify
    // move into ⋯ there (hub-chat.css hides the two buttons at the same width).
    ...(narrow ? [
      { key: "textSize", label: t("app.textSize", t(`app.textSize_${textSize.size}`)), icon: "type", onSelect: () => setTextSize(TEXT_SIZES[(TEXT_SIZES.indexOf(textSize.size) + 1) % TEXT_SIZES.length]) },
      ...(notifySupport() === "ok" ? [{ key: "notify", checkbox: true, checked: notify.state === "on", disabled: notify.asking, label: hroom("notifyTitle"), onSelect: () => { void setHubNotify(notify.state !== "on"); } }] : []),
      // S-255: Install as an app sits by the bell, so on a phone it moves into ⋯ with it.
      ...(installOffered(install.state) ? [{ key: "install", label: installLabel(), icon: "install", onSelect: () => runInstall(install.state) }] : []),
    ] : []),
  ].filter(Boolean);
  const line2 = narrow && inOffice ? hroom("tabOffice") : group ? `${countsLine(room.people, room.agents)}${hasAssistant ? ` · ${hroom("roomAssistant")}` : ""}`
    : room.assistant ? hroom("providedByHub") : room.agent?.answerOnly ? hp("answerOnlyAsker") : String(room.agent?.owner?.name || "");
  // M-3591: the panel takes the members rail's place while it shows a page (the members button brings the rail back).
  const showRail = wide && rail && Panel && group && detail && !(panelOpen && !inOffice);
  // The Fleet chat's working bar (Lumen): 「Notes 正在處理」, or 「2 個 Agent 正在處理」 — the answer row only when it arrives.
  // Who: this room's answers being worked on; the words: workingLine() (#3857), the one place that says it.
  const working = workingLine({ members: store.workers().map((w) => ({ ...w, presence: "working" })) });
  // M-3596: a 1:1 room says what its own question is doing — the Fleet chat's bar: working (with the time since the agent got
  // it), or waiting and why (behind another question, busy, paused, offline, or just sent). The asker's own questions only.
  const statusOf = (now) => room.kind === "direct" && typeof store.pendingAnswers === "function"
    ? directStatus(store.pendingAnswers(), { name: room.agent?.name || room.name, presence: room.agent?.presence, reported: room.agent?.reported === true }, now) : null;
  const status = statusOf(Date.now());
  // M-3565: a message's agent name → its card in the members panel: the panel opened (a phone's sheet), the card open.
  const [focus, setFocus] = useState(null), wideNow = useRef(wide);
  wideNow.current = wide;   // read when pressed: the thread keeps the sender hook from its first render
  const focusMember = (id) => {
    const m = (store.detail()?.members || []).find((x) => x && x.kind === "agent" && x.id === id);
    if (!m) return false;
    // M-3591 (#4407 review): on a desk the rail is where a shown page's panel is — close the page first, as the members
    // button does (read when pressed: the thread keeps this hook from its first render).
    if (wideNow.current) { if (panelOpenFor(panelKey)) closePanel(); setRail(true); } else setSheet(true);
    setFocus({ id, n: Date.now() });
    return true;
  };
  // M-3565: 「和它一對一對話」 (the member card, the office card) — the viewer's own chat with the agent: the one they have,
  // else a new one (openDirect, the page's: as 新對話 starts it). Before, with no chat yet it did nothing.
  const chatWith = (m) => {
    if (typeof openDirect === "function") { setSheet(false); return openDirect(m); }
    const direct = rooms.find((r) => r.kind === "direct" && r.agent?.exposureId === m.id);
    if (direct) openRoom(direct.id);
  };
  const panel = Panel && detail ? html`<${Panel} client=${client} roomId=${roomId} detail=${detail}
        onMention=${(m) => { setSheet(false); insertMention(m); }}
        onOpenChat=${chatWith} focus=${focus}
        onSettings=${() => { setSheet(false); openSettings(); }} onAddAgents=${() => { setSheet(false); openOwnAgents(); }} />` : null;
  return html`<div class=${`hub-chat hub-room-page${showRail ? " with-rail" : ""}`} data-room=${roomId} data-width=${fullWidth ? "full" : undefined} ref=${split}>
    <${LightboxHost} />
    ${pinsOpen ? html`<${RoomPinsDialog} pins=${store.pins()} onClose=${() => setPinsOpen(false)} onJump=${(p) => void showPin(p)} onUnpin=${(p) => void togglePin(p.messageId)} />` : null}
    <section class="hub-chat-main" ref=${mainRef}>
      ${attach && !inOffice ? html`<${DropOverlay} />` : null}
      <header class=${`hub-chat-head${room.agent?.answerOnly?" hub-answer-only-head":""}`} data-trust="panel-content">
        ${/* Lumen (spec §2): on a phone the header starts with the Fleet chat's back to the list. */ ""}
        <a class="icon-btn hub-back only-narrow" href=${inOffice ? officeHref("chat") : "/ui/hub"} aria-label=${t("hub.back")} title=${t("hub.back")}
          onClick=${(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); if (inOffice) onView("chat"); else goList(); }}><${Icon} name="back" /></a>
        ${/* M-3533 H1 (r3): a room's header is one line — its name, its counts beside it — and its picture is in the purpose card
           under the header. A one-to-one chat keeps its picture here. */ ""}
        ${group ? null : html`<span class="av" aria-hidden="true"><span class="av-text">${firstCharacter(title || "?") || "?"}</span></span>`}
        <span class=${`hub-chat-title${group ? " one-line" : ""}`}><strong>${title}</strong><span class=${`s${room.agent?.answerOnly?" hub-answer-only-note":""}`}>${line2}</span>${room.assistant||room.agent?.intro?html`<span class="s hub-agent-intro-line">${room.assistant?hi("assistant"):room.agent.intro}</span>`:null}</span>
        ${officeOn && !narrow ? html`<nav class="inst-switch seg hub-room-tabs" aria-label=${hroom("roomViews", title)}>${["chat", "office"].map((v) => {
          const label = hroom(v === "chat" ? "tabChat" : "tabOffice"), on = (v === "office") === inOffice;
          return html`<a key=${v} class=${`seg-item${on ? " active" : ""}`} href=${officeHref(v)} aria-current=${on ? "page" : undefined} data-label=${label}
            onClick=${(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0) return; e.preventDefault(); onView(v); }}>${label}</a>`; })}</nav>` : null}
        <span class="hub-head-tools"><${RoomPinsButton} count=${pinCount} onOpen=${() => setPinsOpen(true)} /><${TextSizeButton} /><${InstallAppButton} /><${HubNotifyToggle} /></span>
        ${group && Panel ? html`<button type="button" class="icon-btn hub-room-rail-toggle" aria-pressed=${(wide ? showRail : sheet) ? "true" : "false"} title=${hroom("members")} aria-label=${hroom("members")}
          onClick=${() => { if (!wide) { setSheet(true); return; } if (panelOpen && !inOffice) { closePanel(); setRail(true); return; } setRail(!rail); }}><${Icon} name="team" size=${18} /></button>` : null}
        ${menuItems.length ? html`<${Menu} cls="hub-room-menu" label=${hroom("menu")} fit=${true} ownerKey=${roomId} items=${menuItems} />` : null}
      </header>
      ${inOffice ? html`<${RoomOffice} key=${roomId} client=${client} roomId=${roomId} members=${detail?.members || []}
        onMention=${(m) => { mentionNext.current = m; onView("chat"); }} onOpenChat=${chatWith} more=${officeMore} onMore=${setOfficeMore} />` : null}
      ${!inOffice && group && typeof room.purpose === "string" ? html`<${RoomPurposeCard} initial=${firstCharacter(title || "?") || "?"} purpose=${room.purpose}
        onEdit=${detail?.me?.role === "manager" && client.roomPurposeV1 === true ? openSettings : undefined} />` : null}
      ${leaveError ? html`<p class="err hub-room-leave-err" role="alert">${leaveError}</p>` : null}
      ${room.closureReason === "owner-stopped-sharing" ? html`<p class="note" role="status">${hroom("noAnswerStopped", room.ownerName || room.agent?.owner?.name || "")}</p>` : null}
      ${inOffice ? null : html`<${Thread} store=${store} name=${title} panelKey=${panelKey} threadRef=${threadRef} extra=${extra}
        emptyView=${room.assistant ? html`<div class="hub-assistant-empty"><${Empty} icon="bot" title=${hroom("hubAssistant")} hint=${hroom("hubAssistantEmpty")} /></div>`
          : group ? html`<p class="note">${hroom("composerHint")}</p>` : null} />`}
      ${/* M-3117: under the thread, the Fleet chat's dock — its column, its padding, the working line and the box in it.
         M-3533 R1: the office shows none (design §2.1: no message box under it; to ask, back to Chat). It stays mounted, hidden,
         so a draft and the mentions picked into it are still there when Chat comes back. */ ""}
      ${html`<div class="dock hub-dock" data-trust="composer" hidden=${inOffice}><div class="dock-col">
        ${room.kind === "direct" ? (status ? html`<${DirectStatusBar} statusOf=${statusOf} />` : null)
          : working ? html`<${WorkBarView} kind="working" label=${working.text} elapsed="" elapsedTitle="" />` : null}
        ${room.kind==="direct"&&room.directMessagesMuted?html`<p class="note" role="status">${t("hubDirectPosts.mutedNotice",title)}</p>`:null}
        <${RoomComposer} store=${sendStore} detail=${detail} reply=${reply} onReply=${setReply} closed=${store.closed()} inputRef=${input} insertRef=${insert} editRef=${editDraft}
          attach=${attach} pending=${pending} canSendEmpty=${files.some((f) => f.state === "ready")} />
      </div></div>`}
    </section>
    ${/* M-3591: the office has no thread, so no page panel beside it (leaving for the office closes it). */ ""}
    ${inOffice ? null : html`<${PreviewPanel} name=${panelKey} split=${split} msgs=${() => store.messages()} subscribe=${(fn) => store.subscribe(() => fn(panelKey, "msgs"))}
      keyOf=${msgKey} reveal=${(k) => threadRef.current && threadRef.current.reveal(k)} download=${downloadHtml} allow=${(commit) => setHubPreviewOptIn(true, commit)} />`}
    ${showRail ? html`<${RailFrame} trust="hub-context" label=${hroom("members")} title=${hroom("members")} closeLabel=${hroom("cancel")} onClose=${() => setRail(false)}>${panel}</${RailFrame}>` : null}
    ${!wide && sheet && panel && group ? html`<${Dialog} title=${hroom("members")} label=${hroom("members")} onClose=${() => setSheet(false)}><div class="hub-rail-sheet">${panel}</div></${Dialog}>` : null}
    ${ownAgents && detail ? html`<${ownAgents} key=${roomId} client=${client} roomId=${roomId} detail=${detail} onClose=${() => setOwnAgents(null)} onChanged=${() => { void store.refresh(); }} />` : null}
    ${settings && detail ? html`<${settings} client=${client} roomId=${roomId} detail=${detail} assistant=${hasAssistant}
      onClose=${() => setSettings(null)} onChanged=${() => { void store.refresh(); }} />` : null}
  </div>`;
}

/** M-3596: a 1:1 room's status line — the Fleet chat's work bar (working, its elapsed time ticking; or waiting, and why). */
function DirectStatusBar({ statusOf }) {
  // Worked out again on every tick (its elapsed time; a hand-off the agent never took turns back to waiting after the grace).
  const [, tick] = useState(0);
  const status = statusOf(Date.now());
  const kind = status ? status.kind : null;
  useEffect(() => {
    if (kind !== "working") return undefined;
    const h = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [kind]);
  if (!status) return null;
  if (status.kind !== "working") return html`<${WorkBarView} kind="awaiting" label=${status.text} note="" noteTitle="" />`;
  const R = globalThis.AgendChatRender;
  const elapsed = R && typeof status.since === "number" ? R.formatElapsed(Math.max(0, Date.now() - status.since)) : "";
  return html`<${WorkBarView} kind="working" label=${status.text} elapsed=${elapsed} elapsedTitle=${hroom("elapsedTitle")} />`;
}
