import {randomUUID} from "node:crypto";
import {defaultAgentIntro,HUB_AGENT_INTRO_CAPABILITY,agentIntroResultSchema,type HubAgentIntro,type HubAgentIntroResult} from "../agent-intro-model.js";
import type {HubMemberLink} from "../client.js";
import type {RoomCaller} from "./room-post.js";
export interface AgentIntroPort {set(caller:RoomCaller,text:string,operationId:string):Promise<HubAgentIntroResult>}
export interface IntroExposure {agent:string;id:string;revision:number;description:string}
export class HubMemberAgentIntro implements AgentIntroPort {
 private link:HubMemberLink|null=null;
 private attempted=new Set<string>();
 private flushing:Promise<void>|null=null;
 constructor(private options:{current():boolean;exposures():IntroExposure[]}){}
 connected(link:HubMemberLink|null){this.link=link;this.attempted.clear();if(link)void this.defaults();}
 private current(link:HubMemberLink,local:IntroExposure,caller?:RoomCaller){return this.options.current()&&this.link===link&&link.current()&&(!caller||caller.current())&&this.options.exposures().some(e=>e.id===local.id&&e.revision===local.revision&&e.agent===local.agent);}
 private async send(link:HubMemberLink,local:IntroExposure,text:string,source:"agent"|"default",operationId:string,caller?:RoomCaller):Promise<HubAgentIntroResult>{
  if(!link.features.has(HUB_AGENT_INTRO_CAPABILITY))return {ok:false,code:"unsupported"};
  if(!this.current(link,local,caller))return {ok:false,code:"stale"};
  const payload:HubAgentIntro={exposureId:local.id,revision:local.revision,text,source};
  try{const result=await link.exchange({v:1,type:"agent.intro",requestId:operationId,linkEpoch:link.linkEpoch,payload},"agent.intro-result");
   if(!this.current(link,local,caller))return {ok:false,code:"stale"};
   return result.type==="agent.intro-result"?agentIntroResultSchema.parse(result.payload):{ok:false,code:"invalid"};
  }catch{return {ok:false,code:"unavailable"};}
 }
 async set(caller:RoomCaller,text:string,operationId:string):Promise<HubAgentIntroResult>{
  const local=this.options.exposures().find(e=>e.agent===caller.agent),link=this.link;
  if(!link)return {ok:false,code:"unavailable"};
  if(!link.features.has(HUB_AGENT_INTRO_CAPABILITY))return {ok:false,code:"unsupported"};
  if(!local||!caller.current())return {ok:false,code:"denied"};
  return this.send(link,local,text,"agent",operationId,caller);
 }
 defaults():Promise<void>{
  if(this.flushing)return this.flushing;
  const link=this.link;if(!link?.features.has(HUB_AGENT_INTRO_CAPABILITY)||!this.options.current())return Promise.resolve();
  this.flushing=(async()=>{
   while(this.link===link&&link.current()&&this.options.current()){
    const local=this.options.exposures().find(e=>!this.attempted.has(`${e.id}:${e.revision}`));if(!local)return;
    const key=`${local.id}:${local.revision}`;this.attempted.add(key);
    const result=await this.send(link,local,defaultAgentIntro(local.description),"default",randomUUID());
    if(!result.ok){if(this.link===link)this.attempted.delete(key);return;}
   }
  })().finally(()=>{this.flushing=null;if(this.link&&this.link!==link)void this.defaults();});
  return this.flushing;
 }
 close(){this.link=null;this.attempted.clear();}
}
