import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { Daemon } from "../src/daemon.js";
import { RequestContextLocalTurns, type RequestContextRuntimeOwner } from "../src/request-context-turns.js";
import { RequestContextWorkStore } from "../src/request-context-work.js";
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
