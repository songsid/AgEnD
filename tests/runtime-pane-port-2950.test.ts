import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import{tmpdir}from'node:os';import{randomUUID}from'node:crypto';
import {RuntimePanePort,RuntimePaneObservation,RuntimePaneHostPort,type PaneEndpoint}from'../src/runtime-pane-port.js';
import{RuntimePaneHost}from'../src/runtime-pane-host.js';import{RuntimePaneStore}from'../src/runtime-pane-store.js';
import type{RuntimePaneLaunch}from'../src/runtime-pane-protocol.js';import type{RuntimeCoordinatorEvent}from'../src/runtime-coordinator.js';
const clean:Array<()=>void|Promise<void>>=[];afterEach(async()=>{for(const f of clean.splice(0).reverse())await f();vi.restoreAllMocks();});
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'agend-remote-port-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
 let exit:(v:{exitCode:number})=>void=()=>{},online=true;const write=vi.fn();
 const native={pid:55555,write,resize:vi.fn(),pause:vi.fn(),resume:vi.fn(),kill:vi.fn(()=>exit({exitCode:0})),onData:()=>({dispose(){}}),onExit:(f:typeof exit)=>{exit=f;return{dispose(){}};}};
 const spawn=vi.fn(async()=>native),host=new RuntimePaneHost({store:new RuntimePaneStore(join(root,'runner')),bootId:randomUUID(),online:()=>online,maxAgents:()=>4,spawn});clean.push(()=>host.stop());
 const listeners=new Set<(e:RuntimeCoordinatorEvent)=>void>();const endpoint:PaneEndpoint={machineId:randomUUID(),online:()=>online,call:r=>host.request(r),subscribe:f=>{listeners.add(f);return()=>{listeners.delete(f);};}};
 const launch:RuntimePaneLaunch={paneId:randomUUID(),agentId:randomUUID(),instance:'test-中文',cli:'codex',cwd:'C:\\scratch',sandbox:'read-only',columns:80,rows:24};
 const file=join(root,'receipt.json');const make=()=>new RuntimePanePort(endpoint,file,launch);const port=make();await port.open();
 return{host,spawn,native,write,endpoint,port,make,file,launch,offline:()=>{online=false;},emit:(e:RuntimeCoordinatorEvent)=>{for(const f of listeners)f(e);}};
}
it('reconciles a lost response by command digest with no plaintext or second Enter',async()=>{
 const f=await fixture(),call=f.endpoint.call;let lost=false;
 f.endpoint.call=async request=>{const result=await call(request);if(request.action==='input'&&!lost){lost=true;throw Error('lost response');}return result;};
 const secret='PRIVATE_INPUT_CANARY';expect(await f.port.pasteBuffer(secret)).toBe(false);
 expect(readFileSync(f.file,'utf8')).not.toContain(secret);expect(f.write).toHaveBeenCalledExactlyOnceWith(secret);
 const recovered=f.make();expect((await recovered.open()).reattached).toBe(true);expect(f.spawn).toHaveBeenCalledOnce();expect(f.write).toHaveBeenCalledTimes(1);
 expect(await recovered.sendSpecialKey('Enter')).toBe(true);expect(f.write.mock.calls.map(x=>x[0])).toEqual([secret,'\r']);
});
it('holds a prepared write and never converts uncertainty into a replacement or retry',async()=>{
 const f=await fixture();f.write.mockImplementationOnce(()=>{throw Error('native write outcome unknown');});
 expect(await f.port.sendSpecialKey('Enter')).toBe(false);
 await expect(f.make().open()).rejects.toThrow('unconfirmed');expect(f.spawn).toHaveBeenCalledOnce();expect(f.write).toHaveBeenCalledOnce();
 expect(await f.port.sendKeys('again')).toBe(false);expect(f.write).toHaveBeenCalledOnce();
});
it('exposes no remote PID and disconnect is unknown, never a dead pane',async()=>{
 const f=await fixture();expect(await f.port.getPaneStatus()).toEqual({alive:true});
 f.offline();expect(await f.port.getPaneStatus()).toBeNull();await expect(f.port.isWindowAlive()).rejects.toThrow('unconfirmed');expect(f.native.kill).not.toHaveBeenCalled();
});
it('keeps edits closed and pasteText submits exactly once without Enter retry',async()=>{
 const f=await fixture();expect(await f.port.sendKeySequence(['Enter'])).toBe(false);expect(await f.port.deleteBackward(8193)).toBe(false);
 expect(await f.port.sendKeySequence(['C-a','C-k'])).toBe(true);expect(await f.port.deleteBackward(3)).toBe(true);expect(await f.port.pasteText('message')).toBe(true);
 expect(f.write.mock.calls.map(x=>x[0])).toEqual(['\x01\x0b','\x7f\x7f\x7f','message','\r']);
});
it('observation is blind offline and rejects output from another launch',async()=>{
 const f=await fixture(),owned=f.port.ownedSnapshot()!,observation=new RuntimePaneObservation(f.endpoint,()=>f.port.ownedSnapshot(),0);clean.push(()=>observation.stop());observation.start();await observation.registerWindow(owned.paneId);
 f.emit({type:'pane',machineId:f.endpoint.machineId,pane:{...owned,launchId:randomUUID()}});expect(observation.isIdle(owned.paneId)).toBe(false);
 f.emit({type:'pane',machineId:f.endpoint.machineId,pane:owned});expect(observation.isIdle(owned.paneId)).toBe(true);f.emit({type:'machine',machineId:f.endpoint.machineId});expect(observation.isIdle(owned.paneId)).toBe(true);f.offline();expect(observation.isIdle(owned.paneId)).toBe(false);expect(observation.getLastOutputAt(owned.paneId)).toBeUndefined();
});

it('host facade retains handle identity and exposes no remote PID as a local signal target',async()=>{
 const f=await fixture(),host=new RuntimePaneHostPort(f.port,f.endpoint);
 expect(host.bind('ignored','')).toBe(f.port);expect(host.bind('ignored',f.port.getWindowId())).toBe(f.port);
 expect(()=>host.bind('ignored',randomUUID())).toThrow('outside');expect(host.executionHost).toBe('remote');
 expect(await host.getServerPid()).toBeNull();expect(await host.getPanePid()).toBeNull();expect(await host.listPanePids()).toEqual([]);
 expect(await host.listWindows()).toEqual([{id:f.port.getWindowId(),name:f.launch.instance}]);
});
