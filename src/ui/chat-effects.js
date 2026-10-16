// #1629: actual Chat surface adapter; no global/Fleet/Settings mount, public code or idle polling.
import { html, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { onPrefsChanged, prefInForce } from "/assets/app-prefs.js";
import { resolvedMode, themesStore } from "/assets/app-themes.js";
import { ownerCssLifecycle, safeMode } from "/assets/owner-css.js";
import { constrainedDevice } from "/assets/effect-policy.js";
import { createChatEffectRuntime, chatEffectState } from "/assets/effect-chat-runtime.js";
import { Dialog } from "/assets/ui-dialog.js";
import { navigate } from "/assets/app-nav.js";
import { toast } from "/assets/ui-toast.js";

register("chatFx", {
  en: { title: "Effects", loading: "Checking effects…", empty: "No effects in this chat.", failed: "Effects stopped because their resources could not be verified. Reload the page to try again.", reload: "Reload page", pause: "Pause", resume: "Resume", remove: "Remove from chat", removeFailed: "Could not remove this effect. Reload the page to check its state.", css: "Agent foreground effects are paused while your custom CSS is on or cannot be verified.", setting: "Open Appearance settings", running: "Running", starting: "Starting", off: "Stopped", resumeFailed: "This effect cannot resume: the page or its safety history is not ready. Reload the page or choose another effect.", queued: "Waiting for a slot", unknown: "Playback is off or unavailable here.", budget: "Paused to protect page responsiveness. Resume keeps the three-pauses safety limit.", paused: "Paused", low: "Reduced quality" },
  "zh-TW": { title: "效果", loading: "正在確認效果…", empty: "這個聊天沒有放置效果。", failed: "無法確認效果資源，已停止播放。重新載入頁面後再試。", reload: "重新載入頁面", pause: "暫停", resume: "恢復", remove: "從聊天移除", removeFailed: "無法移除效果。請重新載入頁面確認狀態。", css: "自訂 CSS 開啟或無法確認時，代理的前景效果會暫停。", setting: "開啟外觀設定", running: "播放中", starting: "啟動中", off: "已停止", resumeFailed: "頁面或安全紀錄尚未就緒，無法恢復此效果。請重新載入頁面，或選擇其他效果。", queued: "等待空位", unknown: "這裡已關閉播放，或無法播放效果。", budget: "為維持頁面順暢，已暫停效果。恢復仍保留三次暫停的安全上限。", paused: "已暫停", low: "降低畫質" },
});

export function ChatEffects({ name, lease, element, store, open, onClose }) {
  const cssLife = useStore(ownerCssLifecycle);
  const runtime = useRef(null), [state, setState] = useState(null), [canWrite, setCanWrite] = useState(false), [busy, setBusy] = useState(false);
  useLayoutEffect(() => {
    let live = true;
    setBusy(false); onClose(); setCanWrite(false); setState(null);
    const host = window, preview = host.AgendPreview, releases = [];
    const current = () => live && lease.current();
    const media = host.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: true }, coarse = host.matchMedia?.("(pointer: coarse)") ?? { matches: false };
    const context = () => {
      let ready = false; try { ready = preview?.availability().ok === true; } catch { /* unavailable */ }
      return { safe: safeMode(), publicLink: document.body.dataset.publicLink === "1", reducedMotion: media.matches, saveData: navigator.connection?.saveData === true,
        hidden: document.visibilityState !== "visible", enabled: typeof host.OffscreenCanvas === "function" && typeof host.Worker === "function" && typeof host.MutationObserver === "function" && typeof host.ResizeObserver === "function", show: prefInForce("fx.show")?.value !== false, previewReady: ready,
        optIn: prefInForce("preview.optIn")?.value === true && preview?.optedIn() === true && preview?.never() !== true,
        constrained: constrainedDevice({ memory: navigator.deviceMemory, cores: navigator.hardwareConcurrency, coarse: coarse.matches, width: innerWidth }),
        modal: !!document.querySelector("dialog[open],.menu-list,.pop,[role=alertdialog],.oc-keep,.shell.sb-open"), openInstance: name };
    };
    const api = createChatEffectRuntime({ window: host, name, element: element.current, current,
      observe: () => ({ context: context(), ownerCss: ownerCssLifecycle.get().state, state: chatEffectState(appStore.get(), name), mode: resolvedMode() }),
      onChange: value => {
        if (!current()) return;
        const g = context();
        setState({ ...value, unavailable: !g.enabled || !g.show || !g.previewReady || !g.optIn || g.safe || g.publicLink || g.reducedMotion || g.saveData });
      },
    });
    runtime.current = api;
    if (!api.ok) setState(api.snapshot ? api.snapshot() : { error: null, rows: [], effects: [], unavailable: true });
    const sync = () => { if (current() && api.ok) api.sync(); };
    let revision = appStore.get().themesRev;
    releases.push(appStore.subscribe(s => {
      if (!current()) return;
      if (s.connection === "ended") { api.dispose(); setState({ error: "resource_unavailable", rows: [], effects: [] }); return; }
      if (s.themesRev !== revision) { revision = s.themesRev; api.changed?.(); } else sync();
    }), ownerCssLifecycle.subscribe(sync), themesStore.subscribe(sync), onPrefsChanged(sync), store.onAgentReply(e => api.reply?.(e)));
    if (typeof preview?.onChange === "function") releases.push(preview.onChange(sync));
    if (typeof host.AgendTheme?.onChange === "function") releases.push(host.AgendTheme.onChange(sync));
    for (const [target, type] of [[media, "change"], [coarse, "change"], [document, "visibilitychange"], [host, "resize"], [host.navigator.connection, "change"]]) {
      if (target?.addEventListener) { target.addEventListener(type, sync); releases.push(() => target.removeEventListener(type, sync)); }
    }
    // A BFCache restoration gets a fresh lease when the person reloads. Never resume an old session episode.
    // Stock proof hides immediately; this updates the stored modal gate when the real portal changes.
    let modal = context().modal;
    const barriers = typeof host.MutationObserver === "function" ? new host.MutationObserver(() => { const value = context().modal; if (value === modal) return; modal = value; sync(); }) : null;
    barriers?.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "open", "hidden", "role"] });
    releases.push(() => barriers?.disconnect());
    const pagehide = () => { api.dispose(); if (current()) setState({ error: "resource_unavailable", rows: [], effects: [] }); };
    host.addEventListener("pagehide", pagehide); releases.push(() => host.removeEventListener("pagehide", pagehide));
    host.AgendAuth?.canWrite?.().then(value => { if (current()) setCanWrite(value === true); }).catch(() => {});
    sync();
    const cleanup = () => { if (!live) return; live = false; api.dispose(); for (const off of releases) if (typeof off === "function") off(); if (runtime.current === api) runtime.current = null; };
    lease.hold(cleanup); return cleanup;
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
