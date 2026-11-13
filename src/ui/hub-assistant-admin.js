import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { hroom } from "./hub-room-strings.js";
import { ha } from "./hub-assistant-admin-strings.js";

const fields = value => ({ enabled: value.enabled === true, backend: value.backend, account: value.account ?? null, cap: Number(value.cap), idleMinutes: Number(value.idleMinutes) });
const validLimits = value => Number.isInteger(Number(value?.cap)) && Number(value.cap) >= 1 && Number(value.cap) <= 16 && Number.isInteger(Number(value?.idleMinutes)) && Number(value.idleMinutes) >= 1 && Number(value.idleMinutes) <= 240;
const accountWord = row => row.state === "signed-in" ? hroom("signedIn") : row.state === "needs-sign-in" ? hroom("needsSignIn") : ha("unknown");
const stateWord = state => state === "idle" ? hroom("stIdle") : state === "working" ? hroom("stWorking") : ha(["starting", "stopping", "failed"].includes(state) ? state : "unknown");
const quotaWord = band => band === "available" ? hroom("quotaPlenty") : band === "near_limit" ? hroom("quotaLow") : band === "exhausted" ? hroom("quotaGone") : ha("unknown");

/** Hub-only admin cards; the existing client owns same-origin session/CSRF. No Fleet endpoint is called. */
export function HubAssistantAdmin({ client }) {
  const [view, setView] = useState(null), [form, setForm] = useState(null), [usage, setUsage] = useState(null);
  const [error, setError] = useState(null), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const generation = useRef(0);
  const load = async (replaceForm = true) => {
    const mine = ++generation.current;
    const results = await Promise.allSettled([Promise.resolve().then(() => client.assistantSettings()), Promise.resolve().then(() => client.assistantUsage())]);
    const settings = results[0].status === "fulfilled" ? results[0].value : { ok: false };
    const counts = results[1].status === "fulfilled" ? results[1].value : { ok: false };
    if (mine !== generation.current) return;
    if (!settings?.ok) { setError(ha("loadFailed")); return; }
    setView(settings); setForm(value => replaceForm || value === null ? fields(settings) : value); setUsage(counts?.ok ? counts : { ok: false }); setError(null);
  };
  useEffect(() => { setBusy(false); setView(null); setForm(null); void load(); return () => { generation.current++; }; }, [client]);
  const edit = patch => { setSaved(false); setForm(value => ({ ...value, ...patch })); };
  const save = async event => {
    event.preventDefault(); if (busy || !validLimits(form)) return;
    setBusy(true); setError(null); setSaved(false);
    const mine = generation.current;
    let result;
    try { result = await client.saveAssistantSettings(fields(form)); } catch { result = { ok: false }; }
    if (mine !== generation.current) return;
    setBusy(false);
    if (!result?.ok) { setError(ha("saveFailed")); return; }
    setView(result); setForm(fields(result)); setSaved(true);
  };
  const stop = async roomId => {
    if (busy) return; setBusy(true); setError(null);
    const mine = generation.current;
    let result, latest;
    try { result = await client.stopRoomAssistant(roomId); } catch { result = { ok: false }; }
    if (result?.ok) { try { latest = await client.assistantSettings(); } catch { latest = { ok: false }; } }
    if (mine !== generation.current) return;
    setBusy(false);
    if (!result?.ok) { setError(ha("stopFailed")); return; }
    if (!latest?.ok) {
      setView(value => ({ ...value, running: value.running.filter(row => row.roomId !== roomId) }));
      setError(ha("stoppedRefreshFailed")); return;
    }
    setView(latest); // a status refresh must not discard unsaved settings
  };
  if (!view) return html`<section class="card" aria-label=${hroom("roomAssistant")}><h3>${hroom("roomAssistant")}</h3>${error
    ? html`<${ErrorState} message=${error} onRetry=${() => load(false)} />` : html`<${Skeleton} variant="rows" lines=${3} />`}</section>`;
  const backends = Array.isArray(view.backends) ? view.backends : [], backend = backends.find(row => row.id === form.backend);
  const accounts = backend?.accounts || [], selected = accounts.find(row => row.id === form.account);
  const canEnable = accounts.some(row => row.state !== "needs-sign-in"), running = Array.isArray(view.running) ? view.running : [];
  return html`<section class="card" aria-label=${hroom("roomAssistant")}><h3>${hroom("roomAssistant")}</h3>
    ${!view.enabled ? html`<p class="note">${hroom("assistantNotEnabled")}</p>` : null}
    ${!backends.length ? html`<${Empty} title=${hroom("assistantNotEnabled")} hint=${hroom("assistantEnableHint")} />` : null}
    <form class="form" onSubmit=${save}>
      <label class="s-row"><span>${hroom("enableAssistant")}</span><input class="s-ui-toggle" type="checkbox" role="switch" aria-label=${hroom("enableAssistant")} checked=${form.enabled} disabled=${busy || !canEnable && !form.enabled} onChange=${e => edit({ enabled: e.target.checked })} /></label>
      <div class="s-group"><h4>${hroom("aiAccount")}</h4><div class="grid2">
        <label class="field"><span>${ha("backend")}</span><select aria-label=${ha("backend")} value=${form.backend} disabled=${busy || !backends.length} onChange=${e => edit({ backend: e.target.value, account: null })}>
          ${backends.map(row => html`<option key=${row.id} value=${row.id}>${row.name}</option>`)}</select></label>
        <label class="field"><span>${ha("account")}</span><select aria-label=${ha("account")} value=${form.account ?? ""} disabled=${busy || !accounts.length} onChange=${e => edit({ account: e.target.value || null })}>
          ${accounts.map(row => html`<option key=${row.id ?? "default"} value=${row.id ?? ""} disabled=${row.state === "needs-sign-in"}>${row.id === null ? ha("defaultAccount") : row.name} · ${accountWord(row)}</option>`)}</select></label>
      </div><p class="note">${selected ? accountWord(selected) : ha("unknown")} · ${hroom("signInHow")}</p><p class="note">${hroom("assistantQuota")}</p></div>
      <div class="grid2"><label class="field"><span>${hroom("cap")}</span><input aria-label=${hroom("cap")} type="number" inputmode="numeric" min="1" max="16" step="1" required value=${form.cap} disabled=${busy} onInput=${e => edit({ cap: e.target.value })} /></label>
        <label class="field"><span>${hroom("idleMinutes")}</span><input aria-label=${hroom("idleMinutes")} type="number" inputmode="numeric" min="1" max="240" step="1" required value=${form.idleMinutes} disabled=${busy} onInput=${e => edit({ idleMinutes: e.target.value })} /></label></div>
      ${error ? html`<p class="err" role="alert">${error}</p>` : null}${saved ? html`<p class="note" role="status">${ha("saved")}</p>` : null}
      <div class="field-row"><button type="submit" class="btn btn-primary" disabled=${busy || !validLimits(form) || form.enabled && !selected}>${ha("save")}</button></div>
    </form>
  </section>
  <section class="card" aria-label=${hroom("runningNow")}><div class="hub-card-head"><h3>${hroom("runningNow")}</h3><button type="button" class="btn btn-sm btn-ghost" disabled=${busy} onClick=${() => load(false)}>${ha("refresh")}</button></div>
    ${running.length ? html`<div class="hub-rows">${running.map(row => html`<div class="s-row hub-row" key=${row.roomId}><span class="hub-row-text"><strong title=${row.roomName}>${row.roomName}</strong><small class="note">${hroom("lastUsed")} · ${new Date(row.lastUsed).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short", hour12: false })}</small></span>
      <span class=${`tag ${row.state === "failed" ? "warn" : ""}`}>${stateWord(row.state)}</span><button type="button" class="btn btn-sm" disabled=${busy || row.state === "stopping"} onClick=${() => stop(row.roomId)}>${hroom("stop")}</button></div>`)}</div>` : html`<p class="note">${ha("noneRunning")}</p>`}
  </section>
  <section class="card" aria-label=${hroom("usage")}><h3>${hroom("usage")}</h3><p class="note">${hroom("usageLead")}</p>
    ${usage?.ok ? html`<div class="hub-rows">${usage.days.map(row => html`<div class="s-row" key=${row.day}><span>${row.day} UTC</span><strong>${row.count}</strong></div>`)}</div><p>${hroom("aiAccount")} · <span class="tag">${quotaWord(usage.quota?.band)}</span></p>
      ${usage.note === "usage-not-saved" ? html`<p class="note" role="status">${ha("usageNotSaved")}</p>` : null}` : html`<${ErrorState} message=${ha("usageFailed")} onRetry=${() => load(false)} />`}
  </section>`;
}
