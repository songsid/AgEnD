import { execFile, execFileSync } from "node:child_process";
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
  try {
    const fleetPid = Number.parseInt(
      readFileSync(join(dataDir, "fleet.pid"), "utf8").trim(),
      10,
    );
    return Number.isSafeInteger(fleetPid) && fleetPid === pid;
  } catch {
    return false;
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
): void {
  execute(
    "systemd-notify",
    [state],
    { env: buildNotifyEnvironment(environment, socket), timeout: 5000 },
    () => { /* best effort: a failed ping is handled by WatchdogSec, not by us */ },
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
  if (!notifySocket || !isFleetOwner()) return;
  try {
    sendSystemdNotificationAsync(state, notifySocket, process.env);
  } catch { /* best effort */ }
}

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
