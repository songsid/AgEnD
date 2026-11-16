import {expect,it} from "vitest";
import {builtinRoles,type HubRolePolicy} from "../src/hub/roles/model.js";
import {buildHubRoleImpact} from "../src/hub/group-policy/admin-impact.js";
import type {GroupPersonFacts} from "../src/hub/group-policy/model.js";
import type {HubGroupImpactResource} from "../src/hub/group-policy/admin-impact.js";
const root={realm:"corp",objectId:"00000000-0000-4000-8000-000000000000"},user={...root,objectId:"11111111-1111-4111-8111-111111111111"},group={...root,objectId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
const policy=():HubRolePolicy=>({realm:"corp",generation:"g1",revision:1,rolesActive:true,state:"enabled",everEnabled:true,roles:builtinRoles(),assignments:[],denies:[]});
const facts=new Map<string,GroupPersonFacts>([[`${user.realm}/${user.objectId}`,{kind:"complete" as const,person:user,groups:[group.objectId],observedAt:100}],[`${root.realm}/${root.objectId}`,{kind:"eligible" as const,person:root,observedAt:100}]]);
const person={key:user,name:"Member",login:"member",hasAskGrant:true};
const fleet=(source:"group"|"manual"|"code"="group"):HubGroupImpactResource=>({resource:{kind:"fleet",id:"fleet-a",revision:1,owner:user},display:{kind:"fleet",id:"fleet-a",revision:1,label:"Fleet",owner:{name:"Member"}},lifecycle:{source,state:"active",revision:1}});
const run=(before:HubRolePolicy,next:HubRolePolicy,resources:HubGroupImpactResource[]=[])=>buildHubRoleImpact({before,next,resources,people:[person],facts,administrator:root,at:200});
it("does not flatten two role assignments into a larger pairing quota",()=>{
 const before=policy();before.roles.push({id:"ask",kind:"custom",name:"Ask",permissions:["ask_agents"],defaultMaxFleets:8},{id:"pair",kind:"custom",name:"Pair",permissions:["pair_fleet"],defaultMaxFleets:1});
 for(const roleId of ["ask","pair"])before.assignments.push({id:roleId,roleId,subject:{kind:"group",group,dn:"CN=Group"},scope:{kind:"hub"},maxFleets:null,startsAt:0,expiresAt:null,assignedBy:root,assignedAt:0});
 const next=structuredClone(before);next.assignments=next.assignments.filter(a=>a.id!=="ask");
 const result=run(before,next,[fleet()]);
 expect(result.impact.losingActions.find(row=>row.personId===`${user.realm}/${user.objectId}`)?.capabilities).toEqual(["ask_agents"]);
 expect(result.suspend).toEqual([]);
});
it("preserves manual and code provenance unless an explicit person deny narrows it",()=>{
 const before=policy(),next=structuredClone(before),resources=[fleet("manual")];
 expect(run(before,next,resources).suspend).toEqual([]);
 next.denies=[{person:user,deny:["pair_fleet"]}];
 expect(run(before,next,resources).suspend).toEqual([resources[0]!.resource]);
 expect(run(before,next,[fleet("code")]).suspend).toHaveLength(1);
});
it("turning roles off does not suspend self-use or resurrect a paused resource",()=>{
 const before=policy();before.people=[{person:user,name:"Member",allow:["pair_fleet"],maxFleets:3}];
 const next={...structuredClone(before),rolesActive:false};const paused={...fleet(),lifecycle:{source:"group" as const,state:"suspended" as const,revision:2}};
 const result=run(before,next,[paused]);expect(result.suspend).toEqual([]);expect(result.capture).toEqual([]);
});
