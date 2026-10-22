/**
 * #1737 review (Prism's witnesses, adopted): the startup clear may only clear the marker this boot adopted, and the
 * old copy's folder is named only when it carries no control/format character.
 *
 * The completion is the REAL `startAll` completion block and its `finishStartup(bootUpdateMarker)` handoff, extracted
 * from src/fleet-manager.ts by the TypeScript AST and run against an inert FleetManager (stub adapter, scratch marker,
 * a real RestartProgress and the real requestFullRestart for the newer marker B). No fleet, tmux or service runs.
 */
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { RestartProgress, formatRestartProgressCompletion } from "../src/restart-progress.js";
import { beginUpdateProgress, beginFullRestartProgress, clearUpdateMarker, markCleanupPending, markUpdateInProgress, writeCleanupOutcome, readUpdateProgress, sameUpdateMarker, updateReceiptOf, updateMarkerIdentity, isUpdateInProgress, UPDATE_MARKER_MAX_AGE_MS } from "../src/update-marker.js";
import { retireSystemCopy } from "../src/update-install.js";
import { setLocale } from "../src/locale.js";

const roots:string[]=[];
beforeEach(()=>{setLocale("en");vi.useFakeTimers();vi.setSystemTime(1_000_000);});
afterEach(()=>{vi.useRealTimers();for(const dir of roots.splice(0)) fs.rmSync(dir,{recursive:true,force:true});});
const WARNING="cleanup owed",COMMAND="sudo '/inert/npm' uninstall -g @songsid/agend";
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
function scratch(){const dir=fs.mkdtempSync(join(tmpdir(),"agend-1737-"));roots.push(dir);return dir;}
function inertManager(dataDir:string, editMessage:any){
 const fm=Object.create(FleetManager.prototype) as any;
 const adapter={id:"a",editMessage,sendText:vi.fn().mockResolvedValue({messageId:"fallback"})};
 Object.assign(fm,{dataDir,fleetConfig:{instances:{one:{},two:{}},channel:{group_id:"c"}},adapters:new Map([["a",adapter]]),
 logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()},startNeedsYou:vi.fn(),announceToolPermissionsChange:vi.fn(),tightenInstanceDirectories:vi.fn(),
 fleetLevelSignature:()=>"inert",checkStartupSignatureConsistency:vi.fn(),applyJobStoreCache:{settleAfterRestart:()=>[]},reloadPending:false,
 sweepOrphanedCancelButtons:async()=>{},announceWebChatOnce:async()=>{},configuredStartupInstanceNames:()=>["one","two"],
 lifecycle:{isPaused:()=>false,daemons:new Map([["one",{}],["two",{}]])},findGeneralInstance:()=>null,tipsEnabled:()=>false,
 updateCleanupWatch:null,updateProgressTimer:null,updateProgressEditRunning:false,lastUpdateProgressText:null,updateCompletionTipText:null,
 sendFleetStartCompletionFallback:async(_chat:string,text:string)=>{await adapter.sendText("c",text);return true;}});
 return {fm,adapter};
}
async function completion(fm:any, adapter:any, pending:any, resume=true){
 const source=fs.readFileSync(join(process.cwd(),"src/fleet-manager.ts"),"utf8");
 const ast=ts.createSourceFile("fleet-manager.ts",source,ts.ScriptTarget.ES2022,true);
 let method:ts.MethodDeclaration|undefined, block:ts.Block|undefined;
 function visit(n:ts.Node):void{if(ts.isMethodDeclaration(n)&&n.name.getText(ast)==="startAllWithinDeadline")method=n;ts.forEachChild(n,visit);}visit(ast);
 if(!method?.body)throw Error("startup implementation missing");
 function find(n:ts.Node):void{if(ts.isBlock(n)&&n.statements.some(st=>ts.isVariableStatement(st)&&st.declarationList.declarations.some(d=>d.name.getText(ast)==="completionSummary")))block=n;ts.forEachChild(n,find);}find(method.body);
 if(!block)throw Error("completion moved");const statements=(block as ts.Block).statements;
 const first=statements.findIndex(st=>ts.isVariableStatement(st)&&st.declarationList.declarations.some(d=>d.name.getText(ast)==="configuredNames"));
 if(first<0)throw Error("completion beginning moved");
 const tail=method.body.statements.find(st=>ts.isExpressionStatement(st)&&ts.isCallExpression(st.expression)&&ts.isPropertyAccessExpression(st.expression.expression)&&st.expression.expression.name.text==="finishStartup");
 if(!tail)throw Error("startup finish handoff moved");
 // The boot's own snapshot statement (#1737 review fence), run first — as startAll runs it before the completion.
 const snapshot=method.body.statements.find(st=>ts.isVariableStatement(st)&&st.declarationList.declarations.some(d=>d.name.getText(ast)==="bootUpdateMarker"));
 if(!snapshot)throw Error("boot marker snapshot moved");
 const script=snapshot.getText(ast)+"\n"+statements.slice(first).map(st=>st.getText(ast)).join("\n")+"\n"+tail.getText(ast);
 const progress=new RestartProgress(2,pending.startedAt,fm.logger,{mode:"update"});
 if(resume)await progress.resume({adapter,chatId:"c"},pending.progress.target.messageId);
 const context=createContext({fm,fleet:fm.fleetConfig,topicMode:true,pendingUpdateProgress:pending,pendingProgressOperation:"update",
 startupProgress:progress,progressStart:Promise.resolve(true),updateMarkerIdentity,updateReceiptOf,formatRestartProgressCompletion,t:()=>"fleet ready",Date,
 load:async(name:string)=>{if(name!=="node:module")throw Error("unexpected inert import");return {createRequire:()=>()=>({version:"2.2.1"})};}});
 const js=ts.transpileModule(`(async function(){ ${script} }).call(fm)`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
 .replaceAll("import.meta.url","'file:///inert/compiled.js'").replaceAll("import(","load(").replaceAll("export {};","");
 await runInContext(js,context);
}
function seed(dir:string,age=0){beginUpdateProgress(dir,{adapterId:"a",chatId:"c",messageId:"A"},Date.now()-age);return markCleanupPending(dir)!;}

describe("#1737: the real completion and startup clear — renders a landed outcome, and clears only its own marker",()=>{
 it.each(["before boot","during boot"])("%s: completion executes real render wiring",async order=>{
  const dir=scratch(),receipt=seed(dir);let pending=readUpdateProgress(dir)!;
  writeCleanupOutcome(dir,receipt,{warning:WARNING,cleanupCommand:COMMAND});if(order==="before boot")pending=readUpdateProgress(dir)!;
  const edit=vi.fn().mockResolvedValue(undefined),{fm,adapter}=inertManager(dir,edit);
  await completion(fm,adapter,pending);
  const terminal=edit.mock.calls.map(c=>String(c[2])).find(x=>x.includes("✅ Update complete"));
  expect(terminal).toContain(WARNING);expect(terminal).toContain(COMMAND);expect(readUpdateProgress(dir)).toBeNull();expect(fm.updateCleanupWatch).toBeNull();
 });
 it("#1854: the real completion carries no tip, even with tips enabled and one available",async()=>{
  const dir=scratch();seed(dir);const pending=readUpdateProgress(dir)!;
  const edit=vi.fn().mockResolvedValue(undefined),{fm,adapter}=inertManager(dir,edit);
  Object.assign(fm,{tipsEnabled:()=>true,pickAvailableTip:()=>({id:"tip-x"}),formatTip:()=>"💡 Tip: try /status"});
  await completion(fm,adapter,pending);
  const terminal=edit.mock.calls.map(c=>String(c[2])).find(x=>x.includes("✅ Update complete"));
  expect(terminal).toBe("✅ Update complete — v2.2.1 · 2/2 agents ready (0s)");
 });
 it("real completion fallback includes a landed warning",async()=>{
  const dir=scratch(),receipt=seed(dir);writeCleanupOutcome(dir,receipt,{warning:WARNING,cleanupCommand:COMMAND});
  const {fm,adapter}=inertManager(dir,vi.fn().mockResolvedValue(undefined));
  await completion(fm,adapter,readUpdateProgress(dir),false);
  const text=String(adapter.sendText.mock.calls[0][1]);expect(text).toContain(WARNING);expect(text).toContain(COMMAND);
 });
 it.each([false,true])("pending warning lands during terminal edit=%s: no completion overwrites it",async duringEdit=>{
  const dir=scratch(),receipt=seed(dir),pending=readUpdateProgress(dir)!;
  const edit=vi.fn(async(_c:string,_m:string,text:string)=>{if(duringEdit&&text.includes("✅ Update complete")&&!text.includes(WARNING))writeCleanupOutcome(dir,receipt,{warning:WARNING,cleanupCommand:COMMAND});});
  const {fm,adapter}=inertManager(dir,edit);await completion(fm,adapter,pending);
  if(!duringEdit)writeCleanupOutcome(dir,receipt,{warning:WARNING,cleanupCommand:COMMAND});
  await vi.advanceTimersByTimeAsync(1_000);
  const terminal=edit.mock.calls.filter(c=>String(c[2]).includes("✅ Update complete"));
  expect(String(terminal.at(-1)![2])).toContain(WARNING);expect(readUpdateProgress(dir)).toBeNull();
  if(fm.updateProgressTimer)clearInterval(fm.updateProgressTimer);
 });
 it.each([false,true])("terminal edit yielded and B replaced A (A already rendered=%s): startup clear must keep B",async rendered=>{
  const dir=scratch(),receipt=seed(dir,UPDATE_MARKER_MAX_AGE_MS-1_000);
  if(rendered)writeCleanupOutcome(dir,receipt,{warning:WARNING,cleanupCommand:COMMAND});
  const pending=readUpdateProgress(dir)!,hold=deferred(),entered=deferred();
  const edit=vi.fn(async(_c:string,id:string,text:string)=>{if(id==="A"&&text.includes("✅ Update complete")){entered.resolve();await hold.promise;}});
  const {fm,adapter}=inertManager(dir,edit);const finishing=completion(fm,adapter,pending);await entered.promise;
  await vi.advanceTimersByTimeAsync(1_001);expect(isUpdateInProgress(dir)).toBe(false);
  const restartGrace=deferred();fm.waitForFullRestartIdleGrace=()=>restartGrace.promise;
  const replacing=fm.requestFullRestart(adapter,"c",undefined,"B");const replacement=readUpdateProgress(dir)!;
  expect(replacement.progress.target.messageId).toBe("B");
  try {
    hold.resolve();await finishing;
    expect(readUpdateProgress(dir),"B must survive the old completion's startup clear").toEqual(replacement);
  } finally {
    fm.shuttingDown=true;restartGrace.resolve();await replacing;
    if(fm.updateProgressTimer)clearInterval(fm.updateProgressTimer);
  }
 });
 it("control: unchanged A is cleared after its rendered completion",async()=>{
  const dir=scratch(),receipt=seed(dir);writeCleanupOutcome(dir,receipt,{warning:WARNING});
  const {fm,adapter}=inertManager(dir,vi.fn().mockResolvedValue(undefined));await completion(fm,adapter,readUpdateProgress(dir));expect(readUpdateProgress(dir)).toBeNull();
 });
});
describe("#1737: the old copy's folder is never named with a control or format character",()=>{
 const runner={run:()=>({status:1,signal:null,stdout:"",stderr:""}),log:()=>{}};
 it.each(["\u0085","\u009b","\u202e","\u2028","\u00a0"])("%j → not named",control=>{
  expect(retireSystemCopy(runner,"/inert/npm",`/opt/a${control}/node_modules/@songsid/agend`)).toMatchObject({ok:true,warning:"Old system install was not removed (sudo refused); remove it by hand."});
 });
 it("a plain path is still named (control)",()=>{
  expect(retireSystemCopy(runner,"/inert/npm","/usr/local/lib/node_modules/@songsid/agend")).toMatchObject({ok:true,warning:"Old system install at /usr/local/lib/node_modules/@songsid/agend was not removed (sudo refused); remove it by hand."});
 });
});

describe("#1737: the startup clear, by what the boot adopted", () => {
 it("a plain CLI update marker (no receipt) adopted at boot → cleared", () => {
  const dir = scratch(); markUpdateInProgress(dir);
  const fm = inertManager(dir, vi.fn()).fm, boot = updateMarkerIdentity(dir);
  fm.clearSettledUpdateMarker(boot);
  expect(fs.existsSync(join(dir, "update-in-progress.json"))).toBe(false);
 });
 it("nothing adopted at boot, a marker written since → kept (it is its writer's)", () => {
  const dir = scratch(); const fm = inertManager(dir, vi.fn()).fm;
  beginFullRestartProgress(dir, { adapterId: "a", chatId: "c", messageId: "B" });
  fm.clearSettledUpdateMarker(null);
  expect(readUpdateProgress(dir)?.progress.target.messageId).toBe("B");
 });
 it("the same update's later stage writes keep its identity → still cleared", () => {
  const dir = scratch(); const receipt = seed(dir); const boot = updateMarkerIdentity(dir);
  writeCleanupOutcome(dir, receipt, { warning: WARNING });
  inertManager(dir, vi.fn()).fm.clearSettledUpdateMarker(boot);
  expect(readUpdateProgress(dir)).toBeNull();
 });
 it("an unreadable marker is nobody's → removed", () => {
  const dir = scratch(); fs.writeFileSync(join(dir, "update-in-progress.json"), "{not json");
  inertManager(dir, vi.fn()).fm.clearSettledUpdateMarker(null);
  expect(fs.existsSync(join(dir, "update-in-progress.json"))).toBe(false);
 });
 it("same start time, another receipt (a chat /update whose clock matched) → kept", () => {
  const dir = scratch(); const t = Date.now();
  beginUpdateProgress(dir, { adapterId: "a", chatId: "c", messageId: "A" }, t);
  const boot = updateMarkerIdentity(dir);
  beginUpdateProgress(dir, { adapterId: "a", chatId: "c", messageId: "B" }, t);
  expect(sameUpdateMarker(updateMarkerIdentity(dir), boot)).toBe(false);
  inertManager(dir, vi.fn()).fm.clearSettledUpdateMarker(boot);
  expect(readUpdateProgress(dir)?.progress.target.messageId).toBe("B");
 });
 it("a plain CLI marker adopted, replaced by a newer plain one (another start time) → the newer one is kept", () => {
  const dir = scratch(); markUpdateInProgress(dir, 1_000);
  const boot = updateMarkerIdentity(dir);
  clearUpdateMarker(dir); markUpdateInProgress(dir, 2_000);
  inertManager(dir, vi.fn()).fm.clearSettledUpdateMarker(boot);
  expect(updateMarkerIdentity(dir)?.startedAt).toBe(2_000);
 });
});
