import { execFileSync } from "node:child_process";

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
  if (socket) delete environment.NOTIFY_SOCKET;
  return socket || undefined;
}

export function buildNotifyEnvironment(
  environment: NodeJS.ProcessEnv,
  socket: string,
): NodeJS.ProcessEnv {
  return { ...environment, NOTIFY_SOCKET: socket };
}

const notifySocket = consumeNotifySocket(process.env);

export function sdNotify(state: string): void {
  if (!notifySocket) return;
  try {
    execFileSync("systemd-notify", [state], {
      env: buildNotifyEnvironment(process.env, notifySocket),
      stdio: "ignore",
      timeout: 5000,
    });
  } catch { /* best effort */ }
}
