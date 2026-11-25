// Shared, explicit contact-only scope editor. Identity/room/target are frozen from the ticket or existing row.
import { html, useState } from "/assets/app-html.js";
import { Dialog } from "/assets/ui-dialog.js";
import { ca, contactPlatformLabel, contactPersonLabel, contactWhen } from "./contact-auth-strings.js";
import { personKey } from "./contact-auth-client.js";
export const CONTACT_VERBS = ["send_to_instance", "delegate_task", "request_information", "broadcast", "report_result"];
const localTime = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const afterDays = days => localTime(new Date(Date.now() + days * 86400000));
// `keyOf` (M-3736 J): how a person is selected — the same-card contract's server-owned candidate key; by default the
// person's own [platform, userId] key, as before.
export function ContactGrantEditor({ people, source, target, verb, grant = null, onSave, onClose, keyOf = personKey }) {
  const [selected, setSelected] = useState(() => grant ? [personKey(grant.person)] : people.length === 1 ? [keyOf(people[0])] : []);
  const [preset, setPreset] = useState(grant ? "custom" : "7");
  const [until, setUntil] = useState(() => grant ? localTime(new Date(grant.expiresAt)) : afterDays(7));
  const [uses, setUses] = useState(grant?.remainingUses == null ? "" : String(grant.remainingUses));
  const [verbs, setVerbs] = useState(() => grant ? [...grant.verbs] : [verb]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const validUntil = Number.isFinite(new Date(until).getTime()) && new Date(until).getTime() > Date.now();
  const validUses = uses === "" || /^\d+$/.test(uses) && Number(uses) >= 1 && Number(uses) <= 10000;
  const valid = selected.length > 0 && verbs.length > 0 && validUntil && validUses;
  const save = async () => {
    if (busy || !valid) return;
    setBusy(true); setError("");
    try {
      const ok = await onSave({ personKeys: selected, expiresAt: new Date(until).toISOString(), remainingUses: uses === "" ? null : Number(uses), verbs });
      if (ok) onClose(); else setError(ca("grantSaveFailed"));
    } catch { setError(ca("grantSaveFailed")); }
    finally { setBusy(false); }
  };
  const toggle = (values, value, checked) => checked ? [...values, value] : values.filter(v => v !== value);
  return html`<${Dialog} title=${ca(grant ? "grantEdit" : people.length === 1 ? "allowPersonTitle" : "allowPeopleTitle")} busy=${busy} cls="contact-grant-dialog" onClose=${onClose}
    actions=${html`<button type="button" class="btn" disabled=${busy} onClick=${onClose}>${ca("cancel")}</button><button type="button" class="btn btn-primary" disabled=${busy || !valid} onClick=${save}>${ca(busy ? "saving" : grant ? "grantSave" : "allowAndApprove")}</button>`}>
    <p>${ca("grantRoute", source, target)}</p>
    <section class="s-group" aria-label=${ca("grantPeople")}><h3>${ca("grantPeople")}</h3><div class="s-checks">
      ${people.map(person => html`<label class="check"><input type="checkbox" checked=${selected.includes(keyOf(person))} disabled=${busy || !!grant}
        onChange=${e => setSelected(toggle(selected, keyOf(person), e.currentTarget.checked))} /><span>${contactPersonLabel(person)} · ${contactPlatformLabel(person.platform)}</span></label>`)}
    </div></section>
    ${!grant && people.length > 1 ? html`<p class="note">${ca("grantAllOrigins")}</p>` : null}
    ${grant ? html`<section class="s-group" aria-label=${ca("grantTypes")}><h3>${ca("grantTypes")}</h3><div class="s-checks">${CONTACT_VERBS.map(v => html`<label class="check"><input type="checkbox" checked=${verbs.includes(v)} disabled=${busy}
      onChange=${e => setVerbs(toggle(verbs, v, e.currentTarget.checked))} /><span>${ca(`verb_${v}`)}</span></label>`)}</div></section>` : html`<p>${ca("grantType", ca(`verb_${verb}`))}</p>`}
    <div class="grid2"><label class="field"><span>${ca("grantDuration")}</span><select class="input" value=${preset} disabled=${busy} onChange=${e => { const value = e.currentTarget.value; setPreset(value); if (value !== "custom") setUntil(afterDays(Number(value))); }}>
      ${[1, 7, 30].map(n => html`<option value=${String(n)}>${n === 1 ? ca("grantOneDay") : ca("grantDays", n)}</option>`)}<option value="custom">${ca("grantCustom")}</option></select></label>
      <label class="field"><span>${ca("alsoAllowUntil")}</span><input class="input" type="datetime-local" value=${until} disabled=${busy} onInput=${e => { setPreset("custom"); setUntil(e.currentTarget.value); }} /></label></div>
    ${validUntil ? html`<p class="note contact-grant-expiry">${ca("grantExpires", contactWhen(until))}</p>` : null}
    <p class="note">${ca("grantZone", Intl.DateTimeFormat().resolvedOptions().timeZone)}</p>
    <details open=${grant?.remainingUses === 0}><summary>${ca("grantAdvanced")}</summary><label class="field"><span>${ca("alsoAllowUses")}</span><input class="input" type="number" min="1" max="10000" inputmode="numeric" value=${uses} disabled=${busy} onInput=${e => setUses(e.currentTarget.value)} /></label></details>
    ${!validUntil ? html`<p class="err">${ca("grantFutureExpiry")}</p>` : !validUses ? html`<p class="err">${ca("grantValidUses")}</p>` : null}
    <p class="note">${ca("grantBoundary")}</p>
    ${grant ? html`<p class="note">${ca("grantEditScope")}</p>` : null}
    ${error ? html`<p class="err" role="alert">${error}</p>` : null}
  </${Dialog}>`;
}
