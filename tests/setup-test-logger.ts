/**
 * #2725: no test's logger writes a file into a directory the test removes. The fleet's createLogger feeds a pino
 * transport whose worker thread opens `<AGEND_HOME>/daemon.log` 100–300 ms after the first line, from wherever
 * AGEND_HOME pointed when logger.ts loaded. A test that stubs AGEND_HOME to a scratch directory and then builds a
 * FleetManager or a Daemon gets that file created after it ended, while its afterEach removes the directory: rmSync
 * then fails ENOTEMPTY (#1599, #1778, #2722).
 *
 *  - For every test file createLogger is a real pino logger (its own object, its level, child(), spies — all as
 *    before) writing to a sink: no transport, no worker, no file. Everything else in logger.ts is the real module.
 *  - A file that needs the real transport (it tests the transport itself) gets it back by any means it likes —
 *    `vi.unmock("../src/logger.js")`, its own mock, importActual — and the tripwire (tests/support/test-logger-tripwire.ts) still holds it: a pino
 *    transport writing any file but this run's own `<test home>/daemon.log` (AGEND_TEST_GUARD_DIR outlives every
 *    test; a directory made inside it may not) throws when it is built, so no late writer can ever reach a scratch directory, whatever the mock looks like.
 *
 * What a child process logs (`spawnSync(node …)`) is that process's own logger: untouched.
 */
import pino from "pino";
import { vi } from "vitest";
import { installTransportTripwire } from "./support/test-logger-tripwire.js";

vi.mock("../src/logger.js", async original => {
  const real = await original<typeof import("../src/logger.js")>();
  const sink = { write() {} };
  return { ...real, createLogger: (level: string = "info") => pino({ level }, sink) as ReturnType<typeof real.createLogger> };
});

installTransportTripwire();
