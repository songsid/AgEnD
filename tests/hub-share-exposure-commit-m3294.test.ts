/** A journal receipt participates in one canonical exposure change, before its independent floor advances. */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { HubExposureStore,HUB_EXPOSURE_MIGRATION,publishExposure } from "../src/hub/member/exposures.js";
import type { HubLocalExposure } from "../src/hub/execution/service.js";
const dbs:Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
function world(){
 const db=new Database(":memory:");dbs.push(db);HUB_EXPOSURE_MIGRATION.up(db);
 db.exec("CREATE TABLE applied(id TEXT PRIMARY KEY,revision INTEGER);CREATE TABLE events(body TEXT)");
 let floor=0;const owner={realm:"corp",objectId:randomUUID()},fleetId=randomUUID();
 const store=new HubExposureStore(db,{floor:{read:()=>floor,raise:n=>{floor=n;}},views:new Map(),binding:()=>({owner,fleetId}),
  audit:{appendInTransaction:(event,d)=>{d.prepare("INSERT INTO events VALUES(?)").run(JSON.stringify(event));}}});store.initialize();
 const input={agent:"Docs",providerId:"agent",displayName:"Docs",dataViewId:"agent",allowedTools:[],expectedRevision:0};
 const ready=(c:HubLocalExposure)=>({ok:true as const,policyDigest:c.exposure.policyDigest,exposureRevision:c.exposure.revision});
 const requestId=randomUUID();
 const context={requestId,assertCurrent:()=>undefined,actor:{kind:"person" as const,person:owner},committed:(c:HubLocalExposure)=>{
  expect(db.inTransaction).toBe(true);db.prepare("INSERT INTO applied VALUES(?,?)").run(c.exposure.id,c.exposure.revision);return undefined;
 }};
 return {db,store,input,ready,context,requestId};
}
it("publishes its journal receipt in the same transaction with the trusted request audit provenance",()=>{
 const r=world();const published=publishExposure(r.store,r.input,r.ready,r.context);
 expect(r.db.prepare("SELECT * FROM applied").get()).toEqual({id:published.exposure.id,revision:1});
 const events=r.db.prepare("SELECT body FROM events").all() as {body:string}[];
 expect(events.map(e=>JSON.parse(e.body))).toEqual(expect.arrayContaining([expect.objectContaining({action:"exposure.published",requestId:r.requestId,actor:r.context.actor})]));
});
it("rolls back a failed receipt without publishing and keeps the store floor usable",()=>{
 const r=world();const context={...r.context,committed:(c:HubLocalExposure)=>{r.context.committed(c);throw Error("receipt disk failure");}};
 expect(()=>publishExposure(r.store,r.input,r.ready,context)).toThrow("receipt disk failure");
 expect(r.db.prepare("SELECT * FROM applied").all()).toEqual([]);expect(r.store.snapshot().exposures).toEqual([]);expect(()=>r.store.check()).not.toThrow();
});
it("withdraws and journals together, refusing a changed revision before the receipt",()=>{
 const r=world(),published=publishExposure(r.store,r.input,r.ready);
 expect(()=>r.store.withdraw(published.exposure.id,0,r.context)).toThrow();expect(r.db.prepare("SELECT * FROM applied").all()).toEqual([]);
 const out=r.store.withdraw(published.exposure.id,1,r.context);
 expect(out.exposure.state).toBe("withdrawn");expect(r.db.prepare("SELECT * FROM applied").get()).toEqual({id:out.exposure.id,revision:2});
});
it("refuses a journaled operation inside an outer transaction before advancing any independent floor",()=>{
 const r=world();
 expect(()=>r.db.transaction(()=>publishExposure(r.store,r.input,r.ready,r.context))()).toThrow(/transaction/);
 expect(r.store.check()).toBe(0);expect(r.store.list()).toEqual([]);
});
