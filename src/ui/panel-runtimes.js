import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { Icon } from "/assets/ui-icons.js";
import { Skeleton } from "/assets/ui-states.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Menu } from "/assets/ui-menu.js";
import { appStore, useStore } from "/assets/app-store.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { confirmedWrite } from "./settings-confirm.js";
import { CliProductMark, cliLabel } from "./cli-picker.js";
import { WindowsCliPanel } from "./panel-windows-cli.js";
import { useRuntimeCatalog } from "./runtime-catalog.js";
import { runtimeConnectCommand, runtimeEnrollCommand, runtimeInstallCommand, runtimeInstallOnlyCommand, runtimeWindowsConnectCommand } from "./runtime-commands.js";
import { RuntimeUpdateNotice, runtimeUpdateText, runtimeFreshInstallCommand } from "./runtime-update-status.js";
import { credentialProfileView, credentialProfileState } from "./credential-profile-select.js";
import { identityText } from "./account-identity.js";
import { CliInstall, offersCliInstall } from "./runtime-cli-install.js";
import { useWindowsCliCatalog, refreshWindowsCliCatalog, useWindowsCliCatalogSnapshot } from "./windows-cli-catalog.js";

/** The install tabs', command cards' and account list's stylesheet, linked once by this lazy page (a tab opened before an upgrade has an app.css without these rules). */
export function linkRuntimeInstallCss(doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc || !doc.head || doc.querySelector('link[data-runtime-install-css="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/runtime-install.css"); link.setAttribute("data-runtime-install-css", "1");
    doc.head.appendChild(link);
  } catch { /* the page still works, only plainer, without it */ }
}
linkRuntimeInstallCss();

register("machines", {
  en: { paneUnverified:"Not yet verified", paneUnverifiedHint:"AgEnD has not tested this version in Windows panes yet. It still runs; any screen AgEnD does not recognise stops and waits for you in Needs you.", paneDenied:"Known not to work", paneDeniedHint:"AgEnD knows this version does not work in Windows panes, so it will not start it. Install a different version." },
  "zh-TW": { paneUnverified:"尚未驗證", paneUnverifiedHint:"AgEnD 還沒在 Windows 面板中測試過這個版本。它仍然可以執行；遇到 AgEnD 認不得的畫面時，會停下來在「需要你」等你處理。", paneDenied:"已知無法使用", paneDeniedHint:"AgEnD 已知這個版本無法在 Windows 面板中使用，所以不會啟動它。請改裝其他版本。" },
});
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
    guidePair:"2. Click Connect a computer, copy the one-time PowerShell command it shows and paste it on the other PC, or give it to an AI agent running there: it installs the Runtime and connects, with no pairing code and no approval. A pairing code (under Manual options) or the ZIP is the alternative.", guideApprove:"3. That PC then appears under Connected computers, with a notice and a Revoke button. Pairing-code and ZIP connections ask you to approve here.",
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
    guidePair:"2. 按「連接電腦」，複製頁面顯示的一次性 PowerShell 指令，貼到另一台電腦，或交給在那台電腦上執行的 AI agent：它會安裝 Runtime 並直接連線，不用配對碼，也不用核准。配對碼（在手動選項裡）或 ZIP 是另外的做法。", guideApprove:"3. 那台電腦會出現在「已連接的電腦」，並有通知和撤銷按鈕。用配對碼或 ZIP 連線時，要在這裡核准。",
    turnOff:"關閉此功能",
  },
});
export { runtimeConnectCommand, runtimeEnrollCommand, runtimeInstallCommand, runtimeInstallOnlyCommand, runtimeWindowsConnectCommand };
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
  en: { versionNotReported:"This Runtime does not provide version information", versionUnreadable:"Runtime version information is unavailable", buildId:"Code Build ID", buildUnavailable:"Build ID is unavailable", protocols:"Supported protocols", compatibility:"Protocol compatibility", compatible:"Compatible", legacy:"Connected using protocol v1; version metadata unavailable. Re-run the install command to update it", incompatible:"Not compatible with this AgEnD: re-run the install command on that computer", protocolUnknown:"Not reported yet", capabilities:"Reported capabilities", capability_exec:"One-off execution", capability_mcp:"AgEnD tools (MCP)", capability_panes:"Persistent terminals" },
  "zh-TW": { versionNotReported:"此 Runtime 未提供版本資訊", versionUnreadable:"無法讀取 Runtime 版本資訊", buildId:"程式碼 Build ID", buildUnavailable:"無法取得 Build ID", protocols:"支援的協定", compatibility:"協定相容狀態", compatible:"相容", legacy:"已使用協定 v1 連線，未提供版本資訊。可重新執行安裝指令來更新", incompatible:"與這台 AgEnD 不相容：請在那台電腦重新執行安裝指令", protocolUnknown:"尚未回報協定資訊", capabilities:"回報功能", capability_exec:"單次任務", capability_mcp:"AgEnD 工具（MCP）", capability_panes:"持續終端" },
});
register("machines", {
  en: { downloadBuilding:"Preparing ZIP…", stepZipHint:"Includes the address above. Extract it on the other computer.", stepLaunch:"Double-click connect-agend.bat there", stepLaunchHint:"Enter the pairing code when asked. A saved profile reconnects without it. If that computer is already paired to another AgEnD, this one gets its own profile and the existing pairing is kept. The window stays open and explains what to do if AgEnD disconnects it, including when jobs.json from another pairing must be deleted.",manualMultiHint:"Without agend-server.json, a profile paired to another AgEnD is never reused. Add --profile \"%USERPROFILE%\\.agend-runtime\\profiles\\<host>-<port>\" (any folder) to keep both, and pass the same --profile to run, status, rotate and disconnect.", stepApproveHint:"Keep the Runtime window open.", pairingApprove:"A computer is waiting for your approval", copyCode:"Copy", codeCopied:"Copied", newCode:"New code", manualCommand:"Manual connection command", downloadedFor:"Downloaded for: {0}", downloadFailed:"Could not download the Runtime", pairingHint:"Generate a one-time install command, paste it on the other computer, and this page shows that computer joining." },
  "zh-TW": { downloadBuilding:"正在準備 ZIP…", stepZipHint:"已內含上方位址，請在另一台電腦解壓縮。", stepLaunch:"在那台電腦雙擊 connect-agend.bat", stepLaunchHint:"提示時輸入配對碼；已有配對資料時會直接重連。若那台電腦已配對到另一個 AgEnD，這次會自動使用獨立的資料夾，原本的配對不受影響。若 AgEnD 中斷連線，視窗會保持開啟並說明下一步，包括何時需要刪除另一個配對留下的 jobs.json。",manualMultiHint:"沒有 agend-server.json 時，已配對到其他 AgEnD 的資料夾不會被重複使用。請加上 --profile \"%USERPROFILE%\\.agend-runtime\\profiles\\<host>-<port>\"（任何資料夾皆可）讓兩個都保留，之後 run、status、rotate、disconnect 也要帶相同的 --profile。", stepApproveHint:"請保持 Runtime 視窗開啟。", pairingApprove:"有電腦正在等待你核准", copyCode:"複製", codeCopied:"已複製", newCode:"重新產生", manualCommand:"手動連線指令", downloadedFor:"已下載，連線位址：{0}", downloadFailed:"無法下載 Runtime", pairingHint:"產生一次性安裝指令，貼到另一台電腦執行，這一頁會顯示那台電腦加入。" },
});
register("machines", {
  en: { installMethod:"Install method", tabWindows:"Windows (PowerShell)", tabZip:"Other install methods (ZIP)",
    stepInstall:"Copy the one-time install command", stepInstallHint:"Paste this into PowerShell on any Windows computer, or hand it to an AI agent running there. It downloads install.ps1 from this AgEnD, checks it against the SHA-256 below and only then runs it. The installer verifies the Runtime's own checksum, installs it for that Windows user only (next to any version already there; nothing already installed is deleted; no administrator rights needed) and connects the computer straight away: no pairing code and no approval step. Windows Node.js 22.14 or newer is required; if it is missing, the command only tells you how to get it.",
    stepConnect:"Paste it on the other computer", stepConnectHint:"It can be any computer that can reach this AgEnD's address, not only this one. The window installs, checks this AgEnD's server fingerprint, connects and keeps running; there is nothing to type and nothing to approve here. To reconnect later, double-click connect-agend.bat in the install folder (the installer prints where it is). A computer that is already connected to this AgEnD just reconnects, and the token stays unused.",
    manualCommands:"Manual options (pairing code, install only)", manualCommandsHint:"For a person at an interactive PowerShell window who prefers a pairing code: the first command only installs; the second asks for the one-time pairing code below, shows a pairing fingerprint and waits for your approval here.", installOnlyCommand:"Install only (does not connect)", manualCodeNote:"A pairing code cannot be put in a command or a variable: it is typed at an interactive terminal. For an AI agent or CI, use the one-time install command above instead.",
    installCommand:"Install command", connectCommand:"Connect command", copyCommand:"Copy command", commandCopied:"Copied",
    installerHash:"The command checks install.ps1 against this SHA-256 before it runs anything:", installerLoading:"Preparing the installer hash…",
    installerUnavailable:"This AgEnD cannot offer the installer (for example its Runtime files were not built), so there is no install command. Use Other install methods (ZIP).", installerRetry:"Try again",
    tlsHelp:"If PowerShell reports a certificate error, make that computer trust this AgEnD's certificate, or use a trusted HTTPS address (for example Tailscale Serve), or use the ZIP. Never turn certificate checks off: the SHA-256 check does not replace them.",
    restrictedHelp:"Under Constrained Language Mode or AppLocker this command stops without running anything (the check cannot be done there): use Other install methods (ZIP). The command never changes your execution policy.",
    needsReinstall:"This computer's Runtime is not compatible with this AgEnD, so it cannot connect or run work. Run the install command from Connect a computer on that computer again: it installs the matching Runtime next to the old one, and the pairing is kept.",
    zipTabHint:"Prefer not to run a command? Download the ZIP here, move it to the other computer and extract it." },
  "zh-TW": { installMethod:"安裝方式", tabWindows:"Windows（PowerShell）", tabZip:"其他安裝方式（ZIP）",
    stepInstall:"複製一次性安裝指令", stepInstallHint:"在任何一台 Windows 電腦的 PowerShell 貼上這行指令，或交給在那台電腦上執行的 AI agent。它會從這台 AgEnD 下載 install.ps1，先用下方的 SHA-256 檢查，相符才執行。安裝程式會再驗證 Runtime 自己的校驗碼，並只為那個 Windows 使用者安裝，放在既有版本旁邊（不會刪除任何已安裝的東西，也不需要系統管理員權限），然後立刻連線那台電腦：不用配對碼，也不用另外核准。需要 Windows Node.js 22.14 以上；若沒有，指令只會告訴你怎麼取得。",
    stepConnect:"在另一台電腦貼上並執行", stepConnectHint:"不限這台電腦，只要能連到這台 AgEnD 的位址都可以。視窗會安裝、比對這台 AgEnD 的伺服器指紋、連線並持續執行；不用輸入任何東西，也不用回來核准。之後要重連，請雙擊安裝資料夾裡的 connect-agend.bat（安裝程式會印出它的位置）。已經連到這台 AgEnD 的電腦只會重連，token 不會被用掉。",
    manualCommands:"手動選項（配對碼、只安裝）", manualCommandsHint:"適合在互動式 PowerShell 視窗前、想用配對碼的人：第一行只安裝；第二行會要求輸入下方的一次性配對碼，顯示配對指紋，並等待你在這裡核准。", installOnlyCommand:"只安裝（不連線）", manualCodeNote:"配對碼不能放進指令或變數，只能在互動式終端機輸入。AI agent 或 CI 請改用上方的一次性安裝指令。",
    installCommand:"安裝指令", connectCommand:"連線指令", copyCommand:"複製指令", commandCopied:"已複製",
    installerHash:"指令會先用這個 SHA-256 檢查 install.ps1，相符才會執行任何東西：", installerLoading:"正在準備安裝程式雜湊…",
    installerUnavailable:"這台 AgEnD 無法提供安裝程式（例如缺少 Runtime 檔案），所以沒有安裝指令。請改用「其他安裝方式（ZIP）」。", installerRetry:"重試",
    tlsHelp:"若 PowerShell 顯示憑證錯誤，請讓那台電腦信任這台 AgEnD 的憑證、改用受信任的 HTTPS 位址（例如 Tailscale Serve），或改用 ZIP。絕對不要關閉憑證檢查：SHA-256 檢查不能取代它。",
    restrictedHelp:"在受限語言模式（Constrained Language Mode）或 AppLocker 下，這個指令會停下來、什麼都不執行（那裡無法做檢查）：請改用「其他安裝方式（ZIP）」。指令不會變更你的執行原則。",
    needsReinstall:"這台電腦的 Runtime 與這台 AgEnD 不相容，無法連線或執行工作。請在那台電腦再執行一次「連接電腦」頁面上的安裝指令：它會把相符的 Runtime 安裝在舊版旁邊，配對會保留。",
    zipTabHint:"不想執行指令？在這裡下載 ZIP，傳到另一台電腦並解壓縮。" },
});
// the one-time install command (a token made by this page), its card, and the notice that a computer joined with it.
register("machines", {
  en: {
    "enrollCardTitle": "One-time install command",
    "enrollExpiresIn": "Expires in {0}",
    "enrollExpired": "This install command has expired. Generate a new one.",
    "enrollUsed": "A computer joined with this command; the token is spent.",
    "enrollRevoked": "This install command was revoked. Generate a new one.",
    "enrollWait": "Waiting for a computer to run the command",
    "enrollNew": "New command",
    "enrollRevoke": "Revoke and close",
    "enrollSecurity": "Treat this command like a password. Anyone who gets it before it expires or is used can connect their own computer to this AgEnD, and agent work (code, prompts) would then run there. It works once, for 15 minutes, on any computer. A new command or Revoke ends it. Do not paste it into chats, tickets or screenshots; PowerShell also keeps pasted commands in its history.",
    "enrollJoinedStep": "{0} joined with this command.",
    "enrollFingerprint": "AgEnD server fingerprint (the Runtime checks it before it sends the token):",
    "showPairingCode": "Show a pairing code",
    "hideEnroll": "Hide this command",
    "joinedTitle": "A new computer joined with an install command",
    "joinedBody": "{0} was added {1} with a one-time token from this page: no pairing code and no approval step. If you did not expect it, revoke it now.",
    "joinedRevoke": "Revoke",
    "joinedDismiss": "Dismiss",
    "enrolledBadge": "Joined by install command",
    "enrollNoInstaller": "The install command appears once the installer information has loaded.",
    "enrollGenerate": "Generate the install command"
  },
  "zh-TW": {
    "enrollCardTitle": "一次性安裝指令",
    "enrollExpiresIn": "{0} 後到期",
    "enrollExpired": "這個安裝指令已經到期，請重新產生。",
    "enrollUsed": "已有電腦用這個指令加入；token 已用掉。",
    "enrollRevoked": "這個安裝指令已被撤銷，請重新產生。",
    "enrollWait": "等待電腦執行這個指令",
    "enrollNew": "重新產生",
    "enrollRevoke": "撤銷並關閉",
    "enrollSecurity": "請把這行指令當成密碼。在它到期或被使用之前，任何拿到的人都能把自己的電腦連到這台 AgEnD，之後 Agent 的工作（程式碼、提示詞）就會在那台電腦上執行。它只能用一次、15 分鐘內有效，在任何電腦都能用。重新產生或撤銷就會讓它失效。請不要貼到聊天、工單或截圖；PowerShell 也會把貼上的指令存進歷史紀錄。",
    "enrollJoinedStep": "{0} 已用這個指令加入。",
    "enrollFingerprint": "AgEnD 伺服器指紋（Runtime 會先比對它，才送出 token）：",
    "showPairingCode": "顯示配對碼",
    "hideEnroll": "隱藏這個指令",
    "joinedTitle": "有新電腦透過安裝指令加入",
    "joinedBody": "{0} 在{1}以這一頁的一次性 token 加入：沒有配對碼，也沒有核准步驟。如果不是你預期的，請立刻撤銷。",
    "joinedRevoke": "撤銷",
    "joinedDismiss": "關閉通知",
    "enrolledBadge": "以安裝指令加入",
    "enrollNoInstaller": "安裝程式資訊載入完成後，才會顯示安裝指令。",
    "enrollGenerate": "產生安裝指令"
  },
});
register("machines", {
  en: { profilesTitle:"Claude accounts", profileDefault:"Default", profilesNone:"No Claude accounts reported yet.", profilesHow:"To add one, run agend-runtime login claude-code NAME on that computer, then choose Detect again in CLI diagnostics.", profilesOld:"Update the Runtime on that computer to choose a Claude account for an agent.", profilesList:"Claude accounts on {0}", profileSignedIn:"Signed in", profileSignedOut:"Not signed in", profileUnchecked:"Not checked", capability_credentialProfiles:"Claude accounts (credential profiles)" },
  "zh-TW": { profilesTitle:"Claude 帳號", profileDefault:"預設", profilesNone:"尚未回報任何 Claude 帳號。", profilesHow:"要新增，請在那台電腦執行 agend-runtime login claude-code 名稱，再在「CLI 診斷」按「重新偵測」。", profilesOld:"請更新那台電腦上的 Runtime，才能為 Agent 選擇 Claude 帳號。", profilesList:"{0} 上的 Claude 帳號", profileSignedIn:"已登入", profileSignedOut:"尚未登入", profileUnchecked:"未確認", capability_credentialProfiles:"Claude 帳號（credential profile）" },
});
function CredentialProfiles({ machine }) {
  const view = credentialProfileView(machine);
  // A Runtime that predates Claude accounts (it may not even report its capabilities) is told to update rather than shown an empty list.
  if (!view.capable) return html`<p class="note runtime-profiles-old" role="status">${machineText("profilesOld")}</p>`;
  return html`<div class="runtime-profiles"><h4>${machineText("profilesTitle")}</h4>${view.profiles.length
    ? html`<ul class="runtime-profile-list" aria-label=${machineText("profilesList",machine.name)}>${view.profiles.map(row => html`<li key=${row.name} data-profile=${row.name}><code>${row.name}</code>${row.name === view.defaultName ? html`<small class="runtime-profile-default">${machineText("profileDefault")}</small>` : null}${row.loggedIn === true && identityText(row.identity) ? html`<small class="runtime-account">${identityText(row.identity)}</small>` : null}<span class=${`runtime-cli-auth ${row.loggedIn === true ? "is-signed-in" : ""}`}><span class="windows-cli-dot"></span>${machineText(`profile${credentialProfileState(row.loggedIn).replace(/^./,c=>c.toUpperCase())}`)}</span></li>`)}</ul>`
    : html`<p class="note">${machineText("profilesNone")}</p>`}<p class="note runtime-profiles-how">${machineText("profilesHow")}</p></div>`;
}
/** cc3ce4fe: a persistent-pane CLI's version AgEnD has not audited (or knows is broken), from the coordinator's label. */
function paneVerificationTag(cli, text) {
  const key = cli.paneVerification === "unverified" ? "paneUnverified" : cli.paneVerification === "denied" ? "paneDenied" : "";
  return key ? html`<span class="tag" title=${text(`${key}Hint`)}>${text(key)}</span>` : null;
}
export function machineTime(value) { const date=new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString() : machineText("unknown"); }
function MachineCard({ machine, sameName, busy, action, openDiagnostics, probe, repairUpdate, lease, onChanged }) {
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
    <header><span class="runtime-machine-icon"><${Icon} name="fleet" size=${22} /></span><div><h3>${machine.name}${revoked ? null : html`<span class="runtime-kind">${machineText(local ? "localBadge" : machine.enrolledVia ? "enrolledBadge" : "pairedBadge")}</span>`}${sameName ? html`<span class="tag runtime-same-name-tag">#${sameName.n}</span>` : null}</h3><p>${machine.platform === "win32" ? "Windows" : machine.platform || machineText("unknown")}${machine.hostname && machine.hostname !== machine.name ? ` · ${machine.hostname}` : ""} · ${machineText((clis.length) === 1 ? "cliCountOne" : "cliCount",clis.length)}</p>${sameName ? html`<p class="runtime-same-name-when">${machineText(status === "pending" ? "requestedAt" : "pairedAt",machineTime(status === "pending" ? machine.createdAt : machine.approvedAt || machine.createdAt),String(machine.id).slice(0,8))}</p>` : null}</div><span class=${`runtime-status is-${status}`}><span class="windows-cli-dot"></span>${machineText(["available","online","offline","pending","revoked"].includes(status) ? status : "unknown")}</span></header>
    ${sameName ? html`<p class="note lbar runtime-same-name">${machineText("sameName",machine.name)}</p>` : null}
    ${!local && !revoked && machine.runtimeCompatibility === "incompatible" ? html`<p class="runtime-reinstall" role="alert">${machineText("needsReinstall")}</p>` : null}
    ${!local && !revoked && status !== "pending" ? html`<${RuntimeUpdateNotice} machine=${machine} onRepair=${() => repairUpdate(machine)} />` : null}
    ${revoked ? null : html`<p class="runtime-inventory-time note">${machine.inventoryUpdatedAt ? machineText("inventoryAt",machineTime(machine.inventoryUpdatedAt)) : machineText("neverDetected")}</p>`}
    ${status === "pending" ? html`<div class="runtime-approval"><p>${machineText("fingerprintLabel")}<code class="runtime-pairing-fingerprint">${machine.pairingFingerprint || machineText("unknown")}</code></p><p class="note" role=${machine.pairingExpired ? "status" : undefined}>${machineText(machine.pairingExpired ? "pairingExpired" : "approvalHint")}</p></div>` : null}
    ${revoked ? html`<p class="note runtime-revoked-note" role="status">${machineText("revokedNote")}</p>` : clis.length ? html`<table class="runtime-cli-table" aria-label=${machineText("cli")}><thead><tr><th>${machineText("cli")}</th><th>${machineText("versionColumn")}</th><th>${machineText("signInColumn")}</th></tr></thead><tbody>${clis.map(cli=>html`<tr key=${cli.id}><td><span class="runtime-cli-product"><${CliProductMark} id=${cli.id} size=${21} /><strong>${cliLabel(cli.id)}</strong></span>${cli.supports?.execution === false ? html`<small>${machineText("detectionOnly")}</small>` : null}</td><td><span class="runtime-cli-version" title=${cli.version || ""}>${cli.version || "—"}</span>${paneVerificationTag(cli,machineText)}</td><td><span class=${`runtime-cli-auth ${cli.authenticated === true ? "is-signed-in" : ""}`}><span class="windows-cli-dot"></span>${machineText(cli.authenticated === true ? "signedIn" : cli.authenticated === false ? "signedOut" : "authShort")}</span>${cli.authenticated === true && identityText(cli.identity) ? html`<small class="runtime-account" data-account="default">${identityText(cli.identity)}</small>` : null}</td></tr>`)}</tbody></table>` : html`<p class="note runtime-no-clis">${machineText(local ? "noLocalClis" : "noClis")}</p>`}
    ${!local && !revoked && status !== "pending" ? html`<${CredentialProfiles} machine=${machine} />` : null}
    ${offersCliInstall(machine) && lease ? html`<${CliInstall} machine=${machine} lease=${lease} onChanged=${onChanged} />` : null}
    <div class="runtime-machine-actions">${ready ? html`<button type="button" class="btn btn-sm runtime-inspect" onClick=${() => openDiagnostics(local ? "" : machine.id)}>${machineText("diagnosticTitle")}</button><button type="button" class="btn btn-sm runtime-probe" disabled=${busy || probing || !local && status !== "online"} onClick=${() => probe(local ? "" : machine.id)}><${Icon} name="restart" size=${14} cls=${probing ? "out-spin" : ""} />${machineText(probing ? "probeBusy" : "probeAgain")}</button>` : null}
      ${status === "pending" && !machine.pairingExpired ? html`<button type="button" class="btn btn-primary btn-sm" disabled=${busy || !machine.pairingFingerprint} onClick=${() => action(machine,"approve",{fingerprint:machine.pairingFingerprint})}>${machineText("approve")}</button>` : null}
      ${status === "pending" && machine.pairingExpired ? html`<button type="button" class="btn btn-sm runtime-expired-reject" disabled=${busy} onClick=${() => action(machine,"reject")}>${machineText("askReject")}</button>` : null}
      <${Menu} cls="runtime-machine-menu" label=${machineText("machineActions",machine.name)} disabled=${busy} items=${menuItems} />
    </div>
    ${info ? html`<${Dialog} title=${`${machineText("machineInfo")} · ${machine.name}`} onClose=${()=>setInfo(false)}><dl class="runtime-machine-facts"><dt>${machineText("machineName")}</dt><dd>${machine.name}</dd><dt>${machineText("hostName")}</dt><dd>${machine.hostname || machine.inventory?.hostname || machineText("unknown")}</dd><dt>${machineText("platform")}</dt><dd>${machine.platform === "win32" ? "Windows" : machine.platform}</dd>${local ? html`<dt>${machineText("home")}</dt><dd>${machine.inventory?.home || machineText("unknown")}</dd>` : html`<dt>${machineText("version")}</dt><dd class="runtime-reported-version">${machine.runtimeInfo?.version || machineText(machine.runtimeInfo ? "versionUnreadable" : "versionNotReported")}</dd>${machine.runtimeInfo ? html`<dt>${machineText("buildId")}</dt><dd class="runtime-reported-build"><code>${machine.runtimeInfo?.buildId || machineText("buildUnavailable")}</code></dd><dt>${machineText("protocols")}</dt><dd>${machine.runtimeInfo?.protocolVersions?.map(v=>`v${v}`).join(", ") || machineText("protocolUnknown")}</dd>` : null}<dt>${machineText("compatibility")}</dt><dd class="runtime-compatibility">${machineText(["compatible","legacy","incompatible"].includes(machine.runtimeCompatibility) ? machine.runtimeCompatibility : "protocolUnknown")}</dd>${machine.runtimeInfo ? html`<dt>${machineText("capabilities")}</dt><dd>${machine.runtimeInfo?.capabilities?.map(capability=>["exec","mcp","panes"].includes(capability) ? machineText(`capability_${capability}`) : capability === "credential-profiles" ? machineText("capability_credentialProfiles") : capability).join(" · ") || machineText("unknown")}</dd>` : null}<dt>${machineText("lastSeenLabel")}</dt><dd>${machineTime(machine.lastSeenAt)}</dd><dt>${machineText("identity")}</dt><dd><code>${machine.id}</code></dd>`}</dl></${Dialog}>` : null}
    ${editing ? html`<${Dialog} title=${machineText("rename")} onClose=${()=>setEditing(false)} busy=${busy}
      actions=${html`<button type="button" class="btn" disabled=${busy} onClick=${()=>setEditing(false)}>${machineText("cancel")}</button><button class="btn btn-primary" type="submit" form=${`runtime-rename-${machine.id}`} disabled=${busy || !name.trim()}>${machineText("save")}</button>`}>
      <form id=${`runtime-rename-${machine.id}`} class="runtime-rename" onSubmit=${event=>{event.preventDefault();if(name.trim())void action(machine,"rename",{name:name.trim()}).then(ok=>{if(ok)setEditing(false);});}}><label class="field"><span>${machineText("name")}</span><input value=${name} maxLength=${100} onInput=${event=>setName(event.target.value)} /></label></form></${Dialog}>` : null}
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
      const res=await confirmedWrite("/api/settings/fleet/runtimes",{method:"PUT",body:{[item.name]:on},resendable:true,label:machineText(item.label),onPending:() => { if (lease.current()) setPending(item.name); }});
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
      const res=await confirmedWrite("/api/settings/fleet/runtimes",{method:"PUT",body:{max_agents_per_machine:limitValue},resendable:true,label:machineText("limit")});
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
  if (!view && !unavailable) return html`<div class="runtime-layout"><div class="runtime-main">${computers}<section class="runtime-switches" aria-label=${machineText("switches")}><h3>${machineText("switches")}</h3>
    ${error ? html`<p role="alert">${error}</p><button type="button" class="btn btn-sm" onClick=${() => { setError(""); load().catch(e => { if (lease.current()) setError(machineText("switchFailed", e.message)); }); }}>${machineText("retry")}</button>` : html`<${Skeleton} variant="rows" lines=${3} />`}</section></div></div>`;
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
/** The countdown is its own component: it ticks every second without re-rendering the whole Runtime page. */
function EnrollClock({ lease, expiresAt }) {
  const [now,setNow]=useState(() => Date.now());
  useEffect(() => { const timer=lease.interval(() => setNow(Date.now()),1000);return () => lease.clear(timer); },[lease]);
  const seconds=Math.max(0,Math.ceil((expiresAt-now)/1000));
  return html`<p class="note runtime-enroll-clock">${machineText("enrollExpiresIn",`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`)}</p>`;
}
/** Computers that joined with an install command stay announced on this page until the administrator dismisses the notice (kept in this browser only). */
const JOINED_SEEN_KEY = "agend.runtime.joined.dismissed";
function readSeenJoined() {
  try { const value = JSON.parse(localStorage.getItem(JOINED_SEEN_KEY) || "[]"); return new Set(Array.isArray(value) ? value.filter(id => typeof id === "string").slice(-100) : []); }
  catch { return new Set(); }
}
function writeSeenJoined(set) { try { localStorage.setItem(JOINED_SEEN_KEY, JSON.stringify([...set].slice(-100))); } catch { /* the notice comes back after a reload */ } }
const JOINED_NOTICE_MS = 7 * 24 * 3_600_000;
export function RuntimesPanel({navKey}) {
  const lease=useLease(`runtimes:${navKey}`), state=useRuntimeCatalog(), {windowsCli}=useStore(appStore);
  const localInventory=useWindowsCliCatalog(windowsCli);
  const [pairing,setPairing]=useState(null), [busy,setBusy]=useState(""), [error,setError]=useState("");
  // The one-time install-command token lives here, in memory, and nowhere else (the server keeps only its hash); `open` shows the connect panel.
  const [open,setOpen]=useState(false), [enroll,setEnroll]=useState(null), [,setTick]=useState(0), [seenJoined,setSeenJoined]=useState(readSeenJoined);
  const zipAsked=useRef(false);
  const [server,setServer]=useState(() => typeof location === "undefined" ? "" : location.origin);
  const drafts=useRef(new Map()), taskSessions=useRef(new Map()), downloadClaim=useRef(false);
  const [downloadedFor,setDownloadedFor]=useState(""), [copied,setCopied]=useState(false);
  const [tab,setTab]=useState("windows"), [copiedCommand,setCopiedCommand]=useState(""), [installCopied,setInstallCopied]=useState(false);
  // The administrator-only report of install.ps1's SHA-256 (what the server sends); the install command pins it.
  const [installer,setInstaller]=useState({status:"idle",sha:"",version:""});
  const [repairMachine,setRepairMachine]=useState(null);
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
  // One re-render at the moment the token ends (the countdown itself is EnrollClock's). Expiry is measured on THIS browser's clock from when the answer arrived,
  // by the token's length of life, never by comparing the server's clock with this one.
  useEffect(() => {
    if (!enroll) return;
    const remaining=enroll.localExpiresAt-Date.now()+100;
    if (remaining <= 0) return;
    const timer=lease.timeout(() => setTick(count => count+1),remaining);
    return () => lease.clear(timer);
  },[lease,enroll]);
  const loadInstaller=async() => {
    setInstaller({status:"loading",sha:"",version:""});
    try {
      const response=await lease.fetch("/ui/runtimes/installer",{credentials:"same-origin"});
      const value=await response.json();
      if(!lease.current())return;
      if(response.ok && /^[a-f0-9]{64}$/.test(value?.scriptSha256 || "")) setInstaller({status:"ready",sha:value.scriptSha256,version:String(value.version || "")});
      else setInstaller({status:"error",sha:"",version:""});
    } catch { if(lease.current())setInstaller({status:"error",sha:"",version:""}); }
  };
  useEffect(() => { if ((open || repairMachine) && installer.status === "idle") void loadInstaller(); },[open,repairMachine,installer.status]);
  // The ZIP route uses a pairing code, made only when that route is shown (or asked for under Manual options), never for the install command.
  // Once per opening of the panel: an expired code is not replaced behind the administrator's back (the card offers a new one).
  useEffect(() => { if (open && tab === "zip" && !pairing && !busy && !zipAsked.current) { zipAsked.current=true;void newPairingCode(); } },[open,tab,pairing]);
  const post=async(path,body={}) => {
    const response=await lease.fetch(path,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const value=await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`),{status:response.status,code:value.code});
    return value;
  };
  // Makes a one-time install-command token (and ends any earlier unused one). Same authorization as a pairing code.
  const connect=async() => {
    setBusy("pairing");setError("");
    try {const value=await post("/ui/runtimes/enrollment");if(lease.current()){setEnroll({...value,localExpiresAt:Date.now()+Math.max(0,value.expiresAt-value.createdAt)});setInstallCopied(false);setTab("windows");setOpen(true);}}catch(e){if(lease.current())setError(e.message);}finally{if(lease.current())setBusy("");}
  };
  const newPairingCode=async() => {
    setBusy("pairing");setError("");
    try {const value=await post("/ui/runtimes/pairing");if(lease.current())setPairing(value);}catch(e){if(lease.current())setError(e.message);}finally{if(lease.current())setBusy("");}
  };
  const openZip=() => { setTab("zip");setOpen(true); };
  // Closing from the card ends an unused token: nothing on screen can show it again, so it should not stay valid. (Leaving the page without closing does not revoke it:
  // the command may already be copied, and it ends by itself after 15 minutes.)
  const closePanel=async() => {
    if(enroll && enrollStatus === "unused") {
      setBusy("pairing");setError("");
      try {await post(`/ui/runtimes/enrollment/${encodeURIComponent(enroll.id)}/revoke`);}catch(e){if(lease.current())setError(e.message);}finally{if(lease.current())setBusy("");}
    }
    if(!lease.current())return;
    setEnroll(null);setPairing(null);setOpen(false);zipAsked.current=false;
    await state.refresh();
  };
  const dismissJoined=id => setSeenJoined(seen => { const next=new Set(seen).add(id); writeSeenJoined(next); return next; });
  const action=async(machine,operation,body={}) => {
    // "reject" drops a request that is still waiting: the button is the decision (no second question) and no "revoked" card stays. The server refuses it (409) for a computer that
    // is no longer waiting, so it can never revoke one that was approved meanwhile (another tab, another administrator): the page says so and reads the list again.
    const route=operation;
    if(operation === "revoke" && !await confirmDialog({message:machineText("revokeAsk"),confirmLabel:machineText("revoke"),danger:true}))return false;
    if(!lease.current())return false;
    setBusy(machine.id);setError("");
    try {
      await post(`/ui/runtimes/machines/${encodeURIComponent(machine.id)}/${route}`,body);if(!lease.current())return false;
      // Kept before the refresh, so the card is never dropped between the answer and the new list.
      if(operation === "revoke")setRevokedHere(seen=>new Map(seen).set(machine.id,{...machine,status:"revoked"}));
      await state.refresh();return lease.current();
    }
    catch(e){
      if(!lease.current())return false;
      if(operation === "reject" && e.status === 409){setError(machineText("alreadyHandled"));await state.refresh();return false;}
      setError(operation === "refresh" ? `${machineText("cliFailed")} ${e.message}` : e.message);return false;
    }
    finally{if(lease.current())setBusy("");}
  };
  const machines=state.data?.machines || [];
  const localMachine={id:"",isLocal:true,name:localInventory.data?.hostname || machineText("nativeWindows"),platform:"win32",status:windowsCli ? "online" : "offline",inventory:localInventory.data,inventoryUpdatedAt:localInventory.data?.probedAt,probing:localInventory.loading};
  const listed=machines.filter(machine=>machine.status !== "revoked" || revokedHere.has(machine.id));
  const gone=[...revokedHere.values()].filter(machine=>!machines.some(row=>row.id === machine.id));
  const shown=[...listed,...gone].map(machine=>({...machine,...(revokedHere.has(machine.id) ? {status:"revoked"} : {}),probing:busy===machine.id}));
  // Computers waiting for approval come first, in the order they asked, so a long card never pushes Approve out of sight. A request that has run out is not waiting: it stays where it is, says so, and can be dropped.
  const waiting=pendingMachines(shown), allMachines=[...waiting,...(windowsCli ? [localMachine] : []),...shown.filter(machine=>!waiting.includes(machine))];
  const waitingIds=waiting.map(machine=>machine.id).join(",");
  const [ask,setAsk]=useState(null), announced=useRef(new Set()), machinesRef=useRef(null);
  // A computer waiting that this page has not asked about yet opens the dialog, and only that one: a computer the person has already put off with Later does not come back by itself, not
  // even when another one arrives (it stays on the bar and on its card). A new one while the dialog is open joins its list ("1 of 2"). Never over another dialog: it waits until that closes.
  useEffect(() => {
    const fresh=waiting.filter(machine=>!announced.current.has(machine.id));
    if(!fresh.length || otherDialogOpen())return;
    fresh.forEach(machine=>announced.current.add(machine.id));
    setAsk(open=>({ids:[...(open ? open.ids : []),...fresh.map(machine=>machine.id).filter(id=>!open?.ids.includes(id))]}));
  },[waitingIds,state.checkedAt]);
  const asking=ask ? ask.ids.map(id=>waiting.find(machine=>machine.id === id)).filter(Boolean) : [];
  useEffect(() => { if(ask && !asking.length)setAsk(null); },[ask,asking.length]);
  const review=() => {
    if(!waiting.length)return;
    setAsk({ids:waiting.map(machine=>machine.id)});
    const card=[...(machinesRef.current?.querySelectorAll?.("[data-machine-id]") || [])].find(item=>item.getAttribute("data-machine-id") === waiting[0].id);
    card?.scrollIntoView?.({block:"start"});
  };
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
  const enrollRow=enroll ? (state.data?.enrollments || []).find(row => row.id === enroll.id) : null;
  const enrollStatus=!enroll ? "none" : enrollRow?.status === "used" ? "used" : enrollRow?.status === "revoked" ? "revoked" : enrollRow?.status === "expired" || enroll.localExpiresAt <= Date.now() ? "expired" : "unused";
  const enrollCommand=enrollStatus === "unused" ? runtimeEnrollCommand(server,installer.sha,enroll.token,enroll.fingerprint) : "";
  const joinedMachine=enrollStatus === "used" ? machines.find(machine => machine.id === enrollRow?.machineId) : null;
  const command=runtimeConnectCommand(server), installCommand=runtimeInstallCommand(server,installer.sha), installOnlyCommand=runtimeInstallOnlyCommand(server,installer.sha), windowsConnectCommand=runtimeWindowsConnectCommand(server);
  const copyCommand=async(key,text) => {
    try {await navigator.clipboard.writeText(text);if(!lease.current())return;setCopiedCommand(key);if(key === "install" || key === "enroll")setInstallCopied(true);lease.timeout(() => setCopiedCommand(""),2000);}catch { /* the command is on screen to copy by hand */ }
  };
  const awaitingApproval=machines.some(machine => machine.status === "pending" && !machine.pairingExpired), installed=tab === "windows" ? installCopied : !!downloadedFor, currentStep=tab === "windows" ? (enrollStatus === "used" ? 4 : installed || awaitingApproval ? 3 : 2) : awaitingApproval ? 4 : installed ? 3 : 2;
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
  const download=(setup=false)=>html`<button type="button" class="btn btn-sm runtime-bundle-download" disabled=${!!busy || !setup && !command} onClick=${setup ? openZip : downloadRuntime}><${Icon} name="download" size=${15} />${machineText(busy === "download" ? "downloadBuilding" : "download")}</button>`;

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
  const addressStep=step(1,machineText("server"),html`<div class="field"><input type="url" aria-label=${machineText("server")} value=${server} disabled=${busy === "download"} spellcheck=${false} onInput=${event => setServer(event.target.value)} /></div><p class="note">${machineText("serverHint")}</p>${command ? null : html`<p role="alert">${machineText("serverInvalid")}</p>`}`);
  const approveStep=step(4,machineText("stepApprove"),html`<p class="note">${machineText("stepApproveHint")}</p>`);
  const enrollNote=enrollStatus === "used" ? "enrollUsed" : enrollStatus === "revoked" ? "enrollRevoked" : "enrollExpired";
  const pairCodeBlock=() => pairing ? html`<label class="field"><span>${machineText("pairingCode")}</span><div class="runtime-pair-code-row"><input class="runtime-pair-code" value=${pairing.code} readOnly=${true} spellcheck=${false} autocomplete="off" /><button type="button" class="btn btn-sm" onClick=${copyCode}><${Icon} name="copy" size=${15} />${machineText(copied ? "codeCopied" : "copyCode")}</button></div></label><p class="note">${machineText("expires",machineTime(pairing.expiresAt))}</p><p class="runtime-pair-status" role="status"><span class="windows-cli-dot"></span>${machineText(awaitingApproval ? "pairingApprove" : "pairingWait")}</p><button type="button" class="btn btn-sm" disabled=${!!busy} onClick=${newPairingCode}>${machineText("newCode")}</button>` : null;
  const windowsSteps=html`${addressStep}
      ${step(2,machineText("stepInstall"),html`<p class="note">${machineText("stepInstallHint")}</p>
        ${installer.status === "loading" || installer.status === "idle" ? html`<${Skeleton} lines=${3} label=${machineText("installerLoading")} />` : null}
        ${installer.status === "error" ? html`<p class="runtime-installer-error" role="alert">${machineText("installerUnavailable")} <button type="button" class="btn btn-ghost btn-sm" onClick=${() => void loadInstaller()}>${machineText("installerRetry")}</button></p>` : null}
        ${!enroll ? html`<button type="button" class="btn btn-primary btn-sm runtime-enroll-generate" disabled=${!!busy} onClick=${connect}>${machineText("enrollGenerate")}</button>` : null}
        ${enrollCommand ? html`${commandCard("enroll",machineText("installCommand"),enrollCommand)}<p class="note runtime-installer-hash">${machineText("installerHash")} <code>${installer.sha}</code></p><p class="note runtime-installer-hash">${machineText("enrollFingerprint")} <code>${enroll.fingerprint}</code></p><p class="note">${machineText("tlsHelp")}</p><p class="note">${machineText("restrictedHelp")}</p>`
          : enroll && enrollStatus !== "unused" ? html`<p class="note runtime-enroll-ended" role="status">${machineText(enrollNote)}</p>` : null}
        ${windowsConnectCommand ? html`<details class="runtime-manual-command"><summary>${machineText("manualCommands")}</summary><p class="note">${machineText("manualCommandsHint")}</p>${installOnlyCommand ? commandCard("install-only",machineText("installOnlyCommand"),installOnlyCommand) : null}${commandCard("connect",machineText("connectCommand"),windowsConnectCommand)}${pairing ? pairCodeBlock() : html`<button type="button" class="btn btn-sm" disabled=${!!busy} onClick=${newPairingCode}>${machineText("showPairingCode")}</button>`}<p class="note">${machineText("manualCodeNote")}</p></details>` : null}`)}
      ${step(3,machineText("stepConnect"),html`<p class="note">${machineText("stepConnectHint")}</p>${joinedMachine ? html`<p class="note" role="status">${machineText("enrollJoinedStep",joinedMachine.name)}</p>` : null}`)}`;
  const zipSteps=html`${addressStep}
      ${step(2,machineText("stepDownload"),html`<p class="note">${machineText("stepZipHint")}</p>${download()}${downloadedFor ? html`<p class="note" role="status">${machineText("downloadedFor",downloadedFor)}</p>` : null}`)}
      ${step(3,machineText("stepLaunch"),html`<p class="note">${machineText("stepLaunchHint")}</p>${command ? html`<details class="runtime-manual-command"><summary>${machineText("manualCommand")}</summary><label class="field"><span>${machineText("command")}</span><input class="runtime-command" value=${command} readOnly=${true} spellcheck=${false} /></label><p class="note">${machineText("manualMultiHint")}</p></details>` : null}`)}
      ${approveStep}`;

  const enrollAside=html`<aside class=${`runtime-pair-card runtime-enroll-card is-${enrollStatus}${awaitingApproval ? " is-pending" : ""}`}><h4>${machineText("enrollCardTitle")}</h4><p class="runtime-pair-status" role="status"><span class="windows-cli-dot"></span>${machineText(awaitingApproval ? "pairingApprove" : enrollStatus === "unused" || enrollStatus === "none" ? "enrollWait" : enrollNote)}</p>${enrollStatus === "unused" ? html`<${EnrollClock} lease=${lease} expiresAt=${enroll.localExpiresAt} />` : null}<p class="note lbar runtime-enroll-warning">${machineText("enrollSecurity")}</p><div class="runtime-pair-actions"><button type="button" class="btn btn-sm" disabled=${!!busy} onClick=${connect}>${machineText("enrollNew")}</button><button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${closePanel}>${machineText(enrollStatus === "unused" ? "enrollRevoke" : "closeCode")}</button></div></aside>`;
  const zipAside=html`<aside class=${`runtime-pair-card${awaitingApproval ? " is-pending" : ""}`}>${pairing ? pairCodeBlock() : html`<button type="button" class="btn btn-sm" disabled=${!!busy} onClick=${newPairingCode}>${machineText("newCode")}</button>`}<div class="runtime-pair-actions"><button type="button" class="btn btn-ghost btn-sm" onClick=${closePanel}>${machineText("closeCode")}</button></div></aside>`;
  const joinedNotices=machines.filter(machine => machine.enrolledVia === "install-command" && machine.status !== "revoked" && !revokedHere.has(machine.id) && !seenJoined.has(machine.id) && Date.now()-(machine.approvedAt || 0) < JOINED_NOTICE_MS)
    .map(machine => html`<section key=${machine.id} class="runtime-joined" role="status" data-machine-id=${machine.id}><${Icon} name="info" size=${18} /><div class="runtime-joined-text"><h4>${machineText("joinedTitle")}</h4><p class="note">${machineText("joinedBody",machine.name,machineTime(machine.approvedAt))}</p></div><div class="runtime-joined-actions"><button type="button" class="btn btn-sm" disabled=${!!busy} onClick=${() => action(machine,"revoke")}>${machineText("joinedRevoke")}</button><button type="button" class="btn btn-ghost btn-sm" onClick=${() => dismissJoined(machine.id)}>${machineText("joinedDismiss")}</button></div></section>`);
  const computers = html`<section class="runtime-computers"><div class="runtime-computers-heading"><h3>${machineText("computersTitle")}</h3><div class="note">${state.data ? machineText((allMachines.length) === 1 ? "machineCountOne" : "machineCount",allMachines.length) : !state.error ? html`<${Skeleton} variant="inline" lines=${1} />` : "—"}</div></div>
    ${waiting.length ? html`<div class="note lbar runtime-pending-banner" role="status"><span>${waiting.length === 1 ? machineText("awaitingOne") : machineText("awaitingMany",waiting.length)}</span><button type="button" class="btn btn-primary btn-sm runtime-pending-review" onClick=${review}>${machineText("awaitingReview")}</button></div>` : null}
    ${joinedNotices}
    <section class="runtime-machines" ref=${machinesRef} aria-label=${machineText("machines")}>${!state.data && !state.error ? html`<${Skeleton} variant="cards" lines=${2} label=${machineText("loading")} />` : allMachines.map(machine=>html`<${MachineCard} key=${machine.isLocal ? "local" : machine.id} sameName=${sameNameInfo(allMachines,machine)} lease=${lease} onChanged=${state.refresh} machine=${machine} busy=${!!busy || !!machine.probing} action=${action} openDiagnostics=${openDiagnostics} probe=${probeTarget} repairUpdate=${setRepairMachine} />`)}</section>
    ${asking.length ? html`<${ApproveDialog} key=${asking[0].id} machine=${asking[0]} position=${ask.ids.indexOf(asking[0].id)+1} total=${ask.ids.length} sameName=${sameNameInfo(allMachines,asking[0])?.others.find(other=>other.status !== "pending")} busy=${!!busy} error=${error}
      onApprove=${()=>action(asking[0],"approve",{fingerprint:asking[0].pairingFingerprint})} onReject=${()=>action(asking[0],"reject")} onLater=${()=>setAsk(null)} />` : null}
    ${repairMachine ? html`<${Dialog} title=${runtimeUpdateText("repairTitle")} onClose=${() => setRepairMachine(null)}>
      <p>${runtimeUpdateText("repairHint")}</p>
      ${installer.status === "idle" || installer.status === "loading" ? html`<${Skeleton} lines=${3} label=${machineText("installerLoading")} />` : null}
      ${installer.status === "error" ? html`<p role="alert">${machineText("installerUnavailable")} <button class="btn btn-sm" onClick=${() => void loadInstaller()}>${machineText("installerRetry")}</button></p>` : null}
      ${installer.status === "ready" ? commandCard("update-repair",machineText("installCommand"),runtimeFreshInstallCommand(typeof location === "undefined" ? "" : location.origin,installer.sha)) : null}
    </${Dialog}>` : null}
    ${state.data && !allMachines.some(machine=>!machine.isLocal) ? html`<p class="note runtime-empty-remotes">${machineText("empty")}</p>` : null}
    <article class="runtime-host-note"><${Icon} name="info" size=${18} /><span>${machineText("hostLocationNote")}</span></article></section>`;

  return html`<section class="runtime-settings">
    <header class="runtime-heading s-page-head"><div><h2>${machineText("title")}<span class="s-scope">${machineText("fleetScope")}</span></h2><p class="s-page-lead">${machineText("lead")}</p></div><div><button type="button" class="btn btn-primary btn-sm" disabled=${!!busy || state.data?.enabled !== true} onClick=${connect}><${Icon} name="plus" size=${15} />${machineText("connect")}</button>${state.data?.enabled === true && !open ? download(true) : null}<button type="button" class="btn btn-sm" disabled=${state.loading} onClick=${state.refresh}><${Icon} name="restart" size=${15} />${machineText("refresh")}</button></div></header>
    ${state.data?.enabled === false ? html`<p class="note">${machineText("disabled")}</p>` : null}
    ${error || state.error ? html`<div class="runtime-error" role="alert"><p>${error || state.error}</p>${state.data && state.error ? html`<p>${machineText("seenCached")}</p>` : null}<button type="button" class="btn btn-sm" onClick=${state.refresh}>${machineText("retry")}</button></div>` : null}
    ${open ? html`<section class="runtime-pairing" aria-label=${machineText("pairing")}><header><h3>${machineText("pairing")}</h3><p class="note">${machineText("pairingHint")}</p></header><div class="runtime-pairing-body"><div class="runtime-install">${installTabs}<div id="runtime-install-panel" class="runtime-install-panel" role="tabpanel" aria-labelledby=${`runtime-install-tab-${tab}`} data-install-method=${tab}><ol class="runtime-steps">
      ${tab === "windows" ? windowsSteps : zipSteps}
    </ol></div></div>${tab === "windows" ? enrollAside : zipAside}</div></section>` : null}
    <${RuntimeSwitches} lease=${lease} onChanged=${state.refresh} computers=${computers} />
    ${diagnosticMachineId !== null ? html`<${RuntimeDiagnosticsDialog} key=${diagnosticMachineId || "local"} navKey=${navKey} machineId=${diagnosticMachineId} machine=${target} enabled=${diagnosticMachineId !== "" || windowsCli} drafts=${drafts.current} session=${taskSessions.current.get(diagnosticMachineId)} taskLease=${lease} onChanged=${state.refresh} onClose=${()=>setDiagnosticMachineId(null)} />` : null}
    <p class="note runtime-operations-note">${machineText("operationsNote")}</p>
  </section>`;
}

// Ridge #3321 S17: one computer, one CLI — not "1 computers", "1 CLIs".
register("machines", {
  en: { cliCountOne: "{0} CLI", machineCountOne: "{0} computer" },
  "zh-TW": { cliCountOne: "{0} 個 CLI", machineCountOne: "{0} 台電腦" },
});
// a computer asking to pair opens a dialog (a shortcut to the card's own Approve), waiting computers come first,
// and computers with the same name can be told apart.
register("machines", {
  en: { awaitingOne:"1 computer is waiting for approval", awaitingMany:"{0} computers are waiting for approval", awaitingReview:"Review and approve",
    askTitle:"A computer wants to pair", askOf:"{0} of {1}", askRequested:"Requested", askApprove:"Approve", askReject:"Reject", askLater:"Later",
    askSameName:"A computer with this name is already paired (paired {0}). It may be the same computer pairing again: check the fingerprint.",
    sameName:"Another computer is also named “{0}”. Use ⋯ → Rename to tell them apart.", pairedAt:"Paired {0} · ID {1}", requestedAt:"Requested {0} · ID {1}",
    alreadyHandled:"This computer was already approved or removed, probably in another tab. The list is up to date now.",
    pairingExpired:"This request has expired. Run the connect command on that computer again; Reject clears this one." },
  "zh-TW": { awaitingOne:"有 1 台電腦等待核准", awaitingMany:"有 {0} 台電腦等待核准", awaitingReview:"檢視並核准",
    askTitle:"有電腦要求配對", askOf:"第 {0} 台，共 {1} 台", askRequested:"要求時間", askApprove:"核准", askReject:"拒絕", askLater:"稍後",
    askSameName:"已有一台同名電腦（配對於 {0}）。可能是同一台重新配對，請看指紋。",
    sameName:"另一台電腦也叫「{0}」。可從 ⋯ 選單 →「重新命名」改成容易分辨的名稱。", pairedAt:"配對於 {0} · 識別碼 {1}", requestedAt:"要求於 {0} · 識別碼 {1}",
    alreadyHandled:"這台電腦已經被核准或移除了，可能是在另一個分頁。清單已經更新。",
    pairingExpired:"這個要求已經過期。請在那台電腦重新執行連線指令；按「拒絕」可以清掉這一筆。" },
});

/** A computer's name as compared for "same name" — trimmed, any case. */
const nameKey = machine => String(machine?.name || "").trim().toLowerCase();
/** Paired computers in the order they asked to pair (then by id, so the order never changes between polls). */
const byPairing = (a,b) => (Number(a.createdAt) || 0)-(Number(b.createdAt) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** `{ n, others }` for a paired computer whose name another not-revoked paired computer shares (n = its place, from 1, among them); else null. */
export function sameNameInfo(machines, machine) {
  if (!machine || machine.isLocal || machine.status === "revoked") return null;
  const group = machines.filter(item => !item.isLocal && item.status !== "revoked" && nameKey(item) === nameKey(machine)).sort(byPairing);
  return group.length > 1 ? { n:group.findIndex(item => item.id === machine.id)+1, others:group.filter(item => item.id !== machine.id) } : null;
}
/** The computers waiting for approval, in the order they asked. One whose request has run out (the server says so) can no longer be approved and is not among them. */
export const pendingMachines = machines => machines.filter(machine => !machine.isLocal && machine.status === "pending" && !machine.pairingExpired).sort(byPairing);
/** An unasked-for dialog must not land on top of one the person is already using (rename, diagnostics, a question). The approval dialog itself does not count: it is the one a new computer joins. */
const otherDialogOpen = () => typeof document !== "undefined" && !!document.querySelector?.("dialog[open]:not(.runtime-approve-dialog)");
/** How long the dialog's Approve stays off after it shows: it appears by itself, so a click already on its way must not land on it. */
export const APPROVE_ARM_MS = 1000;

/**
 * The shortcut to approving: one waiting computer at a time, its pairing fingerprint large, to compare with the one in that
 * computer's terminal. Later, Esc, the backdrop and × only close it; the card keeps its own Approve. Reject drops the request.
 */
function ApproveDialog({ machine, position, total, sameName, busy, error, onApprove, onReject, onLater }) {
  const [armed,setArmed] = useState(false), lease = useLease(`runtime-approve:${machine.id}`);
  useEffect(() => {
    setArmed(false);
    const timer = lease.timeout(() => setArmed(true),APPROVE_ARM_MS);
    return () => lease.clear(timer);
  },[lease,machine.id]);
  const fingerprint = machine.pairingFingerprint;
  return html`<${Dialog} title=${machineText("askTitle")} cls="runtime-approve-dialog" busy=${busy} onClose=${onLater}
    actions=${html`<button type="button" class="btn" disabled=${busy} onClick=${onLater}>${machineText("askLater")}</button><span class="dlg-spacer"></span><button type="button" class="btn btn-danger runtime-ask-reject" disabled=${busy} onClick=${onReject}>${machineText("askReject")}</button><button type="button" class="btn btn-primary runtime-ask-approve" disabled=${busy || !armed || !fingerprint} onClick=${onApprove}>${machineText("askApprove")}</button>`}>
    ${total > 1 ? html`<p class="note">${machineText("askOf",position,total)}</p>` : null}
    <dl class="runtime-machine-facts"><dt>${machineText("machineName")}</dt><dd>${machine.name}</dd><dt>${machineText("hostName")}</dt><dd>${machine.hostname || machineText("unknown")}</dd><dt>${machineText("platform")}</dt><dd>${machine.platform === "win32" ? "Windows" : machine.platform || machineText("unknown")}</dd><dt>${machineText("askRequested")}</dt><dd>${machineTime(machine.createdAt)}</dd></dl>
    <div><p class="note">${machineText("fingerprint")}</p><p class="runtime-approve-fingerprint">${fingerprint || machineText("unknown")}</p><p class="note">${machineText("approvalHint")}</p></div>
    ${sameName ? html`<p class="note lbar runtime-same-name">${machineText("askSameName",machineTime(sameName.approvedAt || sameName.createdAt))}</p>` : null}
    ${error ? html`<p class="err" role="alert">${error}</p>` : null}
  </${Dialog}>`;
}
