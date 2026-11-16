/** Actual Hub HTTP/SQLite/content/audit, with an inert Runtime execution port. No native process or provider. */
import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it,vi } from "vitest";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { readRuntimeInfo } from "../src/runtime-build-info.js";
import { HubPersonalOwnerHost } from "../src/hub/personal/owner-host.js";
import { HubPersonalTurns } from "../src/hub/personal/turns.js";
import { HUB_PERSONAL_AGENTS_MIGRATION } from "../src/hub/personal/schema.js";
import { personKeyString } from "../src/hub/identity.js";
import type { RuntimeMachine } from "../src/runtime-protocol.js";
import type { WindowsCliTask } from "../src/windows-cli.js";
import type { HubFleetExposure } from "../src/hub/types.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { createHubGroupAdminInventory } from "../src/hub/group-policy/admin-inventory.js";
import {HUB_ROOM_MENTION_FEEDBACK_CAPABILITY} from "../src/hub/room-mention-feedback-model.js";
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0))await close();vi.restoreAllMocks();});
async function fixture(){
  const r=await s3bRig({realAudit:true});HUB_PERSONAL_AGENTS_MIGRATION.up(r.db);
  const directory=mkdtempSync(join(tmpdir(),"personal-http-")),runtime=new RuntimeCoordinator(directory);
  const tasks=new Map<string,WindowsCliTask>();let reported:RuntimeMachine|null=null,turns!:HubPersonalTurns,owner!:HubPersonalOwnerHost;
  const actualMachine=runtime.machine.bind(runtime);
  vi.spyOn(runtime,"machine").mockImplementation(id=>reported?.id===id?structuredClone(reported):actualMachine(id));
  vi.spyOn(runtime,"task").mockImplementation(id=>tasks.get(id)??null);
  vi.spyOn(runtime,"hasActiveTask").mockImplementation(()=>[...tasks.values()].some(t=>t.status==="running"));
  const calls=vi.spyOn(runtime,"call").mockImplementation(async(_id,operation,payload)=>{
    if(operation!=="run")return {};
    const task=(payload as {task:{requestId:string;prompt:string}}).task;
    expect(payload).toMatchObject({profile:"personal-agent-v1",task:{cwd:"C:\\Shared",sandbox:"read-only"}});
    const value:WindowsCliTask={id:task.requestId,cli:"codex",cwd:"C:\\Shared",sandbox:"read-only",status:"running",startedAt:Date.now(),output:""};tasks.set(value.id,value);return value;
  });
  r.httpDeps.personalAgents=core=>{owner=new HubPersonalOwnerHost(core,runtime);turns=new HubPersonalTurns(core,runtime,owner);return {owner,turns};};
  await r.restartHttp();const admin=await r.signIn("admin"),alex=r.addPerson("alex","Alex"),a=await r.signIn("alex");
  const policy=await r.call(admin,"PUT","/hub/v1/admin/personal-agents",{enabled:true,people:[],teams:[]});expect(policy.status).toBe(200);
  const token=await r.call(admin,"POST","/hub/v1/me/personal-agent/enrollment",{});expect(token.status).toBe(200);
  const joined=runtime.enroll({token:token.json.token,fingerprint:runtime.serverFingerprint(),name:"Personal computer",platform:"win32"});
  reported={...actualMachine(joined.machineId)!,status:"online",runtimeInfo:{...readRuntimeInfo(),capabilities:["exec","personal-agent-v1"]},
    inventory:{home:"C:\\User",personalFolder:"C:\\Shared",probedAt:Date.now(),clis:[{id:"codex",path:"C:\\codex.exe",version:"0.167.0",authenticated:true,runnable:true,
      supports:{execution:true,resume:false,model:true,mcp:false},readOnlySupport:true,permissionNote:"",models:[],personalStatus:"ready"}]}};
  const publication=await r.call(admin,"PUT","/hub/v1/me/personal-agent",{name:"PersonalNotes",description:"Shared notes",cli:"codex",ifRevision:0});expect(publication.status).toBe(200);
  const exposure=publication.json.exposure;
  cleanups.push(async()=>{await r.close();runtime.close();rmSync(directory,{recursive:true});});
  const finish=async(text:string)=>{
    const id=[...tasks.values()].find(t=>t.status==="running")!.id;
    tasks.set(id,{...tasks.get(id)!,status:"completed",outcomeConfirmed:true,answer:text,finishedAt:Date.now()});turns.wake();
    await vi.waitFor(()=>expect(r.db.prepare("SELECT state FROM hub_personal_jobs WHERE id=?").get(id)).toEqual({state:"answered"}));return id;
  };
  const group=async(agents=[exposure.id])=>{const made=await r.call(admin,"POST","/hub/v1/rooms",{name:"Personal room",people:[personKeyString(alex)],agents});expect(made.status).toBe(200);return made.json.room.id as string;};
  return {r,runtime,admin,alex,a,exposure,tasks,calls,finish,group,turns,owner:()=>owner,machine:()=>reported!};
}
describe("personal source through composed Hub HTTP",()=>{
  it("disconnects only the owner's computer and keeps it disconnected after refresh",async()=>{
    const f=await fixture(),id=f.machine().id;
    expect((await f.r.call(f.a,"DELETE","/hub/v1/me/personal-agent",{})).status).toBe(200);
    expect(f.runtime.listMachines().find(m=>m.id===id)?.status).not.toBe("revoked");
    expect((await f.r.call(f.admin,"DELETE","/hub/v1/me/personal-agent",{})).status).toBe(200);
    expect(f.runtime.listMachines().find(m=>m.id===id)?.status).toBe("revoked");
    expect((await f.r.call(f.admin,"GET","/hub/v1/me/personal-agent")).json.computer).toBeNull();
    expect(f.r.db.prepare("SELECT state FROM hub_exposures WHERE id=?").get(f.exposure.id)).toEqual({state:"frozen"});
  });
  it("keeps ordinary catalog reads usable when personal admission is disabled",async()=>{
    const f=await fixture(),grant=await f.r.call(f.admin,"POST","/hub/v1/grants",{exposureId:f.exposure.id,exposureRevision:1,login:"alex",days:2});expect(grant.status).toBe(200);
    expect((await f.r.call(f.admin,"PUT","/hub/v1/admin/personal-agents",{enabled:false,people:[],teams:[]})).status).toBe(200);
    const catalog=await f.r.call(f.a,"GET","/hub/v1/exposures");expect(catalog.status).toBe(200);expect(catalog.json.askable).toEqual([]);
    expect((await f.r.call(f.admin,"GET","/hub/v1/exposures")).status).toBe(200);
  });
  it("includes personal publications in the agent count without inventing a Fleet",async()=>{
    const f=await fixture(),view=await f.r.call(f.admin,"GET","/hub/v1/admin/dashboard");
    expect(view.status).toBe(200);expect(view.json).toMatchObject({sharedAgents:1,fleets:{total:0}});
  });
  it("keeps personal policy inventory bound to its actual source and computer",async()=>{
    const f=await fixture(),input={kind:"exposure" as const,id:f.exposure.id,revision:1};
    const absent=createHubGroupAdminInventory({db:f.r.db,transport:f.r.store,realm:"corp"});expect(absent.current(input)).toBeNull();
    const inventory=createHubGroupAdminInventory({db:f.r.db,transport:f.r.store,realm:"corp",personalSource:e=>f.owner().sourceMaterial(f.r.db,e)});
    const before=inventory.current(input);expect(before?.resource).toEqual({...input,owner:f.r.admin});
    f.machine().generation++;expect(inventory.current(input)?.fingerprint).not.toBe(before?.fingerprint);
    f.r.db.prepare("DELETE FROM hub_personal_computers").run();expect(inventory.current(input)).toBeNull();
  });
  it("serves only the owner's computer and keeps the new routes absent without the factory",async()=>{
    const f=await fixture();expect(f.r.http.features).toContain("personal-agents-v1");
    expect((await f.r.call(f.a,"GET","/hub/v1/me/personal-agent")).json.computer).toBeNull();
    expect((await f.r.call(f.a,"GET","/hub/v1/admin/personal-agents")).status).toBe(403);
    expect((await f.r.call(f.admin,"GET","/hub/v1/me/personal-agent?owner=other")).status).toBe(400);
    delete f.r.httpDeps.personalAgents;await f.r.restartHttp();
    expect(f.r.http.features).not.toContain("personal-agents-v1");expect((await f.r.call(f.admin,"GET","/hub/v1/me/personal-agent")).status).toBe(404);
  });
  it("answers a granted direct question once and binds final text to the real content store",async()=>{
    const f=await fixture(),g=await f.r.call(f.admin,"POST","/hub/v1/grants",{exposureId:f.exposure.id,exposureRevision:1,login:"alex",days:2});expect(g.status).toBe(200);
    const room=await f.r.call(f.a,"POST","/hub/v1/rooms",{exposureId:f.exposure.id,grantId:g.json.grant.id});expect(room.status).toBe(200);
    expect((await f.r.call(f.a,"GET",`/hub/v1/rooms/${room.json.room.id}`)).json.room.agentKind).toBe("personal");
    const path=`/hub/v1/rooms/${room.json.room.id}/messages`,body={text:"What is in the shared notes?",idempotencyKey:randomUUID()};
    const first=await f.r.call(f.a,"POST",path,body),again=await f.r.call(f.a,"POST",path,body);expect(first.status).toBe(200);expect(again.json.id).toBe(first.json.id);
    await vi.waitFor(()=>expect(f.calls).toHaveBeenCalledTimes(1));expect(first.json.receipt.stage).toBe("queued");
    await f.finish("The final direct answer.");const read=await f.r.call(f.a,"GET",path);
    expect(read.status).toBe(200);expect(read.json.messages.find((m:any)=>m.author.kind==="agent").text).toBe("The final direct answer.");
    expect(f.r.db.prepare("SELECT COUNT(*) n FROM hub_personal_jobs").get()).toEqual({n:1});
    expect(f.r.store.read().fleets).toEqual([]);
  });
  it("excludes personal sources from @all, then answers an explicit person mention without forwarding answer mentions",async()=>{
    const f=await fixture(),id=await f.group();
    const detail=await f.r.call(f.a,"GET",`/hub/v1/rooms/${id}`);expect(detail.json.members.find((m:any)=>m.id===f.exposure.id).agentKind).toBe("personal");
    const all=await f.r.call(f.a,"POST",`/hub/v1/rooms/${id}/messages`,{text:"Everyone?",mentions:["all"],idempotencyKey:randomUUID()});expect(all.status).toBe(200);expect(all.json.ask).toBeUndefined();
    expect(f.r.db.prepare("SELECT COUNT(*) n FROM hub_personal_jobs").get()).toEqual({n:0});
    const ask=await f.r.call(f.a,"POST",`/hub/v1/rooms/${id}/messages`,{text:"@PersonalNotes please read",mentions:[f.exposure.id],idempotencyKey:randomUUID()});expect(ask.status).toBe(200);
    await vi.waitFor(()=>expect(f.calls).toHaveBeenCalledTimes(1));
    const during=await f.r.call(f.a,"GET",`/hub/v1/rooms/${id}/messages`);expect(during.json.messages.find((m:any)=>m.id===ask.json.id).ask.working).toBe(1);
    await f.finish("Answer mentioning @PersonalNotes and @all as ordinary text.");
    const after=await f.r.call(f.a,"GET",`/hub/v1/rooms/${id}/messages`),answer=after.json.messages.find((m:any)=>m.answerTo===ask.json.id);
    expect(answer).toMatchObject({stage:"answered",text:"Answer mentioning @PersonalNotes and @all as ordinary text."});expect(answer.mentions).toEqual([]);
    expect(f.r.db.prepare("SELECT COUNT(*) n FROM hub_room_deliveries").get()).toEqual({n:1});expect(f.calls).toHaveBeenCalledTimes(1);
  });
  it("does not spend a personal owner's quota for an autonomous Fleet mention, while verified via remains a person root",async()=>{
    const f=await fixture(),fleetId=randomUUID(),link=f.r.link(fleetId,f.r.admin,1,["welcome-caps-v1","room-ask-v1","room-post-v1",HUB_ROOM_MENTION_FEEDBACK_CAPABILITY]);
    const e:HubFleetExposure={id:randomUUID(),fleetId,owner:f.r.admin,displayName:"FleetNotes",revision:1,state:"published",dataViewId:"fixture",allowedTools:[],policyDigest:"a".repeat(64)};
    await f.r.http.receive(f.r.frame("exposure.snapshot",{revision:1,exposures:[e]},link) as never,link);const room=await f.group([f.exposure.id,e.id]);
    const post=async(extra:object={})=>f.r.http.receive(f.r.frame("room.post",{exposureId:e.id,room,text:"Ask @PersonalNotes please",idempotencyKey:randomUUID(),...extra},link) as never,link);
    const key=randomUUID(),plain=await post({idempotencyKey:key});expect(plain?.payload).toMatchObject({ok:true});expect(plain?.payload).not.toHaveProperty("mentionRefusals");
    const extended=await post({idempotencyKey:key,mentionFeedback:true});expect(extended?.payload).toMatchObject({ok:true,messageId:(plain?.payload as {messageId:string}).messageId,
      mentionRefusals:{refusals:[{code:"personal-people-only",name:"PersonalNotes"}]}});
    expect(f.r.db.prepare("SELECT COUNT(*) n FROM hub_room_deliveries").get()).toEqual({n:0});expect(f.calls).not.toHaveBeenCalled();
    expect((await post({text:"@all please",onBehalfOf:{receiptId:`hmsg-${randomUUID()}`}}))?.payload).toMatchObject({ok:true});
    expect(f.r.db.prepare("SELECT COUNT(*) n FROM hub_personal_jobs").get()).toEqual({n:0});
    expect((await post({onBehalfOf:{receiptId:`hmsg-${randomUUID()}`}}))?.payload).toMatchObject({ok:true});
    await vi.waitFor(()=>expect(f.calls).toHaveBeenCalledTimes(1));expect(f.r.db.prepare("SELECT on_behalf FROM hub_room_deliveries").get()).toEqual({on_behalf:1});
    await f.finish("The manager's answer.");
  });
  it("returns answer refusals only after explicit opt-in, retaining the original ACK and frozen answer",async()=>{
    const f=await fixture(),fleetId=randomUUID(),link=f.r.link(fleetId,f.r.admin,1,["welcome-caps-v1","room-ask-v1",HUB_ROOM_MENTION_FEEDBACK_CAPABILITY]);
    const e:HubFleetExposure={id:randomUUID(),fleetId,owner:f.r.admin,displayName:"FleetNotes",revision:1,state:"published",dataViewId:"fixture",allowedTools:[],policyDigest:"a".repeat(64)};
    await f.r.http.receive(f.r.frame("exposure.snapshot",{revision:1,exposures:[e]},link) as never,link);const room=await f.group([e.id,f.exposure.id]);
    const parent=await f.r.call(f.a,"POST",`/hub/v1/rooms/${room}/messages`,{text:"Ask FleetNotes",mentions:[e.id],idempotencyKey:randomUUID()});expect(parent.status).toBe(200);
    await vi.waitFor(()=>expect(f.r.sent.filter(s=>s.frame.type==="room.ask")).toHaveLength(1));const ask=f.r.sent.find(s=>s.frame.type==="room.ask")!.frame.payload as {messageId:string};
    const body={messageId:ask.messageId,roomId:room,exposureId:e.id,answerId:randomUUID(),text:"@PersonalNotes please read"};
    const plain=await f.r.http.receive(f.r.frame("room.answer",body,link) as never,link);expect(plain?.payload).toEqual({messageId:body.messageId,answerId:body.answerId});
    const extended=await f.r.http.receive(f.r.frame("room.answer",{...body,mentionFeedback:true},link) as never,link);
    expect(extended?.payload).toMatchObject({messageId:body.messageId,answerId:body.answerId,mentionRefusals:{refusals:[{code:"personal-people-only",name:"PersonalNotes"}]}});
    expect(f.r.db.prepare("SELECT COUNT(*) n FROM hub_personal_jobs").get()).toEqual({n:0});expect(f.r.db.prepare("SELECT COUNT(*) n FROM hub_room_deliveries").get()).toEqual({n:1});
    const messages=await f.r.call(f.a,"GET",`/hub/v1/rooms/${room}/messages`);expect(messages.json.messages.find((m:any)=>m.answerTo===parent.json.id).text).toBe(body.text);
  });
});
