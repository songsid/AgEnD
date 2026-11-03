/** Approved native-pane creation. Compensation never retires a replacement launch or deletes a referenced topic. */
import type { FleetConfig, InstanceConfig } from './types.js';
import type { FleetWindowsRuntime } from './fleet-windows-runtime.js';
import type { SettingsExecution } from './settings-transaction.js';
import { nativePaneTopicTarget } from './native-instance-input.js';
type Target=NonNullable<ReturnType<typeof nativePaneTopicTarget>>;
export interface NativePaneCreateHost {
 fleet():FleetConfig|null;
 runtime:FleetWindowsRuntime;
 topic(target:Target):{current():boolean;create(name:string):Promise<number|string>;remove(id:number|string):Promise<void>};
 epoch(name:string):number;
 start(name:string,config:InstanceConfig,current:()=>boolean):Promise<void>;
 close(name:string,config:InstanceConfig,epoch:number):Promise<boolean>;
 routes():void;
 warn(error:unknown):void;
}
export async function createNativePane(host:NativePaneCreateHost,profile:Record<string,unknown>,channelId:string|undefined,authorized:()=>boolean,execution:SettingsExecution){
 const fleet=host.fleet();if(!fleet)throw Error('Fleet configuration is unavailable');
 const target=nativePaneTopicTarget(fleet,channelId),topic=target?host.topic(target):null;
 const current=()=>authorized()&&execution.current()&&host.fleet()===fleet&&(!topic||topic.current());
 const check=()=>{if(!current())throw Error('Native pane creation authority or topic destination changed');};
 check();let topicId:number|string|undefined,created:Awaited<ReturnType<FleetWindowsRuntime['create']>>|undefined,config:InstanceConfig|undefined,epoch:number|undefined;
 try{
  if(topic){topicId=await topic.create(String(profile.name));check();}
  // Complete only after the ordinary persistent Daemon is published, not at the profile commit point.
  created=await host.runtime.create(profile,current,{mutate:effect=>execution.mutate(effect),complete:()=>{}},
   {native_adapter:'pane',...(topicId!==undefined&&target?{topic_id:topicId,channel_id:target.id}:{})});
  config=fleet.instances[created.name];epoch=host.epoch(created.name);check();host.routes();
  await host.start(created.name,config,()=>current()&&fleet.instances[created!.name]===config&&host.epoch(created!.name)===epoch);
  check();if(fleet.instances[created.name]!==config||host.epoch(created.name)!==epoch)throw Error('Native pane creation was superseded');
  execution.complete();return created;
 }catch(error){
  if(created&&config&&epoch!==undefined&&fleet.instances[created.name]===config&&host.fleet()===fleet){
   try{
    if(await host.close(created.name,config,epoch)&&fleet.instances[created.name]===config){
     host.runtime.remove(created.name,()=>host.fleet()===fleet&&fleet.instances[created!.name]===config);
     host.routes();
    }
   }catch(cleanup){host.warn(cleanup);} // Unknown close keeps the profile, config, topic and launch receipt together.
  }
  const referenced=topicId!==undefined&&Object.values(host.fleet()?.instances??{}).some(row=>String(row.topic_id)===String(topicId)&&(row.channel_id==null||row.channel_id===target?.id));
  if(topic&&topicId!==undefined&&!referenced)try{await topic.remove(topicId);}catch(cleanup){host.warn(cleanup);}
  throw error;
 }
}
