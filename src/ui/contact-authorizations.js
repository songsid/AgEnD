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
import { register, lang } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { toast } from "/assets/ui-toast.js";
import { Skeleton, ErrorState, Empty } from "/assets/ui-states.js";
import { detailsPath } from "/assets/app-route.js";
import { labelOf } from "/assets/instance-nav.js";
import { ContactGrantEditor } from "./contact-grant-editor.js";
import { InfoTip } from "/assets/info-tip.js";
import { ca } from "./contact-auth-strings.js";
import { decideTicket, getTicket, listTickets, personKey, shortTicketId } from "./contact-auth-client.js";
import { dateTimeText } from "/assets/clock-text.js";

// The Fleet tab's own label (panel-fleet.js reads fleet.<tab>).
register("fleet", { en: { authorizations: "Authorizations" }, "zh-TW": { authorizations: "授權" } });

const when = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? dateTimeText(d, { dateStyle: "medium", timeStyle: "short" }, []) : ""; };
/** The server's reason codes (ContactTicket.reason, ContactPermissions.originRestriction.reason). */
export const REASONS = new Set(["earlier-non-admin", "unknown-origin"]);
const TONE = { pending: "warn", approved: "ok", delivered: "ok", declined: "bad", expired: "muted", unknown: "bad" };
const stateOf = (s) => (Object.prototype.hasOwnProperty.call(TONE, s) ? s : "unknown");
const label = (p) => (p && (p.label || p.userId)) || "";
/** How long an application waits for a decision, from its server timestamps. */
const waitMinutes = (tk) => { const ms = Date.parse(tk.expiresAt) - Date.parse(tk.createdAt); return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : 0; };

/** One request: what it is, who asked, and — for its approver, while it waits — the decision. */
export function TicketCard({ ticket, onChange, onPerson, focus = false }) {
  const [busy, setBusy] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const { instances } = useStore(appStore);
  const agentLabel = (name) => labelOf((instances || []).find((i) => i.name === name) || { name });
  const personLabel = label;
  const tk = ticket, st = stateOf(tk.state);
  const decide = async (decision, grant) => {
    if (busy) return false;
    setBusy(true);
    const r = await decideTicket(tk.id, { revision: tk.revision, decision, ...(grant ? { grant } : {}) });
    setBusy(false);
    if (r.ok) { if (grant) toast(ca("grantSaved"), true); onChange?.(r.data); return true; }
    if (r.code === "already-decided" || r.code === "expired" || r.code === "conflict") {
      toast(ca("alreadyDecided"), false);
      const again = await getTicket(tk.id);
      if (again.ok) onChange?.(again.data);
      return false;
    }
    toast(ca(r.code === "verification-required" ? "verifyFirst" : r.code === "forbidden" ? "forbidden" : r.code === "unavailable" ? "unavailable" : r.code === "updating" ? "updating" : "decideFailed"), false);
  };
  const people = tk.origin?.people || [];
  const grantable = ["human", "mixed"].includes(tk.origin?.kind) && people.length > 0 && people.length <= 16;
  // M-3385: when it was decided; or, while it waits, how long it waits and that nothing is forwarded after that.
  const endsText = tk.decidedAt ? ca("decided", when(tk.decidedAt), personLabel(tk.decidedBy))
    : st === "pending" && waitMinutes(tk) ? ca("expiresPending", when(tk.expiresAt), waitMinutes(tk)) : ca("expires", when(tk.expiresAt));
  const originText = tk.origin?.kind === "unknown" ? ca("origin_unknown") : tk.origin?.kind === "mixed" ? ca("origin_mixed") : "";
  return html`<article class=${`card contact-ticket${st === "pending" || focus ? " lbar" : ""}${focus ? " focus" : ""}`} data-ticket=${tk.id} data-state=${st}>
    <div class="contact-ticket-head"><strong>${ca("ticketTitle")}</strong><code class="contact-ticket-id" title=${tk.id}>#${shortTicketId(tk.id)}</code>
      <span class="tag contact-ticket-verb">${ca(`verb_${tk.verb}`)}</span><span class=${`tag contact-ticket-state${TONE[st] === "warn" ? " warn" : TONE[st] === "ok" ? " s-state ok" : TONE[st] === "bad" ? " s-state bad" : ""}`}>${ca(`state_${st}`)}</span></div>
    <div class="contact-ticket-meta">
      <div class="contact-ticket-route"><span>${ca("from", "")}</span><span class="contact-agent-chip" title=${tk.source}>${agentLabel(tk.source)}</span>
        <span>→ ${ca("to", "")}</span><span class="contact-agent-chip" title=${tk.target}>${agentLabel(tk.target)}</span></div>
      <div class="contact-ticket-origin">${people.map((p) => html`<button type="button" class="link-btn" title=${ca("filterPerson", personLabel(p))}
          onClick=${() => onPerson?.(p)}>${personLabel(p)}</button>`)}${originText ? html`<span class="tag warn">${originText}</span>` : null}
        ${tk.origin?.chain?.length ? html`<span class="contact-hop-chain"><span>${ca("via", "")}</span>${tk.origin.chain.map((name, i) => html`${i ? html`<span aria-hidden="true">→</span>` : null}<span class="contact-hop" title=${name}>${agentLabel(name)}</span>`)}</span>` : null}</div>
    </div>
    ${tk.message ? html`<div class="contact-ticket-message-box"><p class="contact-ticket-label">${ca("messageLabel")}</p><pre class="contact-ticket-message">${tk.message}</pre></div>` : null}
    <div class="contact-ticket-foot">
      <div class="contact-ticket-times"><span class="contact-time-item" title=${ca("created", when(tk.createdAt))}>${ca("created", when(tk.createdAt))}</span>
        <span class=${`contact-time-item${!tk.decidedAt && st === "pending" && waitMinutes(tk) ? " contact-time-wait" : ""}`} title=${endsText}>${endsText}</span></div>
      ${st === "delivered" ? html`<p class="note">${ca("deliveryNote")}</p>` : null}
      ${REASONS.has(tk.reason) ? html`<p class="note contact-reason" data-reason=${tk.reason}>${ca(`request_reason_${tk.reason}`, agentLabel(tk.source))}${st === "pending" ? html`${lang() === "zh-TW" ? "" : " "}${ca("requestRecoveryNote", agentLabel(tk.source))}` : null}</p>` : null}
    </div>
    ${tk.grantIds?.length ? html`<p><a class="st-link" href=${`${detailsPath(tk.target)}?cat=permissions`}>${ca("grantView")}</a></p>` : null}
    ${tk.canDecide && st === "pending" ? html`<div class="contact-decide">
      ${/* M-3385 (the user, 11-20: easy to read but too long): one short visible line; what an approval means onward is in its ⓘ. */ ""}
      <p class="note contact-decided-note">${ca("decidedNote")} <${InfoTip} text=${ca("decidedNoteMore")} label=${ca("decidedNoteAbout")} /></p>
      <div class="contact-decide-controls"><button type="button" class="btn btn-sm btn-primary" disabled=${busy} onClick=${() => void decide("approve-once")}>${ca("approveOnce")}</button>
        <button type="button" class="btn btn-sm" disabled=${busy || !grantable} onClick=${() => setGrantOpen(true)}>${ca(people.length > 1 ? "allowPeople" : "allowPerson")}</button>
        <button type="button" class="btn btn-sm danger" disabled=${busy} onClick=${() => void decide("decline")}>${ca("decline")}</button></div>
      ${!grantable ? html`<p class="note">${ca("grantUnknown")}</p>` : null}
      ${grantOpen && grantable ? html`<${ContactGrantEditor} key=${`${tk.id}:${tk.revision}`} people=${people} source=${agentLabel(tk.source)} target=${agentLabel(tk.target)} verb=${tk.verb}
        onClose=${() => setGrantOpen(false)} onSave=${choice => decide("approve-once", { expiresAt: choice.expiresAt, remainingUses: choice.remainingUses, personKeys: choice.personKeys })} />` : null}
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
    <p class="s-page-lead">${ca("pageLead")}</p>
    <div class="us-bar-top contact-filters">
      <div class="seg-inline" role="group" aria-label=${ca("filterStatus")}>${["pending", "all"].map((s) => html`<button key=${s} type="button" class=${`btn btn-sm${status === s ? " btn-primary" : ""}`}
          aria-pressed=${status === s ? "true" : "false"} onClick=${() => setStatus(s)}>${ca(`filter_${s}`)}</button>`)}</div>
      <label class="us-group contact-agent-filter"><span>${ca("filterAgent")}</span><select value=${agent} onChange=${(e) => setAgent(e.currentTarget.value)}>
        <option value="">${ca("filterAny")}</option>${names.map((n) => html`<option key=${n} value=${n}>${labelOf((instances || []).find((i) => i.name === n))}</option>`)}</select></label>
      ${person ? html`<span class="chip contact-person-filter"><span>${ca("filterPerson", label(person))}</span><button type="button" class="chip-x" aria-label=${ca("filterPersonClear")} title=${ca("filterPersonClear")} onClick=${() => setPerson(null)}>×</button></span>` : null}
    </div>
    ${focus ? html`<${TicketCard} ticket=${focus} focus=${true} onChange=${replace} onPerson=${setPerson} />` : null}
    ${page.loading ? html`<${Skeleton} variant="cards" lines=${2} label=${ca("loading")} />`
      : page.error && !page.items.length ? (page.error === "verification-required" ? html`<p class="note contact-verify">${ca("verifyFirst")}</p>`
        : page.error === "forbidden" ? html`<p class="note">${ca("forbidden")}</p>` : html`<${ErrorState} message=${ca(page.error === "unavailable" ? "unavailable" : "loadFailed")} onRetry=${() => void read()} />`)
      : !list.length && !focus ? html`<${Empty} icon="key" title=${ca(status === "pending" ? "emptyPending" : "empty")} hint=${ca("emptyHint")} action=${status === "pending" ? html`<button type="button" class="btn btn-sm" onClick=${() => setStatus("all")}>${ca("viewAll")}</button>` : null} />`
      : html`<div class="contact-ticket-list">${list.map((tk) => html`<${TicketCard} key=${tk.id} ticket=${tk} onChange=${replace} onPerson=${setPerson} />`)}</div>`}
    ${page.next ? html`<div class="field-row"><button type="button" class="btn btn-sm" onClick=${() => void read(page.next)}>${ca("more")}</button></div>` : null}
  </div>`;
}
