/** Fleet-only company handoff; all fields live in the actual Settings section and use its shared confirmation card. */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { api, confirmedWrite } from "./settings-confirm.js";
import { hj, joinError } from "./hub-company-join-strings.js";
const root = "/api/hub/member/company-join";
export function CompanyJoinSettings() {
  const [view, setView] = useState(undefined), [error, setError] = useState(null), [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ address: "", label: hj("defaultFleet") }), live = useRef(true), token = useRef(0);
  const read = async () => {
    const gen = token.current;
    try { const result = await api(root + (view?.operationId ? `?operationId=${encodeURIComponent(view.operationId)}` : ""));
      if (!live.current || gen !== token.current) return;
      if (!result.ok) { setError(joinError(result.body?.error)); return; }
      setView(result.body.operation ?? null); setError(null);
    } catch { if (live.current && gen === token.current) setError(hj("unknown")); }
  };
  useEffect(() => { live.current = true; read(); return () => { live.current = false; token.current++; }; }, []);
  useEffect(() => {
    if (!view?.operationId || !["joining", "awaiting-sign-in", "durable"].includes(view.state)) return;
    const timer = setTimeout(read, 1500); return () => clearTimeout(timer);
  }, [view]);
  const start = async e => {
    e.preventDefault(); if (busy) return;
    const gen = ++token.current; setBusy(true); setError(null);
    try {
      const result = await confirmedWrite(root + "/start", { body: form, label: hj("title"), onPending: () => { if (live.current && gen === token.current) setError(hj("pending")); } });
      if (!live.current || gen !== token.current) return;
      if (!result.ok || !result.body?.operation) { await read(); setError(joinError(result.body?.error)); return; }
      const operation = result.body.operation; setView(operation); setError(null);
      if (operation.state === "awaiting-sign-in") location.assign(root + "/bridge?operationId=" + encodeURIComponent(operation.operationId));
    } catch { if (live.current && gen === token.current) setError(hj("unknown")); }
    finally { if (live.current && gen === token.current) setBusy(false); }
  };
  const action = async step => {
    if (busy || !view?.operationId) return;
    const gen = ++token.current; setBusy(true); setError(null);
    try {
      const options = { body: { operationId: view.operationId }, label: hj("title") };
      const result = step === "resume" ? await confirmedWrite(root + "/resume", options) : await api(root + "/cancel", { method: "POST", body: JSON.stringify(options.body) });
      if (!live.current || gen !== token.current) return;
      if (result.ok) setView(result.body.operation); else setError(joinError(result.body?.error));
    } catch { if (live.current && gen === token.current) setError(hj("unknown")); }
    finally { if (live.current && gen === token.current) setBusy(false); }
  };
  const canStart = view === null || view && ["ended", "cancelled"].includes(view.state) && !view.issued && view.outcomeKnown;
  return html`<section class="card"><h3>${hj("title")}</h3><p class="note">${hj("lead")}</p>
    ${view === undefined && !error ? html`<${Skeleton} variant="form" lines=${4} label=${hj("loading")} />` : null}
    ${error ? html`<${ErrorState} message=${error} onRetry=${read} />` : null}
    ${canStart ? html`<form class="form" onSubmit=${start}>
      <label class="field" for="hubCompanyAddress"><span>${hj("address")}</span><input id="hubCompanyAddress" type="text" value=${form.address} autocomplete="off" spellcheck=${false} onInput=${e => setForm(f => ({ ...f, address: e.target.value }))} /><small class="note">${hj("addressHint")}</small></label>
      <label class="field" for="hubCompanyFleetName"><span>${hj("fleetName")}</span><input id="hubCompanyFleetName" value=${form.label} maxlength="120" onInput=${e => setForm(f => ({ ...f, label: e.target.value }))} /></label>
      <p class="note">${hj("firstUse")}</p><div class="field-row"><button class="btn btn-primary" type="submit" disabled=${busy || !form.address.trim() || !form.label.trim()}>${hj("start")}</button></div>
    </form>` : null}
    ${view ? html`<div role="status"><strong>${hj(view.state === "saved" ? "saved" : view.state === "awaiting-sign-in" ? "awaiting" : view.state === "cancelled" ? "cancelled" : view.state === "held" || view.state === "ended" ? "held" : "joining")}</strong>
      ${view.state === "saved" ? html`<p class="note">${hj(view.link === "online" ? "done" : "offline")}</p>` : view.reason ? html`<p class="note">${joinError(view.reason)}</p>` : null}
      ${view.issued && view.state !== "saved" ? html`<p class="note">${hj("issued")}</p>` : null}
      <div class="field-row">${view.state === "held" && !["authority", "expired"].includes(view.reason) ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => action("resume")}>${hj("resume")}</button>` : null}
        ${!["saved", "cancelled", "ended"].includes(view.state) ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => action("cancel")}>${hj("stop")}</button>` : null}
        ${view.hubOrigin ? html`<a class="btn btn-sm" href=${view.hubOrigin + "/ui/hub"} target="_blank" rel="noopener noreferrer">${hj("inspect")}</a>` : null}</div>
    </div>` : null}
  </section>`;
}
