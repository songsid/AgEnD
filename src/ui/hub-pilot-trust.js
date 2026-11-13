/** Optional probe data: old hosts keep their existing certificate message. */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { api, confirmedWrite } from "./settings-confirm.js";
import { pt } from "./hub-pilot-trust-strings.js";
export const pilotTrustV1 = true;
export function pilotTrustCandidate(probe) {
  const trust = probe?.ok === false && probe.reason === "certificate" && probe.selfSigned === true ? probe.trust : null;
  return trust && /^[a-f0-9]{64}$/.test(trust.fingerprint) && (trust.previous === null || /^[a-f0-9]{64}$/.test(trust.previous)) ? trust : null;
}
export function PilotTrustPrompt({ trust, host, busy, onTrust, onCancel }) {
  const [full, setFull] = useState(false), changed = trust.previous !== null;
  const fingerprint = trust.fingerprint.match(/.{2}/g).join(":");
  return html`<div class="form hub-pilot-trust" role="group" aria-labelledby="hubPilotTrustTitle">
    <strong id="hubPilotTrustTitle">${pt("title")}</strong>
    <p class="note">${pt(changed ? "changed" : "body", host)}</p>
    <div class="field"><span>${pt("fingerprint")}</span><code>${(full ? fingerprint : fingerprint.slice(0, 23) + "…" + fingerprint.slice(-11)).split(":").map((part, i) => html`${i ? ":" : ""}<wbr />${part}`)}</code>
      ${!full ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => setFull(true)}>${pt("full")}</button>` : null}</div>
    <div class="field-row"><button type="button" class="btn btn-primary" disabled=${busy} onClick=${onTrust}>${pt(changed ? "again" : "trust")}</button>
      <button type="button" class="btn" disabled=${busy} onClick=${onCancel}>${pt("cancel")}</button></div>
  </div>`;
}
export function HubPilotTrustSettings({ onChanged }) {
  const [enabled, setEnabled] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(false), [pending, setPending] = useState(false), live = useRef(true);
  const path = "/api/settings/hub/pilot-trust";
  const read = async () => { const r = await api(path); if (live.current && r.ok && typeof r.body?.enabled === "boolean") setEnabled(r.body.enabled); };
  useEffect(() => { live.current = true; read().catch(() => {}); return () => { live.current = false; }; }, []);
  const change = async value => {
    if (busy) return; setBusy(true); setError(false); setPending(false);
    try {
      const r = await confirmedWrite(path, { method: "PUT", body: { enabled: value }, label: pt("setting"), onPending: () => { if (live.current) setPending(true); } });
      if (!live.current) return;
      if (!r.ok) { setError(true); return; }
      await read(); if (live.current) { setPending(false); onChanged?.(); }
    } catch { if (live.current) setError(true); }
    finally { if (live.current) setBusy(false); }
  };
  if (enabled === null) return null;
  return html`<div class="form hub-pilot-trust-setting"><label class="check"><input type="checkbox" role="switch" checked=${enabled} disabled=${busy} onChange=${e => change(e.target.checked)} /><span>${pt("setting")}</span></label>
    <p class="note">${pt("hint")}</p>${pending ? html`<p class="note" role="status">${pt("pending")}</p>` : null}
    ${error ? html`<p class="note" role="alert">${pt("failed")}</p>` : null}</div>`;
}
