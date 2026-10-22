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
 * Send a notification without blocking the event loop.
 *
 * The watchdog ping exists to prove this process is still turning its event
 * loop. Proving it with `execFileSync` stopped the loop for as long as the fork
 * took — up to the 5s timeout — every 30 seconds, and forking is slowest exactly
 * when the machine is loaded, i.e. when the ping matters. A fire-and-forget spawn
 * says the same thing about liveness (the timer fired, the call was made) without
 * contradicting itself.
 *
 * Still a subprocess: Node does not expose AF_UNIX datagram sockets, so
 * systemd-notify remains the only way to reach NOTIFY_SOCKET from here.
 */
export function sdNotify(state: string): void {
  defaultNotifier(state);
}

/** Where a skipped or failed notification is said (the fleet's logger). Unset: nothing is said. */
export type SdNotifyWarn = (fields: Record<string, unknown>, message: string) => void;
let warnSink: SdNotifyWarn | null = null;
export function setSdNotifyWarn(sink: SdNotifyWarn | null): void { warnSink = sink; }

/** At most one warning per kind in this window: a ping is every 30 s, the log must not be. */
export const SD_NOTIFY_WARN_INTERVAL_MS = 10 * 60_000;

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
 * the log, and the abort that followed looked like a hang. Now each says so, rate-limited per kind.
 */
export function createSdNotifier(deps: SdNotifierDeps): (state: string) => void {
  const now = deps.now ?? (() => performance.now());
  const lastWarnAt = new Map<string, number>();
  const warn = (kind: string, fields: Record<string, unknown>, message: string): void => {
    const sink = deps.warn();
    if (!sink) return;
    const at = now(), last = lastWarnAt.get(kind);
    if (last !== undefined && at - last < SD_NOTIFY_WARN_INTERVAL_MS) return;
    lastWarnAt.set(kind, at);
    try { sink(fields, message); } catch { /* reporting must never break the ping */ }
  };
  return (state: string): void => {
    if (!deps.socket) return;
    const pid = deps.pid(), recorded = deps.recordedPid();
    if (recorded !== pid) {
      warn("not_owner", { state, pid, recordedPid: recorded },
        "systemd notification not sent: fleet.pid does not name this process, so systemd's watchdog is not being fed");
      return;
    }
    try {
      deps.send(state, deps.socket, error => {
        if (error) warn("notify_failed", { state, error: error.message, code: (error as { code?: unknown }).code },
          "systemd-notify failed; systemd's watchdog may not be fed");
      });
    } catch (error) {
      warn("notify_failed", { state, error: (error as Error).message }, "systemd-notify could not be started; systemd's watchdog may not be fed");
    }
  };
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
  if (!notifySocket || !isFleetOwner()) return;
  try {
    sendSystemdNotification(state, notifySocket, process.env);
  } catch { /* best effort */ }
}
