// Refs #3061 (P2a): Settings → Access & security → Sign-in & authorization → "Devices & sign-in", on a fleet with no chat
// connection. "Add device" opens a dialog: type the 8-character code a new device is showing on its sign-in page (the
// device chose "Sign in with another device"), see who is asking — its label, whether it came from this computer or
// the network, its address and the time left — and Allow or Deny. Approving copies nothing from this device: the new
// browser signs itself in with a session of its own, and owner authorization is not part of it.
//
// Only the verified owner may approve (GET /ui/devices' `owner`): this computer's admin here, or signed in from outside
// with the authenticator's code. Anyone else sees the card, the explanation and a disabled button. The server decides
// that on every request and refuses everything else regardless (POST /ui/devices/{lookup,approve,deny} → 403).
// The words are English and 繁體中文, as everything in src/ui (tests/i18n-ui-literals-2390.test.ts).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { api } from "./settings-confirm.js";

register("devices", {
  en: {
    title: "Devices & sign-in", lead: "Sign in a new device with an 8-character code. You approve it here, on a device that is already signed in as the owner.",
    add: "Add device", noCopy: "Approving does not copy this device's sign-in. The new device gets a session of its own.",
    ownerOnly: "Only a device whose owner is verified can add a device. Use the AgEnD computer, or sign in with the authenticator app.",
    dlgTitle: "Add device", dlgLead: "On the new device, choose “Sign in with another device”, then enter the code it shows.",
    codeLabel: "Code on the new device", find: "Continue",
    confirmTitle: "Allow this device to sign in?", device: "Device", from: "From", address: "Address", left: "Time left", code: "Code",
    fromHost: "This computer", fromNetwork: "The network (LAN or tailnet)",
    grants: "General web actions only. Owner authorization is not included; it is verified separately.",
    allow: "Allow", deny: "Deny", back: "Back", done: "Done",
    approved: "Approved. The new device signs in within a few seconds.", denied: "Denied. The new device was told it may not sign in.",
    notFound: "No device is waiting with that code. Check the code on the new device; it may have expired.",
    expired: "That code has expired. Ask the new device for a new one.",
    paused: "Too many wrong codes. Try again in {0}.", decided: "That request was already decided.",
    lostOwner: "This device can no longer approve sign-ins: its owner verification has ended.",
    minutes: "{0} minutes", minute: "1 minute",
  },
  "zh-TW": {
    title: "裝置與登入", lead: "用 8 碼代碼讓新裝置登入。在已登入且已驗證擁有者的裝置上，到這裡核准。",
    add: "新增裝置", noCopy: "核准不會複製這台裝置的登入狀態，新裝置會取得自己的工作階段。",
    ownerOnly: "只有已驗證擁有者的裝置才能新增裝置。請使用 AgEnD 電腦，或用驗證器 App 登入。",
    dlgTitle: "新增裝置", dlgLead: "在新裝置上選「使用其他裝置登入」，再輸入它顯示的代碼。",
    codeLabel: "新裝置上的代碼", find: "繼續",
    confirmTitle: "允許這台裝置登入？", device: "裝置", from: "來源", address: "位址", left: "剩餘時間", code: "代碼",
    fromHost: "這台電腦", fromNetwork: "網路（區網或 tailnet）",
    grants: "只能使用一般的網頁功能，不含擁有者授權；擁有者授權需另外驗證。",
    allow: "允許", deny: "拒絕", back: "返回", done: "完成",
    approved: "已核准。新裝置幾秒內就會登入。", denied: "已拒絕。新裝置會收到不能登入的通知。",
    notFound: "沒有等待中的裝置使用這組代碼。請確認新裝置上的代碼；它可能已失效。",
    expired: "這組代碼已失效。請讓新裝置重新取得代碼。",
    paused: "錯誤次數太多，請 {0} 後再試。", decided: "這個請求已經處理過了。",
    lostOwner: "這台裝置已不能核准登入：它的擁有者驗證已結束。",
    minutes: "{0} 分鐘", minute: "1 分鐘",
  },
});
const td = (k, ...v) => t(`devices.${k}`, ...v);

/** A wait as words: "2 minutes" / 「2 分鐘」 (rounded up). */
export function pauseWords(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return minutes === 1 ? td("minute") : td("minutes", minutes);
}
/** The time left as m:ss. */
export function leftClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function DevicesCard() {
  const [s, setS] = useState(null);
  // step: "code" (type it) | "confirm" (who is asking) | "done" (what happened). `msg`: a line under the field.
  const [dlg, setDlg] = useState(null), [code, setCode] = useState(""), [msg, setMsg] = useState(""), [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now());
  const live = useRef({ mounted: true });
  const load = async () => {
    let r = null;
    try { r = await api("/ui/devices"); } catch { r = null; }
    if (live.current.mounted && r && r.ok && r.body && typeof r.body === "object") setS(r.body);
  };
  useEffect(() => { live.current.mounted = true; load(); return () => { live.current.mounted = false; }; }, []);
  // The confirm screen counts down; a request that ran out goes back to the field with the reason.
  const step = dlg && dlg.step, expiresAt = dlg && dlg.request && dlg.request.expiresAt;
  useEffect(() => {
    if (step !== "confirm") return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step]);
  useEffect(() => {
    if (step === "confirm" && expiresAt && now >= expiresAt) { setDlg({ step: "code" }); setMsg(td("expired")); }
  }, [now, step, expiresAt]);
  if (!s || !s.webOnly) return null;

  const close = () => { setDlg(null); setCode(""); setMsg(""); };
  // A button the page disabled never reaches here in a browser; the guard is for anything that calls it anyway (the server refuses a non-owner regardless).
  const open = () => { if (!s.owner) return; setDlg({ step: "code" }); setCode(""); setMsg(""); setNow(Date.now()); };
  // What the server said, as a line for the person (a code that names nothing, a pause, an ended authority…).
  const reason = (r) => {
    const why = r.body && r.body.error;
    if (r.status === 404) return td("notFound");
    if (r.status === 429) return td("paused", pauseWords(Number(r.body && r.body.retryAfterMs) || 60000));
    if (r.status === 409 || why === "already_decided") return td("decided");
    if (r.status === 403) return td("lostOwner");
    return t("app.failed");
  };
  const post = async (op, body) => {
    setBusy(true); setMsg("");
    try { return await api(`/ui/devices/${op}`, { method: "POST", body: JSON.stringify(body) }); }
    catch { return { ok: false, status: 0, body: null }; }
    finally { if (live.current.mounted) setBusy(false); }
  };
  const find = async () => {
    const r = await post("lookup", { code });
    if (!live.current.mounted) return;
    if (r.ok && r.body && r.body.request) { setNow(Date.now()); setDlg({ step: "confirm", request: r.body.request }); return; }
    setMsg(reason(r));
    if (r.status === 403) load();
  };
  const decide = async (op) => {
    const r = await post(op, { code: dlg.request.code });
    if (!live.current.mounted) return;
    if (r.ok) { setDlg({ step: "done", outcome: op }); return; }
    setDlg({ step: "code" }); setMsg(reason(r));
    if (r.status === 403) load();
  };

  const request = dlg && dlg.request;
  const body = !dlg ? null : dlg.step === "code" ? html`
      <p class="note" id="devLead">${td("dlgLead")}</p>
      <div class="field"><label for="devCodeInput">${td("codeLabel")}</label>
        <input id="devCodeInput" class="s-dev-code" type="text" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck=${false}
          maxlength="12" placeholder="XXXX-XXXX" value=${code} onInput=${(e) => { setCode(e.target.value); setMsg(""); }} /></div>
      ${msg ? html`<p class="feedback error" role="alert" id="devMsg">${msg}</p>` : null}`
    : dlg.step === "confirm" ? html`
      <p class="note" id="devConfirmLead">${td("confirmTitle")}</p>
      <dl class="s-dev-facts" id="devFacts">
        <div><dt>${td("device")}</dt><dd id="devLabel">${request.label}</dd></div>
        <div><dt>${td("code")}</dt><dd><code id="devCodeShown">${request.code}</code></dd></div>
        <div><dt>${td("from")}</dt><dd id="devFrom">${td(request.peer === "host" ? "fromHost" : "fromNetwork")}</dd></div>
        <div><dt>${td("address")}</dt><dd id="devAddress">${request.address}</dd></div>
        <div><dt>${td("left")}</dt><dd id="devLeft">${leftClock(request.expiresAt - now)}</dd></div>
      </dl>
      <p class="note" id="devGrants">${td("grants")}</p>
      <p class="note" id="devNoCopy">${td("noCopy")}</p>`
    : html`<p class="note" role="status" id="devDone">${td(dlg.outcome === "approve" ? "approved" : "denied")}</p>`;
  const actions = !dlg ? null : dlg.step === "code" ? html`
      <button type="button" class="btn" id="devCancel" disabled=${busy} onClick=${close}>${t("app.cancel")}</button>
      <button type="button" class="btn btn-primary" id="devFind" disabled=${busy || code.replace(/[^0-9A-Za-z]/g, "").length < 8} onClick=${find}>${td("find")}</button>`
    : dlg.step === "confirm" ? html`
      <button type="button" class="btn" id="devBack" disabled=${busy} onClick=${() => { setDlg({ step: "code" }); setMsg(""); }}>${td("back")}</button>
      <button type="button" class="btn btn-danger" id="devDeny" disabled=${busy} onClick=${() => decide("deny")}>${td("deny")}</button>
      <button type="button" class="btn btn-primary" id="devAllow" disabled=${busy} onClick=${() => decide("approve")}>${td("allow")}</button>`
    : html`<button type="button" class="btn btn-primary" id="devDoneBtn" onClick=${close}>${td("done")}</button>`;
  return html`<section class="card s-devices" id="devicesCard"><header class="s-auth-section-head"><div><h3>${td("title")}</h3><p id="devicesLead">${td("lead")}</p></div></header>
    <p class="note" id="devicesNoCopy">${td("noCopy")}</p>
    ${!s.owner ? html`<p class="note" id="devicesOwnerOnly">${td("ownerOnly")}</p>` : null}
    <div class="save-row"><button type="button" class="btn btn-primary" id="devicesAdd" disabled=${!s.owner} onClick=${open}>${td("add")}</button></div>
    ${dlg ? html`<${Dialog} title=${td("dlgTitle")} onClose=${close} busy=${busy} actions=${actions}>${body}</${Dialog}>` : null}
  </section>`;
}
