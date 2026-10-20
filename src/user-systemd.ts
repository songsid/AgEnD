/**
 * #2264: the user's systemd manager, reachable before any `systemctl --user` runs.
 *
 * The fleet runs as a user unit (com.agend.fleet). A user manager exists only while that user has a session — or has
 * linger. Root on WSL usually has neither once the starting shell is gone: `systemctl --user` then fails with "Failed to
 * connect to bus: No such file or directory", `agend start` refused, and the user manager's teardown could kill an
 * update mid-install. So, for every service command and for `agend install`:
 *   - linger is turned on (the manager then starts at boot and outlives every login);
 *   - XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS are filled in when a non-login shell (sudo, su, wsl -e) left them out;
 *   - a manager that is not running yet is waited for (linger starts it), briefly.
 * Every `systemctl --user` this process (and its children) runs then finds it. Never an error: a host where none of
 * this applies keeps today's behaviour, and the systemctl call says what is wrong.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";

export interface UserSystemdDeps {
  uid: number;
  user: string;
  env: NodeJS.ProcessEnv;
  exists(path: string): boolean;
  run(command: string, args: string[]): { status: number | null };
  sleep(ms: number): void;
}

const defaultDeps = (): UserSystemdDeps => ({
  uid: typeof process.getuid === "function" ? process.getuid() : -1,
  user: (() => { try { return userInfo().username; } catch { return ""; } })(),
  env: process.env,
  exists: existsSync,
  run: (command, args) => { const r = spawnSync(command, args, { stdio: "ignore", timeout: 15_000 }); return { status: r.status }; },
  sleep: ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
});

export interface UserSystemdResult { lingerEnabled: boolean; managerUp: boolean; envFilled: string[] }

const done = new Map<boolean, UserSystemdResult>();

/**
 * Make the user's systemd manager reachable (see the header). `linger`: only for commands that change state (install,
 * start, restart) — a query (status, stop) only fills in the environment and never changes the host (#2264 review).
 * Idempotent per process and per kind unless `deps` are given.
 */
export function ensureUserSystemd(deps?: UserSystemdDeps, opts: { waitMs?: number; linger?: boolean } = {}): UserSystemdResult {
  const linger = opts.linger ?? false;
  if (!deps && done.has(linger)) return done.get(linger)!;
  const remember = (r: UserSystemdResult) => { if (!deps) done.set(linger, r); return r; };
  const d = deps ?? defaultDeps();
  const result: UserSystemdResult = { lingerEnabled: false, managerUp: false, envFilled: [] };
  if (process.platform !== "linux" && !deps) return remember(result);
  // A test run never touches the host's systemd or linger (fleet decision: tests stub what reaches the live host).
  if (!deps && process.env.VITEST) return remember(result);
  if (d.uid < 0 || !d.user) return remember(result);
  const runtime = d.env.XDG_RUNTIME_DIR || `/run/user/${d.uid}`;
  if (!d.env.XDG_RUNTIME_DIR) { d.env.XDG_RUNTIME_DIR = runtime; result.envFilled.push("XDG_RUNTIME_DIR"); }
  // Linger: the manager starts at boot and no logout ends it (or an update running inside it).
  if (d.exists(`/var/lib/systemd/linger/${d.user}`)) result.lingerEnabled = true;
  else if (linger) result.lingerEnabled = d.run("loginctl", ["enable-linger", d.user]).status === 0;
  const privateSocket = `${runtime}/systemd/private`;
  const deadline = opts.waitMs ?? 10_000;
  for (let waited = 0; linger && !d.exists(privateSocket) && waited < deadline; waited += 250) {
    if (waited === 0 && d.uid === 0) d.run("systemctl", ["start", `user@${d.uid}.service`]);
    d.sleep(250);
  }
  result.managerUp = d.exists(privateSocket);
  if (!d.env.DBUS_SESSION_BUS_ADDRESS && d.exists(`${runtime}/bus`)) {
    d.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtime}/bus`;
    result.envFilled.push("DBUS_SESSION_BUS_ADDRESS");
  }
  return remember(result);
}
