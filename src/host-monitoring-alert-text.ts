import type {HostAlertRecord} from './host-monitoring-alert-policy.js';
import type {HostAlertPending} from './host-monitoring-alert-store.js';
/** No paths, actors or raw commands in a General summary. Each disk keeps a short opaque identity. */
export function hostAlertSummary(changes:Array<{transition:HostAlertPending['transition'];record:HostAlertRecord}>,locale:string):string {
 const zh=locale==='zh-TW',labels=zh?{cpu:'CPU',memory:'記憶體壓力',filesystem:'檔案系統','backing-drive':'存放 WSL 的 Windows 磁碟',inodes:'inode'}:{cpu:'CPU',memory:'Memory pressure',filesystem:'Filesystem','backing-drive':'Windows backing drive',inodes:'Inodes'};
 return [zh?'主機狀態':'Host health',...changes.map(({transition,record:r})=>{
  const status=transition==='resolved'?(zh?'已恢復':'Recovered'):r.level==='urgent'?(zh?'緊急':'Urgent'):(zh?'注意':'Warning');
  const value=r.kind==='backing-drive'?(r.value/1024**3).toFixed(1)+(zh?' GiB 可用':' GiB free'):r.kind==='memory'?(zh?['正常','偏高','嚴重']:['normal','elevated','critical'])[r.value]:r.value.toFixed(1)+'%';
  return `${status}: ${labels[r.kind]}${r.key.startsWith('disk:')?' · '+r.key.slice(-6):''} · ${value}${transition==='reminder'?(zh?'（再次提醒）':' (reminder)'):''}`;
 }),zh?'在網頁開啟 Fleet → 主機狀態：/ui/fleet/host-health':'Open Fleet → Host health: /ui/fleet/host-health'].join('\n');
}
