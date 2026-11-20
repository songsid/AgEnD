import { html, useEffect } from '/assets/app-html.js';
import { register, t } from '/assets/app-i18n.js';
import { confirmDialog } from '/assets/ui-confirm.js';
import { useDraft, syncStage } from './settings-draft.js';
register('hostMonitoring', {
  en: { title:'Host monitoring', enabled:'Monitor this computer', agents:'Include agent footprint',
    hint:'When on, samples every 30–60 seconds; estimated 2–4 MiB RAM and 1–4 MiB of local writes per hour.',
    agentHint:'Optional process snapshot every minute; for 32 agents, an estimated extra 2–8 MiB RAM and 1–4 MiB of writes per hour.',
    off:'Off by default. While off, there is no monitoring collector, timer or history file.',
    agentUnavailable:'Agent footprint is not available in this version of AgEnD.',
    stopTitle:'Turn off host monitoring?', stopBody:'This stops monitoring and its alerts, and removes the recorded host history. Turning it on again starts a new history.', stop:'Turn off', },
  'zh-TW': { title:'主機監測', enabled:'監測這台電腦', agents:'包含 Agent 資源用量',
    hint:'開啟後每 30–60 秒取樣；估計使用 2–4 MiB 記憶體，每小時本機寫入 1–4 MiB。',
    agentHint:'選用：每分鐘讀取行程資料；32 個 Agent 估計另用 2–8 MiB 記憶體，每小時寫入 1–4 MiB。',
    off:'預設關閉。關閉時沒有監測收集器、計時器或歷史檔案。',
    agentUnavailable:'這個 AgEnD 版本尚未提供 Agent 資源用量。',
    stopTitle:'關閉主機監測？', stopBody:'這會停止監測與通知，並移除已記錄的主機歷史。重新開啟時會建立新的歷史。', stop:'關閉', },
});
const copy = k => t(`hostMonitoring.${k}`);
export function HostMonitoringSettings({ ctx }) {
  const available = ctx.schema?.host_monitoring === true;
  useEffect(() => { if (!available) syncStage(ctx, 'host-monitoring', null); }, [available]);
  // Keep the dormant controls out of Settings until a real collector is wired.
  // A separate child keeps hook order stable across capability transitions.
  return available ? html`<${AvailableHostMonitoringSettings} ctx=${ctx} />` : null;
}
function AvailableHostMonitoringSettings({ ctx }) {
  const base = { enabled:ctx.fleet.monitoring?.enabled === true, agent_footprint:ctx.fleet.monitoring?.agent_footprint === true };
  const [form, setForm] = useDraft(ctx, 'host-monitoring', () => base);
  const agentsAvailable = ctx.schema?.host_monitoring_agents === true;
  useEffect(() => {
    const changed = form.enabled !== base.enabled || form.agent_footprint !== base.agent_footprint;
    syncStage(ctx, 'host-monitoring', changed ? {label:copy('title'), impact:'now', request:{method:'PUT',url:'/api/settings/fleet/monitoring',body:{enabled:form.enabled,agent_footprint:form.agent_footprint}}} : null);
  }, [form]);
  const setEnabled = async checked => {
    if (!checked && form.enabled && !(await confirmDialog({title:copy('stopTitle'),message:copy('stopBody'),confirmLabel:copy('stop'),danger:true}))) return;
    setForm(f=>({...f,enabled:checked}));
  };
  const row = (id,key,hint,disabled,change) => html`<div class="s-setting-row"><div class="s-setting-copy"><label for=${id}>${copy(key)}</label><p class="note" id=${`${id}-hint`}>${copy(hint)}</p></div>
    <input class="s-ui-toggle" type="checkbox" role="switch" id=${id} checked=${form[key === 'agents' ? 'agent_footprint':'enabled']} disabled=${disabled} aria-describedby=${`${id}-hint`} onChange=${e=>change(e.target.checked)} /></div>`;
  return html`<section class="card s-group" id="host-monitoring"><h3>${copy('title')}</h3>
    ${row('hostMonitoringEnabled','enabled','hint',false,setEnabled)}
    ${row('hostMonitoringAgents','agents','agentHint',!agentsAvailable || !form.enabled,checked=>setForm(f=>({...f,agent_footprint:checked})))}
    ${!agentsAvailable ? html`<p class="note">${copy('agentUnavailable')}</p>` : null}
    <p class="note">${copy('off')}</p></section>`;
}
