import { parentPort, workerData } from "node:worker_threads";
import { scanKiroHistory, type KiroHistoryInput } from "./kiro-history-scan.js";
try { parentPort?.postMessage({ ok: true, out: scanKiroHistory(workerData as KiroHistoryInput) }); }
catch (err) { parentPort?.postMessage({ ok: false, error: String(err) }); }
