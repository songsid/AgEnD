import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { RequestContextLocalTurns, type PreparedRequestContextInput, type RequestContextTurnPorts } from "../src/request-context-turns.js";
import { deliveryContentDigest as wireDigest } from "../src/delivery-outbox.js";
const ROOT = "00000000-0000-4000-8000-000000000001", AUDIENCE = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const logger: any = { info() {}, error() {}, warn() {}, debug() {}, child() { return logger; } };
function rig() {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "request-daemon-")); roots.push(root);
  const dir = join(root, "instances", "worker"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "window-id"), "@synthetic");
  const daemon: any = new Daemon("worker", { working_directory: root, log_level: "silent", backend: "claude-code",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 60_000, max_age_hours: 0 } } as any,
  dir, false, undefined, { isIdle: () => true, waitUntilIdle: async () => true, getObservationResetAt: () => 0 } as any, logger);
  const inputs = new Map<string, PreparedRequestContextInput>(), saved = new Map<string, any>(); let pointer: any = null;
  const ports: RequestContextTurnPorts = { input: id => inputs.get(id) ?? null, context: id => saved.get(id) ?? null,
    retain: c => { saved.set(c.ref.contextId, c); }, canManage: () => true, recovery: () => pointer, saveRecovery: p => { pointer = p; } };
  const turns = new RequestContextLocalTurns(ports);
  daemon.setRequestContextLocalLifecycle(turns, () => ({ incarnation: "worker-generation", workGeneration: "session-1" }));
  daemon.processStatus = "running";
  daemon.tmux = { capturePane: vi.fn(async () => "❯"), pasteBuffer: vi.fn(async () => true), sendSpecialKey: vi.fn(async () => true) };
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("ready");
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
  vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockResolvedValue(true);
  const writes: string[] = [];
  vi.spyOn(daemon, "writeMessageToPane").mockImplementation(async (...args: any[]) => {
    (args[10] as ((text: string) => void) | undefined)?.(args[0]);
    writes.push(args[0]); return true;
  });
  const prepare = (id: string, text: string) => {
    inputs.set(id, { inputId: id, wireSha256: wireDigest(text), owner: daemon.requestContextOwner(), proof: { kind: "independent" }, context: {
      ref: { version: 1, contextId: ROOT, rootContextId: ROOT }, rootEvidenceRef: "accepted-fixture", ingress: "restricted-room",
      initiatingActor: { kind: "person", platform: "discord", userId: "demo-person" }, source: { instance: "worker", incarnation: "worker-generation" }, sourceAudience: { kind: "room", ref: AUDIENCE } } });
  };
  return { daemon, turns, inputs, prepare, writes };
}
it("real deliverMessage binds the owned input immediately before its pane writer, never while queued", async () => {
  const r = rig(), text = "[hid:demo-receipt] Synthetic input";
  r.prepare("human:demo-receipt", text); expect(r.daemon.requestContextTurnSnapshot()).toBeNull();
  const delivered = r.daemon.deliverMessage(text, undefined, { humanVerificationId: "demo-receipt" });
  expect(r.daemon.requestContextTurnSnapshot()).toBeNull(); await vi.runAllTimersAsync(); expect(await delivered).toBe(true);
  expect(r.writes).toEqual([text]); expect(r.daemon.requestContextTurnSnapshot()?.inputId).toBe("human:demo-receipt");
});
it("unmapped system writes cannot silently become owner work", async () => {
  const r = rig();
  const delivered = r.daemon.deliverMessage("Unmapped system resume");
  const rejected = expect(delivered).rejects.toThrow(/no trustworthy parent/);
  await vi.runAllTimersAsync(); await rejected; expect(r.writes).toEqual([]);
});
it("idle or answer publication does not retire the binding; an exact new transcript end does", async () => {
  const r = rig(), text = "[hid:demo-receipt] Synthetic input";
  r.prepare("human:demo-receipt", text);
  const delivered = r.daemon.deliverMessage(text, undefined, { humanVerificationId: "demo-receipt" });
  await vi.runAllTimersAsync(); await delivered;
  const captured = r.daemon.requestContextTurnSnapshot(); expect(captured).not.toBeNull();
  r.daemon.noteTurnEdge("idle"); await vi.advanceTimersByTimeAsync(10_000); expect(r.daemon.requestContextTurnCurrent(captured)).toBe(true);
  const write = r.daemon.requestContextWrite;
  write.ledger.observe([{ kind: "start", turnId: "ours" }, { kind: "user", turnId: "ours", text, at: write.at }]);
  r.daemon.settleRequestContextFromTranscript(); expect(r.daemon.requestContextTurnCurrent(captured)).toBe(true);
  write.ledger.observe([{ kind: "end", turnId: "other", end: "complete" }]); r.daemon.settleRequestContextFromTranscript(); expect(r.daemon.requestContextTurnCurrent(captured)).toBe(true);
  write.ledger.observe([{ kind: "end", turnId: "ours", end: "complete" }]); r.daemon.settleRequestContextFromTranscript(); expect(r.daemon.requestContextTurnCurrent(captured)).toBe(false);
});
it("stopping or changing the launch fences an earlier snapshot instead of reviving it", async () => {
  const r = rig(), text = "[hid:demo-receipt] Synthetic input"; r.prepare("human:demo-receipt", text);
  const delivered = r.daemon.deliverMessage(text, undefined, { humanVerificationId: "demo-receipt" }); await vi.runAllTimersAsync(); await delivered;
  const captured = r.daemon.requestContextTurnSnapshot(); r.daemon.fenceDeliveryWritesForStop();
  expect(r.daemon.requestContextTurnCurrent(captured)).toBe(false); expect(r.daemon.requestContextTurnSnapshot()).toBeNull();
});
it("the actual reply-recovery job carries the captured logical-turn parent, not an owner fallback", async () => {
  const r = rig(), text = "[hid:demo-receipt] Synthetic input"; r.prepare("human:demo-receipt", text);
  const first = r.daemon.deliverMessage(text, undefined, { humanVerificationId: "demo-receipt" }); await vi.runAllTimersAsync(); await first;
  const snapshot = r.daemon.requestContextTurnSnapshot();
  r.turns.ended(snapshot, r.daemon.requestContextOwner());
  r.daemon.workingTurnRequestContext = { generation: 7, snapshot };
  vi.spyOn(r.daemon, "currentReplyRecovery").mockReturnValue({ completionDelivered: false });
  r.daemon.queueReplyRecoveryPrompt({ generation: 7 } as any);
  await vi.runAllTimersAsync(); await r.daemon.pasteLock;
  expect(r.writes).toHaveLength(2); expect(r.daemon.requestContextTurnSnapshot()?.context.ref.rootContextId).toBe(ROOT);
  expect(r.daemon.requestContextTurnSnapshot()?.inputId).toBe(`reply-recovery:${r.daemon.bootId}:7:${r.daemon.deliveryEpoch}`);
});
it("historical cached completion and transcript withdrawal do not prove that a new input ended", async () => {
  const r = rig(), text = "[hid:demo-receipt] Synthetic input";
  r.daemon.transcriptTurns.observe([{ kind: "start", turnId: "old" }, { kind: "user", turnId: "old", text, at: Date.now() }, { kind: "end", turnId: "old", end: "complete" }]);
  r.prepare("human:demo-receipt", text); const first = r.daemon.deliverMessage(text, undefined, { humanVerificationId: "demo-receipt" }); await vi.runAllTimersAsync(); await first;
  const snapshot = r.daemon.requestContextTurnSnapshot(); r.daemon.settleRequestContextFromTranscript();
  expect(r.daemon.requestContextTurnCurrent(snapshot)).toBe(true);
  const write = r.daemon.requestContextWrite;
  write.ledger.observe([{ kind: "start", turnId: "ours" }, { kind: "user", turnId: "ours", text, at: write.at }, { kind: "retract", turnId: "ours" }]);
  r.daemon.settleRequestContextFromTranscript(); expect(r.daemon.requestContextTurnCurrent(snapshot)).toBe(true);
});
it("the last common paste callback receives the final wire, including receipt preparation changes", async () => {
  const r = rig(), d = r.daemon, before = "unprepared", final = "[hid:demo-receipt] Prepared wire";
  r.prepare("human:demo-receipt", final);
  d.writeMessageToPane.mockImplementation(async (...args: any[]) => { args[10](final); r.writes.push(final); return true; });
  const first = d.deliverMessage(before, undefined, { humanVerificationId: "demo-receipt" }); await vi.runAllTimersAsync(); await first;
  expect(d.requestContextTurnSnapshot()?.wireSha256).toBe(wireDigest(final)); expect(r.writes).toEqual([final]);
});
it("a native adapter cannot be added after the dormant local-only lifecycle was bound", () => {
  const r = rig(); r.daemon.tmux = undefined;
  expect(() => r.daemon.setNativePaneLifecycle({} as any)).toThrow(/before daemon startup/);
});
it("matching an unmarked repeated system prompt never proves an owned turn ended", async () => {
  const r = rig(), firstText = "[hid:demo-receipt] Synthetic input"; r.prepare("human:demo-receipt", firstText);
  const first = r.daemon.deliverMessage(firstText, undefined, { humanVerificationId: "demo-receipt" }); await vi.runAllTimersAsync(); await first;
  r.turns.ended(r.daemon.requestContextTurnSnapshot(), r.daemon.requestContextOwner());
  const resume = r.daemon.deliverMessage("Unmarked repeated system prompt"); await vi.runAllTimersAsync(); await resume;
  const write = r.daemon.requestContextWrite, snapshot = r.daemon.requestContextTurnSnapshot();
  expect(write.endAnchor).toBe(false);
  write.ledger.observe([{ kind: "start", turnId: "same-text" }, { kind: "user", turnId: "same-text", text: write.text, at: write.at }, { kind: "end", turnId: "same-text", end: "complete" }]);
  r.daemon.settleRequestContextFromTranscript(); expect(r.daemon.requestContextTurnCurrent(snapshot)).toBe(true);
});
it("the daemon refuses an older snapshot after the next input binds under the same owner", async () => {
  const r = rig(), firstText = "[hid:demo-first] First input"; r.prepare("human:demo-first", firstText);
  const firstWrite = r.daemon.deliverMessage(firstText, undefined, { humanVerificationId: "demo-first" }); await vi.runAllTimersAsync(); await firstWrite;
  const first = r.daemon.requestContextTurnSnapshot(), write = r.daemon.requestContextWrite;
  write.ledger.observe([{ kind: "start", turnId: "first" }, { kind: "user", turnId: "first", text: firstText, at: write.at }, { kind: "end", turnId: "first", end: "complete" }]);
  r.daemon.settleRequestContextFromTranscript(); expect(r.daemon.requestContextTurnSnapshot()).toBeNull();
  const secondText = "[hid:demo-second] Second input"; r.prepare("human:demo-second", secondText);
  const prepared = r.inputs.get("human:demo-second")!;
  prepared.context = { ...prepared.context!, ref: { version: 1, contextId: AUDIENCE, rootContextId: AUDIENCE }, rootEvidenceRef: "accepted-second" };
  const secondWrite = r.daemon.deliverMessage(secondText, undefined, { humanVerificationId: "demo-second" }); await vi.runAllTimersAsync(); await secondWrite;
  const second = r.daemon.requestContextTurnSnapshot(); expect(second.owner).toEqual(first.owner);
  expect(r.daemon.requestContextTurnCurrent(first)).toBe(false);
  expect(r.turns.ended(first, r.daemon.requestContextOwner())).toBe(false);
  expect(r.daemon.requestContextTurnSnapshot()).toBe(second);
  expect(r.daemon.requestContextTurnCurrent(second)).toBe(true);
  expect(r.daemon.requestContextTurnCurrent({ ...second, wireSha256: wireDigest("different snapshot") })).toBe(false);
  expect(r.daemon.requestContextTurnSnapshot()).toBe(second);
});

it("S-224 ends a newly bound turn on positive native no-input, but never on an uncertain write",async()=>{
 const r=rig(),d=r.daemon,text="[hid:demo-receipt] Synthetic input";r.prepare("human:demo-receipt",text);
 d.writeMessageToPane.mockImplementation(async(...args:any[])=>{args[10](text);d.nativePaneLifecycle={lastInputWasNotSent:()=>true};return false;});
 const pending=d.deliverMessage(text,undefined,{humanVerificationId:"demo-receipt"});await vi.runAllTimersAsync();expect(await pending).toBe(false);expect(d.requestContextTurnSnapshot()).toBeNull();
 d.nativePaneLifecycle=undefined;r.prepare("human:demo-receipt",text);
 d.writeMessageToPane.mockImplementation(async(...args:any[])=>{args[10](text);d.nativePaneLifecycle={lastInputWasNotSent:()=>false};return false;});
 const uncertain=d.deliverMessage(text,undefined,{humanVerificationId:"demo-receipt"});await vi.runAllTimersAsync();await uncertain;expect(d.requestContextTurnSnapshot()).not.toBeNull();
});
it("S-224 a failed steer with positive no-input cannot retire the turn it borrowed",async()=>{
 const r=rig(),d=r.daemon,text="[hid:demo-receipt] Synthetic input";r.prepare("human:demo-receipt",text);
 const pending=d.deliverMessage(text,undefined,{humanVerificationId:"demo-receipt"});await vi.runAllTimersAsync();await pending;const a=d.requestContextTurnSnapshot();
 const steer="[hid:steer-receipt] Clarification";r.prepare("human:steer-receipt",steer);r.inputs.get("human:steer-receipt")!.proof={kind:"admin-steer",activeToken:a.token,actor:{kind:"person",platform:"discord",userId:"demo-admin"}};
 d.writeMessageToPane.mockImplementation(async(...args:any[])=>{args[10](steer);d.nativePaneLifecycle={lastInputWasNotSent:()=>true};return false;});
 const next=d.deliverMessage(steer,undefined,{humanVerificationId:"steer-receipt"});await vi.runAllTimersAsync();await next;expect(d.requestContextTurnSnapshot()).toBe(a);
});

it("S-224 ordinary input on a queue-capable backend waits for owned idle before binding",async()=>{
 const r=rig(),d=r.daemon,aText="[hid:a] Outside input";r.prepare("human:a",aText);
 const first=d.deliverMessage(aText,undefined,{humanVerificationId:"a"});await vi.runAllTimersAsync();await first;const a=d.requestContextTurnSnapshot();
 d.backend={...d.backend,supportsQueuedInput:()=>true};d.paneReadinessForDelivery.mockResolvedValueOnce("busy").mockResolvedValue("ready");
 d.waitForPaneReadyForDelivery.mockImplementation(async()=>{r.turns.ended(a,a.owner);return true;});
 const bText="[hid:b] Independent input";r.prepare("human:b",bText);
 const next=d.deliverMessage(bText,undefined,{humanVerificationId:"b"});await vi.runAllTimersAsync();expect(await next).toBe(true);
 expect(d.waitForPaneReadyForDelivery).toHaveBeenCalled();expect(d.writeMessageToPane.mock.calls.at(-1)[2]).toBe(false);
 expect(d.requestContextTurnSnapshot().inputId).toBe("human:b");
});
