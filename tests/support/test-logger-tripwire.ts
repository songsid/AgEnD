/**
 * #2725: the tripwire tests/setup-test-logger.ts installs in every test worker (kept apart from the setup's vi.mock so
 * a test can read it without registering that mock itself). A pino transport whose file would land outside this run's
 * own `<test home>/daemon.log` (AGEND_TEST_GUARD_DIR, which outlives every test) throws when it is built: its worker would otherwise
 * write there after the test ended, while the test removes the directory (late daemon.log, ENOTEMPTY).
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import pino from "pino";

const TRIPWIRE = Symbol.for("agend.test.transportTripwire");
type Transport = typeof pino.transport & { [TRIPWIRE]?: true };
/** The path with symlinks resolved through its nearest existing ancestor (the log file itself is not there yet). */
function canonical(p: string): string {
  const full = resolve(p);
  try { return realpathSync(full); } catch { /* not there yet */ }
  const parent = dirname(full);
  return parent === full ? full : join(canonical(parent), basename(full));
}

/**
 * The files a transport's targets would write other than the run's own `<test home>/daemon.log` — the one log file that
 * outlives every test. Anywhere else may be removed by a test while the worker still writes: a scratch home, even one
 * made inside the run's home (#2727 review r3), so containment proves nothing; only that exact file is allowed.
 */
export function strayTransportFiles(options: unknown, home: string | undefined = process.env.AGEND_TEST_GUARD_DIR): string[] {
  const targets = (options as { targets?: Array<{ options?: { destination?: unknown } }> } | undefined)?.targets
    ?? [options as { options?: { destination?: unknown } }];
  const files = targets.map(t => t?.options?.destination).filter((d): d is string => typeof d === "string");
  if (!home) return files;
  const allowed = join(canonical(home), "daemon.log");
  return files.filter(file => canonical(file) !== allowed);
}

/** Node caches pino once per worker, shared by every test file it runs: its transport is wrapped once. */
export function installTransportTripwire(): void {
  if ((pino.transport as Transport)[TRIPWIRE]) return;
  const build = pino.transport;
  const guarded = ((options: Parameters<typeof build>[0]) => {
    const stray = strayTransportFiles(options);
    if (stray.length) {
      throw new Error(`#2725: a test built a real logger transport writing ${stray.join(", ")} — not this run's own <test home>/daemon.log, so its `
        + "worker would write there after the test ended (late daemon.log, ENOTEMPTY). Keep the shared sink logger, or leave AGEND_HOME alone.");
    }
    return build(options);
  }) as Transport;
  guarded[TRIPWIRE] = true;
  pino.transport = guarded;
}
