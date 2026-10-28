import { execFileSync } from "node:child_process";
import { execFile } from "./child-process.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgendHome } from "./paths.js";

/**
 * Keep systemd's notification socket private to the fleet process. The socket
 * path is a capability: any child that inherits it can send READY/WATCHDOG/
 * STOPPING on behalf of a NotifyAccess=all service.
 *
 * systemd-notify itself must remain an allowed child sender because Node does
 * not expose AF_UNIX datagram sockets. We therefore remove the capability from
 * the ambient process environment and pass it only to the short-lived helper.
 */
export function consumeNotifySocket(environment: NodeJS.ProcessEnv): string | undefined {
  const socket = environment.NOTIFY_SOCKET;
  delete environment.NOTIFY_SOCKET;
  return socket || undefined;
}

export function buildNotifyEnvironment(
  environment: NodeJS.ProcessEnv,
  socket: string,
): NodeJS.ProcessEnv {
  return { ...environment, NOTIFY_SOCKET: socket };
}

const notifySocket = consumeNotifySocket(process.env);

/** Only the process recorded as the fleet owner may exercise the capability. */
export function isFleetOwner(
  dataDir = getAgendHome(),
  pid = process.pid,
): boolean {
  return recordedFleetPid(dataDir) === pid;
}

/** The pid fleet.pid records, or null when it is missing or unreadable. */
export function recordedFleetPid(dataDir = getAgendHome()): number | null {
  try {
    const fleetPid = Number.parseInt(
      readFileSync(join(dataDir, "fleet.pid"), "utf8").trim(),
      10,
    );
    return Number.isSafeInteger(fleetPid) ? fleetPid : null;
  } catch {
    return null;
  }
}

type NotifyExecutor = (
  file: string,
  args: readonly string[],
  options: Parameters<typeof execFileSync>[2],
) => unknown;

/** Exported for a focused test of the exact helper environment. */
export function sendSystemdNotification(
  state: string,
  socket: string,
  environment: NodeJS.ProcessEnv,
  execute: NotifyExecutor = execFileSync,
): void {
  execute("systemd-notify", [state], {
    env: buildNotifyEnvironment(environment, socket),
    stdio: "ignore",
    timeout: 5000,
  });
}

export type AsyncNotifyExecutor = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
  callback: (error: Error | null) => void,
) => unknown;

/** Exported so a test can drive the async path without spawning anything. */
export function sendSystemdNotificationAsync(
  state: string,
  socket: string,
  environment: NodeJS.ProcessEnv,
  execute: AsyncNotifyExecutor = execFile as unknown as AsyncNotifyExecutor,
  onDone: (error: Error | null) => void = () => { /* best effort: a failed ping is handled by WatchdogSec */ },
): void {
  execute(
    "systemd-notify",
    [state],
    { env: buildNotifyEnvironment(environment, socket), timeout: 5000 },
    error => { try { onDone(error); } catch { /* reporting must never throw out of a child callback */ } },
  );
}

/**
 * Wait for the notify child asynchronously. execFile still has a synchronous
 * fork cost under host pressure; the shorter heartbeat interval and bounded
 * retry restore margin without an independent heartbeat or changing barriers.
 */
export function sdNotify(state: string): void {
  defaultNotifier(state);
}

/** Where a skipped or failed notification is said (the fleet's logger). Unset: nothing is said. */
export type SdNotifyWarn = (fields: Record<string, unknown>, message: string) => void;
let warnSink: SdNotifyWarn | null = null;
export function setSdNotifyWarn(sink: SdNotifyWarn | null): void { warnSink = sink; }

/** Repeated unchanged ownership skips may coalesce; delivery failures never do. */
export const SD_NOTIFY_WARN_INTERVAL_MS = 10 * 60_000;
/** More opportunities within WatchdogSec=60, still driven by the main loop. */
export const SD_WATCHDOG_INTERVAL_MS = 10_000;
export const SD_NOTIFY_RETRY_MS = 1_000;

/** Liveness is sampled only by the fleet's main loop, never an independent sender. */
export function startSdWatchdog(notify: (state: string) => void = sdNotify): ReturnType<typeof setInterval> {
  return setInterval(() => notify("WATCHDOG=1"), SD_WATCHDOG_INTERVAL_MS);
}

export interface SdNotifierDeps {
  socket: string | undefined;
  pid: () => number;
  recordedPid: () => number | null;
  send: (state: string, socket: string, onDone: (error: Error | null) => void) => void;
  warn: () => SdNotifyWarn | null;
  now?: () => number;
}

/**
 * The notification path, with what it depends on passed in (tests). A skipped notification used to be silent: a
 * fleet.pid naming another process, or a systemd-notify that failed, stopped the watchdog being fed with nothing in
 * the log, and the abort that followed looked like a hang. Delivery failures include the child outcome on every attempt; ownership skips coalesce.
 */
export function createSdNotifier(deps: SdNotifierDeps): ((state: string) => void) & { cancelRetry(): void } {
  const now = deps.now ?? (() => performance.now());
  const lastWarnAt = new Map<string, number>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  const cancelRetry = (): void => {
    generation++;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const warnOwner = (fields: Record<string, unknown>): void => {
    const at = now(), last = lastWarnAt.get("not_owner");
    if (last !== undefined && at - last < SD_NOTIFY_WARN_INTERVAL_MS) return;
    lastWarnAt.set("not_owner", at);
    try { deps.warn()?.(fields,
      "systemd notification not sent: fleet.pid does not name this process, so systemd's watchdog is not being fed"); } catch { /* reporting must never break the ping */ }
  };
  const attempt = (state: string, retry: boolean, epoch: number): void => {
    if (!deps.socket || epoch !== generation) return;
    const pid = deps.pid(), recorded = deps.recordedPid();
    if (recorded !== pid) {
      warnOwner({ state, pid, recordedPid: recorded });
      return;
    }
    const startedAt = now();
    let completed = false;
    const done = (error: Error | null): void => {
      if (completed) return;
      completed = true;
      if (!error) return;
      const detail = error as Error & { code?: unknown; signal?: unknown; killed?: boolean };
      // Every failed attempt is visible, including a failed retry. A later
      // successful ping needs no warning; only unchanged ownership skips coalesce.
      try { deps.warn()?.({ state, retry, error: error.message, code: detail.code ?? null,
        signal: detail.signal ?? null, killed: detail.killed ?? false,
        elapsedMs: Math.max(0, Math.round(now() - startedAt)) },
        "systemd-notify failed; systemd's watchdog may not be fed"); } catch { /* reporting must never break the ping */ }
      if (state === "WATCHDOG=1" && !retry && epoch === generation) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          attempt(state, true, epoch); // owner is checked again, and a retry never retries itself
        }, SD_NOTIFY_RETRY_MS);
        retryTimer.unref?.();
      }
    };
    try { deps.send(state, deps.socket, done); }
    catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
  };
  const notify = (state: string): void => {
    // A regular ping supersedes an older retry; STOPPING/READY also fence any
    // in-flight failure callback from rearming a heartbeat after lifecycle changes.
    cancelRetry();
    attempt(state, false, generation);
  };
  return Object.assign(notify, { cancelRetry });
}

const defaultNotifier = createSdNotifier({
  socket: notifySocket,
  pid: () => process.pid,
  recordedPid: () => recordedFleetPid(),
  send: (state, socket, onDone) => sendSystemdNotificationAsync(state, socket, process.env, undefined, onDone),
  warn: () => warnSink,
});

/**
 * Blocking variant, for the one case where the process is about to exit.
 *
 * `STOPPING=1` has to reach systemd before the event loop stops running, and an
 * async spawn queued on the way out may simply never be executed. Nothing else
 * should use this.
 */
export function sdNotifyBlocking(state: string): void {
  defaultNotifier.cancelRetry();
  if (!notifySocket || !isFleetOwner()) return;
  try {
    sendSystemdNotification(state, notifySocket, process.env);
  } catch { /* best effort */ }
}
