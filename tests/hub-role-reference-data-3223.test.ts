import {expect,it} from "vitest";
import {builtinRoles,parseRolePolicy} from "../src/hub/roles/model.js";
import {planRoleChange} from "../src/hub/roles/change.js";
const root={realm:"corp",objectId:"00000000-0000-4000-8000-000000000001"};
const policy=()=>({realm:"corp",generation:"g1",revision:1,rolesActive:true,state:"enabled",everEnabled:true,roles:builtinRoles(),assignments:[],denies:[]});
it("keeps legacy role documents byte-shaped while preserving a new description",()=>{
 const old=policy();expect(JSON.stringify(parseRolePolicy(old))).toBe(JSON.stringify(old));
 const next=structuredClone(old);next.roles.push({...builtinRoles()[2]!,id:"custom:help",kind:"custom",name:"Help",description:"Help colleagues connect their Fleet."} as any);
 expect(parseRolePolicy(next).roles.at(-1)).toMatchObject({description:"Help colleagues connect their Fleet."});
});
it("binds a description-only edit into the checked role change",()=>{
 const old=policy(),next=structuredClone(old);Object.assign(next.roles[1]!,{description:"Named support leads"});
 const plan=planRoleChange(old,next,root,100);expect(plan.changed).toBe(true);expect(plan.roles).toHaveLength(1);expect(plan.required).toContain("hub.admin");expect(plan.next.roles[1]?.description).toBe("Named support leads");
});
it("bounds description text and keeps the Administrator metadata immutable",()=>{
 for(const description of ["x".repeat(501),"line\nforged", "\u202ehidden"]){const p=policy();Object.assign(p.roles[1]!,{description});expect(()=>parseRolePolicy(p)).toThrow();}
 const p=policy();Object.assign(p.roles[0]!,{description:"Custom admin copy"});expect(()=>parseRolePolicy(p)).toThrow();
});

import {hasCurrentAdministrator,roleReview} from "../src/hub/roles/review.js";
import type {RolePersonFacts} from "../src/hub/roles/evaluate.js";
import type {HubRolePolicy} from "../src/hub/roles/model.js";
import {personKeyString} from "../src/hub/identity.js";
const member={...root,objectId:"00000000-0000-4000-8000-000000000002"};
const facts=(eligible=true)=>new Map<string,RolePersonFacts>([[personKeyString(root),eligible?{kind:"eligible",person:root,observedAt:100}:{kind:"ineligible",person:root,reason:"disabled",observedAt:100}],[personKeyString(member),{kind:"complete",person:member,groups:[],observedAt:100}]]);
const assigned=():HubRolePolicy=>parseRolePolicy({...policy(),assignments:[{id:"member",roleId:"builtin:manager",subject:{kind:"person",person:member},scope:{kind:"hub"},startsAt:0,expiresAt:null,maxFleets:null,assignedBy:root,assignedAt:0}]});
it("never counts a missing, disabled, future or expired administrator as the last administrator",()=>{
 const p=assigned(),f=facts(false);expect(hasCurrentAdministrator(p,[root,member],f,root,100)).toBe(false);
 p.assignments[0]!.roleId="builtin:admin";expect(hasCurrentAdministrator(p,[root,member],f,root,100)).toBe(true);
 p.assignments[0]!.startsAt=101;expect(hasCurrentAdministrator(p,[root,member],f,root,100)).toBe(false);
 p.assignments[0]!.startsAt=0;p.assignments[0]!.expiresAt=100;expect(hasCurrentAdministrator(p,[root,member],f,root,100)).toBe(false);
 expect(hasCurrentAdministrator(p,[root,member],new Map(),root,100)).toBe(false);
 expect(hasCurrentAdministrator(p,[root],facts(),root,100)).toBe(true);
});
it("names role-permission losses even when no self-use permission changed",()=>{
 const before=assigned(),next=structuredClone(before);next.roles.find(r=>r.kind==="manager")!.permissions=next.roles.find(r=>r.kind==="manager")!.permissions.filter(p=>p!=="team.view");
 const result=roleReview(planRoleChange(before,next,root,100),[root,member],facts(),root,100);
 expect(result.losingPermissions).toEqual([{person:member,permissions:["team.view"]}]);expect(result.unverified).toEqual([]);
});
it("holds uncertain affected people out of a nobody-loses-access claim",()=>{
 const before=assigned(),next=structuredClone(before);next.assignments=[];
 const result=roleReview(planRoleChange(before,next,root,100),[member],new Map(),root,100);expect(result.unverified).toEqual([member]);expect(result.losingPermissions).toEqual([]);
});

it("includes management losses and narrower team scopes in the same named review",()=>{
 const before=assigned();before.roles[1]!.permissions.push("audit.view");
 const next=structuredClone(before);next.roles[1]!.permissions=next.roles[1]!.permissions.filter(p=>p!=="audit.view");
 const group={...root,objectId:"00000000-0000-4000-8000-000000000003"};next.assignments[0]!.scope={kind:"group",group,dn:"CN=Product"};
 const result=roleReview(planRoleChange(before,next,root,100),[member],facts(),root,100);
 expect(result.losingPermissions).toEqual([{person:member,permissions:["team.view","team.usage","audit.view"]}]);
});
