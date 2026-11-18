// M-3339 (A2): a chat message's contact badge — message.contactTicket = { id, state } (the contract's ContactBadge), on a
// ClassicBot room's held request or its status line ("聯絡申請 #R12"), and on the worker's inbound copy of an approved one
// ("已准轉交 #R12"). A link to that request (Fleet → Authorizations, where the server scopes who may read it).
// Kept current: on the stream's contact-auth frame naming a request a badge shows, that request is read again from its
// scoped route (installBadgeRefresh) and its badges change in place; later draws use that state too. A reader the route
// refuses keeps the message's own state.
// HTML text for chat-thread.js's opts.contactBadge hook (the Fleet chat's only; a Hub room passes none): every value escaped.
import { appStore } from "/assets/app-store.js";
import { ca } from "./contact-auth-strings.js";
import { getTicket } from "./contact-auth-client.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATES = new Set(["pending", "approved", "delivered", "declined", "expired", "unknown"]);
/** The latest state read for a request (its scoped route), over the message's own. */
const fresh = new Map();
/** Requests a badge has shown on this page (the only ones a contact-auth frame reads again). */
const shown = new Set();

const badgeText = (id, state) => (state === "delivered" ? `${ca("forwarded")} #${id}`
  : state === "pending" || !STATES.has(state) ? ca("ticket", id) : `${ca("ticket", id)} · ${ca(`state_${state}`)}`);

export function contactBadgeHtml(x) {
  const tk = x && x.contactTicket;
  if (!tk || typeof tk.id !== "string" || !ID.test(tk.id)) return "";
  shown.add(tk.id);
  const state = fresh.get(tk.id) ?? tk.state;
  const ok = state === "delivered" || state === "approved";
  return `<a class="contact-badge${ok ? " ok" : ""}" data-contact-ticket="${esc(tk.id)}" href="/ui/fleet/authorizations?ticket=${encodeURIComponent(tk.id)}">${esc(badgeText(tk.id, state))}</a>`;
}

/** Read one request again and change its badges on the page in place. */
export async function refreshBadge(id, doc = typeof document !== "undefined" ? document : null) {
  if (!ID.test(String(id || "")) || !shown.has(id)) return;
  const r = await getTicket(id);
  if (!r.ok || !STATES.has(r.data?.state)) return;
  fresh.set(id, r.data.state);
  for (const a of doc ? doc.querySelectorAll("a.contact-badge") : []) {
    if (a.getAttribute("data-contact-ticket") !== id) continue;
    a.textContent = badgeText(id, r.data.state);
    a.classList.toggle("ok", r.data.state === "delivered" || r.data.state === "approved");
  }
}

let installed = null;
/** Once per page: the stream's contact-auth frames with a ticketId refresh that request's badges. */
export function installBadgeRefresh() {
  if (installed) return installed;
  const sub = appStore.get().streamOn;
  if (typeof sub !== "function") return () => {};
  const off = sub("contact-auth", (d) => { if (d && typeof d.ticketId === "string") void refreshBadge(d.ticketId); });
  installed = () => { if (typeof off === "function") off(); installed = null; };
  return installed;
}
