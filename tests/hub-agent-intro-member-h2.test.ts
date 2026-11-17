import {expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {HubMemberAgentIntro} from "../src/hub/member/agent-intro.js";
import {defaultAgentIntro} from "../src/hub/agent-intro-model.js";
import type {HubMemberLink} from "../src/hub/client.js";
it("sends nothing to an old Hub, derives only the first 50 visible characters, and binds the invoking agent",async()=>{
 const local={agent:"guide",id:randomUUID(),revision:1,description:"界".repeat(60)+"\nprivate instructions"};
 const exchange=vi.fn(async(frame:any)=>({type:"agent.intro-result",payload:{ok:true,intro:frame.payload.text,introBy:frame.payload.source,introAt:1,changed:true}}));
 const features=new Set<string>(),link={features,current:()=>true,exchange,linkEpoch:1} as unknown as HubMemberLink;
 const member=new HubMemberAgentIntro({current:()=>true,exposures:()=>[local]});member.connected(link);await member.defaults();expect(exchange).not.toHaveBeenCalled();
 expect(await member.set({agent:"guide",current:()=>true},"Hello",randomUUID())).toEqual({ok:false,code:"unsupported"});
 features.add("agent-intro-v1");member.connected(link);await member.defaults();expect(exchange).toHaveBeenCalledTimes(1);
 expect(exchange.mock.calls[0][0].payload).toEqual({exposureId:local.id,revision:1,text:"界".repeat(50),source:"default"});
 await member.defaults();expect(exchange).toHaveBeenCalledTimes(1);
 expect(await member.set({agent:"other",current:()=>true},"forged",randomUUID())).toEqual({ok:false,code:"denied"});
 expect((await member.set({agent:"guide",current:()=>true},"My own line",randomUUID())).ok).toBe(true);
 expect(exchange.mock.calls[1][0].payload).toMatchObject({exposureId:local.id,text:"My own line",source:"agent"});member.close();
 expect(defaultAgentIntro("👨‍👩‍👧‍👦".repeat(51))).toBe("👨‍👩‍👧‍👦".repeat(50));
});
it("serializes the default burst and discards a result after its caller or exposure retires",async()=>{
 let active=0,max=0,current=true,live=true;const locals=[0,1,2].map(n=>({agent:`agent-${n}`,id:randomUUID(),revision:1,description:"Guide"}));let release:()=>void=()=>{};
 const gate=new Promise<void>(r=>{release=r;});
 const exchange=vi.fn(async(frame:any)=>{active++;max=Math.max(max,active);await gate;active--;return {type:"agent.intro-result",payload:{ok:true,intro:frame.payload.text,introBy:frame.payload.source,introAt:1,changed:true}};});
 const link={features:new Set(["agent-intro-v1"]),current:()=>live,exchange,linkEpoch:1} as unknown as HubMemberLink;
 const member=new HubMemberAgentIntro({current:()=>true,exposures:()=>locals});member.connected(link);const defaults=member.defaults();expect(exchange).toHaveBeenCalledTimes(1);release();await defaults;expect(exchange).toHaveBeenCalledTimes(3);expect(max).toBe(1);
 let reply:(v:any)=>void=()=>{};exchange.mockImplementationOnce(()=>new Promise(r=>{reply=r;}));
 const pending=member.set({agent:locals[0]!.agent,current:()=>current},"late",randomUUID());current=false;
 reply({type:"agent.intro-result",payload:{ok:true,intro:"late",introBy:"agent",introAt:2,changed:true}});expect(await pending).toEqual({ok:false,code:"stale"});live=false;member.close();
});
it("reports a lost RPC outcome as uncertain and never retries an agent edit as a new operation",async()=>{
 const local={agent:"guide",id:randomUUID(),revision:1,description:""},exchange=vi.fn(async(_frame:any)=>{throw Error("lost acknowledgement");});
 const link={features:new Set(["agent-intro-v1"]),current:()=>true,exchange,linkEpoch:1} as unknown as HubMemberLink;
 const member=new HubMemberAgentIntro({current:()=>true,exposures:()=>[local]});member.connected(link);await member.defaults();exchange.mockClear();
 const operationId=randomUUID();expect(await member.set({agent:"guide",current:()=>true},"Own line",operationId)).toEqual({ok:false,code:"uncertain"});
 expect(exchange).toHaveBeenCalledTimes(1);expect(exchange.mock.calls[0]?.[0]).toMatchObject({requestId:operationId,payload:{source:"agent"}});member.close();
});
