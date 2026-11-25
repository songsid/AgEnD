import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { RequestContextLocalTurns, type PreparedRequestContextInput } from "../src/request-context-turns.js";
import { deliveryContentDigest } from "../src/delivery-outbox.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const logger: any = { info() {}, error() {}, warn() {}, debug() {}, child() { return logger; } };
function rig(enabled = true, registration?:import("../src/request-context-fence.js").RequestContextRegistrationGate) {
  const root = mkdtempSync(join(tmpdir(), "agend-s224-local-")); roots.push(root);
  const dir = join(root, "instances", "worker"); mkdirSync(dir, { recursive: true });
  const daemon: any = new Daemon("worker", { working_directory: root, log_level: "silent", backend: "claude-code" } as any, dir, true, undefined, undefined, logger);
  const inputs = new Map<string, PreparedRequestContextInput>(), contexts = new Map<string, any>();
  const turns = new RequestContextLocalTurns({ registration, input: id => inputs.get(id) ?? null, context: id => contexts.get(id) ?? null,
    retain: c => { contexts.set(c.ref.contextId, c); }, canManage: () => true, recovery: () => null, saveRecovery: () => {} });
  if (enabled) daemon.setRequestContextLocalLifecycle(turns, () => ({ incarnation: "incarnation", workGeneration: "session" }));
  daemon.ipcServer = { send: vi.fn(() => true) };
  const frames: Record<string, unknown>[] = []; vi.spyOn(daemon, "broadcastFleetMessage").mockImplementation((frame: any) => { frames.push(frame); });
  vi.spyOn(daemon, "fleetTransportAvailable").mockReturnValue(true);
  const socket = {} as any; daemon.socketSessionNames.set(socket, "worker");
  const bind = (id: string, ingress: "owner" | "guest" = "guest") => {
    const contextId = randomUUID(), text = `[agend-request-input:${id}]\nSynthetic question`;
    inputs.set(id, { inputId: id, wireSha256: deliveryContentDigest(text), owner: daemon.requestContextOwner(), proof: { kind: "independent" },
      context: { ref: { version: 1, contextId, rootContextId: contextId }, rootEvidenceRef: "accepted-fixture", ingress,
        initiatingActor: { kind: "person", platform: "discord", userId: ingress === "owner" ? "demo-admin" : "demo-person" },
        source: { instance: "worker", incarnation: "incarnation" }, sourceAudience: { kind: "web", ref: randomUUID() } } });
    daemon.bindRequestContextWrite(id, text, false); return daemon.requestContextTurnSnapshot();
  };
  const call = () => { daemon.handleOwnedToolCall({ type: "tool_call", tool: "send_to_instance", args: { instance_name: "target", message: "synthetic" }, requestId: 1 }, socket); return frames.at(-1)!; };
  const fm: any = new FleetManager(root); fm.daemons.set("worker", daemon); vi.spyOn(fm, "checkToolPermission").mockReturnValue({allowed:true}); const ipc = { send: vi.fn(() => true) }; if(registration)fm.setRequestContextDrainRegistration(registration);fm.instanceIpcClients.set("worker", ipc);if(registration)fm.observeRequestContextResponses("worker",ipc);
  const clearTimers = () => { for (const cb of daemon.pendingIpcRequests.values()) cb({ result: { sent: false } }); daemon.pendingIpcRequests.clear(); };
  return { daemon, turns, bind, frames, call, fm, ipc, socket, clearTimers };
}
it("first local hop mints only an opaque call id; delayed Fleet receipt cannot acquire B", () => {
  const f = rig(); const a = f.bind("a"), frame = f.call();
  const call = f.daemon.requestContextCall(frame.requestContextCallId); expect(call.admission.lease.snapshot).toEqual(a);
  expect(JSON.stringify(frame)).not.toContain(a.token); expect(JSON.stringify(frame)).not.toContain(a.context.ref.contextId);
  f.turns.ended(a, a.owner); f.bind("b", "owner");
  expect(f.fm.captureRequestContextIpcCall("worker", frame, f.ipc)).toBe(false);
  expect(f.fm.requestContextCallOf(frame)).toBeNull(); f.clearTimers();
});
it("a timely Fleet admission keeps original A after awaits, and never performs a late current-turn lookup", () => {
  const f = rig(); const a = f.bind("a"), frame = f.call();
  expect(f.fm.captureRequestContextIpcCall("worker", frame, f.ipc)).toBe(true);
  const captured = f.fm.requestContextCallOf(frame); expect(captured.admission.lease.snapshot.token).toBe(a.token);
  f.turns.ended(a, a.owner); f.bind("b", "owner");
  expect(captured.current()).toBe(false); expect(f.fm.requestContextCallOf(frame)).toBe(captured);
  expect(captured.admission.lease.snapshot.token).toBe(a.token); f.clearTimers();
});
it("an anchored abort does not block B input; B's contacts get an interrupted-launch operation scope", () => {
  const f = rig(); f.bind("a"); const write = f.daemon.requestContextWrite;
  write.ledger.observe([{ kind: "start", turnId: "owned" }, { kind: "user", turnId: "owned", text: write.text, at: write.at }, { kind: "end", turnId: "owned", end: "aborted" }]);
  f.daemon.settleRequestContextFromTranscript(); expect(f.daemon.requestContextTurnSnapshot()).toBeNull();
  expect(() => f.bind("b", "owner")).not.toThrow();
  const frame = f.call(); expect(f.fm.captureRequestContextIpcCall("worker", frame, f.ipc)).toBe(true);
  const captured = f.fm.requestContextCallOf(frame); expect(captured.current()).toBe(true);
  expect(captured.admission).toEqual({ coverage: "not-covered", reason: "interrupted-launch" }); f.clearTimers();
});
it("wrong daemon/connection and missing call ids refuse, while OFF retains the original IPC shape", () => {
  const f = rig(); f.bind("a"); const frame = f.call();
  expect(f.fm.captureRequestContextIpcCall("worker", frame, {})).toBe(false);
  expect(f.fm.captureRequestContextIpcCall("worker", { ...frame, sourceDaemonBootId: "other" }, f.ipc)).toBe(false);
  expect(f.fm.captureRequestContextIpcCall("worker", { ...frame, requestContextCallId: undefined }, f.ipc)).toBe(false); f.clearTimers();
  const off = rig(false), legacy = off.call(); expect(legacy.requestContextCallId).toBeUndefined(); expect(legacy.sourceDaemonBootId).toBeUndefined();
  expect(off.fm.captureRequestContextIpcCall("worker", legacy, off.ipc)).toBe(true); expect(off.fm.requestContextCallOf(legacy)).toBeNull(); off.clearTimers();
});
it("a fresh launch recovers coverage without clearing another request or an origin row", () => {
  const f = rig(); f.bind("a"); const write = f.daemon.requestContextWrite;
  write.ledger.observe([{ kind: "start", turnId: "owned" }, { kind: "user", turnId: "owned", text: write.text, at: write.at }, { kind: "end", turnId: "owned", end: "aborted" }]);
  f.daemon.settleRequestContextFromTranscript();
  f.daemon.spawnGeneration++; const fresh = f.bind("fresh", "owner"), frame = f.call();
  const captured = f.daemon.requestContextCall(frame.requestContextCallId);
  expect(captured.admission.coverage).toBe("covered"); expect(captured.admission.lease.snapshot.token).toBe(fresh.token); f.clearTimers();
});

it("an unknown or sibling helper socket never borrows this daemon's active requester", () => {
  const f = rig(); f.bind("a", "owner"); f.daemon.socketSessionNames.set(f.socket, "sibling");
  const frame = f.call(); const captured = f.daemon.requestContextCall(frame.requestContextCallId);
  expect(captured.admission).toEqual({ coverage: "not-covered", reason: "unbound-input" }); f.clearTimers();
});

it("S-224 captured local scope also loses its commit lease after role, IPC or published-daemon replacement",()=>{
 const f=rig();f.bind("a");const frame=f.call();expect(f.fm.captureRequestContextIpcCall("worker",frame,f.ipc)).toBe(true);const captured=f.fm.requestContextCallOf(frame);
 expect(captured.current()).toBe(true);f.fm.checkToolPermission.mockReturnValue({allowed:false,message:"revoked"});expect(captured.current()).toBe(false);
 f.fm.checkToolPermission.mockReturnValue({allowed:true});f.fm.instanceIpcClients.set("worker",{});expect(captured.current()).toBe(false);
 f.fm.instanceIpcClients.set("worker",f.ipc);f.fm.daemons.set("worker",{bootId:"replacement"});expect(captured.current()).toBe(false);f.clearTimers();
});

it("a retired call reports an unconfirmed outcome rather than implying that a committed effect was not done", () => {
 const f=rig(); const a=f.bind("a"); f.call();
 f.turns.ended(a,a.owner); f.bind("b","owner");
 f.clearTimers();
 expect(JSON.stringify(f.daemon.ipcServer.send.mock.calls)).toContain("outcome is unconfirmed");
 expect(JSON.stringify(f.daemon.ipcServer.send.mock.calls)).toContain("do not repeat");
});

it("the real user-cancel path flags turn cancellation while dialog keys keep their existing proof", async () => {
 const f=rig(); f.daemon.nativePaneLifecycle={};
 f.daemon.tmux={capturePane:vi.fn(async()=>"synthetic screen"),sendSpecialKey:vi.fn(async()=>true)};
 await f.daemon.sendEscape();
 expect(f.daemon.tmux.sendSpecialKey).toHaveBeenCalledWith("Escape",undefined,{kind:"dialog",screen:"synthetic screen",cancelTurn:true});
});

it("S-226 actual daemon and Fleet indexes last until their own completion, not a turn ending",()=>{
 const gate={assertRegistration:vi.fn()},f=rig(true,gate),snapshot=f.bind("a"),root=snapshot.context.ref.rootContextId,frame=f.call();
 expect(f.daemon.requestContextCallDrainView(root).references).toHaveLength(1);expect(f.fm.captureRequestContextIpcCall("worker",frame,f.ipc)).toBe(true);
 expect(f.fm.requestContextFleetDrainView(root).references).toHaveLength(1);f.turns.ended(snapshot,snapshot.owner);
 expect(f.fm.requestContextFleetDrainView(root).references).toHaveLength(1);
 (f.ipc.send as any)({type:"fleet_outbound_response",fleetRequestId:frame.fleetRequestId,result:{sent:false}});
 expect(f.fm.requestContextFleetDrainView(root).references).toEqual([]);f.clearTimers();expect(f.daemon.requestContextCallDrainView(root).references).toEqual([]);
});
it("S-226 a fenced local call is refused before dispatch and cannot enter either index",()=>{
 const gate={assertRegistration:vi.fn()},f=rig(true,gate),snapshot=f.bind("a"),root=snapshot.context.ref.rootContextId;
 gate.assertRegistration.mockImplementation(()=>{throw Error("root draining");});
 f.daemon.handleOwnedToolCall({tool:"send_to_instance",args:{instance_name:"target",message:"synthetic"},requestId:2},f.socket);
 expect(f.frames).toEqual([]);expect(f.daemon.requestContextCallDrainView(root).references).toEqual([]);expect(f.daemon.ipcServer.send).toHaveBeenCalledWith(f.socket,expect.objectContaining({error:expect.stringContaining("unavailable")}));
});
it("S-226 Fleet refuses a newly fenced captured call without dropping an already active daemon call",()=>{
 const gate={assertRegistration:vi.fn()},f=rig(true,gate),snapshot=f.bind("a"),frame=f.call();gate.assertRegistration.mockImplementation(()=>{throw Error("root draining");});
 expect(f.fm.captureRequestContextIpcCall("worker",frame,f.ipc)).toBe(false);expect(f.fm.requestContextFleetDrainView(snapshot.context.ref.rootContextId).references).toEqual([]);f.clearTimers();
});
