import { statSync } from "node:fs";
import { userInfo } from "node:os";

/** Only ENOENT proves it gone: a socket this process may not stat (EACCES) is not called missing. */
function socketExists(path: string): boolean {
  try { statSync(path); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

/**
 * Why a notification cannot arrive, when the socket itself says so (log only): a filesystem socket (an '@' one is
 * abstract and has no file) that no longer exists. On a user unit it lives in the user manager's runtime dir,
 * /run/user/<uid>; logind removes that dir when the user's last session ends without linger, and the manager's notify
 * socket goes with it, so READY and WATCHDOG never reach systemd and it restarts the fleet. null: nothing to say.
 * A module of its own, with no side effects: sd-notify.ts takes NOTIFY_SOCKET out of the environment when it loads,
 * and `agend doctor` asks this too.
 */
export function notifySocketProblem(socket: string | undefined, exists: (path: string) => boolean = socketExists): Record<string, unknown> | null {
  if (!socket || socket.startsWith("@")) return null;
  try { if (exists(socket)) return null; } catch { return null; }
  const runtime = /^\/run\/user\/(\d+)\//.exec(socket);
  let user = "<user>";
  try { user = userInfo().username || user; } catch { /* no passwd entry: the placeholder */ }
  const hint = runtime
    ? `the user manager's runtime dir is gone (e.g. /run/user/${runtime[1]} removed without linger): loginctl enable-linger ${user}, then systemctl restart user@${runtime[1]}.service`
    : `systemd's notify socket ${socket} does not exist`;
  return { socketMissing: true, socket, hint };
}
