import {describe,it,expect,vi} from 'vitest';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {interpretMemory as darwin,parseDarwinCompression} from '../src/host-monitoring/darwin/interpretation.js';
import {interpretMemory as linux} from '../src/host-monitoring/linux/interpretation.js';
import {interpretMemory as wsl} from '../src/host-monitoring/wsl/interpretation.js';
import {DarwinHostMonitoring} from '../src/host-monitoring/darwin/collector.js';import {LinuxHostMonitoring} from '../src/host-monitoring/linux/collector.js';import {WslHostMonitoring} from '../src/host-monitoring/wsl/collector.js';
import {parseDarwinAvailable,parseDarwinPressureLevel,parseDarwinSwap} from '../src/darwin-memory.js';
import {readHostMemory} from '../src/host-memory.js';import {MemoryPressure,type MemoryPressureSnapshot} from '../src/memory-pressure.js';
import {hostAlertDefaults} from '../src/host-monitoring-defaults.js';import {HOST_ALERT_DEFAULTS,HostAlertWindow} from '../src/host-monitoring-alert-policy.js';
import {defaultHostAlertSettings,hostAlertRuleFor,readHostAlertSettings,hostAlertSettingsPath,type HostAlertSettings} from '../src/host-monitoring-alert-settings.js';
import {HostMonitoringAlerts} from '../src/host-monitoring-alerts.js';import {emptyHostAlerts} from '../src/host-monitoring-alert-store.js';
import type {MonitoringPlatform} from '../src/host-monitoring.js';
const GiB=1024**3,MiB=1024**2,fixture=(path:string)=>readFileSync(new URL('./fixtures/'+path,import.meta.url),'utf8');
const snapshot=(memory:MemoryPressureSnapshot['memory'],patch:Partial<MemoryPressureSnapshot>={}):MemoryPressureSnapshot=>({level:'critical',memory,sampledAt:1000000,recovering:false,samples:1,trend:null,...patch});
const native=(raw:string)=>{const vm=fixture('darwin-memory/vm-stat-16k.txt');return snapshot({totalBytes:32*GiB,availableBytes:parseDarwinAvailable(vm,32*GiB),availableKind:'available',...parseDarwinSwap(fixture('darwin-memory/swap-16k.txt')),...parseDarwinCompression(vm,32*GiB),darwinPressureLevel:parseDarwinPressureLevel(raw)});};
async function tick(){for(let i=0;i<50;i++)await Promise.resolve();}
describe('separate platform memory interpretation',()=>{
 it.each([[1,'normal'],[2,'elevated'],[4,'critical']]as const)('Mac kernel %i is %s even if admission has a different synthetic level',(level,expected)=>{
  const input=native('kern.memorystatus_vm_pressure_level: '+level+'\n');input.level=expected==='critical'?'normal':'critical';input.recovering=true;const reading=darwin(input).value!;
  expect(reading.pressure).toBe(expected);expect(reading.availableKind).toBe('reclaimable-estimate');expect(reading.details).toMatchObject({kind:'darwin',kernelPressure:level,compressedBytes:470072*16384,storedBytes:2107671*16384});expect(reading.details).not.toHaveProperty('psiSomeAvg60');
 });
 it('unknown Mac alarms remain unknown despite critical admission or low free/swap diagnostics',()=>{const input=native('malformed');input.memory!.availableBytes=0;input.memory!.swapFreeBytes=0;expect(darwin(input).value?.pressure).toBe('unknown');});
 it('compression uses each recorded vm_stat page size; malformed or missing counters are unavailable',()=>{
  expect(parseDarwinCompression(fixture('darwin-memory/vm-stat-4k.txt'),32*GiB)).toEqual({darwinCompressedBytes:293880*4096,darwinStoredBytes:930489*4096});
  expect(parseDarwinCompression('missing',32*GiB)).toEqual({darwinCompressedBytes:null,darwinStoredBytes:null});
  const input=fixture('darwin-memory/vm-stat-16k.txt');expect(parseDarwinCompression(input+'Pages occupied by compressor: 1.\n',32*GiB).darwinCompressedBytes).toBeNull();expect(parseDarwinCompression(input,1).darwinCompressedBytes).toBeNull();
 });
 it('dynamic Mac swap may be unallocated without implying pressure',()=>{const input=native('kern.memorystatus_vm_pressure_level: 1\n');Object.assign(input.memory!,parseDarwinSwap('vm.swapusage: total = 0.00M used = 0.00M free = 0.00M'));expect(darwin(input).value).toMatchObject({pressure:'normal',swapTotalBytes:0,details:{swapUsedBytes:0}});});
 it.each([['linux',linux],['wsl',wsl]]as const)('%s uses the Linux kernel recording and excludes synthetic admission recovery',(kind,interpret)=>{
  const memory=readHostMemory({platform:'linux',includePressure:true,psi:()=>fixture('linux-memory-pressure/wsl2-low-psi.txt'),meminfo:()=>`MemTotal: ${32098*1024} kB\nMemAvailable: ${17351*1024} kB\nSwapTotal: ${8192*1024} kB\nSwapFree: ${330*1024} kB\n`});
  const pressure=new MemoryPressure({platform:'linux',read:()=>memory,now:()=>1000000});const first=pressure.sample();expect(first.level).toBe('normal');const reading=interpret(first).value!;expect(reading.pressure).toBe('normal');expect(reading.availableBytes).toBe(17351*MiB);expect(reading.details).toMatchObject({kind,psiSomeAvg60:0.08,psiFullAvg10:0.02});
  expect(interpret({...first,level:'elevated',recovering:true,signal:'recovery'}).value?.pressure).toBe('normal');expect(interpret({...first,level:'critical',signal:'psi-full'}).value?.pressure).toBe('critical');
  const missing={...memory,linuxPsi:null};expect(interpret(snapshot(missing,{level:'elevated',signal:'available'})).value?.details).toMatchObject({psiSomeAvg60:null,psiFullAvg10:null});expect(interpret(snapshot(null)).value).toBeNull();
 });
 it.each(['darwin','linux','wsl']as const)('%s defaults and explicit/legacy saved memory rules use one precedence rule',platform=>{
  const defaults=hostAlertDefaults(platform);expect(defaults.memory.criticalOnly).toBe(platform==='darwin');expect(hostAlertRuleFor(defaultHostAlertSettings(),'memory','memory',platform).criticalOnly).toBe(platform==='darwin');
  for(const choice of [true,false]){const settings:HostAlertSettings={...defaultHostAlertSettings(),rules:{memory:{...HOST_ALERT_DEFAULTS.memory,criticalOnly:choice}}};expect(hostAlertRuleFor(settings,'memory','memory',platform).criticalOnly).toBe(choice);}
  const legacy:HostAlertSettings={...defaultHostAlertSettings(),rules:{memory:{...HOST_ALERT_DEFAULTS.memory}}};expect(hostAlertRuleFor(legacy,'memory','memory',platform).criticalOnly).toBe(false);expect(legacy.rules.memory).not.toHaveProperty('criticalOnly');
  const w=new HostAlertWindow('memory',hostAlertRuleFor(defaultHostAlertSettings(),'memory','memory',platform));let event;for(let at=0;at<=120000;at+=30000)event=w.observe({sampledAt:at,monotonicAt:at,wallAt:at,value:1})??event;expect(event?.record.level).toBe(platform==='darwin'?undefined:'warning');
 });
 it('reading defaults/legacy sidecars does not materialize or rewrite user preferences',()=>{const dir=mkdtempSync(join(tmpdir(),'platform-rules-'));try{const path=hostAlertSettingsPath(dir),raw=JSON.stringify({...defaultHostAlertSettings(),rules:{memory:HOST_ALERT_DEFAULTS.memory}})+'\n';writeFileSync(path,raw,{mode:0o600});for(const p of ['darwin','linux','wsl']as const){const value=readHostAlertSettings(dir);hostAlertRuleFor(value,'memory','memory',p);hostAlertDefaults(p);expect(readFileSync(path,'utf8')).toBe(raw);}}finally{rmSync(dir,{recursive:true,force:true});}});
 it('a Mac default retires an old warning, while a legacy explicit Mac rule preserves it',async()=>{
  for(const legacy of [false,true]){let document=emptyHostAlerts(),sequence=0;document.active=[{key:'memory',kind:'memory',level:'warning',revision:1,openedAt:1,updatedAt:1,value:1,threshold:1}];const save=vi.fn(async(_:number,next:typeof document)=>({ok:true,value:{sequence:++sequence,document:structuredClone(document=next)}}));const service=new HostMonitoringAlerts({platform:'darwin',now:()=>1000000,persistence:{incidentRead:async()=>({ok:true,value:{sequence,document}}),incidentSave:save},deliver:()=>false});const settings:HostAlertSettings={...defaultHostAlertSettings(),rules:legacy?{memory:{...HOST_ALERT_DEFAULTS.memory}}:{}};service.configure(true,settings);service.ready();await tick();expect(service.snapshot().active).toHaveLength(legacy?1:0);expect(save).toHaveBeenCalledTimes(legacy?0:1);service.stop();}
 });
});
describe('platform ownership and frozen storage compatibility',()=>{
 const disk=JSON.parse(fixture('host-platforms-m3535/disk-legacy-recording.json')).cases;
 const df='Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/example 1000 400 600 40% /\n',mounts='1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 0:3 / /windows/c rw - 9p C:\\ rw\n3 1 0:4 / /windows/e rw - 9p E:\\ rw\n',mac='/dev/disk1s1 on / (apfs, local, read-only)\n/dev/disk1s2 on /synthetic (apfs, local)\n';
 it.each([['darwin',DarwinHostMonitoring],['linux',LinuxHostMonitoring],['wsl',WslHostMonitoring]]as const)('%s keeps disk identities/roles/available space equal to actual legacy recording',async(kind,C)=>{
  const provider=new C({statePath:'/synthetic/state',memory:()=>snapshot(null),now:()=>100000,monotonic:()=>0,readMounts:async()=>mounts,run:(file)=>({result:Promise.resolve(file==='/sbin/mount'?mac:file.endsWith('diskutil')?'<key>APFSContainerReference</key><string>disk9</string>':file.endsWith('.exe')?'E\n':df),stopped:Promise.resolve(),kill(){}})});const flight=provider.disks();expect(await flight.result).toEqual(disk[kind]);await flight.stopped;await provider.stop();
 });
 it('platform modules do not import sibling-platform parsers, interpretation or defaults',()=>{let checked=0;for(const platform of ['darwin','linux','wsl'])for(const file of ['collector','interpretation','defaults']){const source=readFileSync(new URL(`../src/host-monitoring/${platform}/${file}.ts`,import.meta.url),'utf8');for(const other of ['darwin','linux','wsl'].filter(p=>p!==platform))expect(source).not.toMatch(new RegExp(`from ['\"][^'\"]*/${other}/`));checked++;}expect(checked).toBe(9);});
});
