import { hi } from "./hub-agent-intro.js";
import {hp} from "./hub-personal-agent-strings.js";
// M-3092 PR 2 (Hub rooms, track U): a room's composer — the Fleet chat's own ComposerInput, its palette (`cmd-palette`)
// and its reply bar (`reply-bar`), with what a room adds (docs/design/hub-rooms-ux.md §4):
// - typing `@` opens a menu: 「@所有 Agent」 (when this room lets me), 「@房間助理」 (when the room has one), each agent
//   (its owner and status dot; filtered by name or owner), then the people (an @ to a person only reminds them);
// - with @所有 Agent in the text, a line above says how many answer now and how many after they come back;
// - under the box, always: messages with no @agent are seen only by the people in the room;
// - `/` is plain text here (no slash commands); a refusal is worded where the Fleet chat words "Not sent: …".
import { html, useEffect, useState, useRef } from "/assets/app-html.js";
import { ComposerInput, touchScreen } from "/assets/chat-composer.js";
import { t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { hroom } from "./hub-room-strings.js";
import { presenceDot } from "./hub-room-presence.js";

const ONLINE = new Set(["online", "idle", "working"]);
const agentsOf = (detail) => (detail?.members || []).filter((m) => m.kind === "agent" || m.kind === "later");

/** Lumen (spec §4): where the room's long placeholder doesn't fit (a phone), the short one. */
const SHORT_QUERY = "(max-width: 599px)";
function useShortPlaceholder() {
  const q = typeof matchMedia === "function" ? matchMedia(SHORT_QUERY) : null;
  const [short, setShort] = useState(() => !!q?.matches);
  useEffect(() => { if (!q) return; const on = () => setShort(q.matches); q.addEventListener?.("change", on); return () => q.removeEventListener?.("change", on); }, []);
  return short;
}

/** The @ token being typed at `caret` (from an `@` after a space or the start to the caret), or null. */
export function mentionAt(value, caret) {
  const before = String(value || "").slice(0, caret), at = before.lastIndexOf("@");
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  const q = before.slice(at + 1);
  return /[\s]/.test(q) ? null : { start: at, query: q };
}

/** The @ menu (spec §4), in its order; `query` filters agents and people by name or owner. */
export function mentionOptions(detail, query = "") {
  const q = String(query || "").toLowerCase(), hit = (...v) => !q || v.some((x) => String(x || "").toLowerCase().includes(q));
  const agents = agentsOf(detail), manager = detail?.me?.role === "manager", out = [];
  if ((detail?.settings?.allMention !== false || manager) && agents.length && hit(hroom("mentionAll")))
    out.push({ kind: "all", key: "all", label: hroom("mentionAll"), hint: hroom("mentionAllHint", String(agents.length)) });
  if ((detail?.members || []).some((m) => m.kind === "assistant") && hit(hroom("mentionAssistant")))
    out.push({ kind: "assistant", key: "assistant", label: hroom("mentionAssistant"), hint: hi("assistant") });
  for (const a of agents) if (hit(a.name, a.owner?.name)) out.push({ kind: "agent", key: a.id, label: `@${a.name}`, ...(a.answerOnly?{answerOnly:true}:{}), hint: [a.intro,a.answerOnly?hp("answerOnlyAsker"):a.owner?.name].filter(Boolean).join(" · "), dot: presenceDot(a.presence, a.presenceReason) });
  for (const p of (detail?.members || []).filter((m) => m.kind === "person" && m.id !== detail?.me?.id)) if (hit(p.name)) out.push({ kind: "person", key: p.id, label: `@${p.name}`, hint: "" });
  return out;
}

// `@Name` not followed by an ASCII word character or `-` (as agents have always been read: "@研發助理幫我看" names it, no
// space needed). `person`: also not after an ASCII letter, digit, `_`, `@` or `\` — an email address or an escaped @ names no one.
const atName = (name, flags = "", person = false) =>
  new RegExp(`${person ? "(?<![A-Za-z0-9_@\\\\])" : ""}@${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, flags);
/**
 * The mentions a text names (spec seam 1: "all", "assistant" or an agent's exposure id), read from the text as sent.
 * M-3298: and each person it @s (their member id) — the reminder the @ menu promises: their room list's @ and their page's
 * ping (hub-room-unread.js) read it from the message's mentions. A longer name is read first, so "@Alex Chen" is not also
 * "@Alex"; never me; a name two members share, no one. It is the page's preview: the Hub resolves who a person's @ reminds
 * from the text itself (hub/rooms/service.ts post()), and keeps from what a page sends only what routes (@all, assistant, agents).
 */
export function mentionsIn(text, detail) {
  const s = String(text || ""), out = [];
  if (s.includes(hroom("mentionAll"))) out.push("all");
  if (s.includes(hroom("mentionAssistant"))) out.push("assistant");
  for (const a of agentsOf(detail)) if (atName(a.name).test(s)) out.push(a.id);
  const me = detail?.me?.id, named = [...agentsOf(detail).map((a) => ({ name: a.name, person: null })),
    ...(detail?.members || []).filter((m) => m.kind === "person" && m.name).map((m) => ({ name: m.name, person: m.id }))]
    .sort((x, y) => String(y.name).length - String(x.name).length);
  // A name two members share names no one (as the Hub reads it, #4132 review F1): the Hub decides who is reminded.
  const shared = new Map();
  for (const n of named) { const k = String(n.name).toLocaleLowerCase("en-US"); shared.set(k, (shared.get(k) || 0) + 1); }
  let rest = s;
  for (const n of named) {
    if (!atName(n.name, "", !!n.person).test(rest)) continue;
    if (n.person && n.person !== me && shared.get(String(n.name).toLocaleLowerCase("en-US")) === 1) out.push(n.person);
    rest = rest.replace(atName(n.name, "g", !!n.person), (hit) => " ".repeat(hit.length));
  }
  return [...new Set(out)];
}

/** M-3308: past this many characters a paste goes as a text file (the Fleet chat's LONG_PASTE_CHARS, chat-render.js). */
export const LONG_PASTE_CHARS = 4000;
const isLongPaste = (text) => (globalThis.AgendChatRender?.isLongPaste ? globalThis.AgendChatRender.isLongPaste(text) : typeof text === "string" && text.length > LONG_PASTE_CHARS);
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
/**
 * M-3308: a pasted file as the room uploads it. A clipboard picture (a screen capture) may come with no name — the Hub refuses
 * an upload without one — so it is named `screenshot-<time>.<png|jpg|…>` by its type; a named one (Chrome's "image.png", a copied
 * file) keeps its own.
 */
export function pastedFile(file) {
  if (!file || (file.name && file.name.trim())) return file;
  const ext = IMAGE_EXT[file.type] || (String(file.type).startsWith("text/") ? "txt" : "bin");
  return new File([file], `${String(file.type).startsWith("image/") ? "screenshot" : "pasted"}-${stamp()}.${ext}`, { type: file.type, lastModified: file.lastModified });
}

/** Above the box when @所有 Agent is in it: how many answer now, how many after they come back (spec §4). */
export function allBar(detail) {
  const agents = agentsOf(detail), online = agents.filter((a) => ONLINE.has(a.presence)).length;
  return hroom("allBar", String(agents.length), String(online), String(agents.length - online));
}

const REFUSALS = { "all-mention-off": "errAllMention", "not-member": "errNotMember", archived: "errArchived" };
/** A refusal in words (spec §4); the network's own failure as the Fleet chat says it. */
export function refusalText(r) {
  if (!r || r.ok) return "";
  if (REFUSALS[r.code]) return hroom(REFUSALS[r.code]);
  return hroom("notSentBecause", hroom("sendNoConnection"));
}

/**
 * The composer. `store`: the room's (send); `detail`: the room GET; `reply`/`onReply`: the message being answered (the
 * thread's Reply); `closed`: archived or no longer a member (the box says why, nothing is sent).
 * M-3125: `canSendEmpty` — Send works with an empty box (the caller has files ready).
 * M-3117 (for M-3125's files): `attach` is ComposerInput's own ({ title, onFiles } — the Fleet's ＋ left of the box), `pending`
 * the files waiting, drawn first in the box (where the 1:1 chat puts its PendingFiles). Neither given: no Attach.
 */
export function RoomComposer({ store, detail, reply = null, onReply = () => {}, closed = false, inputRef, insertRef, attach = null, pending = null, canSendEmpty = false }) {
  const [value, setValue] = useState(""), [msg, setMsg] = useState(null), [busy, setBusy] = useState(false), [pick, setPick] = useState(0);
  const own = useRef(null), input = inputRef || own;
  const [caret, setCaret] = useState(0);
  const at = mentionAt(value, caret), options = at ? mentionOptions(detail, at.query) : [];
  const palette = at && options.length ? options : null, chosen = palette ? palette[Math.min(pick, palette.length - 1)] : null;
  const room = detail?.room || {}, group = room.kind === "group";
  const short = useShortPlaceholder();
  // M-3117: the Fleet chat's box takes the focus when its conversation opens (panel-chat.js Composer): a room's too.
  useEffect(() => { if (!closed) input.current?.focus(); }, [room.id || "", closed]);
  // 「在這裡 @ 它」 from the members panel: the mention goes into the box, after what is there.
  if (insertRef) insertRef.current = (text) => { setValue((v) => `${v && !/\s$/.test(v) ? `${v} ` : v}${text} `); setTimeout(() => input.current?.focus(), 0); };
  const complete = (o) => {
    const next = `${value.slice(0, at.start)}${o.label} ${value.slice(caret)}`;
    setValue(next); setPick(0);
    setTimeout(() => { const el = input.current; if (el) { const n = at.start + o.label.length + 1; el.focus(); try { el.setSelectionRange(n, n); } catch { /* not a text field */ } setCaret(n); } }, 0);
  };
  const send = async () => {
    // M-3125: `canSendEmpty` — files are ready to go, so a post may be the files alone (the server takes it).
    const text = value.trim(); if ((!text && !canSendEmpty) || busy || closed) return;
    setBusy(true); setMsg(null);
    const r = await store.send(text, { mentions: mentionsIn(text, detail), ...(reply ? { replyTo: reply.roomMessage } : {}) });
    setBusy(false);
    if (r.ok) { setValue(""); onReply(null); } else setMsg({ text: refusalText(r), retry: !REFUSALS[r.code] });
  };
  const onKeyDown = (e) => {
    if (palette && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setPick((i) => (i + (e.key === "ArrowDown" ? 1 : palette.length - 1)) % palette.length); return; }
    if (palette && (e.key === "Enter" || e.key === "Tab") && !e.isComposing) { e.preventDefault(); complete(chosen); return; }
    if (palette && e.key === "Escape") { e.preventDefault(); setCaret(-1); return; }
    // Enter sends, Shift+Enter is a new line — the Fleet chat's own rule (and a phone's).
    if (globalThis.AgendChatRender?.composerKey(e, { touch: touchScreen() }) === "send") { e.preventDefault(); void send(); }
  };
  const track = (v) => { setValue(v); setMsg(null); setCaret(input.current ? input.current.selectionStart ?? v.length : v.length); };
  // M-3308 (the user: a screenshot pasted with Ctrl+V did nothing in a room): the Fleet chat's paste (panel-chat.js onPaste) —
  // files in a paste are attached, through the room's own Attach and its file rules (hub-attachments.js); a clipboard picture
  // with no name gets one; a very long text paste goes as a text file. A room that takes no files keeps the text (as before).
  const onPaste = (e) => {
    if (!attach || closed) return;
    const list = e.clipboardData && e.clipboardData.files ? [...e.clipboardData.files] : [];
    const text = e.clipboardData ? e.clipboardData.getData("text") : "";
    if (list.length) { void attach.onFiles(list.map(pastedFile)); if (!text) e.preventDefault(); return; }
    if (isLongPaste(text)) { e.preventDefault(); void attach.onFiles([new File([text], `pasted-${stamp()}.txt`, { type: "text/plain" })]); }
  };
  const paletteId = `hubMention-${room.id || "room"}`, optId = (o) => `${paletteId}-${o.key}`;
  // M-3117: as the Fleet chat's dock has it — the box, then a failed send, then the line under it (its .composer-row).
  if (closed) return html`<p class="hub-banner warn" role="status">${hroom(detail?.room?.archived ? "errArchived" : "errNotMember")}</p>`;
  return html`<div class="composer-box hub-room-composer">
    ${pending}
    ${palette ? html`<ul data-trust="palette" class="cmd-palette" id=${paletteId} role="listbox" aria-label=${hroom("mentionAll")}>
      ${palette.map((o) => html`<li key=${o.key} id=${optId(o)} role="option" aria-selected=${o === chosen ? "true" : "false"} class=${o === chosen ? "on" : ""}
        onMouseDown=${(e) => { e.preventDefault(); complete(o); }}>
        <span class="cmd-name">${o.dot ? html`<span class=${`dot ${o.dot}`} aria-hidden="true"></span> ` : null}${o.label}</span><span class=${`cmd-desc${o.answerOnly?" hub-answer-only-note":""}`}>${o.hint}</span></li>`)}
    </ul>` : null}
    ${group && value.includes(hroom("mentionAll")) ? html`<p class="note hub-room-allbar" role="status">${allBar(detail)}</p>` : null}
    ${reply ? html`<div class="reply-bar" data-trust="composer" role="status"><span class="reply-text">${reply.sender ? `${reply.sender} · ` : ""}${String(reply.text || "").slice(0, 80)}</span>
      <button type="button" class="icon-btn reply-cancel" title=${hroom("cancel")} aria-label=${hroom("cancel")} onClick=${() => { onReply(null); input.current?.focus(); }}><${Icon} name="close" size=${14} /></button></div>` : null}
    <${ComposerInput} inputRef=${input} value=${value} attach=${attach} onPaste=${onPaste} placeholder=${room.assistant ? hroom("composerAssistant") : group ? (short ? hroom("composerShort") : hroom("composer", room.name || "")) : hroom("composerDirect", room.name || "")} onValue=${track} onKeyDown=${onKeyDown}
      controls=${palette ? paletteId : undefined} expanded=${!!palette} activeDescendant=${chosen ? optId(chosen) : undefined}
      stop=${{ hidden: true, disabled: true, title: t("chat.stopReply"), label: t("chat.stopReply"), onClick: () => {} }}
      send=${{ hidden: false, disabled: (!value.trim() && !canSendEmpty) || busy, label: t("chat.send"), onClick: () => { void send(); } }} />
  </div>
  ${msg ? html`<p class="err" role="alert">${msg.text}${msg.retry ? html` <button type="button" class="btn btn-sm" onClick=${send}>${hroom("retrySend")}</button>` : null}</p>` : null}
  ${group ? html`<div class="composer-row"><span class="hint hub-room-hint">${hroom("composerHint")}</span></div>` : null}`;
}
