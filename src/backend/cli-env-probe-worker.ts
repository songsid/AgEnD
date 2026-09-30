import { parentPort, workerData } from "node:worker_threads";
import { createBackend } from "./factory.js";
import type { CliBackendConfig } from "./types.js";

interface ProbeWorkerInput {
  backend: string;
  instanceDir: string;
  config: CliBackendConfig;
  refreshVendorCatalog: boolean;
}

const input = workerData as ProbeWorkerInput;

async function main(): Promise<void> {
  try {
    const backend = createBackend(input.backend, input.instanceDir);
    if (!backend.probeCLIEnv) {
      parentPort?.postMessage({ ok: true, result: null });
      return;
    }
    if (input.refreshVendorCatalog && backend.refreshModelCatalog) {
      await backend.refreshModelCatalog();
    }
    const result = await backend.probeCLIEnv(input.config);
    parentPort?.postMessage({ ok: true, result });
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    parentPort?.close();
  }
}

void main();
