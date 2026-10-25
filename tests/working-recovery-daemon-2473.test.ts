/** Real local writer/outbox; every native effect outside the fixture is forbidden. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ forbidden: vi.fn(() => { throw Error("forbidden host effect"); }) }));
vi.mock("node:child_process", async load => ({ ...await load<typeof import("node:child_process")>(), exec: io.forbidden, execFile: io.forbidden,
  execFileSync: io.forbidden, execSync: io.forbidden, spawn: io.forbidden, spawnSync: io.forbidden, fork: io.forbidden }));
vi.mock("node:net", async load => ({ ...await load<typeof import("node:net")>(), createServer: io.forbidden, connect: io.forbidden, createConnection: io.forbidden }));
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import type { RecoveryEpisode } from "../src/working-recovery.js";
const roots: string[] = [], stores: DeliveryOutbox[] = [];
beforeEach(() => { vi.useFakeTimers(); io.forbidden.mockClear(); });
afterEach(() => { stores.splice(0).forEach(s => s.close()); vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); expect(io.forbidden).not.toHaveBeenCalled(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "working-recovery-daemon-")); roots.push(dir);
  const logger: any = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }; logger.child = () => logger;
  const backend: any = { binaryName: "fixture", getReadyPattern: () => /^READY$/m, getBusyPattern: () => /BUSY/,
    readInputRow: (pane: string) => pane.includes("DRAFT") ? { text: "draft", collapsedPastes: 0 } : { text: "", collapsedPastes: 0 },
    backgroundWorkRunning: () => false };
  const daemon = new Daemon("worker", { backend: "claude-code", working_directory: dir, log_level: "silent" } as any,
    dir, true, backend, undefined, logger) as any;
  daemon.processStatus = "running"; daemon.instanceState = "idle"; daemon.recoveryBootSettled = true;
  daemon.ownedWorkingSession = "owned-session"; daemon.workingBackgroundObservation = false;
  let pane = "READY", admitted = true;
  const paste = vi.fn(async (_text: string, options: { guard: () => boolean }) => options.guard());
  const enter = vi.fn(async () => true);
  daemon.tmux = { capturePane: vi.fn(async () => pane), getPaneInputMode: vi.fn(async () => "raw"), pasteBuffer: paste,
    sendSpecialKey: enter, getWindowId: () => "@private" };
  daemon.waitForInputTransientToClear = vi.fn(async () => true);
  const proof = vi.spyOn(daemon, "confirmSubmitted").mockResolvedValue("submitted");
  const markTurn = vi.spyOn(daemon, "markTurnStarted");
  const outbox = new DeliveryOutbox(join(dir, "outbox.db"), "manager"); stores.push(outbox); daemon.setDeliveryOutboxPort(outbox);
  const snapshot: any = { version: 1, managerBootId: "old-manager", observedAt: 1, lastActivityAt: 1, reason: "before_stop",
    observation: { ...daemon.getWorkingStateObservation(), executionState: "working" }, references: [{ kind: "task", id: "task", version: 1, status: "claimed" }], totalReferences: 1, unavailable: [] };
  outbox.observeWorkingState("worker", snapshot); outbox.workingRecovery.discover("worker", snapshot);
  const episode = outbox.workingRecovery.get("worker")! as RecoveryEpisode;
  outbox.admitWorkingRecovery(episode, "private recovery continuation");
  const row = outbox.claimNext("manager", () => daemon.bootId, new Set())!;
  return { daemon, outbox, row, proof, markTurn, paste, enter, setPane: (s: string) => { pane = s; },
    setAdmitted: (b: boolean) => { admitted = b; }, deliver: () => daemon.deliverWorkingRecovery(row.payload.content, row, () => admitted) };
}
describe("working continuation reuses the durable pane fence without a user turn", () => {
  it("commits possible input before paste, sends one Enter, and never arms a user turn", async () => {
    const f = fixture();
    f.paste.mockImplementation(async (_text, options) => {
      expect(options.guard()).toBe(true);
      const db = (f.outbox as any).db;
      expect(db.prepare("SELECT enter_started_at FROM delivery_attempts WHERE delivery_id=?").get(f.row.deliveryId).enter_started_at).toBeTruthy();
      return true;
    });
    const sending = f.deliver(); await vi.advanceTimersByTimeAsync(1000); await sending;
    expect(f.paste).toHaveBeenCalledOnce(); expect(f.enter).toHaveBeenCalledOnce(); expect(f.markTurn).not.toHaveBeenCalled();
    expect(f.outbox.get(f.row.deliveryId)?.state).toBe("delivered"); expect(f.outbox.openReplyObligations("worker")).toHaveLength(0);
    expect(f.daemon.getWorkingStateObservation().recoveryDeliveryId).toBe(f.row.deliveryId);
  });
  it.each(["DRAFT\nREADY", "BUSY\nREADY", "unknown"])("does not paste into %s", pane => {
    return (async () => { const f = fixture(); f.setPane(pane); const sending = f.deliver(); await vi.advanceTimersByTimeAsync(1000); await sending;
      expect(f.paste).not.toHaveBeenCalled(); expect(f.enter).not.toHaveBeenCalled(); expect(f.outbox.get(f.row.deliveryId)?.state).toBe("retry_wait"); })();
  });
  it("revalidates after a held capture and rejects a replacement generation", async () => {
    const f = fixture(); let release!: (s: string) => void;
    f.daemon.tmux.capturePane.mockImplementation(() => new Promise<string>(resolve => { release = resolve; }));
    const sending = f.deliver(); await vi.advanceTimersByTimeAsync(0); f.daemon.beginSpawn(); f.daemon.endSpawn();
    release("READY"); await vi.advanceTimersByTimeAsync(1000); await sending;
    expect(f.paste).not.toHaveBeenCalled(); expect(f.enter).not.toHaveBeenCalled();
  });
  it("refuses newly observed background work even when the prior cached inventory was unknown", async () => {
    const f = fixture(); f.daemon.workingBackgroundObservation = null;
    f.daemon.backend.backgroundWorkRunning = () => true;
    const sending = f.deliver(); await vi.advanceTimersByTimeAsync(1000); await sending;
    expect(f.paste).not.toHaveBeenCalled(); expect(f.enter).not.toHaveBeenCalled();
    expect(f.outbox.get(f.row.deliveryId)?.state).toBe("retry_wait");
  });
  it("a cancel or hot opt-out after paste cannot send Enter; the uncertain write is never replayed", async () => {
    const f = fixture(); f.paste.mockImplementation(async () => { f.setAdmitted(false); return true; });
    await f.deliver(); expect(f.paste).toHaveBeenCalledOnce(); expect(f.enter).not.toHaveBeenCalled();
    expect(f.outbox.get(f.row.deliveryId)?.state).toBe("uncertain");
    expect(f.outbox.claimNext("other-manager", () => "other-daemon", new Set())).toBeUndefined();
  });
  it("a real user cancel marks recovery cancelled even when a later writer captures the new delivery epoch", async () => {
    const f = fixture(); f.daemon.clearPendingDeliveries();
    expect(f.daemon.getWorkingRecoveryState().cancelled).toBe(true);
    const sending = f.deliver(); await vi.advanceTimersByTimeAsync(1000); await sending;
    expect(f.paste).not.toHaveBeenCalled(); expect(f.enter).not.toHaveBeenCalled();
  });
  it("another queued input after paste still cancels Enter during an owned write", async () => {
    const f = fixture(); f.paste.mockImplementation(async () => { f.daemon.pasteQueueDepth = 1; return true; });
    const sending = f.deliver(); await vi.advanceTimersByTimeAsync(1000); await sending;
    expect(f.paste).toHaveBeenCalledOnce(); expect(f.enter).not.toHaveBeenCalled();
    expect(f.outbox.get(f.row.deliveryId)?.state).toBe("uncertain");
  });
  it("unrelated work observed before admission still blocks after it returns idle", async () => {
    const f = fixture();
    for (const state of ["working", "idle"]) f.daemon.applyInstanceStateSnapshot({ state, observedAt: Date.now(), stateChangedAt: Date.now(), unchangedForMs: 0 });
    await f.deliver(); expect(f.paste).not.toHaveBeenCalled(); expect(f.enter).not.toHaveBeenCalled();
    expect(f.outbox.get(f.row.deliveryId)?.state).toBe("retry_wait");
  });
  it("unproven submission is uncertain after exactly one paste/Enter", async () => {
    const f = fixture(); f.proof.mockResolvedValue("stranded");
    const sending = f.deliver(); await vi.advanceTimersByTimeAsync(1000); await sending;
    expect(f.paste).toHaveBeenCalledOnce(); expect(f.enter).toHaveBeenCalledOnce(); expect(f.outbox.get(f.row.deliveryId)?.state).toBe("uncertain");
    expect(f.daemon.getWorkingStateObservation().recoveryDeliveryId).toBeUndefined();
  });
});
