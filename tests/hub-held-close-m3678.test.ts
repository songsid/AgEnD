import { messageContentDigest } from "../src/hub/identity.js";
import {afterEach,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
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

const CAP = "question-close-v1";
async function closeAsk(w:Awaited<ReturnType<typeof world>>,messageId:string,link=w.link){
 (link.features as Set<string>).add(CAP);
 return r!.http.receive(r!.frame("question.close",{messageId,exposureId:w.exposureId},link) as never,link) as Promise<any>;
}
it("owner closes an unanswered direct ask once and the asker sees the reason",async()=>{
 const w=await world(),q=await w.ask();
 const closed=await closeAsk(w,q.id);
 expect(closed).toMatchObject({type:"question.close-result",payload:{messageId:q.id,outcome:"closed"}});
 expect(r!.db.prepare("SELECT stage,reason_code FROM hub_messages WHERE id=?").get(q.id)).toEqual({stage:"cancelled",reason_code:"owner-declined"});
 const thread=await r!.call(w.a,"GET",`/hub/v1/rooms/${w.room}/messages`);
 expect(thread.json.messages).toContainEqual(expect.objectContaining({id:q.id,stage:"not-answered",reasonCode:"owner-declined"}));
 expect(await closeAsk(w,q.id)).toMatchObject({payload:{outcome:"closed"}});
});
it("cannot close an ask for another Fleet, owner or exposure",async()=>{
 const w=await world(),q=await w.ask();
 const other=r!.link(randomUUID(),w.owner);
 await expect(closeAsk(w,q.id,other)).rejects.toThrow();
 const wrongOwner=r!.link(w.fleetId,w.person);
 await expect(closeAsk(w,q.id,wrongOwner)).rejects.toThrow();
 await expect(r!.http.receive(r!.frame("question.close",{messageId:q.id,exposureId:randomUUID()},w.link) as never,w.link)).rejects.toThrow();
 expect(r!.db.prepare("SELECT stage FROM hub_messages WHERE id=?").get(q.id)).toEqual({stage:"queued"});
});
it("an answer already received wins; closing never erases it",async()=>{
 const w=await world(),q=await w.ask(),answerId=randomUUID();
 r!.db.prepare("UPDATE hub_messages SET stage='answered',answer_id=? WHERE id=?").run(answerId,q.id);
 expect(await closeAsk(w,q.id)).toMatchObject({payload:{outcome:"answered"}});
 expect(r!.db.prepare("SELECT stage,answer_id FROM hub_messages WHERE id=?").get(q.id)).toEqual({stage:"answered",answer_id:answerId});
});
it("late delivery evidence cannot reopen an owner-closed question",async()=>{
 const w=await world(),q=await w.ask();await closeAsk(w,q.id);
 const msg=r!.db.prepare("SELECT content_digest FROM hub_messages WHERE id=?").get(q.id) as {content_digest:string};
 await r!.http.receive(r!.frame("receipt",{messageId:q.id,contentDigest:msg.content_digest,stage:"delivered",sequence:1,at:Date.now()},w.link) as never,w.link);
 expect(r!.db.prepare("SELECT stage,reason_code FROM hub_messages WHERE id=?").get(q.id)).toEqual({stage:"cancelled",reason_code:"owner-declined"});
});
it("close and its audit commit together; failure leaves the question open",async()=>{
 const w=await world(),q=await w.ask();r!.setAuditFails(true,"question.owner-closed");
 await expect(closeAsk(w,q.id)).rejects.toThrow();
 expect(r!.db.prepare("SELECT stage FROM hub_messages WHERE id=?").get(q.id)).toEqual({stage:"queued"});
});

it("unnegotiated and stale links cannot close",async()=>{
 const w=await world(),q=await w.ask();
 await expect(r!.http.receive(r!.frame("question.close",{messageId:q.id,exposureId:w.exposureId},w.link) as never,w.link)).rejects.toThrow();
 (w.link.features as Set<string>).add(CAP);
 await expect(closeAsk(w,q.id,{...w.link,current:()=>false})).rejects.toThrow();
 expect(r!.db.prepare("SELECT stage FROM hub_messages WHERE id=?").get(q.id)).toEqual({stage:"queued"});
});

it("a late answer cannot disclose after the owner closes",async()=>{
 const w=await world(),q=await w.ask();await closeAsk(w,q.id);
 const answerId=randomUUID(),text="A saved answer",contentDigest=messageContentDigest("answer",text),operationId=randomUUID();
 await expect(r!.http.receive(r!.frame("answer",{messageId:q.id,answerId,text,contentDigest,
  releaseLease:{decisionId:randomUUID(),messageId:q.id,operationId,phase:"release-answer",operationDigest:"a".repeat(64),revocationVersion:1,exposureRevision:1,linkEpoch:w.link.linkEpoch,expiresAt:Date.now()+5000}},w.link) as never,w.link)).rejects.toThrow("denied");
 expect(r!.db.prepare("SELECT stage,answer_id FROM hub_messages WHERE id=?").get(q.id)).toEqual({stage:"cancelled",answer_id:null});
});

it("asking again with a closed message's exact retry key cannot reopen it",async()=>{
 const w=await world(),q=await w.ask();await closeAsk(w,q.id);
 const {idempotency_key:key}=r!.db.prepare("SELECT idempotency_key FROM hub_messages WHERE id=?").get(q.id) as {idempotency_key:string};
 const sent=r!.sent.length;
 const retry=await r!.call(w.a,"POST",`/hub/v1/rooms/${w.room}/messages`,{text:"Question",idempotencyKey:key});
 expect(retry.status).toBe(200);expect(retry.json).toMatchObject({id:q.id,receipt:{stage:"cancelled",reasonCode:"owner-declined"}});
 expect(r!.sent).toHaveLength(sent);expect(r!.db.prepare("SELECT COUNT(*) AS n FROM hub_messages WHERE room_id=?").get(w.room)).toEqual({n:1});
});
