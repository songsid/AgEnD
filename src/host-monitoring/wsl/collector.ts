import {createHash} from 'node:crypto';
import {cpus,loadavg} from 'node:os';
import {isAbsolute} from 'node:path';
import type {HostMonitoringProvider,DiskReading,DiskVolume,MonitoringProbe} from '../../host-monitoring.js';
import {MonitorProbeOwner,DISCOVERY_MS,MONITOR_MOUNT_BYTES,readMonitorKernelFile,type NativeMonitorOptions} from '../transport.js';
import {MonitorCpu,interpretMemory,parseMonitorDf,parseMonitorMounts,monitorMountFor,type MonitorMount} from './interpretation.js';
// Constant read-only registry script; output contains a drive letter only, never the registered private path.
export const WSL_BACKING_DRIVE_SCRIPT = String.raw`$ErrorActionPreference='Stop'; $p=$PWD.ProviderPath; $m=[regex]::Match($p,'^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(?:\\|$)',[System.Text.RegularExpressions.RegexOptions]::IgnoreCase); if (!$m.Success) {exit 2}; $n=$m.Groups[1].Value; if (!$n -or $n.Length -gt 128) {exit 2}; $ks=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'); if ($ks.Count -gt 64) {exit 2}; $ms=@($ks | Where-Object {$_.GetValue('DistributionName') -ceq $n}); if ($ms.Count -ne 1) {exit 2}; $b=$ms[0].GetValue('BasePath'); if ($b -match '^(?:\\\\\?\\)?([A-Za-z]):\\') {[Console]::WriteLine($Matches[1].ToUpperInvariant())} else {exit 2}`;
/** Platform-owned collection and interpretation; no sibling-platform imports. */
export class WslHostMonitoring implements HostMonitoringProvider{
  readonly platform='wsl' as const;
  private readonly owner:MonitorProbeOwner;
  private readonly now:()=>number;
  private readonly monotonic:()=>number;
  private readonly cpu=new MonitorCpu();
  private discoveryAt=-Infinity;
  private mounts:MonitorMount[]=[];
  private backing:string|null=null;
  constructor(private readonly options:NativeMonitorOptions){this.now=options.now??Date.now;this.monotonic=options.monotonic??(()=>performance.now());this.owner=new MonitorProbeOwner(options.run,this.monotonic);}
  host():ReturnType<HostMonitoringProvider['host']>{if(this.owner.closed)return{cpu:{value:null},memory:{value:null}};const cpu=this.cpu.sample((this.options.cpus??cpus)(),(this.options.load??loadavg)());return{cpu:{value:cpu,...(cpu.usedPercent===null?{reason:'cpu_baseline_or_reset'}:{})},memory:interpretMemory(this.options.memory())};}
  disks():MonitoringProbe<DiskReading>{return this.owner.probe(async(call,cancelled)=>{
   if(this.monotonic()-this.discoveryAt>=DISCOVERY_MS){this.discoveryAt=this.monotonic();this.mounts=parseMonitorMounts(await(this.options.readMounts??(()=>readMonitorKernelFile('/proc/self/mountinfo',MONITOR_MOUNT_BYTES)))());
    this.backing=null;if(this.options.wslDrive&&/^[A-Z]$/.test(this.options.wslDrive))this.backing=this.options.wslDrive;
    else{const system=this.mounts.find(m=>m.drive==='C'&&m.local);if(system){const answer=await call(system.path.replace(/\/$/,'')+'/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',WSL_BACKING_DRIVE_SCRIPT],undefined,'/');if(answer&&/^[A-Z]\r?\n?$/.test(answer.trim()))this.backing=answer.trim();}}
   }
   const targets:Array<{path:string;role:string;mount?:MonitorMount;drive?:string;}>=[{path:'/',role:'root'},{path:this.options.statePath,role:'state'}];
   const matches=this.mounts.filter(m=>m.drive===this.backing&&m.local);if(matches.length===1)targets.push({path:matches[0].path,role:'wsl-backing',mount:matches[0],drive:this.backing!});
   const volumes:DiskVolume[]=[];for(const target of targets.slice(0,8)){
    const mount=target.mount??monitorMountFor(this.mounts,target.path);const identity=mount?.id??target.role;const reason=!isAbsolute(target.path)||!mount?.local?(mount?'network_filesystem_not_sampled':'filesystem_not_identified'):undefined;
    const reading=reason?null:parseMonitorDf(await call('/bin/df',['-Pk',target.path]));if(cancelled())return null;
    const volume:DiskVolume={id:createHash('sha256').update(identity).digest('hex').slice(0,16),roles:[target.role],totalBytes:reading?.totalBytes??null,availableBytes:reading?.availableBytes??null,usedPercent:reading?.usedPercent??null,sampledAt:reading?this.now():null,...(!reading?{reason:reason??'filesystem_read_failed'}:{}),...(target.drive?{drive:target.drive}:{})};
    const same=volumes.find(v=>v.id===volume.id&&v.totalBytes===volume.totalBytes);if(same&&reading){same.roles.push(target.role);same.availableBytes=Math.min(same.availableBytes!,reading.availableBytes);same.usedPercent=Math.max(same.usedPercent!,reading.usedPercent);same.shared=true;}else volumes.push(volume);
   }
   return{volumes,backingDrive:volumes.some(v=>v.roles.includes('wsl-backing'))?'identified' as const:'unknown' as const,availableDrives:[...new Set(this.mounts.filter(m=>m.drive&&m.local).map(m=>m.drive!))].sort()};
  });}
  stop():Promise<void>{return this.owner.stop();}
}
