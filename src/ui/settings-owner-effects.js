// #1629: authoritative selectors and local slot controls; the app owns all playback and resource reads.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { useStore } from "/assets/app-store.js";
import { OWNER_EFFECT_PREF_KEYS } from "/assets/app-prefs.js";
import { getAppEffects, wakeEffects } from "./effects-waker.js";
import { ownerEffectsStore, watchOwnerEffects, refreshOwnerEffects, saveOwnerEffects } from "/assets/owner-effect-prefs.js";
register("ownerEffects", {
  en: {
    title: "Your effect choices", operatorTitle: "Host-wide effect choices", person: "Follows your sign-in; Discord and Telegram are separate.",
    operator: "Shared by everyone signed in as the host.",
    sidebar: "Sidebar", header: "Header", page: "Page", box: "Box", cursor: "Cursor", none: "None", savedChoice: "Saved choice",
    unknown: "Choices are unavailable. Reload to try again.", changed: "This page can no longer access these choices. Reload and sign in again.",
    unavailable: "No longer available", clear: "Clear", reload: "Reload choices", saved: "Saved.", failed: "Couldn't save. Reload choices and try again.",
    savedRefresh: "Saved, but the choices couldn't be refreshed. Reload to check.", readOnly: "Sign in as an admin to change these choices.",
    playback: "Effects don't require HTML-preview permission.",
    pause: "Pause", resume: "Resume", running: "Running", cursorFailed: "The cursor could not be applied here. Clear or reload the choice to try again.", starting: "Starting", queued: "Waiting for a slot", paused: "Paused", off: "Playback is off or unavailable here.", budget: "Paused to keep the page responsive.", resumeFailed: "This effect cannot resume: the page or its safety history is not ready. Reload the page or choose another effect.",
  },
  "zh-TW": {
    title: "你的效果選擇", operatorTitle: "主機共用效果選擇", person: "跟隨你的登入身分；Discord 與 Telegram 各自獨立。",
    operator: "所有以主機身分登入的人共用。",
    sidebar: "側邊欄", header: "頁首", page: "頁面", box: "區塊", cursor: "游標", none: "無", savedChoice: "已儲存的選擇",
    unknown: "目前無法取得選擇，請重新載入再試。", changed: "這個頁面已無法存取選擇，請重新載入並登入。",
    unavailable: "已無法使用", clear: "清除", reload: "重新載入選擇", saved: "已儲存。", failed: "無法儲存，請重新載入選擇再試。",
    savedRefresh: "已儲存，但無法更新畫面；請重新載入確認。", readOnly: "請以管理員身分登入才能修改選擇。",
    playback: "效果不需要 HTML 預覽權限。",
    pause: "暫停", resume: "恢復", running: "播放中", cursorFailed: "這裡無法套用游標。可清除或重新載入選擇後再試。", starting: "啟動中", queued: "等待空位", paused: "已暫停", off: "這裡已關閉播放，或無法播放效果。", budget: "為維持頁面順暢，已暫停。", resumeFailed: "頁面或安全紀錄尚未就緒，無法恢復此效果。請重新載入頁面，或選擇其他效果。",
  },
});
const text = key => t(`ownerEffects.${key}`);
export function ownerEffectFits(manifest, key) {
  if (!manifest || typeof manifest !== "object" || !OWNER_EFFECT_PREF_KEYS.includes(key)) return false;
  if (key === "fx.cursor") return !!manifest.cursor;
  const region = key.slice(3);
  return Array.isArray(manifest.regions) && manifest.regions.includes(region) && (region !== "box" || !!manifest.box);
}
export function OwnerEffects({ catalog, busy = false }) {
  const state = useStore(ownerEffectsStore), [message, setMessage] = useState(null), life = useRef({ alive: false, seq: 0 }), [runtime, setRuntime] = useState(null);
  useEffect(() => { life.current.alive = true; const stop = watchOwnerEffects(); return () => { life.current.alive = false; life.current.seq++; stop(); }; }, []);
  useEffect(() => {
    // #2193: managing personal effects needs the runtime's view of them: it is woken here (it may still be asleep).
    let live = true, entry = getAppEffects(), off = null, end = null;
    const pull = () => { if (!live) return; const gates = entry?.gates(); setRuntime({ entry, snapshot: entry?.api?.ownerSnapshot?.(), cursor: entry?.cursorSnapshot?.(), available: !!entry && !entry.dead && gates.enabled && gates.show && gates.transportReady && !gates.safe && !gates.publicLink && !gates.reducedMotion }); };
    const bind = () => { off = entry?.subscribe(pull) ?? null; end = entry?.onEnd(pull) ?? null; pull(); };
    if (entry) bind(); else { pull(); void wakeEffects().then(() => { if (!live) return; entry = getAppEffects(); bind(); }); }
    return () => { live = false; off?.(); end?.(); };
  }, []);
  const reload = () => { getAppEffects()?.api?.changedOwner?.(); return refreshOwnerEffects(); };
  // Library reloads/own share changes can alter availability without changing the preference revision.
  useEffect(() => { if (catalog) reload(); }, [catalog]);
  if (state.scope === "none") return null;
  const disabled = busy || state.busy || state.status !== "known" || state.revoked || !catalog?.canWrite;
  const save = async (key, id) => {
    if (disabled || !life.current.alive) return;
    if (id !== null && !(catalog.effects || []).some(e => e.id === id && ownerEffectFits(e.manifest, key))) return;
    const seq = ++life.current.seq; setMessage(null);
    const result = await saveOwnerEffects({ [key]: id });
    if (!life.current.alive || seq !== life.current.seq) return;
    if (result.ok || result.saved) getAppEffects()?.api?.changedOwner?.();   // #2193: asleep, the saved slot wakes it (app-prefs)
    setMessage(text(result.ok ? "saved" : result.saved ? "savedRefresh" : "failed"));
  };
  return html`<section class="s-fx-owner" aria-label=${text(state.scope === "operator" ? "operatorTitle" : "title")}><h4>${text(state.scope === "operator" ? "operatorTitle" : "title")}</h4><p class="sub">${text(state.scope === "operator" ? "operator" : "person")}</p>
    <p class="sub">${text("playback")}</p>${catalog && !catalog.canWrite ? html`<p class="sub">${text("readOnly")}</p>` : null}
    <button class="btn" type="button" disabled=${busy || state.busy || state.revoked} onClick=${reload}>${text("reload")}</button>
    ${state.status !== "known" ? html`<p class="sub" role="status">${text(state.revoked ? "changed" : "unknown")}</p>` : OWNER_EFFECT_PREF_KEYS.map(key => {
      const row = state.slots[key], options = (catalog?.effects || []).filter(e => ownerEffectFits(e.manifest, key));
      const absent = !!row.id && !options.some(e => e.id === row.id);
      const play = runtime?.snapshot?.rows?.find(r => r.slot === key && r.id === row.id);
      const unavailable = row.status === "unavailable" || runtime?.snapshot?.slots?.[key]?.id === row.id && runtime.snapshot.slots[key].status === "unavailable";
      const phase = !runtime?.available ? "off" : play?.reason === "paused" || play?.reason === "host_budget" ? "paused" : play?.phase === "running" ? "running" : play?.phase ? "starting" : play?.verdict === "queued" ? "queued" : "off";
      return html`<div class="s-fx-owner-row" key=${key}><label>${text(key.slice(3))}<select class="s-fx-target" data-owner-slot=${key} disabled=${disabled} value=${row.id || ""} onChange=${e => save(key, e.target.value || null)}>
        <option value="">${text("none")}</option>${absent ? html`<option value=${row.id} disabled>${text(row.status === "unavailable" ? "unavailable" : "savedChoice")}</option>` : null}
        ${options.map(e => html`<option key=${e.id} value=${e.id}>${e.manifest.title}</option>`)}</select></label>
        ${unavailable ? html`<span class="sub" role="status">${text("unavailable")}</span>` : null}
        ${key === "fx.cursor" && row.status === "available" && row.id && !unavailable ? html`<span class="sub" role="status" data-owner-runtime=${key}>${text(!runtime?.available ? "off" : runtime.cursor?.id === row.id && runtime.cursor.status === "running" ? "running" : runtime.cursor?.id === row.id && runtime.cursor.status === "loading" ? "starting" : runtime.cursor?.id === row.id && runtime.cursor.status === "unavailable" ? "cursorFailed" : "off")}</span>` : null}
        ${key !== "fx.cursor" && row.status === "available" && row.id && !unavailable ? html`<span class="sub" role="status" data-owner-runtime=${key}>${text(phase)}</span>
          ${play?.reason === "host_budget" ? html`<span class="sub">${text("budget")}</span>` : null}
          <button class="btn" type="button" data-owner-pause=${key} disabled=${!runtime?.available || !play} onClick=${() => runtime?.entry?.api?.pauseOwner?.(key)}>${text("pause")}</button>
          <button class="btn" type="button" data-owner-resume=${key} disabled=${!runtime?.available || !play} onClick=${() => { if (!runtime?.entry?.api?.resumeOwner?.(key)) setMessage(text("resumeFailed")); }}>${text("resume")}</button>` : null}
        ${row.id ? html`<button class="btn" type="button" data-owner-clear=${key} disabled=${disabled} onClick=${() => save(key, null)}>${text("clear")}</button>` : null}</div>`;
    })}${message ? html`<p class="sub" role="status">${message}</p>` : null}</section>`;
}
