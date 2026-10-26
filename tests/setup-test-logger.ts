/**
 * #2725: no test's logger writes a file. The fleet's createLogger feeds a pino transport whose worker thread opens
 * `<AGEND_HOME>/daemon.log` 100–300 ms after the first line, from wherever AGEND_HOME pointed when logger.ts loaded.
 * A test that stubs AGEND_HOME to a scratch directory and then builds a FleetManager or a Daemon gets that file
 * created after it ended, while its afterEach removes the directory: rmSync then fails ENOTEMPTY (#1599, #1778, #2722).
 *
 * So for every test file createLogger is a real pino logger (its own object, its level, child(), spies — all as
 * before) writing to a sink: no transport, no worker, no file. Everything else in logger.ts is the real module.
 * A file that tests the logger's own transport opts back in with `vi.unmock("../src/logger.js")`; such a file must
 * never point AGEND_HOME at a directory it removes, and tests/test-logger-guard-2725.test.ts holds every opt-in to that.
 * What a child process logs (`spawnSync(node …)`) is that process's own logger: untouched.
 */
import { vi } from "vitest";

vi.mock("../src/logger.js", async original => {
  const real = await original<typeof import("../src/logger.js")>();
  const pino = (await import("pino")).default;
  const sink = { write() {} };
  return { ...real, createLogger: (level: string = "info") => pino({ level }, sink) as ReturnType<typeof real.createLogger> };
});
