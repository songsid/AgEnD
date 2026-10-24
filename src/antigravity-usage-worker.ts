/** #2122: the Antigravity usage scan's thread (antigravity-usage-scan.ts): one scan per worker, its answer posted back. */
import { parentPort, workerData } from "node:worker_threads";
import { scanAntigravityUsage, type AntigravityScanInput } from "./antigravity-usage-scan.js";

try { parentPort?.postMessage({ ok: true, out: scanAntigravityUsage(workerData as AntigravityScanInput) }); }
catch (err) { parentPort?.postMessage({ ok: false, error: String(err) }); }
