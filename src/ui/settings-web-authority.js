// #1939 S2a: Settings → Web → Web authority — whether a signed-in admin's web messages carry their account's authority
// in delivery receipts (docs/design/1939-verified-web-sessions.md §0, §0.1, §3, §10): the server switch (on by default),
// "Only this computer can authorize", how long a session's authorization lasts, the sessions authorized now, and "Revoke
// web authority". Changes go through Review changes → Apply like every Settings edit, and apply at once (§0.1: none of
// them grants anything by itself — a session still needs its account's Confirm in Discord or Telegram).
import { html, useEffect, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { useTypedText } from "/assets/text-undo.js";
import { toast } from "/assets/ui-toast.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { api } from "./settings-confirm.js";
import { Feedback } from "./settings-dialogs.js";
import { resetWebAuthorization } from "/assets/web-authorize.js";
import "./settings-strings.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);

/** What changed against what fleet.yaml says, as the PUT /api/settings/fleet/web body's `verified_authority` (null: nothing). */
export function verifiedAuthorityBody(original, f) {
  const out = {};
  if (f.enabled !== original.enabled) out.enabled = f.enabled ? null : false;                   // §0.1: on is the default
  if (f.loopbackOnly !== original.loopbackOnly) out.loopback_only = f.loopbackOnly ? true : null;
  if (f.hours !== original.hours) out.max_session_hours = f.hours === null ? null : f.hours;
  return Object.keys(out).length ? out : null;
}

export function WebAuthorityCard({ ctx, staged, disabled = false }) {
  const [overview, setOverview] = useState(null), [failed, setFailed] = useState(false);
  const [original, setOriginal] = useState(null), [f, setF] = useState(null), [msg, setMsg] = useState(null);
  // #2342: the hours box keeps what was typed ("01", "1.50"; its undo history); the form gets the number.
  const [hoursText, onHoursText] = useTypedText(f ? f.hours : null, (v) => (v.trim() === "" ? null : Number(v)));
  const load = async () => {
    // What changes here (a revoke, the switch) changes this browser's own line: the chat reads it again when it shows.
    resetWebAuthorization();
    let r = null;
    try { r = await api("/api/settings/web-authority"); } catch { r = null; }
    // Anything but the overview's shape (an older server, an error page) is "could not be loaded", never a crash.
    const o = r && r.ok ? r.body : null;
    if (!o || typeof o !== "object" || !o.state || !o.hours || !Array.isArray(o.lanHosts) || !Array.isArray(o.authorized)) { setFailed(true); return; }
    const c = o.configured || {};
    const orig = { enabled: c.enabled !== false, loopbackOnly: c.loopback_only === true, hours: typeof c.max_session_hours === "number" ? c.max_session_hours : null };
    setOverview(o); setFailed(false);
    setOriginal((prev) => prev || orig);
    setF((prev) => prev || { ...orig });
  };
  useEffect(() => { load(); }, []);
  const card = (body) => html`<section class="card s-web-authority"><h3>${tn("vaTitle")}</h3><p class="note">${tn("vaHint")}</p>${body}</section>`;
  if (failed) return card(html`<p class="note" role="status">${tn("vaLoadFailed")} <button type="button" class="btn btn-sm" onClick=${load}>${t("app.retry")}</button></p>`);
  if (!overview || !f) return card(html`<p class="note">${t("app.loading")}</p>`);

  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const hoursError = f.hours !== null && (!Number.isFinite(f.hours) || f.hours < overview.hours.min || f.hours > overview.hours.max) ? "vaHoursRange" : "";
  const stuckOff = f.enabled && original.enabled && !overview.state.enabled;
  const warnHosts = !f.loopbackOnly && overview.lanHosts.length > 0;
  const when = (ms) => new Date(ms).toLocaleString();

  const review = () => {
    if (hoursError) return;
    const body = verifiedAuthorityBody(original, f);
    if (body) ctx.stage("verified_authority", { label: tn("vaTitle"), impact: "now", request: { method: "PUT", url: "/api/settings/fleet/web", body: { verified_authority: body } } });
    else if (staged.has("verified_authority")) ctx.unstage("verified_authority");
    setMsg(tn("readyApply"));
  };
  const revoke = async () => {
    const yes = await confirmDialog({ title: tn("vaRevokeTitle"), message: tn("vaRevokeConfirm"), confirmLabel: tn("vaRevoke"), danger: true });
    if (!yes) return;
    let r = null;
    try { r = await api("/api/settings/web-authority/revoke", { method: "POST", body: "{}" }); } catch { r = null; }
    if (r && r.ok) { toast(tn(r.body && r.body.durable === false ? "vaRevokedNotDurable" : "vaRevoked")); load(); }
    else toast(tn("vaRevokeFailed"), false);
  };

  return card(html`<fieldset class="s-va-fields" disabled=${disabled}>
      ${stuckOff ? html`<p class="note s-va-warn" role="status" id="vaStuckOff">${tn("vaStuckOff")}</p>` : null}
      <label class="check"><input id="vaEnabled" type="checkbox" checked=${f.enabled} onChange=${(e) => set({ enabled: e.target.checked })} /><span>${tn("vaEnabled")}</span></label>
      <p class="note">${tn("vaEnabledHint")}</p>
      <label class="check"><input id="vaLoopbackOnly" type="checkbox" checked=${f.loopbackOnly} onChange=${(e) => set({ loopbackOnly: e.target.checked })} /><span>${tn("vaLoopbackOnly")}</span></label>
      <p class="note">${tn("vaLoopbackOnlyHint")}</p>
      ${warnHosts ? html`<p class="note s-va-warn" role="status" id="vaLanWarning">${tn("vaLanWarning", overview.lanHosts.join(", "))}</p>` : null}
      <div class="field"><label for="vaHours">${tn("vaHours", overview.hours.min, overview.hours.max)}</label>
        <input id="vaHours" type="number" min=${overview.hours.min} max=${overview.hours.max} step="any" placeholder=${tn("defaultHours", overview.hours.default)}
          class=${hoursError ? "invalid" : ""} value=${hoursText} onInput=${(e) => set({ hours: onHoursText(e.target.value) })} />
        <${Feedback} error=${hoursError} /></div>
      <h4>${tn("vaSessionsTitle")}</h4>
      ${overview.authorized.length
        ? html`<ul class="s-va-sessions" id="vaSessions">${overview.authorized.map((a) => html`<li key=${a.handle} data-handle=${a.handle}>
            <strong>${a.label}</strong> <span class="note">${a.account}</span><br /><span class="note">${tn("vaSessionUntil", when(a.authorizedAt), when(a.until))}</span></li>`)}</ul>`
        : html`<p class="note" id="vaSessionsNone">${tn("vaSessionsNone")}</p>`}
    </fieldset>
    <div class="save-row"><button type="button" class="btn btn-primary" id="vaReview" disabled=${disabled || !!hoursError} onClick=${review}>${tn("vaReview")}</button>
      <button type="button" class="btn btn-danger" id="vaRevoke" disabled=${disabled} onClick=${revoke}>${tn("vaRevoke")}</button>
      ${msg ? html`<span class="note" role="status">${msg}</span>` : null}</div>`);
}
