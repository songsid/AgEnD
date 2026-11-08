/** Fleet-only company handoff; all fields live in the actual Settings section and use its shared confirmation card. */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { api, confirmedWrite } from "./settings-confirm.js";
import { hj, joinError, joinResponseCode } from "./hub-company-join-strings.js";
const root = "/api/hub/member/company-join";
export function CompanyJoinSettings({ onSaved, memberEnabled = false } = {}) {
  const notified = useRef(null);
  const waiting = (() => { try { return new URLSearchParams(location.search).get("joinWait"); } catch { return null; } })();
  const [view, setView] = useState(undefined), [error, setError] = useState(null), [busy, setBusy] = useState(false), [pending, setPending] = useState(false), [identityChanged, setIdentityChanged] = useState(false);
  const [bound, setBound] = useState(false);
  const [form, setForm] = useState(() => {
    let address = ""; try { const candidate = new URLSearchParams(location.hash.slice(1)).get("join"); if (candidate && candidate.length <= 8192) address = candidate; } catch {}
    return { address, label: hj("defaultFleet") };
  }), live = useRef(true), token = useRef(0);
  const read = async () => {
    const gen = token.current;
    try { const result = await api(root + (view?.operationId ? `?operationId=${encodeURIComponent(view.operationId)}` : ""));
      if (!live.current || gen !== token.current) return;
      if (!result.ok) { setError(joinError(result.body?.error)); return; }
      setView(result.body.operation ?? null); setBound(result.body.bound === true); setError(null);
    } catch { if (live.current && gen === token.current) setError(hj("unknown")); }
  };
  useEffect(() => { live.current = true; read(); return () => { live.current = false; token.current++; }; }, []);
  useEffect(() => {
    if (!waiting && (!view?.operationId || !["joining", "awaiting-sign-in", "durable"].includes(view.state) && !(view.state === "saved" && view.link !== "online"))) return;
    if (waiting && view?.handoffId === waiting && view.state === "awaiting-sign-in") {
      location.replace(root + "/bridge?operationId=" + encodeURIComponent(view.operationId)); return;
    }
    const timer = setTimeout(read, 1500); return () => clearTimeout(timer);
  }, [view, waiting]);
  useEffect(() => { if (view?.state === "saved" && view.link === "online" && notified.current !== view.operationId) { notified.current = view.operationId; onSaved?.(); } }, [view, onSaved]);
  const start = async e => {
    e.preventDefault(); if (busy) return;
    const gen = ++token.current; setBusy(true); setError(null); setPending(false); setIdentityChanged(false);
    const handoffId = crypto.randomUUID();
    // Open the Fleet-owned waiting page during the user gesture, with no opener or cross-origin messaging.
    globalThis.open("/settings/hub?joinWait=" + encodeURIComponent(handoffId), "_blank", "noopener");
    try {
      const result = await confirmedWrite(root + "/start", { body: { ...form, handoffId }, label: hj("title"), onPending: () => { if (live.current && gen === token.current) setPending(true); } });
      if (!live.current || gen !== token.current) return;
      if (!result.ok || !result.body?.operation) { await read(); const code = joinResponseCode(result); setError(joinError(code)); setIdentityChanged(code === "identity-changed"); return; }
      const operation = result.body.operation; setView(operation); setError(null);

    } catch { if (live.current && gen === token.current) setError(hj("unknown")); }
    finally { if (live.current && gen === token.current) { setBusy(false); setPending(false); } }
  };
  const repair = async () => {
    if (busy) return; const gen = ++token.current; setBusy(true); setError(null);
    try {
      const result = await confirmedWrite(root + "/repair-trust", { body: { address: form.address }, label: hj("repair"), onPending: () => { if (live.current && gen === token.current) setPending(true); } });
      if (!live.current || gen !== token.current) return;
      if (result.ok) { setIdentityChanged(false); setError(null); } else setError(joinError(joinResponseCode(result)));
    } catch { if (live.current && gen === token.current) setError(hj("unknown")); }
    finally { if (live.current && gen === token.current) { setBusy(false); setPending(false); } }
  };
  const action = async step => {
    if (busy || !view?.operationId) return;
    const gen = ++token.current; setBusy(true); setError(null);
    try {
      const options = { body: { operationId: view.operationId }, label: hj("title") };
      const result = step === "resume" ? await confirmedWrite(root + "/resume", options) : await api(root + "/cancel", { method: "POST", body: JSON.stringify(options.body) });
      if (!live.current || gen !== token.current) return;
      if (result.ok) setView(result.body.operation); else setError(joinError(joinResponseCode(result)));
    } catch { if (live.current && gen === token.current) setError(hj("unknown")); }
    finally { if (live.current && gen === token.current) setBusy(false); }
  };
  const canStart = !waiting && (view === null || view && ["ended", "cancelled"].includes(view.state) && !view.issued && view.outcomeKnown);
  // The existing connection card owns ready status, sharing and disconnect. Do not duplicate it after handoff.
  if (!waiting && bound && view === null || view?.state === "saved" && (memberEnabled || view.link === "online") && onSaved) return null;
  return html`<section class="card s-company-join"><h3>${hj("title")}</h3><p class="note">${hj("lead")}</p>
    ${(view === undefined || waiting && view?.handoffId !== waiting) && !error ? html`<${Skeleton} variant="form" lines=${4} label=${hj("loading")} />` : null}
    ${error ? html`<${ErrorState} message=${error} onRetry=${read} />` : null}
    ${pending ? html`<p role="status" class="note">${hj("pending")}</p>` : null}
    ${waiting && view !== undefined && view?.handoffId !== waiting ? html`<p role="status" class="note">${hj("pending")}</p><a class="btn btn-sm" href="/settings/hub">${hj("return")}</a>` : null}
    ${canStart ? html`<form class="form" onSubmit=${start}>
      <label class="field" for="hubCompanyAddress"><span>${hj("address")}</span><input id="hubCompanyAddress" type="text" value=${form.address} autocomplete="off" spellcheck=${false} onInput=${e => setForm(f => ({ ...f, address: e.target.value }))} /><small class="note">${hj("addressHint")}</small></label>
      <label class="field" for="hubCompanyFleetName"><span>${hj("fleetName")}</span><input id="hubCompanyFleetName" value=${form.label} maxlength="120" onInput=${e => setForm(f => ({ ...f, label: e.target.value }))} /></label>
      <p class="note">${hj("firstUse")}</p><div class="field-row"><button class="btn btn-primary" type="submit" disabled=${busy || !form.address.trim() || !form.label.trim()}>${hj("start")}</button></div>
      ${identityChanged ? html`<p class="note">${hj("repairLead")}</p><button class="btn btn-sm" type="button" disabled=${busy || !form.address.trim()} onClick=${repair}>${hj("repair")}</button>` : null}
    </form>` : null}
    ${view && (!waiting || view.handoffId === waiting) ? html`<div role="status"><strong>${hj(view.state === "saved" ? view.link === "online" ? "saved" : "joining" : view.state === "awaiting-sign-in" ? "awaiting" : view.state === "cancelled" ? "cancelled" : view.state === "held" || view.state === "ended" ? "held" : "joining")}</strong>
      ${view.state === "saved" ? html`<p class="note">${hj(view.link === "online" ? "fleetDone" : "offline")}</p>` : view.reason && view.reason !== "cancelled" ? html`<p class="note">${joinError(view.reason)}</p>` : null}
      ${view.issued && view.state !== "saved" ? html`<p class="note">${hj("issued")}</p>` : null}
      <div class="field-row">${view.state === "awaiting-sign-in" ? html`<a class="btn btn-sm" href=${root + "/bridge?operationId=" + encodeURIComponent(view.operationId)} target="_blank" rel="noopener">${hj("start")}</a>` : null}${view.state === "held" && !["authority", "expired"].includes(view.reason) ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => action("resume")}>${hj("resume")}</button>` : null}
        ${!["saved", "cancelled", "ended"].includes(view.state) ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => action("cancel")}>${hj("stop")}</button>` : null}
        ${view.hubOrigin ? html`<a class="btn btn-sm" href=${view.hubOrigin + "/ui/hub"} target="_blank" rel="noopener noreferrer">${hj("inspect")}</a>` : null}</div>
    </div>` : null}
  </section>`;
}
