/** #2122: the OpenCode usage scan's thread (opencode-usage-scan.ts): one scan per worker, its answer posted back. */
import { parentPort, workerData } from "node:worker_threads";
import { scanOpencodeUsage, type OpencodeScanInput } from "./opencode-usage-scan.js";

try { parentPort?.postMessage({ ok: true, out: scanOpencodeUsage(workerData as OpencodeScanInput) }); }
catch (err) { parentPort?.postMessage({ ok: false, error: String(err) }); }
