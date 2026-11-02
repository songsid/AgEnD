import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createNativePane,type NativePaneCreateHost} from '../src/native-pane-create.js';
import {parseNativeInstanceCreate,nativePaneTopicTarget} from '../src/native-instance-input.js';
import {FleetWindowsRuntime} from '../src/fleet-windows-runtime.js';import {WindowsAgents} from '../src/windows-agents.js';
import {SettingsExecution} from '../src/settings-transaction.js';import {prepareSettingsEffect} from '../src/settings-effect.js';
import {setConfiguredRuntimeSwitches} from '../src/runtime-switches.js';
const clean:Array<()=>void>=[];afterEach(()=>{for(const fn of clean.splice(0).reverse())fn();setConfiguredRuntimeSwitches({});vi.restoreAllMocks();});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'agend-native-pane-create-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));setConfiguredRuntimeSwitches({windows_cli:true});
 const fleet:any={defaults:{},channels:[{id:'chosen',type:'telegram',group_id:-100123}],instances:{}},save=vi.fn(),emit=vi.fn(),bridge:any={prepareWorkspace:async()=> 'C:\\scratch',start:vi.fn(()=>{throw Error('No exec fallback');}),get:()=>null,hasActiveTask:()=>false};
 const store=new WindowsAgents(root,bridge),runtime=new FleetWindowsRuntime({owner:{dataDir:root},fleet:()=>fleet,save,emit,stopping:()=>false},{store,bridge});let valid=true,world=true,epoch=0;
 const execution=new SettingsExecution({current:()=>valid,snapshot:()=>fleet});clean.push(()=>execution.close());
 const create=vi.fn(async()=>123),remove=vi.fn(async()=>{}),topic=vi.fn(()=>({current:()=>world,create,remove}));
 const host:NativePaneCreateHost={fleet:()=>fleet,runtime,topic,epoch:()=>epoch,start:vi.fn(async(_name,_cfg,current)=>{if(!current())throw Error('stale');}),close:vi.fn(async()=>true),routes:vi.fn(),warn:vi.fn()};
 const profile={name:'Pane',cli:'claude-code',cwd:'C:\\scratch',sandbox:'read-only'};
 return{fleet,store,runtime,save,bridge,execution,host,profile,create,remove,topic,expire:()=>{valid=false;},replaceWorld:()=>{world=false;},advance:()=>{epoch++;}};
}
it('opt-in is closed and exec stays the default without leaking adapter/channel into the provider profile',()=>{
 const base={runtime:'windows',topic_name:'Agent',directory:'C:\\scratch'};
 expect(parseNativeInstanceCreate(base).input.native_adapter).toBeUndefined();expect(parseNativeInstanceCreate({...base,native_adapter:'pane',channel_id:'chosen'}).profile).not.toHaveProperty('native_adapter');
 for(const extra of [{native_adapter:'other'},{native_adapter:'pane',backend:'kiro-cli'},{channel_id:'chosen'},{command:'shell'}])expect(()=>parseNativeInstanceCreate({...base,...extra})).toThrow();
});
it('approval names the adapter and exact effect-owner connection; an exec approval stays web-only',()=>{
 const f=fixture(),body={runtime:'windows',topic_name:'Pane',backend:'codex',native_adapter:'pane'},context={config:f.fleet,classic:{}};
 const effect=prepareSettingsEffect('POST','/ui/instances',body,context).diff!;expect(effect.authority).toEqual({connections:['chosen'],primaryGeneral:false,unknown:false});expect(effect.summary.join('\n')).toContain('pane');expect(effect.summary.join('\n')).toContain('chosen');
 expect(prepareSettingsEffect('POST','/ui/instances',{...body,native_adapter:'exec'},context).diff!.authority?.connections).toEqual([]);
 expect(()=>nativePaneTopicTarget(f.fleet,'missing')).toThrow();expect(nativePaneTopicTarget({instances:{},defaults:{}} as any)).toBeNull();
});
it('the approved topic, adapter and channel commit together before ordinary persistent start',async()=>{
 const f=fixture(),result=await createNativePane(f.host,f.profile,undefined,()=>true,f.execution);
 expect(f.fleet.instances[result.name]).toMatchObject({native_adapter:'pane',topic_id:123,channel_id:'chosen',runtime:'windows'});expect(f.store.get(result.agent.id).fleet_instance).toBe(result.name);expect(f.host.start).toHaveBeenCalledExactlyOnceWith(result.name,f.fleet.instances[result.name],expect.any(Function));expect(f.execution.completed).toBe(true);expect(f.remove).not.toHaveBeenCalled();expect(f.bridge.start).not.toHaveBeenCalled();
});
it('a web-only pane starts without fabricating a topic or connection',async()=>{
 const f=fixture();f.fleet.channels=[]; // Start a new baseline after changing the fixture configuration.
 const execution=new SettingsExecution({current:()=>true,snapshot:()=>f.fleet});clean.push(()=>execution.close());const result=await createNativePane(f.host,f.profile,undefined,()=>true,execution);expect(f.topic).not.toHaveBeenCalled();expect(f.fleet.instances[result.name]).not.toHaveProperty('topic_id');expect(f.host.start).toHaveBeenCalledOnce();
});
it.each(['admin','world'])('a revoked %s during topic allocation compensates through the captured adapter only',async cause=>{
 const f=fixture();f.create.mockImplementation(async()=>{cause==='admin'?f.expire():f.replaceWorld();return 123;});await expect(createNativePane(f.host,f.profile,undefined,()=>true,f.execution)).rejects.toThrow('changed');expect(f.store.list()).toEqual([]);expect(f.fleet.instances).toEqual({});expect(f.remove).toHaveBeenCalledExactlyOnceWith(123);expect(f.host.start).not.toHaveBeenCalled();
});
it('start failure closes the exact owned launch before removing its identity and topic',async()=>{
 const f=fixture();vi.mocked(f.host.start).mockRejectedValue(Error('startup failed'));await expect(createNativePane(f.host,f.profile,undefined,()=>true,f.execution)).rejects.toThrow('startup failed');expect(f.host.close).toHaveBeenCalledOnce();expect(f.store.list()).toEqual([]);expect(f.fleet.instances).toEqual({});expect(f.remove).toHaveBeenCalledOnce();expect(f.execution.completed).toBe(false);
});
it('unconfirmed close retains the entire profile, configuration and referenced topic',async()=>{
 const f=fixture();vi.mocked(f.host.start).mockRejectedValue(Error('startup failed'));vi.mocked(f.host.close).mockResolvedValue(false);await expect(createNativePane(f.host,f.profile,undefined,()=>true,f.execution)).rejects.toThrow();expect(f.store.list()).toHaveLength(1);expect(Object.values(f.fleet.instances)).toHaveLength(1);expect(f.remove).not.toHaveBeenCalled();expect(f.execution.completed).toBe(false);
});
it('a replaced identity is never stopped or undone by a failed creation',async()=>{
 const f=fixture();vi.mocked(f.host.start).mockImplementation(async(name,config)=>{f.fleet.instances[name]={...config,description:'new owner'};f.advance();throw Error('superseded');});await expect(createNativePane(f.host,f.profile,undefined,()=>true,f.execution)).rejects.toThrow();expect(f.host.close).not.toHaveBeenCalled();expect(f.remove).not.toHaveBeenCalled();expect(f.store.list()).toHaveLength(1);
});
it('a second config referencing the allocated topic prevents compensation from deleting it',async()=>{
 const f=fixture();vi.mocked(f.host.start).mockImplementation(async(_name,config)=>{f.fleet.instances.other={...config};throw Error('failed');});await expect(createNativePane(f.host,f.profile,undefined,()=>true,f.execution)).rejects.toThrow();expect(f.remove).not.toHaveBeenCalled();expect(Object.keys(f.fleet.instances)).toEqual(['other']);
});
it('a failed profile save cleans the unreferenced topic and creates no pane',async()=>{
 const f=fixture();f.save.mockImplementationOnce(()=>{throw Error('disk full');});await expect(createNativePane(f.host,f.profile,undefined,()=>true,f.execution)).rejects.toThrow('disk full');expect(f.remove).toHaveBeenCalledOnce();expect(f.store.list()).toEqual([]);expect(f.host.start).not.toHaveBeenCalled();
});
