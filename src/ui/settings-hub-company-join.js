/** Fleet-only company handoff; all fields live in the actual Settings section and use its shared confirmation card. */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { api, confirmedWrite, withdraw } from "./settings-confirm.js";
import { hj, joinError, joinResponseCode } from "./hub-company-join-strings.js";
// Own words: a new panel must also work with a cached older company-join dictionary.
register("companyJoinWait", {
  "en": {
    pending: "Local confirmation is required. Company sign-in has not started.",
    pendingNext: "Choose Review local confirmation and complete the next step shown on that card. This connection then continues here.",
    localWithdrawn: "Local confirmation was withdrawn. Company sign-in did not start.",
    reviewConfirmation: "Review local confirmation",
    withdraw: "Withdraw connection request",
    localExpired: "Local confirmation has not completed within five minutes. Check this request before starting another connection.",
    leaveWait: "Returning to Settings does not withdraw a submitted confirmation. Use Withdraw on its confirmation card to cancel it.",
  },
  "zh-TW": {
    pending: "需要先完成本機確認，公司帳號登入尚未開始。",
    pendingNext: "請按「開啟本機確認」，完成確認卡顯示的下一步，這次連接就會繼續。",
    localWithdrawn: "已撤回本機確認，尚未開始公司帳號登入。",
    reviewConfirmation: "開啟本機確認",
    withdraw: "撤回連接請求",
    localExpired: "已等待五分鐘，本機確認尚未完成。請先檢查這次請求，再開始其他連接。",
    leaveWait: "返回設定不會撤回已送出的確認；若要取消，請在該確認卡按「撤回」。",
  },
});
const jw = key => t(`companyJoinWait.${key}`);
const root = "/api/hub/member/company-join";
const LOCAL_WAIT_MS = 5 * 60_000; // matches the Settings confirmation ceiling; never renew on a status read
export function CompanyJoinSettings({ onSaved, memberEnabled = false } = {}) {
  const notified = useRef(null);
  const waiting = (() => { try { return new URLSearchParams(location.search).get("joinWait"); } catch { return null; } })();
  const [view, setView] = useState(undefined), [error, setError] = useState(null), [busy, setBusy] = useState(false), [pending, setPending] = useState(null), [identityChanged, setIdentityChanged] = useState(false);
  const [bound, setBound] = useState(false), [timedOut, setTimedOut] = useState(false), [withdrawing, setWithdrawing] = useState(false), [notice, setNotice] = useState(null);
  const waitDeadline = useRef(Date.now() + LOCAL_WAIT_MS), reading = useRef(null);
  const [form, setForm] = useState(() => {
    let address = ""; try { const candidate = new URLSearchParams(location.hash.slice(1)).get("join"); if (candidate && candidate.length <= 8192) address = candidate; } catch {}
    return { address, label: hj("defaultFleet") };
  }), live = useRef(true), token = useRef(0);
  const read = () => {
    if (reading.current) return reading.current; // one physical status read, including Retry and slow networks
    const gen = token.current;
    const request = (async () => {
      try { const result = await api(root + (view?.operationId ? `?operationId=${encodeURIComponent(view.operationId)}` : ""));
        if (!live.current || gen !== token.current) return;
        if (!result.ok) { setError(joinError(result.body?.error)); return; }
        setView(result.body.operation ?? null); setBound(result.body.bound === true); setError(null);
      } catch { if (live.current && gen === token.current) setError(hj("unknown")); }
    })();
    reading.current = request;
    request.finally(() => { if (reading.current === request) reading.current = null; });
    return request;
  };
  const unmatched = !!waiting && view?.handoffId !== waiting;
  useEffect(() => { live.current = true; read(); return () => { live.current = false; token.current++; }; }, []);
  useEffect(() => {
    if (!pending && !unmatched) { setTimedOut(false); return; }
    const deadline = pending?.deadline ?? waitDeadline.current;
    const left = deadline - Date.now();
    if (left <= 0) { setTimedOut(true); return; }
    const timer = setTimeout(() => setTimedOut(true), left);
    return () => clearTimeout(timer);
  }, [pending?.deadline, unmatched]);
  useEffect(() => {
    if (waiting && view?.handoffId === waiting && view.state === "awaiting-sign-in") {
      location.replace(root + "/bridge?operationId=" + encodeURIComponent(view.operationId)); return;
    }
    const active = waiting || view?.operationId && (["joining", "awaiting-sign-in", "durable"].includes(view.state) || view.state === "saved" && view.link !== "online");
    if (!active || unmatched && timedOut) return;
    // Re-arm after the physical read settles, even when its value is still null. A null state setter does not render.
    let stopped = false, timer;
    const poll = async () => { await read(); if (!stopped) timer = setTimeout(poll, 1500); };
    timer = setTimeout(poll, 1500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [view?.operationId, view?.handoffId, view?.state, view?.link, waiting, unmatched, timedOut]);
  const onPending = (id, change) => {
    setTimedOut(false);
    const remaining = Number(change?.remaining_ms);
    setPending({ id, deadline: Date.now() + Math.min(LOCAL_WAIT_MS, Number.isFinite(remaining) ? Math.max(0, remaining) : LOCAL_WAIT_MS) });
  };
  const reviewConfirmation = () => {
    const cards = [...document.querySelectorAll(".pending-card[data-pending]")];
    const card = pending ? cards.find(el => el.getAttribute("data-pending") === pending.id) : document.querySelector(".pending-stack");
    if (!card) { location.assign("/ui/needs"); return; }
    card.scrollIntoView?.({ block: "center" });
    const control = pending && card.querySelector("button, input, a");
    if (control) control.focus(); else { card.tabIndex = -1; card.focus(); }
  };
  const cancelPending = async () => {
    if (!pending || withdrawing) return;
    const gen = token.current; setWithdrawing(true);
    const ok = await withdraw(pending.id);
    if (live.current && gen === token.current) { setWithdrawing(false); if (!ok) setError(hj("unknown")); }
  };
  useEffect(() => { if (view?.state === "saved" && view.link === "online" && notified.current !== view.operationId) { notified.current = view.operationId; onSaved?.(); } }, [view, onSaved]);
  const start = async e => {
    e.preventDefault(); if (busy) return;
    const gen = ++token.current; setBusy(true); setError(null); setNotice(null); setPending(null); setIdentityChanged(false);
    const handoffId = crypto.randomUUID();
    // Open the Fleet-owned waiting page during the user gesture, with no opener or cross-origin messaging.
    globalThis.open("/settings/hub?joinWait=" + encodeURIComponent(handoffId), "_blank", "noopener");
    try {
      const result = await confirmedWrite(root + "/start", { body: { ...form, handoffId }, label: hj("title"), onPending: (id, change) => { if (live.current && gen === token.current) onPending(id, change); } });
      if (!live.current || gen !== token.current) return;
      if (!result.ok || !result.body?.operation) { await read();
        if (result.confirmed?.state === "rejected" && result.confirmed.outcome?.reason_code === "withdrawn") { setError(null); setNotice(jw("localWithdrawn")); return; }
        const code = joinResponseCode(result); setError(result.confirmed?.state === "expired" ? jw("localExpired") : joinError(code)); setIdentityChanged(code === "identity-changed"); return; }
      const operation = result.body.operation; setView(operation); setError(null);

    } catch { if (live.current && gen === token.current) setError(hj("unknown")); }
    finally { if (live.current && gen === token.current) { setBusy(false); setPending(null); } }
  };
  const repair = async () => {
    if (busy) return; const gen = ++token.current; setBusy(true); setError(null);
    try {
      const result = await confirmedWrite(root + "/repair-trust", { body: { address: form.address }, label: hj("repair"), onPending: (id, change) => { if (live.current && gen === token.current) onPending(id, change); } });
      if (!live.current || gen !== token.current) return;
      if (result.ok) { setIdentityChanged(false); setError(null); } else setError(joinError(joinResponseCode(result)));
    } catch { if (live.current && gen === token.current) setError(hj("unknown")); }
    finally { if (live.current && gen === token.current) { setBusy(false); setPending(null); } }
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
    ${view === undefined && !timedOut && !error ? html`<${Skeleton} variant="form" lines=${4} label=${hj("loading")} />` : null}
    ${error ? html`<${ErrorState} message=${error} onRetry=${read} />` : null}
    ${notice ? html`<p role="status" class="note">${notice}</p>` : null}
    ${pending || unmatched ? html`<div role="status" class="company-local-wait">
      <p class="note">${jw(timedOut ? "localExpired" : "pending")}</p>
      <p class="note">${jw("pendingNext")}</p>
      <div class="field-row"><button type="button" class="btn btn-sm btn-primary" onClick=${reviewConfirmation}>${jw("reviewConfirmation")}</button>
        ${pending ? html`<button type="button" class="btn btn-sm" disabled=${withdrawing} onClick=${cancelPending}>${jw("withdraw")}</button>` : null}
        ${timedOut ? html`<button type="button" class="btn btn-sm" onClick=${read}>${hj("retry")}</button>` : null}
        ${waiting ? html`<a class="btn btn-sm" href="/settings/hub">${hj("return")}</a>` : null}</div>
      ${waiting ? html`<p class="note">${jw("leaveWait")}</p>` : null}
    </div>` : null}
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
