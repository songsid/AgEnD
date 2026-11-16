/** Actual issued management proofs; no directory secret, listener or real account. */
import {expect,it} from "vitest";
import {roleAuthorityWorld} from "./support/hub-role-authority-rig.js";
import {assertDirectoryAdministrator} from "../src/hub/settings-directory-proof.js";
it("accepts the actual auxiliary-admin permit, never a copied or shape-compatible one",async()=>{
 const w=await roleAuthorityWorld(),permit=await w.authority.require(w.ctx.ctx,"hub.admin");
 const actor={kind:"hub-administrator" as const,person:permit.actor.person,sessionId:permit.actor.sessionId,requestId:w.ctx.ctx.requestId},ctx={actor,adminPermit:permit,current:()=>true};
 expect(()=>assertDirectoryAdministrator(ctx,w.root)).not.toThrow();
 expect(()=>assertDirectoryAdministrator({...ctx,adminPermit:{...permit}},w.root)).toThrow();
 expect(()=>assertDirectoryAdministrator({actor,current:()=>true},w.root)).toThrow();
 expect(()=>assertDirectoryAdministrator({...ctx,actor:{...actor,person:w.other}},w.root)).toThrow();
 w.time(6000);expect(()=>assertDirectoryAdministrator(ctx,w.root)).not.toThrow();
 w.policy.assignments=[];w.save(w.policy);expect(()=>assertDirectoryAdministrator(ctx,w.root)).toThrow();
});
it("retains the older configured-root path when no role permit is supplied",async()=>{
 const w=await roleAuthorityWorld();expect(()=>assertDirectoryAdministrator({actor:{kind:"hub-administrator",person:w.root,sessionId:"legacy",requestId:"legacy"},current:()=>true},w.root)).not.toThrow();
});

it("requires both a real admin permit and the auxiliary session's own recent directory authentication", async () => {
 const w=await roleAuthorityWorld(),permit=await w.authority.require(w.ctx.ctx,"hub.admin");
 const actor={kind:"hub-administrator" as const,person:permit.actor.person,sessionId:permit.actor.sessionId,requestId:w.ctx.ctx.requestId};
 expect(w.sessions.recentAuthentication(actor)).toBeNull();
 expect(w.sessions.recentAuthentication(actor,permit)).toBe(100);
 expect(w.sessions.recentAuthentication(actor,{...permit})).toBeNull();
 expect(w.sessions.recentAuthentication({...actor,sessionId:"foreign"},permit)).toBeNull();
 w.time(6000);expect(w.sessions.recentAuthentication(actor,permit)).toBe(100);
 w.time(300001);expect(w.sessions.recentAuthentication(actor,permit)).toBeNull();
});
