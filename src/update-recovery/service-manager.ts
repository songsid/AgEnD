/**
 * M-3770 slice 2.5 (design update-transaction §6.2): the recovery runner's hands on the service manager — what
 * `rollBack` needs (`mainPid`, `stop`, `reload`, `start`) plus §6.2 step 1's wait for the refused start to settle.
 * Every command goes through an injected runner, so the sequences are tested without systemd or launchd. Built into
 * recover.cjs: node built-ins only.
 *
 * - **systemd** (`--user` unless root): `show -p MainPID --value`, `stop` then polling `is-active` until it is
 *   inactive or failed, `daemon-reload`, `reset-failed` + `start --no-block`.
 * - **launchd** (`gui/<uid>/<label>`): `print` for the pid, `bootout` (KeepAlive would restart a killed job) then
 *   polling `print` until the job is gone, reload as a no-op (a `bootstrap` reads the plist from disk), `bootstrap`
 *   (when not loaded) + `kickstart`.
 */
import type { OwnedService } from "../install-ownership.js";

export interface Run { (command: string, args: string[]): { status: number | null; stdout: string } }
export interface ManagerDeps { run: Run; uid: number; sleep(ms: number): void; now(): number }

export interface ServiceManager {
  mainPid(): number | null;
  stop(): boolean;
  reload(): boolean;
  /** The handoff reaches the fleet through the route's pre-start step (§6.2), not through this call. */
  start(handoff?: { nonce: string; gen: string }): boolean;
  /** §6.2 step 1: wait until no start (or stop) job is in progress — the refused start has ended. */
  waitSettled(timeoutMs?: number): boolean;
}

const SETTLE_MS = 30_000, POLL_MS = 250;

export function serviceManager(service: OwnedService, d: ManagerDeps): ServiceManager {
  const poll = (ok: () => boolean, timeoutMs: number) => {
    const until = d.now() + timeoutMs;
    for (;;) { if (ok()) return true; if (d.now() >= until) return false; d.sleep(POLL_MS); }
  };
  if (service.kind === "systemd") {
    const sc = (...args: string[]) => d.run("systemctl", [...(d.uid !== 0 ? ["--user"] : []), ...args]);
    const state = () => sc("is-active", service.unit).stdout.trim();
    return {
      mainPid: () => { const r = sc("show", "-p", "MainPID", "--value", service.unit); const pid = Number(r.stdout.trim()); return r.status === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : null; },
      stop: () => sc("stop", service.unit).status === 0 && poll(() => ["inactive", "failed"].includes(state()), SETTLE_MS),
      reload: () => sc("daemon-reload").status === 0,
      start: () => { sc("reset-failed", service.unit); return sc("start", "--no-block", service.unit).status === 0; },
      waitSettled: (timeoutMs = SETTLE_MS) => poll(() => !["activating", "deactivating", "reloading"].includes(state()), timeoutMs),
    };
  }
  const target = `gui/${d.uid}/${service.unit}`;
  const printed = () => d.run("launchctl", ["print", target]);
  const pidOf = (text: string) => { const m = /^\s*pid = (\d+)\s*$/m.exec(text); return m ? Number(m[1]) : null; };
  return {
    mainPid: () => { const r = printed(); return r.status === 0 ? pidOf(r.stdout) : null; },
    stop: () => {
      const r = d.run("launchctl", ["bootout", target]);
      if (r.status !== 0 && printed().status === 0) return false;        // still loaded: the bootout failed
      return poll(() => printed().status !== 0, SETTLE_MS);
    },
    reload: () => true,
    start: () => {
      if (printed().status !== 0 && d.run("launchctl", ["bootstrap", `gui/${d.uid}`, service.fragmentPath]).status !== 0) return false;
      return d.run("launchctl", ["kickstart", target]).status === 0;
    },
    waitSettled: (timeoutMs = SETTLE_MS) => poll(() => { const r = printed(); return r.status !== 0 || !/^\s*state = (spawn scheduled|xpcproxy)\s*$/m.test(r.stdout); }, timeoutMs),
  };
}
