// M-3339 (A2): Fleet → Authorizations — requests from ClassicBot rooms to other agents, held for an approver (the contact
// authorization contract: src/contact-auth-types.ts; docs/design/classic-contact-authorizations.md). The server scopes
// the list (approvers and the source room's admins only; at most 50 a page, then a cursor) and decides who may decide.
// - Show: waiting (default) or all; one agent; one person (an exact identity, picked from a request — never a name search).
// - A request: who asked (the origin, through which agents), from which room to which agent, the verb and its message,
//   when it expires; Approve once / Decline when the reader may decide, with "also allow this contact" as a separate,
//   explicit choice. Approving forwards this one request once; "Forwarded" means delivered, not that the work is done.
// - ?ticket=<id> opens that request at the top (from a chat badge, Needs you or a Permissions history row).
// It reads again on the stream's contact-auth frame and when the page is shown again (no timer).
import { html, useEffect, useState } from "/assets/app-html.js";
import { register } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { toast } from "/assets/ui-toast.js";
import { Skeleton, ErrorState, Empty } from "/assets/ui-states.js";
import { ca } from "./contact-auth-strings.js";
import { decideTicket, getTicket, listTickets, personKey, shortTicketId } from "./contact-auth-client.js";

// The Fleet tab's own label (panel-fleet.js reads fleet.<tab>).
register("fleet", { en: { authorizations: "Authorizations" }, "zh-TW": { authorizations: "授權" } });

const when = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : ""; };
/** The server's reason codes (ContactTicket.reason, ContactPermissions.originRestriction.reason). */
export const REASONS = new Set(["earlier-non-admin", "unknown-origin"]);
const TONE = { pending: "warn", approved: "ok", delivered: "ok", declined: "bad", expired: "muted", unknown: "bad" };
const stateOf = (s) => (Object.prototype.hasOwnProperty.call(TONE, s) ? s : "unknown");
const label = (p) => (p && (p.label || p.userId)) || "";
/** datetime-local's value for a time `days` from now (the browser's own zone). */
/** M-3385: how long a request waits for a decision (its expiry from when it was asked), in whole minutes; 0 if unknown. */
const waitMinutes = (tk) => { const ms = Date.parse(tk.expiresAt) - Date.parse(tk.createdAt); return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : 0; };
const localIn = (days) => { const d = new Date(Date.now() + days * 864e5); d.setSeconds(0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16); };

/** One request: what it is, who asked, and — for its approver, while it waits — the decision. */
export function TicketCard({ ticket, onChange, onPerson, focus = false }) {
  const [busy, setBusy] = useState(false);
  const [allow, setAllow] = useState(false);
  const [until, setUntil] = useState(() => localIn(7));
  const [uses, setUses] = useState("");
  const tk = ticket, st = stateOf(tk.state);
  const decide = async (decision) => {
    if (busy) return;
    const n = uses.trim() === "" ? null : Math.max(1, Math.floor(Number(uses)));
    const grant = decision === "approve-once" && allow && until && tk.origin?.kind === "human" && (tk.origin?.people || []).length === 1 ? { expiresAt: new Date(until).toISOString(), remainingUses: Number.isFinite(n) ? n : null } : undefined;
    setBusy(true);
    const r = await decideTicket(tk.id, { revision: tk.revision, decision, ...(grant ? { grant } : {}) });
    setBusy(false);
    if (r.ok) { onChange?.(r.data); return; }
    if (r.code === "already-decided" || r.code === "expired" || r.code === "conflict") {
      toast(ca("alreadyDecided"), false);
      const again = await getTicket(tk.id);
      if (again.ok) onChange?.(again.data);
      return;
    }
    toast(ca(r.code === "forbidden" ? "forbidden" : r.code === "unavailable" ? "unavailable" : "decideFailed"), false);
  };
  const people = tk.origin?.people || [];
  const grantable = tk.origin?.kind === "human" && people.length === 1;
  const originText = tk.origin?.kind === "unknown" ? ca("origin_unknown") : tk.origin?.kind === "mixed" ? ca("origin_mixed") : "";
  return html`<article class=${`card contact-ticket${focus ? " focus" : ""}`} data-ticket=${tk.id} data-state=${st}>
    <div class="contact-ticket-head"><strong title=${tk.id}>${ca("ticket", shortTicketId(tk.id))}</strong><span class=${`contact-pill ${TONE[st]}`}>${ca(`state_${st}`)}</span>
      <span class="muted">${ca(`verb_${tk.verb}`)}</span></div>
    <p class="contact-ticket-route">${ca("from", tk.source)} → ${ca("to", tk.target)}</p>
    <p class="contact-ticket-origin">${people.map((p, i) => html`${i ? ", " : ""}<button type="button" class="link-btn" title=${ca("filterPerson", label(p))}
        onClick=${() => onPerson?.(p)}>${label(p)}</button>`)}${originText ? html` <span class="contact-pill warn">${originText}</span>` : null}
      ${tk.origin?.chain?.length ? html` <span class="muted">${ca("via", tk.origin.chain.join(" → "))}</span>` : null}</p>
    ${tk.message ? html`<div class="contact-ticket-message-box"><p class="contact-ticket-label">${ca("messageLabel")}</p><pre class="contact-ticket-message">${tk.message}</pre></div>` : null}
    <p class="muted contact-ticket-times">${ca("created", when(tk.createdAt))} · ${tk.decidedAt ? ca("decided", when(tk.decidedAt), label(tk.decidedBy))
      : st === "pending" && waitMinutes(tk) ? ca("expiresPending", when(tk.expiresAt), waitMinutes(tk)) : ca("expires", when(tk.expiresAt))}</p>
    ${st === "delivered" ? html`<p class="note">${ca("deliveryNote")}</p>` : null}
    ${/* The server's reason code, in words (Sentinel's A1 copy); a code the page doesn't know says nothing rather than a guess. */ ""}
    ${REASONS.has(tk.reason) ? html`<p class="note contact-reason" data-reason=${tk.reason}>${ca(`reason_${tk.reason}`)}${st === "pending" ? html` ${ca("resetNote")}` : null}</p>` : null}
    ${tk.canDecide && st === "pending" ? html`<div class="contact-decide">
      <p class="note">${ca("decidedNote")}</p>
      ${/* M-3385: a standing grant is one person's — offered only for a request from exactly one person (the server refuses
          any other: invalid-grant-origin), and said in full: who, what kind, from where to where, and where it lives. */ ""}
      ${grantable ? html`<label class="check contact-toggle"><input type="checkbox" checked=${allow} disabled=${busy} onChange=${(e) => setAllow(e.currentTarget.checked)} />
        <span>${ca("alsoAllow", label(people[0]), ca(`verb_${tk.verb}`), tk.source, tk.target)}</span></label>
        <p class="note contact-allow-hint">${ca("alsoAllowHint", tk.target)}</p>` : null}
      ${allow && grantable ? html`<div class="field-row contact-allow">
        <label class="field"><span>${ca("alsoAllowUntil")}</span><input class="input" type="datetime-local" value=${until} disabled=${busy} onInput=${(e) => setUntil(e.currentTarget.value)} /></label>
        <label class="field"><span>${ca("alsoAllowUses")}</span><input class="input" type="number" min="1" inputmode="numeric" value=${uses} disabled=${busy} onInput=${(e) => setUses(e.currentTarget.value)} /></label></div>` : null}
      <div class="field-row"><button type="button" class="btn btn-sm btn-primary" disabled=${busy} onClick=${() => void decide("approve-once")}>${ca("approveOnce")}</button>
        <button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => void decide("decline")}>${ca("decline")}</button></div>
    </div>` : null}
  </article>`;
}

const ticketFromSearch = () => { try { const v = new URLSearchParams(location.search).get("ticket"); return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null; } catch { return null; } };

export function ContactAuthorizations() {
  const { instances } = useStore(appStore);
  const [status, setStatus] = useState("pending");
  const [agent, setAgent] = useState("");
  const [person, setPerson] = useState(null);
  const [page, setPage] = useState({ loading: true, items: [], next: null });
  const [focus, setFocus] = useState(null);
  const focusId = ticketFromSearch();
  const filters = { ...(status === "pending" ? { status: "pending" } : {}), ...(agent ? { agent } : {}), ...(person ? { person: personKey(person) } : {}) };
  const read = async (cursor) => {
    const r = await listTickets({ ...filters, ...(cursor ? { cursor } : {}) });
    if (!r.ok) { setPage((p) => ({ ...p, loading: false, error: r.code })); return; }
    setPage((p) => ({ loading: false, items: cursor ? [...p.items, ...r.data.items] : r.data.items, next: r.data.nextCursor }));
  };
  const readFocus = async () => { if (!focusId) return; const r = await getTicket(focusId); setFocus(r.ok ? r.data : null); };
  const key = JSON.stringify(filters);
  useEffect(() => {
    setPage({ loading: true, items: [], next: null });
    void read(); void readFocus();
    const sub = appStore.get().streamOn;
    const off = typeof sub === "function" ? sub("contact-auth", () => { void read(); void readFocus(); }) : null;
    const onShow = () => { if (document.visibilityState === "visible") { void read(); void readFocus(); } };
    document.addEventListener("visibilitychange", onShow);
    return () => { if (typeof off === "function") off(); document.removeEventListener("visibilitychange", onShow); };
  }, [key, focusId]);
  const replace = (tk) => { setPage((p) => ({ ...p, items: p.items.map((x) => (x.id === tk.id ? tk : x)) })); if (focus && focus.id === tk.id) setFocus(tk); };
  const names = (instances || []).map((i) => i.name).filter(Boolean).sort();
  const list = page.items.filter((x) => !focus || x.id !== focus.id);
  return html`<div class="contact-auth-page">
    <p class="note">${ca("pageLead")}</p>
    <div class="field-row contact-filters">
      <div class="seg" role="group" aria-label=${ca("filterStatus")}>${["pending", "all"].map((s) => html`<button key=${s} type="button" class=${`seg-item${status === s ? " active" : ""}`}
          aria-pressed=${status === s ? "true" : "false"} onClick=${() => setStatus(s)}>${ca(`filter_${s}`)}</button>`)}</div>
      <label class="field contact-agent-filter"><span>${ca("filterAgent")}</span><select class="input" value=${agent} onChange=${(e) => setAgent(e.currentTarget.value)}>
        <option value="">${ca("filterAny")}</option>${names.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}</select></label>
      ${person ? html`<button type="button" class="btn btn-sm btn-ghost contact-person-filter" onClick=${() => setPerson(null)}>${ca("filterPerson", label(person))} · ${ca("filterPersonClear")}</button>` : null}
    </div>
    ${focus ? html`<${TicketCard} ticket=${focus} focus=${true} onChange=${replace} onPerson=${setPerson} />` : null}
    ${page.loading ? html`<${Skeleton} lines=${4} label=${ca("loading")} />`
      : page.error && !page.items.length ? (page.error === "forbidden" ? html`<p class="note">${ca("forbidden")}</p>` : html`<${ErrorState} message=${ca(page.error === "unavailable" ? "unavailable" : "loadFailed")} onRetry=${() => void read()} />`)
      : !list.length && !focus ? html`<${Empty} icon="key" title=${ca(status === "pending" ? "emptyPending" : "empty")} />`
      : html`<div class="contact-ticket-list">${list.map((tk) => html`<${TicketCard} key=${tk.id} ticket=${tk} onChange=${replace} onPerson=${setPerson} />`)}</div>`}
    ${page.next ? html`<div class="field-row"><button type="button" class="btn btn-sm" onClick=${() => void read(page.next)}>${ca("more")}</button></div>` : null}
  </div>`;
}
