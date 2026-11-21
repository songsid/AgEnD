/** Pure, numerical process attribution; no command lines, names, environments or paths in telemetry. */
export const FOOTPRINT_ROOTS = 128, FOOTPRINT_ROWS = 4096, FOOTPRINT_BYTES = 512 * 1024;
export interface FootprintRoot {id:string;pid:number;owner:string;observedAt:number}
export interface FootprintProcess {pid:number;ppid:number;start:number;birth?:number;identity?:number;cpuMs:number;rssBytes:number}
export interface FootprintRow {id:string;cpuPercent:number|null;rssBytes:number|null;managedBytes:number|null;processes:number;reason?:string}
export interface FootprintReading {rows:FootprintRow[];shared:Omit<FootprintRow,'id'>;total:number;covered:number;processRows:number;sampledAt:number;truncated:boolean}
const safe=(n:number)=>Number.isSafeInteger(n)&&n>=0;
const pid=(n:number)=>safe(n)&&n>1;
export function processCpuMs(text:string):number|null {
 const match=/^(?:(\d+)-)?(\d+):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/.exec(text);if(!match)return null;
 const days=Number(match[1]??0),first=Number(match[2]),second=Number(match[3]),third=match[4]===undefined?null:Number(match[4]),fraction=Number((match[5]??'').padEnd(3,'0')||0);
 if(second>59||(third!==null&&third>59)||(days>0&&third===null))return null;
 const value=(days*86400+(third===null?first*60+second:first*3600+second*60+third))*1000+fraction;
 return safe(value)?value:null;
}
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function processStartTime(text:string):number|null {
 const m=/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());if(!m)return null;
 const month=months.indexOf(m[1]),day=Number(m[2]),hour=Number(m[3]),minute=Number(m[4]),second=Number(m[5]),year=Number(m[6]);
 if(month<0||day<1||day>31||hour>23||minute>59||second>59||year<1970)return null;
 const at=Date.UTC(year,month,day,hour,minute,second),d=new Date(at);return d.getUTCDate()===day&&safe(at)?at:null;
}
/** ps runs with TZ=UTC and LC_ALL=C. Overflow/malformed rows fail the entire inventory, not a partial attribution. */
export function parseFootprintProcesses(text:string|null):FootprintProcess[]|null {
 if(text===null||Buffer.byteLength(text)>FOOTPRINT_BYTES)return null;const lines=text.trim()?text.trim().split(/\r?\n/):[];if(lines.length>FOOTPRINT_ROWS)return null;
 const result:FootprintProcess[]=[],seen=new Set<number>();
 for(const line of lines){const m=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);if(!m)return null;const p=Number(m[1]),parent=Number(m[2]),rss=Number(m[3])*1024,cpu=processCpuMs(m[4]),start=processStartTime(m[5]);
  if(!Number.isSafeInteger(p)||p<1||!safe(parent)||!safe(rss)||cpu===null||start===null||seen.has(p))return null;seen.add(p);result.push({pid:p,ppid:parent,start,cpuMs:cpu,rssBytes:rss});}
 return result;
}
const identity=(process:FootprintProcess)=>process.identity??process.start;
interface Baseline {mono:number;wall:number;rows:Map<number,FootprintProcess>}
/** One bounded latest baseline. Root PID reuse, owner changes, clock rollback and gaps withdraw CPU evidence. */
export class FootprintAttribution {
 private before:Baseline|null=null;private pins=new Map<string,{owner:string;pid:number;identity:number}>();
 reset():void {this.before=null;this.pins.clear();}
 sample(processes:FootprintProcess[],roots:FootprintRoot[],fleetPid:number,wall:number,mono:number,logicalCpus:number,candidatePids:readonly number[]=[]):FootprintReading {
  if(processes.length>FOOTPRINT_ROWS||roots.length>FOOTPRINT_ROOTS||candidatePids.length>FOOTPRINT_ROOTS*2||!safe(wall)||!Number.isFinite(mono)||mono<0||!Number.isInteger(logicalCpus)||logicalCpus<1||logicalCpus>1024)throw Error('invalid_footprint_input');
  const rows=new Map(processes.map(p=>[p.pid,p]));if(rows.size!==processes.length)throw Error('invalid_footprint_input');
  const priorPins=new Map(this.pins);
  const previous=this.before,elapsed=previous?mono-previous.mono:0,continuous=!!previous&&elapsed>0&&elapsed<=120000&&wall>=previous.wall;
  this.before={rows,mono,wall};if(!continuous)this.pins.clear();
  const result:FootprintRow[]=[],owner=new Map<number,string>(),ambiguous=new Set<number>(),ids=new Set<string>();
  for(const root of roots){if(!/^[a-f0-9]{16}$/.test(root.id)||ids.has(root.id)||typeof root.owner!=='string'||!root.owner.length||root.owner.length>256||!safe(root.observedAt))throw Error('invalid_footprint_root');ids.add(root.id);
   const row:FootprintRow={id:root.id,cpuPercent:null,rssBytes:null,managedBytes:null,processes:0,reason:'root_unavailable'};result.push(row);const process=rows.get(root.pid),pin=this.pins.get(root.id);
   // Second-resolution OS start stamps must predate the daemon's positive live-pane observation.
   if(!pid(root.pid)||!process||(process.birth??process.start)>root.observedAt-1000||root.observedAt>wall||wall-root.observedAt>120000)continue;
   if(pin&&pin.owner===root.owner&&pin.pid===root.pid&&pin.identity!==identity(process)){continue;}
   this.pins.set(root.id,{owner:root.owner,pid:root.pid,identity:identity(process)});
   if(owner.has(root.pid)){ambiguous.add(root.pid);continue;}owner.set(root.pid,root.id);row.rssBytes=0;delete row.reason;
  }
  for(const root of roots)if(ambiguous.has(root.pid)){const r=result.find(r=>r.id===root.id)!;r.rssBytes=null;r.reason='ambiguous_root';owner.delete(root.pid);}
  for(const id of this.pins.keys())if(!ids.has(id))this.pins.delete(id);
  const knownRoots=new Set([...roots.map(root=>root.pid),...candidatePids].filter(pid));
  const byId=new Map(result.map(r=>[r.id,r])),shared={cpuPercent:null as number|null,rssBytes:0 as number|null,managedBytes:null as number|null,processes:0},cpu=new Map<string,number>(),unknown=new Set<string>();
  const sharedRoots=new Set<number>([fleetPid]);for(const root of roots){const p=rows.get(root.pid);if(owner.has(root.pid)&&p?.ppid&&rows.has(p.ppid))sharedRoots.add(p.ppid);}
  const attribution=(p:FootprintProcess):string|null=>{const seen=new Set<number>();let current=p;
   for(let i=0;i<64;i++){if(seen.has(current.pid)||ambiguous.has(current.pid))return null;seen.add(current.pid);const owned=owner.get(current.pid);if(owned)return owned;if(knownRoots.has(current.pid))return null;if(current.pid===fleetPid)return 'shared';const parent=rows.get(current.ppid);if(!parent||parent.start>current.start)return sharedRoots.has(p.pid)?'shared':null;current=parent;}return null;};
  for(const process of processes){const id=attribution(process);if(!id)continue;const target=id==='shared'?shared:byId.get(id)!;if(target.rssBytes===null)continue;target.rssBytes+=process.rssBytes;target.processes++;
   const old=previous?.rows.get(process.pid),pin=id==='shared'?null:priorPins.get(id),root=roots.find(r=>r.id===id);
   const stable=continuous&&(!root||!!pin&&pin.owner===root.owner&&pin.pid===root.pid&&pin.identity===identity(rows.get(root.pid)!))&&!!old&&identity(old)===identity(process)&&process.cpuMs>=old.cpuMs;
   if(stable)cpu.set(id,(cpu.get(id)??0)+process.cpuMs-old!.cpuMs);else if(continuous&&(!root||!!pin&&pin.owner===root.owner&&pin.pid===root.pid&&pin.identity===identity(rows.get(root.pid)!))&&process.start>=previous!.wall)cpu.set(id,(cpu.get(id)??0)+process.cpuMs);else unknown.add(id);
  }
  for(const row of [...result.map(r=>({id:r.id,row:r})),{id:'shared',row:shared}]){
   const value=(cpu.get(row.id)??0)/(elapsed*logicalCpus)*100;row.row.cpuPercent=continuous&&!unknown.has(row.id)&&row.row.rssBytes!==null&&row.row.processes>0&&Number.isFinite(value)&&value<=101?Math.min(100,value):null;
  }
  return {rows:result,shared,total:roots.length,covered:result.filter(r=>r.rssBytes!==null).length,processRows:processes.length,sampledAt:wall,truncated:false};
 }
}
