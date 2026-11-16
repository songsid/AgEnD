import {expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {convertGroupPolicy} from "../src/hub/roles/convert.js";
import {mergeRoleAllowedList,projectRoleAllowedList} from "../src/hub/roles/allowed-list.js";
import type {HubGroupPolicy} from "../src/hub/group-policy/model.js";
const root={realm:"corp",objectId:randomUUID()},group={realm:"corp",objectId:randomUUID()};
function fixture(){const old:HubGroupPolicy={realm:"corp",generation:"g1",revision:3,state:"enabled",groups:[{group,dn:"CN=Members",allow:["ask_agents","pair_fleet"],maxFleets:4}],people:[{person:root,name:"Root",allow:[],maxFleets:0}],denies:[]};return convertGroupPolicy(old,{root,now:100,rolesActive:true});}
it("round-trips carried rules without changing roles, assignment provenance or role mode",()=>{
 const p=fixture(),next=mergeRoleAllowedList(p,projectRoleAllowedList(p),root);expect(next).toEqual(p);
});
it("does not flatten independent per-capability grants or rewrite timed/scoped assignments",()=>{
 const p=fixture();p.roles.push({id:"publisher",name:"Publisher",kind:"custom",permissions:["publish_agents"],defaultMaxFleets:1});
 p.assignments.push({id:"other",roleId:"publisher",subject:{kind:"group",group,dn:"CN=Members"},scope:{kind:"hub"},maxFleets:1,startsAt:10,expiresAt:1000,assignedBy:root,assignedAt:100});
 const shortcut=projectRoleAllowedList(p);expect(shortcut.groups[0]!.allow).toEqual(["ask_agents","pair_fleet"]);shortcut.groups[0]!.allow=["ask_agents"];
 const next=mergeRoleAllowedList(p,shortcut,root);expect(next.assignments.find(a=>a.id==="other")).toEqual(p.assignments[1]);expect(next.roles.find(r=>r.id==="publisher")).toEqual(p.roles[4]);
 expect(projectRoleAllowedList(next).groups[0]!.allow).toEqual(["ask_agents"]);expect(next.roles.find(r=>r.id===next.assignments.find(a=>a.id.startsWith("legacy:"))!.roleId)?.permissions).toEqual(["ask_agents"]);
});
it("refuses collisions with a role assignment the shortcut does not own",()=>{
 const p=fixture();p.assignments[0]!.expiresAt=1000;const next=projectRoleAllowedList(p);next.groups=[{group,dn:"CN=Members",allow:["ask_agents"],maxFleets:1}];expect(()=>mergeRoleAllowedList(p,next,root)).toThrow();
});
it("keeps roles-off and the ever-enabled latch when editing carried person/team rows",()=>{
 const p=fixture();p.rolesActive=false;const next=projectRoleAllowedList(p);next.people=[];const result=mergeRoleAllowedList(p,next,root);expect(result.rolesActive).toBe(false);expect(result.everEnabled).toBe(true);expect(result.assignments).toEqual(p.assignments);
 next.state="never-enabled";expect(()=>mergeRoleAllowedList(p,next,root)).toThrow();
});
