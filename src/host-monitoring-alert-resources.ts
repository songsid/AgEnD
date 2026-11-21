import type {HostHealthSnapshot} from './host-monitoring.js';
import type {HostAlertKind} from './host-monitoring-alert-policy.js';
export interface HostAlertResource {key:string;kind:HostAlertKind;value:number|null;sampledAt:number;capacity?:number}
/** Existing cache only. Unknown/stale readings interrupt dwell; they never clear an incident. */
export function hostAlertResources(snapshot:HostHealthSnapshot,now:number):HostAlertResource[] {
 const fresh=(m:{status:string;sampledAt:number|null},ms:number)=>m.status==='ok'&&m.sampledAt!==null&&now-m.sampledAt<ms*2;
 const cpu=fresh(snapshot.cpu,30000)?snapshot.cpu.value?.usedPercent??null:null;
 const pressure=fresh(snapshot.memory,30000)?snapshot.memory.value?.pressure:null;
 const memory=pressure==='normal'?0:pressure==='elevated'?1:pressure==='critical'?2:null;
 const result:HostAlertResource[]=[{key:'cpu',kind:'cpu',value:cpu,sampledAt:snapshot.cpu.sampledAt??now},{key:'memory',kind:'memory',value:memory,sampledAt:snapshot.memory.sampledAt??now}];
 for(const v of (snapshot.disks.value?.volumes??[]).slice(0,62)){
  if(!/^[a-f0-9]{16}$/.test(v.id))continue;
  const backing=v.roles.includes('wsl-backing'),valid=fresh(snapshot.disks,60000)&&v.sampledAt!==null&&now-v.sampledAt<120000;
  result.push({key:'disk:'+v.id,kind:backing?'backing-drive':'filesystem',value:valid?(backing?v.availableBytes:v.usedPercent):null,sampledAt:v.sampledAt??now,...(v.totalBytes!==null?{capacity:v.totalBytes}:{})});
 }
 return result;
}
