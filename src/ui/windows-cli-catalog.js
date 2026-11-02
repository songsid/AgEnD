// Page-lived Windows inventory. Panels share successful results and one in-flight read;
// closing a dialog only removes its subscription, so a second consumer can finish the read.
import { html, useEffect, useState } from "/assets/app-html.js";
import { createStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { register, t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";

export const WINDOWS_CLI_CATALOG_TTL_MS = 60_000;
const initial = () => ({ data:null, loading:false, error:"", checkedAt:0, startedAt:0 });

/** Successful inventory only, in memory. No polling, localStorage, credential data or model tasks. */
export function createWindowsCliCatalog({ fetcher = (...args) => fetch(...args), now = () => Date.now(), ttlMs = WINDOWS_CLI_CATALOG_TTL_MS, timeoutMs = 80_000 } = {}) {
  const store = createStore(initial());
  let pending = null, controller = null, generation = 0;
  const load = ({ force = false } = {}) => {
    if (pending) return pending;
    const old = store.get();
    if (!force && old.data && now()-old.checkedAt < ttlMs) return Promise.resolve(old.data);
    const mine = generation;
    const abort = controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); },timeoutMs);
    store.set({loading:true,error:"",startedAt:now()});
    pending = Promise.resolve().then(async () => {
      try {
        if (mine !== generation) return null;
        const response = await fetcher("/ui/windows-cli/probe",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(force ? {force:true} : {}),signal:abort.signal});
        const value = await response.json();
        if (!response.ok) {
          if (mine === generation && [401,403].includes(response.status)) store.set({data:null,checkedAt:0});
          throw new Error(value?.error || `HTTP ${response.status}`);
        }
        if (!value || !Array.isArray(value.clis) || typeof value.home !== "string") throw new Error("Invalid Windows CLI inventory response");
        if (mine === generation) store.set({data:value,checkedAt:now(),error:""});
        return value;
      } catch(error) {
        if (mine === generation) store.set({error:timedOut ? "Windows CLI detection timed out" : error?.message || "Windows CLI detection failed"});
        return null;
      } finally {
        clearTimeout(timer);
        if (mine === generation) { pending = null; controller = null; store.set({loading:false}); }
      }
    });
    return pending;
  };
  return { get:store.get, subscribe:store.subscribe, load, clear() { generation++; controller?.abort(); controller = null; pending = null; store.set(initial()); } };
}

const catalog = createWindowsCliCatalog();
export function forgetWindowsCliCatalog() { catalog.clear(); }
export function useWindowsCliCatalog(enabled = true) {
  const state = useStore(catalog);
  useEffect(() => { if (enabled) void catalog.load(); },[enabled]);
  return { ...(enabled ? state : initial()), refresh:() => catalog.load({force:true}) };
}

register("windetect", {
  "zh-TW": { loading:"正在偵測 Windows CLI…", refreshing:"正在更新 Windows CLI…", hint:"正在確認已安裝的 CLI、版本與登入狀態。完成後會重用結果，不必每次重新等待。", elapsed:"已等待 {0} 秒，仍在檢查中。", failed:"無法完成 Windows CLI 偵測", previous:"更新未完成，目前顯示上次成功偵測的結果。", retry:"重試偵測", refresh:"重新偵測", cached:"已載入最近的偵測結果" },
  en: { loading:"Detecting Windows CLIs…", refreshing:"Updating Windows CLIs…", hint:"Checking installed CLIs, versions and sign-ins. Results are reused so reopening does not repeat the wait.", elapsed:"Still checking after {0} seconds.", failed:"Windows CLI detection failed", previous:"Refresh failed. Showing the last successful inventory.", retry:"Retry detection", refresh:"Detect again", cached:"Loaded the recent inventory" },
});
export const detectionText = key => t(`windetect.${key}`);

export function WindowsCliDiscoveryStatus({ state }) {
  const lease = useLease("windows-cli-discovery-status");
  const [seconds,setSeconds] = useState(0);
  useEffect(() => {
    if (!state.loading) { setSeconds(0); return; }
    const tick = () => setSeconds(Math.max(0,Math.floor((Date.now()-state.startedAt)/1000)));
    tick(); const timer = lease.interval(tick,1000);
    return () => lease.clear(timer);
  },[lease,state.loading,state.startedAt]);
  if (state.error) return html`<div class="cli-discovery-status is-error" role="alert"><${Icon} name="alert" size=${18} /><div><strong>${detectionText("failed")}</strong><p>${state.data ? detectionText("previous") : state.error}</p>${state.data ? html`<small>${state.error}</small>` : null}<button type="button" class="btn btn-sm" onClick=${state.refresh}>${detectionText("retry")}</button></div></div>`;
  if (!state.loading && state.data) return null;
  return html`<div class="cli-discovery-status" role="status" aria-live="polite" aria-busy="true"><span class="out-spin" aria-hidden="true"></span><div><strong>${detectionText(state.data ? "refreshing" : "loading")}</strong><p>${detectionText("hint")}</p>${seconds >= 8 ? html`<small>${t("windetect.elapsed",seconds)}</small>` : null}</div></div>`;
}
