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
 expect((await w.r.call(w.o,"GET","/hub/v1/me/intro-notice")).json.notice).toEqual({id:"agent-introductions",batches:[{fleetId:w.link.fleetId,fleet:null,more:false,agents:[{id:w.e.id,name:"Guide"}]}]});
 const other=await w.r.signIn("admin");expect((await w.r.call(other,"GET","/hub/v1/me/intro-notice")).json.notice).toBeNull();
 expect((await w.r.call(w.o,"DELETE","/hub/v1/me/intro-notice")).status).toBe(200);
 await w.send("A new introduction");await w.send("Default again","default");
 expect((await w.r.call(w.o,"GET","/hub/v1/me/intro-notice")).json.notice).toBeNull();
});
it("keeps the daily counter across service recreation and does not rate-limit the owner",async()=>{
 const w=await world();for(let n=0;n<5;n++)await w.send(`Line ${n}`);
 const {HubAgentIntroTool}=await import("../src/hub/agent-intro-tool.js"),{HubCore}=await import("../src/hub/http/core.js");
 const restarted=new HubAgentIntroTool(new HubCore(w.r.httpDeps,w.r.sql));
 expect(restarted.receive({exposureId:w.e.id,revision:1,text:"Six",source:"agent"},w.link,randomUUID())).toMatchObject({ok:false,code:"limit"});
 expect((await w.r.call(w.o,"PUT",`/hub/v1/exposures/${w.e.id}/intro`,{revision:1,text:"Owner override"})).status).toBe(200);
 expect((await w.read()).intro).toBe("Owner override");
});
it("the migration marks only pre-existing Fleet shares without an explicit introduction",async()=>{
 const {default:Database}=await import("better-sqlite3"),{HUB_HTTP_MIGRATIONS}=await import("../src/hub/http/schema.js"),{applyHubMigrations}=await import("../src/hub/db.js");
 const db=new Database(":memory:");try{
  applyHubMigrations(db,HUB_HTTP_MIGRATIONS.filter(m=>m.component!=="s3-agent-intro-tool"));
  const first=randomUUID(),edited=randomUUID();
  for(const id of [first,edited])db.prepare("INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,updated_at) VALUES(?,?,?,'Guide',1,'published','agent','[]',?,1)").run(id,randomUUID(),"example/"+randomUUID(),"b".repeat(64));
  db.prepare("INSERT INTO hub_agent_intros VALUES(?,'','owner',1)").run(edited);
  applyHubMigrations(db,HUB_HTTP_MIGRATIONS);
  expect(db.prepare("SELECT exposure_id FROM hub_agent_intro_existing").all()).toEqual([{exposure_id:first}]);
  expect(db.prepare("SELECT COUNT(*) n FROM hub_agent_intro_notices").get()).toEqual({n:0});
 }finally{db.close();}
});

it("reopens the same notice for a later Fleet, listing only its newly filled agents",async()=>{
 const w=await world();w.r.db.prepare("INSERT INTO hub_agent_intro_existing VALUES(?)").run(w.e.id);await w.send("First default","default");await w.r.call(w.o,"DELETE","/hub/v1/me/intro-notice");
 const link=w.r.link(randomUUID(),w.link.owner,1,["agent-intro-v1"]),e={...w.e,id:randomUUID(),fleetId:link.fleetId,displayName:"Second guide"};
 w.r.store.mutate({requestId:randomUUID(),at:1,actor:{kind:"local-host"},action:"fixture",result:"completed"},state=>{state.fleets.push({id:link.fleetId,owner:link.owner,generation:1,status:"active",credentialHash:"a".repeat(64),label:"Another Fleet"});});
 await w.r.http.receive(w.r.frame("exposure.snapshot",{revision:1,exposures:[e]},link) as never,link);w.r.db.prepare("INSERT INTO hub_agent_intro_existing VALUES(?)").run(e.id);
 await w.send("Later default","default",randomUUID(),link,e.id);
 expect((await w.r.call(w.o,"GET","/hub/v1/me/intro-notice")).json.notice).toEqual({id:"agent-introductions",batches:[{fleetId:link.fleetId,fleet:"Another Fleet",more:true,agents:[{id:e.id,name:"Second guide"}]}]});
 await w.r.call(w.o,"DELETE","/hub/v1/me/intro-notice");await w.send("Repeated default","default",randomUUID(),link,e.id);
 expect((await w.r.call(w.o,"GET","/hub/v1/me/intro-notice")).json.notice).toBeNull();
});
it("backfills a historical registry without personal-agent columns as Fleet shares",async()=>{
 const {default:Database}=await import("better-sqlite3"),{HUB_HTTP_MIGRATIONS}=await import("../src/hub/http/schema.js"),{applyHubMigrations}=await import("../src/hub/db.js");
 const legacy=HUB_HTTP_MIGRATIONS.filter(m=>!m.component.startsWith("s3-personal-")),db=new Database(":memory:");try{
  applyHubMigrations(db,legacy.filter(m=>m.component!=="s3-agent-intro-tool"));
  expect((db.prepare("PRAGMA table_info(hub_exposures)").all() as {name:string}[]).some(c=>c.name==="source_kind")).toBe(false);
  const active=randomUUID(),withdrawn=randomUUID(),edited=randomUUID();
  for(const [id,state] of [[active,"published"],[withdrawn,"withdrawn"],[edited,"published"]])db.prepare("INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,updated_at) VALUES(?,?,?,'Guide',1,?,'agent','[]',?,1)").run(id,randomUUID(),"example/"+randomUUID(),state,"b".repeat(64));
  db.prepare("INSERT INTO hub_agent_intros VALUES(?,'','owner',1)").run(edited);
  applyHubMigrations(db,legacy);
  expect(db.prepare("SELECT exposure_id FROM hub_agent_intro_existing").all()).toEqual([{exposure_id:active}]);
 }finally{db.close();}
});
