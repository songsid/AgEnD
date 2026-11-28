// Page-lived Windows inventory. Panels share successful results and one in-flight read;
// closing a dialog only removes its subscription, so a second consumer can finish the read.
import { html, useEffect, useState } from "/assets/app-html.js";
import { createStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { register, t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";

export const WINDOWS_CLI_CATALOG_TTL_MS = 60_000;
const initial = () => ({ data:null, loading:false, error:"", errorCode:"", errorDetail:"", checkedAt:0, startedAt:0 });
/** A detection that ran and was recorded. The server answers a never-detected computer with a placeholder (`probedAt: null`, no CLIs): that is "no record", not an earlier result. */
export const hasDetectionRecord = data => typeof data?.probedAt === "number";

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
    store.set({loading:true,error:"",errorCode:"",errorDetail:"",startedAt:now()});
    pending = Promise.resolve().then(async () => {
      try {
        if (mine !== generation) return null;
        const base = machineId ? `/ui/runtimes/machines/${encodeURIComponent(machineId)}` : "/ui/windows-cli";
        const response = await fetcher(`${base}/${machineId && !force ? "inventory" : "probe"}`,{credentials:"same-origin",...(machineId && !force ? {} : {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(machineId ? {} : force ? {force:true} : {})}),signal:abort.signal});
        const body = await response.json();
        if (!response.ok) {
          if (mine === generation && [401,403].includes(response.status)) store.set({data:null,checkedAt:0});
          throw Object.assign(new Error(body?.error || `HTTP ${response.status}`),{bridgeCode:typeof body?.code === "string" ? body.code : "",bridgeDetail:typeof body?.detail === "string" ? body.detail : ""});
        }
        const value = machineId ? body.inventory || { home:"", clis:[], probedAt:null } : body;
        if (!value || !Array.isArray(value.clis) || typeof value.home !== "string") throw new Error("Invalid Windows CLI inventory response");
        if (mine === generation) store.set({data:value,checkedAt:now(),error:"",errorCode:"",errorDetail:""});
        return value;
      } catch(error) {
        if (mine === generation) store.set({error:timedOut ? "Windows CLI detection timed out" : error?.message || "Windows CLI detection failed",errorCode:timedOut ? "" : error?.bridgeCode || "",errorDetail:timedOut ? "" : error?.bridgeDetail || ""});
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
// Why this AgEnD cannot reach Windows (the server sends a code, see WINDOWS_BRIDGE_MESSAGES in src/windows-cli.ts), and what to do about it.
const BRIDGE_ERRORS = { "not-wsl":"errNotWsl", "interop-off":"errInteropOff", "powershell-missing":"errPowershellMissing", "powershell-failed":"errPowershellFailed", "node-missing":"errNodeMissing", "wslpath-failed":"errWslpathFailed" };
register("windetect", {
  en: {
    errNotWsl:"This AgEnD is not running on Windows or in WSL (for example in a container or on a plain Linux server), so it has no local Windows CLIs to detect. Run AgEnD on Windows or in WSL, or open Settings → Runtime → Connect a computer to pair a Windows computer.",
    errInteropOff:"This WSL cannot start Windows programs because interop is off. Add [interop] enabled=true to /etc/wsl.conf, run wsl --shutdown in Windows, open WSL again, then detect again.",
    errPowershellMissing:"Windows PowerShell (powershell.exe) was not found from this WSL. Check that the Windows drive is mounted at /mnt/c (ls /mnt/c/Windows) and that appendWindowsPath is not turned off in /etc/wsl.conf, then detect again.",
    errPowershellFailed:"Windows PowerShell was found but could not be started. Run powershell.exe -NoProfile -Command echo ok in this WSL to see why, then detect again.",
    errNodeMissing:"Windows Node.js was not found. Install Node.js for Windows and put node.exe on the Windows PATH, then detect again.",
    errWslpathFailed:"WSL could not translate the path of Windows Node.js or of AgEnD's Windows worker (wslpath failed). Run wslpath -w ~ in this WSL to see why, then detect again.",
  },
  "zh-TW": {
    errNotWsl:"這個 AgEnD 不是跑在 Windows 或 WSL 上（例如 Docker 容器或一般 Linux 主機），沒有本機 Windows CLI 可偵測。請改在 Windows 或 WSL 執行 AgEnD，或到「設定 → Runtime」按「連接電腦」配對一台 Windows 電腦。",
    errInteropOff:"這個 WSL 沒有開啟 interop，無法啟動 Windows 程式。請在 /etc/wsl.conf 加入 [interop] enabled=true，在 Windows 執行 wsl --shutdown，重新開啟 WSL 後再偵測。",
    errPowershellMissing:"在這個 WSL 找不到 Windows PowerShell（powershell.exe）。請確認 Windows 磁碟已掛載在 /mnt/c（執行 ls /mnt/c/Windows），且 /etc/wsl.conf 沒有關閉 appendWindowsPath，再重新偵測。",
    errPowershellFailed:"找到 Windows PowerShell，但無法啟動。請在這個 WSL 執行 powershell.exe -NoProfile -Command echo ok 查看原因，再重新偵測。",
    errNodeMissing:"找不到 Windows 的 Node.js。請安裝 Windows 版 Node.js，並把 node.exe 放進 Windows 的 PATH，再重新偵測。",
    errWslpathFailed:"WSL 無法轉換 Windows Node.js 或 AgEnD Windows worker 的路徑（wslpath 失敗）。請在這個 WSL 執行 wslpath -w ~ 查看原因，再重新偵測。",
  },
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
  if (state.error) {
    // "Showing the last successful result" is only true when there is one; a never-detected computer has none.
    const earlier = hasDetectionRecord(state.data), known = BRIDGE_ERRORS[state.errorCode];
    const message = known ? html`<p>${detectionText(known)}</p>${state.errorDetail ? html`<small>${state.errorDetail}</small>` : null}` : earlier ? html`<small>${state.error}</small>` : html`<p>${state.error}</p>`;
    return html`<div class="cli-discovery-status is-error" role="alert"><${Icon} name="alert" size=${18} /><div><strong>${detectionText("failed")}</strong>${earlier ? html`<p>${detectionText("previous")}</p>` : null}${message}<button type="button" class="btn btn-sm" disabled=${disabled} onClick=${state.refresh}>${detectionText("retry")}</button></div></div>`;
  }
  // M-2239 P1-2: nothing is detected on its own — the first detection is the administrator's press too.
  if (!state.loading && state.data && state.data.probedAt === null) return html`<div class="cli-discovery-status" role="status"><${Icon} name="info" size=${18} /><div><p>${detectionText("never")}</p><button type="button" class="btn btn-sm" disabled=${disabled} onClick=${state.refresh}>${detectionText("detect")}</button></div></div>`;
  if (!state.loading && state.data) return null;
  return html`<div class="cli-discovery-status" role="status" aria-live="polite" aria-busy="true"><span class="out-spin" aria-hidden="true"></span><div><strong>${detectionText(state.data ? "refreshing" : "loading")}</strong><p>${detectionText("hint")}</p>${seconds >= 8 ? html`<small>${t("windetect.elapsed",seconds)}</small>` : null}</div></div>`;
}
