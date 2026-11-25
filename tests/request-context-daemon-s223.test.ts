import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { RequestContextLocalTurns, type PreparedRequestContextInput, type RequestContextTurnPorts } from "../src/request-context-turns.js";
import { requestContextDigest } from "../src/request-context-store.js";
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
    inputs.set(id, { inputId: id, wireSha256: requestContextDigest(text), owner: daemon.requestContextOwner(), proof: { kind: "independent" }, context: {
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
  expect(r.daemon.requestContextTurnSnapshot()?.inputId).toBe(`reply-recovery:7:${r.daemon.deliveryEpoch}`);
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
  expect(d.requestContextTurnSnapshot()?.wireSha256).toBe(requestContextDigest(final)); expect(r.writes).toEqual([final]);
});
it("a native adapter cannot be added after the dormant local-only lifecycle was bound", () => {
  const r = rig(); r.daemon.tmux = undefined;
  expect(() => r.daemon.setNativePaneLifecycle({} as any)).toThrow(/before daemon startup/);
});
