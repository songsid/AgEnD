import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {randomUUID} from "node:crypto";
import {createHubHttp} from "../src/hub/http/compose.js";
import {hubTxDatabase} from "../src/hub/db.js";
import {hubCookieName,hubCsrfOf} from "../src/hub/sessions.js";
import {createHubRoleAdminControl} from "../src/hub/roles/admin-control.js";
import {createHubRoleWriter} from "../src/hub/roles/writer.js";
import {createHubRoleModeEffects} from "../src/hub/roles/mode-effects.js";
import {expect,it,vi} from "vitest";
import {roleAuthorityWorld} from "./support/hub-role-authority-rig.js";
import {hubAdminOverviewPermit} from "../src/hub/roles/overview.js";
async function fixture(permission:"fleets.manage"|"join.manage"|"audit.view"){
 const w=await roleAuthorityWorld();w.policy.roles.push({id:"delegate",name:"Delegate",kind:"custom",permissions:[permission],defaultMaxFleets:0});
 w.policy.assignments.push({id:"delegate",roleId:"delegate",subject:{kind:"person",person:w.other},scope:{kind:"hub"},maxFleets:null,startsAt:0,expiresAt:null,assignedBy:w.root,assignedAt:0});w.save(w.policy);
 return{...w,browser:await w.browser(w.other)};
}
it.each(["fleets.manage","join.manage"] as const)("%s permits only its own overview section and revokes with the graph",async cap=>{
 const w=await fixture(cap),permit=await hubAdminOverviewPermit(w.browser.ctx,w.authority);
 expect({fleets:permit.fleets,joining:permit.joining}).toEqual({fleets:cap==="fleets.manage",joining:cap==="join.manage"});
 w.policy.assignments=[];w.save(w.policy);expect(()=>permit.assertCurrent()).toThrow();
});
it("audit-only authority cannot read either overview section",async()=>{
 const w=await fixture("audit.view");await expect(hubAdminOverviewPermit(w.browser.ctx,w.authority)).rejects.toMatchObject({code:"denied"});
});

it.each(["fleets.manage","join.manage"] as const)("HTTP overview discloses only the %s section under actual role authority",async cap=>{
 const w=await fixture(cap),writer=createHubRoleWriter({db:w.db,hubId:w.hubId,realm:"corp",generation:"g1",root:w.root,directory:w.directory,audit:w.audit,reads:w.pool,effects:createHubRoleModeEffects(w.db,w.store,w.options.current),current:w.options.current,version:w.options.version,advanceAuthorization:w.advance,refreshAuthorization(){},now:w.options.now});
 w.core.deps.management=w.authority;w.core.deps.roleAdmin=createHubRoleAdminControl({db:w.db,root:w.root,directory:w.directory,reads:w.pool,management:w.authority,writer,audit:w.audit,policy:()=>w.policy,current:w.options.current,now:w.options.now});
 const fleet=randomUUID();w.store.mutate({at:100,requestId:randomUUID(),actor:{kind:"local-host"},action:"fixture.fleet",result:"completed"},s=>s.fleets.push({id:fleet,owner:w.admin,status:"active",generation:1,credentialHash:"a".repeat(64)}));
 const http=createHubHttp(w.core.deps,hubTxDatabase),server=createServer((req,res)=>{if(!http.handle(req,res)){res.writeHead(404);res.end();}});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{
  const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hub/v1/admin/overview`,{headers:{cookie:`${hubCookieName(w.hubId)}=${w.browser.token}`}});
  expect(response.status).toBe(200);const body=await response.json();expect(body.permissions).toEqual([cap]);
  if(cap==="fleets.manage")expect(body.fleets).toMatchObject([{id:fleet}]);else{expect(body.fleets).toEqual([]);expect(body.recommendedVersion).toBeUndefined();expect(JSON.stringify(body)).not.toContain(fleet);}
  expect(body.pairings).toEqual([]);
  if(cap==="fleets.manage"){
   const exposure=randomUUID();w.db.prepare("INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,updated_at) VALUES(?,?,?,'Fixture',1,'published','agent','[]','digest',100)").run(exposure,fleet,`${w.admin.realm}/${w.admin.objectId}`);
   const freeze=async(token:string)=>fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hub/v1/admin/exposures/${exposure}/freeze`,{method:"POST",headers:{cookie:`${hubCookieName(w.hubId)}=${token}`,origin:w.core.deps.config.webOrigin,"x-agend-hub-csrf":hubCsrfOf(token),"content-type":"application/json"},body:JSON.stringify({revision:1})});
   expect((await freeze(w.browser.token)).status).toBe(403);
   const append=w.audit.append.bind(w.audit);vi.spyOn(w.audit,"append").mockImplementation((tx,event)=>{append(tx,event);if(event.action==="exposure.frozen")w.time(5000);});
   expect((await freeze(w.ctx.token)).status).toBe(503);expect((w.db.prepare("SELECT frozen_through AS n FROM hub_exposures WHERE id=?").get(exposure) as {n:number}).n).toBe(-1);
  }
 }finally{await http.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
