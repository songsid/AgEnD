/** #2122: the Kiro usage scan's thread (kiro-usage-scan.ts): one scan per worker, its answer posted back. */
import { parentPort, workerData } from "node:worker_threads";
import { scanKiroUsage, type KiroScanInput } from "./kiro-usage-scan.js";

try { parentPort?.postMessage({ ok: true, out: scanKiroUsage(workerData as KiroScanInput) }); }
catch (err) { parentPort?.postMessage({ ok: false, error: String(err) }); }
