import {describe,it,expect} from 'vitest';
import {linuxClockTicks,linuxStartTicks,bindLinuxRootIdentities,type IdentityRead} from '../src/host-monitoring-process-identity.js';
import {FootprintAttribution,type FootprintProcess} from '../src/host-monitoring-footprint-policy.js';
const aux=(width=8,big=false)=>{const b=Buffer.alloc(width*4);const write=(value:number,at:number)=>width===8?big?b.writeBigUInt64BE(BigInt(value),at):b.writeBigUInt64LE(BigInt(value),at):big?b.writeUInt32BE(value,at):b.writeUInt32LE(value,at);write(17,0);write(100,width);return b;};
const stat=(pid:number,ppid=2,ticks=5000)=>Buffer.from(`${pid} (name ) with space) S ${ppid} `+Array(17).fill('0').join(' ')+` ${ticks} 0 0\n`);
const id='a'.repeat(16),boot=1700000000,wall=(boot+100)*1000,root={id,pid:10,owner:'current-launch',observedAt:wall-10000};
const row=(start=(boot+50)*1000,identity?:number):FootprintProcess=>({pid:10,ppid:2,start,identity,cpuMs:0,rssBytes:1024});
describe('stable Linux root start identity',()=>{
 it.each([[8,false],[8,true],[4,false],[4,true]]as const)('reads AT_CLKTCK from bounded native auxv (%d, %s)',(width,big)=>{expect(linuxClockTicks(aux(width,big),width,big)).toBe(100);expect(linuxClockTicks(Buffer.alloc(8193),width,big)).toBeNull();expect(linuxClockTicks(Buffer.alloc(3),width,big)).toBeNull();});
 it('parses only exact numeric pid/parent/start ticks and ignores process-name content',()=>{expect(linuxStartTicks(stat(10),10,2)).toBe(5000);expect(linuxStartTicks(stat(11),10,2)).toBeNull();expect(linuxStartTicks(stat(10,3),10,2)).toBeNull();expect(linuxStartTicks(Buffer.alloc(4097),10,2)).toBeNull();});
 it('survives the observed one-second epoch presentation change, but still rejects a replaced kernel identity',()=>{
  const policy=new FootprintAttribution();policy.sample([row(undefined,5000)],[root],99,wall,0,4);
  const changed=policy.sample([{...row((boot+50)*1000-1000,5000),cpuMs:1000}],[{...root,observedAt:wall+50000}],99,wall+60000,60000,4);
  expect(changed.covered).toBe(1);expect(changed.rows[0].rssBytes).toBe(1024);expect(changed.rows[0].cpuPercent).toBeCloseTo(1000/240000*100);
  expect(policy.sample([row((boot+50)*1000-1000,6000)],[{...root,observedAt:wall+110000}],99,wall+120000,120000,4).covered).toBe(0);
 });
 it('binds only exact selected roots; a missing/malformed global or per-root source fails closed',async()=>{
  const paths:string[]=[],read:IdentityRead=async(path,limit)=>{paths.push(path);expect(limit).toBeLessThanOrEqual(65536);return path==='/proc/self/auxv'?aux():path==='/proc/stat'?Buffer.from(`btime ${boot}\n`):path==='/proc/10/stat'?stat(10):null;};
  const processes=[row()];expect(await bindLinuxRootIdentities(processes,[root],()=>true,read)).toEqual(new Set());expect(processes[0]).toMatchObject({identity:5000,birth:(boot+51)*1000+10});expect(paths.sort()).toEqual(['/proc/10/stat','/proc/self/auxv','/proc/stat'].sort());
  expect(await bindLinuxRootIdentities([row()],[root],()=>true,async()=>null)).toEqual(new Set([10]));
  expect(await bindLinuxRootIdentities([row()],[root],()=>true,async path=>path==='/proc/self/auxv'?aux():path==='/proc/stat'?Buffer.from(`btime ${boot}\n`):stat(10,3))).toEqual(new Set([10]));
 });
 it('keeps the ps presentation consistent for tree ancestry while using kernel birth for the age fence',async()=>{
  const raw=(boot+49)*1000,processes=[row(raw),{...row(raw),pid:11,ppid:10}];
  const blocked=await bindLinuxRootIdentities(processes,[root],()=>true,async path=>path==='/proc/self/auxv'?aux():path==='/proc/stat'?Buffer.from(`btime ${boot}\n`):stat(10));
  expect(blocked.size).toBe(0);expect(processes[0]).toMatchObject({start:raw,birth:(boot+51)*1000+10,identity:5000});
  const sample=new FootprintAttribution().sample(processes,[root],99,wall,0,4);expect(sample.rows[0]).toMatchObject({processes:2,rssBytes:2048});
 });
 it('bounds reads to128 roots/eight active reads and stops queuing after cancellation',async()=>{
  let active=0,peak=0,calls=0;const roots=Array.from({length:128},(_,i)=>({...root,id:i.toString(16).padStart(16,'0'),pid:i+10})),rows=roots.map(r=>({...row(),pid:r.pid}));
  await bindLinuxRootIdentities(rows,roots,()=>true,async path=>{if(path==='/proc/self/auxv')return aux();if(path==='/proc/stat')return Buffer.from(`btime ${boot}\n`);active++;calls++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,1));active--;return stat(Number(path.split('/')[2]));});expect(calls).toBe(128);expect(peak).toBeLessThanOrEqual(8);
  calls=0;await bindLinuxRootIdentities(rows,roots,()=>calls<4,async path=>{if(path==='/proc/self/auxv')return aux();if(path==='/proc/stat')return Buffer.from(`btime ${boot}\n`);calls++;return stat(Number(path.split('/')[2]));});expect(calls).toBeLessThanOrEqual(4);
 });
});

it('does not use an old ps presentation to approve a kernel birth newer than the positive observation',()=>{
 const process={...row((boot+10)*1000,5000),birth:wall};expect(new FootprintAttribution().sample([process],[root],99,wall,0,4).covered).toBe(0);
});

it('uses a conservative birth ceiling when boot seconds and start ticks both discard fractions',async()=>{
 const processes=[row((boot+50)*1000)],observation=(boot+51)*1000+500;
 await bindLinuxRootIdentities(processes,[root],()=>true,async path=>path==='/proc/self/auxv'?aux():path==='/proc/stat'?Buffer.from(`btime ${boot}\n`):stat(10,2,5090));
 // Actual birth may be boot+51.8 seconds although its whole-second presentation was boot+50.
 const reading=new FootprintAttribution().sample(processes,[{...root,observedAt:observation}],99,observation+10000,0,4);expect(reading.covered).toBe(0);
});
