import type { Worker, WorkerOptions } from "node:worker_threads";
import { FakeProbeWorker } from "../helpers/probe-worker.js";

const owned = new Set<FakeProbeWorker | Worker>();
let realProbes = false;

function probeEntry(file: string | URL, options?: WorkerOptions): boolean {
  // Several unrelated isolates share the TS bootstrap. Its script text is NOT a discriminator.
  const entry: unknown = options?.eval ? options.workerData?.entry : file;
  if (typeof entry !== "string" && !(entry instanceof URL)) return false;
  let path: string;
  try { path = new URL(String(entry)).pathname; }
  catch { path = String(entry).replaceAll("\\", "/"); }
  return /\/backend\/cli-env-probe-worker\.(?:ts|js)$/.test(path.replaceAll("\\", "/"));
}

/** Opt in per test, not through environment inheritance; the native process guard is still installed. */
export function useRealProbeWorkers(): void { realProbes = true; }

export function testWorkerConstructor(NativeWorker: typeof Worker): typeof Worker {
  return new Proxy(NativeWorker, {
    construct(target, args, newTarget) {
      const [file, options] = args as [string | URL, WorkerOptions | undefined];
      if (!probeEntry(file, options)) return Reflect.construct(target, args, newTarget);
      const worker = realProbes ? Reflect.construct(target, args, newTarget) as Worker
        : new FakeProbeWorker(file, options as { workerData: ConstructorParameters<typeof FakeProbeWorker>[1]["workerData"] });
      owned.add(worker);
      return worker;
    },
  });
}

export function resetProbeWorkerDefault(): void {
  if (owned.size) throw new Error("Probe workers must drain before the next test");
  realProbes = false;
  FakeProbeWorker.reset();
  FakeProbeWorker.answer = () => null;
}

export async function drainProbeWorkers(): Promise<void> {
  realProbes = false; // cleanup must not admit new native discovery from an old pool queue
  // Resolving one pool reservation may start another queued fake. Drain those as well.
  while (owned.size) {
    const batch = [...owned];
    await Promise.all(batch.map(async worker => {
      if (worker instanceof FakeProbeWorker) {
        worker.reply(null); // settle result/deadline listeners in the real FleetManager
        const last = worker.terminate.mock.results.at(-1);
        const termination = last ? last.type === "return" ? Promise.resolve(last.value) : Promise.reject(last.value)
          : worker.terminate();
        // Fault suites deliberately reject/throw terminate(), then acknowledge an actual exit.
        await Promise.race([termination.catch(() => worker.exited), worker.exited]);
        worker.dispose();
      } else {
        await worker.terminate();
      }
      owned.delete(worker);
    }));
    await Promise.resolve();
  }
}
