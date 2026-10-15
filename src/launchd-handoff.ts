/**
 * #1871: on launchd, an activation takes two steps from the client: `launchctl bootout`, then `bootstrap`. The bootout
 * stops the fleet, and the fleet's stop kills every agent's CLI. So a command run in an agent's pane dies between the
 * two steps: the job stays unloaded (the fleet is down), its plan stays pending, and nobody is left to say so.
 *
 * Run from an agent session, such a command hands itself to a detached copy instead. The copy runs in its own session,
 * as chat /update does, so it outlives the stop. Its output goes to a log in the AgEnD home.
 */
import { join } from "node:path";
import { ORIGIN_ENV } from "./fleet-control-audit.js";

/** Set on the detached copy: it does the work itself (never hands off again). */
export const HANDED_OFF_ENV = "AGEND_LAUNCHD_HANDOFF";
export const HANDOFF_LOG = "service-activation.log";

/** A fleet agent's session (AGEND_INSTANCE_NAME, inherited by everything it runs), and not already the copy. */
export function shouldHandOff(env: NodeJS.ProcessEnv): boolean {
  return !!(env.AGEND_INSTANCE_NAME ?? "").trim() && env[HANDED_OFF_ENV] !== "1";
}

export interface HandOffDeps {
  open(path: string): number;
  write(fd: number, text: string): void;
  close(fd: number): void;
  spawn(command: string, args: string[], options: { detached: true; stdio: ["ignore", number, number]; env: NodeJS.ProcessEnv }): { unref(): void };
  now(): Date;
}

/**
 * Start the detached copy of `self` (this CLI, these arguments). This command was already allowed through the gate, so
 * the copy carries an origin of its own: the confirmation an agent gave (or the updater's origin) does not have to be
 * given twice.
 */
export function handOff(
  o: { agendHome: string; self: { command: string; args: string[] }; env: NodeJS.ProcessEnv; action: string },
  deps: HandOffDeps,
): { ok: true; log: string } | { ok: false; reason: string } {
  const log = join(o.agendHome, HANDOFF_LOG);
  let fd: number;
  try { fd = deps.open(log); } catch (err) { return { ok: false, reason: `cannot open ${log}: ${(err as Error).message}` }; }
  try {
    deps.write(fd, `\n[${deps.now().toISOString()}] agend ${o.action}, handed off from ${o.env.AGEND_INSTANCE_NAME}'s session (#1871)\n`);
    const env = { ...o.env, [HANDED_OFF_ENV]: "1", [ORIGIN_ENV]: `launchd hand-off of agend ${o.action} from ${o.env.AGEND_INSTANCE_NAME}` };
    deps.spawn(o.self.command, o.self.args, { detached: true, stdio: ["ignore", fd, fd], env }).unref();
    return { ok: true, log };
  } catch (err) {
    return { ok: false, reason: `the detached copy did not start: ${(err as Error).message}` };
  } finally {
    try { deps.close(fd); } catch { /* the child holds its own copy */ }
  }
}
