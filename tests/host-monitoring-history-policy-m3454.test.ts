import {describe,expect,it} from 'vitest';
import {disabledHostHealth,type HostHealthSnapshot} from '../src/host-monitoring.js';
import {historyBudget,historyQuery,HistoryWatermark,hostHistoryPoints} from '../src/host-monitoring-history-policy.js';
const GiB=1024**3;
function snapshot(state=8*GiB,backing=8*GiB):HostHealthSnapshot {
 const s=disabledHostHealth();s.enabled=true;s.state='sampling';s.platform='wsl';
 s.disks={status:'ok',sampledAt:0,attemptedAt:0,value:{backingDrive:'identified',volumes:[{id:'a'.repeat(16),roles:['state'],totalBytes:20*GiB,availableBytes:state,usedPercent:50,sampledAt:0},{id:'b'.repeat(16),roles:['wsl-backing'],totalBytes:20*GiB,availableBytes:backing,usedPercent:50,sampledAt:0}]}};
 return s;
}
describe('bounded history policy',()=>{
 it.each([1024**2,4*1024**2,64*1024**2])('reserves a whole WAL and bounded sidecars within %d bytes',cap=>{
  const b=historyBudget(cap);expect(b.worstBytes).toBeLessThanOrEqual(cap);expect(b.dbBytes).toBeLessThan(b.lowBytes);expect(b.maxPages).toBeGreaterThan(0);
 });
 it('checks both the state and verified backing volume, never only the Linux free space',()=>{
  const gate=new HistoryWatermark();expect(gate.permit(snapshot(),0).ok).toBe(true);
  expect(gate.permit(snapshot(8*GiB,GiB),1)).toEqual({ok:false,reason:'low_space'});
  expect(new HistoryWatermark().permit(snapshot(GiB,8*GiB),0)).toEqual({ok:false,reason:'low_space'});
  const s=snapshot();s.disks.value!.backingDrive='unknown';expect(new HistoryWatermark().permit(s,0)).toEqual({ok:false,reason:'backing_drive_unknown'});
 });
 it('recovers only after both exceed 4GiB continuously for ten monotonic minutes',()=>{
  const gate=new HistoryWatermark();gate.permit(snapshot(8*GiB,GiB),0);
  expect(gate.permit(snapshot(),1).ok).toBe(false);expect(gate.permit(snapshot(),9*60*1000).ok).toBe(false);
  expect(gate.permit(snapshot(),10*60*1000+1).ok).toBe(true);
  gate.permit(snapshot(GiB),700000);gate.permit(snapshot(),700001);const stale=snapshot();stale.disks.status='stale';gate.permit(stale,800000);
  expect(gate.permit(snapshot(),1400000).ok).toBe(false);expect(gate.permit(snapshot(),2000000).ok).toBe(true);
 });
 it('does not treat unknown/stale readings or the 4GiB boundary as recovered',()=>{
  const gate=new HistoryWatermark();gate.permit(snapshot(GiB),0);expect(gate.permit(snapshot(4*GiB),999999).ok).toBe(false);
  const s=snapshot();s.disks.status='unavailable';expect(gate.permit(s,9999999).ok).toBe(false);
 });
 it('records only valid numeric fields; missing pressure is a gap, not normal/zero',()=>{
  const s=snapshot();s.memory={status:'ok',sampledAt:0,attemptedAt:0,value:{totalBytes:16*GiB,availableBytes:null,pressure:'unknown',availableKind:'unknown',swapTotalBytes:null,swapFreeBytes:null}};
  const points=hostHistoryPoints(s,1000);expect(points).toHaveLength(4);expect(points.every(p=>p.series.startsWith('disk.'))).toBe(true);
  s.enabled=false;expect(hostHistoryPoints(s,1000)).toEqual([]);
 });
 it.each(['1h','24h','7d','30d'])('keeps %s history reads at most240 buckets',range=>{
  const q=historyQuery(range,['cpu.used'],Date.UTC(2026,10,20));expect(q.buckets).toBeLessThanOrEqual(240);
 });
 it.each([['all',['cpu.used']],['1h',[]],['1h',['../file']],['1h',['cpu.used','cpu.used']]])('rejects unsafe/unbounded history queries %j',([range,series])=>{
  expect(()=>historyQuery(range,series,Date.now())).toThrow('invalid_history_query');
 });
});
