// M-3092 PR 2 (Hub rooms, track U): a room's composer — the Fleet chat's own ComposerInput, its palette (`cmd-palette`)
// and its reply bar (`reply-bar`), with what a room adds (docs/design/hub-rooms-ux.md §4):
// - typing `@` opens a menu: 「@所有 Agent」 (when this room lets me), 「@房間助理」 (when the room has one), each agent
//   (its owner and status dot; filtered by name or owner), then the people (an @ to a person only reminds them);
// - with @所有 Agent in the text, a line above says how many answer now and how many after they come back;
// - under the box, always: messages with no @agent are seen only by the people in the room;
// - `/` is plain text here (no slash commands); a refusal is worded where the Fleet chat words "Not sent: …".
import { html, useState, useRef } from "/assets/app-html.js";
import { ComposerInput, touchScreen } from "/assets/chat-composer.js";
import { t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { hroom } from "./hub-room-strings.js";
import { presenceDot } from "./hub-room-presence.js";

const ONLINE = new Set(["online", "idle", "working"]);
const agentsOf = (detail) => (detail?.members || []).filter((m) => m.kind === "agent" || m.kind === "later");

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
    out.push({ kind: "assistant", key: "assistant", label: hroom("mentionAssistant"), hint: hroom("mentionAssistantHint") });
  for (const a of agents) if (hit(a.name, a.owner?.name)) out.push({ kind: "agent", key: a.id, label: `@${a.name}`, hint: a.owner?.name || "", dot: presenceDot(a.presence) });
  for (const p of (detail?.members || []).filter((m) => m.kind === "person" && m.id !== detail?.me?.id)) if (hit(p.name)) out.push({ kind: "person", key: p.id, label: `@${p.name}`, hint: "" });
  return out;
}

/** The mentions a text names (spec seam 1: "all", "assistant" or an agent's exposure id), read from the text as sent. */
export function mentionsIn(text, detail) {
  const s = String(text || ""), out = [];
  if (s.includes(hroom("mentionAll"))) out.push("all");
  if (s.includes(hroom("mentionAssistant"))) out.push("assistant");
  for (const a of agentsOf(detail)) if (new RegExp(`@${a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(s)) out.push(a.id);
  return [...new Set(out)];
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
 */
export function RoomComposer({ store, detail, reply = null, onReply = () => {}, closed = false, inputRef, insertRef }) {
  const [value, setValue] = useState(""), [msg, setMsg] = useState(null), [busy, setBusy] = useState(false), [pick, setPick] = useState(0);
  const own = useRef(null), input = inputRef || own;
  const [caret, setCaret] = useState(0);
  const at = mentionAt(value, caret), options = at ? mentionOptions(detail, at.query) : [];
  const palette = at && options.length ? options : null, chosen = palette ? palette[Math.min(pick, palette.length - 1)] : null;
  const room = detail?.room || {}, group = room.kind === "group";
  // 「在這裡 @ 它」 from the members panel: the mention goes into the box, after what is there.
  if (insertRef) insertRef.current = (text) => { setValue((v) => `${v && !/\s$/.test(v) ? `${v} ` : v}${text} `); setTimeout(() => input.current?.focus(), 0); };
  const complete = (o) => {
    const next = `${value.slice(0, at.start)}${o.label} ${value.slice(caret)}`;
    setValue(next); setPick(0);
    setTimeout(() => { const el = input.current; if (el) { const n = at.start + o.label.length + 1; el.focus(); try { el.setSelectionRange(n, n); } catch { /* not a text field */ } setCaret(n); } }, 0);
  };
  const send = async () => {
    const text = value.trim(); if (!text || busy || closed) return;
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
  const paletteId = `hubMention-${room.id || "room"}`, optId = (o) => `${paletteId}-${o.key}`;
  if (closed) return html`<div class="composer-box"><p class="note" role="status">${hroom(detail?.room?.archived ? "errArchived" : "errNotMember")}</p></div>`;
  return html`<div class="composer-box hub-room-composer">
    ${palette ? html`<ul data-trust="palette" class="cmd-palette" id=${paletteId} role="listbox" aria-label=${hroom("mentionAll")}>
      ${palette.map((o) => html`<li key=${o.key} id=${optId(o)} role="option" aria-selected=${o === chosen ? "true" : "false"} class=${o === chosen ? "on" : ""}
        onMouseDown=${(e) => { e.preventDefault(); complete(o); }}>
        <span class="cmd-name">${o.dot ? html`<span class=${`dot ${o.dot}`} aria-hidden="true"></span> ` : null}${o.label}</span><span class="cmd-desc">${o.hint}</span></li>`)}
    </ul>` : null}
    ${group && value.includes(hroom("mentionAll")) ? html`<p class="note hub-room-allbar" role="status">${allBar(detail)}</p>` : null}
    ${reply ? html`<div class="reply-bar" data-trust="composer" role="status"><span class="reply-text">${reply.sender ? `${reply.sender} · ` : ""}${String(reply.text || "").slice(0, 80)}</span>
      <button type="button" class="icon-btn reply-cancel" title=${hroom("cancel")} aria-label=${hroom("cancel")} onClick=${() => { onReply(null); input.current?.focus(); }}><${Icon} name="close" size=${14} /></button></div>` : null}
    <${ComposerInput} inputRef=${input} value=${value} placeholder=${room.assistant ? hroom("composerAssistant") : group ? hroom("composer", room.name || "") : hroom("composerDirect", room.name || "")} onValue=${track} onKeyDown=${onKeyDown}
      controls=${palette ? paletteId : undefined} expanded=${!!palette} activeDescendant=${chosen ? optId(chosen) : undefined}
      stop=${{ hidden: true, disabled: true, title: t("chat.stopReply"), label: t("chat.stopReply"), onClick: () => {} }}
      send=${{ hidden: false, disabled: !value.trim() || busy, label: t("chat.send"), onClick: () => { void send(); } }} />
    ${msg ? html`<p class="err" role="alert">${msg.text}${msg.retry ? html` <button type="button" class="btn btn-sm" onClick=${send}>${hroom("retrySend")}</button>` : null}</p>` : null}
    ${group ? html`<p class="note hub-room-hint">${hroom("composerHint")}</p>` : null}
  </div>`;
}
