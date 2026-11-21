import {describe,expect,it} from 'vitest';
// @ts-expect-error product UI module
import {chartData,metricState,storageRows,historySeries,displayBytes,sampleCoverage} from '../src/ui/host-health-model.js';
const bucket=(n:number)=>({average:n,min:n,max:n,count:1});
describe('Host health numeric presentation',()=>{
 it('breaks the chart at missing values and retains actual zero',()=>{
  const data=chartData([bucket(0),bucket(90),{...bucket(0),count:0},bucket(5)]);expect(data.segments).toHaveLength(2);expect(data).toMatchObject({min:0,max:90,covered:3,total:4});expect(data.segments[0]).toContain('0.00,100.00');
 });
 it('bounds even damaged chart responses to240 buckets and admits no nonfinite coordinates',()=>{
  const data=chartData([bucket(10),bucket(Infinity),...Array.from({length:500},()=>bucket(20))]);expect(data.total).toBe(240);expect(data.segments.every((s:string)=>!/NaN|Infinity/.test(s))).toBe(true);
 });
 it('stale and unavailable values cannot look healthy just because last-good data remains',()=>{
  expect(metricState({status:'ok',sampledAt:1000},30000,61000)).toBe('stale');expect(metricState({status:'unavailable',sampledAt:1000},30000,1001)).toBe('unavailable');expect(metricState({status:'ok',sampledAt:null},30000,1001)).toBe('stale');
 });
 it('keeps distinct volumes, lowest space first, and never adds shared APFS space',()=>{
  const rows=storageRows({disks:{value:{volumes:[{id:'a'.repeat(16),roles:['root','state'],availableBytes:100,shared:true},{id:'b'.repeat(16),roles:['wsl-backing'],availableBytes:20},{id:'../bad',roles:[],availableBytes:0}]}}});expect(rows.map((x:any)=>x.availableBytes)).toEqual([20,100]);expect(rows[1].shared).toBe(true);expect(historySeries({disks:{value:{volumes:rows}}})).toHaveLength(8);
 });
 it('bounds volumes/series and distinguishes unknown byte counts from zero',()=>{
  const health={disks:{value:{volumes:Array.from({length:40},(_,i)=>({id:i.toString(16).padStart(16,'0'),roles:['state'],availableBytes:i}))}}};expect(storageRows(health)).toHaveLength(8);expect(historySeries(health)).toHaveLength(20);expect(displayBytes(null)).toBe(null);expect(displayBytes(0)).toBe('0 KiB');expect(displayBytes(1024**3)).toBe('1.0 GiB');
 });
 it('coverage includes a missing WSL backing drive instead of reporting full coverage',()=>{
  const h={platform:'wsl',cpu:{status:'ok',sampledAt:1000,value:{usedPercent:10}},memory:{status:'ok',sampledAt:1000,value:{pressure:'unknown',availableBytes:null}},disks:{status:'ok',sampledAt:1000,value:{volumes:[{id:'a'.repeat(16),roles:['state'],availableBytes:100}]}}};expect(sampleCoverage(h,1001)).toEqual({covered:2,total:4});
 });
});
