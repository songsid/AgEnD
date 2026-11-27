import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { RequestContextMigrationShadow, type RequestMigrationHost } from "../src/request-context-migration.js";
import type { ContactPerson } from "../src/contact-auth-types.js";
const cleanup:Array<()=>void>=[];
afterEach(()=>{vi.restoreAllMocks();for(const fn of cleanup.splice(0).reverse())fn();});
const admin:ContactPerson={platform:"discord",adapterId:"fixture",userId:"demo-admin",label:"Demo admin"};
function rig(){
 const home=mkdtempSync(join(tmpdir(),"s226-shadow-")),file=join(home,"outbox.db");cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const box=new DeliveryOutbox(file);cleanup.push(()=>box.close());const db=(box as any).db as Database.Database;
 let owner="manager-a",epoch="policy-a",allowed=true;const generations=new Map([["source","source-v1"],["target","target-v1"]]);
 const host:RequestMigrationHost={owner:()=>owner,policyEpoch:()=>epoch,generation:name=>generations.get(name)??null,canManage:()=>allowed};
 const shadow=box.requestContextMigrationShadow(host);
 const hold=()=>box.contactAuthorizations.hold({operationId:randomUUID(),source:"source",target:"target",sourceGeneration:"source-v1",targetGeneration:"target-v1",verb:"send_to_instance",origin:{kind:"unknown",people:[],receiptIds:[],chain:[]},message:"PRIVATE_MESSAGE_NOT_RETURNED",correlationId:randomUUID(),resultRecipient:"source",payload:{type:"fleet_inbound",content:"PRIVATE_MESSAGE_NOT_RETURNED"}});
 const grant=()=>{const store=box.contactAuthorizations;return store.writePolicy("target",{revision:store.policy("target","target-v1").revision,grants:[{id:randomUUID(),person:{...admin,userId:"demo-person"},source:"source",target:"target",verbs:["send_to_instance"],expiresAt:new Date(Date.now()+86400_000).toISOString(),remainingUses:3}]},admin,name=>generations.get(name)!).grants[0]!;};
 const bytes=()=>JSON.stringify({tickets:db.prepare("SELECT * FROM contact_auth_tickets ORDER BY id").all(),policies:db.prepare("SELECT * FROM contact_auth_policies ORDER BY instance").all(),origins:db.prepare("SELECT * FROM contact_auth_origins ORDER BY instance").all(),notices:db.prepare("SELECT * FROM contact_auth_outcome_notices ORDER BY ticket_id").all(),admissions:db.prepare("SELECT * FROM deliveries ORDER BY delivery_id").all(),changes:db.prepare("SELECT total_changes() AS n").get()});
 return {home,file,box,db,host,shadow,hold,grant,generations,bytes,owner:(v:string)=>{owner=v;},epoch:(v:string)=>{epoch=v;},allowed:(v:boolean)=>{allowed=v;}};
}
it("OFF shadow creates no artifacts or decisions on an untouched outbox",()=>{
 const f=rig(),before=f.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();const report=f.shadow.inspect();
 expect(report.complete).toBe(true);expect(report.readOnly).toBe(true);expect(report.tickets).toEqual([]);
 expect(f.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
});
it("unread expiry, stale policy and retained union remain byte-identical during a read-only shadow",()=>{
 const f=rig(),ticket=f.hold();f.grant();f.box.contactAuthorizations.inheritOrigin("source",{kind:"mixed",people:[admin,{...admin,userId:"demo-other"}],receiptIds:["receipt"],chain:["source"]});
 f.generations.set("target","new-generation");const before=f.bytes();
 for(const method of ["get","policy","origin","inheritOrigin","decide","applyStandingGrant"]as const)vi.spyOn(f.box.contactAuthorizations,method).mockImplementation(()=>{throw Error("forbidden shadow writer/normalizer");});
 const report=f.shadow.inspect({now:Date.now()+3600_000});expect(report.tickets[0]).toMatchObject({id:ticket.id,storedState:"pending",state:"expired",disposition:"preserve-terminal"});
 expect(report.policies[0]!.grants![0]!.disposition).toBe("stale-generation");expect(report.origins[0]!.disposition).toBe("history-only");
 expect(JSON.stringify(report)).not.toContain("PRIVATE_MESSAGE");expect(JSON.stringify(report)).not.toContain("demo-admin");expect(f.bytes()).toBe(before);
});
it("the same reader works on a real readonly database connection",()=>{
 const f=rig();f.hold();const db=new Database(f.file,{readonly:true});cleanup.push(()=>db.close());
 expect(new RequestContextMigrationShadow(db,f.host).inspect().tickets[0]!.disposition).toBe("preserve-legacy-pending");
});
it.each(["live","expired","spent","stale-generation","manager-revoked","unavailable"])("classifies %s grants without changing their exact contract",kind=>{
 const f=rig();f.hold();const grant=f.grant();
 if(kind==="expired")f.db.prepare("UPDATE contact_auth_policies SET policy_json=json_set(policy_json,'$.grants[0].expiresAt','2000-01-01T00:00:00Z')").run();
 if(kind==="spent")f.db.prepare("UPDATE contact_auth_policies SET policy_json=json_set(policy_json,'$.grants[0].remainingUses',0)").run();
 if(kind==="stale-generation")f.generations.set("source","new-source");if(kind==="manager-revoked")f.allowed(false);if(kind==="unavailable")f.generations.delete("source");
 const before=f.bytes(),report=f.shadow.inspect();expect(report.policies[0]!.grants![0]).toMatchObject({id:grant.id,disposition:kind});expect(f.bytes()).toBe(before);
});
it("changed ticket bytes, policy role or runtime owner invalidate an informational snapshot",()=>{
 const f=rig(),ticket=f.hold();f.grant();const before=f.shadow.inspect();expect(f.shadow.unchanged(before)).toBe(true);
 f.db.prepare("UPDATE contact_auth_tickets SET request_json=json_set(request_json,'$.message','changed') WHERE id=?").run(ticket.id);expect(f.shadow.unchanged(before)).toBe(false);
 const next=f.shadow.inspect();f.allowed(false);expect(f.shadow.unchanged(next)).toBe(false);const role=f.shadow.inspect();f.owner("manager-b");expect(f.shadow.unchanged(role)).toBe(false);
});
it("truncated pages are incomplete and completed streams do not restart on the next page",()=>{
 const f=rig();f.hold();f.hold();f.grant();const first=f.shadow.inspect({limit:1});expect(first.complete).toBe(false);expect(first.truncated).toBe(true);expect(first.nextCursor?.policies).toBeNull();
 const second=f.shadow.inspect({limit:1,cursor:first.nextCursor!});expect(second.tickets).toHaveLength(1);expect(second.policies).toEqual([]);expect(second.nextCursor).toBeNull();
 expect(second.tickets[0]!.id).not.toBe(first.tickets[0]!.id);expect(second.complete).toBe(false);
});
it("malformed and oversized rows are incomplete, never repaired or interpreted as a safe plan",()=>{
 const f=rig(),ticket=f.hold();f.db.prepare("UPDATE contact_auth_tickets SET request_json='broken' WHERE id=?").run(ticket.id);const before=f.bytes();
 expect(f.shadow.inspect()).toMatchObject({complete:false,tickets:[{id:ticket.id,disposition:"malformed"}]});expect(f.bytes()).toBe(before);
 f.db.prepare("UPDATE contact_auth_tickets SET request_json=? WHERE id=?").run("x".repeat(262145),ticket.id);expect(f.shadow.inspect().tickets[0]).toMatchObject({sha256:null,disposition:"malformed"});
});

it("each unresolved legacy ticket is an explicit unsupported-input cutover blocker",()=>{
 const f=rig(),pending=f.hold();const report=f.shadow.inspect();expect(report.blockers).toEqual([{id:pending.id,reason:"legacy-decision-input-unsupported"}]);
 expect(report.complete).toBe(true); // Complete inspection is not permission to cut over.
 f.db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.state','approved') WHERE id=?").run(pending.id);
 expect(f.shadow.inspect().blockers).toEqual([{id:pending.id,reason:"legacy-decision-input-unsupported"}]);
 f.db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.state','declined') WHERE id=?").run(pending.id);
 expect(f.shadow.inspect().blockers).toEqual([]);
});
it("a same-connection write inside a host lookup makes the whole snapshot incomplete",()=>{
 const f=rig();f.hold();f.grant();let written=false;
 const original=f.host.canManage;f.host.canManage=(...args)=>{if(!written){written=true;f.db.prepare("DELETE FROM contact_auth_tickets").run();}return original(...args);};
 expect(f.shadow.inspect().complete).toBe(false);
});
it("R1 a complete bounded scan includes more than 64 retained tickets and every unresolved blocker",()=>{
 const f=rig();for(let n=0;n<70;n++){const ticket=f.hold();if(n<69)f.db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.state','declined') WHERE id=?").run(ticket.id);}
 const before=f.bytes(),report=f.shadow.inspect();expect(report.complete).toBe(true);expect(report.tickets).toHaveLength(70);expect(report.blockers).toHaveLength(1);expect(f.bytes()).toBe(before);
 expect(()=>f.shadow.inspect({limit:10001})).toThrow(/invalid/);
});
it("R1 the single-transaction raw-byte bound reports incomplete instead of loading an unbounded plan",()=>{
 const f=rig();for(let n=0;n<70;n++){const ticket=f.hold();f.db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.state','declined'),request_json=json_set(request_json,'$.message',?) WHERE id=?").run("x".repeat(250000),ticket.id);}
 const report=f.shadow.inspect();expect(report.complete).toBe(false);expect(report.truncated).toBe(true);expect(report.tickets.length).toBeLessThan(70);expect(report.nextCursor?.tickets).toBeTruthy();
});
