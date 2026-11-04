import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { Icon } from "/assets/ui-icons.js";
import { appStore, useStore } from "/assets/app-store.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { confirmedWrite } from "./settings-confirm.js";
import { CliProductMark, cliLabel } from "./cli-picker.js";
import { WindowsCliPanel } from "./panel-windows-cli.js";
import { useRuntimeCatalog } from "./runtime-catalog.js";
import { useWindowsCliCatalog } from "./windows-cli-catalog.js";

register("machines", {
  en: {
    title:"Runtime", lead:"Connect computers to run agents with each computer's own CLIs, sign-ins and files.",
    connect:"Connect a computer", download:"Download Windows Runtime (ZIP)", downloadHint:"Download here, then transfer the ZIP to the Windows computer and extract it. Windows Node.js is required.", refresh:"Refresh machines", loading:"Loading machines…", empty:"No remote computers connected yet.",
    disabled:"Other Windows PCs can connect once “Allow other Windows PCs to pair” is on.", local:"This computer", localHint:"WSL / Linux agents run on the AgEnD host. Native Windows diagnostics are below when enabled.",
    localWindows:"Local Windows CLI diagnostics", online:"Online", offline:"Offline", pending:"Awaiting approval", revoked:"Revoked", unknown:"Not reported",
    lastSeen:"Last seen: {0}", inventoryAt:"CLI inventory: {0}", noInventory:"CLI inventory has not been reported yet.", noClis:"No installed CLIs reported.",
    approve:"Approve computer", revoke:"Revoke connection", rename:"Rename", save:"Save name", cancel:"Cancel", name:"Computer name", probe:"Refresh CLI inventory",
    fingerprint:"Pairing fingerprint", fingerprintLabel:"Pairing fingerprint: ", approvalHint:"Compare this fingerprint with the one shown in the requesting Runtime before approving.", identity:"Computer identity", signedIn:"Signed in", signedOut:"Not signed in", authUnknown:"Sign-in unknown", detectionOnly:"Detection only", ready:"Tasks supported",
    pairing:"Connect a computer", pairingHint:"On the other computer, extract this version's portable Runtime bundle and run the command below from its folder. Paste the one-time code when asked, then approve the computer here. Keep that runtime window open.",
    pairingCode:"One-time pairing code", expires:"Expires: {0}", command:"Run on the other computer", pairingWait:"Waiting for the computer to request approval. This page updates automatically.",
    server:"AgEnD address", serverHint:"Use an address reachable from the other computer. A localhost address works only with a connection forwarded on that computer.", serverInvalid:"Enter an HTTPS origin, or a localhost HTTP origin with a forwarded connection. Leave out paths, credentials and query strings.", closeCode:"Hide pairing code", revokeAsk:"Revoke this computer's connection? New work will be refused. A task already running may need to be stopped on that computer.",
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
    guidePair:"2. Click Connect a computer, download the Runtime ZIP, and run the command it shows on the other PC.", guideApprove:"3. When that PC asks to join, approve it here.",
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
    pairing:"連接電腦", pairingHint:"在另一台電腦解壓縮此版本的可攜式 Runtime 套件，從其資料夾執行下方指令，在提示時貼上一次性配對碼，再回到這裡核准電腦。請保持 Runtime 視窗開啟。",
    pairingCode:"一次性配對碼", expires:"到期時間：{0}", command:"在另一台電腦執行", pairingWait:"正在等待電腦提出核准要求。此頁會自動更新。",
    server:"AgEnD 位址", serverHint:"請使用另一台電腦連得到的位址。localhost 只有在另一台電腦已建立連線轉發時才適用。", serverInvalid:"請填入 HTTPS 來源位址，或已轉發連線的 localhost HTTP 位址，不包含路徑、帳密或查詢參數。", closeCode:"隱藏配對碼", revokeAsk:"要撤銷這台電腦的連線嗎？新的派工會被拒絕；已在執行的任務可能需要在該電腦上停止。",
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
    guidePair:"2. 按「連接電腦」，下載 Runtime ZIP，在另一台電腦執行頁面顯示的指令。", guideApprove:"3. 那台電腦要求加入時，在這裡核准它。",
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
    ${machine.status === "pending" ? html`<div><p>${machineText("fingerprintLabel")}<code class="runtime-pairing-fingerprint">${machine.pairingFingerprint || machineText("unknown")}</code></p><p class="note">${machineText("approvalHint")}</p></div>` : null}
    <ul class="runtime-cli-list" aria-label=${machineText("cli")}>${clis.map(cli => html`<li key=${cli.id}><${CliProductMark} id=${cli.id} size=${22} /><span><strong>${cliLabel(cli.id)}</strong><small>${cli.version || "—"}</small></span><span class="note">${machineText(cli.authenticated === true ? "signedIn" : cli.authenticated === false ? "signedOut" : "authUnknown")} · ${machineText(cli.supports?.execution === false ? "detectionOnly" : "ready")}</span></li>`)}</ul>
    ${!clis.length ? html`<p class="note">${machineText("noClis")}</p>` : null}
    ${editing ? html`<form class="runtime-rename" onSubmit=${event => {event.preventDefault();if(name.trim())void action(machine,"rename",{name:name.trim()}).then(ok => {if(ok)setEditing(false);});}}><label><span>${machineText("name")}</span><input value=${name} maxLength=${100} onInput=${event => setName(event.target.value)} /></label><button class="btn btn-sm" type="submit" disabled=${busy || !name.trim()}>${machineText("save")}</button><button class="btn btn-ghost btn-sm" type="button" onClick=${() => setEditing(false)}>${machineText("cancel")}</button></form>` : null}
    <div class="runtime-machine-actions">${machine.status === "pending" ? html`<button type="button" class="btn btn-primary btn-sm" disabled=${busy || !machine.pairingFingerprint} onClick=${() => action(machine,"approve",{fingerprint:machine.pairingFingerprint})}>${machineText("approve")}</button>` : null}${machine.status === "online" ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => action(machine,"refresh")}><${Icon} name="restart" size=${14} />${machineText("probe")}</button>` : null}${machine.status !== "revoked" ? html`<button type="button" class="btn btn-ghost btn-sm" disabled=${busy} onClick=${() => setEditing(true)}>${machineText("rename")}</button><button type="button" class="btn btn-ghost btn-sm danger" disabled=${busy} onClick=${() => action(machine,"revoke")}>${machineText("revoke")}</button>` : null}</div>
  </article>`;
}
/** M-2255: the switches (fleet.yaml `runtimes`); `env` names the variable that overrides each. */
const SWITCHES = [
  { name: "windows_cli", id: "runtimeWindowsCli", env: "AGEND_WINDOWS_CLI", label: "windowsCli" },
  { name: "remote_runtime", id: "runtimeRemoteRuntime", env: "AGEND_REMOTE_RUNTIME", label: "remoteRuntime" },
];
export const RUNTIME_DOCS = "https://github.com/songsid/AgEnD/blob/main/docs/remote-runtime.md#connecting-over-a-private-network";
function LocalWindowsRuntime({ openDiagnostics }) {
  // Reuse the same cached inventory as the diagnostics below; this summary never forces a CLI probe.
  const inventory = useWindowsCliCatalog();
  const installed = (inventory.data?.clis || []).filter(cli => cli.path);
  return html`<article class="runtime-local runtime-native-local"><div><h3><${Icon} name="fleet" size=${20} />${machineText("nativeWindows")}</h3><p class="note">${machineText("nativeHint")}</p>
    ${installed.length ? html`<ul class="runtime-local-cli-tags" aria-label=${machineText("cli")}>${installed.map(cli => html`<li key=${cli.id}><${CliProductMark} id=${cli.id} size=${19} /><span>${cliLabel(cli.id)}</span></li>`)}</ul>` : html`<p class="note">${machineText("inventoryHint")}</p>`}
  </div><button type="button" class="btn btn-sm" onClick=${openDiagnostics}>${machineText("openDiagnostics")}<span aria-hidden="true">→</span></button></article>`;
}
/**
 * M-2255 (the user, hmsg-71c25c9b): "Use this PC's Windows CLIs" and "Allow other Windows computers to pair", saved in
 * fleet.yaml like any setting: on is confirmed by a fleet admin, off applies at once (after asking here). A switch the
 * environment sets is shown as such and cannot be changed here.
 */
function RuntimeSwitches({ lease, onChanged, computers, diagnosticsPanel }) {
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
  const guide=html`<aside class="runtime-connect-guide"><h3>${machineText("firstConnection")}</h3><ol><li>${machineText("stepDownload")}</li><li>${machineText("stepRun")}</li><li>${machineText("stepApprove")}</li></ol><details class="runtime-guide">
    <summary>${machineText("guide")}</summary>
    <p>${machineText("guideAddress")}</p><pre><code>${serveCommand}</code></pre>
    <p>${machineText("guideSsh",port)}</p><pre><code>${sshCommand}</code></pre>
    <p class="runtime-guide-warn">${machineText("guideFunnel")}</p><p class="runtime-guide-warn">${machineText("guideLan")}</p>
    <p>${machineText("guidePair")}</p><p>${machineText("guideApprove")}</p>
    <a class="runtime-guide-link" href=${RUNTIME_DOCS} target="_blank" rel="noopener noreferrer">${machineText("remoteRuntimeDocs")}<${Icon} name="external" size=${14} /></a>
  </details><p class="note">${machineText("connectionNote")}</p></aside>`;
  if (unavailable) return html`<div class="runtime-layout"><div class="runtime-main">${computers}<section class="runtime-switches" aria-label=${machineText("switches")}><div class="runtime-switches-main"><h3>${machineText("switches")}</h3><p class="note">${machineText("switchesUnavailable")}</p></div></section>${diagnosticsPanel}</div></div>`;
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
    </div></details></section>${diagnosticsPanel}</div>
    ${guide}
  </div>`;
}
export function RuntimesPanel({navKey}) {
  const lease=useLease(`runtimes:${navKey}`), state=useRuntimeCatalog(), {windowsCli}=useStore(appStore);
  const [pairing,setPairing]=useState(null), [busy,setBusy]=useState(""), [error,setError]=useState("");
  const [server,setServer]=useState(() => typeof location === "undefined" ? "" : location.origin);
  const diagnostics=useRef(null);
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
  const computers = html`<section class="runtime-computers"><h3>${machineText("computersTitle")}</h3>${windowsCli ? html`<${LocalWindowsRuntime} openDiagnostics=${() => {if (diagnostics.current) {diagnostics.current.open=true;diagnostics.current.scrollIntoView?.({block:"start"});}}} />` : null}
    <section class="runtime-machines" aria-label=${machineText("machines")}>${machines.map(machine => html`<${MachineCard} key=${machine.id} machine=${machine} busy=${!!busy} action=${action} />`)}${state.data && !machines.length ? html`<p class="note">${machineText("empty")}</p>` : null}</section>
    <article class="runtime-host-note"><${Icon} name="info" size=${18} /><span>${machineText("localHint")}</span></article></section>`;
  const diagnosticsPanel = windowsCli ? html`<details ref=${diagnostics} class="runtime-local-diagnostics s-ui-disclosure"><summary><${Icon} name="view" size=${22} /><span><strong>${machineText("diagnostics")}</strong><small>${machineText("localWindows")}</small></span></summary><div class="s-disclosure-body"><${WindowsCliPanel} navKey=${`${navKey}:local`} embedded=${true} /></div></details>` : null;
  return html`<section class="runtime-settings">
    <header class="runtime-heading s-page-head"><div><h2>${machineText("title")}<span class="s-scope">${machineText("fleetScope")}</span></h2><p class="s-page-lead">${machineText("lead")}</p></div><div><button type="button" class="btn btn-primary btn-sm" disabled=${!!busy || state.data?.enabled !== true} onClick=${connect}><${Icon} name="plus" size=${15} />${machineText("connect")}</button>${state.data?.enabled === true && !pairing ? download() : null}<button type="button" class="btn btn-sm" disabled=${state.loading} onClick=${state.refresh}><${Icon} name="restart" size=${15} />${machineText("refresh")}</button></div></header>
    ${state.data?.enabled === false ? html`<p class="note">${machineText("disabled")}</p>` : null}
    ${state.loading && !state.data ? html`<p role="status" aria-busy="true"><span class="out-spin" aria-hidden="true"></span> ${machineText("loading")}</p>` : null}
    ${error || state.error ? html`<div class="runtime-error" role="alert"><p>${error || state.error}</p>${state.data && state.error ? html`<p>${machineText("seenCached")}</p>` : null}<button type="button" class="btn btn-sm" onClick=${state.refresh}>${machineText("retry")}</button></div>` : null}
    ${pairing ? html`<section class="runtime-pairing" aria-label=${machineText("pairing")}><h3>${machineText("pairing")}</h3><p>${machineText("pairingHint")}</p><div class="runtime-bundle-step">${download()}<p class="note">${machineText("downloadHint")}</p></div><label><span>${machineText("server")}</span><input type="url" value=${server} spellcheck=${false} onInput=${event => setServer(event.target.value)} /></label><p class="note">${machineText("serverHint")}</p>${command ? html`<label><span>${machineText("command")}</span><input class="runtime-command" value=${command} readOnly=${true} spellcheck=${false} /></label>` : html`<p role="alert">${machineText("serverInvalid")}</p>`}<label><span>${machineText("pairingCode")}</span><input class="runtime-pair-code" value=${pairing.code} readOnly=${true} spellcheck=${false} autocomplete="off" /></label><p class="note">${machineText("expires",machineTime(pairing.expiresAt))}</p><p role="status">${machineText("pairingWait")}</p><button type="button" class="btn btn-ghost btn-sm" onClick=${() => setPairing(null)}>${machineText("closeCode")}</button></section>` : null}
    <${RuntimeSwitches} lease=${lease} onChanged=${state.refresh} computers=${computers} diagnosticsPanel=${diagnosticsPanel} />
    <p class="note runtime-operations-note">${machineText("operationsNote")}</p>
  </section>`;
}
