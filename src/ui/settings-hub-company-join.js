/** Fleet-only company handoff; all fields live in the actual Settings section and use its shared confirmation card. */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { api, confirmedWrite, confirmWithCode } from "./settings-confirm.js";
import { hj, joinError, joinResponseCode } from "./hub-company-join-strings.js";
import { j1, classifyHubInput, probeMessage, waitingMessage, reasonMessage, leftOf } from "./hub-join-one-strings.js";
// Own words: a new panel must also work with a cached older company-join dictionary.
register("companyJoinWait", {
  "en": {
    startHint: "Paste the Hub link first.", nameHint: "Enter a Fleet name to continue.",
    getLink: "Enter the Hub address (for example hub.example.com), or paste the link your Hub administrator gave you.",
    connecting: "Opening Hub sign-in…", codeNeeded: "Your authenticator code is required.", target: "Hub: {0}",
    codeLead: "You enabled authenticator codes for remote changes. Enter your own 6-digit code here to continue to Hub sign-in.",
    codeLabel: "Your 6-digit authenticator code", codeGo: "Continue", codeWrong: "That code was not accepted. Try a current code.",
    codeBusy: "Too many attempts. Wait and try again.", codeUnavailable: "This request cannot be verified now. Check the same connection again.",
    codeInOriginal: "Enter your authenticator code here if requested. This tab continues automatically.",
    checking: "Checking this connection’s status. Review any local confirmation before continuing.",
    pending: "Local confirmation is required. Hub sign-in has not started.",
    pendingNext: "Choose Review local confirmation and complete the next step shown on that card. This connection then continues here.",
    localWithdrawn: "Local confirmation was withdrawn. Hub sign-in did not start.",
    reviewConfirmation: "Review local confirmation",
    localExpired: "The local confirmation wait has ended without a verified connection result. Check this request before starting another connection.",
    leaveWait: "Returning to Settings does not withdraw a submitted confirmation. Use Withdraw on its confirmation card to cancel it.",
  },
  "zh-TW": {
    startHint: "請先貼上 Hub 連結。", nameHint: "請填入 Fleet 名稱以繼續。",
    getLink: "請輸入 Hub 位址（例如 hub.example.com），或貼上 Hub 管理員給你的連結。",
    connecting: "正在開啟 Hub 登入頁面…", codeNeeded: "請輸入你的驗證碼以繼續。", target: "Hub：{0}",
    codeLead: "你已啟用遠端變更的驗證碼保護。請在這裡輸入你自己的 6 位數驗證碼，繼續前往 Hub 登入。",
    codeLabel: "你的 6 位數驗證碼", codeGo: "繼續", codeWrong: "驗證碼未通過，請輸入目前的驗證碼。",
    codeBusy: "嘗試次數過多，請稍候再試。", codeUnavailable: "目前無法驗證這次請求，請再次檢查同一個連接。",
    codeInOriginal: "若你的帳號要求驗證碼，請在這裡輸入。這個分頁會自動繼續。",
    checking: "正在確認這次連接的狀態；請先檢視待完成的本機確認。",
    pending: "需要先完成本機確認，Hub 登入尚未開始。",
    pendingNext: "請按「開啟本機確認」，完成確認卡顯示的下一步，這次連接就會繼續。",
    localWithdrawn: "已撤回本機確認，尚未開始 Hub 登入。",
    reviewConfirmation: "開啟本機確認",
    localExpired: "等候本機確認的時間已到，目前仍未確認這次連接的結果。請先檢查這次請求，再開始其他連接。",
    leaveWait: "返回設定不會撤回已送出的確認；若要取消，請在該確認卡按「撤回」。",
  },
});
const jw = (key, ...args) => t(`companyJoinWait.${key}`, ...args);
const root = "/api/hub/member/company-join";
const LOCAL_WAIT_MS = 5 * 60_000; // matches the Settings confirmation ceiling; never renew on a status read
export const companyJoinEmbedV1 = true;
export function CompanyJoinSettings({ onSaved, memberEnabled = false, embedded = false, onPairingCode } = {}) {
  const notified = useRef(null), submittedTarget = useRef(""), submittedHandoff = useRef(null);
  const { hubJoinChanges = [] } = useStore(appStore);
  const waiting = (() => { try { return new URLSearchParams(location.search).get("joinWait"); } catch { return null; } })();
  const consentWait = (() => { try { return new URLSearchParams(location.search).get("joinConsent") === "1"; } catch { return false; } })();
  const [code, setCode] = useState(""), [codeBusy, setCodeBusy] = useState(false), [codeError, setCodeError] = useState(null);
  const [view, setView] = useState(undefined), [error, setError] = useState(null), [busy, setBusy] = useState(false), [pending, setPending] = useState(null), [identityChanged, setIdentityChanged] = useState(false);
  const [bound, setBound] = useState(false), [timedOut, setTimedOut] = useState(false), [notice, setNotice] = useState(null);
  const waitDeadline = useRef(Date.now() + LOCAL_WAIT_MS), reading = useRef(null);
  const [form, setForm] = useState(() => {
    let address = ""; try { const candidate = new URLSearchParams(location.hash.slice(1)).get("join"); if (candidate && candidate.length <= 8192) address = candidate; } catch {}
    return { address, label: "" };
  }), live = useRef(true), token = useRef(0);
  // M-2921 (spec 1.1): the one input — classified here, probed (read only) 600 ms after typing stops and on blur.
  const [probe, setProbe] = useState(null), [probing, setProbing] = useState(false), [renaming, setRenaming] = useState(false), [now, setNow] = useState(Date.now());
  // #3675 r1 P2: an answer is kept per address only to show it; it never stops another look. Blur asks again (spec 1.1),
  // a failed or limited answer is asked again on the next blur, and a replaced identity is looked up again at once.
  // The ref only keeps two looks at the same address from running at the same time.
  // #3675 r2: every look is bound to the address it was asked for and to its generation; only the newest answer for the
  // address in the input counts. A forced look (after a replaced identity) retires any look still running.
  const probeSeq = useRef(0), inflight = useRef(""), current = useRef("");
  const kind = classifyHubInput(form.address);
  current.current = kind.kind === "address" ? kind.address : "";
  const host = (() => { try { return new URL(kind.address).host; } catch { return ""; } })();
  const runProbe = async (target = current.current, force = false) => {
    if (!target || target !== current.current || !force && inflight.current === target) return;
    const seq = ++probeSeq.current, address = target; inflight.current = address; setProbing(true);
    try { const r = await api(root + "/probe", { method: "POST", body: JSON.stringify({ address }) });
      if (!live.current || seq !== probeSeq.current || address !== current.current) return;
      // No answer at all (a network error, an older server): recorded as answered-without-a-word, which never blocks Start.
      setProbe(r.ok ? { ...r.body, address } : r.body && r.body.ok === false && typeof r.body.reason === "string" ? { ...r.body, address } : { address, none: true });
    } catch { if (live.current && seq === probeSeq.current) setProbe({ address, none: true }); }
    finally { if (inflight.current === address) inflight.current = ""; if (live.current && seq === probeSeq.current) setProbing(false); }
  };
  useEffect(() => {
    if (kind.kind !== "address") { probeSeq.current++; inflight.current = ""; setProbe(null); setProbing(false); return; }
    setProbe(p => p && p.address === kind.address ? p : null);
    const timer = setTimeout(() => runProbe(kind.address), 600);
    return () => clearTimeout(timer);
  }, [kind.kind, kind.address]);
  useEffect(() => {
    if (view?.state !== "awaiting-sign-in" || !Number.isFinite(view.expiresAt)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [view?.state, view?.expiresAt]);
  useEffect(() => { if (kind.kind === "pairing") onPairingCode?.({ address: kind.address || "", code: kind.code }); }, [kind.kind, kind.code, kind.address]);
  const read = () => {
    if (reading.current) return reading.current; // one physical status read, including Retry and slow networks
    const gen = token.current;
    const request = (async () => {
      // An older operation can be current while this handoff still awaits local confirmation.
      // Discover the current pointer until our handoff matches; only then retain its operation id.
      const operationId = view?.operationId && (!waiting || view.handoffId === waiting) ? view.operationId : null;
      try { const result = await api(root + (operationId ? `?operationId=${encodeURIComponent(operationId)}` : ""));
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
    setPending({ id, target: submittedTarget.current, inline: change?.presentation === "hub-join", state: change?.state, totp: change?.totp, deadline: Date.now() + Math.min(LOCAL_WAIT_MS, Number.isFinite(remaining) ? Math.max(0, remaining) : LOCAL_WAIT_MS) });
  };
  // PanelSettings attaches this cookie session’s claims on reload. Only the exact handoff, or a sole
  // active claim when no handoff is selected, can be adopted. No new Start or deadline is created.
  useEffect(() => {
    const handoff = waiting || submittedHandoff.current;
    const matching = hubJoinChanges.filter(v => handoff ? v.hubJoin?.handoffId === handoff : v.id === pending?.id);
    const active = hubJoinChanges.filter(v => v.state === "pending" || v.state === "applying");
    const claim = matching[0] || (!handoff && !pending && active.length === 1 ? active[0] : null);
    if (!claim) return;
    if (claim.state === "applied") { if (claim.outcome?.result?.operation) setView(claim.outcome.result.operation); setPending(null); return; }
    if (claim.state !== "pending" && claim.state !== "applying") { setPending(null); setError(jw("localExpired")); return; }
    setPending(old => ({ id: claim.id, inline: true, state: claim.state, totp: claim.totp,
      target: claim.hubJoin?.target || old?.target || submittedTarget.current,
      deadline: old?.id === claim.id ? old.deadline : Date.now() + Math.min(LOCAL_WAIT_MS, Math.max(0, Number(claim.remaining_ms) || 0)) }));
  }, [hubJoinChanges, pending?.id, waiting]);
  const reviewConfirmation = () => {
    const cards = [...document.querySelectorAll(".pending-card[data-pending]")];
    const card = pending ? cards.find(el => el.getAttribute("data-pending") === pending.id) : document.querySelector(".pending-stack");
    if (!card) { location.assign("/settings/hub"); return; }
    card.scrollIntoView?.({ block: "center" });
    const control = pending && card.querySelector("button, input, a");
    if (control) control.focus(); else { card.tabIndex = -1; card.focus(); }
  };
  useEffect(() => { if ((!embedded || bound) && view?.state === "saved" && view.link === "online" && notified.current !== view.operationId) { notified.current = view.operationId; onSaved?.(); } }, [view, onSaved, embedded, bound]);
  const start = async e => {
    e.preventDefault(); if (busy || !ready) return;
    const gen = ++token.current; setBusy(true); setError(null); setNotice(null); setPending(null); setIdentityChanged(false); setCode(""); setCodeError(null);
    const handoffId = crypto.randomUUID(); submittedHandoff.current = handoffId;
    // Open the Fleet-owned waiting page during the user gesture, with no opener or cross-origin messaging.
    let target = ""; try { target = new URL(kind.address).origin; } catch {}
    submittedTarget.current = target;
    globalThis.open("/settings/hub?joinWait=" + encodeURIComponent(handoffId) + "&joinConsent=1#target=" + encodeURIComponent(target), "_blank", "noopener");
    try {
      const body = { address: kind.address, label: fleetLabel, handoffId, ...(kind.code ? { code: kind.code } : {}) };
      const result = await confirmedWrite(root + "/start", { body, label: hj("title"), onPending: (id, change) => { if (live.current && gen === token.current) onPending(id, change); } });
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
      const repaired = kind.address || form.address;
      const result = await confirmedWrite(root + "/repair-trust", { body: { address: repaired }, label: hj("repair"), onPending: (id, change) => { if (live.current && gen === token.current) onPending(id, change); } });
      if (!live.current || gen !== token.current) return;
      // Look the repaired address up again — only while it is still the one in the input (moved on: that address's own look stands).
      if (result.ok) { setIdentityChanged(false); setError(null); if (current.current === repaired) { setProbe(null); void runProbe(repaired, true); } } else setError(joinError(joinResponseCode(result)));
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
  const submitCode = async e => {
    e.preventDefault(); if (codeBusy || !pending?.inline || pending.totp !== "ready" || !/^\d{6}$/.test(code)) return;
    const gen = token.current, id = pending.id; setCodeBusy(true); setCodeError(null);
    try { const r = await confirmWithCode(id, code);
      if (!live.current || gen !== token.current || pending.id !== id) return;
      setCode(""); if (r.ok) setPending(p => p?.id === id ? { ...p, state: "applying" } : p);
      else setCodeError(jw(r.error === "wrong" ? "codeWrong" : r.error === "paused" ? "codeBusy" : "codeUnavailable"));
    } catch { if (live.current && gen === token.current) setCodeError(jw("codeUnavailable")); }
    finally { if (live.current && gen === token.current) setCodeBusy(false); }
  };
  const fleetLabel = (form.label.trim() || probe?.suggestedLabel || hj("defaultFleet")).slice(0, 120);
  const problem = kind.kind === "error" ? j1(kind.error) : probe && !probe.none && probe.address === kind.address ? probeMessage(probe, host) : null;
  // Start once the probe for exactly this address has answered without a problem. A probe that could not answer at all
  // (no reason: a network error, an older server) does not block Start: Start makes the same checks itself.
  const ready = kind.kind === "address" && !problem && !probing && probe?.address === kind.address;
  const target = (() => { try { return pending?.target || (view && (!waiting || view.handoffId === waiting) ? view.hubOrigin : "") || (waiting ? new URLSearchParams(location.hash.slice(1)).get("target") || "" : new URL(kind.address).origin); } catch { return ""; } })();
  const inlineWait = consentWait || pending?.inline;
  const retired = embedded && !bound && view?.state === "saved" && view.outcomeKnown;
  const canStart = !pending?.inline && !waiting && (retired || view === null || view && ["ended", "cancelled"].includes(view.state) && !view.issued && view.outcomeKnown);
  // The existing connection card owns ready status, sharing and disconnect. Do not duplicate it after handoff.
  if (!waiting && bound && view === null || !retired && view?.state === "saved" && (memberEnabled || view.link === "online") && onSaved) return null;
  const Frame = embedded ? "div" : "section";
  return html`<${Frame} class=${embedded ? "form s-company-join" : "card s-company-join"}>${!embedded ? html`<h3>${hj("title")}</h3>` : null}<p class="note">${hj("lead")}</p>
    ${view === undefined && !waiting && !timedOut && !error ? html`<${Skeleton} variant="form" lines=${4} label=${hj("loading")} />` : null}
    ${error ? html`<${ErrorState} message=${error} onRetry=${read} />` : null}
    ${notice ? html`<p role="status" class="note">${notice}</p>` : null}
    ${(pending || unmatched) && inlineWait ? html`<div role="status" class="company-local-wait">
      <p class="note">${jw(timedOut ? "localExpired" : pending?.state === "pending" ? pending.totp === "ready" ? "codeNeeded" : "codeUnavailable" : "connecting")}</p>
      ${target ? html`<p class="note">${jw("target", target)}</p>` : null}
      ${pending?.state === "pending" && pending.totp === "ready" ? html`<form class="form hub-join-code" onSubmit=${submitCode}>
        <p class="note">${jw("codeLead")}</p><label class="field"><span>${jw("codeLabel")}</span><input value=${code} inputmode="numeric" autocomplete="one-time-code" maxlength="6" disabled=${codeBusy} onInput=${e => setCode(e.target.value)} /></label>
        <div class="field-row"><button type="submit" class="btn btn-primary" disabled=${codeBusy || !/^\d{6}$/.test(code)}>${jw("codeGo")}</button></div>
        ${codeError ? html`<p class="note" role="alert">${codeError}</p>` : null}
      </form>` : pending?.state === "pending" ? html`<p class="note">${jw("codeUnavailable")}</p>` : null}
      ${waiting ? html`<p class="note">${jw("codeInOriginal")}</p>` : null}
      ${timedOut ? html`<button type="button" class="btn" onClick=${read}>${hj("retry")}</button>` : null}
    </div>` : null}
    ${(pending || unmatched) && !inlineWait ? html`<div role="status" class="company-local-wait">
      <p class="note">${jw(timedOut ? "localExpired" : !pending && (view === undefined || error) ? "checking" : "pending")}</p>
      <p class="note">${jw("pendingNext")}</p>
      <div class="field-row"><button type="button" class="btn btn-sm btn-primary" onClick=${reviewConfirmation}>${jw("reviewConfirmation")}</button>
        ${timedOut ? html`<button type="button" class="btn btn-sm" onClick=${read}>${hj("retry")}</button>` : null}
        ${waiting ? html`<a class="btn btn-sm" href="/settings/hub">${hj("return")}</a>` : null}</div>
      ${waiting ? html`<p class="note">${jw("leaveWait")}</p>` : null}
    </div>` : null}
    ${canStart ? html`<form class="form hub-join-one" onSubmit=${start}>
      <label class="field" for="hubCompanyAddress"><span>${j1("input")}</span><input id="hubCompanyAddress" type="text" value=${form.address} placeholder=${j1("placeholder")} autocomplete="off" spellcheck=${false} autocapitalize="off"
        aria-describedby="hubCompanyLine" aria-invalid=${problem ? "true" : undefined} onInput=${e => setForm(f => ({ ...f, address: e.target.value }))} onBlur=${() => runProbe()} /></label>
      <p class="note hub-join-line" id="hubCompanyLine" role=${problem ? "alert" : "status"}>${problem ? problem
        : kind.kind === "pairing" ? j1("otherPairing")
        : probing ? j1("probing")
        : probe?.ok && probe.address === kind.address ? html`${j1("found", probe.hubName || host, fleetLabel)} ${!renaming ? html`<button type="button" class="btn btn-ghost btn-sm hub-join-rename" onClick=${() => setRenaming(true)}>${j1("rename")}</button>` : null}`
        : !form.address.trim() ? jw("getLink") : null}</p>
      ${renaming ? html`<label class="field" for="hubCompanyFleetName"><span>${j1("label")}</span><input id="hubCompanyFleetName" value=${form.label} maxlength="120" placeholder=${probe?.suggestedLabel || hj("defaultFleet")} onInput=${e => setForm(f => ({ ...f, label: e.target.value }))} /></label>` : null}
      <div class="field-row"><button class="btn btn-primary" type="submit" disabled=${busy || !ready}>${j1("go")}</button></div>
      ${identityChanged || probe?.identity === "changed" && probe.address === kind.address ? html`<p class="note">${hj("repairLead")}</p><button class="btn btn-sm" type="button" disabled=${busy || kind.kind !== "address"} onClick=${repair}>${hj("repair")}</button>` : null}
    </form>` : null}
    ${view && !retired && (!waiting || view.handoffId === waiting) ? html`<div role="status"><strong>${hj(view.state === "saved" ? view.link === "online" ? "saved" : "joining" : view.state === "awaiting-sign-in" ? "awaiting" : view.state === "cancelled" ? "cancelled" : view.state === "held" || view.state === "ended" ? "held" : "joining")}</strong>
      ${view.state === "awaiting-sign-in" ? html`<p class="note hub-join-opened">${j1("opened", probe?.ok && probe.hubName || (() => { try { return new URL(view.hubOrigin).host; } catch { return view.hubOrigin || ""; } })())}${Number.isFinite(view.expiresAt) ? html` <span class="hub-join-left">${j1("left", leftOf(view.expiresAt, now))}</span>` : null}</p>` : null}
      ${view.state === "awaiting-sign-in" && waitingMessage(view.waiting) ? html`<p class="note" role="alert">${waitingMessage(view.waiting)}</p>` : null}
      ${view.state === "saved" ? html`<p class="note">${hj(view.link === "online" ? "fleetDone" : "offline")}</p>` : view.reason && view.reason !== "cancelled" ? html`<p class="note">${reasonMessage(view) || joinError(view.reason)}</p>` : null}
      ${view.issued && view.state !== "saved" ? html`<p class="note">${hj("issued")}</p>` : null}
      <div class="field-row">${view.state === "awaiting-sign-in" ? html`<a class="btn btn-sm" href=${root + "/bridge?operationId=" + encodeURIComponent(view.operationId)} target="_blank" rel="noopener">${j1("reopen")}</a>` : null}${view.state === "held" && !["authority", "expired"].includes(view.reason) ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => action("resume")}>${hj("resume")}</button>` : null}
        ${!["saved", "cancelled", "ended"].includes(view.state) ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => action("cancel")}>${view.state === "awaiting-sign-in" ? j1("cancel") : hj("stop")}</button>` : null}
        ${view.hubOrigin ? html`<a class="btn btn-sm" href=${view.hubOrigin + "/ui/hub"} target="_blank" rel="noopener noreferrer">${hj("inspect")}</a>` : null}</div>
    </div>` : null}
  </${Frame}>`;
}
