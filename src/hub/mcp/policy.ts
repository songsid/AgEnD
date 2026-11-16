/** Default-off app allowance and default-on room allowance; use existing person/Team/directory identities. */
import { z } from "zod";
import { personKeyString } from "../identity.js";
import { personFromString, type HubCore, type HubOperationPermit } from "../http/core.js";
import { HubProtocolError, person, plain, uuid, validated } from "../validation.js";
import type { HubRequestContext, PersonKey } from "../types.js";
import type { HubMcpAppPolicy } from "./auth.js";

const subject = z.strictObject({kind:z.enum(["person","group","team"]),id:plain(128).min(1),name:plain(256).min(1)})
  .refine(v=>v.kind==="person"?person.safeParse(personFromString(v.id)).success:uuid.safeParse(v.id).success);
const inputSchema=z.strictObject({revision:z.number().int().min(1),enabled:z.boolean(),everyone:z.boolean(),subjects:z.array(subject).max(256)})
  .refine(v=>new Set(v.subjects.map(s=>s.kind+":"+s.id)).size===v.subjects.length);
interface Row {revision:number;enabled:number;everyone:number;subjects:string}
const image=(v:unknown)=>JSON.stringify(v);

export class HubMcpPolicy implements HubMcpAppPolicy {
  private readonly searches=new Map<string,{at:number;used:number}>();
  constructor(private readonly core:HubCore,private readonly endAll:(reason:"feature-disabled"|"not-allowed")=>void) {}
  private row():Row { return this.core.atomic(db=>{
    const row=db.prepare("SELECT revision,enabled,everyone,subjects FROM hub_mcp_settings WHERE singleton=1").get() as Row|undefined;
    if(!row)throw new HubProtocolError("unavailable");return row;
  }); }
  read() {const row=this.row();return {revision:row.revision,enabled:row.enabled===1,everyone:row.everyone===1,subjects:JSON.parse(row.subjects) as z.infer<typeof subject>[]};}
  async settings(ctx:HubRequestContext) {await ctx.requireAdmin();if(ctx.isCurrent?.()!==true)throw new HubProtocolError("revoked");return this.read();}
  async search(ctx:HubRequestContext,input:unknown) {
    const query=validated(z.strictObject({kind:z.enum(["person","group"]),q:plain(64).min(2).refine(q=>q===q.trim()&&!/[\u0000-\u001f\u007f]/.test(q))}),input);
    await ctx.requireAdmin();const who=await ctx.requirePerson(),directory=this.core.deps.directory,people=directory.searchGrantPeople,groups=directory.searchPolicyGroups;
    const at=this.core.now(),key=personKeyString(who);for(const [id,b]of this.searches)if(at<b.at||at-b.at>=60_000)this.searches.delete(id);
    const bucket=this.searches.get(key);if(bucket?bucket.used>=30:this.searches.size>=1024)throw new HubProtocolError("backpressure");
    this.searches.set(key,{at:bucket?.at??at,used:(bucket?.used??0)+1});
    const fence=()=>{this.core.check();if(ctx.isCurrent?.()!==true||this.core.deps.directory!==directory||directory.searchGrantPeople!==people||directory.searchPolicyGroups!==groups)throw new HubProtocolError("revoked");};
    fence();
    if(query.kind==="person") {
      if(!people)throw new HubProtocolError("unavailable");const result=await this.core.readDirectory(who,this.core.groupContext(ctx),()=>people.call(directory,query.q));fence();
      if(!result.ok)throw new HubProtocolError("unavailable");const rows=validated(z.array(z.strictObject({person,login:plain(256),displayName:plain(256)})).max(20),result.people);
      if(rows.some(p=>p.person.realm!==directory.realm))throw new HubProtocolError("unavailable");return {people:rows,truncated:result.truncated===true};
    }
    if(!groups||directory.groupPolicy!=="ad-direct-guid")throw new HubProtocolError("unavailable");
    const result=await this.core.readDirectory(who,this.core.groupContext(ctx),()=>groups.call(directory,query.q));fence();if(!result.ok)throw new HubProtocolError("unavailable");
    return {groups:validated(z.array(z.strictObject({objectId:uuid,cn:plain(256),dn:plain(2048)})).max(20),result.groups),truncated:result.truncated===true};
  }
  async save(ctx:HubRequestContext,input:unknown) {
    const value=validated(inputSchema,input), actor=await ctx.requireAdmin(), before=this.row(), directory=this.core.deps.directory;
    if(value.revision!==before.revision)throw new HubProtocolError("stale");
    const fence=()=>{this.core.check();if(ctx.isCurrent?.()!==true || this.core.deps.directory!==directory || image(this.row())!==image(before))throw new HubProtocolError("stale");};
    for(const selected of value.subjects) {
      if(selected.kind==="team") {
        if(!this.core.atomic(db=>this.core.deps.roomTeams?.read(db,selected.id)))throw new HubProtocolError("not-found");
      } else if(selected.kind==="person") {
        const selectedPerson=personFromString(selected.id);
        if(selectedPerson.realm!==directory.realm || !await this.core.current(selectedPerson))throw new HubProtocolError("denied");
      } else {
        if(!directory.checkPolicyGroup || actor.kind!=="directory")throw new HubProtocolError("unavailable");
        const result=await this.core.readDirectory(actor.person,this.core.groupContext(ctx),()=>directory.checkPolicyGroup!({realm:directory.realm,objectId:selected.id}));
        if(!result.ok || result.group.key.objectId!==selected.id || result.group.key.realm!==directory.realm)throw new HubProtocolError("denied");
      }
      fence();
    }
    this.core.atomic((db,tx)=>{
      fence();
      db.prepare("UPDATE hub_mcp_settings SET revision=revision+1,enabled=?,everyone=?,subjects=? WHERE singleton=1")
        .run(Number(value.enabled),Number(value.everyone),JSON.stringify(value.subjects));
      const auditActor=actor.kind==="directory"?{kind:"person" as const,person:actor.person}:{kind:"local-host" as const};
      // A possible narrowing ends all grants, including unused apps, so remove/re-add
      // cannot revive one. Additions, display edits and everyone-on keep credentials.
      const previous=JSON.parse(before.subjects) as z.infer<typeof subject>[], kept=new Set(value.subjects.map(s=>`${s.kind}:${s.id}`));
      const narrows=before.enabled===1&&(
        !value.enabled||(!value.everyone&&(before.everyone===1||previous.some(s=>!kept.has(`${s.kind}:${s.id}`))))
      );
      if(narrows)this.endAll(value.enabled?"not-allowed":"feature-disabled");
      this.core.audit(tx,{requestId:ctx.requestId,actor:auditActor,action:"mcp.settings-changed",result:"completed"});
    });
    return this.read();
  }
  async authorize(who:PersonKey,current:()=>boolean):Promise<HubOperationPermit> {
    const before=this.row(), rules=JSON.parse(before.subjects) as z.infer<typeof subject>[], key=personKeyString(who);
    if(before.enabled!==1 || !current())throw new HubProtocolError("denied");
    const teams=this.core.deps.roomTeams, directory=this.core.deps.directory;
    const observations=this.core.atomic(db=>rules.filter(s=>s.kind==="team").map(s=>({id:s.id,value:teams?.isMember(db,s.id,key)??null})));
    const assertCurrent=()=>{
      this.core.check();if(!current() || image(this.row())!==image(before) || this.core.deps.roomTeams!==teams || this.core.deps.directory!==directory)throw new HubProtocolError("stale");
      const now=this.core.atomic(db=>observations.map(t=>({id:t.id,value:teams?.isMember(db,t.id,key)??null})));
      if(image(now)!==image(observations))throw new HubProtocolError("stale");
    };
    let allowed=before.everyone===1 || rules.some(s=>s.kind==="person"&&s.id===key) || observations.some(t=>t.value?.member===true);
    if(!allowed && rules.some(s=>s.kind==="group")) {
      const read=directory.readPolicyGroups;
      if(!read || directory.groupPolicy!=="ad-direct-guid")throw new HubProtocolError("unavailable");
      const facts=await this.core.readDirectory(who,{requestId:"mcp-policy",current},()=>read.call(directory,who));
      assertCurrent();
      if(facts.kind==="unknown")throw new HubProtocolError("unavailable");
      if(personKeyString(facts.person)!==key)throw new HubProtocolError("unavailable");
      allowed=facts.kind==="complete" && rules.some(s=>s.kind==="group"&&facts.groups.includes(s.id));
    }
    assertCurrent();if(!allowed)throw new HubProtocolError("denied");return {assertCurrent};
  }
  roomEnabled(id:string):boolean {return this.core.atomic(db=>(db.prepare("SELECT enabled FROM hub_mcp_room_policy WHERE room_id=?").get(id) as {enabled:number}|undefined)?.enabled!==0);}
  async saveRoom(ctx:HubRequestContext,id:string,enabled:unknown) {
    const person=await ctx.requirePerson();validated(uuid,id);if(typeof enabled!=="boolean")throw new HubProtocolError("invalid");
    this.core.atomic((db,tx)=>{
      if(ctx.isCurrent?.()!==true || !db.prepare(`SELECT 1 FROM hub_room_members m JOIN hub_group_rooms r ON r.id=m.room_id
        WHERE m.room_id=? AND m.kind='person' AND m.subject=? AND m.role='manager' AND r.assistant_for IS NULL`).get(id,personKeyString(person)))throw new HubProtocolError("denied");
      db.prepare("INSERT INTO hub_mcp_room_policy VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET enabled=excluded.enabled").run(id,Number(enabled));
      this.core.audit(tx,{requestId:ctx.requestId,actor:{kind:"person",person},action:"mcp.room-setting-changed",result:"completed",roomId:id});
    });return {enabled};
  }
}
