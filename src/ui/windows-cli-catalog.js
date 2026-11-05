// Page-lived Windows inventory. Panels share successful results and one in-flight read;
// closing a dialog only removes its subscription, so a second consumer can finish the read.
import { html, useEffect, useState } from "/assets/app-html.js";
import { createStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { register, t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";

export const WINDOWS_CLI_CATALOG_TTL_MS = 60_000;
const initial = () => ({ data:null, loading:false, error:"", checkedAt:0, startedAt:0 });

/** Successful inventory only, in memory. No polling, localStorage, credential data or model tasks. A plain load reads the
 * server's last detection (which starts nothing, M-2239 P1-2); only `force` (Detect again) runs detection. */
export function createWindowsCliCatalog({ fetcher = (...args) => fetch(...args), now = () => Date.now(), ttlMs = WINDOWS_CLI_CATALOG_TTL_MS, timeoutMs = 100_000, machineId = "" } = {}) {
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
        const base = machineId ? `/ui/runtimes/machines/${encodeURIComponent(machineId)}` : "/ui/windows-cli";
        const response = await fetcher(`${base}/${machineId && !force ? "inventory" : "probe"}`,{credentials:"same-origin",...(machineId && !force ? {} : {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(machineId ? {} : force ? {force:true} : {})}),signal:abort.signal});
        const body = await response.json();
        if (!response.ok) {
          if (mine === generation && [401,403].includes(response.status)) store.set({data:null,checkedAt:0});
          throw new Error(body?.error || `HTTP ${response.status}`);
        }
        const value = machineId ? body.inventory || { home:"", clis:[], probedAt:null } : body;
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
const remoteCatalogs = new Map();
function catalogFor(machineId) {
  if (!machineId) return catalog;
  if (!remoteCatalogs.has(machineId)) remoteCatalogs.set(machineId,createWindowsCliCatalog({machineId}));
  return remoteCatalogs.get(machineId);
}
export const refreshWindowsCliCatalog = (machineId = "") => catalogFor(machineId).load({force:true});
/** Subscribe to progress without starting a read; cards observe detection started in a dialog. */
export const useWindowsCliCatalogSnapshot = (machineId = "") => useStore(catalogFor(machineId));
export function forgetWindowsCliCatalog() { catalog.clear(); for (const remote of remoteCatalogs.values()) remote.clear(); remoteCatalogs.clear(); }
export function useWindowsCliCatalog(enabled = true, machineId = "") {
  const current = catalogFor(machineId);
  const state = useStore(current);
  useEffect(() => { if (enabled) void current.load(); },[enabled,current]);
  return { ...(enabled ? state : initial()), refresh:() => current.load({force:true}) };
}

register("windetect", {
  en: { remoteWindows:"Paired Windows Runtime" },
  "zh-TW": { remoteWindows:"已配對的 Windows Runtime" },
});
register("windetect", {
  "zh-TW": { loading:"正在偵測 Windows CLI…", refreshing:"正在更新 Windows CLI…", hint:"正在確認已安裝的 CLI、版本與登入狀態。完成後會重用結果，不必每次重新等待。", elapsed:"已等待 {0} 秒，仍在檢查中。", failed:"無法完成 Windows CLI 偵測", previous:"更新未完成，目前顯示上次成功偵測的結果。", retry:"重試偵測", refresh:"重新偵測", cached:"已載入最近的偵測結果", never:"尚未偵測 Windows CLI。偵測會逐一啟動已安裝的 CLI 一次，讀取版本與登入狀態；之後只在你按下「重新偵測」時再做。", detect:"偵測 Windows CLI" },
  en: { loading:"Detecting Windows CLIs…", refreshing:"Updating Windows CLIs…", hint:"Checking installed CLIs, versions and sign-ins. Results are reused so reopening does not repeat the wait.", elapsed:"Still checking after {0} seconds.", failed:"Windows CLI detection failed", previous:"Refresh failed. Showing the last successful inventory.", retry:"Retry detection", refresh:"Detect again", cached:"Loaded the recent inventory", never:"Windows CLIs have not been detected yet. Detection starts each installed CLI once to read its version and sign-in; after that, only when you press Detect again.", detect:"Detect Windows CLIs" },
});
register("windetect", {
  en: { computer:"Diagnostic computer", hostWindows:"Windows on the AgEnD host", hostHint:"Diagnostics and test tasks use this computer's CLIs and sign-ins.", hostUnknown:"Computer name not reported", hostRefresh:"Detect again to read the Windows computer name." },
  "zh-TW": { computer:"診斷電腦", hostWindows:"AgEnD 主機的 Windows", hostHint:"診斷與測試任務使用這台電腦的 CLI 與登入。", hostUnknown:"電腦名稱尚未回報", hostRefresh:"重新偵測後可取得 Windows 電腦名稱。" },
});
export const detectionText = key => t(`windetect.${key}`);

/** Show the execution computer's identity, independently of the computer opening the dashboard. */
export function WindowsCliHostIdentity({ inventory, compact = false, machineId = "", machine }) {
  const hostname = (inventory?.hostname || machine?.hostname || "").trim();
  return html`<div class=${`windows-cli-target${compact ? " is-compact" : ""}`} aria-label=${detectionText("computer")}>
    <${Icon} name="fleet" size=${compact ? 16 : 21} /><div><span class="windows-cli-target-label">${machineId ? t("windetect.remoteWindows") : detectionText("hostWindows")}</span><strong class="windows-cli-target-name">${machineId ? `${machine?.name || machineId}${hostname && hostname !== machine?.name ? ` · ${hostname}` : ""}` : hostname || detectionText("hostUnknown")}</strong>
    ${!compact ? html`<p>${detectionText(hostname ? "hostHint" : "hostRefresh")}</p>` : null}</div>
  </div>`;
}

export function WindowsCliDiscoveryStatus({ state, disabled = false }) {
  const lease = useLease("windows-cli-discovery-status");
  const [seconds,setSeconds] = useState(0);
  useEffect(() => {
    if (!state.loading) { setSeconds(0); return; }
    const tick = () => setSeconds(Math.max(0,Math.floor((Date.now()-state.startedAt)/1000)));
    tick(); const timer = lease.interval(tick,1000);
    return () => lease.clear(timer);
  },[lease,state.loading,state.startedAt]);
  if (state.error) return html`<div class="cli-discovery-status is-error" role="alert"><${Icon} name="alert" size=${18} /><div><strong>${detectionText("failed")}</strong><p>${state.data ? detectionText("previous") : state.error}</p>${state.data ? html`<small>${state.error}</small>` : null}<button type="button" class="btn btn-sm" disabled=${disabled} onClick=${state.refresh}>${detectionText("retry")}</button></div></div>`;
  // M-2239 P1-2: nothing is detected on its own — the first detection is the administrator's press too.
  if (!state.loading && state.data && state.data.probedAt === null) return html`<div class="cli-discovery-status" role="status"><${Icon} name="info" size=${18} /><div><p>${detectionText("never")}</p><button type="button" class="btn btn-sm" disabled=${disabled} onClick=${state.refresh}>${detectionText("detect")}</button></div></div>`;
  if (!state.loading && state.data) return null;
  return html`<div class="cli-discovery-status" role="status" aria-live="polite" aria-busy="true"><span class="out-spin" aria-hidden="true"></span><div><strong>${detectionText(state.data ? "refreshing" : "loading")}</strong><p>${detectionText("hint")}</p>${seconds >= 8 ? html`<small>${t("windetect.elapsed",seconds)}</small>` : null}</div></div>`;
}
