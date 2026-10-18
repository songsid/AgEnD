// #1629: Chat contributes a committed lease to the one app owner; no private pool or server polling.
import { html, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { ownerCssLifecycle } from "/assets/owner-css.js";
import { chatEffectState, chatEffectIdentity } from "/assets/effect-chat-runtime.js";
import { Dialog } from "/assets/ui-dialog.js";
import { navigate } from "/assets/app-nav.js";
import { toast } from "/assets/ui-toast.js";
import { setThemesShown, themesShown, themesStore } from "/assets/app-themes.js";
import { getAppEffects } from "./app-effects.js";

register("chatFx", {
  en: { transport: "Off: the isolated effect frame could not start. Reload to try again.", enableHere: "Turn effects on here", viewerShow: "Show themes, effects and widgets here", clock: "Off: the page timing clock is unavailable. Reload to try again.", gatesUnknown: "Off: the playback conditions could not be verified.", resource: "Off: this effect could not be loaded or verified. Reload to try again.", frontQueue: "Waiting for a foreground slot.", consent: "This page has older playback information. Reload to use the isolated effect player.", previewMissing: "Off: the isolated effect frame is unavailable. Reload to try again.", unsupported: "Off: this browser lacks required Canvas Worker or layout support.", calibration: "Measuring this page's frame rate before playback.", baseline: "Off: this page's frame-rate calibration failed. Reload to try again.", safetyUnknown: "Stopped: this device's safety history could not be verified. Reload to check it.", rawReason: "Playback blocked: {0}", missingRow: "Playback state is unavailable (runtime_unavailable).", region: "Off: this effect does not declare the chat region.", blocked: "Placed effects are blocked for this viewer:", deviceSetting: "Open device preferences", webSetting: "Open Web settings", reloadHint: "Reload page", consentHint: "Allow HTML previews in device preferences.",
    title: "Effects", loading: "Checking effects…", empty: "No effects in this chat.", failed: "Effects stopped because their resources could not be verified. Reload the page to try again.", reload: "Reload page", pause: "Pause", resume: "Resume", remove: "Remove from chat", removeFailed: "Could not remove this effect. Reload the page to check its state.", css: "Agent foreground effects are paused while your custom CSS is on or cannot be verified.", setting: "Open Web appearance settings", running: "Running", starting: "Starting", off: "Stopped", resumeFailed: "This effect cannot resume: the page or its safety history is not ready. Reload the page or choose another effect.", queued: "Waiting for a slot", unknown: "Playback is off or unavailable here.", budget: "Paused to protect page responsiveness. Resume keeps the three-pauses safety limit.", paused: "Paused", low: "Reduced quality",
    typing: "Waiting while you type — it plays when you leave the message box.", covered: "Waiting while a menu or panel covers the chat.",
    dialogOpen: "Paused while this dialog is open.", wasRunning: "Was running; paused while this dialog is open.", modal: "Waiting while a dialog is open.",
    off3: "Turned off on this device after three automatic pauses. Resume cannot restart it here.", interrupted: "Stopped: the page closed while it was playing. Resume to play it again.",
    cssOff: "Off while your custom CSS is on.", reducedMotion: "Off: this device asks for reduced motion.", saveData: "Off: data saver is on.",
    previewOff: "Off: previews are not allowed on this device.", hiddenTab: "Waiting until this tab is visible.", offscreen: "Waiting until the chat is on screen.",
    safeMode: "Off in safe mode.", publicLink: "Off on a public link.", disabled: "Effects are switched off." },
  "zh-TW": { transport: "已關閉：無法啟動隔離效果框架。請重新載入再試。", enableHere: "在這裡開啟效果", viewerShow: "在這裡顯示主題、效果與小工具", clock: "已關閉：頁面計時無法使用。請重新載入再試。", gatesUnknown: "已關閉：無法確認播放條件。", resource: "已關閉：無法載入或驗證此效果。請重新載入再試。", frontQueue: "等待前景空位。", consent: "這個頁面的播放資訊已過期。請重新載入以使用隔離效果播放器。", previewMissing: "已關閉：隔離效果框架無法使用。請重新載入再試。", unsupported: "已關閉：這個瀏覽器缺少 Canvas Worker 或版面驗證支援。", calibration: "正在量測頁面影格率，完成後才開始播放。", baseline: "已關閉：頁面影格率校準失敗。請重新載入再試。", safetyUnknown: "已停止：無法確認這台裝置的安全紀錄。請重新載入確認。", rawReason: "播放受阻：{0}", missingRow: "無法取得播放狀態（runtime_unavailable）。", region: "已關閉：此效果未宣告聊天區域。", blocked: "放置的效果目前無法在這個畫面播放：", deviceSetting: "開啟裝置偏好設定", webSetting: "開啟網頁設定", reloadHint: "重新載入頁面", consentHint: "請在裝置偏好設定允許 HTML 預覽。",
    title: "效果", loading: "正在確認效果…", empty: "這個聊天沒有放置效果。", failed: "無法確認效果資源，已停止播放。重新載入頁面後再試。", reload: "重新載入頁面", pause: "暫停", resume: "恢復", remove: "從聊天移除", removeFailed: "無法移除效果。請重新載入頁面確認狀態。", css: "自訂 CSS 開啟或無法確認時，代理的前景效果會暫停。", setting: "開啟網頁外觀設定", running: "播放中", starting: "啟動中", off: "已停止", resumeFailed: "頁面或安全紀錄尚未就緒，無法恢復此效果。請重新載入頁面，或選擇其他效果。", queued: "等待空位", unknown: "這裡已關閉播放，或無法播放效果。", budget: "為維持頁面順暢，已暫停效果。恢復仍保留三次暫停的安全上限。", paused: "已暫停", low: "降低畫質",
    typing: "輸入時暫停，離開訊息輸入框就會播放。", covered: "選單或面板蓋住聊天時暫停。",
    dialogOpen: "開著這個對話框時暫停。", wasRunning: "原本在播放；開著這個對話框時暫停。", modal: "有對話框開著時暫停。",
    off3: "已自動暫停三次，這台裝置已關閉此效果，無法在這裡恢復。", interrupted: "播放時頁面被關閉而停止。按「恢復」再播放一次。",
    cssOff: "自訂 CSS 開啟時關閉。", reducedMotion: "已關閉：這台裝置要求減少動態效果。", saveData: "已關閉：數據節省模式開啟中。",
    previewOff: "已關閉：這台裝置不允許預覽。", hiddenTab: "等這個分頁顯示時再播放。", offscreen: "等聊天顯示在畫面上時再播放。",
    safeMode: "安全模式下關閉。", publicLink: "公開連結上關閉。", disabled: "效果已關閉。" },
});

/** Read/admin dashboard sessions keep management controls; public/guest Chat playback has no owner identity. */
export function chatEffectsMenuAvailable() { return chatEffectIdentity(window) !== null; }

// #2055: what a row's state means, in words — never only "Stopped" when the runtime knows why.
const RECENT_MS = 5000;
const REASON_KEY = { __proto__: null, transport_unavailable: "chatFx.transport", owner_css: "chatFx.cssOff", reduced_motion: "chatFx.reducedMotion", save_data: "chatFx.saveData", preview_unavailable: "chatFx.previewMissing", preview_not_consented: "chatFx.consent", unsupported_host: "chatFx.unsupported", registry_unsupported: "chatFx.unsupported",
  baseline_unsupported: "chatFx.baseline", baseline_unavailable: "chatFx.baseline", baseline_timeout: "chatFx.baseline", calibrating: "chatFx.calibration", safety_unknown: "chatFx.safetyUnknown", region_unavailable: "chatFx.region",
  hidden: "chatFx.hiddenTab", offscreen: "chatFx.offscreen", safe_mode: "chatFx.safeMode", public_link: "chatFx.publicLink", disabled: "chatFx.disabled",
  clock_unavailable: "chatFx.clock", gates_unknown: "chatFx.gatesUnknown", runtime_unavailable: "chatFx.missingRow", resource_unavailable: "chatFx.resource", resource_timeout: "chatFx.resource", front_limit: "chatFx.frontQueue",
  safety_off: "chatFx.off3", interrupted: "chatFx.interrupted" };
/** `ownOpen`: this Effects dialog is open; `wasRunning`: the effect was running when it opened (shown as past, never as current). */
export function effectRowText(row, { ownOpen = false, wasRunning = false, doc = typeof document === "undefined" ? null : document } = {}) {
  if (!row) return t("chatFx.missingRow");
  // The sticky history first (it is what Resume answers), then a pause, then what is playing or queued.
  if (row.reason === "safety_off" || row.reason === "interrupted") return t(REASON_KEY[row.reason]);
  if (row.reason === "paused" || row.reason === "host_budget") return t("chatFx.paused");
  if (REASON_KEY[row.reason]) return t(REASON_KEY[row.reason]);
  if (row.reason != null && !["stock_overlay", "modal", "frame_limit"].includes(row.reason))
    return t("chatFx.rawReason", typeof row.reason === "string" ? row.reason.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80) : "unknown");
  if (row.phase === "running") return t("chatFx.running");
  if (row.phase) return t("chatFx.starting");
  if (row.verdict === "queued") return t("chatFx.queued");
  if (row.reason === "stock_overlay" || row.reason === "modal") {
    if (ownOpen) return t(wasRunning ? "chatFx.wasRunning" : "chatFx.dialogOpen");
    if (row.reason === "modal") return t("chatFx.modal");
    return t("chatFx.covered");
  }
  return t("chatFx.rawReason", typeof row.reason === "string" ? row.reason.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80) : "unknown");
}

/** Fixed local actions: no server/Worker-provided destination or raw reason in a URL. */
export function effectReasonAction(reason) {
  if (reason === "preview_not_consented" || reason === "preview_unavailable") return { reload: true, label: "chatFx.reloadHint" };
  if (["disabled", "owner_css"].includes(reason)) return { href: "/settings/appearance", label: "chatFx.setting" };
  if (["transport_unavailable", "baseline_unsupported", "baseline_unavailable", "baseline_timeout", "runtime_unavailable", "resource_unavailable", "resource_timeout", "clock_unavailable", "safety_unknown"].includes(reason)) return { reload: true, label: "chatFx.reloadHint" };
  return null;
}
const localViewer = () => document.body.dataset.publicLink === "1" || document.body.dataset.tier === "guest";
function ReasonAction({ reason, onClose = () => {} }) {
  if (reason === "disabled" && localViewer()) return html`<button type="button" class="btn" onClick=${() => { onClose(); setThemesShown(true); }}>${t("chatFx.enableHere")}</button>`;
  const action = document.body.dataset.tier === "guest" && reason === "owner_css" ? { reload: true, label: "chatFx.reloadHint" } : effectReasonAction(reason);
  return action ? html`<button type="button" class="btn" onClick=${() => { onClose(); if (action.reload) location.reload(); else navigate(action.href); }}>${t(action.label)}</button>` : null;
}

export function ChatEffects({ name, lease, element, store, open, onClose }) {
  const cssLife = useStore(ownerCssLifecycle);
  useStore(themesStore); // Viewer-local off/on is visible immediately, independent of runtime callbacks.
  // Which effects were running just before this dialog opened ("was running" is said in the past, never shown as
  // current). The ⋯ menu that opens it is a barrier too, so "just before" is within RECENT_MS of the observed stop.
  // Tracked where updates arrive (an unchanged snapshot is not republished while an effect keeps running).
  const before = useRef(null), wasOpen = useRef(false), playing = useRef(new Map());
  const runtime = useRef(null), [state, setState] = useState(null), [canWrite, setCanWrite] = useState(false), [busy, setBusy] = useState(false);
  useLayoutEffect(() => {
    let live = true, api = null;
    const releases = [];
    // Effects are optional: a failed setup must release its partial ownership without breaking Chat.
    const cleanup = () => {
      if (!live) return;
      live = false;
      try { api?.dispose?.(); } catch { /* continue releasing partial setup */ }
      for (const off of releases) { try { if (typeof off === "function") off(); } catch { /* release the rest */ } }
      if (runtime.current === api) runtime.current = null;
    };
    lease.hold(cleanup);
    try {
      setBusy(false); onClose(); setCanWrite(false); setState(null);
      const host = window, owner = getAppEffects(host);
      const current = () => live && lease.current();
      if (!owner) { setState({ error: null, rows: [], effects: [], unavailable: true, reason: typeof host.OffscreenCanvas !== "function" || typeof host.Worker !== "function" ? "unsupported_host" : "runtime_unavailable" }); return cleanup; }
      releases.push(owner.onEnd(() => { if (current()) setState({ error: "resource_unavailable", rows: [], effects: [], unavailable: true }); }));
      playing.current = new Map();   // evidence belongs to this name and lease only
      const track = rows => {
        const now = performance.now(), seen = new Set();
        for (const r of Array.isArray(rows) ? rows : []) {
          seen.add(r.id);
          if (r.phase === "running") playing.current.set(r.id, null);
          else if (playing.current.get(r.id) === null) playing.current.set(r.id, now);
        }
        for (const [id, at] of playing.current) if (!seen.has(id) && at === null) playing.current.set(id, now);
      };
      const changed = value => {
        if (!current()) return;
        track(value?.rows);
        const g = owner.gates();
        setState({ ...value, unavailable: !g.enabled || !g.show || !g.transportReady || g.safe || g.reducedMotion || g.saveData });
      };
      api = owner.attachChat({ name, element: element.current, current,
        observe: () => ({ state: chatEffectState(appStore.get(), name) }), onChange: changed });
      runtime.current = api;
      if (!api?.ok) { setState({ error: null, rows: [], effects: [], unavailable: true, reason: "runtime_unavailable" }); return cleanup; }
      if (chatEffectIdentity(host)) host.AgendAuth?.canWrite?.().then(value => { if (current()) setCanWrite(value === true); }).catch(() => {});
      api.sync();
      return cleanup;
    } catch {
      cleanup();
      if (lease.current()) setState({ error: "runtime_unavailable", rows: [], effects: [] });
      return cleanup;
    }
  }, [name, lease]);
  const rows = state?.rows ?? [], effects = state?.effects ?? [];
  if (open && !wasOpen.current) {
    const now = performance.now();
    before.current = new Map([...playing.current].map(([id, stoppedAt]) => [id, stoppedAt === null || now - stoppedAt < RECENT_MS]));
  }
  if (!open) before.current = null;
  wasOpen.current = open;
  const css = cssLife.state !== "off" && effects.some(p => p.by !== "human" && p.manifest.layer === "front");
  const remove = async id => { if (busy) return; setBusy(true); const api = runtime.current; const ok = await api?.remove?.(id); if (!lease.current() || runtime.current !== api) return; setBusy(false); if (!ok) toast(t("chatFx.removeFailed"), false); };
  const blocked = effects.flatMap(p => { const row = rows.find(r => r.id === p.id); return row?.phase === "running" && row.reason == null ? [] : [{ p, row }]; });
  return html`${!open && localViewer() && effects.length ? html`<div class="chat-fx-notice"><label><input type="checkbox" checked=${themesShown()} onChange=${e => setThemesShown(e.currentTarget.checked)} /> ${t("chatFx.viewerShow")}</label></div>` : null}${!open && state?.error && !effects.length ? html`<div class="chat-fx-notice" role="status">${effectRowText({ reason: state.error })} <${ReasonAction} reason=${state.error} /></div>` : null}${!open && state?.reason ? html`<div class="chat-fx-notice" role="status">${effectRowText({ reason: state.reason })} <${ReasonAction} reason=${state.reason} /></div>` : null}${!open && blocked.length ? html`<div class="chat-fx-notice" role="status"><strong>${t("chatFx.blocked")}</strong>
    ${blocked.map(({ p, row }) => html`<span key=${p.id}>${p.manifest.title}: ${effectRowText(row)} <${ReasonAction} reason=${row?.reason} /></span>`)}</div>` : null}${open ? html`<${Dialog} title=${t("chatFx.title")} onClose=${onClose} busy=${busy}>
      ${state?.error ? html`<p>${t("chatFx.failed")}</p><button type="button" class="btn" onClick=${() => location.reload()}>${t("chatFx.reload")}</button>` : null}
      ${css ? html`<p>${t("chatFx.css")}</p><button type="button" class="btn" onClick=${() => { onClose(); navigate("/settings/appearance"); }}>${t("chatFx.setting")}</button>` : null}
      ${!effects.length && !state?.error ? html`<p>${t(state?.unavailable ? "chatFx.unknown" : state?.loading || !state ? "chatFx.loading" : "chatFx.empty")}</p>` : null}
      ${effects.map(p => { const row = rows.find(r => r.id === p.id); return html`<section key=${p.id}><h3>${p.manifest.title}</h3><p>${effectRowText(row, { ownOpen: open, wasRunning: before.current?.get(p.id) === true })}${row?.quality === "low" ? ` · ${t("chatFx.low")}` : ""}</p>
        <${ReasonAction} reason=${row?.reason} onClose=${onClose} />
        ${row?.reason === "host_budget" ? html`<p>${t("chatFx.budget")}</p>` : null}
        <button type="button" class="btn" disabled=${busy} onClick=${() => runtime.current?.pause?.(p.id)}>${t("chatFx.pause")}</button>
        <button type="button" class="btn" disabled=${busy} onClick=${() => { if (!runtime.current?.resume?.(p.id)) toast(t(rows.find(r => r.id === p.id)?.reason === "safety_off" ? "chatFx.off3" : "chatFx.resumeFailed"), false); }}>${t("chatFx.resume")}</button>
        ${canWrite ? html`<button type="button" class="btn" disabled=${busy} onClick=${() => remove(p.id)}>${t("chatFx.remove")}</button>` : null}</section>`; })}
    </${Dialog}>` : null}`;
}
