import {afterEach,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {s3bRig} from "./helpers/hub-s3b-rig.js";
let rig:Awaited<ReturnType<typeof s3bRig>>|undefined;
afterEach(async()=>{await rig?.close();rig=undefined;});
async function world(){
 let now=Date.parse("2026-11-18T12:00:00Z");const r=rig=await s3bRig({realAudit:true,now:()=>now}),owner=r.addPerson("owner"),link=r.link(randomUUID(),owner,1,["agent-intro-v1"]);
 const e={id:randomUUID(),fleetId:link.fleetId,owner,displayName:"Guide",revision:1,state:"published",dataViewId:"agent",allowedTools:[],policyDigest:"b".repeat(64)};
 await r.http.receive(r.frame("exposure.snapshot",{revision:1,exposures:[e]},link) as never,link);
 const o=await r.signIn("owner");
 const send=(text:string,source="agent",operationId=randomUUID(),l=link,id=e.id)=>r.http.receive({...r.frame("agent.intro" as never,{exposureId:id,revision:1,text,source},l),requestId:operationId} as never,l);
 return {r,o,e,link,send,advance:()=>{now+=86400000;},read:async()=>(await r.call(await r.signIn("owner"),"GET","/hub/v1/exposures")).json.mine[0]};
}
it("a negotiated self-edit is durable, five changes per UTC day, and retries count only once",async()=>{
 const w=await world(),op=randomUUID();
 expect((await w.send("One","agent",op))?.payload).toMatchObject({ok:true,intro:"One",introBy:"agent",changed:true});
 expect((await w.send("One","agent",op))?.payload).toMatchObject({ok:true,intro:"One"});
 for(const text of ["Two","Three","Four","Five"])expect((await w.send(text))?.payload).toMatchObject({ok:true});
 expect((await w.send("Six"))?.payload).toMatchObject({ok:false,code:"limit"});
 expect((await w.read()).intro).toBe("Five");
 w.advance();expect((await w.send("Next day"))?.payload).toMatchObject({ok:true});
 expect((await w.read()).intro).toBe("Next day");
});
it("defaults cannot replace owner or agent edits, empty is an explicit edit, and other Fleets/old peers are refused",async()=>{
 const w=await world();
 await w.r.call(w.o,"PUT",`/hub/v1/exposures/${w.e.id}/intro`,{revision:1,text:"Owner line"});
 expect((await w.send("Default","default"))?.payload).toMatchObject({ok:true,intro:"Owner line",changed:false});
 expect((await w.send(""))?.payload).toMatchObject({ok:true,intro:"",introBy:"agent"});
 expect((await w.send("Default again","default"))?.payload).toMatchObject({ok:true,intro:"",changed:false});
 expect((await w.send("x".repeat(51)))?.payload).toMatchObject({ok:false,code:"invalid"});
 const foreign=w.r.link(randomUUID(),w.link.owner,1,["agent-intro-v1"]);
 expect((await w.send("Forged","agent",randomUUID(),foreign))?.payload).toMatchObject({ok:false,code:"denied"});
 (w.link.features as Set<string>).delete("agent-intro-v1");
 expect((await w.send("Old"))?.payload).toMatchObject({ok:false,code:"unsupported"});
 expect((await w.read()).intro).toBe("");
});
it("shows one persistent owner notice for existing-share defaults, never for private reads or later agent edits",async()=>{
 const w=await world();w.r.db.prepare("INSERT INTO hub_agent_intro_existing VALUES(?)").run(w.e.id);
 expect((await w.r.call(w.o,"GET","/hub/v1/me/intro-notice")).json.notice).toBeNull();
 expect((await w.send("I handle notes.","default"))?.payload).toMatchObject({ok:true,introBy:"default"});
 expect((await w.r.call(w.o,"GET","/hub/v1/me/intro-notice")).json.notice).toEqual({id:"agent-introductions",agents:[{id:w.e.id,name:"Guide"}]});
 const other=await w.r.signIn("admin");expect((await w.r.call(other,"GET","/hub/v1/me/intro-notice")).json.notice).toBeNull();
 expect((await w.r.call(w.o,"DELETE","/hub/v1/me/intro-notice")).status).toBe(200);
 await w.send("A new introduction");await w.send("Default again","default");
 expect((await w.r.call(w.o,"GET","/hub/v1/me/intro-notice")).json.notice).toBeNull();
});
