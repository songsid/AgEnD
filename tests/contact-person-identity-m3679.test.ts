import { ContactHeldError } from "../src/contact-auth-service.js";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { ContactAuthStore, contactPersonKey, normalizeContactPersonKey, mergeContactOrigins, type ContactRequest } from "../src/contact-auth-store.js";
import { sameContactPerson } from "../src/contact-auth-policy.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { ContactOrigin, ContactPerson } from "../src/contact-auth-types.js";
const admin: ContactPerson = { platform: "discord", adapterId: "demo-main", userId: "demo-admin", label: "Demo admin" };
const alias: ContactPerson = { ...admin, adapterId: "demo-persona" };
const personOrigin = (person: ContactPerson): ContactOrigin => ({ kind: "human", people: [person], receiptIds: [`receipt-${person.adapterId}`], chain: ["demo-room"] });
const dbs: Database.Database[] = [];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
function rig(){
 const db=new Database(":memory:");dbs.push(db);const store=new ContactAuthStore(db,()=>1_000);
 const channels=[{id:"demo-main",type:"discord",access:{allowed_users:[admin.userId]}},{id:"demo-persona",type:"discord"},{id:"demo-tg",type:"telegram",access:{allowed_users:["tg-admin"]}}];
 const adapters=new Map(channels.map(c=>[c.id,{id:c.id,type:c.type}]));
 const fm:any=Object.assign(Object.create(FleetManager.prototype),{fleetConfig:{channels,defaults:{},instances:{}},adapters,worlds:new Map(),
  deliveryOutbox:{contactAuthorizations:store},getPrimaryAdapterId:()=>"demo-main",getInstanceAdapterId:(name:string)=>name==="persona-worker"?"demo-persona":"demo-main",classicChannels:{getAll:()=>[],isAdmin:()=>false},hubAgentToken:()=>"demo-generation",hubContactRestricted:()=>false});
 return {db,store,fm};
}
it("one platform/user is one person across sibling bots, but not across platforms or user ids",()=>{
 expect(sameContactPerson(admin,alias)).toBe(true);expect(contactPersonKey(admin)).toBe(contactPersonKey(alias));
 expect(sameContactPerson(admin,{...alias,platform:"telegram"})).toBe(false);
 expect(sameContactPerson(admin,{...alias,userId:"demo-other"})).toBe(false);
});
it("merging the same person twice keeps human and preserves both receipt references",()=>{
 const merged=mergeContactOrigins(personOrigin(admin),personOrigin(alias));
 expect(merged).toMatchObject({kind:"human",people:[expect.objectContaining({platform:"discord",userId:admin.userId})]});
 expect(merged.receiptIds).toEqual(["receipt-demo-main","receipt-demo-persona"]);
 expect(mergeContactOrigins(personOrigin(admin),personOrigin({...alias,userId:"other"})).kind).toBe("mixed");
 expect(mergeContactOrigins(personOrigin(admin),personOrigin({...alias,platform:"telegram"})).kind).toBe("mixed");
});
it("existing mixed-by-adapter origin recovers on ordinary reads and after reopening the store; unknown stays unknown",()=>{
 const r=rig(),old={kind:"mixed",people:[admin,alias],receiptIds:["one","two"],chain:["room","worker"]};
 r.db.prepare("INSERT INTO contact_auth_origins VALUES (?,?)").run("leader",JSON.stringify(old));
 expect(r.store.origin("leader")).toMatchObject({kind:"human",people:[expect.objectContaining({userId:admin.userId})],receiptIds:["one","two"]});
 expect(new ContactAuthStore(r.db).origin("leader")?.kind).toBe("human");
 expect(r.fm.contactService().needsApplication("leader")).toBe(false);
 r.db.prepare("UPDATE contact_auth_origins SET origin_json=? WHERE instance='leader'").run(JSON.stringify({...old,kind:"unknown"}));
 expect(r.store.origin("leader")?.kind).toBe("unknown");expect(r.fm.contactService().needsApplication("leader")).toBe(true);
});
it("contact admin and configured approver checks use platform/person even on a sibling bot with no access block",()=>{
 const {fm}=rig();
 expect(fm.contactAdminOf("leader",alias)).toBe(true);
 expect(fm.contactAdminOf("persona-worker",admin)).toBe(true);
 expect(fm.contactService().canManage("leader",alias)).toBe(true);
 expect(fm.contactService().canManage("persona-worker",alias)).toBe(true);
 expect(fm.contactAdminOf("leader",{...alias,userId:"demo-outsider"})).toBe(false);
 expect(fm.contactAdminOf("leader",{...alias,userId:"tg-admin"})).toBe(false);
 expect(fm.contactAdminOf("leader",{...alias,platform:"telegram"})).toBe(false);
});
it("an existing standing grant matches the person via another bot, with scope and generation still required",()=>{
 const {store}=rig();store.writePolicy("worker",{revision:0,grants:[{id:"",person:admin,source:"room",target:"worker",verbs:["send_to_instance"],expiresAt:new Date(10_000).toISOString(),remainingUses:null}]},admin,()=>"gen");
 const request:ContactRequest={operationId:"operation",source:"room",target:"worker",sourceGeneration:"gen",targetGeneration:"gen",verb:"send_to_instance",origin:personOrigin(alias),message:"Question",correlationId:"correlation",resultRecipient:"room",payload:{}};
 expect(store.matchingGrants(request)).toHaveLength(1);
 expect(store.matchingGrants({...request,source:"other-room"})).toEqual([]);
 expect(store.matchingGrants({...request,targetGeneration:"replacement"})).toEqual([]);
 expect(store.matchingGrants({...request,origin:personOrigin({...alias,userId:"another"})})).toEqual([]);
});
it("distinct-person cap still fails closed; adapter aliases do not consume that cap",()=>{
 let origin=personOrigin(admin);
 for(let n=0;n<17;n++)origin=mergeContactOrigins(origin,personOrigin({...admin,adapterId:`bot-${n}`}));
 expect(origin.kind).toBe("human");expect(origin.people).toHaveLength(1);
 const many={...origin,people:Array.from({length:17},(_,n)=>({...admin,userId:`person-${n}`}))};
 expect(mergeContactOrigins(undefined,many).kind).toBe("unknown");
});

it("recovery does not auto-approve or replay an existing held operation; new admin work is unblocked",()=>{
 const {db,store,fm}=rig(),old:ContactOrigin={kind:"mixed",people:[admin,alias],receiptIds:["one","two"],chain:[]};
 db.prepare("INSERT INTO contact_auth_origins VALUES (?,?)").run("leader",JSON.stringify(old));
 const request:ContactRequest={operationId:"held-operation",source:"leader",target:"worker",sourceGeneration:"demo-generation",targetGeneration:"demo-generation",verb:"send_to_instance",origin:old,message:"Question",correlationId:"correlation",resultRecipient:"leader",payload:{}};
 const ticket=store.hold(request),service=fm.contactService();
 expect(()=>service.requireApplication(request)).toThrow(ContactHeldError);expect(store.get(ticket.id)?.state).toBe("pending");
 const admit=vi.spyOn(service.host,"admit").mockReturnValue("unexpected-delivery");
 store.writePolicy("worker",{revision:0,grants:[{id:"",person:admin,source:"leader",target:"worker",verbs:["send_to_instance"],expiresAt:new Date(10_000).toISOString(),remainingUses:2}]},admin,()=>"demo-generation");
 expect(()=>service.requireApplication(request)).toThrow(ContactHeldError);expect(admit).not.toHaveBeenCalled();
 expect(store.get(ticket.id)?.state).toBe("pending");expect(store.policy("worker","demo-generation").grants[0]?.remainingUses).toBe(2);
 expect(()=>service.requireApplication({...request,message:"Conflicting question"})).toThrow("operation-conflict");
 expect(service.requireApplication({...request,operationId:"fresh-operation"})).toBeUndefined();
});
it("explicit mixed singleton and explicit unknown never gain authority by normalization",()=>{
 const {db,store}=rig();
 for(const kind of ["mixed","unknown"] as const){db.prepare("INSERT OR REPLACE INTO contact_auth_origins VALUES (?,?)").run("worker",JSON.stringify({...personOrigin(admin),kind}));expect(store.origin("worker")?.kind).toBe(kind);}
});

it("old selectors and old pending ticket origins resolve to the same person without widening a grant",()=>{
 const {store}=rig(),old:ContactOrigin={kind:"mixed",people:[admin,alias],receiptIds:["one","two"],chain:[]};
 const input:ContactRequest={operationId:"old-operation",source:"room",target:"worker",sourceGeneration:"gen",targetGeneration:"gen",verb:"send_to_instance",origin:old,message:"Question",correlationId:"correlation",resultRecipient:"room",payload:{}};
 const ticket=store.hold(input),key=JSON.stringify([alias.platform,alias.adapterId,alias.userId]);
 expect(normalizeContactPersonKey(key)).toBe(contactPersonKey(admin));
 expect(store.get(ticket.id)?.origin).toMatchObject({kind:"human",people:[expect.objectContaining({userId:admin.userId})]});
 const admit=vi.fn(()=>"delivery");
 store.decide(ticket.id,{revision:1,decision:"approve-once",grant:{personKeys:[key],expiresAt:new Date(10_000).toISOString(),remainingUses:2}},admin,{canDecide:()=>true,current:()=>true,admit});
 expect(admit).toHaveBeenCalledOnce();expect(store.policy("worker","gen").grants).toMatchObject([{remainingUses:2,verbs:["send_to_instance"],source:"room",target:"worker"}]);
 expect(store.policy("worker","gen").grants).toHaveLength(1);
});
it("another Fleet admin still cannot decide when a different person is the configured approver",()=>{
 const {fm,store}=rig();fm.fleetConfig.channels.push({id:"demo-other-bot",type:"discord",access:{allowed_users:["other-admin"]}});
 const other={...admin,userId:"other-admin",adapterId:"demo-persona"};
 store.writePolicy("leader",{revision:0,approvers:[admin]},admin,()=>"demo-generation");
 expect(fm.contactService().canManage("leader",other)).toBe(true);
 expect(fm.contactService().canDecide("leader",other)).toBe(false);
 expect(fm.contactService().canDecide("leader",alias)).toBe(true);
});

it("the real authorization-list method accepts old and current person selectors without matching another platform",()=>{
 const {store,fm}=rig();const ticket=store.hold({operationId:"filter-operation",source:"leader",target:"worker",sourceGeneration:"demo-generation",targetGeneration:"demo-generation",verb:"send_to_instance",origin:personOrigin(alias),message:"Question",correlationId:"correlation",resultRecipient:"leader",payload:{}});
 for(const person of [contactPersonKey(admin),JSON.stringify([admin.platform,admin.adapterId,admin.userId])])expect(fm.contactAuthorizations(alias,{person}).items.map((row:any)=>row.id)).toEqual([ticket.id]);
 expect(fm.contactAuthorizations(alias,{person:JSON.stringify(["telegram",admin.userId])}).items).toEqual([]);
});

it("a removed sibling bot's stale runtime configuration cannot add a contact admin",()=>{
 const {fm}=rig();fm.worlds.set("removed-bot",{adapter:{id:"removed-bot",type:"discord"},channelConfig:{id:"removed-bot",type:"discord",access:{allowed_users:["removed-admin"]}}});
 expect(fm.contactAdminOf("leader",{...alias,userId:"removed-admin"})).toBe(false);
});
it("contact admin follows the current central Fleet-admin gate, not just an enumerated list",()=>{
 const {fm}=rig(),gate=vi.spyOn(fm,"isFleetAdmin").mockReturnValue(false);
 expect(fm.contactAdminOf("leader",admin)).toBe(false);
 gate.mockImplementation((userId,adapterId)=>userId===admin.userId&&adapterId==="demo-main");
 expect(fm.contactAdminOf("persona-worker",alias)).toBe(true);
 expect(gate).toHaveBeenCalledWith(admin.userId,"demo-main");
 expect(gate.mock.calls.some(([,adapterId])=>adapterId==="demo-tg")).toBe(false);
});
