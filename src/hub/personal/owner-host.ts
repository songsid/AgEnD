/** Company-owner enrollment. Runtime identity is kept separate from Fleet identity. */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {rememberRoomPeople,type RoomPersonSelection} from "../rooms/directory.js";
import { RuntimeCoordinator } from "../../runtime-coordinator.js";
import { PERSONAL_AGENT_PROFILE } from "../../runtime-personal-protocol.js";
import { isPersonalAgentCli } from "../../runtime-personal-answer.js";
import { HubCore, personFromString, type HubOperationPermit } from "../http/core.js";
import { personKeyString } from "../identity.js";
import type { HubRequestContext } from "../types.js";
import { HubProtocolError, validated } from "../validation.js";
import { exposureOf, readExposure } from "../catalog.js";
import type { HubPersonalExposure } from "../types.js";
type DB=Database.Database;
const policyInput=z.strictObject({enabled:z.boolean(),people:z.array(z.string().min(1).max(512)).max(200),teams:z.array(z.string().uuid()).max(200)});
const agentInput=z.strictObject({name:z.string().trim().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/).refine(s=>Buffer.byteLength(s,"utf8")<=256),
  description:z.string().trim().max(512),cli:z.string().refine(isPersonalAgentCli),model:z.string().min(1).max(128).optional(),ifRevision:z.number().int().min(0)});
export interface PersonalDefinition {id:string;owner:string;machine_id:string;cli:import("../../runtime-personal-answer.js").PersonalAgentCli;model:string|null;description:string}
interface Enrollment { id:string;owner:string;created_at:number;expires_at:number;machine_id:string|null;revoked_at:number|null;retired_at:number|null }
interface Computer { owner:string;machine_id:string;enrollment_id:string;bound_at:number }
export class HubPersonalOwnerHost {
  private closed=false;
  private refreshing=false;
  constructor(private readonly core:HubCore, private readonly runtime:RuntimeCoordinator) {}
  close():void { this.closed=true; }
  private fence(ctx:HubRequestContext):HubOperationPermit { return {assertCurrent:()=>{
    this.core.check();if(this.closed||ctx.isCurrent?.()!==true)throw new HubProtocolError("revoked");
  }}; }
  private policy(db:DB) {
    const row=db.prepare("SELECT enabled FROM hub_personal_settings WHERE id=1").get() as {enabled:number}|undefined;
    if(!row)throw new HubProtocolError("unavailable");
    const selected=db.prepare("SELECT kind,subject FROM hub_personal_creators ORDER BY kind,subject").all() as {kind:"person"|"team";subject:string}[];
    return {enabled:row.enabled===1,people:selected.filter(r=>r.kind==="person").map(r=>r.subject),teams:selected.filter(r=>r.kind==="team").map(r=>r.subject)};
  }
  private canAdd(db:DB,owner:string):boolean {
    const policy=this.policy(db);
    return policy.enabled&&(owner===personKeyString(this.core.deps.config.administrator)||policy.people.includes(owner)
      ||policy.teams.some(id=>this.core.deps.roomTeams?.isMember(db,id,owner)?.member===true));
  }
  async settings(ctx:HubRequestContext,input?:unknown) {
    const authority=await this.core.management(ctx,"hub.admin"),request=this.fence(ctx);
    const permit={actor:authority.actor,assertCurrent(){request.assertCurrent();authority.assertCurrent();}};
    if(input===undefined)return this.core.atomic(db=>this.settingsView(db),permit);
    const value=validated(policyInput,input);
    const people:RoomPersonSelection[]=[];
    for(const id of new Set(value.people)){permit.assertCurrent();const found=await this.core.current(personFromString(id));if(!found)throw new HubProtocolError("invalid");people.push({id,...found});}
    return this.core.atomic((db,tx)=>{
      for(const id of value.teams)if(!this.core.deps.roomTeams?.read(db,id))throw new HubProtocolError("invalid");
      db.prepare("UPDATE hub_personal_settings SET enabled=? WHERE id=1").run(value.enabled?1:0);
      db.prepare("DELETE FROM hub_personal_creators").run();
      for(const id of new Set(value.people))db.prepare("INSERT INTO hub_personal_creators VALUES('person',?)").run(id);
      for(const id of new Set(value.teams))db.prepare("INSERT INTO hub_personal_creators VALUES('team',?)").run(id);
      this.core.audit(tx,{requestId:ctx.requestId,actor:permit.actor.kind==="directory"?{kind:"person",person:permit.actor.person}:{kind:"local-host"},action:"personal.settings",result:"completed"});
      rememberRoomPeople(db,people,this.core.now());
      return this.settingsView(db);
    },permit);
  }
  private settingsView(db:DB){
    const policy=this.policy(db);
    return {...policy,peopleInfo:policy.people.map(id=>{const row=db.prepare("SELECT display_name name,login_label login FROM hub_people WHERE person=? UNION ALL SELECT display_name name,login_label login FROM hub_room_people WHERE person=? LIMIT 1").get(id,id) as {name:string;login:string}|undefined;return {id,name:row?.name??null,login:row?.login??null};}),
      teamsInfo:policy.teams.map(id=>({id,name:this.core.deps.roomTeams?.read(db,id)?.name??null}))};
  }
  async enrollment(ctx:HubRequestContext,input:unknown={}) {
    validated(z.strictObject({}),input);
    const key=await ctx.requirePerson(),owner=personKeyString(key),permit=this.fence(ctx);
    this.refresh();
    this.core.atomic(db=>{if(!this.canAdd(db,owner))throw new HubProtocolError("denied");},permit);
    // The actor is an opaque stable handle; directory keys and display names never become Runtime authority.
    const actor=createHash("sha256").update(owner).digest("hex");
    const issued=this.runtime.createEnrollment(actor,{supersede:"actor"});
    try {
      this.core.atomic((db,tx)=>{
        if(!this.canAdd(db,owner))throw new HubProtocolError("denied");
        db.prepare("INSERT INTO hub_personal_enrollments(id,owner,created_at,expires_at) VALUES(?,?,?,?)").run(issued.id,owner,issued.createdAt,issued.expiresAt);
        db.prepare("DELETE FROM hub_personal_enrollments WHERE owner=? AND id NOT IN(SELECT id FROM hub_personal_enrollments WHERE owner=? ORDER BY rowid DESC LIMIT 8) AND id NOT IN(SELECT enrollment_id FROM hub_personal_computers)").run(owner,owner);
        this.core.audit(tx,{requestId:ctx.requestId,actor:{kind:"person",person:key},action:"personal.enrollment",result:"completed",ownerAtEvent:key});
      },permit);
    } catch(error) { try{this.runtime.revokeEnrollment(issued.id,actor);}catch{/* An unreturned token is unusable by this owner flow and expires. */}throw error; }
    permit.assertCurrent();return issued;
  }
  /** Idempotent recovery of the durable enrollment→machine fact, including a restart between Runtime/SQL saves. */
  refresh():void {
    if(this.closed||this.refreshing||!this.core.live())return;
    this.refreshing=true;try{
    const machines=this.runtime.listMachines();
    this.core.atomic((db,tx)=>{
      const enrollments=db.prepare("SELECT rowid AS ordinal,* FROM hub_personal_enrollments ORDER BY rowid").all() as (Enrollment&{ordinal:number})[];
      for(const enrollment of enrollments){
        if(enrollment.revoked_at!==null)continue;
        const machine=machines.find(m=>m.enrollmentId===enrollment.id&&m.enrolledVia==="install-command"&&m.status!=="revoked");
        if(!machine)continue;
        if(enrollment.machine_id&&enrollment.machine_id!==machine.id)throw new HubProtocolError("unavailable");
        db.prepare("UPDATE hub_personal_enrollments SET machine_id=? WHERE id=?").run(machine.id,enrollment.id);
        const before=db.prepare("SELECT c.*,e.rowid AS ordinal FROM hub_personal_computers c JOIN hub_personal_enrollments e ON e.id=c.enrollment_id WHERE c.owner=?").get(enrollment.owner) as (Computer&{ordinal:number})|undefined;
        if(before&&before.ordinal>=enrollment.ordinal)continue;
        db.prepare("INSERT INTO hub_personal_computers(owner,machine_id,enrollment_id,bound_at) VALUES(?,?,?,?) ON CONFLICT(owner) DO UPDATE SET machine_id=excluded.machine_id,enrollment_id=excluded.enrollment_id,bound_at=excluded.bound_at").run(enrollment.owner,machine.id,enrollment.id,this.core.now());
        // Replacing a computer requires a new owner setup before its old publication can answer again.
        db.prepare("UPDATE hub_exposures SET state='frozen',frozen_through=MAX(frozen_through,revision),updated_at=? WHERE personal_agent_id IN(SELECT id FROM hub_personal_agents WHERE owner=?)").run(this.core.now(),enrollment.owner);
        db.prepare("UPDATE hub_personal_enrollments SET revoked_at=? WHERE owner=? AND ordinal<? AND revoked_at IS NULL").run(this.core.now(),enrollment.owner,enrollment.ordinal);
        this.core.audit(tx,{requestId:randomUUID(),actor:{kind:"person",person:personFromString(enrollment.owner)},action:"personal.computer",result:"completed",ownerAtEvent:personFromString(enrollment.owner)});
      }
    });
    // SQL removes authority first. External credential cleanup is retryable after a crash or failed file save.
    const retiring=this.core.atomic(db=>db.prepare("SELECT * FROM hub_personal_enrollments WHERE revoked_at IS NOT NULL AND retired_at IS NULL").all() as Enrollment[]);
    const runtimeTokens=retiring.length?this.runtime.listEnrollments():[];
    for(const enrollment of retiring){
      try{
        const machine=machines.find(m=>m.enrollmentId===enrollment.id);
        // Repeat the save when a prior attempt changed memory but its file commit was unconfirmed.
        if(machine)this.runtime.revoke(machine.id);
        const token=runtimeTokens.find(e=>e.id===enrollment.id);
        if(token?.status==="unused")this.runtime.revokeEnrollment(enrollment.id,createHash("sha256").update(enrollment.owner).digest("hex"));
        // A token absent from the Runtime's bounded recent list is only proven ended after its recorded deadline.
        if(token||enrollment.expires_at<=this.core.now())this.core.atomic(db=>db.prepare("UPDATE hub_personal_enrollments SET retired_at=? WHERE id=? AND revoked_at IS NOT NULL").run(this.core.now(),enrollment.id));
      }catch{this.core.deps.log?.("warn","Personal computer credential retirement is pending");}
    }
    }finally{this.refreshing=false;}
  }
  async disconnect(ctx:HubRequestContext,input:unknown={}) {
    validated(z.strictObject({}),input);
    const key=await ctx.requirePerson(),owner=personKeyString(key),permit=this.fence(ctx);
    this.core.atomic((db,tx)=>{
      db.prepare("UPDATE hub_personal_enrollments SET revoked_at=? WHERE owner=? AND revoked_at IS NULL").run(this.core.now(),owner);
      db.prepare("DELETE FROM hub_personal_computers WHERE owner=?").run(owner);
      db.prepare("UPDATE hub_exposures SET state='frozen',frozen_through=MAX(frozen_through,revision),updated_at=? WHERE personal_agent_id IN(SELECT id FROM hub_personal_agents WHERE owner=?)").run(this.core.now(),owner);
      this.core.audit(tx,{requestId:ctx.requestId,actor:{kind:"person",person:key},action:"personal.disconnect",result:"completed",ownerAtEvent:key});
    },permit);
    this.refresh();return {disconnected:true};
  }
  async refreshComputer(ctx:HubRequestContext,input:unknown={}) {
    validated(z.strictObject({}),input);
    const key=await ctx.requirePerson(),owner=personKeyString(key),permit=this.fence(ctx);
    const id=this.core.atomic(db=>(db.prepare("SELECT machine_id FROM hub_personal_computers WHERE owner=?").get(owner) as Computer|undefined)?.machine_id,permit);
    const machine=id?this.runtime.machine(id):null;
    if(id&&machine?.status==="online"){
      await this.runtime.call(id,"probe",{force:true});permit.assertCurrent();
      this.core.atomic(db=>{const binding=db.prepare("SELECT machine_id FROM hub_personal_computers WHERE owner=?").get(owner) as Computer|undefined;
        if(binding?.machine_id!==id||this.runtime.machine(id)?.generation!==machine.generation)throw new HubProtocolError("stale");},permit);
    }
    return this.view(ctx);
  }
  async view(ctx:HubRequestContext) {
    const key=await ctx.requirePerson(),owner=personKeyString(key),permit=this.fence(ctx);
    this.refresh();
    return this.core.atomic(db=>{
      const policy=this.policy(db),binding=db.prepare("SELECT * FROM hub_personal_computers WHERE owner=?").get(owner) as Computer|undefined;
      const machine=binding&&this.runtime.machine(binding.machine_id);
      const definition=db.prepare("SELECT a.*,e.id exposure_id,e.display_name,e.revision,e.state FROM hub_personal_agents a JOIN hub_exposures e ON e.personal_agent_id=a.id WHERE a.owner=?").get(owner) as (PersonalDefinition&{exposure_id:string;display_name:string;revision:number;state:string})|undefined;
      return {agent:definition?{id:definition.id,exposureId:definition.exposure_id,name:definition.display_name,description:definition.description,cli:definition.cli,model:definition.model,revision:definition.revision,state:definition.state}:null,enabled:policy.enabled,canAdd:this.canAdd(db,owner),computer:machine?{
        id:machine.id,name:machine.name,connected:machine.status==="online",compatible:machine.platform==="win32"&&machine.runtimeInfo?.capabilities.includes(PERSONAL_AGENT_PROFILE)===true,
        folder:machine.inventory?.personalFolder??null,working:!!db.prepare("SELECT 1 FROM hub_personal_jobs WHERE machine_id=? AND state='working'").get(machine.id),clis:(machine.inventory?.clis??[]).filter(cli=>isPersonalAgentCli(cli.id)).map(cli=>({...cli,
          available:machine.platform==="win32"&&machine.runtimeInfo?.capabilities.includes(PERSONAL_AGENT_PROFILE)===true&&cli.personalStatus==="ready"&&cli.runnable&&cli.authenticated===true,
          personalStatus:cli.personalStatus??"unchecked",
        })),
      }:null};
    },permit);
  }
  definition(db:DB,id:string):PersonalDefinition|undefined {
    return db.prepare("SELECT * FROM hub_personal_agents WHERE id=?").get(id) as PersonalDefinition|undefined;
  }
  assertSource(db:DB,exposure:HubPersonalExposure):void {
    this.core.check();if(this.closed)throw new HubProtocolError("unavailable");
    if(!this.policy(db).enabled)throw new HubProtocolError("denied");
    const agent=this.definition(db,exposure.personalAgentId),owner=personKeyString(exposure.owner);
    const binding=db.prepare("SELECT machine_id FROM hub_personal_computers WHERE owner=?").get(owner) as {machine_id:string}|undefined;
    const machine=agent&&this.runtime.machine(agent.machine_id);
    if(!agent||agent.owner!==owner||agent.machine_id!==binding?.machine_id||!machine||machine.status==="revoked"
      ||machine.platform!=="win32"||!machine.runtimeInfo?.capabilities.includes(PERSONAL_AGENT_PROFILE))throw new HubProtocolError("revoked");
  }
  /** Exact non-secret source material for policy preview/resume fences; an offline computer remains the same source. */
  sourceMaterial(db:DB,exposure:HubPersonalExposure):unknown|null {
    try{this.assertSource(db,exposure);}catch(error){if(error instanceof HubProtocolError)return null;throw error;}
    const agent=this.definition(db,exposure.personalAgentId)!,machine=this.runtime.machine(agent.machine_id)!;
    const computer=db.prepare("SELECT * FROM hub_personal_computers WHERE owner=?").get(agent.owner);
    return {exposure,agent,computer,machine:{id:machine.id,generation:machine.generation,enrollmentId:machine.enrollmentId,
      enrolledVia:machine.enrolledVia,personalFolder:machine.inventory?.personalFolder??null}};
  }
  async publish(ctx:HubRequestContext,input:unknown):Promise<HubPersonalExposure> {
    const value=validated(agentInput,input),key=await ctx.requirePerson(),owner=personKeyString(key),request=this.fence(ctx);
    this.refresh();
    const before=this.core.atomic(db=>{
      if(!this.canAdd(db,owner))throw new HubProtocolError("denied");
      const binding=db.prepare("SELECT machine_id FROM hub_personal_computers WHERE owner=?").get(owner) as {machine_id:string}|undefined;
      const machine=binding&&this.runtime.machine(binding.machine_id),cli=machine?.inventory?.clis.find(c=>c.id===value.cli);
      if(!machine||machine.platform!=="win32"||machine.status!=="online"||!machine.runtimeInfo?.capabilities.includes(PERSONAL_AGENT_PROFILE)
        ||!cli?.runnable||cli.authenticated!==true||cli.personalStatus!=="ready"||!machine.inventory?.personalFolder)throw new HubProtocolError("unavailable");
      if(value.model&&!cli.models.some(m=>m.id===value.model))throw new HubProtocolError("invalid");
      const agent=db.prepare("SELECT * FROM hub_personal_agents WHERE owner=?").get(owner) as PersonalDefinition|undefined;
      const row=agent&&db.prepare("SELECT * FROM hub_exposures WHERE personal_agent_id=?").get(agent.id) as ReturnType<typeof readExposure>;
      if((row?.revision??0)!==value.ifRevision)throw new HubProtocolError("conflict");
      return {machine:machine.id,generation:machine.generation,agentId:agent?.id??randomUUID(),id:row?.id??randomUUID(),revision:value.ifRevision+1,image:JSON.stringify(row??null)};
    },request);
    const groups=this.core.deps.groups,context=this.core.groupContext(ctx);
    const enrollment=groups?await groups.prepareEnrollment({kind:"exposure",id:before.id,revision:before.revision,owner:key},context):undefined;
    const permit={assertCurrent:()=>{request.assertCurrent();enrollment?.assertCurrent();if(this.core.deps.groups!==groups)throw new HubProtocolError("stale");}};
    return this.core.atomic((db,tx)=>{
      if(!this.canAdd(db,owner))throw new HubProtocolError("denied");
      const machine=this.runtime.machine(before.machine),binding=db.prepare("SELECT machine_id FROM hub_personal_computers WHERE owner=?").get(owner) as {machine_id:string}|undefined;
      const cli=machine?.inventory?.clis.find(c=>c.id===value.cli);
      if(binding?.machine_id!==before.machine||machine?.generation!==before.generation||machine.status!=="online"||cli?.personalStatus!=="ready"||cli.authenticated!==true||!cli.runnable)throw new HubProtocolError("stale");
      if(JSON.stringify(readExposure(db,before.id)??null)!==before.image)throw new HubProtocolError("conflict");
      const now=this.core.now();
      db.prepare("INSERT INTO hub_personal_agents(id,owner,machine_id,cli,model,description,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET machine_id=excluded.machine_id,cli=excluded.cli,model=excluded.model,description=excluded.description,updated_at=excluded.updated_at")
        .run(before.agentId,owner,before.machine,value.cli,value.model??null,value.description,now,now);
      db.prepare("INSERT INTO hub_exposures(id,owner,display_name,revision,state,updated_at,source_kind,personal_agent_id) VALUES(?,?,?,?,'published',?,'personal',?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,revision=excluded.revision,state='published',updated_at=excluded.updated_at")
        .run(before.id,owner,value.name,before.revision,now,before.agentId);
      enrollment?.commit(db);
      this.core.audit(tx,{requestId:ctx.requestId,actor:{kind:"person",person:key},action:"personal.published",result:"completed",exposureId:before.id,ownerAtEvent:key});
      return exposureOf(readExposure(db,before.id)!) as HubPersonalExposure;
    },permit);
  }
}
