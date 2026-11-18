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
import { toast } from "/assets/ui-toast.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { ca } from "./contact-auth-strings.js";
import { getPermissions, getTicket, putPermissions } from "./contact-auth-client.js";
import { TicketCard } from "./contact-authorizations.js";
import { notCovered, wouldDisableText } from "./contact-permissions.js";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function RequestNeed({ item }) {
  const ref = item.contactTicket || {};
  const [tk, setTk] = useState(null);
  useEffect(() => {
    let live = true;
    if (ID.test(String(ref.id || ""))) void getTicket(ref.id).then((r) => { if (live && r.ok) setTk(r.data); });
    return () => { live = false; };
  }, [ref.id]);
  return html`<div class="n-title"><strong>${ca("needsTitle", ref.source || "", ref.target || "")}</strong></div>
    ${tk ? html`<${TicketCard} ticket=${tk} onChange=${setTk} />` : null}
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
      const ok = await confirmDialog({ title: ca("confirmRestricted"), confirmLabel: ca("suggestSwitch"), message: [ca("modeRestrictedNote"), wouldDisableText(p.roomTools, p.nativeGuard)].join("\n\n") });
      if (!ok) return;
      const w = await putPermissions(name, { revision: p.revision, mode: "restricted" });
      toast(ca(w.ok ? "saved" : w.code === "conflict" ? "stale" : w.code === "forbidden" ? "forbidden" : "saveFailed"), w.ok);
    } finally { setBusy(false); }
  };
  const later = async () => {
    if (busy) return;
    setBusy(true);
    let ok = false;
    try { const r = await fetch("/ui/needs/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id }) }); ok = r.ok; } catch { ok = false; }
    setBusy(false);
    if (!ok) toast(ca("saveFailed"), false);
  };
  return html`<div class="n-title"><strong>${ca("suggestTitle")}</strong></div>
    <p class="n-detail">${name}: ${ca("suggestBody")}</p>
    ${notCovered(guard) ? html`<p class="feedback warning contact-not-covered">${ca("notCoveredWarning")}</p>` : null}
    <div class="n-actions">
      <button type="button" class="btn btn-sm btn-primary" disabled=${busy} onClick=${() => void switchRoom()}>${ca("suggestSwitch")}</button>
      <a class="btn btn-sm" href=${`${detailsPath(name)}?cat=permissions`}>${ca("suggestView")}</a>
      <button type="button" class="btn btn-sm btn-ghost" disabled=${busy} onClick=${() => void later()}>${ca("suggestLater")}</button>
    </div>`;
}

/** One contact item of Needs you (item.type "contact"); null for a reason this page doesn't know. */
export function ContactNeedsItem({ item }) {
  const body = item.reason === "contact_request" ? html`<${RequestNeed} item=${item} />` : item.reason === "contact_restricted_suggestion" ? html`<${SuggestionNeed} item=${item} />` : null;
  if (!body) return null;
  return html`<article data-trust="permission" class="n-item contact-need" data-reason=${item.reason}>
    <span class="n-icon"><${Icon} name="key" size=${18} /></span><div class="n-body">${body}</div></article>`;
}
