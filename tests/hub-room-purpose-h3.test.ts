import {afterEach,expect,it} from "vitest";
import {s3bRig} from "./helpers/hub-s3b-rig.js";
import {personKeyString} from "../src/hub/identity.js";
let rig:Awaited<ReturnType<typeof s3bRig>>|undefined;
afterEach(async()=>{await rig?.close();rig=undefined;});
it("stores an optional purpose, exposes it only to room members, and keeps old create input valid",async()=>{
 const r=rig=await s3bRig({realAudit:true}),member=r.addPerson("member","Member"),outsider=r.addPerson("outsider","Outsider"),a=await r.signIn("admin"),m=await r.signIn("member"),o=await r.signIn("outsider");
 const made=await r.call(a,"POST","/hub/v1/rooms",{name:"Release room",purpose:"Release questions",people:[personKeyString(member)]});expect(made.status).toBe(200);const id=made.json.room.id;
 expect(made.json.room.purpose).toBe("Release questions");
 expect((await r.call(m,"GET",`/hub/v1/rooms/${id}`)).json.room.purpose).toBe("Release questions");
 expect((await r.call(m,"GET","/hub/v1/rooms?v=2")).json.rooms.find((room:any)=>room.id===id).purpose).toBe("Release questions");
 expect([403,404]).toContain((await r.call(o,"GET",`/hub/v1/rooms/${id}`)).status);
 expect((await r.call(o,"GET","/hub/v1/rooms?v=2")).json.rooms.some((room:any)=>room.id===id)).toBe(false);
 const old=await r.call(a,"POST","/hub/v1/rooms",{name:"Old client"});expect(old.status).toBe(200);expect(old.json.room.purpose).toBe("");
});
it("only managers change it; changes retain structured localized events and bound fallback text",async()=>{
 const r=rig=await s3bRig({realAudit:true}),member=r.addPerson("member","Member"),a=await r.signIn("admin"),m=await r.signIn("member");
 const made=await r.call(a,"POST","/hub/v1/rooms",{name:"Room",people:[personKeyString(member)]}),id=made.json.room.id;
 expect((await r.call(m,"PATCH",`/hub/v1/rooms/${id}`,{purpose:"forged"})).status).toBe(403);
 expect((await r.call(a,"PATCH",`/hub/v1/rooms/${id}`,{purpose:"  cafe\u0301\n questions  "})).status).toBe(200);
 await r.restartHttp();
 const rows=(await r.call(m,"GET",`/hub/v1/rooms/${id}/messages`)).json.messages;
 expect(rows.at(-1)).toMatchObject({system:{kind:"purpose-changed",name:"Hub Admin",purpose:"café questions"},text:"Hub Admin set the purpose: café questions"});
 const before=rows.length;await r.call(a,"PATCH",`/hub/v1/rooms/${id}`,{purpose:"café questions"});expect((await r.call(m,"GET",`/hub/v1/rooms/${id}/messages`)).json.messages).toHaveLength(before);
 await r.call(a,"PATCH",`/hub/v1/rooms/${id}`,{purpose:""});
 expect((await r.call(m,"GET",`/hub/v1/rooms/${id}/messages`)).json.messages.at(-1)).toMatchObject({system:{kind:"purpose-changed",purpose:""},text:"Hub Admin cleared the purpose."});
 expect(r.db.prepare("SELECT COUNT(*) n FROM hub_audit WHERE action='room.purpose-changed'").get()).toEqual({n:2});
});
it("caps visible characters at 200 without shortening accepted input",async()=>{
 const r=rig=await s3bRig(),a=await r.signIn("admin"),emoji="👨‍👩‍👧‍👦";
 const made=await r.call(a,"POST","/hub/v1/rooms",{name:"Room",purpose:emoji.repeat(200)});expect(made.status).toBe(200);expect(made.json.room.purpose).toBe(emoji.repeat(200));
 expect((await r.call(a,"PATCH",`/hub/v1/rooms/${made.json.room.id}`,{purpose:emoji.repeat(201)})).status).toBe(400);
});
it("keeps strict legacy Fleet room-list and members frames unchanged",async()=>{
 const {randomUUID}=await import("node:crypto"),{parseServerFrame}=await import("../src/hub/protocol.js");
 const r=rig=await s3bRig(),a=await r.signIn("admin"),link=r.link(randomUUID(),r.admin,1,["welcome-caps-v1","room-ask-v1","room-post-v1"]),id=randomUUID();
 await r.http.receive(r.frame("exposure.snapshot",{revision:1,exposures:[{id,fleetId:link.fleetId,owner:r.admin,displayName:"Guide",revision:1,state:"published",dataViewId:"agent",allowedTools:[],policyDigest:"b".repeat(64)}]},link) as never,link);
 const made=await r.call(a,"POST","/hub/v1/rooms",{name:"Room",purpose:"Release questions",agents:[id]});expect(made.status).toBe(200);
 const list:any=await r.http.receive(r.frame("room.list",{exposureId:id},link) as never,link);expect(list.payload).toMatchObject({ok:true,rooms:[{id:made.json.room.id,name:"Room"}]});expect(list.payload.rooms[0]).not.toHaveProperty("purpose");expect(()=>parseServerFrame(JSON.stringify(list))).not.toThrow();
 const members:any=await r.http.receive(r.frame("room.members",{exposureId:id,room:made.json.room.id},link) as never,link);expect(members.payload.ok).toBe(true);expect(members.payload).not.toHaveProperty("purpose");expect(()=>parseServerFrame(JSON.stringify(members))).not.toThrow();
});
