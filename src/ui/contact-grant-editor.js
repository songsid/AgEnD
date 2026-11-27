// Shared, explicit contact-only scope editor. Identity/room/target are frozen from the ticket or existing row.
import { html, useState } from "/assets/app-html.js";
import { Dialog } from "/assets/ui-dialog.js";
import { ca, contactPlatformLabel, contactPersonLabel, contactWhen } from "./contact-auth-strings.js";
import { lang, register, t } from "/assets/app-i18n.js";
import { dateTimeText } from "/assets/clock-text.js";
import { personKey } from "./contact-auth-client.js";
export const CONTACT_VERBS = ["send_to_instance", "delegate_task", "request_information", "broadcast", "report_result"];

// M-3783: this editor's own words, in its own namespace (#4581 review): a tab that still holds an older
// contact-auth-strings.js reads them all the same, and an older editor keeps the shared, unchanged grantBoundary.
register("cgrant", {
  en: {
    boundary: "Until it expires, these people's requests of this type are forwarded to this agent without asking.",
    moreTitle: "What this allows",
    boundaryMore: "Only from this source to this agent, for this request type. It only decides whether a message is forwarded; what the receiving agent does with it still follows that agent's own permissions. To undo it, remove the rule in the agent's Permissions.",
    allOrigins: "Several people's words are in this conversation: tick each person the rule is for.",
    allOriginsMore: "A later request skips approval only when every person whose words it carries has a matching rule.",
  },
  "zh-TW": {
    boundary: "到期前，這些人的這類請求會直接轉交給這個 Agent，不再詢問。",
    moreTitle: "這會允許什麼",
    boundaryMore: "只限從這個來源發給這個 Agent、這個請求類型。這只決定訊息能不能轉交；接收的 Agent 收到後要做什麼，仍照它自己的權限。要撤銷，到這個 Agent 的「權限」移除規則。",
    allOrigins: "這個對話裡有多人的話：請勾選這條規則適用的每個人。",
    allOriginsMore: "之後的請求，只有在它帶有的每個人都有符合的規則時，才會直接轉交。",
  },
});
const cg = (key) => t(`cgrant.${key}`);
const localTime = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const afterDays = days => localTime(new Date(Date.now() + days * 86400000));
const pad2 = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/**
 * The expiry as a day and a 24-hour time from selects (#4497 capture check; M-3730: no native date/time input, whose
 * format follows the browser, not the page — 12/03/2026, 07:40 AM on a zh-TW page). `value` is local "YYYY-MM-DDTHH:MM".
 */
function UntilPicker({ value, disabled, onChange }) {
  const [day = "", hm = ""] = String(value || "").split("T");
  const [hh = "00", mm = "00"] = hm.split(":");
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 91 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return ymd(d); });
  if (day && !days.includes(day)) days.push(day);
  days.sort();
  const zh = lang() === "zh-TW";
  const dayLabel = v => { const [y, m, d] = v.split("-").map(Number); return dateTimeText(new Date(y, m - 1, d), { weekday: "short", year: "numeric", month: "short", day: "numeric" }, zh ? "zh-TW" : "en"); };
  const minutes = ["00", "15", "30", "45"]; if (!minutes.includes(mm)) minutes.push(mm); minutes.sort();
  const set = (d, h, m) => onChange(`${d}T${h}:${m}`);
  return html`<span class="contact-until">
    <select class="input" aria-label=${ca("untilDay")} value=${day} disabled=${disabled} onChange=${e => set(e.currentTarget.value, hh, mm)}>${days.map(v => html`<option value=${v}>${dayLabel(v)}</option>`)}</select>
    <span class="contact-until-time"><select class="input" aria-label=${ca("untilHour")} value=${hh} disabled=${disabled} onChange=${e => set(day, e.currentTarget.value, mm)}>${Array.from({ length: 24 }, (_, i) => pad2(i)).map(v => html`<option value=${v}>${v}</option>`)}</select>
    <span aria-hidden="true">:</span>
    <select class="input" aria-label=${ca("untilMinute")} value=${mm} disabled=${disabled} onChange=${e => set(day, hh, e.currentTarget.value)}>${minutes.map(v => html`<option value=${v}>${v}</option>`)}</select></span>
  </span>`;
}
// `keyOf` (M-3736 J): how a person is selected — the same-card contract's server-owned candidate key; by default the
// person's own [platform, userId] key, as before.
export function ContactGrantEditor({ people, source, target, verb, grant = null, onSave, onClose, keyOf = personKey, title = "" }) {
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
  return html`<${Dialog} title=${title || ca(grant ? "grantEdit" : people.length === 1 ? "allowPersonTitle" : "allowPeopleTitle")} busy=${busy} cls="contact-grant-dialog" onClose=${onClose}
    actions=${html`<button type="button" class="btn" disabled=${busy} onClick=${onClose}>${ca("cancel")}</button><button type="button" class="btn btn-primary" disabled=${busy || !valid} onClick=${save}>${ca(busy ? "saving" : grant ? "grantSave" : "allowAndApprove")}</button>`}>
    <p>${ca("grantRoute", source, target)}</p>
    <p class="note contact-grant-boundary">${cg("boundary")}</p>
    <details class="contact-grant-more"><summary>${cg("moreTitle")}</summary><p class="note">${cg("boundaryMore")}</p>
      ${!grant && people.length > 1 ? html`<p class="note">${cg("allOriginsMore")}</p>` : null}</details>
    <section class="s-group" aria-label=${ca("grantPeople")}><h3>${ca("grantPeople")}</h3><div class="s-checks">
      ${people.map(person => html`<label class="check"><input type="checkbox" checked=${selected.includes(keyOf(person))} disabled=${busy || !!grant}
        onChange=${e => setSelected(toggle(selected, keyOf(person), e.currentTarget.checked))} /><span>${contactPersonLabel(person)} · ${contactPlatformLabel(person.platform)}</span></label>`)}
    </div></section>
    ${!grant && !selected.length ? html`<p class="note contact-grant-pick">${ca("grantPickSomeone")}</p>` : null}
    ${!grant && people.length > 1 ? html`<p class="note">${cg("allOrigins")}</p>` : null}
    ${grant ? html`<section class="s-group" aria-label=${ca("grantTypes")}><h3>${ca("grantTypes")}</h3><div class="s-checks">${CONTACT_VERBS.map(v => html`<label class="check"><input type="checkbox" checked=${verbs.includes(v)} disabled=${busy}
      onChange=${e => setVerbs(toggle(verbs, v, e.currentTarget.checked))} /><span>${ca(`verb_${v}`)}</span></label>`)}</div></section>` : html`<p>${ca("grantType", ca(`verb_${verb}`))}</p>`}
    <div class="contact-grant-when"><label class="field"><span>${ca("grantDuration")}</span><select class="input" value=${preset} disabled=${busy} onChange=${e => { const value = e.currentTarget.value; setPreset(value); if (value !== "custom") setUntil(afterDays(Number(value))); }}>
      ${[1, 7, 30].map(n => html`<option value=${String(n)}>${n === 1 ? ca("grantOneDay") : ca("grantDays", n)}</option>`)}<option value="custom">${ca("grantCustom")}</option></select></label>
      <div class="field"><span>${ca("alsoAllowUntil")}</span><${UntilPicker} value=${until} disabled=${busy} onChange=${v => { setPreset("custom"); setUntil(v); }} /></div></div>
    ${validUntil ? html`<p class="note contact-grant-expiry">${ca("grantExpires", contactWhen(until))}</p>` : null}
    <p class="note">${ca("grantZone", Intl.DateTimeFormat().resolvedOptions().timeZone)}</p>
    <details open=${grant?.remainingUses === 0}><summary>${ca("grantAdvanced")}</summary><label class="field"><span>${ca("alsoAllowUses")}</span><input class="input" type="number" min="1" max="10000" inputmode="numeric" value=${uses} disabled=${busy} onInput=${e => setUses(e.currentTarget.value)} /></label></details>
    ${!validUntil ? html`<p class="err">${ca("grantFutureExpiry")}</p>` : !validUses ? html`<p class="err">${ca("grantValidUses")}</p>` : null}
    ${grant ? html`<p class="note">${ca("grantEditScope")}</p>` : null}
    ${error ? html`<p class="err" role="alert">${error}</p>` : null}
  </${Dialog}>`;
}
