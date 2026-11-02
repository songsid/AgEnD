import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { Icon } from "/assets/ui-icons.js";
import { appStore, useStore } from "/assets/app-store.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { CliProductMark, cliLabel } from "./cli-picker.js";
import { WindowsCliPanel } from "./panel-windows-cli.js";
import { useRuntimeCatalog } from "./runtime-catalog.js";

register("machines", {
  en: {
    title:"Runtime", lead:"Connect computers to run agents with each computer's own CLIs, sign-ins and files.",
    connect:"Connect a computer", download:"Download Windows Runtime (ZIP)", downloadHint:"Download here, then transfer the ZIP to the Windows computer and extract it. Windows Node.js is required.", refresh:"Refresh machines", loading:"Loading machines…", empty:"No remote computers connected yet.",
    disabled:"Remote runtime connections are not enabled on this AgEnD host.", local:"This computer", localHint:"WSL / Linux agents run on the AgEnD host. Native Windows diagnostics are below when enabled.",
    localWindows:"Local Windows CLI diagnostics", online:"Online", offline:"Offline", pending:"Awaiting approval", revoked:"Revoked", unknown:"Not reported",
    lastSeen:"Last seen: {0}", inventoryAt:"CLI inventory: {0}", noInventory:"CLI inventory has not been reported yet.", noClis:"No installed CLIs reported.",
    approve:"Approve computer", revoke:"Revoke connection", rename:"Rename", save:"Save name", cancel:"Cancel", name:"Computer name", probe:"Refresh CLI inventory",
    approvalHint:"Compare this computer's name and identity with the runtime you started before approving it.", identity:"Computer identity", signedIn:"Signed in", signedOut:"Not signed in", authUnknown:"Sign-in unknown", detectionOnly:"Detection only", ready:"Tasks supported",
    pairing:"Connect a computer", pairingHint:"On the other computer, extract this version's portable Runtime bundle and run the command below from its folder. Paste the one-time code when asked, then approve the computer here. Keep that runtime window open.",
    pairingCode:"One-time pairing code", expires:"Expires: {0}", command:"Run on the other computer", pairingWait:"Waiting for the computer to request approval. This page updates automatically.",
    server:"AgEnD address", serverHint:"Use an address reachable from the other computer. A localhost address works only with a connection forwarded on that computer.", serverInvalid:"Enter an HTTPS origin, or a localhost HTTP origin with a forwarded connection. Leave out paths, credentials and query strings.", closeCode:"Hide pairing code", revokeAsk:"Revoke this computer's connection? New work will be refused. A task already running may need to be stopped on that computer.",
    failed:"Could not update Runtime", cliFailed:"CLI refresh failed; the last reported inventory is still shown.", retry:"Retry", seenCached:"Showing the last successfully loaded machine list.",
    machines:"Connected computers", cli:"CLI", version:"Runtime version", platform:"Platform",
  },
  "zh-TW": {
    title:"Runtime", lead:"連接電腦，讓 Agent 使用各台電腦上的 CLI、登入與檔案。",
    connect:"連接電腦", download:"下載 Windows Runtime（ZIP）", downloadHint:"下載後，將 ZIP 傳到要執行 CLI 的 Windows 電腦並解壓縮。需要 Windows Node.js。", refresh:"更新機器清單", loading:"正在載入機器…", empty:"尚未連接其他電腦。",
    disabled:"這個 AgEnD 主機尚未啟用遠端 Runtime 連線。", local:"這台電腦", localHint:"WSL / Linux Agent 在 AgEnD 主機上執行。啟用後可在下方查看本機 Windows 診斷。",
    localWindows:"本機 Windows CLI 診斷", online:"在線", offline:"離線", pending:"等待核准", revoked:"已撤銷", unknown:"尚未回報",
    lastSeen:"最近連線：{0}", inventoryAt:"CLI 清單更新：{0}", noInventory:"尚未回報 CLI 清單。", noClis:"尚未回報已安裝的 CLI。",
    approve:"核准電腦", revoke:"撤銷連線", rename:"重新命名", save:"儲存名稱", cancel:"取消", name:"電腦名稱", probe:"更新 CLI 清單",
    approvalHint:"核准前，請比對這台電腦的名稱與識別碼，確認是你啟動的 Runtime。", identity:"電腦識別碼", signedIn:"已登入", signedOut:"尚未登入", authUnknown:"登入狀態未知", detectionOnly:"僅偵測", ready:"支援派工",
    pairing:"連接電腦", pairingHint:"在另一台電腦解壓縮此版本的可攜式 Runtime 套件，從其資料夾執行下方指令，在提示時貼上一次性配對碼，再回到這裡核准電腦。請保持 Runtime 視窗開啟。",
    pairingCode:"一次性配對碼", expires:"到期時間：{0}", command:"在另一台電腦執行", pairingWait:"正在等待電腦提出核准要求。此頁會自動更新。",
    server:"AgEnD 位址", serverHint:"請使用另一台電腦連得到的位址。localhost 只有在另一台電腦已建立連線轉發時才適用。", serverInvalid:"請填入 HTTPS 來源位址，或已轉發連線的 localhost HTTP 位址，不包含路徑、帳密或查詢參數。", closeCode:"隱藏配對碼", revokeAsk:"要撤銷這台電腦的連線嗎？新的派工會被拒絕；已在執行的任務可能需要在該電腦上停止。",
    failed:"無法更新 Runtime", cliFailed:"CLI 更新失敗，目前仍顯示上次回報的清單。", retry:"重試", seenCached:"目前顯示上次成功載入的機器清單。",
    machines:"已連接的電腦", cli:"CLI", version:"Runtime 版本", platform:"平台",
  },
});
export const machineText = (key,...values) => t(`machines.${key}`,...values);
/** Only an origin composed of inert hostname/port characters is placed in a copyable shell command. */
export function runtimeConnectCommand(server) {
  try {
    const url = new URL(server);
    const local = ["localhost","127.0.0.1","[::1]"].includes(url.hostname);
    if (!/^([a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || !(url.protocol === "https:" || url.protocol === "http:" && local)) return "";
    return `.\\agend-runtime.cmd connect --server "${url.origin}"`;
  } catch { return ""; }
}
export function machineTime(value) { const date=new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString() : machineText("unknown"); }
function MachineCard({ machine, busy, action }) {
  const [editing,setEditing] = useState(false), [name,setName] = useState(machine.name);
  const clis = (machine.inventory?.clis || []).filter(cli => cli.path);
  return html`<article class="runtime-machine" data-machine-id=${machine.id}>
    <header><span class="runtime-machine-icon"><${Icon} name="view" size=${22} /></span><div><h3>${machine.name}</h3><p>${[machine.platform || machineText("unknown"), machine.hostname, machine.version].filter(Boolean).join(" · ")}</p></div><span class=${`runtime-status is-${machine.status}`}>${machineText(["online","offline","pending","revoked"].includes(machine.status) ? machine.status : "unknown")}</span></header>
    <p class="note">${machineText("lastSeen",machineTime(machine.lastSeenAt))}</p><p class="note">${machine.inventoryUpdatedAt ? machineText("inventoryAt",machineTime(machine.inventoryUpdatedAt)) : machineText("noInventory")}</p>
    <details><summary>${machineText("identity")}</summary><code class="runtime-machine-id">${machine.id}</code></details>
    ${machine.status === "pending" ? html`<p class="note">${machineText("approvalHint")}</p>` : null}
    <ul class="runtime-cli-list" aria-label=${machineText("cli")}>${clis.map(cli => html`<li key=${cli.id}><${CliProductMark} id=${cli.id} size=${22} /><span><strong>${cliLabel(cli.id)}</strong><small>${cli.version || "—"}</small></span><span class="note">${machineText(cli.authenticated === true ? "signedIn" : cli.authenticated === false ? "signedOut" : "authUnknown")} · ${machineText(cli.supports?.execution === false ? "detectionOnly" : "ready")}</span></li>`)}</ul>
    ${!clis.length ? html`<p class="note">${machineText("noClis")}</p>` : null}
    ${editing ? html`<form class="runtime-rename" onSubmit=${event => {event.preventDefault();if(name.trim())void action(machine,"rename",{name:name.trim()}).then(ok => {if(ok)setEditing(false);});}}><label><span>${machineText("name")}</span><input value=${name} maxLength=${100} onInput=${event => setName(event.target.value)} /></label><button class="btn btn-sm" type="submit" disabled=${busy || !name.trim()}>${machineText("save")}</button><button class="btn btn-ghost btn-sm" type="button" onClick=${() => setEditing(false)}>${machineText("cancel")}</button></form>` : null}
    <div class="runtime-machine-actions">${machine.status === "pending" ? html`<button type="button" class="btn btn-primary btn-sm" disabled=${busy} onClick=${() => action(machine,"approve")}>${machineText("approve")}</button>` : null}${machine.status === "online" ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => action(machine,"refresh")}><${Icon} name="restart" size=${14} />${machineText("probe")}</button>` : null}${machine.status !== "revoked" ? html`<button type="button" class="btn btn-ghost btn-sm" disabled=${busy} onClick=${() => setEditing(true)}>${machineText("rename")}</button><button type="button" class="btn btn-ghost btn-sm danger" disabled=${busy} onClick=${() => action(machine,"revoke")}>${machineText("revoke")}</button>` : null}</div>
  </article>`;
}
export function RuntimesPanel({navKey}) {
  const lease=useLease(`runtimes:${navKey}`), state=useRuntimeCatalog(), {windowsCli}=useStore(appStore);
  const [pairing,setPairing]=useState(null), [busy,setBusy]=useState(""), [error,setError]=useState("");
  const [server,setServer]=useState(() => typeof location === "undefined" ? "" : location.origin);
  useEffect(() => {
    if (!pairing) return;
    const remaining = new Date(pairing.expiresAt).getTime()-Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {setPairing(null);return;}
    const timer=lease.timeout(() => setPairing(null),remaining);
    return () => lease.clear(timer);
  },[lease,pairing]);
  const post=async(path,body={}) => {
    const response=await lease.fetch(path,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const value=await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    return value;
  };
  const connect=async() => {
    setBusy("pairing");setError("");
    try {const value=await post("/ui/runtimes/pairing");if(lease.current())setPairing(value);}catch(e){if(lease.current())setError(e.message);}finally{if(lease.current())setBusy("");}
  };
  const action=async(machine,operation,body={}) => {
    if(operation === "revoke" && !await confirmDialog({message:machineText("revokeAsk"),confirmLabel:machineText("revoke"),danger:true}))return false;
    if(!lease.current())return false;
    setBusy(machine.id);setError("");
    try {await post(`/ui/runtimes/machines/${encodeURIComponent(machine.id)}/${operation}`,body);if(!lease.current())return false;await state.refresh();return lease.current();}
    catch(e){if(lease.current())setError(operation === "refresh" ? `${machineText("cliFailed")} ${e.message}` : e.message);return false;}
    finally{if(lease.current())setBusy("");}
  };
  const machines=state.data?.machines || [];
  const command=runtimeConnectCommand(server);
  const download=()=>html`<a class="btn btn-sm runtime-bundle-download" href="/ui/runtimes/download/windows" download><${Icon} name="download" size=${15} />${machineText("download")}</a>`;
  return html`<section class="runtime-settings">
    <header class="runtime-heading"><div><h2>${machineText("title")}</h2><p class="note">${machineText("lead")}</p></div><div>${state.data?.enabled === true && !pairing ? download() : null}<button type="button" class="btn btn-sm" disabled=${state.loading} onClick=${state.refresh}><${Icon} name="restart" size=${15} />${machineText("refresh")}</button><button type="button" class="btn btn-primary btn-sm" disabled=${!!busy || state.data?.enabled !== true} onClick=${connect}><${Icon} name="plus" size=${15} />${machineText("connect")}</button></div></header>
    ${state.data?.enabled === false ? html`<p class="note">${machineText("disabled")}</p>` : null}
    ${state.loading && !state.data ? html`<p role="status" aria-busy="true"><span class="out-spin" aria-hidden="true"></span> ${machineText("loading")}</p>` : null}
    ${error || state.error ? html`<div class="runtime-error" role="alert"><p>${error || state.error}</p>${state.data && state.error ? html`<p>${machineText("seenCached")}</p>` : null}<button type="button" class="btn btn-sm" onClick=${state.refresh}>${machineText("retry")}</button></div>` : null}
    ${pairing ? html`<section class="runtime-pairing" aria-label=${machineText("pairing")}><h3>${machineText("pairing")}</h3><p>${machineText("pairingHint")}</p><div class="runtime-bundle-step">${download()}<p class="note">${machineText("downloadHint")}</p></div><label><span>${machineText("server")}</span><input type="url" value=${server} spellcheck=${false} onInput=${event => setServer(event.target.value)} /></label><p class="note">${machineText("serverHint")}</p>${command ? html`<label><span>${machineText("command")}</span><input class="runtime-command" value=${command} readOnly=${true} spellcheck=${false} /></label>` : html`<p role="alert">${machineText("serverInvalid")}</p>`}<label><span>${machineText("pairingCode")}</span><input class="runtime-pair-code" value=${pairing.code} readOnly=${true} spellcheck=${false} autocomplete="off" /></label><p class="note">${machineText("expires",machineTime(pairing.expiresAt))}</p><p role="status">${machineText("pairingWait")}</p><button type="button" class="btn btn-ghost btn-sm" onClick=${() => setPairing(null)}>${machineText("closeCode")}</button></section>` : null}
    <article class="runtime-local"><h3><${Icon} name="code" size=${18} />${machineText("local")}</h3><p class="note">${machineText("localHint")}</p></article>
    <section aria-label=${machineText("machines")}>${machines.map(machine => html`<${MachineCard} key=${machine.id} machine=${machine} busy=${!!busy} action=${action} />`)}${state.data && !machines.length ? html`<p class="note">${machineText("empty")}</p>` : null}</section>
    ${windowsCli ? html`<details class="runtime-local-diagnostics"><summary>${machineText("localWindows")}</summary><${WindowsCliPanel} navKey=${`${navKey}:local`} embedded=${true} /></details>` : null}
  </section>`;
}
