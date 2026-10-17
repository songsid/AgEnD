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
  en: { title: "Effects", loading: "Checking effects…", empty: "No effects in this chat.", failed: "Effects stopped because their resources could not be verified. Reload the page to try again.", reload: "Reload page", pause: "Pause", resume: "Resume", remove: "Remove from chat", removeFailed: "Could not remove this effect. Reload the page to check its state.", css: "Agent foreground effects are paused while your custom CSS is on or cannot be verified.", setting: "Open Web appearance settings", running: "Running", starting: "Starting", off: "Stopped", resumeFailed: "This effect cannot resume: the page or its safety history is not ready. Reload the page or choose another effect.", queued: "Waiting for a slot", unknown: "Playback is off or unavailable here.", budget: "Paused to protect page responsiveness. Resume keeps the three-pauses safety limit.", paused: "Paused", low: "Reduced quality" },
  "zh-TW": { title: "效果", loading: "正在確認效果…", empty: "這個聊天沒有放置效果。", failed: "無法確認效果資源，已停止播放。重新載入頁面後再試。", reload: "重新載入頁面", pause: "暫停", resume: "恢復", remove: "從聊天移除", removeFailed: "無法移除效果。請重新載入頁面確認狀態。", css: "自訂 CSS 開啟或無法確認時，代理的前景效果會暫停。", setting: "開啟網頁外觀設定", running: "播放中", starting: "啟動中", off: "已停止", resumeFailed: "頁面或安全紀錄尚未就緒，無法恢復此效果。請重新載入頁面，或選擇其他效果。", queued: "等待空位", unknown: "這裡已關閉播放，或無法播放效果。", budget: "為維持頁面順暢，已暫停效果。恢復仍保留三次暫停的安全上限。", paused: "已暫停", low: "降低畫質" },
});

/** Local read/admin sessions keep controls; public, View, poll and header-only pages have no runtime identity. */
export function chatEffectsMenuAvailable() { return chatEffectIdentity(window) !== null; }

export function ChatEffects({ name, lease, element, store, open, onClose }) {
  const cssLife = useStore(ownerCssLifecycle);
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
      const changed = value => {
        if (!current()) return;
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
  const css = cssLife.state !== "off" && effects.some(p => p.by !== "human" && p.manifest.layer === "front");
  const remove = async id => { if (busy) return; setBusy(true); const api = runtime.current; const ok = await api?.remove?.(id); if (!lease.current() || runtime.current !== api) return; setBusy(false); if (!ok) toast(t("chatFx.removeFailed"), false); };
  return html`${open ? html`<${Dialog} title=${t("chatFx.title")} onClose=${onClose} busy=${busy}>
      ${state?.error ? html`<p>${t("chatFx.failed")}</p><button type="button" class="btn" onClick=${() => location.reload()}>${t("chatFx.reload")}</button>` : null}
      ${css ? html`<p>${t("chatFx.css")}</p><button type="button" class="btn" onClick=${() => { onClose(); navigate("/settings/appearance"); }}>${t("chatFx.setting")}</button>` : null}
      ${!effects.length && !state?.error ? html`<p>${t(state?.unavailable ? "chatFx.unknown" : state?.loading || !state ? "chatFx.loading" : "chatFx.empty")}</p>` : null}
      ${effects.map(p => { const row = rows.find(r => r.id === p.id), phase = row?.phase; return html`<section key=${p.id}><h3>${p.manifest.title}</h3><p>${t(row?.reason === "paused" || row?.reason === "host_budget" ? "chatFx.paused" : phase === "running" ? "chatFx.running" : phase ? "chatFx.starting" : row?.verdict === "queued" ? "chatFx.queued" : "chatFx.off")}${row?.quality === "low" ? ` · ${t("chatFx.low")}` : ""}</p>
        ${row?.reason === "host_budget" ? html`<p>${t("chatFx.budget")}</p>` : null}
        <button type="button" class="btn" disabled=${busy} onClick=${() => runtime.current?.pause?.(p.id)}>${t("chatFx.pause")}</button>
        <button type="button" class="btn" disabled=${busy} onClick=${() => { if (!runtime.current?.resume?.(p.id)) toast(t("chatFx.resumeFailed"), false); }}>${t("chatFx.resume")}</button>
        ${canWrite ? html`<button type="button" class="btn" disabled=${busy} onClick=${() => remove(p.id)}>${t("chatFx.remove")}</button>` : null}</section>`; })}
    </${Dialog}>` : null}`;
}
