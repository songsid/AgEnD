import { describe, it, expect } from "vitest";
import { PaneWriteLock } from "../src/pane-write-lock.js";

/** A promise plus its resolver, so a test can hold a writer open on purpose. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("PaneWriteLock", () => {
  it("never lets two writers overlap", async () => {
    const lock = new PaneWriteLock();
    let concurrent = 0;
    let maxConcurrent = 0;
    const write = () => lock.run(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 5));
      concurrent--;
    });

    await Promise.all([write(), write(), write(), write()]);

    expect(maxConcurrent).toBe(1);
  });

  it("runs queued writers in admission order", async () => {
    const lock = new PaneWriteLock();
    const order: string[] = [];
    const write = (id: string, delayMs: number) => lock.run(async () => {
      await new Promise(r => setTimeout(r, delayMs));
      order.push(id);
    });

    // The first writer is the slowest: without the lock it would finish last.
    await Promise.all([write("a", 15), write("b", 1), write("c", 1)]);

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("keeps serving later writers after one of them throws", async () => {
    const lock = new PaneWriteLock();
    const done: string[] = [];

    const failing = lock.run(async () => { throw new Error("paste failed"); });
    const following = lock.run(async () => { done.push("after"); });

    // The rejection reaches its own caller...
    await expect(failing).rejects.toThrow("paste failed");
    // ...but does not poison the chain. A failed delivery must not wedge the pane
    // for every subsequent message.
    await following;
    expect(done).toEqual(["after"]);
  });

  it("tryRun skips instead of queueing while a writer holds the pane", async () => {
    const lock = new PaneWriteLock();
    const holder = deferred();
    let dismissed = false;

    const held = lock.run(() => holder.promise);
    const ran = await lock.tryRun(async () => { dismissed = true; });

    expect(ran).toBe(false);
    expect(dismissed).toBe(false);

    holder.resolve();
    await held;
  });

  it("tryRun skips a writer that is admitted but has not started yet", async () => {
    const lock = new PaneWriteLock();
    const holder = deferred();
    let dismissed = false;

    // No await between run() and tryRun(): the queued writer's callback has not
    // been invoked yet, so a lock that only tracked "currently executing" would
    // wrongly report the pane as free and let the dismisser write into it.
    const held = lock.run(() => holder.promise);
    const ran = await lock.tryRun(async () => { dismissed = true; });

    expect(ran).toBe(false);
    expect(dismissed).toBe(false);

    holder.resolve();
    await held;
  });

  it("tryRun runs and reports true once the pane is free again", async () => {
    const lock = new PaneWriteLock();
    const holder = deferred();
    const held = lock.run(() => holder.promise);

    expect(await lock.tryRun(async () => {})).toBe(false);
    holder.resolve();
    await held;

    let dismissed = false;
    expect(await lock.tryRun(async () => { dismissed = true; })).toBe(true);
    expect(dismissed).toBe(true);
    expect(lock.isBusy).toBe(false);
  });

  it("reports busy from admission until the writer settles", async () => {
    const lock = new PaneWriteLock();
    const holder = deferred();

    expect(lock.isBusy).toBe(false);
    const held = lock.run(() => holder.promise);
    expect(lock.isBusy).toBe(true);

    holder.resolve();
    await held;
    // Free the moment the caller's own promise settles — no trailing tick where a
    // poller would still be told the pane is in use.
    expect(lock.isBusy).toBe(false);
  });
});
