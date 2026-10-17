// #1629: Chat contributes a committed lease to the one app owner; no private pool or server polling.
import { html, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { ownerCssLifecycle } from "/assets/owner-css.js";
import { chatEffectState, chatEffectIdentity } from "/assets/effect-chat-runtime.js";
import { Dialog } from "/assets/ui-dialog.js";
import { navigate } from "/assets/app-nav.js";
import { toast } from "/assets/ui-toast.js";
import { getAppEffects } from "./app-effects.js";

register("chatFx", {
  en: { title: "Effects", loading: "Checking effects…", empty: "No effects in this chat.", failed: "Effects stopped because their resources could not be verified. Reload the page to try again.", reload: "Reload page", pause: "Pause", resume: "Resume", remove: "Remove from chat", removeFailed: "Could not remove this effect. Reload the page to check its state.", css: "Agent foreground effects are paused while your custom CSS is on or cannot be verified.", setting: "Open Web appearance settings", running: "Running", starting: "Starting", off: "Stopped", resumeFailed: "This effect cannot resume: the page or its safety history is not ready. Reload the page or choose another effect.", queued: "Waiting for a slot", unknown: "Playback is off or unavailable here.", budget: "Paused to protect page responsiveness. Resume keeps the three-pauses safety limit.", paused: "Paused", low: "Reduced quality",
    typing: "Waiting while you type — it plays when you leave the message box.", covered: "Waiting while a menu or panel covers the chat.",
    dialogOpen: "Paused while this dialog is open.", wasRunning: "Was running; paused while this dialog is open.", modal: "Waiting while a dialog is open.",
    off3: "Turned off on this device after three automatic pauses. Resume cannot restart it here.", interrupted: "Stopped: the page closed while it was playing. Resume to play it again.",
    cssOff: "Off while your custom CSS is on.", reducedMotion: "Off: this device asks for reduced motion.", saveData: "Off: data saver is on.",
    previewOff: "Off: previews are not allowed on this device.", hiddenTab: "Waiting until this tab is visible.", offscreen: "Waiting until the chat is on screen.",
    safeMode: "Off in safe mode.", publicLink: "Off on a public link.", disabled: "Effects are switched off." },
  "zh-TW": { title: "效果", loading: "正在確認效果…", empty: "這個聊天沒有放置效果。", failed: "無法確認效果資源，已停止播放。重新載入頁面後再試。", reload: "重新載入頁面", pause: "暫停", resume: "恢復", remove: "從聊天移除", removeFailed: "無法移除效果。請重新載入頁面確認狀態。", css: "自訂 CSS 開啟或無法確認時，代理的前景效果會暫停。", setting: "開啟網頁外觀設定", running: "播放中", starting: "啟動中", off: "已停止", resumeFailed: "頁面或安全紀錄尚未就緒，無法恢復此效果。請重新載入頁面，或選擇其他效果。", queued: "等待空位", unknown: "這裡已關閉播放，或無法播放效果。", budget: "為維持頁面順暢，已暫停效果。恢復仍保留三次暫停的安全上限。", paused: "已暫停", low: "降低畫質",
    typing: "輸入時暫停，離開訊息輸入框就會播放。", covered: "選單或面板蓋住聊天時暫停。",
    dialogOpen: "開著這個對話框時暫停。", wasRunning: "原本在播放；開著這個對話框時暫停。", modal: "有對話框開著時暫停。",
    off3: "已自動暫停三次，這台裝置已關閉此效果，無法在這裡恢復。", interrupted: "播放時頁面被關閉而停止。按「恢復」再播放一次。",
    cssOff: "自訂 CSS 開啟時關閉。", reducedMotion: "已關閉：這台裝置要求減少動態效果。", saveData: "已關閉：數據節省模式開啟中。",
    previewOff: "已關閉：這台裝置不允許預覽。", hiddenTab: "等這個分頁顯示時再播放。", offscreen: "等聊天顯示在畫面上時再播放。",
    safeMode: "安全模式下關閉。", publicLink: "公開連結上關閉。", disabled: "效果已關閉。" },
});

/** Local read/admin sessions keep controls; public, View, poll and header-only pages have no runtime identity. */
export function chatEffectsMenuAvailable() { return chatEffectIdentity(window) !== null; }

// #2055: what a row's state means, in words — never only "Stopped" when the runtime knows why.
const RECENT_MS = 5000;
const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable=false])";
const REASON_KEY = { owner_css: "chatFx.cssOff", reduced_motion: "chatFx.reducedMotion", save_data: "chatFx.saveData", preview_unavailable: "chatFx.previewOff",
  hidden: "chatFx.hiddenTab", offscreen: "chatFx.offscreen", safe_mode: "chatFx.safeMode", public_link: "chatFx.publicLink", disabled: "chatFx.disabled",
  safety_off: "chatFx.off3", interrupted: "chatFx.interrupted" };
/** `ownOpen`: this Effects dialog is open; `wasRunning`: the effect was running when it opened (shown as past, never as current). */
export function effectRowText(row, { ownOpen = false, wasRunning = false, doc = typeof document === "undefined" ? null : document } = {}) {
  if (!row) return t("chatFx.off");
  // The sticky history first (it is what Resume answers), then a pause, then what is playing or queued.
  if (row.reason === "safety_off" || row.reason === "interrupted") return t(REASON_KEY[row.reason]);
  if (row.reason === "paused" || row.reason === "host_budget") return t("chatFx.paused");
  if (row.phase === "running") return t("chatFx.running");
  if (row.phase) return t("chatFx.starting");
  if (row.verdict === "queued") return t("chatFx.queued");
  if (row.reason === "stock_overlay" || row.reason === "modal") {
    if (ownOpen) return t(wasRunning ? "chatFx.wasRunning" : "chatFx.dialogOpen");
    if (row.reason === "modal") return t("chatFx.modal");
    // Only a focused editable proves "typing"; a menu or another overlay is the same barrier, said generically.
    const a = doc?.activeElement;
    return t(a && a !== doc.body && typeof a.matches === "function" && (a.matches(EDITABLE) || a.isContentEditable === true) ? "chatFx.typing" : "chatFx.covered");
  }
  return REASON_KEY[row.reason] ? t(REASON_KEY[row.reason]) : t("chatFx.off");
}

export function ChatEffects({ name, lease, element, store, open, onClose }) {
  const cssLife = useStore(ownerCssLifecycle);
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
      if (!owner) { setState({ error: null, rows: [], effects: [], unavailable: true }); return cleanup; }
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
        setState({ ...value, unavailable: !g.enabled || !g.show || !g.previewReady || !g.optIn || g.safe || g.publicLink || g.reducedMotion || g.saveData });
      };
      api = owner.attachChat({ name, element: element.current, current,
        observe: () => ({ state: chatEffectState(appStore.get(), name) }), onChange: changed });
      runtime.current = api;
      if (!api?.ok) { setState({ error: null, rows: [], effects: [], unavailable: true }); return cleanup; }
      host.AgendAuth?.canWrite?.().then(value => { if (current()) setCanWrite(value === true); }).catch(() => {});
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
  return html`${open ? html`<${Dialog} title=${t("chatFx.title")} onClose=${onClose} busy=${busy}>
      ${state?.error ? html`<p>${t("chatFx.failed")}</p><button type="button" class="btn" onClick=${() => location.reload()}>${t("chatFx.reload")}</button>` : null}
      ${css ? html`<p>${t("chatFx.css")}</p><button type="button" class="btn" onClick=${() => { onClose(); navigate("/settings/appearance"); }}>${t("chatFx.setting")}</button>` : null}
      ${!effects.length && !state?.error ? html`<p>${t(state?.unavailable ? "chatFx.unknown" : state?.loading || !state ? "chatFx.loading" : "chatFx.empty")}</p>` : null}
      ${effects.map(p => { const row = rows.find(r => r.id === p.id); return html`<section key=${p.id}><h3>${p.manifest.title}</h3><p>${effectRowText(row, { ownOpen: open, wasRunning: before.current?.get(p.id) === true })}${row?.quality === "low" ? ` · ${t("chatFx.low")}` : ""}</p>
        ${row?.reason === "host_budget" ? html`<p>${t("chatFx.budget")}</p>` : null}
        <button type="button" class="btn" disabled=${busy} onClick=${() => runtime.current?.pause?.(p.id)}>${t("chatFx.pause")}</button>
        <button type="button" class="btn" disabled=${busy} onClick=${() => { if (!runtime.current?.resume?.(p.id)) toast(t(rows.find(r => r.id === p.id)?.reason === "safety_off" ? "chatFx.off3" : "chatFx.resumeFailed"), false); }}>${t("chatFx.resume")}</button>
        ${canWrite ? html`<button type="button" class="btn" disabled=${busy} onClick=${() => remove(p.id)}>${t("chatFx.remove")}</button>` : null}</section>`; })}
    </${Dialog}>` : null}`;
}
