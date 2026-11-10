import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import { TmuxControlClient } from "../src/tmux-control.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { nativeHumanOrigin } from "../src/human-delivery-receipts.js";

const frame = (name: string) => readFileSync(join(import.meta.dirname, "fixtures/codex-receipt-3578", name + ".pane.txt"), "utf8");
const IDLE = frame("idle"), RETAINED = frame("enter-retained"), BUSY = frame("submitted-busy");
const FIXTURE_ID = "hmsg-00000000-0000-4000-8000-000000003578";
const homes: Array<{ dir: string; outbox: DeliveryOutbox }> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-10T10:00:00Z")); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); for (const h of homes.splice(0)) { h.outbox.close(); rmSync(h.dir, { recursive: true, force: true }); } });

/** Real daemon judge + real waitUntilIdle timers + real receipt settlement; only pane frames and key transport are inert. */
function replay() {
  const dir = mkdtempSync(join(tmpdir(), "agend-receipt-3578-"));
  const outbox = new DeliveryOutbox(join(dir, "outbox.db"), "test-manager"); homes.push({dir,outbox});
  const receipt = outbox.createHumanReceipt({ targetInstance: "test", originalBody: "Wait for the local mock response.",
    origin: nativeHumanOrigin("discord", "mock-bot", "mock-human", "Test person", false, "mock-message")!, inputKind: "fleet_inbound", managerBootId: "test-manager" });
  const bound = outbox.bindHumanReceipt(receipt.receipt_id, "test", "owner", "fixture wire", "test-manager");
  // Only the fresh receipt UUID is substituted; the actual captured layout and all parser bindings are retained.
  const replaceId = (p: string) => p.replaceAll(FIXTURE_ID, receipt.message_id);
  const state = { pane: replaceId(RETAINED), idle: false };
  const log: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child() { return this; } };
  const d: any = new Daemon("test", { working_directory: dir, backend: "codex", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 } } as any,
    dir, false, new CodexBackend(dir) as any, undefined, log);
  const capture = vi.fn(async () => state.pane);
  d.tmux = { capturePane: capture, getWindowId: () => "@owned" };
  const control: any = { stopped: false, isIdle: () => state.idle, logger: log };
  control.waitUntilIdle = (...args: any[]) => (TmuxControlClient.prototype.waitUntilIdle as any).apply(control, args);
  d.controlClient = control;
  const positive = vi.fn((tag: string) => outbox.settleHumanReceipt(receipt.receipt_id, "test", "owner", {
    receipt_id: receipt.receipt_id, verification_id: receipt.message_id, wire_sha256: bound.wire_sha256, owner_key: "owner", mode: "idle_submit", tag,
  }, "owner"));
  const signature = { value: "agend-human-id:" + receipt.message_id, unique: true, humanPositive: positive };
  const baseline = d.paneEvidence(IDLE, signature);
  const enter = vi.spyOn(d, "sendDeliveryEnter").mockImplementation(async () => { state.pane = replaceId(BUSY); return true; });
  return { d, state, capture, positive, signature, baseline, enter, replaceId, row: () => outbox.getHumanReceipt(receipt.receipt_id)! };
}

describe("Codex confirmation during the stranded-readiness wait (#3578)", () => {
  it("confirms a retained post-Enter frame once the real busy capture proves the receipt, without waiting for idle or sending Enter again", async () => {
    const h = replay();
    expect(h.d.judgeSubmission(h.state.pane,h.signature,h.baseline)).toBe("stranded");
    let settled: boolean | undefined;
    const done = h.d.confirmAfterEnter("@owned",Date.now(),h.signature,h.baseline,"test-retry").then((v:boolean) => {settled=v;return v;});
    setTimeout(() => { h.state.pane=h.replaceId(BUSY); }, 250);
    await vi.advanceTimersByTimeAsync(1_000);
    const promptResult=settled, receiptState=h.row().state;
    // Drain on the unpatched control too, so the fail-first assertion does not leave an owned wait behind.
    await vi.advanceTimersByTimeAsync(31_000); await done;
    expect(promptResult).toBe(true); expect(receiptState).toBe("delivered");
    expect(h.state.idle).toBe(false); expect(h.positive).toHaveBeenCalledOnce(); expect(h.enter).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("never confirms a permanently stranded message; the existing one-Enter retry still waits for positive readiness", async () => {
    const h=replay(); const done=h.d.confirmAfterEnter("@owned",Date.now(),h.signature,h.baseline,"test-retry");
    await vi.advanceTimersByTimeAsync(1_000); expect(h.row().state).toBe("queued"); expect(h.enter).not.toHaveBeenCalled();
    h.state.idle=true; await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toBe(true);expect(h.enter).toHaveBeenCalledOnce();expect(h.row().state).toBe("delivered");
  });
  it.each(["unreadable","wrong-id","output-only"])("%s is not positive delivery evidence during a busy wait",async mode=>{
    const h=replay(); const done=h.d.confirmAfterEnter("@owned",Date.now(),h.signature,h.baseline,"test-retry");
    setTimeout(()=>{h.state.pane=mode==="unreadable"?"unknown pane":mode==="wrong-id"?BUSY.replaceAll(FIXTURE_ID,"hmsg-another-receipt"):"unrelated output\n"+IDLE;},250);
    await vi.advanceTimersByTimeAsync(31_000);expect(await done).toBe(false);expect(h.row().state).toBe("queued");expect(h.positive).not.toHaveBeenCalled();expect(h.enter).not.toHaveBeenCalled();
  });
  it.each(["generation","window"])("a replacement %s retires the wait without crediting its pane or pressing Enter",async mode=>{
    const h=replay();let settled:boolean|undefined;
    const done=h.d.confirmAfterEnter("@owned",Date.now(),h.signature,h.baseline,"test-retry").then((v:boolean)=>{settled=v;return v});
    setTimeout(()=>{if(mode==="generation")h.d.spawnGeneration++;else h.d.tmux={capturePane:async()=>h.replaceId(BUSY)};},250);
    await vi.advanceTimersByTimeAsync(1_000);const early=settled;await vi.advanceTimersByTimeAsync(31_000);await done;
    expect(early).toBe(false);expect(h.row().state).toBe("queued");expect(h.positive).not.toHaveBeenCalled();expect(h.enter).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it("a held proof read stays single-flight and loses settlement authority when its readiness wait expires",async()=>{
    const h=replay();let release!:(pane:string)=>void;
    const held=new Promise<string>(resolve=>{release=resolve});
    h.capture.mockImplementationOnce(async()=>h.state.pane).mockImplementationOnce(()=>held);
    h.d.inputTransientGuardGeneration=h.d.spawnGeneration;
    const done=h.d.confirmAfterEnter("@owned",Date.now(),h.signature,h.baseline,"test-retry");
    await vi.advanceTimersByTimeAsync(1_000);expect(h.capture).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);expect(await done).toBe(false);
    release(h.replaceId(BUSY));await vi.advanceTimersByTimeAsync(0);
    expect(h.row().state).toBe("queued");expect(h.positive).not.toHaveBeenCalled();expect(h.enter).not.toHaveBeenCalled();
    expect(h.d.inputTransientGuardGeneration).toBe(h.d.spawnGeneration);expect(vi.getTimerCount()).toBe(0);
  });

});
