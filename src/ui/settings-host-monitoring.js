import { html, useEffect, useRef, useState } from '/assets/app-html.js';
import { register, t } from '/assets/app-i18n.js';
import { confirmDialog } from '/assets/ui-confirm.js';
import { useDraft, syncStage } from './settings-draft.js';
import { fleetPath } from '/assets/app-route.js';
import { hostMonitoringVisible } from './settings-capabilities.js';
register('hostMonitoring', {
  en: { open:'View host health',title:'Host monitoring', enabled:'Monitor this computer', agents:'Include agent footprint',
    hint:'Samples every 30–60 seconds; keeps up to 64 MiB locally. Memory and write costs are being measured.',
    agentHint:'Optional process snapshot every minute; for 32 agents, an estimated extra 2–8 MiB RAM and 1–4 MiB of writes per hour.',
    off:'Off by default. While off, there is no monitoring collector, timer or history file.',
    agentUnavailable:'Agent footprint is not available in this version of AgEnD.',
    stopTitle:'Turn off host monitoring?', stopBody:'This stops monitoring and its alerts, and removes the recorded host history. Turning it on again starts a new history.', stop:'Turn off',
    drive:'Windows drive holding this WSL distribution', auto:'Identify automatically', refresh:'Refresh drive list', driveHint:'If automatic identification is unavailable, choose the drive that holds this distribution’s virtual disk. Mounted local drives are listed from the latest sample while monitoring is on; Refresh reads that sample without starting a probe.', },
  'zh-TW': { open:'查看主機狀態',title:'主機監測', enabled:'監測這台電腦', agents:'包含 Agent 資源用量',
    hint:'每 30–60 秒取樣，本機資料最多 64 MiB；額外記憶體與寫入量仍在量測。',
    agentHint:'選用：每分鐘讀取行程資料；32 個 Agent 估計另用 2–8 MiB 記憶體，每小時寫入 1–4 MiB。',
    off:'預設關閉。關閉時沒有監測收集器、計時器或歷史檔案。',
    agentUnavailable:'這個 AgEnD 版本尚未提供 Agent 資源用量。',
    stopTitle:'關閉主機監測？', stopBody:'這會停止監測與通知，並移除已記錄的主機歷史。重新開啟時會建立新的歷史。', stop:'關閉',
    drive:'這個 WSL 發行版本的 Windows 磁碟', auto:'自動辨識', refresh:'重新整理磁碟清單', driveHint:'無法自動辨識時，請選擇存放這個發行版本虛擬磁碟的磁碟。監測開啟後會依最新取樣列出已掛載的本機磁碟；重新整理只讀取該取樣，不會啟動探測。', },
});
const copy = k => t(`hostMonitoring.${k}`);
export function HostMonitoringSettings({ ctx }) {
  const available = hostMonitoringVisible(ctx.schema);
  useEffect(() => { if (!available) syncStage(ctx, 'host-monitoring', null); }, [available]);
  // A collector alone is not a visible feature: S-207 must provide its page too.
  // A separate child keeps hook order stable across capability transitions.
  return available ? html`<${AvailableHostMonitoringSettings} ctx=${ctx} />` : null;
}
function AvailableHostMonitoringSettings({ ctx }) {
  const base = { enabled:ctx.fleet.monitoring?.enabled === true, agent_footprint:ctx.fleet.monitoring?.agent_footprint === true,
    ...(typeof ctx.fleet.monitoring?.wsl_drive === 'string' ? {wsl_drive:ctx.fleet.monitoring.wsl_drive} : {}) };
  const [form, setForm] = useDraft(ctx, 'host-monitoring', () => base);
  const [health,setHealth] = useState(null), [reading,setReading] = useState(false);
  const live=useRef(false),seq=useRef(0);
  const refresh=async()=>{
    const request=++seq.current;setReading(true);
    try {const r=await fetch('/ui/host-health');const snapshot=r.ok?await r.json():null;if(live.current&&request===seq.current)setHealth(snapshot);}
    catch {if(live.current&&request===seq.current)setHealth(null);}
    finally {if(live.current&&request===seq.current)setReading(false);}
  };
  useEffect(()=>{live.current=true;void refresh();return()=>{live.current=false;seq.current++;};},[]);
  const agentsAvailable = ctx.schema?.host_monitoring_agents === true;
  useEffect(() => {
    const changed = form.enabled !== base.enabled || form.agent_footprint !== base.agent_footprint || (form.wsl_drive ?? '') !== (base.wsl_drive ?? '');
    syncStage(ctx, 'host-monitoring', changed ? {label:copy('title'), impact:'now', request:{method:'PUT',url:'/api/settings/fleet/monitoring',body:{enabled:form.enabled,agent_footprint:form.agent_footprint,...(Object.hasOwn(form,'wsl_drive')?{wsl_drive:form.wsl_drive}:{})}}} : null);
  }, [form]);
  const setEnabled = async (checked, control) => {
    if (!checked && form.enabled && !(await confirmDialog({title:copy('stopTitle'),message:copy('stopBody'),confirmLabel:copy('stop'),danger:true}))) {
      // The browser toggled its native property before the asynchronous question.
      // Cancel leaves the draft unchanged, so restore the displayed value too.
      control.checked = form.enabled;
      return;
    }
    setForm(f=>({...f,enabled:checked}));
  };
  const row = (id,key,hint,disabled,change) => html`<div class="s-setting-row"><div class="s-setting-copy"><label for=${id}>${copy(key)}</label><p class="note" id=${`${id}-hint`}>${copy(hint)}</p></div>
    <input class="s-ui-toggle" type="checkbox" role="switch" id=${id} checked=${form[key === 'agents' ? 'agent_footprint':'enabled']} disabled=${disabled} aria-describedby=${`${id}-hint`} onChange=${e=>change(e.target.checked, e.target)} /></div>`;
  return html`<section class="card s-group" id="host-monitoring"><div class="s-group-head"><h3>${copy('title')}</h3><a class="btn btn-sm" href=${fleetPath('host-health')}>${copy('open')}</a></div>
    ${row('hostMonitoringEnabled','enabled','hint',false,setEnabled)}
    ${row('hostMonitoringAgents','agents','agentHint',!agentsAvailable || !form.enabled,checked=>setForm(f=>({...f,agent_footprint:checked})))}
    ${health?.platform === 'wsl' || base.wsl_drive ? html`<div class="field"><label for="hostMonitoringDrive">${copy('drive')}</label>
      <select id="hostMonitoringDrive" value=${form.wsl_drive ?? ''} onChange=${e=>setForm(f=>({...f,wsl_drive:e.target.value}))}>
        <option value="">${copy('auto')}</option>${[...new Set([...(health?.disks?.value?.availableDrives ?? []),form.wsl_drive])].filter(v=>typeof v==='string'&&/^[A-Z]$/.test(v)).slice(0,26).map(d=>html`<option value=${d}>${d}:</option>`)}</select>
      <p class="note">${copy('driveHint')}</p><button type="button" class="btn btn-sm" disabled=${reading} onClick=${refresh}>${copy('refresh')}</button></div>` : null}
    ${!agentsAvailable ? html`<p class="note">${copy('agentUnavailable')}</p>` : null}
    <p class="note">${copy('off')}</p></section>`;
}
