// M-3271 (the user: 「右鍵可以釘選訊息，這樣比較好找」): an agent's pinned messages. They are kept on the host (/ui/pins,
// web-pin-store.ts): admins only, never a guest's, never over the public link. Each pin is a copy of the message, so it
// outlives the 500-message window and a restart. Read when the chat opens, again on the stream's `pins` frame for that
// agent (another device pinned) and when the page is shown again.
// Here: the store, Pin / Unpin (the message menu, the list), the header's 📌 with its count (only when something is
// pinned), the list (click: the message, flashed; one no longer in the chat: the copy the pin kept) and that copy.
import { html, useEffect } from "/assets/app-html.js";
import { lang, t } from "/assets/app-i18n.js";
import { appStore, createStore, guestPage, useStore } from "/assets/app-store.js";
import { useCanCreate } from "/assets/app-shell.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { dateTimeText } from "/assets/clock-text.js";

/** Pins per agent (web-pin-store.ts PINS_MAX): the host says pins_full past it. */
export const PINS_MAX = 50;
/** { [instance]: { offered, pins: [{ key, role, sender, text, ts, files?, pinnedAt }] (newest first), rev } } */
export const pinsStore = createStore({});

/** Whether this page asks at all: never a guest's page or the public link (the host refuses them too). */
export const pinsAsked = () => !guestPage();   // M-3278: the public link's admin too
const put = (name, v) => { const all = pinsStore.get(); pinsStore.set({ ...all, [name]: { offered: false, pins: [], ...(all[name] || {}), ...v } }); };
const listOf = (j) => (Array.isArray(j?.pins) ? j.pins.filter((p) => p && typeof p.key === "string") : []);

/** Read `name`'s pins. A refusal (not an admin) means none, and no Pin in the menu. */
export async function readPins(name, fetcher = (u, o) => fetch(u, o)) {
  if (!name || !pinsAsked()) return;
  try {
    const r = await fetcher(`/ui/pins?instance=${encodeURIComponent(name)}`, { credentials: "same-origin" });
    if (!r.ok) { put(name, { offered: false, pins: [] }); return; }
    const j = await r.json();
    put(name, { offered: true, pins: listOf(j), rev: j.rev });
  } catch { /* offline: the next frame or visit reads again */ }
}
export const pinsOf = (name) => pinsStore.get()[name]?.pins || [];
export const pinOffered = (name) => pinsStore.get()[name]?.offered === true;
export const isPinned = (name, key) => pinsOf(name).some((p) => p.key === key);

/** Pin (on) or unpin `key`; the host answers with the list. Said in a toast either way. */
export async function setPin(name, key, on, fetcher = (u, o) => fetch(u, o)) {
  try {
    const r = await fetcher(`/ui/pins/${encodeURIComponent(name)}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(on ? { pin: key } : { unpin: key }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j?.error === "pins_full" ? t("chat.pinsFull", String(PINS_MAX)) : t("chat.pinFailed"), false); return false; }
    put(name, { offered: true, pins: listOf(j), rev: j.rev });
    toast(t(on ? "chat.pinned" : "chat.unpinned"));
    return true;
  } catch { toast(t("chat.pinFailed"), false); return false; }
}

/**
 * Keep `name`'s pins read while its chat is open — an admin's page only (useCanCreate: nothing is asked for anyone else):
 * once per page (#1374: coming back to a chat reads nothing), then on its `pins` frame and when the page is shown again.
 */
export function usePins(name) {
  const all = useStore(pinsStore), admin = useCanCreate();
  useEffect(() => {
    if (!name || !admin || !pinsAsked()) return undefined;
    if (!pinsStore.get()[name]) void readPins(name);
    const sub = appStore.get().streamOn;
    const off = typeof sub === "function" ? sub("pins", (d) => { if (!d || d.instance === name) void readPins(name); }) : null;
    const onShow = () => { if (document.visibilityState === "visible") void readPins(name); };
    document.addEventListener("visibilitychange", onShow);
    return () => { if (typeof off === "function") off(); document.removeEventListener("visibilitychange", onShow); };
  }, [name, admin]);
  return all[name] || { offered: false, pins: [] };
}

const when = (ts) => { const d = new Date(ts); return Number.isFinite(d.getTime()) ? dateTimeText(d, { dateStyle: "medium", timeStyle: "short" }, lang()) : ""; };
const snippet = (s, n = 40) => { const one = String(s || "").replace(/\s+/g, " ").trim(); return one.length > n ? `${one.slice(0, n - 1)}…` : one; };

/** The header's 📌 with the count: only when this agent has a pin. `onOpen` opens the list (the chat panel's). */
export function PinsButton({ name, onOpen }) {
  const s = useStore(pinsStore)[name];
  const n = s?.offered ? s.pins.length : 0;
  if (!n) return null;
  const label = t("chat.pinsButton", String(n));
  return html`<button type="button" class="btn btn-ghost btn-sm chat-pins-btn" title=${label} aria-label=${label} onClick=${() => onOpen?.()}><${Icon} name="pin" size=${16} /><span class="chat-pins-count" aria-hidden="true">${n}</span></button>`;
}

/** The list: newest pin first; a row shows its message (`onJump(pin)`), its × unpins it. */
export function PinsDialog({ name, onClose, onJump }) {
  const pins = useStore(pinsStore)[name]?.pins || [];
  return html`<${Dialog} title=${`${t("chat.pinsTitle")} · ${pins.length}`} onClose=${onClose} cls="chat-pins-dlg">
    ${pins.length ? html`<ul class="chat-pins">${pins.map((p) => html`<li key=${p.key} class="chat-pin" data-key=${p.key}>
      <button type="button" class="chat-pin-go" title=${t("chat.pinShow")} onClick=${() => onJump?.(p)}>
        <span class="chat-pin-meta"><strong>${p.sender}</strong><time datetime=${p.ts}>${when(p.ts)}</time></span>
        <span class="chat-pin-text">${p.text}</span>
        ${p.files?.length ? html`<span class="chat-pin-files">${t("chat.pinFiles", p.files.map((f) => f.name).join(", "))}</span>` : null}
      </button>
      <button type="button" class="icon-btn chat-pin-x" title=${t("chat.unpin")} aria-label=${t("chat.pinUnpin", snippet(p.text))}
        onClick=${() => { void setPin(name, p.key, false); }}><${Icon} name="close" size=${14} /></button>
    </li>`)}</ul>` : html`<p class="note">${t("chat.pinsEmpty")}</p>`}
  </${Dialog}>`;
}

/** A pinned message no longer in the chat: the copy its pin kept (words, author, time, file names). */
export function PinCopyDialog({ pin, onClose }) {
  return html`<${Dialog} title=${t("chat.pinCopyTitle")} onClose=${onClose} cls="chat-pin-copy">
    <p class="note">${t("chat.pinCopyNote")}</p>
    <p class="chat-pin-meta"><strong>${pin.sender}</strong><time datetime=${pin.ts}>${when(pin.ts)}</time></p>
    <div class="chat-pin-copy-text">${pin.text}</div>
    ${pin.files?.length ? html`<p class="chat-pin-files">${t("chat.pinFiles", pin.files.map((f) => f.name).join(", "))}</p>` : null}
  </${Dialog}>`;
}
