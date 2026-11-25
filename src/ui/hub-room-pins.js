// M-3340 (the user: personal pins): a Hub room's pinned messages — each person's own, kept on the Hub per person per room
// (GET/PUT/DELETE /hub/v1/rooms/<id>/pins; room-pins-v1), never shown to anyone else in the room. The Fleet chat's pin UX
// (#4095, chat-pins.js — its look, its words): Pin / Unpin in a message's menu, the header's 📌 with the count, and the
// list (newest first; a row shows its message in the room, flashed; × unpins it). At most 50 per room.
// A Hub module: imports only the shared /assets/ (never the Fleet's chat-pins.js); the room store (hub-room-thread.js)
// holds the list and answers pin/unpin.
import { html } from "/assets/app-html.js";
import { lang, t } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Icon } from "/assets/ui-icons.js";
import { hroom } from "./hub-room-strings.js";
import { dateTimeText } from "/assets/clock-text.js";

/** The Hub's limit per person per room (src/hub/rooms/service.ts ROOM_PINS_MAX). */
export const ROOM_PINS_MAX = 50;

const when = (ms) => { const d = new Date(ms); return Number.isFinite(d.getTime()) ? dateTimeText(d, { dateStyle: "medium", timeStyle: "short" }, lang()) : ""; };
const snippet = (s, n = 40) => { const one = String(s || "").replace(/\s+/g, " ").trim(); return one.length > n ? `${one.slice(0, n - 1)}…` : one; };
const textOf = (m) => String(m?.text || "");
const filesOf = (m) => (Array.isArray(m?.files) ? m.files.map((f) => f && f.name).filter(Boolean) : []);

/** The header's 📌 with the count: only when I have a pin in this room. */
export function RoomPinsButton({ count, onOpen }) {
  if (!count) return null;
  const label = t("chat.pinsButton", String(count));
  return html`<button type="button" class="btn btn-ghost btn-sm chat-pins-btn hub-room-pins-btn" title=${label} aria-label=${label} onClick=${() => onOpen?.()}>
    <${Icon} name="pin" size=${16} /><span class="chat-pins-count" aria-hidden="true">${count}</span></button>`;
}

/** The list: newest pin first; a row shows its message (`onJump(pin)`), its × unpins it (`onUnpin(pin)`). Only mine. */
export function RoomPinsDialog({ pins, onClose, onJump, onUnpin }) {
  return html`<${Dialog} title=${`${t("chat.pinsTitle")} · ${pins.length}`} onClose=${onClose} cls="chat-pins-dlg hub-room-pins-dlg">
    <p class="note hub-room-pins-only">${hroom("pinsOnlyYou")}</p>
    ${pins.length ? html`<ul class="chat-pins">${pins.map((p) => html`<li key=${p.messageId} class="chat-pin" data-message=${p.messageId}>
      <button type="button" class="chat-pin-go" title=${t("chat.pinShow")} onClick=${() => onJump?.(p)}>
        <span class="chat-pin-meta"><strong>${String(p.message?.author?.name || "")}</strong><time datetime=${new Date(p.message?.at || 0).toISOString()}>${when(p.message?.at)}</time></span>
        <span class="chat-pin-text">${textOf(p.message)}</span>
        ${filesOf(p.message).length ? html`<span class="chat-pin-files">${t("chat.pinFiles", filesOf(p.message).join(", "))}</span>` : null}
      </button>
      <button type="button" class="icon-btn chat-pin-x" title=${t("chat.unpin")} aria-label=${t("chat.pinUnpin", snippet(textOf(p.message)))}
        onClick=${() => onUnpin?.(p)}><${Icon} name="close" size=${14} /></button>
    </li>`)}</ul>` : html`<p class="note">${t("chat.pinsEmpty")}</p>`}
  </${Dialog}>`;
}
