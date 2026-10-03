import { parentPort, workerData } from "node:worker_threads";
import { runBackendProbe, type BackendProbeInput } from "./cli-env-probe.js";

const input = workerData as BackendProbeInput;

async function main(): Promise<void> {
  try {
    const result = await runBackendProbe(input);
    parentPort?.postMessage({ ok: true, result });
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    parentPort?.close();
  }
}

void main();
