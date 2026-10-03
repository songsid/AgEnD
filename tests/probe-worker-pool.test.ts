import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProbeWorkerPool, type ProbeWorker } from "../src/probe-worker-pool.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function handle() {
  const result = deferred<string | null>();
  const stop = deferred<void>();
  const worker: ProbeWorker<string> = { promise: result.promise, stopped: stop.promise, terminate: vi.fn() };
  return { worker, result, stop, start: vi.fn(() => worker) };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const options = { deadlineMs: 100 };
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("bounded probe worker admission", () => {
  it("shares a two-isolate limit and frees a slot only after the isolate stops", async () => {
    const pool = new ProbeWorkerPool();
    const [a, b, c] = [handle(), handle(), handle()];
    const pa = pool.run("a", a!.start, options);
    void pool.run("b", b!.start, options);
    const pc = pool.run("c", c!.start, options);
    expect(a!.start).toHaveBeenCalledOnce();
    expect(b!.start).toHaveBeenCalledOnce();
    expect(c!.start).not.toHaveBeenCalled();
    a!.result.resolve("done");
    expect(await pa).toBe("done");
    expect(c!.start).not.toHaveBeenCalled();
    a!.stop.resolve();
    await flush();
    expect(c!.start).toHaveBeenCalledOnce();
    c!.result.resolve("third"); c!.stop.resolve(); b!.stop.resolve();
    expect(await pc).toBe("third");
    pool.close();
  });

  it("serializes one cache key while unrelated backends still make progress", async () => {
    const pool = new ProbeWorkerPool();
    const a = handle(), refresh = handle(), other = handle();
    void pool.run("codex", a.start, options);
    const pr = pool.run("codex", refresh.start, options);
    void pool.run("muse", other.start, options);
    expect(refresh.start).not.toHaveBeenCalled();
    expect(other.start).toHaveBeenCalledOnce();
    a.result.resolve("ordinary"); a.stop.resolve();
    await flush();
    expect(refresh.start).toHaveBeenCalledOnce();
    refresh.result.resolve("vendor"); refresh.stop.resolve();
    expect(await pr).toBe("vendor");
    pool.close(); other.stop.resolve();
  });

  it("counts queue waiting toward the deadline and never starts an expired job", async () => {
    const pool = new ProbeWorkerPool(1);
    const a = handle(), b = handle();
    void pool.run("a", a.start, { deadlineMs: 1000 });
    const pb = pool.run("b", b.start, options);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pb).toBeNull();
    expect(b.start).not.toHaveBeenCalled();
    a.stop.resolve(); await flush();
    expect(b.start).not.toHaveBeenCalled();
    pool.close();
  });

  it("a deadline returns null, cancels once and ignores late results without freeing a live slot", async () => {
    const pool = new ProbeWorkerPool(1);
    const a = handle(), b = handle();
    const timeout = vi.fn();
    const pa = pool.run("a", a.start, { ...options, onTimeout: timeout });
    const pb = pool.run("b", b.start, { deadlineMs: 1000 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pa).toBeNull();
    expect(timeout).toHaveBeenCalledOnce();
    expect(a.worker.terminate).toHaveBeenCalledOnce();
    expect(b.start).not.toHaveBeenCalled();
    a.result.resolve("too late"); await flush();
    expect(b.start).not.toHaveBeenCalled();
    a.stop.resolve(); await flush();
    expect(b.start).toHaveBeenCalledOnce();
    b.result.resolve("fresh"); b.stop.resolve();
    expect(await pb).toBe("fresh");
    expect(await pa).toBeNull();
  });

  it("admission does not restart the deadline after queue waiting", async () => {
    const pool = new ProbeWorkerPool(1);
    const a = handle(), b = handle();
    void pool.run("a", a.start, { deadlineMs: 1000 });
    const pb = pool.run("b", b.start, options);
    await vi.advanceTimersByTimeAsync(80);
    a.result.resolve("done"); a.stop.resolve(); await flush();
    expect(b.start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20);
    expect(b.worker.terminate).toHaveBeenCalledOnce();
    expect(await pb).toBeNull(); b.stop.resolve();
  });

  it("rejects a late result even when the deadline callback has not run yet", async () => {
    const pool = new ProbeWorkerPool();
    const a = handle(); const pa = pool.run("a", a.start, options);
    const clock = vi.spyOn(performance, "now").mockReturnValue(101);
    a.result.resolve("late");
    expect(await pa).toBeNull(); expect(a.worker.terminate).toHaveBeenCalledOnce();
    a.stop.resolve(); clock.mockRestore();
  });

  it("clears a successful job's timer", async () => {
    const pool = new ProbeWorkerPool();
    const a = handle(), timeout = vi.fn();
    const pa = pool.run("a", a.start, { ...options, onTimeout: timeout });
    a.result.resolve("ok"); a.stop.resolve();
    expect(await pa).toBe("ok");
    await vi.advanceTimersByTimeAsync(100);
    expect(timeout).not.toHaveBeenCalled();
    expect(a.worker.terminate).not.toHaveBeenCalled();
  });

  it("spawn failures release the reservation and the following job runs", async () => {
    const pool = new ProbeWorkerPool(1);
    const error = new Error("cannot create worker");
    const onError = vi.fn();
    expect(await pool.run("a", () => { throw error; }, { ...options, onError })).toBeNull();
    const b = handle(); const pb = pool.run("a", b.start, options);
    expect(onError).toHaveBeenCalledWith(error);
    expect(b.start).toHaveBeenCalledOnce();
    b.result.resolve("recovered"); b.stop.resolve(); expect(await pb).toBe("recovered");
  });

  it("a rejected result cancels, but does not admit another isolate before stopping", async () => {
    const pool = new ProbeWorkerPool(1);
    const a = handle(), b = handle(), onError = vi.fn();
    const pa = pool.run("a", a.start, { ...options, onError });
    void pool.run("b", b.start, options);
    a.result.reject(new Error("crash"));
    expect(await pa).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(a.worker.terminate).toHaveBeenCalledOnce();
    expect(b.start).not.toHaveBeenCalled();
    a.stop.resolve(); await flush(); expect(b.start).toHaveBeenCalledOnce();
    pool.close(); b.stop.resolve();
  });

  it("a failed stop notification retains capacity instead of oversubscribing", async () => {
    const pool = new ProbeWorkerPool(1);
    const a = handle(), b = handle(), onError = vi.fn();
    void pool.run("a", a.start, { ...options, onError });
    const pb = pool.run("b", b.start, options);
    a.stop.reject(new Error("not confirmed stopped")); await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(b.start).not.toHaveBeenCalled();
    pool.close(); expect(await pb).toBeNull();
  });

  it("close cancels active and queued work without starting queued workers", async () => {
    const pool = new ProbeWorkerPool(1);
    const a = handle(), b = handle();
    const pa = pool.run("a", a.start, options), pb = pool.run("b", b.start, options);
    pool.close();
    expect(await pa).toBeNull(); expect(await pb).toBeNull();
    expect(a.worker.terminate).toHaveBeenCalledOnce();
    expect(b.start).not.toHaveBeenCalled();
    expect(await pool.run("c", b.start, options)).toBeNull();
    a.stop.resolve(); await flush();
    expect(b.start).not.toHaveBeenCalled();
  });

  it("reopen preserves reservations for old isolates still stopping", async () => {
    const pool = new ProbeWorkerPool(1);
    const a = handle(), b = handle();
    void pool.run("same", a.start, options);
    pool.close(); pool.reopen();
    const pb = pool.run("same", b.start, options);
    expect(b.start).not.toHaveBeenCalled();
    a.result.resolve("old epoch"); await flush();
    expect(b.start).not.toHaveBeenCalled();
    a.stop.resolve(); await flush();
    expect(b.start).toHaveBeenCalledOnce();
    b.result.resolve("new epoch"); b.stop.resolve(); expect(await pb).toBe("new epoch");
  });

  it("a throwing cancellation/diagnostic cannot break the deadline boundary", async () => {
    const pool = new ProbeWorkerPool(1);
    const a = handle();
    vi.mocked(a.worker.terminate).mockImplementation(() => { throw new Error("stop failed"); });
    const diagnostic = vi.fn(() => { throw new Error("logger failed"); });
    const pa = pool.run("a", a.start, { ...options, onTimeout: diagnostic, onError: diagnostic });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pa).toBeNull();
    expect(diagnostic).toHaveBeenCalledTimes(2);
    a.stop.resolve(); await flush();
  });
});
