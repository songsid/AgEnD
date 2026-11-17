import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach,expect,it } from "vitest";
import { HUB_EXPOSURE_MIGRATION,HubExposureStore,publishExposure,type HubExposureCommit } from "../src/hub/member/exposures.js";
import { HUB_MEMBER_SHARING_MIGRATION,HUB_SHARING_UNDO_MS,HubMemberSharingJournal,type SharingPlan } from "../src/hub/member/sharing-journal.js";
import type { HubLocalExposure } from "../src/hub/execution/service.js";
const dbs:Database.Database[]=[];afterEach(()=>{for(const db of dbs.splice(0))db.close();});
function world(){
 const db=new Database(":memory:");dbs.push(db);HUB_EXPOSURE_MIGRATION.up(db);HUB_MEMBER_SHARING_MIGRATION.up(db);
 let floor=0,now=1_800_000_000_000,live=true,token="a".repeat(64);
 const owner={realm:"corp",objectId:randomUUID()},fleetId=randomUUID(),binding="owned-pairing";
 const store=new HubExposureStore(db,{floor:{read:()=>floor,raise:n=>{floor=n;}},views:new Map(),binding:()=>({owner,fleetId}),audit:{appendInTransaction:()=>{}}});store.initialize();
 const options={db,binding,owner,fleetId,agentToken:()=>token,current:()=>live,now:()=>now};const journal=new HubMemberSharingJournal(options);
 const id=randomUUID(),request={by:owner,catalogRevision:"a".repeat(64),share:["Docs"],stop:[],createdAt:now,expiresAt:now+600_000};
 const plan:SharingPlan={action:"share",target:"Docs",agent:"Docs",name:"Documents",kind:"agent",incarnation:token,before:null};
 const input={agent:"Docs",providerId:"agent",displayName:"Documents",dataViewId:"agent",allowedTools:[],expectedRevision:0};
 const ready=(c:HubLocalExposure)=>({ok:true as const,policyDigest:c.exposure.policyDigest,exposureRevision:c.exposure.revision});
 const receipt=(op=id,undo=false):HubExposureCommit=>({requestId:undo?journal.read(op)!.undoId!:op,actor:{kind:"person",person:owner},assertCurrent:()=>{if(!live)throw Error("stale");return undefined;},
  committed:c=>undo?journal.undone(op,0,c):journal.applied(op,0,c)});
 const notice=(op=id)=>{journal.prepareNotice(op);journal.noticeSaved(op);};
 return {db,store,journal,options,id,request,plan,input,ready,receipt,notice,setNow:(n:number)=>{now=n;},get now(){return now;},setLive:(v:boolean)=>{live=v;},replace:()=>{token="b".repeat(64);}};
}
it("freezes exact owner intent, reopens the same record, and keeps committed outcomes after request expiry",()=>{
 const r=world();r.journal.reserve(r.id,r.request,[r.plan]);r.notice();const applied=publishExposure(r.store,r.input,r.ready,r.receipt());r.journal.finalNoticeSaved(r.id);
 const reopened=new HubMemberSharingJournal(r.options);expect(reopened.reserve(r.id,r.request,[]).rows[0].after).toEqual(applied);
 expect(()=>reopened.reserve(r.id,{...r.request,share:["Other"]},[])).toThrow(/conflict/);
 r.setNow(r.request.expiresAt);expect(reopened.reserve(r.id,r.request,[]).rows[0].outcome).toEqual({ok:true});
 expect(()=>reopened.reserve(randomUUID(),r.request,[r.plan])).toThrow(/expired/);
 expect(()=>reopened.reserve(randomUUID(),{...r.request,by:{realm:"corp",objectId:randomUUID()}},[r.plan])).toThrow(/denied/);
 expect(new HubMemberSharingJournal({...r.options,binding:"other-pairing"}).read(r.id)).toBeNull();
});
it("cannot commit an exposure receipt until the notice is durable, or outside the writer transaction",()=>{
 const r=world();r.journal.reserve(r.id,r.request,[r.plan]);r.journal.prepareNotice(r.id);
 expect(()=>publishExposure(r.store,r.input,r.ready,r.receipt())).toThrow(/conflict/);
 expect(r.store.snapshot().exposures).toEqual([]);expect(r.journal.read(r.id)!.rows[0].outcome).toBeNull();
 r.journal.noticeRefused(r.id);expect(r.journal.read(r.id)!.noticeAt).toBeNull();r.notice();
 const applied=publishExposure(r.store,r.input,r.ready,r.receipt());
 expect(()=>r.journal.applied(r.id,0,applied)).toThrow(/transaction/);
});
it("keeps a stable notice deadline and rejects final acknowledgement before the row and final notice",()=>{
 const r=world();r.journal.reserve(r.id,r.request,[r.plan]);r.notice();const first=r.journal.read(r.id)!;
 r.setNow(r.now+1000);expect(r.journal.prepareNotice(r.id).undoUntil).toBe(first.undoUntil);
 expect(()=>r.journal.finalNoticeSaved(r.id)).toThrow(/conflict/);expect(()=>r.journal.acknowledge(r.id)).toThrow(/conflict/);
 r.journal.refuse(r.id,0,"not-shareable");r.journal.finalNoticeSaved(r.id);r.journal.acknowledge(r.id);expect(r.journal.pending()).toEqual([]);
 expect(()=>r.journal.refuse(r.id,0,"expired")).toThrow(/conflict/);
});
it("Undo share uses a fresh canonical withdrawal and one durable undo identity",()=>{
 const r=world();r.journal.reserve(r.id,r.request,[r.plan]);r.notice();const pub=publishExposure(r.store,r.input,r.ready,r.receipt());r.journal.finalNoticeSaved(r.id);
 const undo=r.journal.beginUndo(r.id,"Fleet admin");expect(r.journal.beginUndo(r.id,"Other admin").undoId).toBe(undo.undoId);
 const stopped=r.store.withdraw(pub.exposure.id,1,r.receipt(r.id,true));expect(stopped.exposure.state).toBe("withdrawn");
 expect(r.journal.read(r.id)!.rows[0].undoAfter).toEqual(stopped);expect(()=>r.journal.acknowledge(r.id,true)).toThrow(/conflict/);r.journal.undoNoticeSaved(r.id);r.journal.acknowledge(r.id,true);
 expect(r.journal.read(r.id)!.undoAcked).toBe(true);
});
it("Undo stop republishes through fresh consent and preserves the saved contact restriction",()=>{
 const r=world();const pub=publishExposure(r.store,{...r.input,contactLimit:false},r.ready);
 const request={...r.request,share:[],stop:[pub.exposure.id]};const plan={...r.plan,action:"stop" as const,target:pub.exposure.id,before:pub};
 r.journal.reserve(r.id,request,[plan]);r.notice();const stopped=r.store.withdraw(pub.exposure.id,1,r.receipt());r.journal.finalNoticeSaved(r.id);r.journal.beginUndo(r.id,"Fleet admin");
 const restored=publishExposure(r.store,{...r.input,expectedRevision:stopped.exposure.revision,contactLimit:pub.contactLimit},r.ready,r.receipt(r.id,true));
 expect(restored.consentId).not.toBe(pub.consentId);expect(restored.exposure.revision).toBe(3);expect(restored.contactLimit).toBe(false);
 expect(r.journal.read(r.id)!.rows[0].undoOutcome).toEqual({ok:true});
});
it("refuses a replacement incarnation and the exact Undo deadline without mutating the exposure",()=>{
 const r=world();r.journal.reserve(r.id,r.request,[r.plan]);r.notice();const pub=publishExposure(r.store,r.input,r.ready,r.receipt());r.journal.finalNoticeSaved(r.id);r.journal.beginUndo(r.id,"Admin");
 r.replace();expect(()=>r.store.withdraw(pub.exposure.id,1,r.receipt(r.id,true))).toThrow(/stale/);expect(r.store.exposure(pub.exposure.id)!.state).toBe("published");
 const deadline=r.journal.read(r.id)!.undoUntil!;r.setNow(deadline);expect(()=>r.store.withdraw(pub.exposure.id,1,r.receipt(r.id,true))).toThrow(/expired/);
 expect(deadline).toBe(r.request.createdAt+HUB_SHARING_UNDO_MS);expect(r.journal.read(r.id)!.rows[0].undoOutcome).toBeNull();
});
it("does not apply an uncommitted row at the request deadline and fences corrupted records",()=>{
 const r=world();r.journal.reserve(r.id,r.request,[r.plan]);r.notice();r.setNow(r.request.expiresAt);
 expect(()=>publishExposure(r.store,r.input,r.ready,r.receipt())).toThrow(/expired/);expect(r.store.snapshot().exposures).toEqual([]);
 r.db.prepare("UPDATE hub_member_sharing_requests SET body='{}' WHERE id=?").run(r.id);expect(()=>r.journal.read(r.id)).toThrow(/uncertain/);
});
