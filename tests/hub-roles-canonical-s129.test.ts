/** Actual policy SQL/audit and the existing physical admission owner; inert directory only. */
import Database from "better-sqlite3";
import {randomBytes,randomUUID} from "node:crypto";
import {afterEach,describe,expect,it} from "vitest";
import {createHubAudit,HUB_AUDIT_MIGRATION} from "../src/hub/audit/index.js";
import {createHubGroupPolicyStore,groupPolicyMigration,inspectHubGroupPolicyBinding} from "../src/hub/group-policy/store.js";
import {convertGroupPolicy} from "../src/hub/roles/convert.js";
import {createHubCanonicalPolicyReader,parseCanonicalPolicy} from "../src/hub/roles/read.js";
import type {HubDirectory} from "../src/hub/directory/types.js";
const dbs:Database.Database[]=[];afterEach(()=>{for(const db of dbs.splice(0))db.close();});
function fixture(){
 const db=new Database(":memory:");dbs.push(db);HUB_AUDIT_MIGRATION.up(db);groupPolicyMigration("hub1","corp","g1").up(db);
 const root={realm:"corp",objectId:randomUUID()},audit=createHubAudit({db,contentKey:randomBytes(32)});
 const directory:HubDirectory={realm:"corp",async checkEligibility(){return{eligible:false,reason:"disabled"};},async signIn(){return{ok:false,reason:"invalid-credentials"};},async close(){}};
 const options={db,hubId:"hub1",realm:"corp",generation:"g1",directory,audit,current:()=>true};
 const old=JSON.parse((db.prepare("SELECT body FROM hub_group_policy").get()as{body:string}).body),roles=convertGroupPolicy(old,{root,now:100,rolesActive:true});
 const save=(v:unknown)=>db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(v));
 return{db,root,options,old,roles,save};
}
const canonical=(store:ReturnType<typeof createHubGroupPolicyStore>)=>(store as unknown as{canonical?:()=>{kind:string;raw:string;policy:unknown}}).canonical?.();
describe("S129 canonical policy bridge",()=>{
 it("retains the complete canonical legacy document and exact serialized image",()=>{
  const w=fixture(),store=createHubGroupPolicyStore(w.options);expect(canonical(store)).toEqual({kind:"group",raw:JSON.stringify(w.old),policy:w.old});expect(store.read()).toEqual(w.old);
 });
 it("constructs the one shared admission owner over a role document without exposing a legacy projection",()=>{
  const w=fixture();w.save(w.roles);let store!:ReturnType<typeof createHubGroupPolicyStore>;
  expect(()=>{store=createHubGroupPolicyStore(w.options);}).not.toThrow();
  expect(canonical(store)).toEqual({kind:"roles",raw:JSON.stringify(w.roles),policy:w.roles});expect(()=>store.read()).toThrow();
 });
 it("holds physical admission through its promise after the canonical document changes",async()=>{
  const w=fixture(),store=createHubGroupPolicyStore(w.options);w.save(w.roles);const release:(()=>void)[]=[];
  const running=Array.from({length:4},()=>store.withDirectoryRead(w.root,()=>new Promise<void>(r=>release.push(r))));
  try{expect(canonical(store)).toMatchObject({kind:"roles"});await expect(store.withDirectoryRead(w.root,async()=>{})).rejects.toBeTruthy();}
  finally{for(const r of release)r();await Promise.all(running);}
  await expect(store.withDirectoryRead(w.root,async()=>"released")).resolves.toBe("released");
 });
 it("preserves exact stored bytes and personal assignment fields without writing a projection",()=>{
  const w=fixture();w.roles.assignments.push({id:"personal",roleId:"builtin:member",subject:{kind:"person",person:w.root},scope:{kind:"hub"},
   maxFleets:0,startsAt:100,expiresAt:200,assignedBy:w.root,assignedAt:100});
  const raw=JSON.stringify(w.roles,null,2);w.db.prepare("UPDATE hub_group_policy SET body=?").run(raw);
  const reader=createHubCanonicalPolicyReader(w.options),a=reader();expect(a).toEqual({kind:"roles",raw,policy:w.roles});
  a.policy.denies.push({person:w.root,deny:["pair_fleet"]});
  expect(reader().policy.denies).toEqual([]);expect((w.db.prepare("SELECT body FROM hub_group_policy").get()as{body:string}).body).toBe(raw);
 });
 it.each(["missing","foreign-hub","foreign-realm","foreign-generation","extra-field","hybrid","corrupt"])("refuses %s canonical state without legacy recovery",kind=>{
  const w=fixture();w.save(w.roles);
  if(kind==="missing")w.db.prepare("DELETE FROM hub_group_policy").run();
  else if(kind==="foreign-hub")w.db.prepare("UPDATE hub_group_policy SET hub_id='other'").run();
  else if(kind==="corrupt")w.db.prepare("UPDATE hub_group_policy SET body='not json'").run();
  else w.save({...w.roles,...(kind==="foreign-realm"?{realm:"other"}:kind==="foreign-generation"?{generation:"g2"}:kind==="hybrid"?{groups:[]}:{extra:true})});
  expect(()=>createHubGroupPolicyStore(w.options)).toThrow();
  expect(inspectHubGroupPolicyBinding(w.db,"hub1","corp","g1")).toEqual({kind:"repair-required",legacy:false});
 });
 it("accepts only the current role binding and preserves old never-enabled repair semantics",()=>{
  const w=fixture();w.save(w.roles);expect(inspectHubGroupPolicyBinding(w.db,"hub1","corp","g1")).toEqual({kind:"ready"});
  expect(inspectHubGroupPolicyBinding(w.db,"hub1","corp","g2")).toEqual({kind:"repair-required",legacy:false});
  w.save(w.old);expect(inspectHubGroupPolicyBinding(w.db,"hub1","corp","g2")).toMatchObject({kind:"repair-required",legacy:true});
 });
 it("refuses a retired server before and after SQL and never reinterprets rolesActive=false",()=>{
  const w=fixture();w.roles.rolesActive=false;w.save(w.roles);let checks=0;
  const reader=createHubCanonicalPolicyReader({...w.options,current:()=>++checks===1});expect(reader).toThrow();
  expect(parseCanonicalPolicy(JSON.stringify(w.roles)).kind).toBe("roles");
 });
});
