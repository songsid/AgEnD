/** Single connection card. Projections only; existing company, membership and exact pairing routes own every effect. */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { register, t } from "/assets/app-i18n.js";
import { api, confirmedWrite } from "./settings-confirm.js";
import * as legacy from "./settings-hub-membership.js";
import { j1 } from "./hub-join-one-strings.js";
import { joinError, joinResponseCode } from "./hub-company-join-strings.js";
register("hubConnection", {
  en: {
    title: "Hub connection", unconnected: "Not connected", connected: "Connected", paused: "Paused", connecting: "Connecting…", attention: "Connection needs attention",
    hub: "Hub", fleet: "Fleet", thisFleet: "This Fleet", open: "Open Hub", pause: "Pause connection", resume: "Resume connection",
    connectedHint: "This Fleet can use the Hub. Choose the Agents to share below; connecting does not share any Agent automatically.",
    pausedHint: "New Hub work and answer delivery are stopped. The saved connection and existing conversations are kept.",
    connectingHint: "The connection is saved. Waiting for the Hub link before reporting Connected.",
    advanced: "Connect with a pairing code (Advanced)", manualHint: "Use this for a Hub with a pairing code. The main sign-in flow enables membership when it succeeds.",
    enabled: "Allow this Fleet to use a Hub", pair: "Connect with pairing code", settings: "Connection settings", disconnect: "Revoke connection",
    pausedSettings: "Resume the connection to use its existing connection settings or revoke it.",
    pending: "Waiting for local confirmation…", review: "Review local confirmation", retry: "Check again",
    failed: "The connection settings could not be verified. Check again before making another change.", unavailable: "Connection settings could not be read. Check again.",
  },
  "zh-TW": {
    title: "Hub 連接", unconnected: "尚未連接", connected: "已連接", paused: "已暫停", connecting: "正在連接…", attention: "連接需要處理",
    hub: "Hub", fleet: "Fleet", thisFleet: "這個 Fleet", open: "開啟 Hub", pause: "暫停連接", resume: "恢復連接",
    connectedHint: "這個 Fleet 已可使用 Hub。請在下方選擇要分享的 Agent；連接不會自動分享 Agent。",
    pausedHint: "已停止新的 Hub 工作與回答傳送；連接資料和既有對話仍保留。",
    connectingHint: "連接資料已儲存，正在等待與 Hub 的網路連線；尚未顯示為已連接。",
    advanced: "使用配對碼連接（進階）", manualHint: "供使用配對碼的 Hub 使用。上方登入流程成功後會自動啟用成員功能。",
    enabled: "允許這個 Fleet 使用 Hub", pair: "以配對碼連接", settings: "連接設定", disconnect: "撤銷連接",
    pausedSettings: "恢復連接後，可使用既有連接設定或撤銷連接。",
    pending: "等待本機確認…", review: "開啟本機確認", retry: "再次檢查",
    failed: "無法確認連接設定。請再次檢查，再嘗試其他變更。", unavailable: "無法讀取連接設定，請再次檢查。",
  },
});
const hc = key => t(`hubConnection.${key}`), path = "/api/settings/hub/membership";
const states = new Set(["unpaired", "pending", "paired", "held"]);
const endpoint = value => { try { const u = new URL(value); return u.protocol === "https:" && u.origin === value; } catch { return false; } };
const validPairing = p => !!p && states.has(p.state) && (p.state === "unpaired" || p.state === "held" && typeof p.hold === "string"
  || p.state === "pending" && endpoint(p.memberOrigin) && /^[a-f0-9]{64}$/i.test(p.fingerprint?.digest || "") && Number.isFinite(p.expiresAt)
  || p.state === "paired" && endpoint(p.hub?.memberOrigin) && endpoint(p.hub?.webOrigin) && /^[a-f0-9]{64}$/i.test(p.hub?.fingerprint?.digest || "") && ["online", "offline"].includes(p.link));
const safeOrigin = p => { try { const value = p?.hub?.webOrigin, u = new URL(value); return u.protocol === "https:" && u.origin === value ? u.origin + "/ui/hub" : null; } catch { return null; } };
export function HubConnectionSettings({ onMode } = {}) {
  const publicPage = globalThis.document?.body?.dataset?.publicLink === "1";
  const [view, setView] = useState(null), [error, setFailureCode] = useState(""), [busy, setBusy] = useState(false), [fallback, setFallback] = useState(typeof legacy.markMember !== "function");
  const [Company, setCompany] = useState(null), [Connect, setConnect] = useState(null), [pending, setPending] = useState(null);
  // M-2921 (spec 1.1 / 1.3): the company-join record of this connection (its address, label, Hub name, owner), the
  // pairing code handed over from the one input, and the held card's reconnect / remove.
  const [display, setDisplay] = useState(null), [prefill, setPrefill] = useState(null), [manualOpen, setManualOpen] = useState(false);
  const [asking, setAsking] = useState(false), [cardError, setCardError] = useState(""), [cardNotice, setCardNotice] = useState("");
  // A reconnect's waiting tab: the join panel follows its handoff even while this pairing still reads held (it is started over in the same request).
  const joinWait = (() => { try { return !!new URLSearchParams(location.search).get("joinWait"); } catch { return false; } })();
  const life = useRef({ live: true, sequence: 0, busy: false, read: null });
  const read = () => {
    if (life.current.read) return life.current.read;
    const seq = ++life.current.sequence;
    const work = (async () => {
      try {
        const r = await api(path + "?v=2");
        if (!life.current.live || life.current.sequence !== seq) return;
        if (r.status === 404 || r.ok && typeof r.body?.enabled === "boolean" && r.body.connectionCardV1 === undefined) { setFallback(true); return; }
        if (!r.ok || r.body?.connectionCardV1 !== true || typeof r.body.enabled !== "boolean" || !validPairing(r.body.pairing)) throw Error("unavailable");
        legacy.markMember(r.body.enabled); setView({ enabled: r.body.enabled, pairing: r.body.pairing }); setFailureCode("");
      } catch { if (life.current.live && life.current.sequence === seq) setFailureCode("unavailable"); }
    })();
    life.current.read = work; void work.finally(() => { if (life.current.read === work) life.current.read = null; }); return work;
  };
  useEffect(() => {
    life.current.live = true; if (!publicPage && !fallback) void read();
    return () => { life.current.live = false; life.current.sequence++; };
  }, [publicPage, fallback]);
  useEffect(() => {
    let live = true;
    if ((view?.pairing?.state === "unpaired" || joinWait) && !fallback) import("./settings-hub-company-join.js").then(m => {
      if (!live) return; if (m.companyJoinEmbedV1 !== true) { setFallback(true); return; } setCompany(() => m.CompanyJoinSettings);
    }, () => { if (live) setFailureCode("unavailable"); });
    return () => { live = false; };
  }, [view?.pairing?.state, fallback]);
  useEffect(() => {
    let live = true;
    if (view?.enabled && !fallback) import("./settings-hub.js").then(m => {
      if (!live) return; if (m.hubConnectEmbedV1 !== true) { setFallback(true); return; } setConnect(() => m.HubConnectCard);
    }, () => { if (live) setFailureCode("unavailable"); });
    return () => { live = false; };
  }, [view?.enabled, fallback]);
  useEffect(() => {
    let live = true; const st = view?.pairing?.state;
    if (st !== "paired" && st !== "held") { setDisplay(null); return; }
    api("/api/hub/member/company-join").then(r => { if (live) setDisplay(r.ok && r.body?.display && typeof r.body.display.webOrigin === "string" ? r.body.display : null); }, () => { if (live) setDisplay(null); });
    return () => { live = false; };
  }, [view?.pairing?.state, view?.pairing?.binding]);
  const card = async step => {
    const p = view?.pairing;
    if (busy || !p?.binding || !(p.hubId || p.hub?.hubId)) return;
    const hubId = p.hubId || p.hub.hubId, address = display?.webOrigin || p.hub?.webOrigin;
    if (!address) return;
    // Reconnect ends at the Hub's sign-in: open the Fleet's own waiting tab now, in the press (as Start does), for this handoff.
    let handoffId = null;
    if (step === "reconnect") {
      handoffId = crypto.randomUUID();
      let target = ""; try { target = new URL(address).origin; } catch {}
      globalThis.open("/settings/hub?joinWait=" + encodeURIComponent(handoffId) + "&joinConsent=1#target=" + encodeURIComponent(target), "_blank", "noopener");
    }
    setBusy(true); setCardError(""); setCardNotice(""); setAsking(false);
    try {
      const r = await confirmedWrite("/api/hub/member/company-join/" + step, { body: { hubId, binding: p.binding, address, ...(handoffId ? { handoffId } : {}) }, label: j1(step === "reconnect" ? "reconnect" : "remove"),
        onPending: id => { if (life.current.live) setPending(id); } });
      if (!life.current.live) return;
      if (!r.ok) { setCardError(joinError(joinResponseCode(r))); return; }
      if (step === "remove") setCardNotice(j1("removed"));
      setView(null); await read();
    } catch { if (life.current.live) setCardError(joinError("unknown")); }
    finally { if (life.current.live) { setBusy(false); setPending(null); } }
  };
  const change = async enabled => {
    if (publicPage || !view || life.current.busy || error) return;
    life.current.busy = true; life.current.sequence++; setBusy(true); setPending(null);
    try {
      const result = await confirmedWrite(path, { method: "PUT", body: { enabled }, resendable: true, label: hc("title"),
        onPending: id => { if (life.current.live) setPending(id); } });
      if (!life.current.live) return;
      if (!result.ok) { setView(null); setFailureCode("failed"); return; }
      // An acknowledged write retires the old status and embedded member controls before verification.
      setView(null); if (!enabled) legacy.markMember(false);
      await life.current.read;
      if (life.current.live) await read();
    } catch { if (life.current.live) { setView(null); setFailureCode("failed"); } }
    finally { life.current.busy = false; if (life.current.live) { setBusy(false); setPending(null); } }
  };
  const review = () => {
    const card = [...document.querySelectorAll(".pending-card[data-pending]")].find(e => e.getAttribute("data-pending") === pending);
    if (!card) { location.assign("/ui/needs"); return; }
    card.scrollIntoView?.({ block: "center" }); card.querySelector("button,input,a")?.focus();
  };
  const reported = !view ? "unknown" : view.pairing?.state === "paired" ? (!view.enabled ? "paused" : view.pairing.link === "online" ? "connected" : "connecting") : "unconnected";
  useEffect(() => { onMode?.(reported); }, [reported]);
  if (publicPage) return null;
  if (fallback) return html`<${legacy.HubMembershipSettings} />`;
  const p = view?.pairing, paired = p?.state === "paired", paused = paired && !view.enabled;
  const online = paired && view.enabled && p.link === "online", bound = p && p.state !== "unpaired";
  const status = paused ? "paused" : online ? "connected" : paired ? "connecting" : bound ? "attention" : "unconnected";
  const mode = !view ? "unknown" : paused ? "paused" : online ? "connected" : paired ? "connecting" : "unconnected";
  const connected = Connect ? html`<${Connect} embedded=${true} prefill=${prefill} labels=${{ settings: hc("settings"), pair: hc("pair"), disconnect: hc("disconnect") }} onPairing=${pairing => setView(v => v ? { ...v, pairing } : v)} />`
    : html`<${Skeleton} variant="form" lines=${3} />`;
  const hubName = display?.hubName || p?.hub?.name || p?.hub?.webOrigin || display?.webOrigin || p?.memberOrigin || "";
  const reconnectable = p?.state === "held" && ["revoked", "rejected", "refused", "expired", "disconnected"].includes(p.hold) && !!p.binding;
  const removable = (paired || p?.state === "held") && !!p.binding && !!(display?.webOrigin || p.hub?.webOrigin);
  const removeAsk = asking ? html`<div class="form hub-remove-ask" role="alertdialog" aria-labelledby="hubRemoveAsk"><p class="note" id="hubRemoveAsk">${j1("removeAsk", hubName)}</p>
    <div class="field-row"><button type="button" class="btn btn-danger btn-sm" disabled=${busy} onClick=${() => card("remove")}>${j1("removeYes")}</button><button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => setAsking(false)}>${j1("removeNo")}</button></div></div>` : null;
  const removeLink = removable && !asking ? html`<button type="button" class="btn btn-ghost btn-sm hub-remove" disabled=${busy} onClick=${() => setAsking(true)}>${j1("remove")}</button>` : null;
  const owner = display?.ownerLabel && display?.label ? html`<p class="note hub-owner-line">${j1("ownerLine", display.ownerLabel, display.label)}</p>` : null;
  return html`<section class="card s-group s-hub-connection" id="hub-connection" data-state=${mode}>
    <header class="s-group-head"><h3>${(paired || p?.state === "held") && display?.hubName ? display.hubName : hc("title")}</h3>${view ? html`<span class=${`tag ${online ? "ok" : bound ? "warn" : ""}`}><span class=${`dot ${online ? "ok" : bound ? "warn" : ""}`}></span>${hc(status)}</span>` : null}</header>
    ${error ? html`<${ErrorState} message=${hc(error)} onRetry=${read} />` : null}
    ${!view && !error ? html`<${Skeleton} variant="form" lines=${4} />` : null}
    ${cardError ? html`<p class="note" role="alert">${cardError}</p>` : null}${cardNotice ? html`<p class="note" role="status">${cardNotice}</p>` : null}
    ${paired ? html`<div class="grid2 hub-connection-summary"><div class="field"><span>${hc("hub")}</span><strong>${hubName}</strong></div><div class="field"><span>${hc("fleet")}</span><strong>${display?.label || hc("thisFleet")}</strong></div></div>${owner}
      <p class="note">${hc(paused ? "pausedHint" : online ? "connectedHint" : "connectingHint")}</p>
      <div class="field-row">${!paused && safeOrigin(p) ? html`<a class="btn btn-primary" href=${safeOrigin(p)} target="_blank" rel="noopener noreferrer">${hc("open")}</a>` : null}
        <button type="button" class=${`btn ${paused ? "btn-primary" : "btn-ghost"}`} disabled=${busy || !!error} onClick=${() => change(paused)}>${hc(paused ? "resume" : "pause")}</button>${removeLink}</div>${removeAsk}
      ${paused ? html`<details class="s-ui-disclosure"><summary>${hc("settings")}</summary><p class="note">${hc("pausedSettings")}</p></details>` : connected}`
      : view ? html`${p.state === "held" && !joinWait ? html`<div class="hub-held"><strong>${hubName}</strong>${owner}
          ${reconnectable || removable ? html`<div class="field-row">${reconnectable ? display ? html`<button type="button" class="btn btn-primary" disabled=${busy} onClick=${() => card("reconnect")}>${j1("reconnect")}</button>`
            : html`<button type="button" class="btn btn-primary" onClick=${() => setManualOpen(true)}>${j1("reconnect")}</button>` : null}${removeLink}</div>${removeAsk}` : null}</div>` : null}
      ${p.state === "unpaired" || joinWait ? Company ? html`<${Company} embedded=${true} memberEnabled=${view.enabled} onSaved=${read} onPairingCode=${v => { setPrefill(v); setManualOpen(true); }} />` : html`<${Skeleton} variant="form" lines=${3} />`
        : p.state === "held" && display ? null : view.enabled ? connected : html`<p class="note">${hc("attention")}</p>`}
      <details class="s-ui-disclosure hub-connection-manual" open=${manualOpen} onToggle=${e => setManualOpen(e.target.open)}><summary>${p.state === "unpaired" ? j1("other") : hc("advanced")}</summary><div class="s-disclosure-body form"><p class="note">${hc("manualHint")}</p>
        <label class="check"><input id="hubMemberEnabled" class="s-ui-toggle" type="checkbox" role="switch" checked=${view.enabled} disabled=${busy || !!error} onChange=${e => change(e.target.checked)} /><span>${hc("enabled")}</span></label>
        ${view.enabled && p.state === "unpaired" ? connected : null}
      </div></details>` : null}
    ${pending ? html`<div role="status" class="form"><p class="note">${hc("pending")}</p><button type="button" class="btn" onClick=${review}>${hc("review")}</button></div>` : null}
  </section>`;
}
