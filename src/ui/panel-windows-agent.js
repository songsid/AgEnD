import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { PanelHeader, setTitle } from "/assets/app-shell.js";
import { Icon } from "/assets/ui-icons.js";
import { CliProductMark, cliLabel } from "./cli-picker.js";
import { appStore, useStore } from "/assets/app-store.js";
import { navigate } from "/assets/app-nav.js";
import { chatPath } from "/assets/app-route.js";

register("winagent", {
  "zh-TW": { loading:"正在載入 Windows Agent…", send:"傳送", message:"傳送任務給 Windows Agent", empty:"開始與 Windows Agent 對話", emptyHint:"對話使用 Windows 本機 Codex，後續訊息會接續同一個對話。", settings:"Windows CLI 設定", waiting:"Windows Codex 正在處理…", cancel:"取消任務", you:"你", refresh:"更新", read:"唯讀", write:"工作目錄可寫入", limit:"每次執行最多五分鐘後請求取消，同時一個 Windows 任務。", uncertain:"提交結果不明，請先更新確認，避免重複派工。", blocked:"上次執行的結束狀態不明。請先檢查 Windows 程序是否已停止。", recover:"已確認程序停止，解除鎖定" },
  en: { loading:"Loading Windows agent…", send:"Send", message:"Send a task to the Windows agent", empty:"Start a Windows conversation", emptyHint:"Runs native Windows Codex. Follow-up messages continue the same conversation.", settings:"Windows CLI settings", waiting:"Windows Codex is working…", cancel:"Cancel task", you:"You", refresh:"Refresh", read:"Read only", write:"Workspace write", limit:"Cancellation after five minutes per turn; one Windows task at a time.", uncertain:"Submission outcome is unknown. Refresh before sending again.", blocked:"The last execution outcome is unknown. Check that its Windows processes have stopped.", recover:"Processes stopped — unlock agent" },
});
const tn = key => t(`winagent.${key}`);
register("winagent", {
  "zh-TW": { emptyHint:"使用所選 Windows 本機 CLI，後續訊息會接續同一個對話。", waiting:"Windows CLI 正在處理…", write:"使用本機 CLI 權限" },
  en: { emptyHint:"Runs the selected native Windows CLI. Follow-up messages continue the same conversation.", waiting:"Windows CLI is working…", write:"Native CLI permissions" },
});
register("winagent", {
  "zh-TW": { starting:"準備啟動", running:"執行中", cancelling:"正在取消", completed:"已完成", failed:"失敗", cancelled:"已取消", interrupted:"已中斷", noOutput:"這次執行沒有文字輸出。" },
  en: { starting:"Starting", running:"Running", cancelling:"Cancelling", completed:"Completed", failed:"Failed", cancelled:"Cancelled", interrupted:"Interrupted", noOutput:"This turn returned no text." },
});
export function WindowsAgentPanel({ route, navKey }) {
  const lease = useLease(navKey);
  const { instances = [] } = useStore(appStore);
  const canonical = route.panel === "windows-agent" ? instances.find(instance => instance.runtime === "windows" && instance.native_agent_id === route.instance)?.name : route.instance;
  useEffect(() => { if (route.panel === "windows-agent" && canonical) navigate(chatPath(canonical),{replace:true}); },[canonical,route.panel]);
  const [data,setData] = useState(null), [prompt,setPrompt] = useState(""), [error,setError] = useState("");
  const [submitting,setSubmitting] = useState(false);
  const request = useRef(null), polling = useRef(false), generation = useRef(0);
  const api = async (path, body) => {
    const r = await lease.fetch(path,{credentials:"same-origin",...(body === undefined ? {} : {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});
    const value = await r.json();
    if (!r.ok) { const e = new Error(value.error || `HTTP ${r.status}`); e.rejected = true; throw e; }
    return value;
  };
  const common = route.panel === "chat";
  const root = common ? `/ui/instances/${encodeURIComponent(route.instance)}` : `/ui/windows-cli/agents/${route.instance}`;
  const refresh = async () => {
    const mine = ++generation.current;
    try {
      const value = await api(root);
      if (!lease.current() || mine !== generation.current) return;
      setData({...value.agent,_route:route.instance}); setTitle(`${value.agent.name} · Windows`);
      if (request.current && value.agent.turns.some(turn => turn.id === request.current.id)) { request.current = null; setSubmitting(false); setPrompt(""); }
    } catch(e) { if (lease.current()) setError(e.message); }
  };
  useEffect(() => { request.current = null; setSubmitting(false); setPrompt(""); setError(""); void refresh(); },[lease]);
  const agent = data?._route === route.instance ? data : null;
  const busy = !!agent?.activeId;
  useEffect(() => {
    if (!busy || agent?.blocked) return;
    const timer = lease.interval(async () => { if (polling.current) return; polling.current = true; try { await refresh(); } finally { polling.current = false; } },1000);
    return () => lease.clear(timer);
  },[lease,busy,agent?.blocked]);
  const send = async e => {
    e.preventDefault();
    if (!agent || busy || submitting || request.current || !prompt.trim()) return;
    const message = request.current = { id:crypto.randomUUID(), prompt };
    setSubmitting(true); setError("");
    try { await api(`${root}/messages`,{requestId:message.id,prompt:message.prompt}); }
    catch(e) {
      if (!lease.current()) return;
      setError(e.rejected ? e.message : tn("uncertain"));
      if (e.rejected) { request.current = null; setSubmitting(false); }
    }
    if (lease.current()) await refresh();
  };
  const cancel = async () => { try { await api(common ? `${root}/cancel` : `/ui/windows-cli/tasks/${agent.activeId}/cancel`,{}); if (lease.current()) await refresh(); } catch(e) { if (lease.current()) setError(e.message); } };
  const recover = async () => { try { await api(`${root}/recover`,{confirmedStopped:true}); if (lease.current()) await refresh(); } catch(e) { if (lease.current()) setError(e.message); } };
  return html`<div class="panel p-windows-agent"><${PanelHeader} title=${agent?.name || "Windows Agent"}>
      <a class="btn btn-ghost btn-sm" href="/settings/agents"><${Icon} name="settings" size=${16} />${t("app.settings")}</a>
    </${PanelHeader}>
    <div class="panel-body"><div class="col windows-agent-conversation">
      ${agent ? html`<div class="windows-agent-identity"><span class="windows-cli-brand"><${CliProductMark} id=${agent.cli || "codex"} size=${24} /></span><div><strong>Windows · ${cliLabel(agent.cli || "codex")}${agent.model ? ` · ${agent.model}` : ""}</strong><code>${agent.cwd}</code></div><span class="pill">${tn(agent.sandbox === "read-only" ? "read" : "write")}</span></div>
        ${agent.description ? html`<p class="note">${agent.description}</p>` : null}
        ${!agent.turns.length ? html`<div class="windows-agent-empty"><${Icon} name="chat" size=${32} /><h2>${tn("empty")}</h2><p>${tn("emptyHint")}</p></div>` : agent.turns.map(turn => html`<article key=${turn.id} class="windows-agent-turn"><div class="windows-agent-human"><strong>${tn("you")}</strong><p>${turn.prompt}</p></div><div class="windows-agent-reply"><strong><${CliProductMark} id=${agent.cli || "codex"} size=${18} />${cliLabel(agent.cli || "codex")}</strong><pre tabIndex="0">${turn.output || tn(["starting","running","cancelling"].includes(turn.status) ? "waiting" : "noOutput")}</pre>${turn.error ? html`<p class="error">${turn.error}</p>` : null}<small>${tn(turn.status)}</small></div></article>`)}
      ` : html`<p class="note">${tn("loading")}</p>`}
      ${error ? html`<p class="error" role="alert">${error}</p>` : null}
      ${agent?.blocked ? html`<div class="windows-agent-blocked"><p>${tn("blocked")}</p><button type="button" class="btn" onClick=${recover}>${tn("recover")}</button></div>` : null}
    </div></div>
    <form class="windows-agent-composer" onSubmit=${send}><div class="windows-agent-input"><textarea aria-label=${tn("message")} placeholder=${tn("message")} rows="3" maxLength=${8000} value=${prompt} disabled=${!agent || busy || submitting} onInput=${e => setPrompt(e.target.value)} /><div><button type="button" class="icon-btn" aria-label=${tn("refresh")} onClick=${refresh}><${Icon} name="restart" size=${17} /></button>${busy && !agent?.blocked ? html`<button type="button" class="btn" onClick=${cancel}><${Icon} name="stop" size=${15} />${tn("cancel")}</button>` : html`<button type="submit" class="btn btn-primary" disabled=${!agent || busy || submitting || !prompt.trim()}><${Icon} name="send" size=${16} />${tn("send")}</button>`}</div></div><p class="note">${tn("limit")}</p></form>
  </div>`;
}
