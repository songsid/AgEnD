import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it,vi } from "vitest";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { readRuntimeInfo } from "../src/runtime-build-info.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubPersonalOwnerHost } from "../src/hub/personal/owner-host.js";
import { HubPersonalTurns } from "../src/hub/personal/turns.js";
import { HUB_PERSONAL_AGENTS_MIGRATION } from "../src/hub/personal/schema.js";
import { personKeyString } from "../src/hub/identity.js";
import { HubProtocolError } from "../src/hub/validation.js";
import type { PersonalQuestionAdapter } from "../src/hub/personal/types.js";
import type { HubRequestContext,PersonKey } from "../src/hub/types.js";
import type { WindowsCliTask } from "../src/windows-cli.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const c of cleanups.splice(0))await c();vi.restoreAllMocks();});
async function drain(){for(let n=0;n<30;n++)await Promise.resolve();}
async function fixture(){
  let now=100_000;const r=await s3bRig({realAudit:true,now:()=>now});HUB_PERSONAL_AGENTS_MIGRATION.up(r.db);
  const home=mkdtempSync(join(tmpdir(),"personal-turns-")),runtime=new RuntimeCoordinator(home),core=new HubCore(r.httpDeps,r.sql),owner=new HubPersonalOwnerHost(core,runtime);
  const person=r.addPerson("alex"),ctx=(key:PersonKey):HubRequestContext=>({requestId:randomUUID(),isCurrent:()=>true,current:async()=>({kind:"directory",person:key,sessionId:"fixture"}),
    requirePerson:async()=>key,requireAdmin:async()=>({kind:"directory",person:r.admin,sessionId:"fixture"})});
  await owner.settings(ctx(r.admin),{enabled:true,people:[personKeyString(person)],teams:[]});
  const token=await owner.enrollment(ctx(person)),joined=runtime.enroll({token:token.token,fingerprint:runtime.serverFingerprint(),name:"Alex PC",platform:"win32"});
  const machine={...runtime.machine(joined.machineId)!,status:"online" as "online"|"offline",runtimeInfo:{...readRuntimeInfo(),capabilities:["exec","personal-agent-v1"]},
    inventory:{home:"C:\\User",personalFolder:"C:\\Shared",probedAt:1,clis:[{id:"codex" as const,path:"C:\\codex.exe",version:"0.167.0",authenticated:true,runnable:true,
      supports:{execution:true,resume:false,model:true,mcp:false},readOnlySupport:true,permissionNote:"",models:[],personalStatus:"ready" as const}]}};
  vi.spyOn(runtime,"machine").mockImplementation(id=>id===machine.id?structuredClone(machine):null);
  const e=await owner.publish(ctx(person),{name:"Notes",description:"",cli:"codex",ifRevision:0});
  const grant=randomUUID(),room=randomUUID(),key=personKeyString(person);
  r.db.prepare("INSERT INTO hub_grants(id,revision,owner,exposure_id,exposure_revision,approved_by,approved_at,subject,permissions,starts_at,expires_at,state) VALUES(?,1,?,?,1,?,0,?,'[\"ask\",\"read-own-room\"]',0,99999999,'active')").run(grant,key,e.id,key,key);
  r.db.prepare("INSERT INTO hub_rooms VALUES(?,?,?,?,?,'active',0)").run(room,key,e.id,key,grant);
  const tasks=new Map<string,WindowsCliTask>();
  vi.spyOn(runtime,"task").mockImplementation(id=>tasks.get(id)??null);
  vi.spyOn(runtime,"hasActiveTask").mockImplementation(()=>[...tasks.values()].some(t=>!["completed","failed","cancelled"].includes(t.status)||t.outcomeConfirmed===false));
  const call=vi.spyOn(runtime,"call").mockImplementation(async(_id,operation,payload)=>{
    if(operation!=="run")return {};
    const task=(payload as {task:{requestId:string}}).task;
    expect(r.db.prepare("SELECT state FROM hub_personal_jobs WHERE id=?").get(task.requestId)).toEqual({state:"working"});
    const result:WindowsCliTask={id:task.requestId,cli:"codex",cwd:"C:\\Shared",sandbox:"read-only",status:"running",startedAt:now,output:""};tasks.set(result.id,result);return result;
  });
  let allowed=true;const changed=vi.fn();
  const adapter:PersonalQuestionAdapter={prepare:async()=>({prompt:"Read the shared notes.",permit:{assertCurrent(){if(!allowed)throw new HubProtocolError("revoked");}}}),
    settle(db,tx,job,result){const ref="text" in result?r.httpDeps.content.put(tx,{answer:result.text}):null;
      db.prepare("UPDATE hub_messages SET stage=?,answer_ref=? WHERE id=?").run("text" in result?"answered":"failed",ref,job.id);
      core.audit(tx,{requestId:job.id,actor:{kind:"local-host"},action:"personal.test-settle",result:"completed",...(ref?{contentRef:ref}:{})});},changed};
  let turns=new HubPersonalTurns(core,runtime,owner);
  const enqueue=()=>{const id=randomUUID();r.db.prepare("INSERT INTO hub_messages(id,room_id,idempotency_key,sequence,fleet_id,exposure_id,exposure_revision,grant_id,grant_revision,asker,owner,content_digest,question_ref,stage,stage_at,created_at,expires_at) VALUES(?,?,?,(SELECT COUNT(*)+1 FROM hub_messages),NULL,?,1,?,1,?,?,'digest','test','queued',0,0,99999999)").run(id,room,randomUUID(),e.id,grant,key,key);
    core.atomic(db=>turns.enqueue(db,e,{direct:id}));return id;};
  const start=()=>turns.start({direct:adapter,room:adapter});
  const wake=async()=>{turns.wake();await drain();};
  cleanups.push(async()=>{await turns.close();owner.close();runtime.close();await r.close();rmSync(home,{recursive:true});});
  return {r,runtime,core,owner,e,machine,tasks,call,enqueue,start,wake,changed,row:(id:string)=>r.db.prepare("SELECT * FROM hub_personal_jobs WHERE id=?").get(id),
    deny:()=>{allowed=false;},advance:(ms:number)=>{now+=ms;},restart:async()=>{await turns.close();turns=new HubPersonalTurns(core,runtime,owner);start();await drain();}};
}
describe("Hub personal one-shot ownership",()=>{
  it("expires a queued question while its computer stays offline",async()=>{
    const f=await fixture();f.machine.status="offline";const id=f.enqueue();f.start();await drain();f.advance(24*60*60_000);await f.wake();
    expect(f.row(id)).toMatchObject({state:"failed",reason:"expired"});expect(f.call).not.toHaveBeenCalled();
  });
  it("cancels an already running turn when the owner disables personal agents",async()=>{
    const f=await fixture(),id=f.enqueue();f.start();await drain();
    f.r.db.prepare("UPDATE hub_personal_settings SET enabled=0").run();await f.wake();
    expect(f.row(id)).toMatchObject({state:"failed",reason:"revoked"});
    expect(f.call).toHaveBeenLastCalledWith(f.machine.id,"cancel",{runId:id});
  });
  it("claims durably, treats the ACK as running, and runs one job per computer",async()=>{
    const f=await fixture(),a=f.enqueue(),b=f.enqueue();f.start();await drain();
    expect(f.call).toHaveBeenCalledTimes(1);expect(f.row(a)).toMatchObject({state:"working"});expect(f.row(b)).toMatchObject({state:"queued"});
    f.tasks.set(a,{...f.tasks.get(a)!,status:"completed",outcomeConfirmed:true,answer:"Final answer."});await f.wake();
    expect(f.row(a)).toMatchObject({state:"answered"});expect(f.r.httpDeps.content.get((f.r.db.prepare("SELECT answer_ref FROM hub_messages WHERE id=?").get(a) as {answer_ref:string}).answer_ref)?.answer).toBe("Final answer.");
    await f.wake();expect(f.call).toHaveBeenCalledTimes(2);expect((f.call.mock.calls[0][2] as {task:object})).toMatchObject({profile:"personal-agent-v1",task:{requestId:a,cwd:"C:\\Shared",sandbox:"read-only"}});
  });
  it("holds offline questions and never replays a claimed turn after restart",async()=>{
    const f=await fixture();f.machine.status="offline";const id=f.enqueue();f.start();await drain();expect(f.call).not.toHaveBeenCalled();
    f.machine.status="online";await f.wake();expect(f.call).toHaveBeenCalledTimes(1);
    await f.restart();expect(f.row(id)).toMatchObject({state:"failed",reason:"interrupted"});expect(f.call).toHaveBeenLastCalledWith(f.machine.id,"cancel",{runId:id});
    await f.wake();expect(f.call.mock.calls.filter(([,operation])=>operation==="run")).toHaveLength(1);
  });
  it.each(["authority","generation","revision"] as const)("does not disclose a late successful answer after %s changes",async change=>{
    const f=await fixture(),id=f.enqueue();f.start();await drain();
    f.tasks.set(id,{...f.tasks.get(id)!,status:"completed",outcomeConfirmed:true,answer:"Must not disclose."});
    if(change==="authority")f.deny();else if(change==="generation")f.machine.generation++;else f.r.db.prepare("UPDATE hub_exposures SET revision=revision+1 WHERE id=?").run(f.e.id);
    await f.wake();expect(f.row(id)).toMatchObject({state:"failed"});
    expect(f.r.db.prepare("SELECT answer_ref FROM hub_messages WHERE id=?").get(id)).toEqual({answer_ref:null});
  });
  it("ends the five-minute job without treating a missing result as success",async()=>{
    const f=await fixture(),id=f.enqueue();f.start();await drain();f.advance(300_000);await f.wake();
    expect(f.row(id)).toMatchObject({state:"failed",reason:"timeout"});expect(f.call.mock.calls.filter(([,op])=>op==="run")).toHaveLength(1);
    expect(f.call).toHaveBeenLastCalledWith(f.machine.id,"cancel",{runId:id});
  });
});
