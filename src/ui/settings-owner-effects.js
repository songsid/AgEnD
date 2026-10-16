// #1629: host-authoritative owner selectors only. No Worker, frame or runtime code/image fetch.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { useStore } from "/assets/app-store.js";
import { OWNER_EFFECT_PREF_KEYS } from "/assets/app-prefs.js";
import { ownerEffectsStore, watchOwnerEffects, refreshOwnerEffects, saveOwnerEffects } from "/assets/owner-effect-prefs.js";
register("ownerEffects", {
  en: {
    title: "Your effect choices", operatorTitle: "Host-wide effect choices", person: "These choices follow this platform sign-in. Discord and Telegram accounts stay separate.",
    operator: "Host-wide choices: everyone signed in as the host operator shares these slots.",
    sidebar: "Sidebar", header: "Header", page: "Page", box: "Box", cursor: "Cursor", none: "None", savedChoice: "Saved choice",
    unknown: "Choices are unavailable. Reload to try again.", changed: "This page can no longer access these choices. Reload and sign in again.",
    unavailable: "No longer available", clear: "Clear", reload: "Reload choices", saved: "Saved.", failed: "Couldn't save. Reload choices and try again.",
    savedRefresh: "Saved, but the choices couldn't be refreshed. Reload to check.", readOnly: "Sign in as an admin to change these choices.",
    deferred: "Saving a choice does not start playback yet.",
  },
  "zh-TW": {
    title: "你的效果選擇", operatorTitle: "主機共用效果選擇", person: "選擇會跟隨這個平台的登入身分；Discord 與 Telegram 帳號各自獨立。",
    operator: "主機共用選擇：所有以主機操作者身分登入的人，都會共用這些欄位。",
    sidebar: "側邊欄", header: "頁首", page: "頁面", box: "區塊", cursor: "游標", none: "無", savedChoice: "已儲存的選擇",
    unknown: "目前無法取得選擇，請重新載入再試。", changed: "這個頁面已無法存取選擇，請重新載入並登入。",
    unavailable: "已無法使用", clear: "清除", reload: "重新載入選擇", saved: "已儲存。", failed: "無法儲存，請重新載入選擇再試。",
    savedRefresh: "已儲存，但無法更新畫面；請重新載入確認。", readOnly: "請以管理員身分登入才能修改選擇。",
    deferred: "儲存選擇暫時不會開始播放效果。",
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
  const state = useStore(ownerEffectsStore), [message, setMessage] = useState(null), life = useRef({ alive: false, seq: 0 });
  useEffect(() => { life.current.alive = true; const stop = watchOwnerEffects(); return () => { life.current.alive = false; life.current.seq++; stop(); }; }, []);
  // Library reloads/own share changes can alter availability without changing the preference revision.
  useEffect(() => { if (catalog) refreshOwnerEffects(); }, [catalog]);
  if (state.scope === "none") return null;
  const disabled = busy || state.busy || state.status !== "known" || state.revoked || !catalog?.canWrite;
  const save = async (key, id) => {
    if (disabled || !life.current.alive) return;
    if (id !== null && !(catalog.effects || []).some(e => e.id === id && ownerEffectFits(e.manifest, key))) return;
    const seq = ++life.current.seq; setMessage(null);
    const result = await saveOwnerEffects({ [key]: id });
    if (!life.current.alive || seq !== life.current.seq) return;
    setMessage(text(result.ok ? "saved" : result.saved ? "savedRefresh" : "failed"));
  };
  return html`<section class="s-fx-owner" aria-label=${text(state.scope === "operator" ? "operatorTitle" : "title")}><h4>${text(state.scope === "operator" ? "operatorTitle" : "title")}</h4><p class="sub">${text(state.scope === "operator" ? "operator" : "person")}</p>
    <p class="sub">${text("deferred")}</p>${!catalog?.canWrite ? html`<p class="sub">${text("readOnly")}</p>` : null}
    <button class="btn" type="button" disabled=${busy || state.busy || state.revoked} onClick=${() => refreshOwnerEffects()}>${text("reload")}</button>
    ${state.status !== "known" ? html`<p class="sub" role="status">${text(state.revoked ? "changed" : "unknown")}</p>` : OWNER_EFFECT_PREF_KEYS.map(key => {
      const row = state.slots[key], options = (catalog?.effects || []).filter(e => ownerEffectFits(e.manifest, key));
      const absent = !!row.id && !options.some(e => e.id === row.id);
      return html`<div class="s-fx-owner-row" key=${key}><label>${text(key.slice(3))}<select class="s-fx-target" data-owner-slot=${key} disabled=${disabled} value=${row.id || ""} onChange=${e => save(key, e.target.value || null)}>
        <option value="">${text("none")}</option>${absent ? html`<option value=${row.id} disabled>${text(row.status === "unavailable" ? "unavailable" : "savedChoice")}</option>` : null}
        ${options.map(e => html`<option key=${e.id} value=${e.id}>${e.manifest.title}</option>`)}</select></label>
        ${row.status === "unavailable" ? html`<span class="sub" role="status">${text("unavailable")}</span>` : null}
        ${row.id ? html`<button class="btn" type="button" data-owner-clear=${key} disabled=${disabled} onClick=${() => save(key, null)}>${text("clear")}</button>` : null}</div>`;
    })}${message ? html`<p class="sub" role="status">${message}</p>` : null}</section>`;
}
