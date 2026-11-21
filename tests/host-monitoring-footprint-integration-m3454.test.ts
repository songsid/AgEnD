import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {HostHistoryStore} from '../src/host-monitoring-history-store.js';
import {HostMonitoringRuntime} from '../src/host-monitoring-runtime.js';
import {hostHistoryPoints,historyQuery} from '../src/host-monitoring-history-policy.js';
import {disabledHostHealth} from '../src/host-monitoring.js';
import {Daemon} from '../src/daemon.js';import {FleetManager} from '../src/fleet-manager.js';
const id='a'.repeat(16),now=1700000000000;
afterEach(()=>vi.useRealTimers());
describe('footprint integration boundaries',()=>{
 it('enables footprint only for both committed switches, and stops it on shutdown or config failure',()=>{
  const footprint={configure:vi.fn(),snapshot:()=>({enabled:false,status:'off',reading:null}),stop:vi.fn()},flag=vi.fn();let config={enabled:false,agent_footprint:true};let raw:any={monitoring:config};
  const runtime=new HostMonitoringRuntime({footprint:footprint as any,footprintEnabled:flag,supported:()=>true,committed:()=>config,raw:()=>raw,pin(){},factory:()=>({platform:'linux',host:()=>({cpu:{value:null},memory:{value:null}}),disks:()=>({result:Promise.resolve(null),stopped:Promise.resolve(),cancel(){}}),stop:async()=>{}})});
  runtime.start();expect(footprint.configure).toHaveBeenLastCalledWith(false);config={enabled:true,agent_footprint:false};raw={monitoring:config};runtime.apply();expect(footprint.configure).toHaveBeenLastCalledWith(false);
  config={enabled:true,agent_footprint:true};raw={monitoring:config};runtime.apply();expect(footprint.configure).toHaveBeenLastCalledWith(true);raw={monitoring:{enabled:false,agent_footprint:false}};runtime.apply();expect(footprint.configure).toHaveBeenLastCalledWith(false);runtime.stop();expect(flag).toHaveBeenLastCalledWith(false);expect(footprint.stop).toHaveBeenCalledOnce();
 });
 it('does not claim clean Off while a cancelled process flight is still physically draining',()=>{
  const runtime=new HostMonitoringRuntime({footprint:{snapshot:()=>({enabled:false,status:'stopping',reading:null})}as any,supported:()=>true,committed:()=>({enabled:false,agent_footprint:false}),raw:()=>({}),pin(){},factory:()=>{throw Error('not called')}});
  expect(runtime.snapshot().state).toBe('stopping');
 });
 it('reads daemon pane evidence without commands and rejects stale/replaced/paused owners',()=>{
  const daemon:any=Object.create(Daemon.prototype);Object.assign(daemon,{bootId:'one',spawnGeneration:1,launchAttempt:2,launchFenceEpoch:3,tmux:{},footprintEnabled:true});
  Object.defineProperty(daemon,'isPaused',{value:false,writable:true});daemon.footprintPane={pid:20,owner:JSON.stringify(daemon.interactionOwner()),observedAt:Date.now(),pane:daemon.tmux};expect(daemon.hostFootprintRoot().pid).toBe(20);
  daemon.launchFenceEpoch++;expect(daemon.hostFootprintRoot()).toBeNull();daemon.launchFenceEpoch--;daemon.isPaused=true;expect(daemon.hostFootprintRoot()).toBeNull();daemon.isPaused=false;daemon.footprintPane.observedAt=Date.now()-120001;expect(daemon.hostFootprintRoot()).toBeNull();daemon.setHostFootprintEnabled(false);expect(daemon.footprintPane).toBeNull();
 });
 it('projects at most 50 cached agents, preserving total and source cache',()=>{
  const fm:any=Object.create(FleetManager.prototype),rows=Array.from({length:128},(_,i)=>({id:i.toString(16).padStart(16,'0'),rssBytes:i}));fm.hostMonitor={snapshot:()=>structuredClone({...disabledHostHealth(),footprint:{enabled:true,status:'ok',reading:{rows,total:128}}})};fm.lifecycle={daemons:new Map()};
  expect(fm.hostHealthSnapshot().footprint.reading.rows).toHaveLength(50);const last=fm.hostHealthSnapshot(100).footprint.reading;expect(last.rows).toHaveLength(28);expect(last).toMatchObject({total:128,offset:100,hasMore:false});expect(rows).toHaveLength(128);
 });
 it('agent history stores one-minute raw and bounded rollups, and expires earlier than host history',()=>{
  const dir=mkdtempSync(join(tmpdir(),'footprint-history-'));const store=new HostHistoryStore(join(dir,'history.sqlite'));try{
   const point={series:`agent.${id}.rss`,at:now,sourceAt:now,value:1024};store.append([point,{...point,series:'cpu.used',value:10}],now);
   const result=store.query('1h',[point.series,'cpu.used'],now+1);expect(result.step).toBe(60000);expect(result.series.map(s=>s.buckets.filter(b=>b.count).length)).toEqual([1,1]);
   store.append([] ,now+7*3600000);const db=(store as any).db;expect(db.prepare('SELECT count(*) n FROM monitoring_points WHERE resolution=60000').get().n).toBe(0);expect(db.prepare('SELECT count(*) n FROM monitoring_points WHERE resolution=30000').get().n).toBe(1);
   store.append([],now+8*86400000);expect(db.prepare("SELECT count(*) n FROM monitoring_points WHERE series LIKE 'agent.%'").get().n).toBe(0);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('accepts the bounded maximum write batch inside the physical quota and rejects one more point',()=>{
  const dir=mkdtempSync(join(tmpdir(),'footprint-cap-')),store=new HostHistoryStore(join(dir,'history.sqlite'),{maxBytes:1024**2});
  try{const points=Array.from({length:832},(_,i)=>({series:`agent.${(i%128).toString(16).padStart(16,'0')}.${['cpu','rss','managed'][i%3]}`,at:now-Math.floor(i/416)*60000,sourceAt:now,value:i%100}));expect(store.append(points,now).paused).toBe(false);expect(store.stats().bytes).toBeLessThanOrEqual(1024**2);expect(()=>store.append([...points,points[0]],now)).toThrow('history_invalid_points');}
  finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('retains only numeric known agent series when footprint is on; queries remain capped',()=>{
  const health:any={...disabledHostHealth(),enabled:true,state:'sampling',footprint:{enabled:true,status:'ok',reading:{sampledAt:now,rows:[{id,cpuPercent:1,rssBytes:2,managedBytes:3}]}}};
  expect(hostHistoryPoints(health,now).map(p=>p.series)).toEqual(['cpu','rss','managed'].map(k=>`agent.${id}.${k}`));health.footprint.enabled=false;expect(hostHistoryPoints(health,now)).toEqual([]);expect(()=>historyQuery('1h',Array(25).fill(`agent.${id}.rss`),now)).toThrow();
 });
});
