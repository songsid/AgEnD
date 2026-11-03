import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { PanelHeader, setTitle } from "/assets/app-shell.js";
import { Icon } from "/assets/ui-icons.js";
import { CliPicker, CliProductMark, cliLabel } from "./cli-picker.js";
import { ModelSelect } from "./settings-dialogs.js";
import { useWindowsCliCatalog, WindowsCliDiscoveryStatus } from "./windows-cli-catalog.js";

register("wincli", {
  "zh-TW": { intro:"在 Windows 上執行一次性任務，使用本機已安裝的 CLI 和登入。", probe:"偵測 Windows CLI", probing:"正在偵測…", newTask:"派送 Windows Codex 任務", folder:"Windows 工作目錄", prompt:"任務內容", access:"檔案存取", readOnly:"唯讀", write:"工作目錄可寫入", limits:"目前支援 Codex 單次任務，同時一個，五分鐘後請求取消。使用 CLI 的沙箱與核准政策；此頁不提供互動核准按鈕。Claude 目前提供偵測。", run:"開始任務", results:"任務與結果", refresh:"更新", signedIn:"已登入", signedOut:"尚未登入", unknown:"登入狀態未知", missing:"未找到執行檔", empty:"還沒有任務。", cancel:"取消任務", starting:"準備啟動", running:"執行中", cancelling:"正在取消", cancelled:"已取消", completed:"已完成", failed:"失敗", waiting:"正在接收 Windows CLI 的輸出…", uncertain:"提交結果不明，請按「更新」確認任務狀態，勿立即重送。" },
  en: { intro:"Run a one-off Windows task using locally installed CLIs and their sign-ins.", probe:"Detect Windows CLIs", probing:"Detecting…", newTask:"Run a Windows Codex task", folder:"Windows working directory", prompt:"Task", access:"File access", readOnly:"Read only", write:"Workspace write", limits:"Codex one-off tasks only: one at a time, cancellation requested after five minutes. The CLI owns sandbox and approval policy; this page has no interactive approval controls. Claude is detection-only for now.", run:"Start task", results:"Tasks and results", refresh:"Refresh", signedIn:"Signed in", signedOut:"Not signed in", unknown:"Sign-in unknown", missing:"Executable not found", empty:"No tasks yet.", cancel:"Cancel task", starting:"Starting", running:"Running", cancelling:"Cancelling", cancelled:"Cancelled", completed:"Completed", failed:"Failed", waiting:"Waiting for Windows CLI output…", uncertain:"Submission outcome is unknown. Refresh to check the task before sending it again." },
});
register("wincli", {
  "zh-TW": { workspace:"Windows 本機工作區", native:"Windows 本機", providers:"本機 CLI", available:"可派工", unavailableBadge:"尚未就緒", detectionOnly:"僅偵測", notDetected:"尚未偵測", checking:"檢查中", path:"執行檔路徑", taskHint:"使用 Windows Codex，在指定專案中執行一次性任務。", folderHint:"請填入已存在的 Windows 專案資料夾。", promptPlaceholder:"例如：檢查這個專案的結構，說明如何在 Windows 上啟動。", readHint:"適合檢查、查詢與分析", writeHint:"適合修改程式與檔案", taskLimits:"同時 1 個任務 · 5 分鐘後請求取消", policy:"存取與核准方式", policyText:"沿用本機 CLI 的沙箱與核准政策，包含已設定的自動審查。此頁不提供互動核准按鈕。", ready:"Codex 已就緒", busy:"Windows 任務執行中", unavailable:"請先確認 Codex 已安裝並登入", historyHint:"查看執行狀態與 CLI 輸出", emptyHint:"派送第一個任務後，進度與結果會出現在這裡。", noOutput:"這個任務沒有回傳輸出。", records:"筆", historyNote:"保留最近 20 筆，重啟後清空", output:"執行輸出", submitting:"正在提交…" },
  en: { workspace:"Your Windows workspace", native:"Native Windows", providers:"Local CLIs", available:"Tasks enabled", unavailableBadge:"Not ready", detectionOnly:"Detection only", notDetected:"Not detected yet", checking:"Checking", path:"Executable path", taskHint:"Run a one-off task in your project with Windows Codex.", folderHint:"Use an existing Windows project folder.", promptPlaceholder:"For example: inspect this project and explain how to run it on Windows.", readHint:"Inspect, query and analyze", writeHint:"Edit code and files", taskLimits:"One task at a time · Cancellation after 5 min", policy:"Access and approvals", policyText:"Uses the local CLI's sandbox and approval policy, including any configured automatic reviewer. This page has no interactive approval controls.", ready:"Codex is ready", busy:"Windows task in progress", unavailable:"Check that Codex is installed and signed in", historyHint:"Execution status and CLI output", emptyHint:"Send your first task to see its progress and results here.", noOutput:"This task returned no output.", records:"tasks", historyNote:"Latest 20 tasks; cleared on restart", output:"Execution output", submitting:"Submitting…" },
});
const tn = key => t(`wincli.${key}`);
register("wincli", {
  "zh-TW": { newTask:"派送 Windows CLI 任務", taskHint:"選擇本機 CLI 與模型，在指定專案中執行任務。", ready:"CLI 已就緒", unavailable:"請先確認 CLI 已安裝並登入", model:"模型", defaultModel:"使用 CLI 預設模型", write:"使用本機 CLI 權限", writeHint:"依照此 CLI 的本機核准設定", writeHintClaude:"可修改工作目錄內的檔案；目錄外的寫入、會修改檔案的 Shell 指令與網路都會被拒絕（唯讀指令仍會執行）", noReadOnly:"此 CLI 無法保證唯讀，請明確選擇本機 CLI 權限。", noProviders:"沒有找到已安裝的 CLI。安裝後可重新偵測。" },
  en: { newTask:"Run a Windows CLI task", taskHint:"Choose a local CLI and model, then run a task in your project.", ready:"CLI is ready", unavailable:"Check that the CLI is installed and signed in", model:"Model", defaultModel:"Use the CLI default model", write:"Use native CLI permissions", writeHint:"Uses this CLI's local approval settings", writeHintClaude:"Edits files in the working directory; writes outside it, shell commands that change files and network access are denied (read-only commands still run)", noReadOnly:"This CLI cannot guarantee read-only access. Choose native CLI permissions explicitly.", noProviders:"No installed CLIs found. Detect again after installation." },
});
const active = task => ["starting","running","cancelling"].includes(task.status);

function CliCard({ cli, probing }) {
  const signedIn = cli.authenticated === true;
  const checking = probing && !cli.path;
  const authKey = checking ? "checking" : !cli.path ? "missing" : signedIn ? "signedIn" : cli.authenticated === false ? "signedOut" : "unknown";
  const providerLabel = cli.company || ({codex:"OpenAI","claude-code":"Anthropic",antigravity:"Google",grok:"xAI","kiro-cli":"AWS",opencode:"Anomaly",muse:"Meta"})[cli.id];
  return html`<article class=${`windows-cli-provider is-${cli.id}`}>
    <div class="windows-cli-provider-head">
      <span class="windows-cli-brand"><${CliProductMark} id=${cli.id} size=${28} /></span>
      <div class="windows-cli-provider-name"><span>${providerLabel}</span><h3>${cliLabel(cli.id)}</h3></div>
      <span class=${`windows-cli-badge ${cli.runnable ? "tone-ready" : "tone-neutral"}`}>${tn(cli.runnable ? "available" : cli.supports?.execution === false ? "detectionOnly" : checking ? "checking" : "unavailableBadge")}</span>
    </div>
    <div class="windows-cli-provider-status"><span class=${`windows-cli-auth ${signedIn ? "tone-ready" : "tone-neutral"}`}><span class="windows-cli-dot"></span>${tn(authKey)}</span><span class="windows-cli-version">${cli.version || "—"}</span></div>
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
      ${["starting","running"].includes(task.status) ? html`<button type="button" class="btn btn-sm btn-ghost danger" onClick=${() => cancel(task.id)}><${Icon} name="stop" size=${14} />${tn("cancel")}</button>` : null}
    </div>
  </details>`;
}

export function WindowsCliPanel({ navKey, embedded = false }) {
  const lease = useLease(navKey);
  const discovery = useWindowsCliCatalog();
  const clis = discovery.data?.clis || [];
  const probing = discovery.loading;
  const [tasks,setTasks] = useState([]), [cwd,setCwd] = useState("");
  const [prompt,setPrompt] = useState(""), [sandbox,setSandbox] = useState("read-only");
  const [selected,setSelected] = useState("codex"), [model,setModel] = useState("");
  const [submitting,setSubmitting] = useState(false), [error,setError] = useState("");
  const submission = useRef(null), claimed = useRef(false), readGeneration = useRef(0), polling = useRef(false);
  const api = async (path,body) => {
    const r = await lease.fetch(path, { credentials:"same-origin", ...(body === undefined ? {} : { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body) }) });
    const data = await r.json();
    if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.rejected = true; throw e; }
    return data;
  };
  const refresh = async () => {
    const generation = ++readGeneration.current;
    try {
      const data = await api("/ui/windows-cli/tasks");
      if (!lease.current() || generation !== readGeneration.current) return;
      setTasks(data.tasks);
      if (submission.current && data.tasks.some(task => task.id === submission.current)) { submission.current = null; claimed.current = false; setSubmitting(false); }
    } catch (e) { if (lease.current()) setError(e.message); }
  };
  const probe = () => discovery.refresh();
  useEffect(() => { if (!embedded) setTitle("Windows CLI"); void refresh(); },[lease]);
  useEffect(() => { if (discovery.data) setCwd(old => old || discovery.data.home); },[discovery.data]);
  const running = tasks.some(active);
  useEffect(() => {
    if (!running) return;
    const timer = lease.interval(async () => { if (polling.current) return; polling.current = true; try { await refresh(); } finally { polling.current = false; } },1000);
    return () => lease.clear(timer);
  },[lease,running]);
  const run = async () => {
    if (claimed.current) return;
    claimed.current = true; setSubmitting(true); setError("");
    const input = { requestId:crypto.randomUUID(), cli:selected, ...(model.trim() ? {model:model.trim()} : {}), cwd:cwd.trim(), prompt, sandbox };
    submission.current = input.requestId;
    try { await api("/ui/windows-cli/tasks",input); }
    catch (e) {
      if (!lease.current()) return;
      setError(e.rejected ? e.message : `${e.message}\n${tn("uncertain")}`);
      if (e.rejected) { submission.current = null; claimed.current = false; setSubmitting(false); }
    }
    if (lease.current()) await refresh();
  };
  const cancel = async id => { try { await api(`/ui/windows-cli/tasks/${id}/cancel`,{}); if (lease.current()) await refresh(); } catch(e) { if (lease.current()) setError(e.message); } };
  const current = clis.find(cli => cli.id === selected);
  const permissionReady = sandbox !== "read-only" || current?.readOnlySupport !== false;
  const runnable = current?.runnable === true && permissionReady;
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
      <header class="windows-cli-intro"><div><span class="windows-cli-eyebrow"><${Icon} name="view" size=${14} />${tn("native")}</span><h2>${tn("workspace")}</h2><p>${tn("intro")}</p></div>
        <button type="button" class="btn windows-cli-probe" disabled=${probing} onClick=${probe}><${Icon} name="restart" size=${16} cls=${probing ? "windows-cli-spin" : ""} />${tn(probing ? "probing" : "probe")}</button>
      </header>
      <${WindowsCliDiscoveryStatus} state=${discovery} />
      <section class="windows-cli-cards" aria-label=${tn("providers")}>${providers.map(cli => html`<${CliCard} key=${cli.id} cli=${cli} probing=${probing} />`)}${discovery.data && !providers.length && !probing && !discovery.error ? html`<p class="note">${tn("noProviders")}</p>` : null}</section>
      ${error ? html`<p class="error windows-cli-error" role="alert"><${Icon} name="alert" size=${18} /><span>${error}</span></p>` : null}
      <div class="windows-cli-workbench">
        <section class="windows-cli-card windows-cli-composer" aria-labelledby="windows-task-title"><div class="windows-cli-section-head"><span class="windows-cli-section-icon"><${Icon} name="edit" size=${19} /></span><div><h2 id="windows-task-title">${tn("newTask")}</h2><p>${tn("taskHint")}</p></div></div>
          <form onSubmit=${e => { e.preventDefault(); if (runnable && !submitting && !running && cwd.trim() && prompt.trim()) void run(); }}>
            <div class="windows-cli-field"><label>CLI</label><${CliPicker} label="CLI" value=${selected} choices=${choices} disabled=${!choices.length || submitting || running} onChange=${value => { setSelected(value); setModel(""); }} /></div>
            <div class="windows-cli-field"><label for="windows-model">${tn("model")}</label><${ModelSelect} key=${selected} id="windows-model" value=${model} onChange=${setModel} catalogOverride=${current?.models || []} inherit=${tn("defaultModel")} /></div>
            <div class="windows-cli-field"><label for="windows-cwd">${tn("folder")}</label><input id="windows-cwd" class="windows-cli-directory" value=${cwd} placeholder="J:\\Project\\Game" aria-describedby="windows-cwd-hint" required spellcheck=${false} onInput=${e => setCwd(e.target.value)} /><p id="windows-cwd-hint">${tn("folderHint")}</p></div>
            <div class="windows-cli-field"><label for="windows-prompt">${tn("prompt")}</label><textarea id="windows-prompt" rows="5" value=${prompt} placeholder=${tn("promptPlaceholder")} required maxLength=${16384} onInput=${e => setPrompt(e.target.value)} /></div>
            <fieldset class="windows-cli-access"><legend>${tn("access")}</legend><div class="windows-cli-access-options">
              ${[["read-only","readOnly","readHint","eye"],["workspace-write","write","writeHint","edit"]].map(([value,label,hint,icon]) => html`<label key=${value} class=${`windows-cli-access-option${sandbox === value ? " selected" : ""}`}><input type="radio" name="windows-sandbox" value=${value} checked=${sandbox === value} disabled=${value === "read-only" && current?.readOnlySupport === false} onChange=${() => setSandbox(value)} /><span><strong><${Icon} name=${icon} size=${15} />${tn(label)}</strong><small>${tn(value === "workspace-write" && current?.id === "claude-code" ? "writeHintClaude" : hint)}</small></span></label>`)}
            </div></fieldset>
            ${!permissionReady ? html`<p class="note">${tn("noReadOnly")}</p>` : null}
            <details class="windows-cli-policy"><summary><${Icon} name="info" size=${14} />${tn("policy")}<${Icon} name="chevron" size=${14} /></summary><p>${tn("policyText")}</p></details>
            <div class="windows-cli-submit"><span class=${`windows-cli-readiness ${runnable && !running ? "tone-ready" : "tone-neutral"}`} role="status"><span class="windows-cli-dot"></span>${tn(running ? "busy" : runnable ? "ready" : "unavailable")}</span><button type="submit" class="btn btn-primary" disabled=${!runnable || submitting || running || !cwd.trim() || !prompt.trim()}><${Icon} name=${submitting ? "clock" : "play"} size=${16} />${tn(submitting ? "submitting" : "run")}</button></div>
            <p class="windows-cli-limits"><${Icon} name="clock" size=${13} />${tn("taskLimits")}</p>
          </form>
        </section>
        <section class="windows-cli-card windows-cli-history" aria-labelledby="windows-history-title"><div class="windows-cli-section-head"><span class="windows-cli-section-icon"><${Icon} name="clock" size=${19} /></span><div><h2 id="windows-history-title">${tn("results")} <span class="windows-cli-count">${tasks.length}</span></h2><p>${tn("historyHint")}</p></div><button type="button" class="icon-btn" aria-label=${tn("refresh")} title=${tn("refresh")} onClick=${refresh}><${Icon} name="restart" size=${16} /></button></div>
          <div class="windows-cli-task-list">${!tasks.length ? html`<div class="windows-cli-empty"><span><${Icon} name="view" size=${28} /></span><h3>${tn("empty")}</h3><p>${tn("emptyHint")}</p></div>` : tasks.map((task,index) => html`<${TaskResult} key=${task.id} task=${task} cancel=${cancel} latest=${index === 0} />`)}</div>
          <p class="windows-cli-history-note">${tn("historyNote")}</p>
        </section>
      </div>
    </div></div></div>`;
}
