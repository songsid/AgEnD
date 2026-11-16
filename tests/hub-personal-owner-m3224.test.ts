import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRuntimeInfo } from "../src/runtime-build-info.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { HubCore } from "../src/hub/http/core.js";
import { personKeyString } from "../src/hub/identity.js";
import { HubPersonalOwnerHost } from "../src/hub/personal/owner-host.js";
import { HUB_PERSONAL_AGENTS_MIGRATION } from "../src/hub/personal/schema.js";
import { HubProtocolError } from "../src/hub/validation.js";
import type { HubActor, HubRequestContext, PersonKey } from "../src/hub/types.js";
const close:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const finish of close.splice(0))await finish();});
async function fixture(){
  const r=await s3bRig({realAudit:true});HUB_PERSONAL_AGENTS_MIGRATION.up(r.db);
  const directory=mkdtempSync(join(tmpdir(),"hub-personal-owner-")),runtime=new RuntimeCoordinator(directory);
  const core=new HubCore(r.httpDeps,r.sql),host=new HubPersonalOwnerHost(core,runtime),a=r.addPerson("alex"),b=r.addPerson("sam");let current=true;
  const ctx=(key:PersonKey):HubRequestContext=>({requestId:randomUUID(),isCurrent:()=>current,
    current:async()=>({kind:"directory",person:key,sessionId:"fixture"}),
    requirePerson:async()=>{if(!current||!await core.eligible(key))throw new HubProtocolError("denied");return key;},
    requireAdmin:async():Promise<HubActor>=>{if(!current||personKeyString(key)!==personKeyString(r.admin))throw new HubProtocolError("denied");return {kind:"directory",person:key,sessionId:"fixture"};}});
  close.push(async()=>{host.close();runtime.close();await r.close();rmSync(directory,{recursive:true});});
  const allow=()=>host.settings(ctx(r.admin),{enabled:true,people:[a,b].map(personKeyString),teams:[]});
  const enroll=(token:string,name="Computer")=>runtime.enroll({token,fingerprint:runtime.serverFingerprint(),name,platform:"win32"});
  return {r,runtime,core,host,a,b,ctx,allow,enroll,stale:()=>{current=false;}};
}
describe("company-owned personal computer enrollment",()=>{
  it("refuses a session that expires while its person lookup completes, before issuing a token",async()=>{
    const f=await fixture();await f.allow();const ctx=f.ctx(f.a);
    ctx.requirePerson=async()=>{f.stale();return f.a;};
    await expect(f.host.enrollment(ctx)).rejects.toMatchObject({code:"revoked"});
    expect(f.runtime.listEnrollments()).toEqual([]);
  });
  it("is off by default, admin-controlled, and refuses caller-chosen identity fields",async()=>{
    const f=await fixture();await expect(f.host.enrollment(f.ctx(f.a))).rejects.toMatchObject({code:"denied"});
    await expect(f.host.settings(f.ctx(f.a),{enabled:true,people:[],teams:[]})).rejects.toMatchObject({code:"denied"});
    await f.allow();await expect(f.host.enrollment(f.ctx(f.a),{owner:personKeyString(f.b)})).rejects.toMatchObject({code:"invalid"});
    expect(f.runtime.listEnrollments()).toHaveLength(0);
  });
  it("binds the actual consumed enrollment to its company person, never another owner's computer",async()=>{
    const f=await fixture();await f.allow();
    const a=await f.host.enrollment(f.ctx(f.a)),b=await f.host.enrollment(f.ctx(f.b));
    const ma=f.enroll(a.token,"Alex computer"),mb=f.enroll(b.token,"Sam computer");
    expect((await f.host.view(f.ctx(f.a))).computer).toMatchObject({id:ma.machineId,name:"Alex computer",compatible:false});
    expect((await f.host.view(f.ctx(f.b))).computer).toMatchObject({id:mb.machineId,name:"Sam computer"});
    expect(f.r.db.prepare("SELECT owner,machine_id FROM hub_personal_computers ORDER BY owner").all()).toEqual([
      {owner:personKeyString(f.a),machine_id:ma.machineId},{owner:personKeyString(f.b),machine_id:mb.machineId}].sort((x,y)=>x.owner.localeCompare(y.owner)));
  });
  it("reconstructs a missed binding from persisted facts and prefers the newer consumed command",async()=>{
    const f=await fixture();await f.allow();
    const first=await f.host.enrollment(f.ctx(f.a));const old=f.enroll(first.token,"Old computer");
    const next=await f.host.enrollment(f.ctx(f.a));const latest=f.enroll(next.token,"New computer");
    f.host.close();const recovered=new HubPersonalOwnerHost(f.core,f.runtime);
    expect((await recovered.view(f.ctx(f.a))).computer?.id).toBe(latest.machineId);
    expect((await recovered.view(f.ctx(f.a))).computer?.id).not.toBe(old.machineId);
    expect(f.runtime.machine(old.machineId)?.status).toBe("revoked");recovered.close();
  });
  it("requires the computer's actual check rather than inferring readiness from a version",async()=>{
    const f=await fixture();await f.allow();const issued=await f.host.enrollment(f.ctx(f.a)),joined=f.enroll(issued.token);
    const machine=f.runtime.machine(joined.machineId)!;
    const reported={...machine,runtimeInfo:{...readRuntimeInfo(),capabilities:["exec","personal-agent-v1"]},inventory:{home:"C:\\User",personalFolder:"C:\\Shared",probedAt:1,clis:[{
      id:"codex" as const,path:"C:\\codex.exe",version:"999.0.0",authenticated:true,runnable:true,supports:{execution:true,resume:false,model:true,mcp:false},readOnlySupport:true,permissionNote:"",models:[],
    }]}};
    vi.spyOn(f.runtime,"machine").mockImplementation(()=>structuredClone(reported));
    expect((await f.host.view(f.ctx(f.a))).computer?.clis[0]).toMatchObject({available:false,personalStatus:"unchecked"});
    Object.assign(reported.inventory.clis[0],{version:"0.1.0",personalStatus:"ready"});
    expect((await f.host.view(f.ctx(f.a))).computer?.clis[0].available).toBe(true);
    reported.runtimeInfo.capabilities=["exec"];
    expect((await f.host.view(f.ctx(f.a))).computer?.clis[0].available).toBe(false);
  });
  it("revokes an unreturned token if the atomic Hub audit fails",async()=>{
    const f=await fixture();await f.allow();f.r.setAuditFails(true,"personal.enrollment");
    await expect(f.host.enrollment(f.ctx(f.a))).rejects.toThrow();
    expect(f.r.db.prepare("SELECT COUNT(*) n FROM hub_personal_enrollments").get()).toEqual({n:0});
    expect(f.runtime.listEnrollments()).toHaveLength(1);expect(f.runtime.listEnrollments()[0].status).toBe("revoked");
  });
  it("publishes only the signed-in owner's checked computer, retaining one source across revisions",async()=>{
    const f=await fixture();await f.allow();const token=await f.host.enrollment(f.ctx(f.a)),joined=f.enroll(token.token);
    const machine={...f.runtime.machine(joined.machineId)!,status:"online" as const,runtimeInfo:{...readRuntimeInfo(),capabilities:["exec","personal-agent-v1"]},
      inventory:{home:"C:\\User",personalFolder:"C:\\Shared",probedAt:1,clis:[{id:"codex" as const,path:"C:\\codex.exe",version:"0.167.0",authenticated:true,runnable:true,
        supports:{execution:true,resume:false,model:true,mcp:false},readOnlySupport:true,permissionNote:"",models:[],personalStatus:"ready" as const}]}};
    vi.spyOn(f.runtime,"machine").mockImplementation(id=>id===machine.id?structuredClone(machine):null);
    const input={name:"Alex notes",description:"Shared notes",cli:"codex",ifRevision:0};
    const first=await f.host.publish(f.ctx(f.a),input);
    expect(first).toMatchObject({kind:"personal",owner:f.a,fleetId:null,revision:1});
    expect(f.r.store.read().fleets).toEqual([]);
    const second=await f.host.publish(f.ctx(f.a),{...input,name:"New name",ifRevision:1});
    expect(second).toMatchObject({id:first.id,personalAgentId:first.personalAgentId,revision:2,displayName:"New name"});
    await expect(f.host.publish(f.ctx(f.a),input)).rejects.toMatchObject({code:"conflict"});
    await expect(f.host.publish(f.ctx(f.b),input)).rejects.toMatchObject({code:"unavailable"});
    machine.inventory.clis[0].authenticated=false;
    await expect(f.host.publish(f.ctx(f.a),{...input,ifRevision:2})).rejects.toMatchObject({code:"unavailable"});
    expect(f.r.db.prepare("SELECT COUNT(*) n FROM hub_exposures").get()).toEqual({n:1});
  });
  it("rolls back a new publication and definition when its audit cannot commit",async()=>{
    const f=await fixture();await f.allow();const token=await f.host.enrollment(f.ctx(f.a)),joined=f.enroll(token.token);
    vi.spyOn(f.runtime,"machine").mockReturnValue({...f.runtime.machine(joined.machineId)!,status:"online",runtimeInfo:{...readRuntimeInfo(),capabilities:["exec","personal-agent-v1"]},
      inventory:{home:"C:\\User",personalFolder:"C:\\Shared",probedAt:1,clis:[{id:"codex",path:"C:\\codex.exe",version:"0.167.0",authenticated:true,runnable:true,
        supports:{execution:true,resume:false,model:true,mcp:false},readOnlySupport:true,permissionNote:"",models:[],personalStatus:"ready"}]}});
    f.r.setAuditFails(true,"personal.published");
    await expect(f.host.publish(f.ctx(f.a),{name:"Notes",description:"",cli:"codex",ifRevision:0})).rejects.toThrow();
    expect(f.r.db.prepare("SELECT COUNT(*) n FROM hub_personal_agents").get()).toEqual({n:0});
    expect(f.r.db.prepare("SELECT COUNT(*) n FROM hub_exposures").get()).toEqual({n:0});
  });
  it("refreshes only the current owner's computer and refuses a replaced binding after the probe",async()=>{
    const f=await fixture();await f.allow();const token=await f.host.enrollment(f.ctx(f.a)),joined=f.enroll(token.token);
    const original=f.runtime.machine.bind(f.runtime);
    vi.spyOn(f.runtime,"machine").mockImplementation(id=>{const value=original(id);return value?{...value,status:"online"}:null;});
    let finish!:()=>void;const waiting=new Promise<void>(resolve=>{finish=resolve;});
    const probe=vi.spyOn(f.runtime,"call").mockImplementation(async()=>{await waiting;return {};});
    expect((await f.host.refreshComputer(f.ctx(f.b))).computer).toBeNull();expect(probe).not.toHaveBeenCalled();
    const pending=f.host.refreshComputer(f.ctx(f.a));await vi.waitFor(()=>expect(probe).toHaveBeenCalledWith(joined.machineId,"probe",{force:true}));
    f.r.db.prepare("DELETE FROM hub_personal_computers WHERE owner=?").run(personKeyString(f.a));finish();
    await expect(pending).rejects.toMatchObject({code:"stale"});
    await expect(f.host.refreshComputer(f.ctx(f.a),{machineId:joined.machineId})).rejects.toMatchObject({code:"invalid"});
  });
});
