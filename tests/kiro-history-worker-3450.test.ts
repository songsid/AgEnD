import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ workers: [] as Array<{ emit(event: string, value: unknown): boolean; terminate: ReturnType<typeof vi.fn>; release(): void }> }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    release!: () => void;
    private exited = new Promise<number>(resolve => { this.release = () => resolve(0); });
    terminate = vi.fn(() => this.exited);
    constructor() { super(); state.workers.push(this); }
  } };
});
import { runKiroHistoryScan } from "../src/kiro-usage-run.js";
const input = { dbPath: "/synthetic/db", kiroHome: "/synthetic/home", cwds: ["/synthetic/work"], profile: "default", zone: "UTC", before: "2026-10-01",
  cursor: { phase: "classic" as const, key: "", id: "" } };
afterEach(() => { state.workers.length = 0; vi.useRealTimers(); });

it.each(["result", "timeout"])("history %s retains the physical worker until termination settles", async how => {
  vi.useFakeTimers();
  let settled = false;
  const scan = runKiroHistoryScan(input, 10).then(value => { settled = true; return value; }, error => { settled = true; return String(error); });
  const worker = state.workers[0]!;
  const out = { rows: [], cursor: input.cursor, done: true, readBytes: 0, sources: 0 };
  if (how === "result") worker.emit("message", { ok: true, out });
  else await vi.advanceTimersByTimeAsync(10);
  await Promise.resolve();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  worker.release();
  expect(await scan).toEqual(how === "result" ? out : "Error: kiro history scan timed out");
});
