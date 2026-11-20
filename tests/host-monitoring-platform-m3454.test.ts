import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonitorCpu, NativeHostMonitoring, MONITOR_OUTPUT_BYTES, parseApfsContainer, parseMonitorDf, parseMonitorMounts, WSL_BACKING_DRIVE_SCRIPT, type MonitorRunner } from '../src/host-monitoring-platform.js';
const linux = '1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 0:2 / /remote rw - nfs server:/data rw\n';
const wsl = linux + '3 1 0:3 / /windows/c rw - 9p C:\\ rw\n4 1 0:4 / /windows/e rw - 9p E:\\ rw\n';
const df = (total=1000,free=600) => `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/example ${total} ${total-free} ${free} 40% /\n`;
const memory = () => ({ level:'unknown' as const, memory:null, sampledAt:null, recovering:false, samples:0, trend:null });
const command = (value:string|null) => ({result:Promise.resolve(value),stopped:Promise.resolve(),kill:vi.fn()});
const flush = async () => { for(let i=0;i<50;i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
describe('bounded host monitoring platform readers', () => {
 it('the exact constant registry query accepts ordinary and extended local BasePath forms only',()=>{
  const pattern=WSL_BACKING_DRIVE_SCRIPT.match(/-match '([^']+)'/)![1],path=new RegExp(pattern);
  expect(path.exec('E:\\Synthetic\\State')?.[1]).toBe('E');
  expect(path.exec('\\\\?\\E:\\Synthetic\\State')?.[1]).toBe('E');
  expect(path.test('\\\\server\\share')).toBe(false);expect(path.test('E:relative')).toBe(false);
 });
 it('validates disk counters and never turns missing/malformed output into zero space', () => {
  expect(parseMonitorDf(df())).toEqual({totalBytes:1024000,availableBytes:614400,usedPercent:40});
  for(const text of [null,'',df().repeat(2),df(100,101),df().replace('1000','999999999999999999999'), 'x'.repeat(MONITOR_OUTPUT_BYTES+1)]) expect(parseMonitorDf(text)).toBeNull();
  expect(parseMonitorDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/example 100 100 -2 102% /\n')?.availableBytes).toBe(0);
 });
 it('uses kernel mounts, honors custom WSL mount roots and excludes network paths', () => {
  const mounts=parseMonitorMounts(wsl);
  expect(mounts.find(m=>m.drive==='E')).toMatchObject({path:'/windows/e',local:true});
  expect(mounts.find(m=>m.path==='/remote')?.local).toBe(false);
  expect(parseMonitorMounts('x'.repeat(MONITOR_OUTPUT_BYTES+1))).toEqual([]);
 });
 it('keeps CPU baseline/reset/hotplug unknown rather than an invented idle percentage', () => {
  const cpu=new MonitorCpu(),rows=(user:number,idle:number)=>[{times:{user,idle,nice:0,sys:0,irq:0}}] as any;
  expect(cpu.sample(rows(10,10),[1,2,3]).usedPercent).toBeNull();
  expect(cpu.sample(rows(20,40),[1,2,3]).usedPercent).toBe(25);
  expect(cpu.sample(rows(1,1),[1,2,3]).usedPercent).toBeNull();
  expect(cpu.sample([],[1,2,3]).usedPercent).toBeNull();
 });
 it('reads memory cache only and refuses network state storage without losing Linux root', async () => {
  const run=vi.fn<MonitorRunner>(()=>command(df())),mem=vi.fn(memory);
  const provider=new NativeHostMonitoring({platform:'linux',statePath:'/remote/state',memory:mem,readMounts:async()=>linux,run});
  expect(run).not.toHaveBeenCalled();expect(mem).not.toHaveBeenCalled();
  expect(provider.host().memory.value).toBeNull();expect(mem).toHaveBeenCalledTimes(1);
  const flight=provider.disks(),reading=await flight.result;await flight.stopped;
  expect(run.mock.calls).toEqual([['/bin/df',['-Pk','/'],undefined]]);
  expect(reading?.volumes.find(v=>v.roles.includes('state'))).toMatchObject({totalBytes:null,reason:'network_filesystem_not_sampled'});
  expect(reading?.volumes.find(v=>v.roles.includes('root'))?.availableBytes).toBe(614400);
  await provider.stop();
 });
 it('resolves only the current registered backing drive and preserves a custom mount root', async () => {
  const run=vi.fn<MonitorRunner>((file)=>command(file.endsWith('.exe')?'E\r\n':df()));
  const provider=new NativeHostMonitoring({platform:'wsl',statePath:'/state',distro:'Synthetic',memory,readMounts:async()=>wsl,run});
  const f=provider.disks(),reading=await f.result;await f.stopped;
  expect(reading?.backingDrive).toBe('identified');expect(reading?.availableDrives).toEqual(['C','E']);
  expect(reading?.volumes.find(v=>v.roles.includes('wsl-backing'))).toMatchObject({drive:'E',availableBytes:614400});
  expect(run.mock.calls[0]).toEqual(['/windows/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',WSL_BACKING_DRIVE_SCRIPT],{AGEND_MONITOR_DISTRO:'Synthetic',WSLENV:'AGEND_MONITOR_DISTRO'}]);
  expect(run.mock.calls.some(c=>c[1].includes('/windows/e'))).toBe(true);
  expect(JSON.stringify(reading)).not.toContain('/state');expect(JSON.stringify(reading)).not.toContain('Synthetic');await provider.stop();
 });
 it('never guesses C as the backing drive when registration is unavailable', async () => {
  const provider=new NativeHostMonitoring({platform:'wsl',statePath:'/state',distro:'Synthetic',memory,readMounts:async()=>wsl,run:file=>command(file.endsWith('.exe')?null:df())});
  const f=provider.disks(),reading=await f.result;await f.stopped;
  expect(reading?.backingDrive).toBe('unknown');expect(reading?.volumes.some(v=>v.roles.includes('wsl-backing'))).toBe(false);await provider.stop();
 });
 it('deduplicates APFS System/Data capacity without summing their shared free space', async () => {
  const run=vi.fn<MonitorRunner>((file,args)=>command(file==='/sbin/mount'?'/dev/disk1s1 on / (apfs, local, read-only)\n/dev/disk1s2 on /state (apfs, local)\n':file==='/usr/sbin/diskutil'?'<plist><key>APFSContainerReference</key><string>disk1</string></plist>':df(1000,args.includes('/state')?500:600)));
  const provider=new NativeHostMonitoring({platform:'darwin',statePath:'/state',memory,run});
  const f=provider.disks(),reading=await f.result;await f.stopped;
  expect(reading?.volumes).toHaveLength(1);expect(reading?.volumes[0]).toMatchObject({roles:['root','state'],shared:true,totalBytes:1024000,availableBytes:512000});
  expect(parseApfsContainer('<key>APFSContainerReference</key><string>disk1</string>'.repeat(2))).toBeNull();await provider.stop();
 });
 it('keeps distinct APFS quota envelopes separate', async () => {
  const provider=new NativeHostMonitoring({platform:'darwin',statePath:'/state',memory,run:(file,args)=>command(file==='/sbin/mount'?'/dev/disk1s1 on / (apfs, local)\n/dev/disk1s2 on /state (apfs, local)\n':file==='/usr/sbin/diskutil'?'<key>APFSContainerReference</key><string>disk1</string>':df(args.includes('/state')?800:1000,200))});
  const f=provider.disks(),reading=await f.result;await f.stopped;expect(reading?.volumes).toHaveLength(2);await provider.stop();
 });
 it('on timeout keeps the physical reservation and cannot start a replacement', async () => {
  vi.useFakeTimers();let closed!:()=>void;
  const physical=new Promise<void>(r=>{closed=r;}),kill=vi.fn(),run=vi.fn<MonitorRunner>(()=>({result:new Promise(()=>{}),stopped:physical,kill}));
  const provider=new NativeHostMonitoring({platform:'linux',statePath:'/state',memory,readMounts:async()=>linux,run});
  const flight=provider.disks();await flush();await vi.advanceTimersByTimeAsync(2000);
  expect(await flight.result).toBeNull();expect(kill).toHaveBeenCalledTimes(1);expect(provider.disks()).toBe(flight);expect(run).toHaveBeenCalledTimes(1);
  let stopped=false;void provider.stop().then(()=>{stopped=true});closed();await flush();
  // An impossible reader whose result never settles must not falsely report physical completion.
  expect(stopped).toBe(false);
 });
});
