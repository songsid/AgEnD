/**
 * #2122: run one Kiro usage scan (kiro-usage-scan.ts) on a worker thread, so a classic conversation's JSON (tens of MB)
 * is parsed off the fleet loop. A scan that has not answered in `timeoutMs` is terminated and reads as failed; nothing
 * it read is kept, and the next pass reads again from the same cursors.
 */
import { Worker } from "node:worker_threads";
import type { KiroScanInput, KiroScanOutput } from "./kiro-usage-scan.js";

export const KIRO_SCAN_TIMEOUT_MS = 120_000;

function worker(input: KiroScanInput): Worker {
  const limits = { maxOldGenerationSizeMb: 768 };
  return import.meta.url.endsWith(".ts")
    ? new Worker(`const { workerData } = require("node:worker_threads"); import("tsx/esm/api").then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));`,
      { eval: true, execArgv: [], resourceLimits: limits, workerData: { ...input, entry: new URL("./kiro-usage-worker.ts", import.meta.url).href } })
    : new Worker(new URL("./kiro-usage-worker.js", import.meta.url), { execArgv: [], resourceLimits: limits, workerData: input });
}

export function runKiroUsageScan(input: KiroScanInput, timeoutMs = KIRO_SCAN_TIMEOUT_MS): Promise<KiroScanOutput> {
  return new Promise((resolve, reject) => {
    let w: Worker;
    try { w = worker(input); } catch (err) { reject(err); return; }
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); void w.terminate().catch(() => {}); fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error("kiro usage scan timed out"))), timeoutMs);
    timer.unref?.();
    w.on("message", (m: { ok: boolean; out?: KiroScanOutput; error?: string }) => finish(() => (m.ok ? resolve(m.out!) : reject(new Error(m.error ?? "kiro usage scan failed")))));
    w.on("error", (err) => finish(() => reject(err)));
    w.on("exit", (code) => finish(() => reject(new Error(`kiro usage scan exited (${code})`))));
  });
}
