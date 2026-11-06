/** A replacement waits before claiming the fleet lock, constructing runtimes or opening Hub listeners. */
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadRawFleetConfigSource } from "../config.js";
import { captureServiceProcess, ServiceDrainError, waitForServiceDrain, type ServiceProcessState } from "../service-drain.js";
import { listenProblems } from "./init/initializer.js";
import { checkHubInitNetworkForHome, type HubInitListeners, type HubNetworkCheck } from "./init/network.js";

export type HubServiceStartReason = "config" | "process" | "listeners" | "timeout";
export class HubServiceStartError extends Error {
  constructor(readonly reason: HubServiceStartReason) { super(`hub_service_start_${reason}`); }
}
export interface HubServiceStartDeps {
  inspectProcess?: (pid: number) => ServiceProcessState;
  checkListeners?: HubNetworkCheck;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function previousPid(home: string): { pid: number; writtenAtMs: number } | null {
  let fd: number;
  try { fd = openSync(join(home, "fleet.pid"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw new HubServiceStartError("process"); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 32 || process.getuid && st.uid !== process.getuid()) throw new HubServiceStartError("process");
    const bytes = Buffer.alloc(33), count = readSync(fd, bytes, 0, 33, 0);
    if (count > 32) throw new HubServiceStartError("process");
    const text = bytes.subarray(0, count).toString("utf8").trim();
    if (!/^[1-9]\d{0,9}$/.test(text) || Number(text) <= 1) throw new HubServiceStartError("process");
    if (!Number.isFinite(st.mtimeMs)) throw new HubServiceStartError("process");
    return { pid: Number(text), writtenAtMs: st.mtimeMs };
  } finally { closeSync(fd); }
}

/** Installation must not signal a PID claim. An active manual Hub is stopped through the existing owner command. */
export function assertHubServiceInstallIdle(home: string, read?: (pid: number) => ServiceProcessState): void {
  try {
    const claim = previousPid(home);
    if (!captureServiceProcess(claim?.pid ?? null, read, claim?.writtenAtMs)()) throw Error("still running");
  }
  catch { throw new HubServiceStartError("process"); }
}

/** Off means no PID/socket inspection. No signal, PID-file deletion, service control, directory or model call. */
export async function waitForHubServiceStart(home: string, deps: HubServiceStartDeps = {}): Promise<void> {
  const path = join(home, "fleet.yaml");
  let source: string, listeners: HubInitListeners;
  try {
    source = readFileSync(path, "utf8");
    const raw = loadRawFleetConfigSource(source), hub = raw.hub as Record<string, unknown> | undefined;
    if (hub?.enabled !== true) return;
    listeners = { webListen: hub.webListen as HubInitListeners["webListen"], memberListen: hub.memberListen as HubInitListeners["memberListen"] };
    if (listenProblems("web", listeners.webListen).length || listenProblems("member", listeners.memberListen).length) throw Error("invalid listeners");
  } catch { throw new HubServiceStartError("config"); }
  let processStopped: () => boolean;
  try {
    const claim = previousPid(home);
    processStopped = captureServiceProcess(claim?.pid ?? null, deps.inspectProcess, claim?.writtenAtMs);
  }
  catch { throw new HubServiceStartError("process"); }
  try {
    await waitForServiceDrain({
      current: () => { try { return readFileSync(path, "utf8") === source; } catch { return false; } },
      processStopped,
      listenersClosed: async () => {
        let problems;
        try { problems = await (deps.checkListeners ? deps.checkListeners(listeners) : checkHubInitNetworkForHome(home, listeners)); }
        catch { throw new HubServiceStartError("listeners"); }
        if (problems.some(p => p.reason !== "occupied")) throw new HubServiceStartError("listeners");
        return problems.length === 0;
      },
      now: deps.now ?? (() => performance.now()), sleep: deps.sleep ?? (async ms => { await sleep(ms); }),
    });
  } catch (err) {
    if (err instanceof ServiceDrainError) throw new HubServiceStartError(err.reason === "changed" ? "config" : "timeout");
    throw err;
  }
}
