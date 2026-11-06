import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach as vitestBeforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({ autoReady: true }));
vi.mock("node:child_process", () => ({
  spawnSync: () => ({ status: 0 }),
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
      exitCode: number | null; signalCode: string | null; kill: () => void;
    };
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    vi.spyOn(child.stdin, "write");
    child.stdin.on("finish", () => { child.exitCode = 0; child.emit("close", 0); });
    child.kill = vi.fn(() => { child.signalCode = "SIGTERM"; child.emit("close", null); });
    if (controls.autoReady) queueMicrotask(() => child.stdout.write("__AGEND_BOOT__\n__AGEND_READY__7\n"));
    return child;
  }),
}));
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallerPsStartGate } from "./support/installer-ps-start.js";
import { InstallerPsBatch } from "./support/installer-ps-batch.js";

const cases = ["close", "deadline", "stdin"] as const;
const batches = cases.map(() => new InstallerPsBatch({ helpers: "function F { 'ok' }" }, false));
const startups = Array.from({ length: 4 }, () => new InstallerPsBatch({ helpers: "function F { 'ok' }" }, false));
const gateRoot = mkdtempSync(join(tmpdir(), "agend-lifecycle-gates-"));
const gates = Array.from({length: 5}, (_, n) => new InstallerPsStartGate(join(gateRoot, String(n)), 1));
const queuedTicket = gates[0]!.tryAcquire()!;
const gated = gates.map(g => new InstallerPsBatch({ helpers: "function F { 'ok' }" }, false, g));
afterAll(() => rmSync(gateRoot, { recursive: true, force: true }));
function childNow() { return vi.mocked(spawn).mock.results.at(-1)!.value as ReturnType<typeof spawn>; }
function signalReady(child: ReturnType<typeof spawn>) { child.stdout!.emit("data", Buffer.from("__AGEND_BOOT__\n__AGEND_READY__7\n")); }
async function activate(batch: InstallerPsBatch) { const ready = batch.ready(); const child = childNow(); signalReady(child); await ready; return child; }
const warmed = new InstallerPsBatch({ helpers: "function F { 'ok' }" });
vitestBeforeEach(() => { controls.autoReady = false; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("terminal PowerShell worker failures", () => {
  it.each(cases)("retains the first %s failure and never writes or waits on that worker again", async kind => {
    vi.useFakeTimers();
    const batch = batches[cases.indexOf(kind)]!;
    await activate(batch);
    const first = batch.run("helpers", "F").catch(error => error as Error);
    const child = childNow();
    await Promise.resolve();
    if (kind === "close") { Object.assign(child, { exitCode: 23 }); child.emit("close", 23); }
    else if (kind === "deadline") { await vi.advanceTimersByTimeAsync(10_000); }
    else { child.stdin!.emit("error", new Error("fixture stdin closed")); }
    const failure = await first;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(kind === "close" ? "exited 23" : kind === "deadline" ? "10 s test budget" : "fixture stdin closed");
    const writes = vi.mocked(child.stdin!.write).mock.calls.length;
    const again = batch.run("helpers", "throw 'must never be sent'");
    void again.catch(() => {});
    expect(child.stdin!.write).toHaveBeenCalledTimes(writes);
    expect(vi.getTimerCount()).toBe(0);
    await expect(again).rejects.toBe(failure);
  });
});


describe("PowerShell readiness boundary", () => {
  it("shares startup, writes no case before READY, and correlates concurrent replies", async () => {
    vi.useFakeTimers();
    const batch = startups[0]!; const count = vi.mocked(spawn).mock.calls.length;
    const first = batch.run("helpers", "F"); const second = batch.run("helpers", "F");
    const child = childNow();
    expect(vi.mocked(spawn).mock.calls.length).toBe(count + 1);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(child.stdin!.write).not.toHaveBeenCalled();
    child.stdout!.emit("data", Buffer.from("__AGEND_BOOT__\n"));
    expect(child.stdin!.write).not.toHaveBeenCalled();
    signalReady(child); await Promise.resolve();
    expect(child.stdin!.write).toHaveBeenCalledTimes(2);
    child.stdout!.emit("data", Buffer.from('__AGEND_BATCH__{"id":2,"out":"two","status":0}\n__AGEND_BATCH__{"id":1,"out":"one","status":0}\n'));
    await expect(first).resolves.toBe("one"); await expect(second).resolves.toBe("two");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds startup independently, kills once, and retains its cause after close/late READY", async () => {
    vi.useFakeTimers(); const batch = startups[1]!;
    const first = batch.run("helpers", "F").catch(e => e as Error); const child = childNow();
    await vi.advanceTimersByTimeAsync(9_999); expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const failure = await first; expect((failure as Error).message).toContain("startup readiness exceeded 10 s");
    expect(child.kill).toHaveBeenCalledTimes(1); expect(child.stdin!.write).not.toHaveBeenCalled();
    signalReady(child);
    await expect(batch.ready()).rejects.toBe(failure);
    await expect(batch.run("helpers", "F")).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("gives a ready worker the original 10 s case budget independently of startup", async () => {
    vi.useFakeTimers(); const batch = startups[2]!;
    const first = batch.run("helpers", "F").catch(e => e as Error); const child = childNow();
    await vi.advanceTimersByTimeAsync(7_999); signalReady(child); await Promise.resolve();
    expect(child.stdin!.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999); expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await first as Error).message).toContain("10 s test budget"); expect(child.kill).toHaveBeenCalledTimes(1);
  });
  it("rejects immediately when the child fails before readiness", async () => {
    vi.useFakeTimers(); const batch = startups[3]!;
    const ready = batch.ready().catch(e => e as Error); const child = childNow();
    const error = new Error("fixture launch failed"); child.emit("error", error);
    expect(await ready).toBe(error); expect(child.stdin!.write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("warms once in fixture setup before any case runs", async () => {
    const count = vi.mocked(spawn).mock.calls.length;
    await warmed.ready(); expect(vi.mocked(spawn).mock.calls.length).toBe(count);
    expect(count).toBeGreaterThan(0);
  });
});


describe("START queue integration", () => {
  it("does not charge queue time to START or case budgets, and releases at READY", async () => {
    vi.useFakeTimers(); const count = vi.mocked(spawn).mock.calls.length;
    const pending = gated[0]!.run("helpers", "F");
    await vi.advanceTimersByTimeAsync(15_000); expect(vi.mocked(spawn).mock.calls.length).toBe(count);
    queuedTicket.release(); await vi.advanceTimersByTimeAsync(20);
    const child = childNow(); expect(vi.mocked(spawn).mock.calls.length).toBe(count + 1);
    await vi.advanceTimersByTimeAsync(9_999); expect(child.kill).not.toHaveBeenCalled();
    signalReady(child); await Promise.resolve();
    const slot = gates[0]!.tryAcquire(); expect(slot).toBeDefined(); slot!.release();
    await vi.advanceTimersByTimeAsync(9_999); expect(child.kill).not.toHaveBeenCalled();
    child.stdout!.emit("data", Buffer.from('__AGEND_BATCH__{"id":1,"out":"done","status":0}\n'));
    await expect(pending).resolves.toBe("done"); expect(vi.getTimerCount()).toBe(0);
  });
  it("holds the START reservation until a timed-out child actually closes", async () => {
    vi.useFakeTimers(); const pending = gated[1]!.ready().catch(e => e as Error); const child = childNow();
    vi.mocked(child.kill).mockImplementation(() => true);
    await vi.advanceTimersByTimeAsync(10_000); expect((await pending as Error).message).toContain("readiness exceeded 10 s");
    expect(gates[1]!.tryAcquire()).toBeUndefined();
    child.emit("close", null); const next = gates[1]!.tryAcquire(); expect(next).toBeDefined(); next!.release();
  });
  it("releases a reservation if native spawn throws before creating a child", async () => {
    const error = new Error("fixture spawn refused"); vi.mocked(spawn).mockImplementationOnce(() => { throw error; });
    await expect(gated[2]!.ready()).rejects.toBe(error);
    const slot = gates[2]!.tryAcquire(); expect(slot).toBeDefined(); slot!.release();
  });
  it("fences a fixture closed while waiting so a late slot cannot launch", async () => {
    vi.useFakeTimers(); const ticket = gates[3]!.tryAcquire()!;
    const count = vi.mocked(spawn).mock.calls.length; const pending = gated[3]!.ready().catch(e => e as Error);
    // Model the registered afterAll's synchronous fence before its async drain.
    (gated[3] as unknown as {closed:boolean}).closed = true;
    ticket.release(); await vi.advanceTimersByTimeAsync(20);
    expect((await pending as Error).message).toContain("fixture closed"); expect(vi.mocked(spawn).mock.calls.length).toBe(count);
    const free = gates[3]!.tryAcquire(); expect(free).toBeDefined(); free!.release();
  });
  it("admits no late case when READY arrives after fixture close", async () => {
    const pending = gated[4]!.run("helpers", "must never be written").catch(e => e as Error); const child = childNow();
    (gated[4] as unknown as {closed:boolean}).closed = true;
    signalReady(child); await Promise.resolve(); expect(child.stdin!.write).not.toHaveBeenCalled();
    expect((await pending as Error).message).toContain("fixture closed before case");
    const slot = gates[4]!.tryAcquire(); expect(slot).toBeDefined(); slot!.release();
  });

});
