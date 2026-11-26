import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContextPublication } from "../src/request-context-installation.js";
import { runWithRequestContextAdmission } from "../src/request-context-admission.js";
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";

const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function publication() { let live = true; const p = new RequestContextPublication({ owner: "fixture-fleet", current: () => live }, false); return { p, lose: () => { live = false; p.admission.changed(); } }; }
const logger: any = { debug() {}, warn() {}, error() {}, info() {}, child() { return logger; } };
function daemon() {
  const root = mkdtempSync(join(tmpdir(), "admission-")); homes.push(root);
  return new Daemon("worker", { working_directory: root, backend: "claude-code", log_level: "silent" } as any, root, true, undefined, undefined, logger) as any;
}
it("claim polls do not invalidate preparation; an actual retained producer does, and abort releases it once", async () => {
  const { p } = publication(), fence = p.fence(), send = vi.fn(() => "accepted");
  for (let i = 0; i < 8; i++) expect(p.admission.available()).toBe(false);
  expect(fence.current()).toBe(true);
  const result = runWithRequestContextAdmission(p.admission, () => true, send);
  expect(fence.current()).toBe(false); expect(fence.owned()).toBe(true); expect(send).not.toHaveBeenCalled();
  p.abandon(fence, () => null);
  expect(await result).toBe("accepted"); p.admission.changed(); expect(send).toHaveBeenCalledTimes(1);
});
it("a durable arrival without a claim invalidates preparation, and a stale or lost-owner waiter never sends", async () => {
  const f = publication(), fence = f.p.fence(); f.p.admission.arrived(); expect(fence.current()).toBe(false);
  let current = true;
  const waiting = f.p.admission.wait(() => current); current = false; f.p.admission.changed();
  expect(await waiting).toBe(false);
  const lost = f.p.admission.wait(() => true); f.lose(); expect(await lost).toBe(false);
  expect(() => f.p.abandon(fence, () => null)).toThrow(); expect(f.p.admission.available()).toBe(false);
});
it("activated state cannot abort into legacy admission", async () => {
  const { p } = publication(), fence = p.fence();
  const state = { revision: 1, epoch: "epoch", owner: "fixture-fleet", mode: "active" as const };
  const waiting = p.admission.wait(() => true);
  expect(() => p.abandon(fence, () => state)).toThrow(); expect(p.admission.available()).toBe(false);
  p.publish(state, {}, p.fence(), () => true, () => state, () => true);
  expect(await waiting).toBe(true);
});
it("a direct daemon input waits before probing or taking the pane lock", async () => {
  const d = daemon(), { p } = publication(), fence = p.fence(); d.setRequestContextAdmission(p.admission);
  const settle = vi.spyOn(d, "waitForSpawnToSettle").mockResolvedValue(true);
  const input = d.deliverMessage("retained synthetic input");
  await Promise.resolve(); expect(settle).not.toHaveBeenCalled(); expect(d.paneWriteLock.isBusy).toBe(false);
  d.deliveryWritesStopping = true; p.admission.changed();
  expect(await input).toBe(false); expect(settle).not.toHaveBeenCalled();
  p.abandon(fence, () => null);
});
it("Fleet binding covers existing and replacement daemons without losing their pre-start preparation", () => {
  const { p } = publication(), existing = daemon(), replacement = daemon(), prepare = vi.fn();
  const ctx: any = Object.create(FleetManager.prototype);
  ctx.lifecycle = { daemons: new Map([["worker", existing]]) }; ctx.configureRequestContextBeforeStart = prepare;
  ctx.attachRequestContextAdmission(p.admission); ctx.attachRequestContextAdmission(p.admission);
  expect(existing.requestContextAdmission).toBe(p.admission);
  ctx.configureRequestContextBeforeStart("worker", replacement, {});
  expect(replacement.requestContextAdmission).toBe(p.admission); expect(prepare).toHaveBeenCalledTimes(1);
  expect(() => ctx.attachRequestContextAdmission(publication().p.admission)).toThrow(/differs/);
});
it("publication release wakes a parked outbox pump; subscribing and polling are not input arrivals", () => {
  const { p } = publication(), fence = p.fence(), schedule = vi.fn(), kick = vi.fn();
  const ctx: any = Object.create(FleetManager.prototype);
  ctx.lifecycle = { daemons: new Map() }; ctx.deliveryOutbox = { isOpen: true };
  ctx.scheduleDeliveryOutboxPump = schedule; ctx.wakeCoordinator = { kick };
  ctx.attachRequestContextAdmission(p.admission);
  expect(p.admission.available()).toBe(false); expect(fence.current()).toBe(true); expect(schedule).not.toHaveBeenCalled();
  p.abandon(fence, () => null); expect(schedule).toHaveBeenCalledTimes(1); expect(kick).toHaveBeenCalledTimes(1);
});
it("held daemon input never acquires a replacement launch's identity", async () => {
  const d = daemon(), { p } = publication(), fence = p.fence(); d.setRequestContextAdmission(p.admission);
  const settle = vi.spyOn(d, "waitForSpawnToSettle").mockResolvedValue(true);
  const input = d.deliverMessage("old launch input");
  d.spawnGeneration++; p.admission.changed(); p.abandon(fence, () => null);
  expect(await input).toBe(false); expect(settle).not.toHaveBeenCalled();
});
it("a fence closing during a daemon pre-write await retains input outside the lock until it can write once", async () => {
  const d = daemon(), { p } = publication(); d.setRequestContextAdmission(p.admission);
  d.tmux = { getWindowId: () => "@fixture" }; d.controlClient = {}; d.runtimeMonitorsFrozen = false;
  d.waitForSpawnToSettle = async () => true; d.paneReadinessForDelivery = async () => "ready";
  d.submitStrandedInputIfAny = async () => "idle"; d.refuseBlockedDelivery = () => false;
  d.waitForInputTransientToClear = async () => true; d.deliveryBlockingDialogs = () => [];
  d.hasPositiveDeliveryInput = async () => true;
  let resume!: () => void;
  const prewrite = new Promise<void>(resolve => { resume = resolve; });
  d.clearRestoredInputDraft = vi.fn(async () => { await prewrite; return "clear"; });
  const physicalWrite = vi.fn();
  d.writeMessageToPane = vi.fn(async (...args: any[]) => { if (!args[8]()) return false; physicalWrite(); return true; });
  const input = d.deliverMessage("retained exact wire");
  await vi.waitFor(() => expect(d.clearRestoredInputDraft).toHaveBeenCalledTimes(1));
  const fence = p.fence(); resume();
  await vi.waitFor(() => expect(d.writeMessageToPane).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(d.paneWriteLock.isBusy).toBe(false));
  expect(physicalWrite).not.toHaveBeenCalled();
  p.abandon(fence, () => null); expect(await input).toBe(true); expect(physicalWrite).toHaveBeenCalledTimes(1);
});
it("direct working recovery cannot consume its durable input while the publication is fenced", async () => {
  const d = daemon(), { p } = publication(), fence = p.fence(); d.setRequestContextAdmission(p.admission);
  d.tmux = { getWindowId: () => "@fixture", capturePane: vi.fn(async () => "empty"), getPaneInputMode: async () => "raw" };
  d.processStatus = "running"; d.instanceState = "idle"; d.recoveryBootSettled = true;
  d.healthCheckPaused = false; d.runtimeMonitorsFrozen = false;
  d.backend = { readInputRow: () => ({ text: "", collapsedPastes: 0, queued: false }) };
  d.paneAuthoritativelyIdle = () => true; d.inputTransientInPane = () => false; d.isSessionOomStopped = () => false;
  d.durableAttemptEvidence = async () => ({}); d.beginDurableDelivery = vi.fn(() => true);
  d.deliveryOutbox = { markEnterStarted: vi.fn(() => false), complete: vi.fn() };
  const input = d.deliverWorkingRecovery("synthetic recovery", { deliveryId: "delivery", attemptNo: 1 }, () => true);
  await Promise.resolve(); expect(d.tmux.capturePane).not.toHaveBeenCalled(); expect(d.beginDurableDelivery).not.toHaveBeenCalled();
  expect(d.paneWriteLock.isBusy).toBe(false);
  p.abandon(fence, () => null); await input;
  expect(d.beginDurableDelivery).toHaveBeenCalledTimes(1);
});
it("the Fleet facade holds the payload before choosing its replacement owner", async () => {
  const { p } = publication(), fence = p.fence(), deliver = vi.fn(async () => true);
  const ctx: any = { requestContextAdmission: p.admission, shuttingDown: false, fleetConfig: { instances: {} },
    generalLocationDeliveryHold: () => false, getDeliveryEpoch: () => 1, deliveryCurrent: () => true,
    waitForInstanceIdle: async () => true, getInstanceStatus: () => "running", lastDeliveryAt: new Map(),
    daemons: new Map(), instanceIpcClients: new Map(), logger, isInstanceRestarting: () => false,
    classicHubSerialized: () => false, lifecycle: { isPaused: () => false } };
  // End the real facade at its existing IPC boundary; it must not pick this boundary until the fence opens.
  ctx.sendWhenConnected = deliver;
  const result = FleetManager.prototype.deliverToInstance.call(ctx, "worker", { type: "message", content: "synthetic" });
  await Promise.resolve(); expect(deliver).not.toHaveBeenCalled();
  p.abandon(fence, () => null); await result;
  expect(deliver).toHaveBeenCalledTimes(1);
});
function hubContext(p: RequestContextPublication<object>) {
  const send = vi.fn(() => true);
  const ctx: any = { requestContextAdmission: p.admission, deliveryCurrent: () => true,
    refuseHubPane: () => false, bindHumanReceiptPayload: (_name: string, payload: unknown) => payload,
    holdPaneSend: () => false, prepareClassicForPerson: async () => null,
    instanceIpcClients: new Map([["worker", { connected: true, send }]]), logger };
  return { ctx, send };
}
it("Hub input intent is retained at its producer until the fence opens", async () => {
  const { p } = publication(), fence = p.fence(), { ctx, send } = hubContext(p), before = vi.fn(async () => true);
  const result = (FleetManager.prototype as any).handOffAfterBeforeInput.call(ctx, "worker", { type: "fleet_inbound" }, 1, () => true, before);
  await Promise.resolve(); expect(before).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  p.abandon(fence, () => null); expect(await result).toBe(true);
  expect(before).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
});
it("a fence closing during a Hub begin await still blocks the final IPC handoff without repeating begin", async () => {
  const { p } = publication(), { ctx, send } = hubContext(p);
  let finish!: (result: boolean) => void;
  const before = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const result = (FleetManager.prototype as any).handOffAfterBeforeInput.call(ctx, "worker", { type: "fleet_inbound" }, 1, () => true, before);
  await vi.waitFor(() => expect(before).toHaveBeenCalledTimes(1));
  const fence = p.fence(); finish(true); await Promise.resolve(); await Promise.resolve();
  expect(send).not.toHaveBeenCalled(); p.abandon(fence, () => null);
  expect(await result).toBe(true); expect(before).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
});
it("a synchronous human control is durably retained with its original receipt across reopen, then consumed once", async () => {
  const { p } = publication(), fence = p.fence();
  const root = mkdtempSync(join(tmpdir(), "held-control-")); homes.push(root); const path = join(root, "outbox.db");
  let outbox = new DeliveryOutbox(path, "before-restart");
  outbox.on("request_context_admitted", () => p.admission.arrived());
  const receipt = { type: "steer", content: "synthetic", meta: { human_receipt_id: "receipt" } };
  const ctx: any = { requestContextAdmission: p.admission, logger, instanceIpcClients: new Map(), managerBootId: "before-restart",
    humanReceiptPayload: vi.fn(() => receipt), deliveryOutbox: outbox, scheduleDeliveryOutboxPump: vi.fn() };
  try {
    expect(FleetManager.prototype.sendHumanControl.call(ctx, "worker", {}, undefined, "synthetic")).toBe(true);
    expect(outbox.listPending()).toHaveLength(1); expect(fence.current()).toBe(false);
    outbox.close(); outbox = new DeliveryOutbox(path, "after-restart"); ctx.deliveryOutbox = outbox;
    expect(outbox.listPending()).toHaveLength(1); expect(outbox.listPending()[0]!.payload).toEqual(receipt);
    p.abandon(fence, () => null);
    outbox.recoverForBoot("after-restart");
    const claimed = outbox.claimNext("after-restart", () => "new-daemon", new Set())!;
    ctx.waitForDurableLaneRelease = () => Promise.resolve(); ctx.deliveryWorkerMode = () => "off";
    ctx.contactDeliveryCurrent = () => true;
    ctx.deliverToInstance = vi.fn(async (_name, payload, options) => {
      expect(payload.meta.human_receipt_id).toBe("receipt"); expect(payload.meta.from_instance).toBeUndefined();
      expect(payload.content).toBe(receipt.content); expect(options).toMatchObject({ isCrossInstance: false, waitForIdle: false });
      expect(outbox.begin(claimed.deliveryId, "new-daemon", claimed.attemptNo)).toBe("begun");
      outbox.complete(claimed.deliveryId, "new-daemon", claimed.attemptNo, "delivered", "synthetic accepted input");
      return true;
    });
    await (FleetManager.prototype as any).dispatchDurableDelivery.call(ctx, claimed);
    expect(ctx.deliverToInstance).toHaveBeenCalledTimes(1); expect(ctx.humanReceiptPayload).toHaveBeenCalledTimes(1);
    expect(outbox.claimNext("after-restart", () => "new-daemon", new Set())).toBeUndefined();
  } finally { outbox.close(); }
});
it("a synchronous control is not acknowledged if durable retention fails", () => {
  const { p } = publication(), fence = p.fence(), uncertain = vi.fn();
  const ctx: any = { requestContextAdmission: p.admission, logger, instanceIpcClients: new Map(), managerBootId: "manager",
    humanReceiptPayload: () => ({ type: "steer", meta: { human_receipt_id: "receipt" } }),
    deliveryOutbox: { admit: () => { throw Error("storage unavailable"); }, markHumanReceiptUncertain: uncertain } };
  expect(FleetManager.prototype.sendHumanControl.call(ctx, "worker", {}, undefined, "synthetic")).toBe(false);
  expect(uncertain).toHaveBeenCalledWith("receipt", "worker"); p.abandon(fence, () => null);
});
it("both actual pump owners leave work unclaimed while held; eligibility polling grants no preparation change", async () => {
  const { p } = publication(), fence = p.fence(), claimNext = vi.fn(() => undefined);
  const ctx: any = { requestContextAdmission: p.admission, deliveryPumpRunning: false, activeDurableTargets: new Set(),
    queueWorkers: new Map(), deliveryWorkerMode: () => "on", reconcileQueueWorkers: vi.fn(),
    isInstanceRestarting: () => false, deliveryBootId: () => "boot", logger,
    deliveryOutbox: { isOpen: true, listPending: () => [], expireStale: vi.fn(), claimNext, nextRetryAt: () => null, nextExpiryAt: () => null } };
  const worker = (FleetManager.prototype as any).createQueueWorker.call(ctx, "worker"); ctx.queueWorkers.set("worker", worker);
  (FleetManager.prototype as any).runDeliveryOutboxPump.call(ctx); await worker.drain();
  expect(claimNext).not.toHaveBeenCalled(); expect(fence.current()).toBe(true);
  p.abandon(fence, () => null); (FleetManager.prototype as any).runDeliveryOutboxPump.call(ctx);
  expect(claimNext).toHaveBeenCalledTimes(1);
});

it("a captured continuation passes the actual daemon final-write gate while independent input remains parked",async()=>{
  const d=daemon(),{p}=publication(),ports={};
  let state={revision:1,epoch:"epoch",owner:"fixture-fleet",mode:"active" as "active"|"draining"};
  p.publish(state,ports,p.fence(),()=>true,()=>state,()=>true);
  const root="00000000-0000-4000-8000-000000000001",proof=p.continuation(root,()=>true);
  state={...state,revision:2,mode:"draining"};p.publish(state,ports,p.fence(),()=>true,()=>state,()=>true,id=>id===root);
  d.setRequestContextAdmission(p.admission);
  // Only the gate is under test; every physical pane/backend port is synthetic and writes no process input.
  d.requestContextLifecycle={continuation:(id:string)=>id==="owned-delivery"?proof:undefined};
  d.tmux={getWindowId:()=>"@fixture"};d.controlClient={};d.runtimeMonitorsFrozen=false;
  d.waitForSpawnToSettle=async()=>true;d.paneReadinessForDelivery=async()=>"ready";
  d.submitStrandedInputIfAny=async()=>"idle";d.refuseBlockedDelivery=()=>false;
  d.waitForInputTransientToClear=async()=>true;d.deliveryBlockingDialogs=()=>[];d.hasPositiveDeliveryInput=async()=>true;
  d.clearRestoredInputDraft=async()=>"clear";
  const physicalWrite=vi.fn();d.writeMessageToPane=vi.fn(async(...args:any[])=>{if(!args[8]())return false;physicalWrite();return true;});
  expect(await d.deliverMessage("synthetic return",undefined,{requestContextInputId:"owned-delivery"})).toBe(true);
  expect(physicalWrite).toHaveBeenCalledTimes(1);
  const fresh=d.deliverMessage("synthetic new root");await Promise.resolve();expect(physicalWrite).toHaveBeenCalledTimes(1);
  d.deliveryWritesStopping=true;p.admission.changed();expect(await fresh).toBe(false);
});
