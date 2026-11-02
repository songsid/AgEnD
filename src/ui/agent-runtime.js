import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { Icon } from "/assets/ui-icons.js";

register("runtime", {
  "zh-TW": { title:"新增 Agent", choose:"1. 選擇 Runtime", wsl:"WSL / Linux", windows:"Windows 本機", wslHint:"使用 Linux CLI 與工作目錄", windowsHint:"使用 Windows 工具與本機登入", disabled:"需要先啟用 Windows CLI", configure:"2. 設定 Agent", backend:"CLI", directory:"工作目錄（選填）", nativeHint:"建立 Windows Codex Agent，保留獨立對話。Claude Code 目前僅支援偵測。", model:"使用 Windows Codex 的預設模型", access:"檔案存取", read:"唯讀", write:"工作目錄可寫入", required:"請填入 Agent 名稱，工作目錄可以留空。", created:"Windows Agent 已建立", assist:"讓 AI 幫我填寫", assistHint:"由已登入的 Windows Codex 產生草稿，填回下方後可編輯，再按「建立」。", noAi:"需要先有可用的 AI：請在設定 → Windows CLI 確認 Codex 已登入。", goal:"描述想建立的 Agent", placeholder:"例如：建立一個協助整理資料、回答問題的助手", generate:"產生設定草稿", generating:"AI 正在產生草稿…", cancel:"取消產生", draftError:"AI 沒有回傳有效的設定草稿，請調整描述後再試。", nativeBackend:"Codex — Windows", nativeClaude:"Claude Code — Windows（僅偵測）" },
  en: { title:"New agent", choose:"1. Choose a runtime", wsl:"WSL / Linux", windows:"Native Windows", wslHint:"Linux CLIs and working directories", windowsHint:"Windows tools and local sign-ins", disabled:"Enable Windows CLI first", configure:"2. Configure the agent", backend:"CLI", directory:"Working directory (optional)", nativeHint:"Creates a Windows Codex agent with its own conversation. Claude Code is detection-only.", model:"Use Windows Codex's default model", access:"File access", read:"Read only", write:"Workspace write", required:"Enter an agent name. The working directory is optional.", created:"Windows agent created", assist:"Let AI fill this in", assistHint:"Uses signed-in Windows Codex to draft these settings. Review or edit them, then press Create.", noAi:"A working AI is needed first: check the Codex sign-in under Settings → Windows CLI.", goal:"Describe the agent you want", placeholder:"For example: an assistant that organizes information and answers questions", generate:"Generate settings", generating:"AI is drafting settings…", cancel:"Cancel generation", draftError:"The AI did not return a valid settings draft. Adjust the description and try again.", nativeBackend:"Codex — Windows", nativeClaude:"Claude Code — Windows (detection only)" },
});
export const tr = key => t(`runtime.${key}`);
register("runtime", {
  "zh-TW": { nativeHint:"使用所選 Windows CLI 的本機登入，保留獨立對話。只顯示已安裝且支援派工的 CLI。", model:"使用 CLI 預設模型", write:"使用本機 CLI 權限", noReadOnly:"這個 CLI 無法保證唯讀。請選擇本機 CLI 權限後再建立。", nativePolicy:"依照此 CLI 的本機存取與核准設定執行。", noCli:"沒有可派工的 CLI，請先到 Windows CLI 設定檢查。" },
  en: { nativeHint:"Uses the selected Windows CLI's sign-in and keeps its own conversation. Only installed CLIs with task support are listed.", model:"Use the CLI default model", write:"Use native CLI permissions", noReadOnly:"This CLI cannot guarantee read-only access. Choose native CLI permissions to continue.", nativePolicy:"Uses this CLI's local access and approval settings.", noCli:"No task-capable CLI found. Check Windows CLI settings first." },
});
register("runtime", {
  "zh-TW": { progress:"建立 Agent 的進度", runtimeStep:"選擇 Runtime", configureStep:"設定 Agent", doneStep:"完成", where:"這個 Agent 要在哪裡執行？", runtimeLead:"先選擇執行環境與 CLI，下一步再設定 Agent。", environment:"執行環境", configureLead:"填入 Agent 名稱與指示，工作目錄可留空，也可以讓 AI 協助填寫。", changeRuntime:"更換 Runtime", back:"上一步", next:"下一步", finish:"完成", openChat:"開啟對話", viewAgents:"查看 Agent", success:"Agent 已建立", successLead:"設定已儲存，可以開始使用這個 Agent。", autoWorkspace:"由 AgEnD 自動建立工作區" },
  en: { progress:"Agent creation progress", runtimeStep:"Choose runtime", configureStep:"Configure agent", doneStep:"Done", where:"Where should this agent run?", runtimeLead:"Choose an environment and CLI. Configure the agent in the next step.", environment:"Environment", configureLead:"Set a name and instructions, or let AI help fill them in. The working directory is optional.", changeRuntime:"Change runtime", back:"Back", next:"Next", finish:"Done", openChat:"Open chat", viewAgents:"View agents", success:"Agent created", successLead:"Your settings are saved. This agent is ready to use.", autoWorkspace:"AgEnD creates a managed workspace" },
});

register("runtime", {
  "zh-TW": { loadingClis:"正在載入可用的 CLI…", directoryHint:"留空時，AgEnD 會自動建立獨立工作區", nameHint:"例如：通用助手" },
  en: { loadingClis:"Loading available CLIs…", directoryHint:"Leave empty for a separate workspace created by AgEnD", nameHint:"For example: General assistant" },
});
register("runtime", {
  en: { computers:"Connected computers", online:"Online", offline:"Offline", pending:"Awaiting approval", revoked:"Revoked", machineLoading:"Loading connected computers…", machineFailed:"Could not update connected computers. Local choices are still available.", machineRetry:"Refresh computers", noRemoteCli:"This computer has not reported a task-capable CLI.", remoteDirectory:"Working directory on {0} (optional)", remoteDraft:"AI-assisted setup is currently available for the local runtime. You can enter this remote agent's settings below.", machine:"Computer", inventoryAt:"CLI inventory updated: {0}", remotePolicy:"Files and CLI permissions belong to the selected computer. Sign-ins remain on that computer.", manage:"Connect or manage computers in Settings → Runtime", noAvailableMachine:"Connect and approve a computer in Settings → Runtime to use its CLIs." },
  "zh-TW": { computers:"已連接的電腦", online:"在線", offline:"離線", pending:"等待核准", revoked:"已撤銷", machineLoading:"正在載入已連接的電腦…", machineFailed:"無法更新已連接的電腦，仍可使用本機選項。", machineRetry:"更新機器清單", noRemoteCli:"這台電腦尚未回報可派工的 CLI。", remoteDirectory:"{0} 上的工作目錄（選填）", remoteDraft:"AI 協助設定目前適用於本機 Runtime，你可以直接填寫下方遠端 Agent 設定。", machine:"電腦", inventoryAt:"CLI 清單更新：{0}", remotePolicy:"檔案與 CLI 權限屬於所選電腦，登入也保留在該電腦上。", manage:"前往設定 → Runtime 連接或管理電腦", noAvailableMachine:"在設定 → Runtime 連接並核准電腦後，即可使用它的 CLI。" },
});
register("runtime", {
  "zh-TW": {
    agendQueries:"AgEnD 工具：唯讀模式可查詢 Agent、任務與派送狀態。",
    agendActions:"AgEnD 工具：可用的查詢、訊息、派工與任務操作，依 Agent 的工具權限決定。",
    agendUnavailable:"此 CLI 尚未支援呼叫 AgEnD 工具，仍可接收 Fleet 派工。",
  },
  en: {
    agendQueries:"AgEnD tools: read-only mode can query agents, tasks and delivery status.",
    agendActions:"AgEnD tools: queries, messaging, delegation and task actions depend on this agent's tool permissions.",
    agendUnavailable:"This CLI cannot call AgEnD tools yet. It can still receive Fleet tasks.",
  },
});
/** Only advertise the capability confirmed by the installed CLI, not its product name. */
export function NativeAgendToolsHint({ cli, sandbox }) {
  const supported = cli?.supports?.mcp;
  if (supported !== true && supported !== false) return null;
  return html`<p class="note native-agend-tools">${tr(!supported ? "agendUnavailable" : sandbox === "read-only" ? "agendQueries" : "agendActions")}</p>`;
}
export function RuntimePicker({ value, onChange, windowsEnabled, disabled, machineId = "", machines = [], onMachineChange, legend = tr("choose") }) {
  return html`<fieldset class="agent-runtime-picker" disabled=${disabled}><legend>${legend}</legend><div>${["wsl","windows"].map(runtime => html`<label key=${runtime} class=${`agent-runtime-choice${!machineId && value === runtime ? " selected" : ""}`}><input type="radio" name="agent-runtime" value=${runtime} checked=${!machineId && value === runtime} disabled=${runtime === "windows" && !windowsEnabled} onChange=${() => onChange(runtime)} /><${Icon} name=${runtime === "windows" ? "view" : "code"} size=${22} /><span><strong>${tr(runtime)}</strong><small>${tr(runtime === "windows" && !windowsEnabled ? "disabled" : `${runtime}Hint`)}</small></span></label>`)}</div>
    ${machines.length ? html`<section class="runtime-remote-targets" aria-label=${tr("computers")}><h4>${tr("computers")}</h4>${machines.filter(machine => machine.status !== "revoked").map(machine => html`<label key=${machine.id} class=${`agent-runtime-choice${machineId === machine.id ? " selected" : ""}`}><input type="radio" name="agent-runtime" value=${`machine:${machine.id}`} checked=${machineId === machine.id} disabled=${machine.status !== "online"} onChange=${() => onMachineChange?.(machine.id)} /><${Icon} name="view" size=${22} /><span><strong>${machine.name}</strong><small>${machine.platform || "Windows"} · ${tr(["online","offline","pending"].includes(machine.status) ? machine.status : "offline")}</small></span></label>`)}</section>` : null}
  </fieldset>`;
}
export function parseAgentDraft(text, runtime) {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].at(-1)?.[1];
  const raw = fenced || text.slice(text.indexOf("{"),text.lastIndexOf("}")+1);
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || !["name","cwd","description","instructions"].every(key => typeof value[key] === "string")
    || value.name.length > 64 || value.instructions.length > 8000 || value.description.length > 512 || !value.name.trim()
    || !(value.cwd === "" || (runtime === "windows" ? /^[a-z]:[\\/]/i.test(value.cwd) : /^\//.test(value.cwd)))) throw new Error(tr("draftError"));
  return value;
}
export function AgentDraftAssistant({ runtime, probe, onDraft, onBusy, initialGoal = "", onGoalChange }) {
  const lease = useLease(`agent-draft:${runtime}`);
  const [goal,setGoal] = useState(initialGoal), [id,setId] = useState(null), [error,setError] = useState("");
  const claimed = useRef(false), taskId = useRef(null), polling = useRef(false);
  const ready = probe?.clis?.some(cli => cli.id === "codex" && cli.runnable);
  const api = async (path,body) => {
    const r = await lease.fetch(path,{credentials:"same-origin",...(body === undefined ? {} : {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});
    const value = await r.json();
    if (!r.ok) { const e = new Error(value.error || `HTTP ${r.status}`); e.rejected = true; throw e; }
    return value;
  };
  const done = () => { taskId.current = null; claimed.current = false; setId(null); onBusy(false); };
  const refresh = async () => {
    if (polling.current || !taskId.current) return;
    polling.current = true;
    try {
      const task = await api(`/ui/windows-cli/tasks/${taskId.current}`);
      if (!lease.current()) return;
      if (["completed","failed","cancelled"].includes(task.status)) {
        done();
        if (task.status === "completed") { try { onDraft(parseAgentDraft(task.output,runtime)); } catch { setError(tr("draftError")); } }
        else if (task.error) setError(task.error);
      }
    } catch(e) { if (lease.current()) setError(e.message); }
    finally { polling.current = false; }
  };
  useEffect(() => {
    if (!id) return;
    void refresh();
    const timer = lease.interval(refresh,1000);
    return () => lease.clear(timer);
  },[lease,id]);
  useEffect(() => () => {
    if (taskId.current) void fetch(`/ui/windows-cli/tasks/${taskId.current}/cancel`,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:"{}"}).catch(() => {});
  },[lease]);
  const generate = async () => {
    if (claimed.current || !ready || !goal.trim()) return;
    claimed.current = true; onBusy(true); setError("");
    const requestId = taskId.current = crypto.randomUUID();
    const prompt = `Draft configuration for a new AgEnD agent. Runtime: ${runtime}. This is configuration drafting only. Do not use tools, run commands, read files or create the agent. Return only a JSON object with string keys name, cwd, description, instructions. Use an absolute ${runtime === "windows" ? "Windows drive" : "Linux"} path provided by the user; do not invent a project path. If no path was given use an empty string for cwd (AgEnD will create a managed workspace). Name at most 64 characters, description at most 512, instructions at most 8000. Use the user's language. User request:\n${goal}`;
    try { await api("/ui/windows-cli/tasks",{requestId,cli:"codex",cwd:probe.home,prompt,sandbox:"read-only"}); if (lease.current()) setId(requestId); }
    catch(e) { if (lease.current()) { setError(e.message); if (e.rejected) done(); else setId(requestId); } }
  };
  const cancel = async () => { try { await api(`/ui/windows-cli/tasks/${taskId.current}/cancel`,{}); if (lease.current()) await refresh(); } catch(e) { if (lease.current()) setError(e.message); } };
  return html`<details class="agent-draft-assistant"><summary><${Icon} name="wand" size=${16} />${tr("assist")}</summary><p class="note">${tr(ready ? "assistHint" : "noAi")}</p><label class="field"><span>${tr("goal")}</span><textarea rows="2" maxLength=${2000} value=${goal} disabled=${!!id || claimed.current} placeholder=${tr("placeholder")} onInput=${e => { setGoal(e.target.value); onGoalChange?.(e.target.value); }} /></label>${error ? html`<p class="error" role="alert">${error}</p>` : null}<button type="button" class="btn btn-sm" disabled=${!ready || !goal.trim() || claimed.current} onClick=${generate}><${Icon} name="wand" size=${14} />${tr(id ? "generating" : "generate")}</button>${id ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${cancel}>${tr("cancel")}</button>` : null}</details>`;
}
