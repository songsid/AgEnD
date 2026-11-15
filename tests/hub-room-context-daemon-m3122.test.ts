/** Actual daemon delivery/consumed hooks, inert tmux and retained transcript fixtures; no CLI process or live Fleet. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Daemon } from "../src/daemon.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { consumedWatches, type ConsumedWatchTarget } from "../src/delivery-consumed-watch.js";
import { HUB_REPORT_TARGET } from "../src/hub-report-target.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); consumedWatches.stopAll(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const logger: any = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
function world() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const dir = mkdtempSync(join(tmpdir(), "agend-room-generation-")); roots.push(dir);
  const inst = join(dir, "worker"); mkdirSync(inst);
  writeFileSync(join(inst,"window-id"),"@owned");
  const backend = new ClaudeCodeBackend(inst);
  const d: any = new Daemon("worker", { backend: "claude-code", working_directory: dir, log_level: "error",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { max_age_hours: 0, grace_period_ms: 600000 } }, inst, false, backend, undefined, logger);
  let pasted = false, enters = 0;
  const pane = () => readFileSync(join(import.meta.dirname, "fixtures", `claude-2.1.293-${!pasted ? "busy-empty" : enters ? "long-busy-queued" : "long-busy-pasted"}.pane.txt`), "utf8");
  const tmux = { capturePane: vi.fn(async () => pane()), capturePaneWithHistory: vi.fn(async () => pane()),
    pasteBuffer: vi.fn(async () => { pasted = true; return true; }), sendSpecialKey: vi.fn(async () => { enters++; return true; }),
    getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: () => true, getLastSendSpecialKeyError: vi.fn(), getWindowId: () => "@owned" };
  d.tmux = tmux; d.controlClient = { isIdle: () => false, waitUntilIdle: async () => true, hasOutputSince: () => true,
    getObservationResetAt: () => 0, getLastOutputAt: () => undefined };
  d.transcriptMonitor = { reconciliationCheckpoint: async () => ({ path: join(inst,"transcript.jsonl"), offset: 0, sessionId: "owned" }) };
  for (const method of ["wake", "markTurnStarted"]) vi.spyOn(d, method).mockResolvedValue(undefined);
  vi.spyOn(d,"waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(d,"paneReadinessForDelivery").mockResolvedValue("busy");
  vi.spyOn(d,"waitForPaneReadyForDelivery").mockResolvedValue(true);
  vi.spyOn(d,"probeBlockingDialog").mockResolvedValue({state:"clear"});
  d.resetRoomConversation(); d.ownedWorkingSession = "owned";
  const notices: any[] = [], watches: ConsumedWatchTarget[] = [];
  vi.spyOn(d,"broadcastFleetMessage").mockImplementation((v: any) => notices.push(v));
  vi.spyOn(consumedWatches,"start").mockImplementation(t => { watches.push(t); return true; });
  const generation = d.roomConversationGeneration(), correlationId = `hub-room-${randomUUID()}`;
  const meta = { from_instance: HUB_REPORT_TARGET, correlation_id: correlationId, hub_room_context_generation: generation,
    message_id: correlationId, chat_id: "", user: "Hub", requires_reply: "true" };
  const finish = async () => { await vi.advanceTimersByTimeAsync(20000); await d.pasteLock; };
  return { d, backend, tmux, notices, watches, generation, correlationId, meta, finish };
}
it("a real busy Hub delivery advances only when its recorded input is consumed, never at IPC or queue acceptance", async () => {
  const w = world(); w.d.pushChannelMessage("Hub room question",w.meta); await w.finish();
  expect(w.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
  expect(w.notices.filter(n => n.type === "hub_room_input")).toEqual([]);
  expect(w.watches).toHaveLength(1);
  w.watches[0].consumed("turn", "transcript-consumed:user-entry");
  expect(w.notices.filter(n => n.type === "hub_room_input")).toEqual([{ type: "hub_room_input", correlationId: w.correlationId, generation: w.generation }]);
});
it("a reset during a readiness wait prevents an old room delta from reaching the pane", async () => {
  const w = world(); let release!: (v: string) => void;
  vi.mocked(w.d.paneReadinessForDelivery).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  w.d.pushChannelMessage("Old room context",w.meta);
  await vi.advanceTimersByTimeAsync(1);
  expect(release).toBeTypeOf("function"); w.d.resetRoomConversation(); release("busy"); await w.finish();
  expect(w.tmux.pasteBuffer).not.toHaveBeenCalled();
  expect(w.notices.filter(n => n.type === "hub_room_input")).toEqual([]);
});
it("a newly checkpointed non-Claude session rotates the room generation without changing the working-session contract", () => {
  const w = world(); w.d.config.backend = "codex"; let session = "A";
  vi.spyOn(w.backend,"getSessionId").mockImplementation(() => session);
  w.d.saveSessionId(); const first = w.d.roomConversationGeneration();
  session="B"; w.d.saveSessionId(); expect(w.d.roomConversationGeneration()).not.toBe(first);
  const next=w.d.roomConversationGeneration(); w.d.saveSessionId(); expect(w.d.roomConversationGeneration()).toBe(next);
});
it.each([true,false])("owned clear rotates only after its actual command write (%s)", async written => {
  const w=world();let release!:()=>void;w.d.pasteLock=new Promise<void>(resolve=>{release=resolve;});
  vi.spyOn(w.d,"deliverMessage").mockImplementation(async (...args:any[])=>{if(written)args[2].onPaneWritten?.();return written;});
  w.d.handleRawPasteIpcMessage({content:"/clear",context_reset:"clear"});
  expect(w.d.roomConversationGeneration()).toBe(w.generation);release();await w.finish();
  expect(w.d.roomConversationGeneration()===w.generation).toBe(!written);
});
