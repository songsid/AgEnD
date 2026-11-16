/** Hub-owned one-shot jobs. A Runtime command acknowledgement is never answer evidence. */
import type Database from "better-sqlite3";
import type { RuntimeCoordinator } from "../../runtime-coordinator.js";
import { PERSONAL_AGENT_PROFILE } from "../../runtime-personal-protocol.js";
import { exposureOf, readExposure } from "../catalog.js";
import type { HubCore, HubOperationPermit } from "../http/core.js";
import { personKeyString } from "../identity.js";
import type { HubPersonalExposure } from "../types.js";
import { HubProtocolError } from "../validation.js";
import type { HubPersonalOwnerHost } from "./owner-host.js";
import type { HubPersonalPort, PersonalJob, PersonalOutcome, PersonalQuestionAdapter } from "./types.js";

type DB=Database.Database;
const terminal=(status:string)=>["completed","failed","cancelled"].includes(status);
const DEADLINE=300_000;
export class HubPersonalTurns implements HubPersonalPort {
  private stopped=false;
  private adapters: {direct:PersonalQuestionAdapter;room:PersonalQuestionAdapter}|null=null;
  private readonly flights=new Map<string,Promise<void>>();
  private timer:NodeJS.Timeout|null=null;
  private readonly permits=new Map<string,HubOperationPermit>();
  private readonly unsubscribe:()=>void;
  constructor(private readonly core:HubCore,private readonly runtime:RuntimeCoordinator,private readonly owner:HubPersonalOwnerHost){
    this.unsubscribe=runtime.subscribe(event=>{if(event.type==="machine")this.owner.refresh();this.wake();});
  }
  private live(){return !this.stopped&&this.core.live();}
  assertSource(db:DB,e:HubPersonalExposure):void {if(this.stopped)throw new HubProtocolError("unavailable");this.owner.assertSource(db,e);}
  enqueue(db:DB,e:HubPersonalExposure,source:{direct:string}|{room:string}):void {
    this.assertSource(db,e);
    const agent=this.owner.definition(db,e.personalAgentId)!;
    const id="direct" in source?source.direct:source.room;
    const existing=db.prepare("SELECT * FROM hub_personal_jobs WHERE id=?").get(id) as PersonalJob|undefined;
    if(existing){if(existing.personal_agent_id!==e.personalAgentId||existing.owner!==personKeyString(e.owner)||existing.exposure_revision!==e.revision)throw new HubProtocolError("conflict");return;}
    db.prepare("INSERT INTO hub_personal_jobs(id,personal_agent_id,direct_message_id,room_delivery_id,machine_id,owner,exposure_revision,state,created_at) VALUES(?,?,?,?,?,?,?,'queued',?)")
      .run(id,e.personalAgentId,"direct" in source?source.direct:null,"room" in source?source.room:null,agent.machine_id,personKeyString(e.owner),e.revision,this.core.now());
  }
  presence(exposureId:string):"idle"|"working"|"paused"|"offline"|"later" {
    try{return this.core.atomic(db=>{
      const row=readExposure(db,exposureId),e=row&&exposureOf(row);
      if(!e||e.kind!=="personal")return "offline";
      if(e.state!=="published")return "paused";
      this.assertSource(db,e);const agent=this.owner.definition(db,e.personalAgentId)!,machine=this.runtime.machine(agent.machine_id);
      if(machine?.status!=="online")return "later";
      const cli=machine.inventory?.clis.find(c=>c.id===agent.cli);
      if(cli?.personalStatus!=="ready"||cli.authenticated!==true||!cli.runnable)return "paused";
      return db.prepare("SELECT 1 FROM hub_personal_jobs WHERE machine_id=? AND state='working'").get(agent.machine_id)?"working":"idle";
    });}catch{return "paused";}
  }
  start(adapters:{direct:PersonalQuestionAdapter;room:PersonalQuestionAdapter}):void {
    if(this.adapters||this.stopped)throw Error("Personal jobs already started");
    this.adapters=adapters;
    // Phase 1 never replays a turn that may have entered a CLI before the Hub stopped.
    for(const job of this.core.atomic(db=>db.prepare("SELECT * FROM hub_personal_jobs WHERE state='working'").all() as PersonalJob[])){
      this.finish(job,{reason:"interrupted"});void this.runtime.call(job.machine_id,"cancel",{runId:job.id}).catch(()=>{});
    }
    this.timer=setInterval(()=>this.wake(),1000);this.timer.unref();this.wake();
  }
  wake():void {
    if(!this.live()||!this.adapters)return;
    let ids:{machine_id:string}[];
    try{ids=this.core.atomic(db=>db.prepare("SELECT DISTINCT machine_id FROM hub_personal_jobs WHERE state IN('queued','working')").all() as {machine_id:string}[]);}
    catch{return;} // A fenced directory epoch or unavailable store cannot take down the Hub's timer loop.
    for(const {machine_id:id} of ids){
      if(this.flights.has(id))continue;
      const work=this.step(id).catch(()=>{ /* No guessed completion; the persisted job remains for the next fenced look. */ })
        .finally(()=>this.flights.delete(id));
      this.flights.set(id,work);
    }
  }
  private adapter(job:PersonalJob):PersonalQuestionAdapter {return this.adapters![job.direct_message_id?"direct":"room"];}
  private source(db:DB,job:PersonalJob):HubPersonalExposure {
    const row=db.prepare("SELECT * FROM hub_exposures WHERE personal_agent_id=?").get(job.personal_agent_id) as ReturnType<typeof readExposure>;
    const e=row&&exposureOf(row);
    if(!e||e.kind!=="personal"||e.revision!==job.exposure_revision||personKeyString(e.owner)!==job.owner||e.state!=="published")throw new HubProtocolError("revoked");
    this.assertSource(db,e);
    if(this.owner.definition(db,e.personalAgentId)?.machine_id!==job.machine_id)throw new HubProtocolError("revoked");
    return e;
  }
  private finish(job:PersonalJob,outcome:PersonalOutcome,permit?:HubOperationPermit):void {
    if(!this.live()||!this.adapters)return;
    const changed=this.core.atomic((db,tx)=>{
      const current=db.prepare("SELECT * FROM hub_personal_jobs WHERE id=?").get(job.id) as PersonalJob|undefined;
      if(!current||!["queued","working"].includes(current.state))return false;
      if("text" in outcome){this.source(db,current);const machine=this.runtime.machine(current.machine_id);
        if(machine?.status!=="online"||machine.generation!==current.machine_generation)throw new HubProtocolError("stale");}
      this.adapter(current).settle(db,tx,current,outcome);
      db.prepare("UPDATE hub_personal_jobs SET state=?,reason=?,finished_at=? WHERE id=?")
        .run("text" in outcome?"answered":"failed","reason" in outcome?outcome.reason:null,this.core.now(),job.id);
      return true;
    },permit);
    if(changed){this.permits.delete(job.id);this.adapter(job).changed(job);}
  }
  private async step(machineId:string):Promise<void> {
    if(!this.live())return;
    const job=this.core.atomic(db=>db.prepare("SELECT * FROM hub_personal_jobs WHERE machine_id=? AND state IN('queued','working') ORDER BY CASE state WHEN 'working' THEN 0 ELSE 1 END,created_at,rowid LIMIT 1").get(machineId) as PersonalJob|undefined);
    if(!job)return;
    if(job.state==="queued"&&this.core.now()>=job.created_at+24*60*60_000){this.finish(job,{reason:"expired"});return;}
    const machine=this.runtime.machine(machineId);
    if(job.state==="working"){
      try{this.core.atomic(db=>this.source(db,job));this.permits.get(job.id)?.assertCurrent();}
      catch(error){
        if(error instanceof HubProtocolError&&["denied","revoked","stale","expired","not-found"].includes(error.code)){
          this.finish(job,{reason:"revoked"});void this.runtime.call(machineId,"cancel",{runId:job.id}).catch(()=>{});
        }
        return;
      }
      const task=this.runtime.task(job.id);
      if(this.core.now()>=(job.started_at??0)+DEADLINE){
        this.finish(job,{reason:"timeout"});void this.runtime.call(machineId,"cancel",{runId:job.id}).catch(()=>{});return;
      }
      if(!task||!terminal(task.status))return;
      if(task.status!=="completed"||task.outcomeConfirmed!==true||!task.answer?.trim()){
        this.finish(job,{reason:task.personalFailure??"interrupted"});return;
      }
      if(machine?.status!=="online"||machine.generation!==job.machine_generation){this.finish(job,{reason:"interrupted"});return;}
      try{
        const prepared=await this.adapter(job).prepare(job);if(!this.live())return;
        this.finish(job,{text:task.answer},prepared.permit);
      }catch(error){if(error instanceof HubProtocolError&&["denied","revoked","stale","expired","not-found"].includes(error.code))this.finish(job,{reason:"revoked"});}
      return;
    }
    try{
      this.core.atomic(db=>this.source(db,job));
      if(!machine||machine.status!=="online"||this.runtime.hasActiveTask(machineId))return;
      const agent=this.core.atomic(db=>this.owner.definition(db,job.personal_agent_id))!,cli=machine.inventory?.clis.find(c=>c.id===agent.cli);
      if(!machine.inventory?.personalFolder||cli?.personalStatus!=="ready"||!cli.runnable||cli.authenticated!==true){this.finish(job,{reason:"authentication-unavailable"});return;}
      const prepared=await this.adapter(job).prepare(job);if(!this.live())return;
      const claimed=this.core.atomic(db=>{
        this.source(db,job);
        const current=this.runtime.machine(machineId);
        if(current?.status!=="online"||current.generation!==machine.generation||this.runtime.hasActiveTask(machineId))return false;
        return db.prepare("UPDATE hub_personal_jobs SET state='working',machine_generation=?,started_at=? WHERE id=? AND state='queued'").run(machine.generation,this.core.now(),job.id).changes===1;
      },prepared.permit);
      if(!claimed)return;
      this.permits.set(job.id,prepared.permit);
      this.adapter(job).changed(job);
      prepared.permit.assertCurrent();this.core.atomic(db=>this.source(db,job));
      // Write-ahead above: an exception or lost ACK here must never turn into a second run with a new id.
      try{await this.runtime.call(machineId,"run",{profile:PERSONAL_AGENT_PROFILE,task:{requestId:job.id,cli:agent.cli,cwd:machine.inventory.personalFolder,
        prompt:prepared.prompt,sandbox:"read-only",...(agent.model?{model:agent.model}:{})}});}
      catch{if(this.live()&&!this.runtime.task(job.id))this.finish(job,{reason:"interrupted"});}
    }catch(error){if(error instanceof HubProtocolError&&["denied","revoked","stale","expired","not-found"].includes(error.code))this.finish(job,{reason:"revoked"});}
  }
  async close():Promise<void>{this.stopped=true;this.unsubscribe();if(this.timer)clearInterval(this.timer);this.timer=null;await Promise.allSettled(this.flights.values());}
}
