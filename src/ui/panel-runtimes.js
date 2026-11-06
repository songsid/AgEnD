import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { Icon } from "/assets/ui-icons.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Menu } from "/assets/ui-menu.js";
import { appStore, useStore } from "/assets/app-store.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { confirmedWrite } from "./settings-confirm.js";
import { CliProductMark, cliLabel } from "./cli-picker.js";
import { WindowsCliPanel } from "./panel-windows-cli.js";
import { useRuntimeCatalog } from "./runtime-catalog.js";
import { useWindowsCliCatalog, refreshWindowsCliCatalog, useWindowsCliCatalogSnapshot } from "./windows-cli-catalog.js";

register("machines", {
  en: {
    title:"Runtime", lead:"Connect computers to run agents with each computer's own CLIs, sign-ins and files.",
    connect:"Connect a computer", download:"Download Windows Runtime (ZIP)", downloadHint:"Download here, then transfer the ZIP to the Windows computer and extract it. Windows Node.js is required.", refresh:"Refresh machines", loading:"Loading machines…", empty:"No remote computers connected yet.",
    disabled:"Other Windows PCs can connect once “Allow other Windows PCs to pair” is on.", local:"This computer", localHint:"WSL / Linux agents run on the AgEnD host. Native Windows diagnostics are below when enabled.",
    localWindows:"Local Windows CLI diagnostics", online:"Online", offline:"Offline", pending:"Awaiting approval", revoked:"Revoked", unknown:"Not reported",
    lastSeen:"Last seen: {0}", inventoryAt:"CLI inventory: {0}", noInventory:"CLI inventory has not been reported yet.", noClis:"No installed CLIs reported.",
    approve:"Approve computer", revoke:"Revoke connection", rename:"Rename", save:"Save name", cancel:"Cancel", name:"Computer name", probe:"Refresh CLI inventory",
    fingerprint:"Pairing fingerprint", fingerprintLabel:"Pairing fingerprint: ", approvalHint:"Compare this fingerprint with the one shown in the requesting Runtime before approving.", identity:"Computer identity", signedIn:"Signed in", signedOut:"Not signed in", authUnknown:"Sign-in unknown", detectionOnly:"Detection only", ready:"Tasks supported",
    pairing:"Connect a computer",
    pairingCode:"One-time pairing code", expires:"Expires: {0}", command:"Run on the other computer", pairingWait:"Waiting for the computer to connect",
    server:"AgEnD address", serverHint:"Must be reachable from the other computer. localhost works only over a forwarded connection.", serverInvalid:"Enter an HTTPS origin, or a localhost HTTP origin with a forwarded connection. Leave out paths, credentials and query strings.", closeCode:"Hide pairing code", revokeAsk:"Revoke this computer's connection? New work will be refused. A task already running may need to be stopped on that computer.",
    failed:"Could not update Runtime", cliFailed:"CLI refresh failed; the last reported inventory is still shown.", retry:"Retry", seenCached:"Showing the last successfully loaded machine list.",
    machines:"Connected computers", cli:"CLI", version:"Runtime version", platform:"Platform",
    switches:"What this fleet may use", switchesNote:"Turning one on asks a fleet admin to confirm, like other access settings. Turning one off needs no fleet admin; it applies as soon as you confirm here.",
    windowsCli:"Use this PC's Windows CLIs", windowsCliHelp:"Agents can run the CLIs installed on Windows on this PC, such as Codex or Claude Code, with your Windows sign-ins. Windows Node.js is required.",
    remoteRuntime:"Allow other Windows PCs to pair", remoteRuntimeHelp:"This computer stays your fleet. Another Windows PC runs only a small runner, not a fleet; once you approve it here, agents can use that PC's CLIs and files. That PC must reach this fleet at an HTTPS address, as the guide below explains.",
    remoteRuntimeDocs:"Full guide", setByEnv:"Set by the environment ({0}={1}). To change it, remove it from AgEnD's environment and restart AgEnD.",
    switchPending:"Waiting for a fleet admin to confirm. It turns on once they do.", switchFailed:"Could not change this setting: {0}", switchesUnavailable:"These switches can be changed only on this fleet's own dashboard.",
    windowsCliOffAsk:"Turn off this PC's Windows CLIs? A Windows agent turn in progress on this PC stops, and these agents stay stopped until you turn it on again.",
    remoteRuntimeOffAsk:"Stop accepting other Windows PCs? Paired PCs disconnect now and their agents stay stopped until you turn it on again. Approved PCs are kept.",
    limit:"Agents at once on each Windows PC", limitHelp:"Each Windows PC, this one or a paired one, runs at most this many agents at the same time ({0}–{1}, default {2}). This limit applies to persistent terminal agents. Per-message execution keeps its existing admission limit.", limitSave:"Save", limitSaved:"Saved.",
    guide:"How another PC connects", guideAddress:"1. Give this fleet an HTTPS address the other PC can reach. Recommended: Tailscale Serve, run on this computer (on Windows, if AgEnD runs in WSL). Then use the https://….ts.net address it prints:",
    guideSsh:"Or: an SSH tunnel, opened on the other PC (replace user@this-computer with your SSH sign-in for this computer). Then use http://localhost:{0}:", guideFunnel:"Never use Tailscale Funnel: it puts this fleet on the internet.",
    guideLan:"A plain http:// address on your network (such as http://192.168.1.20) is refused: it would send the pairing code unencrypted.",
    guidePair:"2. Click Connect a computer, install the Runtime on the other PC with the PowerShell command it shows (or download the ZIP instead), then run the connect command there.", guideApprove:"3. When that PC asks to join, approve it here.",
    turnOff:"Turn off",
  },
  "zh-TW": {
    title:"Runtime", lead:"連接電腦，讓 Agent 使用各台電腦上的 CLI、登入與檔案。",
    connect:"連接電腦", download:"下載 Windows Runtime（ZIP）", downloadHint:"下載後，將 ZIP 傳到要執行 CLI 的 Windows 電腦並解壓縮。需要 Windows Node.js。", refresh:"更新機器清單", loading:"正在載入機器…", empty:"尚未連接其他電腦。",
    disabled:"開啟「允許其他 Windows 電腦配對」後，其他 Windows 電腦才能連接。", local:"這台電腦", localHint:"WSL / Linux Agent 在 AgEnD 主機上執行。啟用後可在下方查看本機 Windows 診斷。",
    localWindows:"本機 Windows CLI 診斷", online:"在線", offline:"離線", pending:"等待核准", revoked:"已撤銷", unknown:"尚未回報",
    lastSeen:"最近連線：{0}", inventoryAt:"CLI 清單更新：{0}", noInventory:"尚未回報 CLI 清單。", noClis:"尚未回報已安裝的 CLI。",
    approve:"核准電腦", revoke:"撤銷連線", rename:"重新命名", save:"儲存名稱", cancel:"取消", name:"電腦名稱", probe:"更新 CLI 清單",
    fingerprint:"配對指紋", fingerprintLabel:"配對指紋：", approvalHint:"核准前，請比對提出要求的 Runtime 視窗所顯示的配對指紋。", identity:"電腦識別碼", signedIn:"已登入", signedOut:"尚未登入", authUnknown:"登入狀態未知", detectionOnly:"僅偵測", ready:"支援派工",
    pairing:"連接電腦",
    pairingCode:"一次性配對碼", expires:"到期時間：{0}", command:"在另一台電腦執行", pairingWait:"等待電腦連線",
    server:"AgEnD 位址", serverHint:"須為另一台電腦連得到的位址。localhost 僅適用於已轉發的連線。", serverInvalid:"請填入 HTTPS 來源位址，或已轉發連線的 localhost HTTP 位址，不包含路徑、帳密或查詢參數。", closeCode:"隱藏配對碼", revokeAsk:"要撤銷這台電腦的連線嗎？新的派工會被拒絕；已在執行的任務可能需要在該電腦上停止。",
    failed:"無法更新 Runtime", cliFailed:"CLI 更新失敗，目前仍顯示上次回報的清單。", retry:"重試", seenCached:"目前顯示上次成功載入的機器清單。",
    machines:"已連接的電腦", cli:"CLI", version:"Runtime 版本", platform:"平台",
    switches:"這個 Fleet 可以使用", switchesNote:"開啟時，和其他存取設定一樣需要 Fleet 管理員確認；關閉不需 Fleet 管理員確認，你在這裡確認後就會立即生效。",
    windowsCli:"使用這台電腦 Windows 上的 CLI", windowsCliHelp:"Agent 可以使用這台電腦 Windows 上安裝的 CLI（例如 Codex 或 Claude Code），沿用你在 Windows 的登入。需要 Windows Node.js。",
    remoteRuntime:"允許其他 Windows 電腦配對", remoteRuntimeHelp:"這台電腦仍是你的 Fleet。另一台 Windows 電腦只執行一個小 runner，不是 Fleet；你在這裡核准後，Agent 就能使用那台電腦的 CLI 與檔案。那台電腦必須能用 HTTPS 位址連到這個 Fleet，做法見下方說明。",
    remoteRuntimeDocs:"完整說明", setByEnv:"由環境變數設定（{0}={1}）。若要變更，請從 AgEnD 的環境移除它並重新啟動 AgEnD。",
    switchPending:"等待 Fleet 管理員確認，確認後就會開啟。", switchFailed:"無法變更此設定：{0}", switchesUnavailable:"這些開關只能在這個 Fleet 自己的儀表板上變更。",
    windowsCliOffAsk:"要關閉這台電腦的 Windows CLI 嗎？這台電腦上進行中的 Windows Agent 回合會停止，這些 Agent 會保持停止，直到你再次開啟。",
    remoteRuntimeOffAsk:"要停止接受其他 Windows 電腦嗎？已配對的電腦會立即中斷連線，它們的 Agent 會保持停止，直到你再次開啟。已核准的電腦會保留。",
    limit:"每台 Windows 電腦同時執行的 Agent 數", limitHelp:"每台 Windows 電腦（這台或已配對的電腦）最多同時執行這麼多個 Agent（{0}–{1}，預設 {2}）。此限制適用於持續執行的終端 Agent。每則訊息各自執行的模式維持原本的執行數限制。", limitSave:"儲存", limitSaved:"已儲存。",
    guide:"另一台電腦如何連線", guideAddress:"1. 讓另一台電腦能用 HTTPS 位址連到這個 Fleet。建議在這台電腦上執行 Tailscale Serve（若 AgEnD 在 WSL 中執行，請在 Windows 上執行），再使用它顯示的 https://….ts.net 位址：",
    guideSsh:"或：在另一台電腦上開啟 SSH 通道（把 user@this-computer 換成你登入這台電腦的 SSH 帳號），再使用 http://localhost:{0}：", guideFunnel:"請勿使用 Tailscale Funnel：它會把這個 Fleet 公開到網際網路。",
    guideLan:"網路上的一般 http:// 位址（例如 http://192.168.1.20）會被拒絕：配對碼會以未加密的方式傳送。",
    guidePair:"2. 按「連接電腦」，在另一台電腦用頁面顯示的 PowerShell 指令安裝 Runtime（或改為下載 ZIP），再在那裡執行連線指令。", guideApprove:"3. 那台電腦要求加入時，在這裡核准它。",
    turnOff:"關閉此功能",
  },
});
export const machineText = (key,...values) => t(`machines.${key}`,...values);
register("machines", {
  en: { computersTitle:"Computers and CLIs", firstConnection:"Connecting for the first time?", stepDownload:"Download the Runtime", stepRun:"Run it on another computer", stepApprove:"Return here to approve", connectionNote:"Each computer keeps its own CLI sign-ins.", fleetScope:"Entire fleet", nativeWindows:"Native Windows", nativeHint:"CLIs and existing sign-ins on this computer's Windows installation.", inventoryHint:"Open diagnostics to inspect CLI availability and sign-ins." },
  "zh-TW": { computersTitle:"電腦與 CLI", firstConnection:"初次連接？", stepDownload:"下載 Runtime", stepRun:"在另一台電腦執行", stepApprove:"回來核准", connectionNote:"每台電腦保留自己的 CLI 登入。", fleetScope:"整個 Fleet", nativeWindows:"Windows 本機", nativeHint:"使用這台電腦 Windows 上的 CLI 與既有登入。", inventoryHint:"前往診斷查看 CLI 可用性與登入狀態。" },
});
register("machines", {
  en: { policies:"Runtime policies", policySummary:"Windows CLIs, remote pairing and per-computer limits", diagnostics:"CLI diagnostics and test tasks", diagnosticsHint:"Use this PC's Windows CLI sign-ins and inspect one-off task results.", openDiagnostics:"View local Windows CLIs", hostRuntime:"WSL / Linux", operationsNote:"Connections, approvals and test tasks are confirmed in their own flows." },
  "zh-TW": { policies:"Runtime 政策", policySummary:"本機 Windows CLI、遠端配對與每台電腦的並行數", diagnostics:"CLI 診斷與測試", diagnosticsHint:"使用這台電腦的 Windows CLI 登入，查看診斷或一次性測試任務。", openDiagnostics:"查看本機 Windows CLI", hostRuntime:"WSL / Linux", operationsNote:"連接、核准與測試任務會在各自流程中確認。" },
});
register("machines", {
  en: { diagnosticComputer:"Diagnostic computer", inspect:"Open CLI diagnostics", selectComputer:"Select a computer", targetUnavailable:"Selected Runtime is unavailable" },
  "zh-TW": { diagnosticComputer:"診斷電腦", inspect:"查看 CLI 診斷", selectComputer:"選擇電腦", targetUnavailable:"所選 Runtime 無法使用" },
});
register("machines", {
  en: { versionColumn:"Version", signInColumn:"Sign-in", authShort:"Unknown", noLocalClis:"No detected CLIs yet. Open diagnostics to detect installed CLIs.", lastSeenLabel:"Last connected", hostLocationNote:"WSL / Linux agents run on the AgEnD host. Windows agents use their selected computer.", connectionHelp:"Connection guide", localBadge:"This PC", pairedBadge:"Paired", available:"Available", cliCount:"{0} CLIs", machineCount:"{0} computers", diagnosticTitle:"CLI diagnostics", machineInfo:"Computer information", machineActions:"Actions for {0}", diagnosticClose:"Close", hostName:"Host name", machineName:"Name", home:"Home directory", neverDetected:"Not detected yet", probeAgain:"Detect again", probeBusy:"Detecting…", diagnosticHint:"Version, sign-in and executable paths on this computer. Expand Test CLI only when you need to check execution." },
  "zh-TW": { versionColumn:"版本", signInColumn:"登入", authShort:"未確認", noLocalClis:"尚未偵測到 CLI，可開啟診斷進行偵測。", lastSeenLabel:"最近連線", hostLocationNote:"WSL / Linux Agent 在 AgEnD 主機上執行；Windows Agent 使用選定的電腦。", connectionHelp:"連線說明", localBadge:"本機", pairedBadge:"已配對", available:"可用", cliCount:"{0} 個 CLI", machineCount:"{0} 台電腦", diagnosticTitle:"CLI 診斷", machineInfo:"電腦資訊", machineActions:"{0} 的操作", diagnosticClose:"關閉", hostName:"主機名稱", machineName:"名稱", home:"使用者目錄", neverDetected:"尚未偵測", probeAgain:"重新偵測", probeBusy:"正在偵測…", diagnosticHint:"查看這台電腦的版本、登入與執行檔路徑；需要確認執行能力時，再展開「測試 CLI」。" },
});
register("machines", {
  en: { revokedNote:"Revoked. It leaves this list when you refresh the page." },
  "zh-TW": { revokedNote:"已撤銷，重新整理頁面後會從清單移除。" },
});
register("machines", {
  en: { versionNotReported:"This Runtime does not provide version information", versionUnreadable:"Runtime version information is unavailable", buildId:"Code Build ID", buildUnavailable:"Build ID is unavailable", protocols:"Supported protocols", compatibility:"Protocol compatibility", compatible:"Compatible", legacy:"Connected using protocol v1; version metadata unavailable", incompatible:"No common reported protocol", protocolUnknown:"Not reported yet", capabilities:"Reported capabilities", capability_exec:"One-off execution", capability_mcp:"AgEnD tools (MCP)", capability_panes:"Persistent terminals" },
  "zh-TW": { versionNotReported:"此 Runtime 未提供版本資訊", versionUnreadable:"無法讀取 Runtime 版本資訊", buildId:"程式碼 Build ID", buildUnavailable:"無法取得 Build ID", protocols:"支援的協定", compatibility:"協定相容狀態", compatible:"相容", legacy:"已使用協定 v1 連線，未提供版本資訊", incompatible:"回報的協定與主機不相容", protocolUnknown:"尚未回報協定資訊", capabilities:"回報功能", capability_exec:"單次任務", capability_mcp:"AgEnD 工具（MCP）", capability_panes:"持續終端" },
});
register("machines", {
  en: { downloadBuilding:"Preparing ZIP…", stepZipHint:"Includes the address above. Extract it on the other computer.", stepLaunch:"Double-click connect-agend.bat there", stepLaunchHint:"Enter the pairing code when asked. A saved profile reconnects without it. If that computer is already paired to another AgEnD, this one gets its own profile and the existing pairing is kept. The window stays open and explains what to do if AgEnD disconnects it, including when jobs.json from another pairing must be deleted.",manualMultiHint:"Without agend-server.json, a profile paired to another AgEnD is never reused. Add --profile \"%USERPROFILE%\\.agend-runtime\\profiles\\<host>-<port>\" (any folder) to keep both, and pass the same --profile to run, status, rotate and disconnect.", stepApproveHint:"Keep the Runtime window open.", pairingApprove:"A computer is waiting for your approval", copyCode:"Copy", codeCopied:"Copied", newCode:"New code", manualCommand:"Manual connection command", downloadedFor:"Downloaded for: {0}", downloadFailed:"Could not download the Runtime", pairingHint:"Follow the four steps. This page updates automatically." },
  "zh-TW": { downloadBuilding:"正在準備 ZIP…", stepZipHint:"已內含上方位址，請在另一台電腦解壓縮。", stepLaunch:"在那台電腦雙擊 connect-agend.bat", stepLaunchHint:"提示時輸入配對碼；已有配對資料時會直接重連。若那台電腦已配對到另一個 AgEnD，這次會自動使用獨立的資料夾，原本的配對不受影響。若 AgEnD 中斷連線，視窗會保持開啟並說明下一步，包括何時需要刪除另一個配對留下的 jobs.json。",manualMultiHint:"沒有 agend-server.json 時，已配對到其他 AgEnD 的資料夾不會被重複使用。請加上 --profile \"%USERPROFILE%\\.agend-runtime\\profiles\\<host>-<port>\"（任何資料夾皆可）讓兩個都保留，之後 run、status、rotate、disconnect 也要帶相同的 --profile。", stepApproveHint:"請保持 Runtime 視窗開啟。", pairingApprove:"有電腦正在等待你核准", copyCode:"複製", codeCopied:"已複製", newCode:"重新產生", manualCommand:"手動連線指令", downloadedFor:"已下載，連線位址：{0}", downloadFailed:"無法下載 Runtime", pairingHint:"依下列四步操作，此頁會自動更新。" },
});
register("machines", {
  en: { installMethod:"Install method", tabWindows:"Windows (PowerShell)", tabZip:"Other install methods (ZIP)",
    stepInstall:"Install the Runtime", stepInstallHint:"Paste this into PowerShell on the other Windows computer. It downloads this fleet's Runtime, checks its checksum and installs it for your Windows user only. It does not connect, pair or need administrator rights. Windows Node.js 22.14 or newer is required; if it is missing, the command only tells you how to get it.",
    stepConnect:"Connect that computer", stepConnectHint:"Run this in the same PowerShell window (or open a new one). It asks for the one-time pairing code on the right, shows a pairing fingerprint, then waits for your approval here. The code is typed there, never put in the command.",
    installCommand:"Install command", connectCommand:"Connect command", copyCommand:"Copy command", commandCopied:"Copied",
    zipTabHint:"Prefer not to run a command? Download the ZIP here, move it to the other computer and extract it." },
  "zh-TW": { installMethod:"安裝方式", tabWindows:"Windows（PowerShell）", tabZip:"其他安裝方式（ZIP）",
    stepInstall:"安裝 Runtime", stepInstallHint:"在另一台 Windows 電腦的 PowerShell 貼上這行指令。它會下載這個 Fleet 的 Runtime、檢查校驗碼，並只為你的 Windows 使用者安裝；不會連線、不會配對，也不需要系統管理員權限。需要 Windows Node.js 22.14 以上；若沒有，指令只會告訴你怎麼取得。",
    stepConnect:"連接那台電腦", stepConnectHint:"在同一個 PowerShell 視窗（或新開一個）執行。它會要求輸入右側的一次性配對碼、顯示配對指紋，然後等待你在這裡核准。配對碼是在那裡輸入的，不會寫進指令。",
    installCommand:"安裝指令", connectCommand:"連線指令", copyCommand:"複製指令", commandCopied:"已複製",
    zipTabHint:"不想執行指令？在這裡下載 ZIP，傳到另一台電腦並解壓縮。" },
});
/** The origin, only when it is composed of inert hostname/port characters; "" otherwise. Nothing else is placed in a copyable shell command. */
function safeRuntimeOrigin(server) {
  try {
    const url = new URL(server);
    const local = ["localhost","127.0.0.1","[::1]"].includes(url.hostname);
    if (!/^([a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || !(url.protocol === "https:" || url.protocol === "http:" && local)) return "";
    return url.origin;
  } catch { return ""; }
}
/** ZIP flow: run from the extracted folder. */
export function runtimeConnectCommand(server) {
  const origin = safeRuntimeOrigin(server);
  return origin ? `.\\agend-runtime.cmd connect --server "${origin}"` : "";
}
/** Windows one-line install. The address is handed to the script by this command; the script never looks it up. No secret or pairing code is in it. */
export function runtimeInstallCommand(server) {
  const origin = safeRuntimeOrigin(server);
  return origin ? `$agend = '${origin}'; irm "$agend/runtime/install.ps1" | iex` : "";
}
/** After the install script: agend-runtime is on the user's PATH. The pairing code is typed into the terminal, never here. */
export function runtimeWindowsConnectCommand(server) {
  const origin = safeRuntimeOrigin(server);
  return origin ? `agend-runtime connect --server "${origin}"` : "";
}
export function machineTime(value) { const date=new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString() : machineText("unknown"); }
function MachineCard({ machine, busy, action, openDiagnostics, probe }) {
  const [editing,setEditing] = useState(false), [name,setName] = useState(machine.name), [info,setInfo] = useState(false);
  const detection = useWindowsCliCatalogSnapshot(machine.isLocal ? "" : machine.id);
  const probing = machine.probing || detection.loading;
  const clis = (machine.inventory?.clis || []).filter(cli => cli.path);
  const local = machine.isLocal === true, status = local ? machine.inventory ? "available" : "unknown" : machine.status;
  const ready = local || ["online","offline"].includes(status), revoked = !local && status === "revoked";
  const menuItems = [{key:"info",label:machineText("machineInfo"),icon:"info",onSelect:()=>setInfo(true)},
    !local && status !== "revoked" && {key:"rename",label:machineText("rename"),icon:"edit",onSelect:()=>setEditing(true)},
    !local && status !== "revoked" && {key:"revoke",label:machineText("revoke"),icon:"close",danger:true,onSelect:()=>action(machine,"revoke")}];
  return html`<article class=${`runtime-machine${local ? " runtime-native-local" : ""}${revoked ? " is-revoked" : ""}`} data-machine-id=${local ? "local" : machine.id}>
    <header><span class="runtime-machine-icon"><${Icon} name="fleet" size=${22} /></span><div><h3>${machine.name}${revoked ? null : html`<span class="runtime-kind">${machineText(local ? "localBadge" : "pairedBadge")}</span>`}</h3><p>${machine.platform === "win32" ? "Windows" : machine.platform || machineText("unknown")}${machine.hostname && machine.hostname !== machine.name ? ` · ${machine.hostname}` : ""} · ${machineText("cliCount",clis.length)}</p></div><span class=${`runtime-status is-${status}`}><span class="windows-cli-dot"></span>${machineText(["available","online","offline","pending","revoked"].includes(status) ? status : "unknown")}</span></header>
    ${revoked ? null : html`<p class="runtime-inventory-time note">${machine.inventoryUpdatedAt ? machineText("inventoryAt",machineTime(machine.inventoryUpdatedAt)) : machineText("neverDetected")}</p>`}
    ${status === "pending" ? html`<div class="runtime-approval"><p>${machineText("fingerprintLabel")}<code class="runtime-pairing-fingerprint">${machine.pairingFingerprint || machineText("unknown")}</code></p><p class="note">${machineText("approvalHint")}</p></div>` : null}
    ${revoked ? html`<p class="note runtime-revoked-note" role="status">${machineText("revokedNote")}</p>` : clis.length ? html`<table class="runtime-cli-table" aria-label=${machineText("cli")}><thead><tr><th>${machineText("cli")}</th><th>${machineText("versionColumn")}</th><th>${machineText("signInColumn")}</th></tr></thead><tbody>${clis.map(cli=>html`<tr key=${cli.id}><td><span class="runtime-cli-product"><${CliProductMark} id=${cli.id} size=${21} /><strong>${cliLabel(cli.id)}</strong></span>${cli.supports?.execution === false ? html`<small>${machineText("detectionOnly")}</small>` : null}</td><td><span class="runtime-cli-version" title=${cli.version || ""}>${cli.version || "—"}</span></td><td><span class=${`runtime-cli-auth ${cli.authenticated === true ? "is-signed-in" : ""}`}><span class="windows-cli-dot"></span>${machineText(cli.authenticated === true ? "signedIn" : cli.authenticated === false ? "signedOut" : "authShort")}</span></td></tr>`)}</tbody></table>` : html`<p class="note runtime-no-clis">${machineText(local ? "noLocalClis" : "noClis")}</p>`}
    <div class="runtime-machine-actions">${ready ? html`<button type="button" class="btn btn-sm runtime-inspect" onClick=${() => openDiagnostics(local ? "" : machine.id)}>${machineText("diagnosticTitle")}</button><button type="button" class="btn btn-sm runtime-probe" disabled=${busy || probing || !local && status !== "online"} onClick=${() => probe(local ? "" : machine.id)}><${Icon} name="restart" size=${14} cls=${probing ? "out-spin" : ""} />${machineText(probing ? "probeBusy" : "probeAgain")}</button>` : null}
      ${status === "pending" ? html`<button type="button" class="btn btn-primary btn-sm" disabled=${busy || !machine.pairingFingerprint} onClick=${() => action(machine,"approve",{fingerprint:machine.pairingFingerprint})}>${machineText("approve")}</button>` : null}
      <${Menu} cls="runtime-machine-menu" label=${machineText("machineActions",machine.name)} disabled=${busy} items=${menuItems} />
    </div>
    ${info ? html`<${Dialog} title=${`${machineText("machineInfo")} · ${machine.name}`} onClose=${()=>setInfo(false)}><dl class="runtime-machine-facts"><dt>${machineText("machineName")}</dt><dd>${machine.name}</dd><dt>${machineText("hostName")}</dt><dd>${machine.hostname || machine.inventory?.hostname || machineText("unknown")}</dd><dt>${machineText("platform")}</dt><dd>${machine.platform === "win32" ? "Windows" : machine.platform}</dd>${local ? html`<dt>${machineText("home")}</dt><dd>${machine.inventory?.home || machineText("unknown")}</dd>` : html`<dt>${machineText("version")}</dt><dd class="runtime-reported-version">${machine.runtimeInfo?.version || machineText(machine.runtimeInfo ? "versionUnreadable" : "versionNotReported")}</dd>${machine.runtimeInfo ? html`<dt>${machineText("buildId")}</dt><dd class="runtime-reported-build"><code>${machine.runtimeInfo?.buildId || machineText("buildUnavailable")}</code></dd><dt>${machineText("protocols")}</dt><dd>${machine.runtimeInfo?.protocolVersions?.map(v=>`v${v}`).join(", ") || machineText("protocolUnknown")}</dd>` : null}<dt>${machineText("compatibility")}</dt><dd class="runtime-compatibility">${machineText(["compatible","legacy","incompatible"].includes(machine.runtimeCompatibility) ? machine.runtimeCompatibility : "protocolUnknown")}</dd>${machine.runtimeInfo ? html`<dt>${machineText("capabilities")}</dt><dd>${machine.runtimeInfo?.capabilities?.map(capability=>["exec","mcp","panes"].includes(capability) ? machineText(`capability_${capability}`) : capability).join(" · ") || machineText("unknown")}</dd>` : null}<dt>${machineText("lastSeenLabel")}</dt><dd>${machineTime(machine.lastSeenAt)}</dd><dt>${machineText("identity")}</dt><dd><code>${machine.id}</code></dd>`}</dl></${Dialog}>` : null}
    ${editing ? html`<${Dialog} title=${machineText("rename")} onClose=${()=>setEditing(false)} busy=${busy}><form class="runtime-rename" onSubmit=${event=>{event.preventDefault();if(name.trim())void action(machine,"rename",{name:name.trim()}).then(ok=>{if(ok)setEditing(false);});}}><label><span>${machineText("name")}</span><input value=${name} maxLength=${100} onInput=${event=>setName(event.target.value)} /></label><button class="btn btn-primary btn-sm" type="submit" disabled=${busy || !name.trim()}>${machineText("save")}</button></form></${Dialog}>` : null}
  </article>`;
}
function RuntimeDiagnosticsDialog({ navKey, machineId, machine, enabled, drafts, session, taskLease, onChanged, onClose }) {
  const name = machine?.name || machineText("targetUnavailable");
  return html`<${Dialog} title=${`${machineText("diagnosticTitle")} · ${name}`} cls="runtime-diagnostics-dialog" wide=${true} onClose=${onClose}
    tools=${html`<span class=${`runtime-status is-${machine?.status || "offline"}`}>${machineText(machine?.isLocal ? "localBadge" : machine?.status || "offline")}</span>`}>
    <div class="runtime-diagnostics"><p class="runtime-diagnostics-hint">${machineText("diagnosticHint")}</p><${WindowsCliPanel} navKey=${`${navKey}:diagnostics:${machineId || "local"}`} embedded=${true} diagnostic=${true} enabled=${enabled} machineId=${machineId} machine=${machine} drafts=${drafts} session=${session} taskLease=${taskLease} onInventoryChanged=${onChanged} /></div>
  </${Dialog}>`;
}
/** M-2255: the switches (fleet.yaml `runtimes`); `env` names the variable that overrides each. */
const SWITCHES = [
  { name: "windows_cli", id: "runtimeWindowsCli", env: "AGEND_WINDOWS_CLI", label: "windowsCli" },
  { name: "remote_runtime", id: "runtimeRemoteRuntime", env: "AGEND_REMOTE_RUNTIME", label: "remoteRuntime" },
];
export const RUNTIME_DOCS = "https://github.com/songsid/AgEnD/blob/main/docs/remote-runtime.md#connecting-over-a-private-network";
/**
 * M-2255 (the user, hmsg-71c25c9b): "Use this PC's Windows CLIs" and "Allow other Windows computers to pair", saved in
 * fleet.yaml like any setting: on is confirmed by a fleet admin, off applies at once (after asking here). A switch the
 * environment sets is shown as such and cannot be changed here.
 */
function RuntimeSwitches({ lease, onChanged, computers }) {
  const [view,setView]=useState(null), [busy,setBusy]=useState(""), [pending,setPending]=useState(""), [error,setError]=useState(""), [unavailable,setUnavailable]=useState(false);
  const [limit,setLimit]=useState(""), [limitNote,setLimitNote]=useState("");
  // A number being typed is the person's: a reload (a switch's answer) never replaces it; a save of it does.
  const limitEdited=useRef(false);
  const switches=view?.switches;
  const load=async() => {
    const response=await lease.fetch("/api/settings/runtimes",{credentials:"same-origin"});
    if (!lease.current()) return;
    if (response.status === 403) { setUnavailable(true); return; }
    const value=await response.json().catch(() => ({}));
    if (!response.ok || !value.switches) throw new Error(value.error || `HTTP ${response.status}`);
    if (!lease.current()) return;
    setView(value);
    if (!limitEdited.current) setLimit(String(value.max_agents_per_machine?.value ?? ""));
  };
  useEffect(() => { load().catch(e => { if (lease.current()) setError(machineText("switchFailed", e.message)); }); }, [lease]);
  const change=async(item,on) => {
    if (busy) return;
    if (!on && !await confirmDialog({message:machineText(`${item.label}OffAsk`),confirmLabel:machineText("turnOff"),danger:true})) return;
    if (!lease.current()) return;
    setBusy(item.name);setError("");
    try {
      const res=await confirmedWrite("/api/settings/fleet/runtimes",{method:"PUT",body:{[item.name]:on},label:machineText(item.label),onPending:() => { if (lease.current()) setPending(item.name); }});
      if (!lease.current()) return;
      if (!res.ok) setError(machineText("switchFailed",(res.body && res.body.error) || String(res.status)));
      await load();
      if (lease.current()) onChanged?.();
    } catch (e) { if (lease.current()) setError(machineText("switchFailed",e.message)); }
    finally { if (lease.current()) { setBusy("");setPending(""); } }
  };
  const bounds=view?.max_agents_per_machine;
  const limitValue=Number(limit), limitValid=!!bounds && Number.isInteger(limitValue) && limitValue >= bounds.min && limitValue <= bounds.max;
  const saveLimit=async(event) => {
    event.preventDefault();
    if (busy || !limitValid || limitValue === bounds.value) return;
    setBusy("limit");setError("");setLimitNote("");
    try {
      const res=await confirmedWrite("/api/settings/fleet/runtimes",{method:"PUT",body:{max_agents_per_machine:limitValue},label:machineText("limit")});
      if (!lease.current()) return;
      if (res.ok) { limitEdited.current=false; setLimitNote(machineText("limitSaved")); } else setError(machineText("switchFailed",(res.body && res.body.error) || String(res.status)));
      await load();
    } catch (e) { if (lease.current()) setError(machineText("switchFailed",e.message)); }
    finally { if (lease.current()) setBusy(""); }
  };
  const origin=view?.local_origin || "http://127.0.0.1:19280", port=(() => { try { return new URL(origin).port || "80"; } catch { return "19280"; } })();
  // Commands, not words: the same in every language (built here, never translated).
  const serveCommand=`tailscale serve --https=443 ${origin}`, sshCommand=`ssh -N -L 127.0.0.1:${port}:127.0.0.1:${port} user@this-computer`;
  const guide=html`<details class="runtime-connect-guide"><summary>${machineText("connectionHelp")}</summary><h3>${machineText("firstConnection")}</h3><ol><li>${machineText("stepDownload")}</li><li>${machineText("stepRun")}</li><li>${machineText("stepApprove")}</li></ol><details class="runtime-guide">
    <summary>${machineText("guide")}</summary>
    <p>${machineText("guideAddress")}</p><pre><code>${serveCommand}</code></pre>
    <p>${machineText("guideSsh",port)}</p><pre><code>${sshCommand}</code></pre>
    <p class="runtime-guide-warn">${machineText("guideFunnel")}</p><p class="runtime-guide-warn">${machineText("guideLan")}</p>
    <p>${machineText("guidePair")}</p><p>${machineText("guideApprove")}</p>
    <a class="runtime-guide-link" href=${RUNTIME_DOCS} target="_blank" rel="noopener noreferrer">${machineText("remoteRuntimeDocs")}<${Icon} name="external" size=${14} /></a>
  </details><p class="note">${machineText("connectionNote")}</p></details>`;
  if (unavailable) return html`<div class="runtime-layout"><div class="runtime-main">${computers}<section class="runtime-switches" aria-label=${machineText("switches")}><div class="runtime-switches-main"><h3>${machineText("switches")}</h3><p class="note">${machineText("switchesUnavailable")}</p></div></section></div></div>`;
  return html`<div class="runtime-layout"><div class="runtime-main">${computers}<section class="runtime-switches" aria-label=${machineText("switches")}>
    <details class="runtime-policy s-ui-disclosure"><summary><${Icon} name="settings" size=${22} /><span><strong>${machineText("policies")}</strong><small>${machineText("policySummary")}</small></span></summary>
    <div class="runtime-switches-main">
    <h3>${machineText("switches")}</h3>
    ${SWITCHES.map(item => {
      const state=switches?.[item.name];
      return html`<div key=${item.name} class="runtime-switch" data-switch=${item.name}>
        <label class="runtime-switch-row" for=${item.id}>
          <input id=${item.id} class="s-ui-toggle" type="checkbox" role="switch" checked=${state?.on === true} aria-describedby=${`${item.id}Help`}
            disabled=${!state || !!state.environment || !!busy} onChange=${e => { const want=e.target.checked; e.target.checked=!want; void change(item,want); }} />
          <span><strong>${machineText(item.label)}</strong><small id=${`${item.id}Help`}>${machineText(`${item.label}Help`)}</small></span>
        </label>
        ${pending === item.name ? html`<p class="note runtime-switch-pending" role="status">${machineText("switchPending")}</p>` : null}
        ${state?.environment ? html`<p class="note runtime-switch-env">${machineText("setByEnv",item.env,state.environment === "on" ? "1" : "0")}</p>` : null}
      </div>`;
    })}
    <form class="runtime-limit" onSubmit=${saveLimit}>
      <label for="runtimeMaxAgents"><strong>${machineText("limit")}</strong><small id="runtimeMaxAgentsHelp">${bounds ? machineText("limitHelp",bounds.min,bounds.max,bounds.default) : ""}</small></label>
      <div><input id="runtimeMaxAgents" type="number" inputMode="numeric" min=${bounds?.min ?? 1} max=${bounds?.max ?? 16} step="1" value=${limit} aria-describedby="runtimeMaxAgentsHelp"
        disabled=${!bounds || !!busy} onInput=${e => { limitEdited.current=true; setLimit(e.target.value); setLimitNote(""); }} />
      <button type="submit" class="btn btn-sm" disabled=${!limitValid || limitValue === bounds?.value || !!busy}>${machineText("limitSave")}</button>
      ${limitNote ? html`<span class="note" role="status">${limitNote}</span>` : null}</div>
    </form>
    <p class="note">${machineText("switchesNote")}</p>
    ${error ? html`<p class="runtime-error" role="alert">${error}</p>` : null}
    </div></details></section></div>
    ${guide}
  </div>`;
}
export function RuntimesPanel({navKey}) {
  const lease=useLease(`runtimes:${navKey}`), state=useRuntimeCatalog(), {windowsCli}=useStore(appStore);
  const localInventory=useWindowsCliCatalog(windowsCli);
  const [pairing,setPairing]=useState(null), [busy,setBusy]=useState(""), [error,setError]=useState("");
  const [server,setServer]=useState(() => typeof location === "undefined" ? "" : location.origin);
  const drafts=useRef(new Map()), taskSessions=useRef(new Map()), downloadClaim=useRef(false);
  const [downloadedFor,setDownloadedFor]=useState(""), [copied,setCopied]=useState(false);
  const [tab,setTab]=useState("windows"), [copiedCommand,setCopiedCommand]=useState(""), [installCopied,setInstallCopied]=useState(false);
  const [diagnosticMachineId,setDiagnosticMachineId]=useState(null);
  // Computers revoked on this page stay on screen as revoked until the page is left or reloaded; the server keeps the record.
  const [revokedHere,setRevokedHere]=useState(() => new Map());
  const openDiagnostics=id=>setDiagnosticMachineId(id);
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
    try {
      await post(`/ui/runtimes/machines/${encodeURIComponent(machine.id)}/${operation}`,body);if(!lease.current())return false;
      // Kept before the refresh, so the card is never dropped between the answer and the new list.
      if(operation === "revoke")setRevokedHere(seen=>new Map(seen).set(machine.id,{...machine,status:"revoked"}));
      await state.refresh();return lease.current();
    }
    catch(e){if(lease.current())setError(operation === "refresh" ? `${machineText("cliFailed")} ${e.message}` : e.message);return false;}
    finally{if(lease.current())setBusy("");}
  };
  const machines=state.data?.machines || [];
  const localMachine={id:"",isLocal:true,name:localInventory.data?.hostname || machineText("nativeWindows"),platform:"win32",status:windowsCli ? "online" : "offline",inventory:localInventory.data,inventoryUpdatedAt:localInventory.data?.probedAt,probing:localInventory.loading};
  const listed=machines.filter(machine=>machine.status !== "revoked" || revokedHere.has(machine.id));
  const gone=[...revokedHere.values()].filter(machine=>!machines.some(row=>row.id === machine.id));
  const allMachines=[...(windowsCli ? [localMachine] : []),...[...listed,...gone].map(machine=>({...machine,...(revokedHere.has(machine.id) ? {status:"revoked"} : {}),probing:busy===machine.id}))];
  const target=diagnosticMachineId === "" ? localMachine : machines.find(machine=>machine.id===diagnosticMachineId);
  if(diagnosticMachineId !== null && !taskSessions.current.has(diagnosticMachineId)) taskSessions.current.set(diagnosticMachineId,{requestId:null,pending:false,error:""});
  const probeTarget=async(id="")=>{
    setBusy(id || "local");setError("");
    try{const result=await refreshWindowsCliCatalog(id);if(!lease.current())return;if(!result)throw Error(machineText("cliFailed"));if(id)await state.refresh();}
    catch(error){if(lease.current())setError(error.message);}
    finally{if(lease.current())setBusy("");}
  };
  const copyCode=async() => {
    try {await navigator.clipboard.writeText(pairing.code);if(!lease.current())return;setCopied(true);lease.timeout(() => setCopied(false),2000);}catch { /* the code is on screen to copy by hand */ }
  };
  const command=runtimeConnectCommand(server), installCommand=runtimeInstallCommand(server), windowsConnectCommand=runtimeWindowsConnectCommand(server);
  const copyCommand=async(key,text) => {
    try {await navigator.clipboard.writeText(text);if(!lease.current())return;setCopiedCommand(key);if(key === "install")setInstallCopied(true);lease.timeout(() => setCopiedCommand(""),2000);}catch { /* the command is on screen to copy by hand */ }
  };
  const awaitingApproval=machines.some(machine => machine.status === "pending"), installed=tab === "windows" ? installCopied : !!downloadedFor, currentStep=awaitingApproval ? 4 : installed ? 3 : 2;
  const step=(n,title,body) => html`<li class=${`runtime-step${n < currentStep ? " is-done" : ""}`} aria-current=${n === currentStep ? "step" : undefined}><span class="runtime-step-n" aria-hidden="true">${n}</span><div><h4>${title}</h4>${body}</div></li>`;
  const downloadRuntime=async()=>{
    if(downloadClaim.current || !command)return;
    const target=new URL(server).origin;downloadClaim.current=true;setBusy("download");setError("");setDownloadedFor("");
    try{
      const response=await lease.fetch("/ui/runtimes/download/windows",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({server:target})});
      if(!lease.current())return;
      if(!response.ok){const body=await response.json();throw Error(body.error || machineText("downloadFailed"));}
      const blob=await response.blob();if(!lease.current())return;
      const url=URL.createObjectURL(blob),release=lease.hold(()=>URL.revokeObjectURL(url));
      const link=document.createElement("a");link.href=url;link.download=/filename="([a-zA-Z0-9._-]+\.zip)"/.exec(response.headers.get("content-disposition") || "")?.[1] || "agend-runtime-windows.zip";
      document.body.appendChild(link);link.click();link.remove();lease.timeout(release,1000);setDownloadedFor(target);
    }catch(error){if(lease.current())setError(error.message || machineText("downloadFailed"));}
    finally{downloadClaim.current=false;if(lease.current())setBusy("");}
  };
  const download=(setup=false)=>html`<button type="button" class="btn btn-sm runtime-bundle-download" disabled=${!!busy || !setup && !command} onClick=${setup ? connect : downloadRuntime}><${Icon} name="download" size=${15} />${machineText(busy === "download" ? "downloadBuilding" : "download")}</button>`;

  const commandCard=(key,label,text) => html`<div class="runtime-command-card"><span class="runtime-command-label">${label}</span><div class="runtime-command-row"><pre class="runtime-command-text" tabindex="0" aria-label=${label}><code>${text}</code></pre><button type="button" class="btn btn-sm" onClick=${() => copyCommand(key,text)}><${Icon} name="copy" size=${15} />${machineText(copiedCommand === key ? "commandCopied" : "copyCommand")}</button></div></div>`;
  const tabItems=[{id:"windows",label:machineText("tabWindows")},{id:"zip",label:machineText("tabZip")}];
  const tabKeys=(event,index) => {
    let next;
    if (event.key === "ArrowRight") next=(index+1) % tabItems.length;
    else if (event.key === "ArrowLeft") next=(index-1+tabItems.length) % tabItems.length;
    else if (event.key === "Home") next=0;
    else if (event.key === "End") next=tabItems.length-1;
    else return;
    event.preventDefault();setTab(tabItems[next].id);
    if(typeof document !== "undefined")lease.timeout(() => document.getElementById(`runtime-install-tab-${tabItems[next].id}`)?.focus(),0);
  };
  const installTabs=html`<div class="s-page-tabs runtime-install-tabs" role="tablist" aria-label=${machineText("installMethod")}>${tabItems.map((item,index) => html`<button key=${item.id} id=${`runtime-install-tab-${item.id}`} type="button" role="tab" class=${tab === item.id ? "on" : ""} aria-selected=${tab === item.id ? "true" : "false"} aria-controls="runtime-install-panel" tabindex=${tab === item.id ? 0 : -1} onClick=${() => setTab(item.id)} onKeyDown=${event => tabKeys(event,index)}>${item.label}</button>`)}</div>`;
  const addressStep=step(1,machineText("server"),html`<input type="url" aria-label=${machineText("server")} value=${server} disabled=${busy === "download"} spellcheck=${false} onInput=${event => setServer(event.target.value)} /><p class="note">${machineText("serverHint")}</p>${command ? null : html`<p role="alert">${machineText("serverInvalid")}</p>`}`);
  const approveStep=step(4,machineText("stepApprove"),html`<p class="note">${machineText("stepApproveHint")}</p>`);
  const windowsSteps=html`${addressStep}
      ${step(2,machineText("stepInstall"),html`<p class="note">${machineText("stepInstallHint")}</p>${installCommand ? commandCard("install",machineText("installCommand"),installCommand) : null}`)}
      ${step(3,machineText("stepConnect"),html`<p class="note">${machineText("stepConnectHint")}</p>${windowsConnectCommand ? commandCard("connect",machineText("connectCommand"),windowsConnectCommand) : null}`)}
      ${approveStep}`;
  const zipSteps=html`${addressStep}
      ${step(2,machineText("stepDownload"),html`<p class="note">${machineText("stepZipHint")}</p>${download()}${downloadedFor ? html`<p class="note" role="status">${machineText("downloadedFor",downloadedFor)}</p>` : null}`)}
      ${step(3,machineText("stepLaunch"),html`<p class="note">${machineText("stepLaunchHint")}</p>${command ? html`<details class="runtime-manual-command"><summary>${machineText("manualCommand")}</summary><label><span>${machineText("command")}</span><input class="runtime-command" value=${command} readOnly=${true} spellcheck=${false} /></label><p class="note">${machineText("manualMultiHint")}</p></details>` : null}`)}
      ${approveStep}`;

  const computers = html`<section class="runtime-computers"><div class="runtime-computers-heading"><h3>${machineText("computersTitle")}</h3><span class="note">${machineText("machineCount",allMachines.length)}</span></div>
    <section class="runtime-machines" aria-label=${machineText("machines")}>${allMachines.map(machine=>html`<${MachineCard} key=${machine.isLocal ? "local" : machine.id} machine=${machine} busy=${!!busy || !!machine.probing} action=${action} openDiagnostics=${openDiagnostics} probe=${probeTarget} />`)}</section>
    ${state.data && !allMachines.some(machine=>!machine.isLocal) ? html`<p class="note runtime-empty-remotes">${machineText("empty")}</p>` : null}
    <article class="runtime-host-note"><${Icon} name="info" size=${18} /><span>${machineText("hostLocationNote")}</span></article></section>`;

  return html`<section class="runtime-settings">
    <header class="runtime-heading s-page-head"><div><h2>${machineText("title")}<span class="s-scope">${machineText("fleetScope")}</span></h2><p class="s-page-lead">${machineText("lead")}</p></div><div><button type="button" class="btn btn-primary btn-sm" disabled=${!!busy || state.data?.enabled !== true} onClick=${connect}><${Icon} name="plus" size=${15} />${machineText("connect")}</button>${state.data?.enabled === true && !pairing ? download(true) : null}<button type="button" class="btn btn-sm" disabled=${state.loading} onClick=${state.refresh}><${Icon} name="restart" size=${15} />${machineText("refresh")}</button></div></header>
    ${state.data?.enabled === false ? html`<p class="note">${machineText("disabled")}</p>` : null}
    ${state.loading && !state.data ? html`<p role="status" aria-busy="true"><span class="out-spin" aria-hidden="true"></span> ${machineText("loading")}</p>` : null}
    ${error || state.error ? html`<div class="runtime-error" role="alert"><p>${error || state.error}</p>${state.data && state.error ? html`<p>${machineText("seenCached")}</p>` : null}<button type="button" class="btn btn-sm" onClick=${state.refresh}>${machineText("retry")}</button></div>` : null}
    ${pairing ? html`<section class="runtime-pairing" aria-label=${machineText("pairing")}><header><h3>${machineText("pairing")}</h3><p class="note">${machineText("pairingHint")}</p></header><div class="runtime-pairing-body"><div class="runtime-install">${installTabs}<div id="runtime-install-panel" class="runtime-install-panel" role="tabpanel" aria-labelledby=${`runtime-install-tab-${tab}`} data-install-method=${tab}><ol class="runtime-steps">
      ${tab === "windows" ? windowsSteps : zipSteps}
    </ol></div></div><aside class=${`runtime-pair-card${awaitingApproval ? " is-pending" : ""}`}><label><span>${machineText("pairingCode")}</span><div class="runtime-pair-code-row"><input class="runtime-pair-code" value=${pairing.code} readOnly=${true} spellcheck=${false} autocomplete="off" /><button type="button" class="btn btn-sm" onClick=${copyCode}><${Icon} name="copy" size=${15} />${machineText(copied ? "codeCopied" : "copyCode")}</button></div></label><p class="note">${machineText("expires",machineTime(pairing.expiresAt))}</p><p class="runtime-pair-status" role="status"><span class="windows-cli-dot"></span>${machineText(awaitingApproval ? "pairingApprove" : "pairingWait")}</p><div class="runtime-pair-actions"><button type="button" class="btn btn-sm" disabled=${!!busy} onClick=${connect}>${machineText("newCode")}</button><button type="button" class="btn btn-ghost btn-sm" onClick=${() => setPairing(null)}>${machineText("closeCode")}</button></div></aside></div></section>` : null}
    <${RuntimeSwitches} lease=${lease} onChanged=${state.refresh} computers=${computers} />
    ${diagnosticMachineId !== null ? html`<${RuntimeDiagnosticsDialog} key=${diagnosticMachineId || "local"} navKey=${navKey} machineId=${diagnosticMachineId} machine=${target} enabled=${diagnosticMachineId !== "" || windowsCli} drafts=${drafts.current} session=${taskSessions.current.get(diagnosticMachineId)} taskLease=${lease} onChanged=${state.refresh} onClose=${()=>setDiagnosticMachineId(null)} />` : null}
    <p class="note runtime-operations-note">${machineText("operationsNote")}</p>
  </section>`;
}
