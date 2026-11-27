import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { Daemon } from "../src/daemon.js";
import { RequestContextLocalTurns, type RequestContextRuntimeOwner } from "../src/request-context-turns.js";
import { RequestContextWorkStore,RequestContextPreparedWork } from "../src/request-context-work.js";
import type { RequestContextV1 } from "../src/request-context-protocol.js";
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) fn(); });
function rig() {
 const h = mkdtempSync(join(tmpdir(),"request-work-")); cleanup.push(() => rmSync(h,{recursive:true,force:true}));
 const path = join(h,"box.db"), box = new DeliveryOutbox(path,"boot",{requestContextDispatchVersion:1}); cleanup.push(()=>box.close());
 return {h,path,box,store:box.requestContextWork};
}
it("work reads while Off create no artifacts, and capability without a floor cannot write",()=>{
 const r=rig(); expect(r.store.read("worker")).toBeNull(); expect(()=>r.store.retain({instance:"worker",incarnation:"inc",generation:randomUUID()})).toThrow(/ready/);
 const db=new Database(r.path,{readonly:true});try{expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'request_context_%'").get()).toEqual({n:0});}finally{db.close();}
});
it("the retained generation survives ordinary restart and exact retries, with no backend session lookup",()=>{
 const r=rig();r.box.activateRequestContextBarrier();const input={instance:"worker",incarnation:"inc",generation:randomUUID()};
 expect(r.store.retain(input)).toEqual(input);expect(r.box.requestContextWork.read("worker")).toEqual(input);expect(r.store.retain(input)).toEqual(input);
 expect(()=>r.store.retain({...input,generation:randomUUID()})).toThrow(/differs/);expect(()=>r.store.retain({...input,incarnation:"other"})).toThrow(/differs/);
 const db=new Database(r.path,{readonly:true});try{expect(new RequestContextWorkStore(db,()=>{throw Error("readonly");}).read("worker")).toEqual(input);}finally{db.close();}
});
it("new work uses a generation CAS; an old completion cannot rotate a newer conversation",()=>{
 const r=rig();r.box.activateRequestContextBarrier();const first=r.store.retain({instance:"worker",incarnation:"inc",generation:randomUUID()});
 const next=r.store.rotate(first);expect(next.generation).not.toBe(first.generation);expect(()=>r.store.rotate(first)).toThrow(/changed/);expect(r.store.read("worker")).toEqual(next);
});
it("generation rotation is atomic on final owner loss",()=>{
 const r=rig();r.box.activateRequestContextBarrier();const first=r.store.retain({instance:"worker",incarnation:"inc",generation:randomUUID()});
 const db=new Database(r.path);let checks=0;const lost=new RequestContextWorkStore(db,()=>{if(++checks>1)throw Error("owner lost");});
 try{expect(()=>lost.rotate(first)).toThrow(/owner lost/);expect(r.store.read("worker")).toEqual(first);}finally{db.close();}
});
it("a proven fresh lifecycle transition ends its old turn without relabelling recovery history",()=>{
 const r=rig();r.box.activateRequestContextBarrier();let work=r.store.retain({instance:"worker",incarnation:"inc",generation:randomUUID()});
 const id=randomUUID(),context:RequestContextV1={ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:"fixture",initiatingActor:{kind:"unknown",reason:"unidentified"},ingress:"guest",source:{instance:"worker",incarnation:"inc"},sourceAudience:{kind:"web",ref:id}};
 const d:any=new Daemon("worker",{working_directory:r.h,backend:"claude-code",log_level:"silent"} as any,r.h,true,undefined,undefined,{child(){return this;}} as any);
 const ports=r.box.requestContextRecovery.ports("worker",(inputId,wireSha256,owner)=>({inputId,wireSha256,owner:{...owner},context,proof:{kind:"independent"}}),()=>false);
 const turns=new RequestContextLocalTurns(ports);d.setRequestContextLocalLifecycle(turns,()=>({incarnation:"inc",workGeneration:work.generation}),()=>{work=r.store.rotate(work);});
 const before=d.requestContextOwner() as RequestContextRuntimeOwner,snapshot=turns.beforeWrite("fixture","a".repeat(64),before);
 expect(r.box.requestContextRecovery.pointer("worker")?.workGeneration).toBe(before.workGeneration);
 d.requestContextNewWork("fresh");expect(turns.isCurrent(snapshot,before)).toBe(false);expect(d.requestContextTurnSnapshot()).toBeNull();
 expect(d.requestContextOwner().workGeneration).not.toBe(before.workGeneration);
 expect(r.box.requestContextRecovery.pointer("worker")?.workGeneration).toBe(before.workGeneration);
 expect(()=>turns.beforeWrite(null,"b".repeat(64),d.requestContextOwner())).toThrow(/trustworthy parent/);
});

it("fresh-work hooks are restricted to authoritative spawn/native-start boundaries",async()=>{
 const ts=await import("typescript"),source=ts.createSourceFile("daemon.ts",readFileSync(new URL("../src/daemon.ts",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true);
 const scopes:string[]=[];
 function visit(node:import("typescript").Node,scope="") {
  if(ts.isMethodDeclaration(node))scope=node.name.getText(source);
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==="requestContextNewWork")scopes.push(scope);
  ts.forEachChild(node,child=>visit(child,scope));
 }
 visit(source);expect(scopes.sort()).toEqual(["startAdmitted","spawnClaudeWindow"].sort());
});

it("first-On work stages before pane start without creating artifacts or pretending a backend session is a generation",()=>{
 const r=rig(),work=new RequestContextPreparedWork(r.store,"worker","inc",()=>true,true),first=work.identity();
 expect(work.current()).toBe(true);expect(r.store.read("worker")).toBeNull();expect(()=>work.retainPrepared()).toThrow(/ready/);expect(()=>work.requireRetained()).toThrow(/unavailable/);
 work.fresh();expect(work.identity().workGeneration).not.toBe(first.workGeneration);expect(work.revision).toBe(1);expect(r.store.read("worker")).toBeNull();
 work.dispose();expect(work.current()).toBe(false);expect(()=>work.identity()).toThrow(/owner changed/);expect(()=>work.fresh()).toThrow(/owner changed/);
});
it("work initialization rollback preserves the same prepared identity for a clean retry",()=>{
 const r=rig();r.box.activateRequestContextBarrier();const work=new RequestContextPreparedWork(r.store,"worker","inc",()=>true,true),first=work.identity(),db=(r.box as any).db;
 expect(()=>db.transaction(()=>{work.retainPrepared();expect(()=>work.sealRetained()).toThrow(/not committed/);throw Error("failed install");})()).toThrow(/failed install/);
 expect(work.current()).toBe(true);expect(work.identity()).toEqual(first);expect(r.store.read("worker")).toBeNull();
 db.transaction(()=>work.retainPrepared())();work.sealRetained();expect(work.current()).toBe(true);expect(r.store.read("worker")?.generation).toBe(first.workGeneration);
 db.prepare("DELETE FROM request_context_work_v1 WHERE instance=?").run("worker");expect(work.current()).toBe(false);expect(()=>work.identity()).toThrow(/owner changed/);
});
it("capable restart requires retained work and preserves the conversation across the switch being Off",()=>{
 const r=rig();r.box.activateRequestContextBarrier();expect(()=>new RequestContextPreparedWork(r.store,"worker","inc",()=>true,false)).toThrow(/unavailable/);
 const first=r.store.retain({instance:"worker",incarnation:"inc",generation:randomUUID()}),work=new RequestContextPreparedWork(r.store,"worker","inc",()=>true,false);
 expect(work.identity()).toEqual({incarnation:"inc",workGeneration:first.generation});work.fresh();expect(work.identity().workGeneration).toBe(r.store.read("worker")?.generation);expect(work.identity().workGeneration).not.toBe(first.generation);
 expect(()=>new RequestContextPreparedWork(r.store,"worker","replacement",()=>true,false)).toThrow(/incarnation differs/);
});
it("a stale prepared owner cannot overwrite another owner's work or retain after owner loss",()=>{
 const r=rig();r.box.activateRequestContextBarrier();let live=true;const work=new RequestContextPreparedWork(r.store,"worker","inc",()=>live,true),identity=work.identity();
 const competing=r.store.retain({instance:"worker",incarnation:"inc",generation:randomUUID()});expect(work.current()).toBe(false);expect(()=>work.retainPrepared()).toThrow(/owner changed/);expect(r.store.read("worker")).toEqual(competing);
 const other=new RequestContextPreparedWork(r.store,"other","inc",()=>live,true);live=false;expect(()=>other.retainPrepared()).toThrow(/owner changed/);expect(r.store.read("other")).toBeNull();expect(identity.workGeneration).not.toBe(competing.generation);
});
it.each(["retain","rotate"] as const)("the explicit %s owner guard runs inside the database transaction and rolls back on final loss",op=>{
 const r=rig();r.box.activateRequestContextBarrier();const input={instance:"worker",incarnation:"inc",generation:randomUUID()};if(op==="rotate")r.store.retain(input);
 let reads=0;const guard=()=>++reads===1;
 expect(()=>op==="retain"?r.store.retain(input,guard):r.store.rotate(input,guard)).toThrow(/owner changed/);
 expect(r.store.read("worker")).toEqual(op==="retain"?null:input);
});
it("explicit successor registration CAS retains the predecessor without deleting its contexts",()=>{
 const r=rig();r.box.activateRequestContextBarrier();const old=r.store.retain({instance:"worker",incarnation:"old",generation:randomUUID()});
 const next={...old,incarnation:"new",generation:randomUUID()};expect(r.store.register(next,old,()=>true)).toEqual(next);
 const db=new Database(r.path,{readonly:true});try{expect(db.prepare("SELECT * FROM request_context_retired_work_v1").all()).toEqual([old]);}finally{db.close();}
 expect(()=>r.store.register({...next,incarnation:"other"},old,()=>true)).toThrow(/changed/);
 expect(()=>r.store.register({...next,generation:randomUUID()},next,()=>true)).toThrow(/successor/);
 expect(r.store.read("worker")).toEqual(next);
});
it("a lost registration guard rolls back both the successor and its retired predecessor",()=>{
 const r=rig();r.box.activateRequestContextBarrier();const old=r.store.retain({instance:"worker",incarnation:"old",generation:randomUUID()});let checks=0;
 expect(()=>r.store.register({...old,incarnation:"new",generation:randomUUID()},old,()=>++checks===1)).toThrow(/changed/);
 expect(r.store.read("worker")).toEqual(old);const db=new Database(r.path,{readonly:true});try{expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='request_context_retired_work_v1'").get()).toBeUndefined();}finally{db.close();}
});
