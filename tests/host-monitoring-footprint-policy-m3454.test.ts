import {describe,it,expect} from 'vitest';
import {FootprintAttribution,parseFootprintProcesses,processCpuMs,processStartTime,type FootprintProcess,type FootprintRoot} from '../src/host-monitoring-footprint-policy.js';
const at=Date.UTC(2026,10,21,15),a='a'.repeat(16),b='b'.repeat(16);
const p=(pid:number,ppid:number,cpuMs=0,start=at-60000):FootprintProcess=>({pid,ppid,cpuMs,start,rssBytes:1024});
const root=(id=a,pid=10,owner='launch-1'):FootprintRoot=>({id,pid,owner,observedAt:at-10000});
describe('bounded numerical process snapshot and attribution',()=>{
 it('parses Linux/macOS CPU times and UTC starts without commands or names',()=>{
  expect(processCpuMs('01:02:03')).toBe(3723000);expect(processCpuMs('2-01:02:03')).toBe(176523000);expect(processCpuMs('12:34.56')).toBe(754560);expect(processCpuMs('00:99:00')).toBeNull();expect(processStartTime('Sat Nov 21 15:00:00 2026')).toBe(at);
  expect(parseFootprintProcesses(' 10 2 120 01:02:03 Sat Nov 21 15:00:00 2026\n')).toEqual([{pid:10,ppid:2,rssBytes:122880,cpuMs:3723000,start:at}]);
 });
 it('refuses malformed/duplicate/overflow inventories rather than attributing a partial table',()=>{
  const row='10 2 120 00:00:01 Sat Nov 21 15:00:00 2026';expect(parseFootprintProcesses(row+'\n'+row)).toBeNull();expect(parseFootprintProcesses(row+' secret command')).toBeNull();expect(parseFootprintProcesses('x'.repeat(512*1024+1))).toBeNull();expect(parseFootprintProcesses(Array.from({length:4097},(_,i)=>(i+1)+' 0 0 00:00:00 Sat Nov 21 15:00:00 2026').join('\n'))).toBeNull();
 });
 it('assigns each descendant to its nearest proven root, with shared overhead separate',()=>{
  const policy=new FootprintAttribution(),rows=[p(2,1),p(10,2),p(11,10),p(20,11),p(21,20),p(30,2),p(40,1)];const sample=policy.sample(rows,[root(),root(b,20)],2,at,0,4);
  expect(sample.rows.map(r=>[r.id,r.rssBytes,r.processes])).toEqual([[a,2048,2],[b,2048,2]]);expect(sample.shared.rssBytes).toBe(2048);expect(sample.covered).toBe(2);expect(sample.rows.every(r=>r.cpuPercent===null)).toBe(true);expect(JSON.stringify(sample)).not.toMatch(/owner|pid|ppid|launch/);
 });
 it('normalizes CPU deltas by monotonic elapsed time and total CPU capacity',()=>{
  const policy=new FootprintAttribution();policy.sample([p(2,1),p(10,2,10000),p(11,10,10000)],[root()],2,at,0,4);
  const next=policy.sample([p(2,1),p(10,2,70000),p(11,10,70000)],[{...root(),observedAt:at+50000}],2,at+60000,60000,4);expect(next.rows[0].cpuPercent).toBe(50);
 });
 it('withdraws evidence for PID reuse, changed owners, missing roots and stale pane observations',()=>{
  const policy=new FootprintAttribution();policy.sample([p(10,2,1000)],[root()],2,at,0,2);
  const reused=policy.sample([p(10,2,2000,at-20000)],[root()],2,at+60000,60000,2);expect(reused.rows[0].rssBytes).toBeNull();
  expect(policy.sample([p(10,2,3000)],[root(a,10,'launch-2')],2,at+60001,60001,2).rows[0].cpuPercent).toBeNull();
  expect(policy.sample([], [root()],2,at+120000,120000,2).rows[0].rssBytes).toBeNull();
  expect(new FootprintAttribution().sample([p(10,2)],[root()],2,at+120001,0,2).rows[0].rssBytes).toBeNull();
 });
 it('refuses a process born after the positive pane observation and cycles/ambiguous roots',()=>{
  const policy=new FootprintAttribution();expect(policy.sample([p(10,2,0,at)],[root()],2,at,0,2).covered).toBe(0);
  const duplicate=policy.sample([p(10,2)],[root(),root(b,10)],2,at,1,2);expect(duplicate.covered).toBe(0);expect(duplicate.rows.every(r=>r.reason==='ambiguous_root')).toBe(true);
 });
 it('resets CPU baselines across gaps and wall clock rollback, and enforces root cap',()=>{
  const policy=new FootprintAttribution();policy.sample([p(10,2)],[root()],2,at,0,2);expect(policy.sample([p(10,2,10)],[root()],2,at-1,60000,2).rows[0].cpuPercent).toBeNull();
  expect(()=>policy.sample([],Array.from({length:129},(_,i)=>root(i.toString(16).padStart(16,'0'),i+2)),2,at,1,2)).toThrow('invalid_footprint_input');
 });
});
it('does not charge an unrelated pane under a shared tmux server to Fleet overhead',()=>{
 const policy=new FootprintAttribution();const reading=policy.sample([p(2,1),p(10,2),p(50,2),p(51,50)],[root()],99,at,0,4);
 expect(reading.shared.processes).toBe(1);expect(reading.rows[0].processes).toBe(1);
});
it('handles the full 128-root / 4096-process inventory without double counting',()=>{
 const roots=Array.from({length:128},(_,i)=>root(i.toString(16).padStart(16,'0'),i+10));
 const rows=[p(2,1),...roots.map(r=>p(r.pid,2)),...Array.from({length:4096-129},(_,i)=>p(i+1000,roots[i%128].pid))];
 const result=new FootprintAttribution().sample(rows,roots,2,at,0,8);expect(result.covered).toBe(128);expect(result.rows.reduce((n,r)=>n+r.processes,0)+result.shared.processes).toBe(4096);expect(result.rows.reduce((n,r)=>n+r.rssBytes!,0)+result.shared.rssBytes!).toBe(4096*1024);
});

it('does not accept a producer observation newer than the snapshot wall time',()=>{
 expect(new FootprintAttribution().sample([p(10,2)],[{...root(),observedAt:at+1}],2,at,0,4).covered).toBe(0);
 expect(new FootprintAttribution().sample([p(10,2)],[{...root(),observedAt:at-1000}],2,at,0,4).covered).toBe(1);
});

it('quarantines unavailable or newly observed agent trees instead of billing them as shared services',()=>{
 const policy=new FootprintAttribution();policy.sample([p(2,1),p(10,2),p(11,10)],[root()],2,at,0,4);
 const replaced=policy.sample([p(2,1),p(10,2,0,at-20000),p(11,10)],[root()],2,at+60000,60000,4);expect(replaced.covered).toBe(0);expect(replaced.shared).toMatchObject({processes:1,rssBytes:1024});
 const pending=new FootprintAttribution().sample([p(2,1),p(10,2),p(11,10),p(20,2),p(21,20)],[root(a,0)],2,at,0,4,[10,20]);expect(pending.shared).toMatchObject({processes:1,rssBytes:1024});
});
