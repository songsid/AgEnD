import { statSync } from "node:fs";
import { userInfo } from "node:os";

/** Only ENOENT proves it gone: a socket this process may not stat (EACCES) is not called missing. */
function socketExists(path: string): boolean {
  try { statSync(path); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

/**
 * Why a notification cannot arrive, when the socket itself says so (log only): a filesystem socket (an '@' one is
 * abstract and has no file) that no longer exists. On a user unit it lives in the user manager's runtime dir,
 * /run/user/<uid>; when that dir is removed (logind, at the last session's end without linger) or replaced without its
 * systemd/ subdir (seen on WSL with linger on), the manager's notify socket is gone, READY and WATCHDOG never reach
 * systemd and it restarts the fleet. Restarting user@<uid> recreates it. null: nothing to say.
 * A module of its own, with no side effects: sd-notify.ts takes NOTIFY_SOCKET out of the environment when it loads,
 * and `agend doctor` asks this too.
 */
export function notifySocketProblem(socket: string | undefined, exists: (path: string) => boolean = socketExists): Record<string, unknown> | null {
  if (!socket || socket.startsWith("@")) return null;
  try { if (exists(socket)) return null; } catch { return null; }
  const runtime = /^\/run\/user\/(\d+)\//.exec(socket);
  let user = "<user>";
  try { user = userInfo().username || user; } catch { /* no passwd entry: the placeholder */ }
  // Restarting user@<uid> ends everything that manager runs, the fleet included; a user who is not root needs sudo.
  const sudo = runtime && runtime[1] !== "0" ? "sudo " : "";
  const hint = runtime
    ? `the user manager's notify socket is gone (/run/user/${runtime[1]} was removed or replaced without its systemd/ dir): ${sudo}systemctl restart user@${runtime[1]}.service (recreates /run/user/${runtime[1]}/systemd/notify; it also restarts the fleet and everything else that user runs, so run it from a host shell, not from an agent); if \`loginctl show-user ${user} -p Linger\` says no, also ${sudo}loginctl enable-linger ${user}`
    : `systemd's notify socket ${socket} does not exist`;
  return { socketMissing: true, socket, hint };
}
