/** Hub-only join page and Administration contents; the shell remains panel-hub's. */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { hubClient } from "./hub-client.js";
import { hj, joinError } from "./hub-company-join-strings.js";
export function joinRequest() {
  try { const id = new URLSearchParams(location.search).get("join"); return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || "") ? id : null; }
  catch { return null; }
}
async function call(path, method = "GET", body, csrf) {
  try {
    const res = await fetch(path, { method, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}), ...(csrf ? { "X-AgEnD-Hub-CSRF": csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await res.json(); return { ...json, ok: res.ok };
  } catch { return { ok: false, code: "unavailable" }; }
}
export const approveCompanyJoin = (requestId, csrf) => call("/hub/v1/join/approve", "POST", { requestId }, csrf);
export function useCompanyJoinContext() {
  const requestId = joinRequest(), [view, set] = useState(requestId ? undefined : null), [attempt, retry] = useState(0);
  useEffect(() => {
    if (!requestId) { set(null); return; }
    let current = true, timer;
    const read = async () => {
      const r = await call("/hub/v1/join/browser?request=" + encodeURIComponent(requestId));
      if (!current) return; set(r);
      if (r.ok && Date.now() < r.outerDeadline && (["pending", "identity-approved", "issued"].includes(r.state) || r.state === "acknowledged" && !r.connected)) timer = setTimeout(read, 1500);
    };
    read(); return () => { current = false; clearTimeout(timer); };
  }, [requestId, attempt]);
  return { requestId, view, retry: () => retry(n => n + 1) };
}
export function CompanyJoinLead({ context }) {
  return html`<p class="hub-signin-lead">${context?.label ? hj("request", context.label) : hj("lead")}</p>
    ${context?.fleetOrigin ? html`<p class="note">${hj("origin")}: <span class="hub-origin"><code>${context.fleetOrigin}</code></span></p>` : null}`;
}
export function HubCompanyJoinPage({ session }) {
  const { requestId, view, retry } = useCompanyJoinContext(), [error, setError] = useState(() => session.companyJoinFailure?.requestId === joinRequest() ? joinError(session.companyJoinFailure.code) : null), [busy, setBusy] = useState(false), gen = useRef(0);
  useEffect(() => () => { gen.current++; }, []);
  const connect = async () => {
    if (busy || !view?.ok || view.state !== "pending") return;
    const token = ++gen.current; setBusy(true); setError(null);
    const r = await approveCompanyJoin(requestId, session.csrf);
    if (gen.current !== token) return;
    setBusy(false); if (!r.ok) setError(joinError(r.code)); retry();
  };
  const terminal = view?.ok && !["pending", "identity-approved", "issued"].includes(view.state);
  return html`<div class="col hub-owner"><div class="s-section-layout"><section class="card">
    <h3>${hj("title")}</h3>
    ${view === undefined ? html`<${Skeleton} variant="form" lines=${3} label=${hj("loading")} />` : null}
    ${view?.ok ? html`<${CompanyJoinLead} context=${view} />
      ${view.state === "pending" ? html`<div class="field-row"><button class="btn btn-primary" type="button" disabled=${busy} onClick=${connect}>${hj("connectAs", session.displayName || session.login)}</button></div>` : html`<p role="status">${view.state === "acknowledged" ? hj(view.connected ? "done" : "offline") : terminal ? joinError(view.reason || view.state) : hj("approved")}</p>`}
      ${view.issued && terminal && view.state !== "acknowledged" ? html`<p class="note">${hj("issued")}</p>` : null}
      ${view.returnPath ? html`<div class="field-row"><a class="btn btn-sm" href=${view.returnPath} rel="noreferrer">${hj("return")}</a></div>` : null}` : view ? html`<${ErrorState} message=${joinError(view.code)} onRetry=${retry} />` : null}
    ${error ? html`<${ErrorState} message=${error} onRetry=${retry} />` : null}
  </section></div></div>`;
}
export function CompanyJoinAdminCard() {
  const [view, setView] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const live = useRef(true), csrf = useRef(null);
  const [inviteLogin, setInviteLogin] = useState(""), [invitation, setInvitation] = useState(null);
  const read = async () => {
    const session = await hubClient().session();
    if (!live.current) return;
    if (!session.ok || !session.admin) { setError(hj("denied")); return; }
    csrf.current = session.csrf;
    const r = await call("/hub/v1/admin/company-join"); if (!live.current) return;
    if (r.ok) { setView(r); setError(null); } else setError(joinError(r.code));
  };
  useEffect(() => { live.current = true; read(); return () => { live.current = false; }; }, []);
  const change = async enabled => {
    if (busy || !view) return; setBusy(true); setError(null);
    const r = await call("/hub/v1/admin/company-join", "PUT", { enabled, expectedRevision: view.revision }, csrf.current);
    if (!live.current) return;
    setBusy(false); if (r.ok) setView(r); else setError(joinError(r.code));
  };
  const makeInvitation = async e => {
    e.preventDefault(); if (busy || !inviteLogin.trim()) return; setBusy(true); setError(null);
    const r = await call("/hub/v1/admin/company-join/invitations", "POST", { login: inviteLogin.trim() }, csrf.current);
    if (!live.current) return; setBusy(false);
    if (r.ok) setInvitation(r.url); else setError(joinError(r.code === "not-found" ? "denied" : r.code));
  };
  return html`<section class="card"><h3>${hj("adminTitle")}</h3><p class="note">${hj("adminLead")}</p>
    ${!view && !error ? html`<${Skeleton} variant="form" lines=${3} />` : null}
    ${error ? html`<${ErrorState} message=${error} onRetry=${read} />` : null}
    ${view ? html`<label class="check"><input type="checkbox" role="switch" class="s-ui-toggle" checked=${view.enabled} disabled=${busy} onChange=${e => change(e.target.checked)} /><span>${hj("enabled")}</span></label>
      ${view.companyLink ? html`<label class="field"><span>${hj("companyLink")}</span><textarea rows="4" readonly value=${view.companyLink} /></label>
        <div class="field-row"><button class="btn btn-sm" type="button" onClick=${async () => { try { await navigator.clipboard.writeText(view.companyLink); if (live.current) setCopied(true); } catch { if (live.current) setError(hj("copyFailed")); } }}>${hj(copied ? "copied" : "copy")}</button></div>` : null}` : null}
    ${view?.enabled ? html`<details><summary>${hj("inviteTitle")}</summary><p class="note">${hj("inviteLead")}</p>
      <form class="form" onSubmit=${makeInvitation}><label class="field"><span>${hj("inviteLogin")}</span><input value=${inviteLogin} autocomplete="off" onInput=${e => setInviteLogin(e.target.value)} /></label>
        <div class="field-row"><button class="btn btn-sm" type="submit" disabled=${busy || !inviteLogin.trim()}>${hj("inviteCreate")}</button></div></form>
      ${invitation ? html`<label class="field"><span>${hj("inviteTitle")}</span><textarea rows="4" readonly value=${invitation} /></label>
        <button type="button" class="btn btn-sm" onClick=${async () => { try { await navigator.clipboard.writeText(invitation); if (live.current) setCopied(true); } catch { if (live.current) setError(hj("copyFailed")); } }}>${hj(copied ? "copied" : "inviteCopy")}</button>` : null}
    </details>` : null}
  </section>`;
}
