import { register, t } from "/assets/app-i18n.js";
/** Hub-only join page and Administration contents; the shell remains panel-hub's. */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { hubClient } from "./hub-client.js";
import { hj, joinError } from "./hub-company-join-strings.js";
import * as entryWords from "./hub-company-join-strings.js";
import { HubJoinCard } from "./hub-join-steps.js";
// M-2921 (spec 1.1): the Hub tab's own words for closing itself and for E13 (its own namespace: a cached older
// company-join dictionary must not leave a key showing).
register("hubJoinOne", {
  en: { closing: "Connected. You can close this tab.",
    offerPending: "Another connection with a pairing code is still in progress for you. Finish or stop it on the Hub first." },
  "zh-TW": { closing: "已連接。可以關閉這個分頁。", offerPending: "你有另一個用配對碼的連接還沒完成。請先在 Hub 完成或停止它。" },
});
const hj1 = key => t(`hubJoinOne.${key}`);
const approveError = code => code === "offer-pending" ? hj1("offerPending") : joinError(code);
export function joinRequest() {
  try { const id = new URLSearchParams(location.search).get("join"); return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || "") ? id : null; }
  catch { return null; }
}
export function companyInfoRequest() { try { return new URLSearchParams(location.search).get("joinInfo") === "1"; } catch { return false; } }
export function CompanyJoinInfoPage() {
  const [fleet, setFleet] = useState(""), [copied, setCopied] = useState(false), [error, setError] = useState(null);
  let link = "", target = null, separateHosts = false;
  try {
    const fragment = location.hash;
    if (fragment.length <= 8192 && /^#(?:hub|invite)=[A-Za-z0-9_-]+$/.test(fragment)) link = location.origin + "/join-info" + fragment;
    if (fleet) {
      const u = new URL(fleet);
      if (u.origin === fleet && (u.protocol === "https:" || u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) {
        // Browser cookies are hostname-scoped, not port-scoped. Refuse before offering navigation.
        separateHosts = u.hostname === new URL(location.origin).hostname;
        if (!separateHosts) target = u.origin + "/settings/hub#join=" + encodeURIComponent(link);
      }
    }
  } catch { /* Invalid addresses remain an inactive navigation link. */ }
  return html`<div class="col hub-owner"><div class="s-section-layout"><section class="card hub-company-join"><h3>${hj("companyLink")}</h3>
    <p class="note">${hj("linkLead")}</p>
    ${link ? html`<label class="field"><span>${hj("companyLink")}</span><textarea rows="4" readonly value=${link} /></label><div class="field-row"><button class="btn btn-sm" type="button" onClick=${async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setError(hj("copyFailed")); } }}>${hj(copied ? "copied" : "copy")}</button></div>
      <label class="field"><span>${hj("fleetAddress")}</span><input value=${fleet} type="url" onInput=${e => setFleet(e.target.value.trim())} /></label>
      ${separateHosts ? html`<${ErrorState} message=${hj("separateHosts")} />` : null}
      ${target ? html`<a class="btn btn-primary" href=${target} target="_blank" rel="noopener noreferrer">${hj("openFleet")}</a>` : null}` : html`<${ErrorState} message=${hj("invalidLink")} />`}
    ${error ? html`<p class="err" role="alert">${error}</p>` : null}
  </section></div></div>`;
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
    setBusy(false); if (!r.ok) setError(approveError(r.code)); retry();
  };
  const terminal = view?.ok && !["pending", "identity-approved", "issued"].includes(view.state);
  // Connected: say so, close this tab; a tab the browser keeps open (one it did not open by script) offers the way back after 300 ms.
  const done = view?.ok && view.state === "acknowledged" && view.connected === true, [stayed, setStayed] = useState(false);
  useEffect(() => {
    if (!done) return;
    try { globalThis.close?.(); } catch { /* the browser decides */ }
    const timer = setTimeout(() => setStayed(true), 300);
    return () => clearTimeout(timer);
  }, [done]);
  if (done) return html`<div class="col hub-owner"><div class="s-section-layout"><section class="card hub-company-join hub-join-closing">
    <p role="status">${hj1("closing")}</p>
    ${stayed && view.returnPath ? html`<div class="field-row"><a class="btn btn-sm" href=${view.returnPath} rel="noreferrer">${hj("return")}</a></div>` : null}
  </section></div></div>`;
  return html`<div class="col hub-owner"><div class="s-section-layout"><section class="card hub-company-join">
    ${view === undefined ? html`<${Skeleton} variant="form" lines=${3} label=${hj("loading")} />` : null}
    ${view?.ok ? html`<${CompanyJoinLead} context=${view} />
      ${view.state === "pending" ? !error ? html`<div class="field-row"><button class="btn btn-primary" type="button" disabled=${busy} onClick=${connect}>${hj("connectAs", session.displayName || session.login)}</button></div>` : null : html`<p role="status">${view.state === "acknowledged" ? hj(view.connected ? "done" : "offline") : terminal ? joinError(view.reason || view.state) : hj("approved")}</p>`}
      ${view.issued && terminal && view.state !== "acknowledged" ? html`<p class="note">${hj("issued")}</p>` : null}
      ${view.returnPath ? html`<div class="field-row"><a class="btn btn-sm" href=${view.returnPath} rel="noreferrer">${hj("return")}</a></div>` : null}` : view ? html`<${ErrorState} message=${joinError(view.code)} onRetry=${retry} />` : null}
    ${error ? html`<${ErrorState} message=${error} onRetry=${() => { setError(null); retry(); }} />` : null}
  </section></div></div>`;
}
register("companyJoin", {
  en: { "guide.title": "How colleagues connect", "guide.one": "Copy the colleague connection link here.", "guide.two": "In their Fleet’s Settings → Hub, paste the link and choose {0}.", "guide.three": "Sign in on the Hub and choose Sign in and connect Fleet. Allowed groups need no further approval." },
  "zh-TW": { "guide.title": "同仁如何連接", "guide.one": "在這裡複製含金鑰指紋的連結。", "guide.two": "在自己的 Fleet「設定 → Hub」貼上連結，按「{0}」。", "guide.three": "在 Hub 登入並按「登入並連接 Fleet」。允許的群組不需要另外核准。" },
});
const guide = (key, ...args) => t(`companyJoin.guide.${key}`, ...args);
export const companyJoinAdminEntryV1 = entryWords.companyAdminStringsV1 === true;
export function CompanyJoinAdminCard({ entry = false, groups = false } = {}) {
  const [view, setView] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const live = useRef(true), csrf = useRef(null);
  const [inviteLogin, setInviteLogin] = useState(""), [invitation, setInvitation] = useState(null);
  const [invitationCopied, setInvitationCopied] = useState(false), [features, setFeatures] = useState([]);
  const read = async () => {
    const session = await hubClient().session();
    if (!live.current) return;
    if (!session.ok || !session.admin) { setError(hj("denied")); return; }
    csrf.current = session.csrf; setFeatures(Array.isArray(session.features) ? session.features : []);
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
    if (r.ok) { setInvitation(r.url); setInvitationCopied(false); } else setError(joinError(r.code === "not-found" ? "denied" : r.code));
  };
  // Hub UX U2 (spec 1.2): the 「讓同仁加入」 card — three steps; individual invitations stay, folded, under it.
  if (entry) return html`<${HubJoinCard} view=${view} busy=${busy} error=${error} onToggle=${change} onRetry=${read} groups=${groups} features=${features}>
    ${view?.enabled ? html`<details class="s-ui-disclosure hub-admin-individual"><summary>${hj("inviteTitle")}</summary><div class="s-disclosure-body"><p class="note">${hj("inviteLead")} ${hj("inviteScope")}</p>
      <form class="form" onSubmit=${makeInvitation}><label class="field"><span>${hj("inviteLogin")}</span><input autocomplete="off" value=${inviteLogin} onInput=${e => setInviteLogin(e.target.value)} /></label>
        <div class="field-row"><button class="btn btn-sm" type="submit" disabled=${busy || !!error || !inviteLogin.trim()}>${hj("inviteCreate")}</button></div></form>
      ${invitation ? html`<label class="field"><span>${hj("inviteTitle")}</span><textarea rows="4" readonly value=${invitation} /></label>
        <button type="button" class="btn btn-sm" onClick=${async () => { try { await navigator.clipboard.writeText(invitation); if (live.current) setInvitationCopied(true); } catch { if (live.current) setError(hj("copyFailed")); } }}>${hj(invitationCopied ? "copied" : "inviteCopy")}</button>` : null}</div></details>` : null}
  </${HubJoinCard}>`;
  return html`<section class="card hub-company-join"><h3>${hj("adminTitle")}</h3><p class="note">${hj("adminLead")}</p>
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
