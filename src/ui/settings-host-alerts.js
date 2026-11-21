import {html,useEffect} from '/assets/app-html.js';
import {register,t} from '/assets/app-i18n.js';
import {useDraft,syncStage} from './settings-draft.js';
import {hostAlertText} from './host-alerts.js';
register('hostAlertSettings',{
 en:{title:'Host alert settings',needs:'Show in Needs you',general:'Send summaries to General',handoff:'General is off initially to avoid duplicate alerts. The existing disk-watch script stays unchanged; arrange its notification handoff separately.',resource:'Resource',warning:'Warning',urgent:'Urgent',clear:'Recovery',percent:'Percent used',gib:'GiB available',fixed:'Memory thresholds use the existing Normal / Elevated / Critical pressure states.',defaults:'Restore defaults',holds:'Threshold holds and recovery delays keep brief spikes from becoming alerts. Acknowledgment does not hide a problem; snooze it from Host health.',off:'Rules are saved while monitoring is off. No alert checks, notification retries or incident files run while off.'},
 'zh-TW':{title:'主機警示設定',needs:'顯示在「需要你」',general:'傳送摘要至 General',handoff:'General 通知預設關閉，避免重複提醒。現有磁碟監測腳本保持不變，請另外安排通知交接。',resource:'監測項目',warning:'注意',urgent:'緊急',clear:'恢復',percent:'使用百分比',gib:'可用 GiB',fixed:'記憶體門檻沿用正常／偏高／嚴重的壓力狀態。',defaults:'還原預設值',holds:'門檻持續時間與恢復延遲可避免短暫尖峰觸發警示。標記已看過不會隱藏問題；可在主機狀態暫停提醒。',off:'監測關閉時仍可儲存規則，但不會執行警示檢查、通知重試或建立問題檔案。'}
});
const text=k=>t('hostAlertSettings.'+k);
export function HostAlertSettings({ctx,health}){
 const defaults=ctx.schema?.host_alert_defaults,base=ctx.hostAlerts;
 const [form,setForm]=useDraft(ctx,'host-alerts',()=>base||{version:1,needsYou:true,general:false,rules:{}});
 useEffect(()=>{syncStage(ctx,'host-alerts',base&&defaults&&JSON.stringify(form)!==JSON.stringify(base)?{label:text('title'),impact:'now',request:{method:'PUT',url:'/api/settings/fleet/host-alerts',body:form}}:null);},[form,base,defaults]);
 if(!base||!defaults)return null;
 const disks=(health?.disks?.value?.volumes||[]).slice(0,62),resources=[{key:'cpu',kind:'cpu',name:hostAlertText('cpu')},{key:'memory',kind:'memory',name:hostAlertText('memory')},...disks.map(v=>({key:'disk:'+v.id,kind:v.roles.includes('wsl-backing')?'backing-drive':'filesystem',name:(v.roles.includes('wsl-backing')?hostAlertText('backing'):hostAlertText('filesystem'))+(v.drive?' ('+v.drive+':)':'')}))];
 for(const [key,rule] of Object.entries(form.rules))if(!resources.some(r=>r.key===key))resources.push({key,kind:rule.kind,name:hostAlertText(rule.kind==='backing-drive'?'backing':'filesystem')+' · '+key.slice(-6)});
 const update=(key,kind,field,value)=>setForm(f=>({...f,rules:{...f.rules,[key]:{...defaults[kind],...f.rules[key],[field]:value}}}));
 const reset=()=>setForm(f=>({...f,rules:{}}));
 const choice=(key,label)=>html`<div class="s-setting-row"><div class="s-setting-copy"><label for=${'hostAlert-'+key}>${text(label)}</label></div><input id=${'hostAlert-'+key} class="s-ui-toggle" type="checkbox" role="switch" checked=${form[key]} onChange=${e=>setForm(f=>({...f,[key]:e.target.checked}))}/></div>`;
 return html`<div class="host-alert-settings"><h4>${text('title')}</h4>${choice('needsYou','needs')}${choice('general','general')}<p class="note">${text('handoff')}</p>
 <details><summary>${text('resource')}</summary>${resources.map(resource=>{const rule=form.rules[resource.key]||defaults[resource.kind],factor=resource.kind==='backing-drive'?1024**3:1;return html`<fieldset class="field" key=${resource.key}><legend>${resource.name}</legend>${resource.kind==='memory'?html`<p class="note">${text('fixed')}</p>`:html`<p class="note">${text(resource.kind==='backing-drive'?'gib':'percent')}</p><div class="grid2">${['warning','urgent','clear'].map(field=>html`<div class="field"><label for=${'alert-'+resource.key+'-'+field}>${text(field)}</label><input id=${'alert-'+resource.key+'-'+field} type="number" min="0" step=${resource.kind==='backing-drive'?'1':'0.1'} value=${rule[field]/factor} onInput=${e=>update(resource.key,resource.kind,field,Number(e.target.value)*factor)}/></div>`)}</div>`}</fieldset>`;})}<button class="btn btn-sm" type="button" onClick=${reset}>${text('defaults')}</button></details><p class="note">${text('holds')}</p><p class="note">${text('off')}</p></div>`;
}
