/**
 * #2122: run one usage scan on a worker thread — Kiro's (kiro-usage-scan.ts: a classic conversation's JSON is tens of MB)
 * OpenCode's (opencode-usage-scan.ts) or Antigravity's (antigravity-usage-scan.ts: SQLite reads) — so it never runs on the
 * fleet loop. A scan that has not
 * answered in `timeoutMs` is terminated and reads as failed; nothing it read is kept, and the next pass reads again from
 * the same cursors.
 */
import { Worker } from "node:worker_threads";
import type { KiroScanInput, KiroScanOutput } from "./kiro-usage-scan.js";
import type { OpencodeScanInput, OpencodeScanOutput } from "./opencode-usage-scan.js";
import type { AntigravityScanInput, AntigravityScanOutput } from "./antigravity-usage-scan.js";

export const KIRO_SCAN_TIMEOUT_MS = 120_000;

type Entry = "kiro-usage-worker" | "opencode-usage-worker" | "antigravity-usage-worker";
function worker(entry: Entry, input: object): Worker {
  const limits = { maxOldGenerationSizeMb: 768 };
  return import.meta.url.endsWith(".ts")
    ? new Worker(`const { workerData } = require("node:worker_threads"); import("tsx/esm/api").then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));`,
      { eval: true, execArgv: [], resourceLimits: limits, workerData: { ...input, entry: new URL(`./${entry}.ts`, import.meta.url).href } })
    : new Worker(new URL(`./${entry}.js`, import.meta.url), { execArgv: [], resourceLimits: limits, workerData: input });
}

function run<O>(entry: Entry, input: object, timeoutMs: number, what: string): Promise<O> {
  return new Promise((resolve, reject) => {
    let w: Worker;
    try { w = worker(entry, input); } catch (err) { reject(err); return; }
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); void w.terminate().catch(() => {}); fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`${what} timed out`))), timeoutMs);
    timer.unref?.();
    w.on("message", (m: { ok: boolean; out?: O; error?: string }) => finish(() => (m.ok ? resolve(m.out!) : reject(new Error(m.error ?? `${what} failed`)))));
    w.on("error", (err) => finish(() => reject(err)));
    w.on("exit", (code) => finish(() => reject(new Error(`${what} exited (${code})`))));
  });
}

export const runKiroUsageScan = (input: KiroScanInput, timeoutMs = KIRO_SCAN_TIMEOUT_MS): Promise<KiroScanOutput> =>
  run<KiroScanOutput>("kiro-usage-worker", input, timeoutMs, "kiro usage scan");
export const runOpencodeUsageScan = (input: OpencodeScanInput, timeoutMs = KIRO_SCAN_TIMEOUT_MS): Promise<OpencodeScanOutput> =>
  run<OpencodeScanOutput>("opencode-usage-worker", input, timeoutMs, "opencode usage scan");
export const runAntigravityUsageScan = (input: AntigravityScanInput, timeoutMs = KIRO_SCAN_TIMEOUT_MS): Promise<AntigravityScanOutput> =>
  run<AntigravityScanOutput>("antigravity-usage-worker", input, timeoutMs, "antigravity usage scan");
