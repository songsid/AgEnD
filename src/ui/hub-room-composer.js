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
import { pasteToAttach } from "./hub-attachments.js";

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

/**
 * M-3533 (#4355 review): who a mention put in the box stands for — the office card's "@ it" and the members panel's — is
 * that member, not every member of its name. A binding is one mention where it was put: { name, id, start } (its `@name`
 * at `start`). Edits move or retire it (shiftBindings); only one still whole at its place binds (intactBindings).
 */
const tokenAt = (s, b) => s.startsWith(`@${b.name}`, b.start) && !/[\w-]/.test(s.charAt(b.start + 1 + b.name.length));
/**
 * The bindings after the text changed from `prev` to `next`: the edit is what lies between their common start and end; a
 * mention before it stays, one after it moves by the change in length, one the edit touches is gone (deleted or edited:
 * a later pick or a name retyped by hand cannot revive it).
 */
export function shiftBindings(prev, next, bindings = []) {
  const a = String(prev || ""), b = String(next || "");
  if (a === b) return bindings;
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0; while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const editEnd = a.length - q, delta = b.length - a.length;
  return (Array.isArray(bindings) ? bindings : []).flatMap((x) => {
    const end = x.start + 1 + x.name.length;
    if (end <= p) return [x];
    if (x.start >= editEnd) return [{ ...x, start: x.start + delta }];
    return [];
  });
}
/** The bindings still whole where they were put in `text`. */
export const intactBindings = (text, bindings = []) => (Array.isArray(bindings) ? bindings : [])
  .filter((b) => b && typeof b.name === "string" && typeof b.id === "string" && Number.isInteger(b.start) && tokenAt(String(text || ""), b));
/**
 * The mentions `text` sends: as read (mentionsIn), except that a name whose every `@name` is a bound mention sends the
 * members bound — two agents called Notes, picked one each, send those two; one picked and one typed by hand reads as
 * typed (both).
 */
export function boundMentions(text, detail, bindings = []) {
  const s = String(text || ""), out = mentionsIn(s, detail), live = intactBindings(s, bindings);
  if (!live.length) return out;
  const byName = new Map();
  for (const b of live) { const k = b.name.toLocaleLowerCase("en-US"); byName.set(k, [...(byName.get(k) || []), b]); }
  let result = out;
  for (const [k, list] of byName) {
    const name = list[0].name, said = (s.match(atName(name, "g")) || []).length;
    if (list.length < said) continue;
    const same = new Set(agentsOf(detail).filter((a) => String(a.name).toLocaleLowerCase("en-US") === k).map((a) => a.id));
    result = [...result.filter((id) => !same.has(id)), ...list.map((b) => b.id)];
  }
  return [...new Set(result)];
}

// M-3308: the paste helpers live with the Hub's files (hub-attachments.js), shared with the 1:1 question's composer (M-3311).
export { LONG_PASTE_CHARS, pastedFile } from "./hub-attachments.js";

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
  // M-3533: the mentions put in the box for a member, where they were put; every change of the text moves or retires
  // them (shiftBindings) before a new one is added (`adding`: the one an insertion carries, at its place).
  const bindings = useRef([]), seen = useRef(""), adding = useRef([]);
  useEffect(() => {
    bindings.current = shiftBindings(seen.current, value, bindings.current); seen.current = value;
    if (adding.current.length) { bindings.current = [...bindings.current, ...adding.current]; adding.current = []; }
  }, [value]);
  const own = useRef(null), input = inputRef || own;
  const [caret, setCaret] = useState(0);
  const at = mentionAt(value, caret), options = at ? mentionOptions(detail, at.query) : [];
  const palette = at && options.length ? options : null, chosen = palette ? palette[Math.min(pick, palette.length - 1)] : null;
  const room = detail?.room || {}, group = room.kind === "group";
  const short = useShortPlaceholder();
  // M-3117: the Fleet chat's box takes the focus when its conversation opens (panel-chat.js Composer): a room's too.
  useEffect(() => { if (!closed) input.current?.focus(); }, [room.id || "", closed]);
  // 「在這裡 @ 它」 from the members panel or the office card: the mention goes into the box, after what is there, bound to
  // the member it was picked for (`bind`: { name, id }; see boundMentions).
  if (insertRef) insertRef.current = (text, bind = null) => {
    setValue((v) => {
      const base = v && !/\s$/.test(v) ? `${v} ` : v;
      // Appended: the binding goes in after the text's own change is applied (an edit at the end touches nothing before).
      if (bind) adding.current = [...adding.current, { ...bind, start: base.length + text.indexOf(`@${bind.name}`) }];
      return `${base}${text} `;
    });
    setTimeout(() => input.current?.focus(), 0);
  };
  const complete = (o) => {
    const next = `${value.slice(0, at.start)}${o.label} ${value.slice(caret)}`;
    setValue(next); setPick(0);
    setTimeout(() => { const el = input.current; if (el) { const n = at.start + o.label.length + 1; el.focus(); try { el.setSelectionRange(n, n); } catch { /* not a text field */ } setCaret(n); } }, 0);
  };
  const send = async () => {
    // M-3125: `canSendEmpty` — files are ready to go, so a post may be the files alone (the server takes it).
    const text = value.trim(); if ((!text && !canSendEmpty) || busy || closed) return;
    setBusy(true); setMsg(null);
    const r = await store.send(text, { mentions: boundMentions(value, detail, bindings.current), ...(reply ? { replyTo: reply.roomMessage } : {}) });
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
  // M-3308 (the user: a screenshot pasted with Ctrl+V did nothing in a room): the Fleet chat's paste, through the room's own
  // Attach and its file rules (hub-attachments.js pasteToAttach). A room that takes no files keeps the text (as before).
  const onPaste = (e) => { if (!closed) pasteToAttach(e, attach); };
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
  ${/* M-3311 (3): the Fleet chat's line under the box — Enter sends, Shift+Enter a new line — and a group room's @agent hint after it. */ ""}
  <div class=${`composer-row${group ? " hub-hints" : ""}`}><span class="hint hub-enter-hint">${t(touchScreen() ? "chat.nativeComposerHintTouch" : "chat.nativeComposerHint")}</span>${group ? html`<span class="hint hub-room-hint">${hroom("composerHint")}</span>` : null}</div>`;
}
