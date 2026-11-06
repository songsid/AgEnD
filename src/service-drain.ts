/** Startup admission only. Service managers retain restart ownership; this module sends no PID signals. */
import { FLEET_STOP_TIMEOUT_MS, detachedProcessExited, detachedProcessStart } from "./fleet-stop-budget.js";

export interface ServiceDrainDeps {
  current(): boolean;
  processStopped(): boolean;
  listenersClosed(): boolean | Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class ServiceDrainError extends Error {
  constructor(readonly reason: "changed" | "timeout") {
    super(reason === "changed" ? "Service settings changed; no replacement was started" : "Old service job, process or listeners did not close; no replacement was started");
  }
}

/** Called by the replacement before claiming the fleet singleton or constructing any runtime. */
export async function waitForServiceDrain(deps: ServiceDrainDeps): Promise<void> {
  const assert = () => { if (!deps.current()) throw new ServiceDrainError("changed"); };
  assert();
  const deadline = deps.now() + FLEET_STOP_TIMEOUT_MS;
  for (;;) {
    assert();
    const gone = deps.processStopped() && await deps.listenersClosed();
    assert();
    if (gone) return;
    const remaining = deadline - deps.now();
    if (remaining <= 0) throw new ServiceDrainError("timeout");
    await deps.sleep(Math.min(250, remaining));
  }
}

export type ServiceProcessState = "gone" | "unknown" | { birth: string };
function inspect(pid: number): ServiceProcessState {
  try { process.kill(pid, 0); }
  catch (err) { return (err as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown"; }
  if (detachedProcessExited(pid)) return "gone";
  const birth = detachedProcessStart(pid);
  return birth ? { birth } : "unknown";
}

/** Capture the prior identity before waiting. A reused PID is no longer the old process; unreadable identity never proves exit. */
export function captureServiceProcess(pid: number | null, read: (pid: number) => ServiceProcessState = inspect): () => boolean {
  if (pid === null) return () => true; // No recorded old PID; manager job ordering and the singleton lock still apply.
  if (!Number.isSafeInteger(pid) || pid <= 1) throw Error("Service main process is invalid; nothing was stopped");
  const before = read(pid);
  if (before === "unknown") throw Error("Service main process identity is unavailable; nothing was stopped");
  if (before === "gone") return () => true;
  return () => {
    const current = read(pid);
    return current === "gone" || current !== "unknown" && current.birth !== before.birth;
  };
}
