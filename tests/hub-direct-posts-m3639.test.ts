import {afterEach,expect,it} from "vitest";
import {randomUUID,createHash} from "node:crypto";
import {s3bRig} from "./helpers/hub-s3b-rig.js";
const HUB_DIRECT_POST_CAPABILITY="direct-posts-v1";
let r:Awaited<ReturnType<typeof s3bRig>>|undefined;
afterEach(async()=>{await r?.close();r=undefined;});
async function world(){
  r=await s3bRig({attachments:true,realAudit:true});const owner=r.addPerson("owner","Demo owner"),person=r.addPerson("reader","Demo reader"),fleetId=randomUUID(),exposureId=randomUUID();
  const link=r.link(fleetId,owner);for(const f of [HUB_DIRECT_POST_CAPABILITY,"welcome-caps-v1","room-ask-v1","room-post-v1","attachments-v1"])(link.features as Set<string>).add(f);
  await r.http.receive(r.frame("exposure.snapshot",{revision:1,exposures:[{id:exposureId,fleetId,owner,displayName:"Demo agent",revision:1,state:"published",dataViewId:"v",allowedTools:[],policyDigest:"b".repeat(64)}]},link) as never,link);
  const o=await r.signIn("owner"),a=await r.signIn("reader");
  const grant=await r.call(o,"POST","/hub/v1/grants",{exposureId,exposureRevision:1,login:"reader",days:7});expect(grant.status).toBe(200);
  const opened=await r.call(a,"POST","/hub/v1/rooms",{exposureId,grantId:grant.json.grant.id});expect(opened.status).toBe(200);const room=opened.json.room.id;
  async function post(text="Follow-up",extra:Record<string,unknown>={}){const result=await r!.http.receive(r!.frame("room.post",{exposureId,room,text,direct:true,idempotencyKey:randomUUID(),...extra},link) as never,link) as any;return result.payload;}
  async function ask(){const response=await r!.call(a,"POST",`/hub/v1/rooms/${room}/messages`,{text:"Question",idempotencyKey:randomUUID()});expect(response.status).toBe(200);return response.json;}
  return {o,a,owner,person,fleetId,exposureId,link,room,post,ask,grantId:grant.json.grant.id};
}
it("requires a previous question; lists verified direct names only on opted-in links",async()=>{
 const w=await world();expect(await w.post()).toMatchObject({ok:false,code:"not-found"});await w.ask();
 const list=await r!.http.receive(r!.frame("room.list",{exposureId:w.exposureId},w.link) as never,w.link) as any;
 expect(list.payload.rooms).toContainEqual({id:w.room,name:"Demo reader",kind:"direct"});
 (w.link.features as Set<string>).delete(HUB_DIRECT_POST_CAPABILITY);
 const old=await r!.http.receive(r!.frame("room.list",{exposureId:w.exposureId},w.link) as never,w.link) as any;expect(old.payload.rooms).toEqual([]);
 expect(await w.post()).toMatchObject({ok:false});
});
it("commits standalone text once, merges history and unread without an answer placeholder, and marks it read",async()=>{
 const w=await world();await w.ask();const key=randomUUID(),sent=await w.post("Ready",{idempotencyKey:key});expect(sent).toMatchObject({ok:true,roomId:w.room});
 expect(await w.post("Ready",{idempotencyKey:key})).toEqual(sent);expect(await w.post("Changed",{idempotencyKey:key})).toMatchObject({ok:false,code:"conflict"});
 const page=await r!.call(w.a,"GET",`/hub/v1/rooms/${w.room}/messages`);const standalone=page.json.messages.find((m:any)=>m.id===sent.messageId);
 expect(standalone).toMatchObject({text:"Ready",author:{kind:"agent"}});expect(standalone).not.toHaveProperty("answerTo");expect(standalone).not.toHaveProperty("stage");
 const list=await r!.call(w.a,"GET","/hub/v1/rooms?v=2");expect(list.json.rooms[0].unread).toBe(1);
 expect((await r!.call(w.a,"POST",`/hub/v1/rooms/${w.room}/read`,{upTo:sent.messageId})).status).toBe(200);
 expect((await r!.call(w.a,"GET","/hub/v1/rooms?v=2")).json.rooms[0].unread).toBe(0);
 expect(JSON.stringify(r!.db.prepare("SELECT * FROM hub_direct_posts").all())).not.toContain('Ready');
 const before=await r!.call(w.a,"GET",`/hub/v1/rooms/${w.room}/messages?before=${sent.messageId}`);expect(before.status).toBe(200);expect(before.json.messages.some((m:any)=>m.id===sent.messageId)).toBe(false);
});
it("mute is person-only, immediate, persistent and does not block ordinary questions",async()=>{
 const w=await world();await w.ask();
 expect((await r!.call(w.o,"PATCH",`/hub/v1/rooms/${w.room}`,{directMessagesMuted:true})).status).not.toBe(200);
 expect((await r!.call(w.a,"PATCH",`/hub/v1/rooms/${w.room}`,{directMessagesMuted:true})).status).toBe(200);
 expect((await r!.call(w.a,"GET",`/hub/v1/rooms/${w.room}`)).json.room.directMessagesMuted).toBe(true);
 expect(await w.post()).toMatchObject({ok:false,message:expect.stringContaining("turned off")});await w.ask();
 expect((await r!.call(w.a,"PATCH",`/hub/v1/rooms/${w.room}`,{directMessagesMuted:false})).status).toBe(200);expect(await w.post()).toMatchObject({ok:true});
});
it("refuses pause, expired grant, withdrawn share, inactive person and stale link without any delivery",async()=>{
 const w=await world();await w.ask();
 r!.db.prepare("UPDATE hub_exposures SET sharing_paused=1 WHERE id=?").run(w.exposureId);expect(await w.post()).toMatchObject({ok:false,message:expect.stringContaining("paused")});r!.db.prepare("UPDATE hub_exposures SET sharing_paused=0 WHERE id=?").run(w.exposureId);
 r!.setEligible("reader",false);expect(await w.post()).toMatchObject({ok:false,message:expect.stringContaining("active")});r!.setEligible("reader",true);
 r!.db.prepare("UPDATE hub_grants SET expires_at=0 WHERE id=?").run(w.grantId);expect(await w.post()).toMatchObject({ok:false});
 expect(r!.db.prepare("SELECT COUNT(*) AS n FROM hub_direct_posts").get()).toEqual({n:0});
});
it("keeps the loop guard without an hourly cap",async()=>{
 const w=await world();await w.ask();expect(await w.post("same")).toMatchObject({ok:true});expect(await w.post("same")).toMatchObject({ok:false,code:"conflict",message:expect.stringContaining("minute")});
 for(let i=0;i<31;i++)expect(await w.post(`part ${i}`)).toMatchObject({ok:true});
});
it("binds staged files by content; same text with different contents is not a duplicate",async()=>{
 const w=await world();await w.ask();
 async function file(text:string,name="part.txt") {const bytes=Buffer.from(text),id=randomUUID(),sha256=createHash("sha256").update(bytes).digest("hex");
  await r!.http.receive(r!.frame("attachment.put",{id,offset:0,total:bytes.length,sha256,data:bytes.toString("base64")},w.link) as never,w.link);
  return {id,name,size:bytes.length,mime:"text/plain",sha256};}
 const first=await w.post("Here is the next part",{attachments:[await file("first")]});expect(first).toMatchObject({ok:true});
 expect(await w.post("Here is the next part",{attachments:[await file("second")]})).toMatchObject({ok:true});
 expect(await w.post("Here is the next part",{attachments:[await file("second","renamed.txt")]})).toMatchObject({ok:false,code:"conflict"});
 const page=await r!.call(w.a,"GET",`/hub/v1/rooms/${w.room}/messages`),message=page.json.messages.find((m:any)=>m.id===first.messageId);expect(message.files[0]).toMatchObject({name:"part.txt"});
 expect((await r!.call(w.a,"GET",message.files[0].url)).status).toBe(200);
});
it("refuses closed chats, foreign sources and retired links, with no post or file binding",async()=>{
 const w=await world();await w.ask();
 expect(await w.post("Wrong source",{exposureId:randomUUID()})).toMatchObject({ok:false,code:"not-found"});
 r!.db.prepare("UPDATE hub_rooms SET state='closed' WHERE id=?").run(w.room);expect(await w.post()).toMatchObject({ok:false,message:expect.stringContaining("closed")});r!.db.prepare("UPDATE hub_rooms SET state='active' WHERE id=?").run(w.room);
 r!.db.prepare("UPDATE hub_exposures SET state='withdrawn' WHERE id=?").run(w.exposureId);expect(await w.post()).toMatchObject({ok:false,message:expect.stringContaining("shared")});r!.db.prepare("UPDATE hub_exposures SET state='published' WHERE id=?").run(w.exposureId);
 w.link.alive=false;await expect(w.post()).rejects.toThrow("stale");
 expect(r!.db.prepare("SELECT COUNT(*) AS n FROM hub_direct_posts").get()).toEqual({n:0});
});
it("rolls back standalone content, files and dedupe admission when its audit fails",async()=>{
 const w=await world();await w.ask();r!.setAuditFails(true,"direct-message.post");
 await expect(w.post()).rejects.toThrow("disk full");expect(r!.db.prepare("SELECT COUNT(*) AS n FROM hub_direct_posts").get()).toEqual({n:0});
 r!.setAuditFails(false);expect(await w.post()).toMatchObject({ok:true});
});
it("does not repeat an ordinary answer as a standalone post within a minute",async()=>{
 const w=await world(),q=await w.ask(),text="The answer",answerId=randomUUID(),digest=createHash("sha256").update(text).digest("hex");
 const release=await r!.http.receive(r!.frame("authorize.request",{messageId:q.id,operationId:randomUUID(),exposureRevision:1,phase:"release-answer",answer:{answerId,contentDigest:digest}},w.link) as never,w.link) as any;expect(release.payload.ok).toBe(true);
 await r!.http.receive(r!.frame("answer",{messageId:q.id,answerId,text,contentDigest:digest,releaseLease:release.payload.lease},w.link) as never,w.link);
 expect(await w.post(text)).toMatchObject({ok:false,code:"conflict"});expect(await w.post("Extra details")).toMatchObject({ok:true});
});
