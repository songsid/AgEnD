import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * `createLogger` builds a pino `transport`, and a transport spawns a worker
 * thread per target and registers a `process.on("exit")` handler. FleetManager
 * creates its logger in a field initializer, so every `new FleetManager()` used
 * to pay for both — and a test process that built more than ten of them made
 * Node report an exit-listener leak it was right about.
 *
 * The warning was the visible part. The cost was the worker threads.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "agend-logger-"));
  dirs.push(dir);
  return dir;
}

describe("createLogger", () => {
  it("still gives every caller its own logger", () => {
    // Sharing the logger itself would be the tempting fix and the wrong one:
    // tests spy on one fleet's `logger.debug`, and a shared object makes one
    // test see another's calls. Only the transport underneath is shared.
    expect(createLogger("info")).not.toBe(createLogger("info"));
  });

  it("keeps a spy on one logger away from another", () => {
    const a = createLogger("info");
    const b = createLogger("info");
    const spy = vi.spyOn(a, "debug");

    b.debug({ probe: true }, "not for a");

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("honours the level it was asked for", () => {
    expect(createLogger("silent").level).toBe("silent");
    expect(createLogger("info").level).toBe("info");
  });

  it("still logs", () => {
    const logger = createLogger("info");
    expect(() => logger.info({ probe: true }, "logger transport sharing test")).not.toThrow();
  });
});

describe("building many FleetManagers", () => {
  it("adds no exit listeners, however many are constructed", () => {
    // The assertion the bug report was really about. Before memoisation this
    // grew by one per FleetManager and tripped Node's limit at ten.
    const before = process.listenerCount("exit");

    const fleets = Array.from({ length: 12 }, () => new FleetManager(workspace()));

    expect(process.listenerCount("exit") - before,
      "each FleetManager used to bring its own pino transport, and its own exit listener").toBe(0);
    expect(fleets).toHaveLength(12);
  });

  it("still gives each FleetManager its own logger object", () => {
    // What the exit listeners cost was the transport, not the logger. Keeping
    // the objects distinct is what lets each fleet's log be spied on alone.
    const a = new FleetManager(workspace());
    const b = new FleetManager(workspace());

    expect(a.logger).not.toBe(b.logger);
  });
});
