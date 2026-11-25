// M-3339 (A2): Needs you's contact items (panel-needs.js hands item.type "contact" here). The server's needs list carries
// only references, scoped to the signed-in viewer (Sentinel's seam):
// - reason "contact_request", contactTicket { id, source, target }: the title names source and target; the request itself
//   (who asked, the message, whether this reader may decide) is read from the scoped ticket route — never shown from the
//   list. Approve once / Decline there (TicketCard); Open goes to Fleet → Authorizations.
// - reason "contact_restricted_suggestion", contactSuggestion { instance }: 切換這個房間 reads the room's permissions (its
//   revision, and what would stop), confirms, then PUTs mode restricted; 查看影響與常用轉交 opens its Permissions;
//   稍後 acknowledges the reminder (POST /ui/needs/ack — the server's durable dismissal; the mode never changes).
// The item leaves the list when the server's next `needs` drops it.
import { html, useEffect, useState } from "/assets/app-html.js";
import { detailsPath } from "/assets/app-route.js";
import { Icon } from "/assets/ui-icons.js";
import { appStore, useStore } from "/assets/app-store.js";
import { labelOf } from "/assets/instance-nav.js";
import { toast } from "/assets/ui-toast.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { ca } from "./contact-auth-strings.js";
import { getPermissions, getTicket, putPermissions, dismissSuggestion } from "./contact-auth-client.js";
import { TicketCard } from "./contact-authorizations.js";
import { notCovered, wouldDisableMore, wouldDisableText } from "./contact-permissions.js";
// M-3736 J (S-228): where the same-card host is installed, a request's item is its one card (Sentinel, #4492: the item is
// an ordinary contact_request for every recognized managing admin, verified or not; no count-only line).
import { getCard, RC_ID, sameCardState } from "./request-contact-client.js";
import { RequestContactCard } from "./request-contact-card.js";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function RequestNeed({ item }) {
  const ref = item.contactTicket || {};
  const [tk, setTk] = useState(null);
  const [host, setHost] = useState(null), [rc, setRc] = useState(null);
  // M-3680: the agents by the names the page shows them (the request card below does the same).
  const { instances } = useStore(appStore);
  const agent = (name) => (name ? labelOf((instances || []).find((i) => i.name === name) || { name }) : "");
  useEffect(() => {
    let live = true;
    // Today's scoped ticket read only where the host is known to be off; installed → the one card; not known → neither.
    void sameCardState().then((s) => {
      if (!live) return;
      setHost(s);
      if (s === "on" && RC_ID.test(String(ref.id || ""))) void getCard(ref.id).then((r) => { if (live && r.ok) setRc(r.data); });
      else if (s === "off" && ID.test(String(ref.id || ""))) void getTicket(ref.id).then((r) => { if (live && r.ok) setTk(r.data); });
    });
    return () => { live = false; };
  }, [ref.id]);
  return html`<div class="n-title"><strong>${ca("needsTitle", agent(ref.source), agent(ref.target))}</strong></div>
    ${host === "on" && rc ? html`<${RequestContactCard} card=${rc} onChange=${setRc} />` : host === "off" && tk ? html`<${TicketCard} ticket=${tk} onChange=${setTk} />` : null}
    <div class="n-actions">${ID.test(String(ref.id || "")) ? html`<a class="btn btn-sm btn-ghost" href=${`/ui/fleet/authorizations?ticket=${encodeURIComponent(ref.id)}`}>${ca("needsOpen")}</a>` : null}</div>`;
}

function SuggestionNeed({ item }) {
  const name = item.contactSuggestion?.instance || item.instance;
  const [busy, setBusy] = useState(false);
  // The room's guard coverage, read (scoped) before the switch: not covered → said here, before the mode is set.
  const [guard, setGuard] = useState(null);
  useEffect(() => {
    let live = true;
    if (name) void getPermissions(name).then((r) => { if (live && r.ok) setGuard(r.data.nativeGuard || null); });
    return () => { live = false; };
  }, [name]);
  const switchRoom = async () => {
    if (busy || !name) return;
    setBusy(true);
    try {
      const r = await getPermissions(name);
      if (!r.ok) { toast(ca(r.code === "forbidden" ? "forbidden" : r.code === "unavailable" ? "unavailable" : "loadFailed"), false); return; }
      const p = r.data;
      if (p.canSetMode !== true) { toast(ca("forbidden"), false); return; }
      const ok = await confirmDialog({ title: ca("confirmRestricted"), confirmLabel: ca("suggestSwitch"), message: [ca("modeRestrictedNote"), ca("switchOriginNote"), wouldDisableText(p.roomTools, p.nativeGuard)].join("\n\n"), more: wouldDisableMore(p.roomTools) });
      if (!ok) return;
      const w = await putPermissions(name, { revision: p.revision, mode: "restricted" });
      toast(ca(w.ok ? "saved" : w.code === "conflict" ? "stale" : w.code === "forbidden" ? "forbidden" : "saveFailed"), w.ok);
    } finally { setBusy(false); }
  };
  const later = async () => {
    if (busy) return;
    setBusy(true);
    const r = await dismissSuggestion(item.id);
    setBusy(false);
    if (!r.ok) toast(ca(r.status === 401 ? "laterSignedOut" : r.code === "csrf" || r.code === "cross-site" ? "laterRefresh" : r.code === "verification-required" ? "laterVerify"
      : r.code === "forbidden" ? "laterForbidden" : r.code === "missing" ? "laterMissing" : r.status === 0 ? "laterNetwork" : "laterUnavailable"), false, { detail: true });
  };
  return html`<div class="n-title"><strong>${ca("suggestTitle")}</strong></div>
    <p class="n-detail">${name}: ${ca("suggestBody")}</p>
    <p class="feedback warning contact-origin-switch">${ca("switchOriginNote")}</p>
    ${notCovered(guard) ? html`<p class="feedback warning contact-not-covered">${ca("notCoveredWarning")}</p>` : null}
    <div class="n-actions">
      <button type="button" class="btn btn-sm btn-primary" disabled=${busy} onClick=${() => void switchRoom()}>${ca("suggestSwitch")}</button>
      <a class="btn btn-sm" href=${`${detailsPath(name)}?cat=permissions`}>${ca("suggestView")}</a>
      <button type="button" class="btn btn-sm btn-ghost" disabled=${busy} onClick=${() => void later()}>${ca("suggestLater")}</button>
    </div>`;
}

/** M-3381: a Needs you item that is a room's restricted-mode suggestion. */
export const isRestrictedSuggestion = (item) => item?.type === "contact" && item.reason === "contact_restricted_suggestion";

/**
 * M-3381 (the user, beta.14: one row per existing room flooded the list): every room's restricted-mode suggestion in ONE
 * low-key group, closed until opened — "N existing ClassicBot rooms can switch to restricted mode" — each room's card
 * (switch / preview / later) inside it.
 */
export function ContactSuggestionsGroup({ items }) {
  if (!items?.length) return null;
  return html`<details class="n-group n-suggestions" data-trust="permission">
    <summary class="n-group-head">${ca("suggestGroup", items.length)}</summary>
    ${items.map((item) => html`<${ContactNeedsItem} key=${item.id} item=${item} />`)}
  </details>`;
}

/** One contact item of Needs you (item.type "contact"); null for a reason this page doesn't know. */
export function ContactNeedsItem({ item }) {
  const body = item.reason === "contact_request" ? html`<${RequestNeed} item=${item} />` : item.reason === "contact_restricted_suggestion" ? html`<${SuggestionNeed} item=${item} />` : null;
  if (!body) return null;
  return html`<article data-trust="permission" class="n-item contact-need" data-reason=${item.reason}>
    <span class="n-icon"><${Icon} name="key" size=${18} /></span><div class="n-body">${body}</div></article>`;
}
