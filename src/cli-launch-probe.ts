/** Only this Node filesystem worker runs; never execute a product CLI for launch inspection. */
import { Worker } from "node:worker_threads";
import { ProbeWorkerPool, type ProbeWorker } from "./probe-worker-pool.js";
import type { CliLaunchSnapshot } from "./cli-launch-inspect.js";
const pool = new ProbeWorkerPool(2);
export const CLI_LAUNCH_INSPECTION_MS = 2000;
function worker(pid: number, path: string): ProbeWorker<CliLaunchSnapshot> {
  const w = import.meta.url.endsWith(".ts")
    ? new Worker(`const {workerData}=require('node:worker_threads');import('tsx/esm/api').then(({tsImport})=>tsImport(workerData.entry,workerData.entry));`, { eval: true, execArgv: [], workerData: { pid, path, entry: new URL("./cli-launch-inspect-worker.ts", import.meta.url).href } })
    : new Worker(new URL("./cli-launch-inspect-worker.js", import.meta.url), { execArgv: [], workerData: { pid, path } });
  let resolve!: (r: CliLaunchSnapshot | null) => void, stopped!: () => void;
  const promise = new Promise<CliLaunchSnapshot | null>(r => resolve = r), gone = new Promise<void>(r => stopped = r);
  w.once("message", resolve);
  w.once("error", () => resolve(null));
  w.once("exit", () => { resolve(null); stopped(); });
  return { promise, stopped: gone, terminate() { void w.terminate().catch(() => { }); } };
}
export function probeClaudeLaunch(pid: number, path: string): Promise<CliLaunchSnapshot | null> {
  if (process.platform !== "linux")
    return Promise.resolve(null);
  return pool.run(String(pid), () => worker(pid, path), { deadlineMs: CLI_LAUNCH_INSPECTION_MS });
}
