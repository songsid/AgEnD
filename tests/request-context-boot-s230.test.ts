import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { RequestContextBoot, readRequestContextBootState } from "../src/request-context-boot.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setProcessFleetLock, releaseProcessFleetLock } from "../src/fleet-lock.js";
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) fn(); });
function home() { const h = mkdtempSync(join(tmpdir(), "request-boot-")); cleanup.push(() => rmSync(h, { recursive: true, force: true })); return h; }
function activated(h = home()) {
 const path = join(h, "delivery-outbox.db"), box = new DeliveryOutbox(path, "old", { requestContextDispatchVersion: 1, requestContextRelayVersion: 1 });
 const row = box.admit({ sourceInstance: "source", sourceDaemonBootId: "old-source", targetInstance: "target", operationId: "op", sourceKey: "key", kind: "fleet_inbound", payload: { content: "synthetic" } }).delivery;
 box.claimNext("old", () => "target-old", new Set());
 const state = box.requestContextInstallation().activate({ epoch: "epoch", owner: "durable-fleet", activatedAt: 100, invalidates: [], offeredLatestDeadline: null }, { owner: "durable-fleet", current: () => true }, { current: () => true, release() {} }, () => true, 0);
 box.close(); return { h, path, state, row };
}
function manager(h: string): any {
 const m: any = Object.create(FleetManager.prototype);
 Object.assign(m, { dataDir: h, managerBootId: "new-boot", lifecycle: { daemons: new Map() }, logger: { info() {}, error() {} },
  initializeWorkingRecovery: vi.fn(), sweepContactAuthorizationOutcomes: vi.fn(), scheduleDeliveryOutboxPump: vi.fn(),
  createWakeCoordinator: () => ({ start() {}, kick() {} }) });
 cleanup.push(() => { clearInterval(m.replyObligationTimer); m.deliveryOutbox?.close(); }); return m;
}
function lock(h: string) {
 const record = { pid: process.pid, nonce: "fixture", createdAt: new Date().toISOString(), role: "fleet" as const };
 const serialized = JSON.stringify(record), path = join(h, "fleet.lock"); writeFileSync(path, serialized);
 setProcessFleetLock({ path, record, serialized }); cleanup.push(() => { releaseProcessFleetLock(); }); return path;
}
it("a missing DB is inspected without creation; a legacy startup installs no gate or scoped artifacts", () => {
 const h = home(); expect(readRequestContextBootState(h)).toBeNull(); expect(existsSync(join(h, "delivery-outbox.db"))).toBe(false);
 const m = manager(h); m.ensureDeliveryOutbox(); expect(m.requestContextBoot).toBeUndefined(); expect(m.requestContextAdmission).toBeUndefined(); expect(m.requestContextPolicy).toBeUndefined();
 expect(m.deliveryOutbox.requestContextInstallation().read()).toBeNull();
 const db = new Database(join(h, "delivery-outbox.db"), { readonly: true });
 try { expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'request_context_%'").get()).toEqual({ n: 0 }); } finally { db.close(); }
});
it("production startup holds every input and rejects unprepared owners before activated outbox recovery", () => {
 const r = activated(), path = lock(r.h), m = manager(r.h);
 const recovery = vi.spyOn(DeliveryOutbox.prototype, "recoverForBoot");
 let observed = false;
 recovery.mockImplementation(function(this: DeliveryOutbox, ...args) {
  expect(m.requestContextAdmission.available()).toBe(false); expect(m.requestContextBoot.recoveryCurrent()).toBe(true);
  expect(() => m.prepareRequestContextStart("target", {})).toThrow(/preparation unavailable/);
  expect(() => m.requestContextPolicy.assert({ instance: "target", tool: "send_to_instance", args: {} })).toThrow(/fenced/);
  observed = true; return { queued: 0, reconciliationPending: 0 };
 });
 m.ensureDeliveryOutbox(); expect(observed).toBe(true); expect(m.deliveryOutbox.get(r.row.deliveryId).managerBootId).toBe("old");
 expect(m.requestContextBoot.owner.owner).toBe("durable-fleet");
 writeFileSync(path, "different owner"); expect(m.requestContextBoot.recoveryCurrent()).toBe(false);
 expect(() => m.deliveryOutbox.recoverForBoot("later")).toThrow();
});
it("actual capable recovery under the retained fence preserves queued work without publishing input", () => {
 const r = activated(); lock(r.h); const m = manager(r.h); m.ensureDeliveryOutbox();
 expect(m.deliveryOutbox.get(r.row.deliveryId)).toMatchObject({ state: "queued" });
 expect(m.requestContextAdmission.available()).toBe(false); expect(m.requestContextPolicy.installedMode()).toBeNull();
});
it("an activated home with no exact process Fleet lock cannot open or mutate recovery", () => {
 const r = activated(), m = manager(r.h); expect(() => m.ensureDeliveryOutbox()).toThrow(); expect(m.deliveryOutbox).toBeUndefined();
 const db = new Database(r.path, { readonly: true }); try {
  expect(db.prepare("SELECT state,manager_boot_id FROM deliveries WHERE delivery_id=?").get(r.row.deliveryId)).toEqual({ state: "delivering", manager_boot_id: "old" });
 } finally { db.close(); }
});
it("partial activation metadata, unreadable SQLite and redirected database paths never mean legacy", () => {
 const h = home(), path = join(h, "delivery-outbox.db"), db = new Database(path); db.exec("CREATE TABLE request_context_activations_v1(epoch TEXT)"); db.close();
 expect(() => readRequestContextBootState(h)).toThrow(/unavailable/);
 rmSync(path); writeFileSync(path, "not SQLite"); expect(() => readRequestContextBootState(h)).toThrow();
 rmSync(path); const other = activated(); symlinkSync(other.path, path); expect(() => readRequestContextBootState(h)).toThrow(/path differs/);
});
it("boot lease currentness is not an installation capability and cannot revive a lost process owner", () => {
 const r = activated(); let current = true; const boot = new RequestContextBoot(r.state, { id: "boot", current: () => current });
 expect(boot.recoveryCurrent()).toBe(true); expect(boot.publication.capture.bind(boot.publication)).toThrow();
 current = false; expect(boot.recoveryCurrent()).toBe(false); expect(boot.publication.admission.available()).toBe(false);
 expect(() => new RequestContextBoot(r.state, { id: "lost", current: () => false })).toThrow(/lease/);
});
it("first On stages capabilities on the existing connection and abort restores capability zero without artifacts", () => {
 const h = home(), path = join(h, "delivery-outbox.db"), box = new DeliveryOutbox(path); cleanup.push(() => box.close());
 const tickets = box.contactAuthorizations, recovery = box.workingRecovery;
 expect(() => box.stageRequestContextConnection({ current: () => false })).toThrow();
 const stage = box.stageRequestContextConnection({ current: () => true }); expect(stage.current()).toBe(true);
 expect(box.contactAuthorizations).toBe(tickets); expect(box.workingRecovery).toBe(recovery);
 expect(box.requestContextInstallation().read()).toBeNull();
 expect(() => box.stageRequestContextConnection({ current: () => true })).toThrow();
 stage.restore(); expect(stage.current()).toBe(false); expect(() => box.activateRequestContextBarrier()).toThrow(/v1/);
 const db = new Database(path, { readonly: true }); try { expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'request_context_%'").get()).toEqual({ n: 0 }); } finally { db.close(); }
 expect(box.recoverForBoot("still-legacy")).toEqual({ queued: 0, reconciliationPending: 0 });
});
it("a committed activation on the staged connection can never restore legacy capability", () => {
 const h = home(), box = new DeliveryOutbox(join(h, "delivery-outbox.db")); cleanup.push(() => box.close());
 const stage = box.stageRequestContextConnection({ current: () => true });
 box.requestContextInstallation().activate({ epoch: "first", owner: "fleet", activatedAt: 1, invalidates: [], offeredLatestDeadline: null },
  { owner: "fleet", current: () => true }, { current: () => true, release() {} }, () => stage.current(), 0);
 expect(() => stage.restore()).toThrow(/cannot revert/); expect(stage.current()).toBe(true);
 expect(() => box.requestHubContactGate({} as any)).not.toThrow();
});
it("rollback of an outer activation transaction leaves the same connection safely restorable", () => {
 const h = home(), box = new DeliveryOutbox(join(h, "delivery-outbox.db")); cleanup.push(() => box.close());
 const stage = box.stageRequestContextConnection({ current: () => true }); let calls = 0;
 expect(() => box.requestContextInstallation().activate({ epoch: "first", owner: "fleet", activatedAt: 1, invalidates: [], offeredLatestDeadline: null },
  { owner: "fleet", current: () => true }, { current: () => true, release() {} }, () => ++calls < 3, 0)).toThrow(/changed/);
 expect(box.requestContextInstallation().read()).toBeNull(); stage.restore(); expect(() => box.activateRequestContextBarrier()).toThrow(/v1/);
});

it("a missing main database with retained WAL evidence cannot be recreated as a legacy home", () => {
 const h = home(), wal = join(h, "delivery-outbox.db-wal"); writeFileSync(wal, "retained evidence");
 expect(() => readRequestContextBootState(h)).toThrow(/journal remains/);
 const m = manager(h); expect(() => m.ensureDeliveryOutbox()).toThrow(); expect(existsSync(join(h, "delivery-outbox.db"))).toBe(false);
});
it("the real Fleet inventory captures exactly its fenced persistent owners and never treats an idle badge as proof", async () => {
 const h=home();lock(h);const m=manager(h),publication=new (await import("../src/request-context-installation.js")).RequestContextPublication({owner:"fixture",current:()=>true},false);
 m.attachRequestContextAdmission(publication.admission);m.requestContextPendingWork=new (await import("../src/request-context-pending-work.js")).RequestContextPendingWork();
 const identity={daemonBootId:"owned",spawnGeneration:1,launchFenceEpoch:2,deliveryEpoch:0};
 const idle=vi.fn(async()=>({...identity,current:()=>true})),retirement=vi.fn(async()=>({...identity,windowId:"owned",panePid:123,retired:async()=>false}));
 const daemon={getConfigSnapshot:()=>({working_directory:h,backend:"claude-code"}),captureRequestContextIdle:idle,captureRequestContextRetirement:retirement};
 m.lifecycle.daemons.set("worker",daemon);
 await expect(m.captureRequestContextOwnedLaunches()).rejects.toThrow(/unavailable/);expect(idle).not.toHaveBeenCalled();publication.fence();
 const proof=await m.captureRequestContextOwnedLaunches();expect(proof.records.map((row:any)=>row.name)).toEqual(["worker"]);expect(proof.current()).toBe(true);expect(retirement).toHaveBeenCalledOnce();
 const finish=m.requestContextPendingWork.begin("worker");finish();expect(proof.current()).toBe(false);
 idle.mockResolvedValueOnce(null as any);await expect(m.captureRequestContextOwnedLaunches()).rejects.toMatchObject({code:"request-context-owner-not-ready",agent:"worker"});
});
it("a replacement or configuration change during the Fleet roster read cannot be adopted", async () => {
 const h=home();lock(h);const m=manager(h),publication=new (await import("../src/request-context-installation.js")).RequestContextPublication({owner:"fixture",current:()=>true},false);publication.fence();
 m.attachRequestContextAdmission(publication.admission);m.requestContextPendingWork=new (await import("../src/request-context-pending-work.js")).RequestContextPendingWork();
 let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});const identity={daemonBootId:"owned",spawnGeneration:1,launchFenceEpoch:2};const exit=vi.fn(async()=>({...identity,windowId:"owned",panePid:123,retired:async()=>false}));
 const daemon={getConfigSnapshot:()=>({working_directory:h}),captureRequestContextIdle:async()=>{await waiting;return {...identity,current:()=>true};},captureRequestContextRetirement:exit};m.lifecycle.daemons.set("worker",daemon);
 const result=m.captureRequestContextOwnedLaunches();m.lifecycle.daemons.set("worker",{...daemon});release();
 await expect(result).rejects.toMatchObject({agent:"worker"});expect(exit).not.toHaveBeenCalled();
});

it("the actual boot policy lets current covered work finish during drain/readiness loss while new calls stay fenced",async()=>{
 const {randomUUID}=await import("node:crypto"),{captureRequestContextCall}=await import("../src/request-context-call.js"),{assertRequestContextOperation}=await import("../src/request-context-policy.js");
 const r=activated();let owned=true,ready=true,livePorts=true,turnCurrent=true;
 const boot=new RequestContextBoot(r.state,{id:"process-owner",current:()=>owned});
 const box=new DeliveryOutbox(r.path,"new",{requestContextDispatchVersion:1,requestContextRelayVersion:1,requestContextRecoveryFence:boot.recoveryCurrent});cleanup.push(()=>box.close());
 const id=randomUUID(),context={ref:{version:1 as const,contextId:id,rootContextId:id},rootEvidenceRef:"admitted-fixture",initiatingActor:{kind:"person"as const,platform:"discord"as const,userId:"demo-person"},ingress:"owner"as const,source:{instance:"target",incarnation:"v1"},sourceAudience:{kind:"instance"as const,ref:randomUUID()}};
 const snapshot={token:randomUUID(),inputId:"owned-fixture",context,wireSha256:"0".repeat(64),owner:{instance:"target",incarnation:"v1",workGeneration:randomUUID(),daemonBootId:randomUUID(),spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0}};
 const lease=captureRequestContextCall(snapshot,()=>turnCurrent&&owned),admission={coverage:"covered"as const,lease};
 const asserted=vi.fn(assertRequestContextOperation),ports={policy:{assert:asserted}};
 boot.publication.publish(r.state,ports,boot.publication.fence(),()=>ready,()=>box.requestContextInstallation().read(),()=>livePorts);
 const operation={instance:"target",tool:"send_to_instance",args:{instance_name:"another"},admission};
 expect(boot.policy.assert(operation).kind).toBe("ordinary");
 const fence=boot.publication.fence(),draining=box.requestContextInstallation().beginOff(1,boot.owner);
 boot.publication.publish(draining,ports,fence,()=>ready,()=>box.requestContextInstallation().read(),()=>livePorts);
 ready=false;expect(boot.policy.assert(operation).kind).toBe("ordinary");expect(boot.policy.installedMode?.()).toBe("draining");
 expect(()=>boot.policy.assert({...operation,admission:undefined})).toThrow(/fenced/);
 boot.publication.fence();expect(boot.policy.assert(operation).kind).toBe("ordinary");
 expect(()=>boot.policy.assert({...operation,admission:undefined})).toThrow(/fenced/);
 livePorts=false;expect(()=>boot.policy.assert(operation)).toThrow(/unavailable|current/);livePorts=true;
 turnCurrent=false;expect(()=>boot.policy.assert(operation)).toThrow(/current/);turnCurrent=true;owned=false;
 expect(()=>boot.policy.assert(operation)).toThrow(/current|unavailable/);
});
it("boot policy rechecks execution ownership after a validation callback, before returning a permit",async()=>{
 const {randomUUID}=await import("node:crypto"),{captureRequestContextCall}=await import("../src/request-context-call.js"),{assertRequestContextOperation}=await import("../src/request-context-policy.js");
 const r=activated(),boot=new RequestContextBoot(r.state,{id:"process-owner",current:()=>true});let livePorts=true;
 const id=randomUUID(),context={ref:{version:1 as const,contextId:id,rootContextId:id},rootEvidenceRef:"admitted-fixture",initiatingActor:{kind:"person"as const,platform:"discord"as const,userId:"demo-person"},ingress:"owner"as const,source:{instance:"target",incarnation:"v1"},sourceAudience:{kind:"instance"as const,ref:randomUUID()}};
 const lease=captureRequestContextCall({token:randomUUID(),inputId:"owned-fixture",context,wireSha256:"0".repeat(64),owner:{instance:"target",incarnation:"v1",workGeneration:randomUUID(),daemonBootId:randomUUID(),spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0}},()=>true);
 const ports={policy:{assert:(input:Parameters<typeof assertRequestContextOperation>[0])=>{const result=assertRequestContextOperation(input);livePorts=false;return result;}}};
 boot.publication.publish(r.state,ports,boot.publication.fence(),()=>true,()=>r.state,()=>livePorts);
 expect(()=>boot.policy.assert({instance:"target",tool:"send_to_instance",args:{},admission:{coverage:"covered",lease}})).toThrow(/current/);
});

it("a staged drain can bind memory-only participants before On but cannot register work until commit", () => {
 const h=home(),path=join(h,"delivery-outbox.db"),box=new DeliveryOutbox(path);cleanup.push(()=>box.close());
 let held=true;const stage=box.stageRequestContextConnection({current:()=>held}),drain=stage.drain(()=>"fleet"),registration=drain.registration();
 const root="00000000-0000-4000-8000-000000000001";
 drain.register("turns","candidate",{registration,revision:()=>"0",inspect:()=>({registration,revision:"0",references:[],unknown:false})});
 expect(()=>registration.assertRegistration(root)).toThrow(/not ready/);
 const db=new Database(path,{readonly:true});try{expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'request_context_%'").get()).toEqual({n:0});}finally{db.close();}
 box.requestContextInstallation().activate({epoch:"first",owner:"fleet",activatedAt:1,invalidates:[],offeredLatestDeadline:null},
  {owner:"fleet",current:()=>true},{current:()=>true,release(){}},()=>stage.current(),0);
 held=false;expect(()=>registration.assertRegistration(root)).not.toThrow(); // Publication opens admission; the committed registry stays usable.
 expect(()=>stage.drain(()=>"fleet")).toThrow(/preparation unavailable/);
});
it("an abandoned staged drain never borrows a successor connection preparation",()=>{
 const h=home(),box=new DeliveryOutbox(join(h,"delivery-outbox.db"));cleanup.push(()=>box.close());
 const first=box.stageRequestContextConnection({current:()=>true}),registration=first.drain(()=>"fleet").registration();first.restore();
 const second=box.stageRequestContextConnection({current:()=>true});
 box.requestContextInstallation().activate({epoch:"second",owner:"fleet",activatedAt:1,invalidates:[],offeredLatestDeadline:null},
  {owner:"fleet",current:()=>true},{current:()=>true,release(){}},()=>second.current(),0);
 expect(()=>registration.assertRegistration("00000000-0000-4000-8000-000000000001")).toThrow(/not ready/);
});
