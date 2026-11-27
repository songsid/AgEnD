/** Conversation work identity is owned by lifecycle events, never by backend session discovery or a timer. */
import type Database from "better-sqlite3";
import type {RequestContextDaemonWork} from "./request-context-start.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
const key = z.string().min(1).max(256);
const row = z.strictObject({ instance: key, incarnation: key, generation: z.uuid() });
export type RequestContextWorkIdentity = Readonly<z.infer<typeof row>>;
const TABLE = "request_context_work_v1";
export class RequestContextWorkStore {
 constructor(private readonly db: Database.Database, private readonly writable: () => void) {}
 get transactionOpen():boolean{return this.db.inTransaction;}
 read(instance: string): RequestContextWorkIdentity | null {
  key.parse(instance);
  const table = this.db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(TABLE) as { type: string } | undefined;
  if (!table) return null;
  if (table.type !== "table") throw Error("Request-context work identity unavailable");
  const stored = this.db.prepare(`SELECT instance,incarnation,generation FROM ${TABLE} WHERE instance=?`).get(instance);
  return stored ? Object.freeze(row.parse(stored)) : null;
 }
 /** First activation stages UUIDs in memory, then retains the same identities in its outer transaction. */
 retain(value: RequestContextWorkIdentity, current:()=>boolean=()=>true): RequestContextWorkIdentity {
  const input = row.parse(value); this.writable();if(!current())throw Error("Request-context work owner changed");
  return this.db.transaction(() => {
   const previous = this.read(input.instance);
   if (previous) {
    if (previous.incarnation !== input.incarnation || previous.generation !== input.generation) throw Error("Request-context work identity differs");
    if(!current())throw Error("Request-context work owner changed");return previous;
   }
   this.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(instance TEXT PRIMARY KEY,incarnation TEXT NOT NULL,generation TEXT NOT NULL)`);
   this.db.prepare(`INSERT INTO ${TABLE} VALUES (?,?,?)`).run(input.instance,input.incarnation,input.generation);
   this.writable();if(!current())throw Error("Request-context work owner changed");return this.read(input.instance)!;
  })();
 }
 /** Explicit new-registration CAS, after the owner proves durable lifecycle evidence and old launch/IPC retirement.
  * Old contexts and recovery pointers remain intact. A missing row alone never authorizes this method.
  */
 register(value: RequestContextWorkIdentity, expected: RequestContextWorkIdentity | null, current: () => boolean): RequestContextWorkIdentity {
  const input=row.parse(value),before=expected===null?null:row.parse(expected);
  if(before&&(before.instance!==input.instance||before.incarnation===input.incarnation))throw Error("Request work successor differs");
  this.writable();if(!current())throw Error("Request work registration changed");
  return this.db.transaction(()=>{
   const stored=this.read(input.instance);
   if(JSON.stringify(stored)!==JSON.stringify(before))throw Error("Request work registration changed");
   if(before){
    this.db.exec("CREATE TABLE IF NOT EXISTS request_context_retired_work_v1(instance TEXT NOT NULL,incarnation TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(instance,incarnation,generation))");
    this.db.prepare("INSERT INTO request_context_retired_work_v1 VALUES (?,?,?)").run(before.instance,before.incarnation,before.generation);
    if(this.db.prepare(`UPDATE ${TABLE} SET incarnation=?,generation=? WHERE instance=? AND incarnation=? AND generation=?`)
      .run(input.incarnation,input.generation,before.instance,before.incarnation,before.generation).changes!==1)throw Error("Request work registration changed");
   }else this.retain(input,current);
   this.writable();if(!current())throw Error("Request work registration changed");return this.read(input.instance)!;
  })();
 }
 /** Only a proven fresh lifecycle boundary calls this. A written Clear, compact and session discovery do not prove one. */
 rotate(expected: RequestContextWorkIdentity, current:()=>boolean=()=>true): RequestContextWorkIdentity {
  const before = row.parse(expected); this.writable();if(!current())throw Error("Request-context work owner changed");
  return this.db.transaction(() => {
   const stored = this.read(before.instance);
   if (!stored || stored.incarnation !== before.incarnation || stored.generation !== before.generation) throw Error("Request-context work identity changed");
   const next = { ...before, generation: randomUUID() };
   if (this.db.prepare(`UPDATE ${TABLE} SET generation=? WHERE instance=? AND incarnation=? AND generation=?`)
    .run(next.generation,before.instance,before.incarnation,before.generation).changes !== 1) throw Error("Request-context work identity changed");
   // Recovery history remains explainable. Its old generation is not adopted into the new work, and is
   // resolved explicitly by the owning recovery/clear action rather than silently relabelled or reset here.
   this.writable();if(!current())throw Error("Request-context work owner changed");return Object.freeze(next);
  })();
 }
}

/** One prepared replacement's work port. Staging is allowed only for a never-activated home by its installer. */
export class RequestContextPreparedWork implements RequestContextDaemonWork {
 private value:RequestContextWorkIdentity;
 private retainedRequired:boolean;
 private alive=true;
 private serial=0;
 constructor(private readonly store:RequestContextWorkStore,instance:string,incarnation:string,
  private readonly ownerCurrent:()=>boolean,allowFirstActivationStaging:boolean){
  key.parse(instance);key.parse(incarnation);
  const existing=store.read(instance);
  if(existing&&existing.incarnation!==incarnation)throw Error("Request-context work incarnation differs");
  if(!existing&&!allowFirstActivationStaging)throw Error("Retained request-context work is unavailable");
  this.retainedRequired=!!existing;
  this.value=Object.freeze(existing??{instance,incarnation,generation:randomUUID()});
  if(!this.current())throw Error("Request-context work owner changed");
 }
 current():boolean {
  try{
   if(!this.alive||!this.ownerCurrent())return false;
   const stored=this.store.read(this.value.instance);
   return stored?stored.incarnation===this.value.incarnation&&stored.generation===this.value.generation:!this.retainedRequired;
  }catch{return false;}
 }
 get revision():number{return this.serial;}
 identity():Readonly<{incarnation:string;workGeneration:string}>{
  if(!this.current())throw Error("Request-context work owner changed");
  return Object.freeze({incarnation:this.value.incarnation,workGeneration:this.value.generation});
 }
 /** Called synchronously inside activation's outer transaction; a rollback changes no local phase. */
 retainPrepared():void {
  if(!this.current())throw Error("Request-context work owner changed");
  this.store.retain(this.value,()=>this.current());
 }
 requireRetained():void {
  if(!this.current()||!this.store.read(this.value.instance))throw Error("Retained request-context work is unavailable");
 }
 /** Seal only after the outer COMMIT; failed initialization cannot leave a memory-only durable phase. */
 sealRetained():void {
  if(this.store.transactionOpen)throw Error("Request-context work has not committed");
  this.requireRetained();this.retainedRequired=true;
 }
 /** Actual fresh-launch lifecycle only. Existing capable homes rotate durably even while the switch is Off. */
 fresh():void {
  if(!this.current())throw Error("Request-context work owner changed");
  const previous=this.value,stored=this.store.read(previous.instance);
  if(stored){
   this.value=this.store.rotate(previous,()=>this.alive&&this.ownerCurrent());this.retainedRequired=true;
  }else{
   const next=Object.freeze({...previous,generation:randomUUID()});
   if(!this.alive||!this.ownerCurrent())throw Error("Request-context work owner changed");
   this.value=next;
  }
  this.serial++;
 }
 dispose():void{if(this.alive){this.alive=false;this.serial++;}}
}
