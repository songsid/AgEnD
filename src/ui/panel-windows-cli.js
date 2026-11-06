import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { PanelHeader, setTitle } from "/assets/app-shell.js";
import { Icon } from "/assets/ui-icons.js";
import { CliPicker, CliProductMark, cliLabel } from "./cli-picker.js";
import { ModelSelect } from "./settings-dialogs.js";
import { useWindowsCliCatalog, WindowsCliDiscoveryStatus, WindowsCliHostIdentity } from "./windows-cli-catalog.js";

register("wincli", {
  "zh-TW": { intro:"在 Windows 上執行一次性任務，使用本機已安裝的 CLI 和登入。", probe:"偵測 Windows CLI", probing:"正在偵測…", newTask:"派送 Windows Codex 任務", folder:"Windows 工作目錄", prompt:"任務內容", access:"檔案存取", readOnly:"唯讀", write:"工作目錄可寫入", limits:"目前支援 Codex 單次任務，同時一個，五分鐘後請求取消。使用 CLI 的沙箱與核准政策；此頁不提供互動核准按鈕。Claude 目前提供偵測。", run:"開始任務", results:"任務與結果", refresh:"更新", signedIn:"已登入", signedOut:"尚未登入", unknown:"登入狀態未知", missing:"未找到執行檔", empty:"還沒有任務。", cancel:"取消任務", starting:"準備啟動", running:"執行中", cancelling:"正在取消", cancelled:"已取消", completed:"已完成", failed:"失敗", waiting:"正在接收 Windows CLI 的輸出…", uncertain:"提交結果不明，請按「更新」確認任務狀態，勿立即重送。" },
  en: { intro:"Run a one-off Windows task using locally installed CLIs and their sign-ins.", probe:"Detect Windows CLIs", probing:"Detecting…", newTask:"Run a Windows Codex task", folder:"Windows working directory", prompt:"Task", access:"File access", readOnly:"Read only", write:"Workspace write", limits:"Codex one-off tasks only: one at a time, cancellation requested after five minutes. The CLI owns sandbox and approval policy; this page has no interactive approval controls. Claude is detection-only for now.", run:"Start task", results:"Tasks and results", refresh:"Refresh", signedIn:"Signed in", signedOut:"Not signed in", unknown:"Sign-in unknown", missing:"Executable not found", empty:"No tasks yet.", cancel:"Cancel task", starting:"Starting", running:"Running", cancelling:"Cancelling", cancelled:"Cancelled", completed:"Completed", failed:"Failed", waiting:"Waiting for Windows CLI output…", uncertain:"Submission outcome is unknown. Refresh to check the task before sending it again." },
});
register("wincli", {
  "zh-TW": { workspace:"Windows 本機工作區", native:"Windows 本機", providers:"本機 CLI", available:"可派工", unavailableBadge:"尚未就緒", detectionOnly:"僅偵測", notDetected:"尚未偵測", checking:"檢查中", path:"執行檔路徑", taskHint:"使用 Windows Codex，在指定專案中執行一次性任務。", folderHint:"請填入已存在的 Windows 專案資料夾。", promptPlaceholder:"例如：檢查這個專案的結構，說明如何在 Windows 上啟動。", readHint:"適合檢查、查詢與分析", writeHint:"適合修改程式與檔案", taskLimits:"同時 1 個任務 · 5 分鐘後請求取消", policy:"存取與核准方式", policyText:"沿用本機 CLI 的沙箱與核准政策，包含已設定的自動審查。此頁不提供互動核准按鈕。", ready:"Codex 已就緒", busy:"Windows 任務執行中", unavailable:"請先確認 Codex 已安裝並登入", historyHint:"查看執行狀態與 CLI 輸出", emptyHint:"派送第一個任務後，進度與結果會出現在這裡。", noOutput:"這個任務沒有回傳輸出。", records:"筆", historyNote:"保留最近 20 筆，重啟後清空", output:"執行輸出", submitting:"正在提交…" },
  en: { workspace:"Your Windows workspace", native:"Native Windows", providers:"Local CLIs", available:"Tasks enabled", unavailableBadge:"Not ready", detectionOnly:"Detection only", notDetected:"Not detected yet", checking:"Checking", path:"Executable path", taskHint:"Run a one-off task in your project with Windows Codex.", folderHint:"Use an existing Windows project folder.", promptPlaceholder:"For example: inspect this project and explain how to run it on Windows.", readHint:"Inspect, query and analyze", writeHint:"Edit code and files", taskLimits:"One task at a time · Cancellation after 5 min", policy:"Access and approvals", policyText:"Uses the local CLI's sandbox and approval policy, including any configured automatic reviewer. This page has no interactive approval controls.", ready:"Codex is ready", busy:"Windows task in progress", unavailable:"Check that Codex is installed and signed in", historyHint:"Execution status and CLI output", emptyHint:"Send your first task to see its progress and results here.", noOutput:"This task returned no output.", records:"tasks", historyNote:"Latest 20 tasks; cleared on restart", output:"Execution output", submitting:"Submitting…" },
});
register("wincli", {
  en: { paneUnverified:"Not yet verified", paneUnverifiedHint:"AgEnD has not tested this version in Windows panes yet. It still runs; any screen AgEnD does not recognise stops and waits for you in Needs you.", paneDenied:"Known not to work", paneDeniedHint:"AgEnD knows this version does not work in Windows panes, so it will not start it. Install a different version." },
  "zh-TW": { paneUnverified:"尚未驗證", paneUnverifiedHint:"AgEnD 還沒在 Windows 面板中測試過這個版本。它仍然可以執行；遇到 AgEnD 認不得的畫面時，會停下來在「需要你」等你處理。", paneDenied:"已知無法使用", paneDeniedHint:"AgEnD 已知這個版本無法在 Windows 面板中使用，所以不會啟動它。請改裝其他版本。" },
});
const tn = key => t(`wincli.${key}`);
register("wincli", {
  "zh-TW": { newTask:"派送 Windows CLI 任務", taskHint:"選擇本機 CLI 與模型，在指定專案中執行任務。", ready:"CLI 已就緒", unavailable:"請先確認 CLI 已安裝並登入", model:"模型", defaultModel:"使用 CLI 預設模型", write:"使用本機 CLI 權限", writeHint:"依照此 CLI 的本機核准設定", writeHintClaude:"可修改工作目錄內的檔案；目錄外的寫入、會修改檔案的 Shell 指令與網路都會被拒絕（唯讀指令仍會執行）", noReadOnly:"此 CLI 無法保證唯讀，請明確選擇本機 CLI 權限。", noProviders:"沒有找到已安裝的 CLI。安裝後可重新偵測。" },
  en: { newTask:"Run a Windows CLI task", taskHint:"Choose a local CLI and model, then run a task in your project.", ready:"CLI is ready", unavailable:"Check that the CLI is installed and signed in", model:"Model", defaultModel:"Use the CLI default model", write:"Use native CLI permissions", writeHint:"Uses this CLI's local approval settings", writeHintClaude:"Edits files in the working directory; writes outside it, shell commands that change files and network access are denied (read-only commands still run)", noReadOnly:"This CLI cannot guarantee read-only access. Choose native CLI permissions explicitly.", noProviders:"No installed CLIs found. Detect again after installation." },
});
register("wincli", {
  en: { remoteIntro:"Inspect CLIs and run a one-off task on the selected Windows computer.", offline:"This computer is offline. Showing its last reported inventory; reconnect its Runtime to detect or run tasks.", removed:"This Runtime is unavailable or no longer approved. Select another computer.", historyLoading:"Loading this computer's task status…", outcomePending:"A task outcome is unconfirmed. Reconnect this Runtime to reconcile before sending another task.", remoteHistory:"Latest 20 tasks on this computer", remoteWorkspace:"Selected Windows computer", remoteHint:"Choose this computer's CLI and model, then run a task in its working directory." },
  "zh-TW": { remoteIntro:"查看所選 Windows 電腦的 CLI，並在該電腦執行一次性任務。", offline:"這台電腦已離線。目前顯示上次回報的清單；請重新連接該 Runtime，才能偵測或派送任務。", removed:"此 Runtime 無法使用或已不再核准，請選擇另一台電腦。", historyLoading:"正在讀取這台電腦的任務狀態…", outcomePending:"有任務的執行結果尚未確認，請重新連接該 Runtime 完成確認後再派工。", remoteHistory:"保留這台電腦最近 20 筆任務", remoteWorkspace:"所選 Windows 電腦", remoteHint:"選擇這台電腦的 CLI 與模型，在該電腦的工作目錄執行任務。" },
});
register("wincli", {
  en: { testCli:"Test CLI", testHint:"Optional: send a one-off task to check execution on this computer.", closeKeepsTask:"Closing this window keeps submitted tasks running. Reopen this computer's diagnostics to check their status.", lastDetection:"Last detection: {0}", inventoryTitle:"Detected CLIs", neverDetection:"No detection recorded yet", modelsFound:"Models reported by this CLI", localDisabled:"This computer's Windows CLI access is disabled." },
  "zh-TW": { testCli:"測試 CLI", testHint:"選用：送出一次性任務，確認這台電腦的 CLI 執行能力。", closeKeepsTask:"關閉視窗後，已提交的任務會繼續執行；重開這台電腦的診斷即可查看狀態。", lastDetection:"最近偵測：{0}", inventoryTitle:"偵測到的 CLI", neverDetection:"尚未有偵測紀錄", modelsFound:"此 CLI 回報的模型", localDisabled:"這台電腦的 Windows CLI 存取已停用。" },
});
const active = task => ["starting","running","cancelling"].includes(task.status);

/** cc3ce4fe: a persistent-pane CLI's version AgEnD has not audited (or knows is broken), from the coordinator's label. */
function paneVerificationTag(cli) {
  const key = cli.paneVerification === "unverified" ? "paneUnverified" : cli.paneVerification === "denied" ? "paneDenied" : "";
  return key ? html`<span class="tag" title=${tn(`${key}Hint`)}>${tn(key)}</span>` : null;
}
function CliCard({ cli, probing, diagnostic = false }) {
  const signedIn = cli.authenticated === true;
  const checking = probing && !cli.path;
  const authKey = checking ? "checking" : !cli.path ? "missing" : signedIn ? "signedIn" : cli.authenticated === false ? "signedOut" : "unknown";
  const providerLabel = cli.company || ({codex:"OpenAI","claude-code":"Anthropic",antigravity:"Google",grok:"xAI","kiro-cli":"AWS",opencode:"Anomaly",muse:"Meta"})[cli.id];
  if(diagnostic) return html`<details class="windows-cli-diagnostic-row"><summary><${CliProductMark} id=${cli.id} size=${24} /><strong>${cliLabel(cli.id)}</strong><span class="windows-cli-diagnostic-version">${cli.version || "—"}</span>${paneVerificationTag(cli)}<span class=${`windows-cli-auth ${signedIn ? "tone-ready" : "tone-neutral"}`}><span class="windows-cli-dot"></span>${tn(authKey)}</span><${Icon} name="chevron" size=${16} /></summary>
    <div class="windows-cli-diagnostic-facts"><span class=${`windows-cli-badge ${cli.runnable ? "tone-ready" : "tone-neutral"}`}>${tn(cli.runnable ? "available" : cli.supports?.execution === false ? "detectionOnly" : "unavailableBadge")}</span><dl><dt>${tn("path")}</dt><dd><code class="windows-cli-path">${cli.path || tn("missing")}</code></dd>${cli.models?.length ? html`<dt>${tn("modelsFound")}</dt><dd><ul class="windows-cli-model-list">${cli.models.map(model=>html`<li key=${model.id}><code>${model.id}</code>${model.label && model.label!==model.id ? html`<span>${model.label}</span>` : null}</li>`)}</ul></dd>` : null}</dl>${cli.reason ? html`<p class="note">${cli.reason}</p>` : null}</div>
  </details>`;
  return html`<article class=${`windows-cli-provider is-${cli.id}`}>
    <div class="windows-cli-provider-head">
      <span class="windows-cli-brand"><${CliProductMark} id=${cli.id} size=${28} /></span>
      <div class="windows-cli-provider-name"><span>${providerLabel}</span><h3>${cliLabel(cli.id)}</h3></div>
      <span class=${`windows-cli-badge ${cli.runnable ? "tone-ready" : "tone-neutral"}`}>${tn(cli.runnable ? "available" : cli.supports?.execution === false ? "detectionOnly" : checking ? "checking" : "unavailableBadge")}</span>
    </div>
    <div class="windows-cli-provider-status"><span class=${`windows-cli-auth ${signedIn ? "tone-ready" : "tone-neutral"}`}><span class="windows-cli-dot"></span>${tn(authKey)}</span><span class="windows-cli-version">${cli.version || "—"}</span>${paneVerificationTag(cli)}</div>
    <details class="windows-cli-location"><summary>${tn("path")}<${Icon} name="chevron" size=${14} /></summary><code class="windows-cli-path">${cli.path || tn(checking ? "checking" : "notDetected")}</code></details>
    ${cli.reason ? html`<p class="note">${cli.reason}</p>` : null}
  </article>`;
}

function TaskResult({ task, latest, cancel }) {
  const [expanded, setExpanded] = useState(latest || active(task));
  const tone = task.status === "completed" ? "ready" : task.status === "failed" ? "failed" : active(task) ? "working" : "neutral";
  return html`<details class="windows-cli-task" open=${expanded || active(task)} onToggle=${e => setExpanded(e.currentTarget.open)}>
    <summary><span class=${`windows-cli-task-state tone-${tone}`}><span class="windows-cli-dot"></span>${tn(task.status)}</span><time dateTime=${new Date(task.startedAt).toISOString()}>${new Date(task.startedAt).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}</time><${Icon} name="chevron" size=${16} /></summary>
    <code class="windows-cli-path windows-cli-task-cwd">${task.cwd}</code>
    <div class="windows-cli-task-detail"><span class="windows-cli-output-label"><${Icon} name="view" size=${14} />${tn("output")}</span><pre class="windows-cli-output" tabIndex="0">${task.output || tn(active(task) ? "waiting" : "noOutput")}</pre>${task.error ? html`<p class="error">${task.error}</p>` : null}
      ${cancel && ["starting","running"].includes(task.status) ? html`<button type="button" class="btn btn-sm btn-ghost danger" onClick=${() => cancel(task.id)}><${Icon} name="stop" size=${14} />${tn("cancel")}</button>` : null}
    </div>
  </details>`;
}

export function WindowsCliPanel({ navKey, embedded = false, machineId = "", machine, drafts, onInventoryChanged, diagnostic = false, enabled = true, session, taskLease }) {
  const lease = useLease(navKey);
  const approved = enabled && (!machineId || ["online","offline"].includes(machine?.status));
  const online = enabled && (!machineId || machine?.status === "online");
  const discovery = useWindowsCliCatalog(approved,machineId);
  const apiBase = machineId ? `/ui/runtimes/machines/${encodeURIComponent(machineId)}` : "/ui/windows-cli";
  const initialDraft = drafts?.get(machineId) || {};
  const clis = discovery.data?.clis || [];
  const probing = discovery.loading;
  const [tasks,setTasks] = useState([]), [cwd,setCwd] = useState(initialDraft.cwd || "");
  const [prompt,setPrompt] = useState(initialDraft.prompt || ""), [access,setAccess] = useState(initialDraft.access || "read-only");
  const [selected,setSelected] = useState(initialDraft.selected || "codex"), [model,setModel] = useState(initialDraft.model || "");
  // The page owns a send across diagnostic-dialog close/reopen. Closing never aborts a submitted POST.
  const ownSession = useRef({requestId:null,pending:false,error:""});
  const operation = session || ownSession.current;
  const [submitting,setSubmitting] = useState(!!operation.requestId), [error,setError] = useState(operation.error || "");
  const [testOpen,setTestOpen] = useState(initialDraft.testOpen || false);
  const readGeneration = useRef(0), polling = useRef(false);
  const [historyReady,setHistoryReady] = useState(false);
  const latestDraft = useRef(null), directoryInitialized = useRef(!!initialDraft.cwd);
  latestDraft.current = {cwd,prompt,access,selected,model,testOpen};
  useEffect(() => () => { drafts?.set(machineId,latestDraft.current); },[drafts,machineId]);
  const api = async (path,body,owner = lease) => {
    const r = await owner.fetch(path, { credentials:"same-origin", ...(body === undefined ? {} : { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body) }) });
    const data = await r.json();
    if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.rejected = true; throw e; }
    return data;
  };
  const refresh = async () => {
    const generation = ++readGeneration.current;
    try {
      const data = await api(`${apiBase}/tasks`);
      if (!lease.current() || generation !== readGeneration.current) return;
      setTasks(data.tasks); setHistoryReady(true);
      if (operation.requestId && data.tasks.some(task => task.id === operation.requestId)) { operation.requestId = null; operation.pending = false; operation.error = ""; }
      setSubmitting(!!operation.requestId);
      if(operation.error) setError(operation.error);
    } catch (e) { if (lease.current() && generation === readGeneration.current) setError(e.message); }
  };
  const probe = async () => { if (!online || !approved) return; const result = await discovery.refresh(); if (result && lease.current()) onInventoryChanged?.(); };
  useEffect(() => { if (!embedded) setTitle("Windows CLI"); if (approved) void refresh(); },[lease,approved,online]);
  useEffect(() => { if (discovery.data?.home && !directoryInitialized.current) { directoryInitialized.current = true; setCwd(discovery.data.home); } },[discovery.data]);
  const running = tasks.some(active);
  const uncertain = tasks.some(task => task.outcomeConfirmed === false);
  useEffect(() => {
    if ((!running && !uncertain && !operation.requestId) || !online || !approved) return;
    const timer = lease.interval(async () => { if (polling.current) return; polling.current = true; try { await refresh(); } finally { polling.current = false; } },1000);
    return () => lease.clear(timer);
  },[lease,running,uncertain,online,approved,submitting]);
  const run = async () => {
    if (operation.requestId || !online || !approved || !historyReady || running || uncertain) return;
    const input = { requestId:crypto.randomUUID(), cli:selected, ...(model.trim() ? {model:model.trim()} : {}), cwd:cwd.trim(), prompt, sandbox:access };
    operation.requestId = input.requestId; operation.pending = true; operation.error = "";
    setSubmitting(true);setError("");
    try { await api(`${apiBase}/tasks`,input,taskLease || lease); }
    catch (e) {
      if(operation.requestId === input.requestId) {
        operation.error = e.rejected ? e.message : `${e.message}\n${tn("uncertain")}`;
        if(e.rejected) operation.requestId = null;
        if (lease.current()) setError(operation.error || e.message);
      }
    } finally {
      if(operation.requestId === input.requestId) operation.pending = false;
    }
    if (lease.current()) await refresh();
  };
  const cancel = async id => { if (!online || !approved) return; try { await api(`${apiBase}/tasks/${id}/cancel`,{}); if (lease.current()) await refresh(); } catch(e) { if (lease.current()) setError(e.message); } };
  const current = clis.find(cli => cli.id === selected);
  const permissionReady = access !== "read-only" || current?.readOnlySupport !== false;
  const runnable = current?.runnable === true && permissionReady && online && approved && historyReady && !uncertain;
  const providers = clis.filter(cli => cli.path);
  const choices = providers.filter(cli => cli.supports?.execution !== false).map(cli => ({value:cli.id,label:cliLabel(cli.id),disabled:!cli.runnable,description:cli.authenticated === false ? tn("signedOut") : cli.version || "Windows"}));
  useEffect(() => {
    if (clis.length && !choices.some(choice => choice.value === selected)) {
      const first = choices.find(choice => !choice.disabled) || choices[0];
      if (first) { setSelected(first.value); setModel(""); }
    }
  },[clis]);
  return html`<div class=${embedded ? "p-windows-cli windows-cli-settings" : "panel p-windows-cli"}>${!embedded ? html`<${PanelHeader} title="Windows CLI" />` : null}
    <div class=${embedded ? "windows-cli-settings-body" : "panel-body"}><div class="windows-cli-content">
      <header class="windows-cli-intro"><div>${diagnostic ? html`<p>${discovery.data?.probedAt ? t("wincli.lastDetection",new Date(discovery.data.probedAt).toLocaleString()) : tn("neverDetection")}</p>` : html`<span class="windows-cli-eyebrow"><${Icon} name="view" size=${14} />${tn("native")}</span><h2>${tn(machineId ? "remoteWorkspace" : "workspace")}</h2><p>${tn(machineId ? "remoteIntro" : "intro")}</p>`}</div>
        <button type="button" class="btn windows-cli-probe" disabled=${probing || !online || !approved} onClick=${probe}><${Icon} name="restart" size=${16} cls=${probing ? "windows-cli-spin" : ""} />${tn(probing ? "probing" : "probe")}</button>
      </header>
      ${!diagnostic ? html`<${WindowsCliHostIdentity} inventory=${discovery.data} machineId=${machineId} machine=${machine} />` : null}
      ${!approved || !online ? html`<p class="note" role="status">${tn(!enabled ? "localDisabled" : approved ? "offline" : "removed")}</p>` : null}
      ${approved ? html`<${WindowsCliDiscoveryStatus} state=${{...discovery,refresh:probe}} disabled=${!online} />` : null}
      <section class=${diagnostic ? "windows-cli-diagnostic-list" : "windows-cli-cards"} aria-label=${tn(diagnostic ? "inventoryTitle" : "providers")}>${providers.map(cli => html`<${CliCard} key=${cli.id} cli=${cli} probing=${probing} diagnostic=${diagnostic} />`)}${discovery.data && !providers.length && !probing && !discovery.error ? html`<p class="note">${tn("noProviders")}</p>` : null}</section>
      ${error ? html`<p class="error windows-cli-error" role="alert"><${Icon} name="alert" size=${18} /><span>${error}</span></p>` : null}
      <details class=${diagnostic ? "windows-cli-test-disclosure" : "windows-cli-test-disclosure is-standalone"} open=${!diagnostic || testOpen || running || uncertain || submitting} onToggle=${event=>{if(event.target===event.currentTarget)setTestOpen(event.currentTarget.open);}}>
        ${diagnostic ? html`<summary><${Icon} name="view" size=${19} /><span><strong>${tn("testCli")}</strong><small>${tn("testHint")}</small></span><${Icon} name="chevron" size=${16} /></summary>` : null}
      <div class="windows-cli-workbench">
        <section class="windows-cli-card windows-cli-composer" aria-labelledby="windows-task-title"><div class="windows-cli-section-head"><span class="windows-cli-section-icon"><${Icon} name="edit" size=${19} /></span><div><h2 id="windows-task-title">${tn("newTask")}</h2><p>${tn(machineId ? "remoteHint" : "taskHint")}</p></div></div>
          <form onSubmit=${e => { e.preventDefault(); if (runnable && !submitting && !running && cwd.trim() && prompt.trim()) void run(); }}>
            <div class="windows-cli-field"><label>CLI</label><${CliPicker} label="CLI" value=${selected} choices=${choices} disabled=${!choices.length || submitting || running} onChange=${value => { setSelected(value); setModel(""); }} /></div>
            <div class="windows-cli-field"><label for="windows-model">${tn("model")}</label><${ModelSelect} key=${selected} id="windows-model" value=${model} onChange=${setModel} catalogOverride=${current?.models || []} inherit=${tn("defaultModel")} /></div>
            <div class="windows-cli-field"><label for="windows-cwd">${tn("folder")}</label><input id="windows-cwd" class="windows-cli-directory" value=${cwd} placeholder="J:\\Project\\Game" aria-describedby="windows-cwd-hint" required spellcheck=${false} onInput=${e => setCwd(e.target.value)} /><p id="windows-cwd-hint">${tn("folderHint")}</p></div>
            <div class="windows-cli-field"><label for="windows-prompt">${tn("prompt")}</label><textarea id="windows-prompt" rows="5" value=${prompt} placeholder=${tn("promptPlaceholder")} required maxLength=${16384} onInput=${e => setPrompt(e.target.value)} /></div>
            <fieldset class="windows-cli-access"><legend>${tn("access")}</legend><div class="windows-cli-access-options">
              ${[["read-only","readOnly","readHint","eye"],["workspace-write","write","writeHint","edit"]].map(([value,label,hint,icon]) => html`<label key=${value} class=${`windows-cli-access-option${access === value ? " selected" : ""}`}><input type="radio" name="windows-sandbox" value=${value} checked=${access === value} disabled=${value === "read-only" && current?.readOnlySupport === false} onChange=${() => setAccess(value)} /><span><strong><${Icon} name=${icon} size=${15} />${tn(label)}</strong><small>${tn(value === "workspace-write" && current?.id === "claude-code" ? "writeHintClaude" : hint)}</small></span></label>`)}
            </div></fieldset>
            ${!permissionReady ? html`<p class="note">${tn("noReadOnly")}</p>` : null}
            <details class="windows-cli-policy"><summary><${Icon} name="info" size=${14} />${tn("policy")}<${Icon} name="chevron" size=${14} /></summary><p>${tn("policyText")}</p></details>
            <div class="windows-cli-submit"><span class=${`windows-cli-readiness ${runnable && !running ? "tone-ready" : "tone-neutral"}`} role="status"><span class="windows-cli-dot"></span>${tn(uncertain ? "outcomePending" : !historyReady ? "historyLoading" : running ? "busy" : runnable ? "ready" : "unavailable")}</span><button type="submit" class="btn btn-primary" disabled=${!runnable || submitting || running || !cwd.trim() || !prompt.trim()}><${Icon} name=${submitting ? "clock" : "play"} size=${16} />${tn(submitting ? "submitting" : "run")}</button></div>
            <p class="windows-cli-limits"><${Icon} name="clock" size=${13} />${tn("taskLimits")}</p>
          </form>
        </section>
        <section class="windows-cli-card windows-cli-history" aria-labelledby="windows-history-title"><div class="windows-cli-section-head"><span class="windows-cli-section-icon"><${Icon} name="clock" size=${19} /></span><div><h2 id="windows-history-title">${tn("results")} <span class="windows-cli-count">${tasks.length}</span></h2><p>${tn("historyHint")}</p></div><button type="button" class="icon-btn" aria-label=${tn("refresh")} title=${tn("refresh")} onClick=${refresh}><${Icon} name="restart" size=${16} /></button></div>
          <div class="windows-cli-task-list">${!tasks.length ? html`<div class="windows-cli-empty"><span><${Icon} name="view" size=${28} /></span><h3>${tn("empty")}</h3><p>${tn("emptyHint")}</p></div>` : tasks.map((task,index) => html`<${TaskResult} key=${task.id} task=${task} cancel=${online && approved ? cancel : null} latest=${index === 0} />`)}</div>
          <p class="windows-cli-history-note">${tn(machineId ? "remoteHistory" : "historyNote")}</p>
        </section>
      </div>
      ${diagnostic ? html`<p class="windows-cli-close-note"><${Icon} name="info" size=${15} />${tn("closeKeepsTask")}</p>` : null}
      </details>
    </div></div></div>`;
}
