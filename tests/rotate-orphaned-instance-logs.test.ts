import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * `output.log` is fed by tmux pipe-pane: raw TUI output, which a wedged splash
 * screen emits at animation rate. A running instance rotates its own log on each
 * health tick, so what matters is everything that has no health tick.
 *
 * The old sweep walked `fleetConfig.instances`, which excluded exactly those:
 * deleted instances (directory outlives the config entry), classic instances
 * (they live in classicChannels), and stopped ones. On the machine this was found
 * on that left 122 MB in one orphan and 74 MB in another, out of 622 MB total.
 */

const OVER_LIMIT = 11 * 1024 * 1024; // MAX_LOG_SIZE is 10 MB

function makeFleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-logsweep-"));
  const fm = new FleetManager(dir);
  return {
    dir,
    fm,
    sweep: () => (fm as unknown as { rotateAllInstanceLogs(): void }).rotateAllInstanceLogs(),
    writeLog: (instance: string, bytes: number) => {
      const instanceDir = join(dir, "instances", instance);
      mkdirSync(instanceDir, { recursive: true });
      const path = join(instanceDir, "output.log");
      writeFileSync(path, Buffer.alloc(bytes, 0x41));
      return path;
    },
  };
}

describe("instance log sweep", () => {
  it("rotates a directory that is no longer in the config", () => {
    const { dir, fm, sweep, writeLog } = makeFleet();
    try {
      // The config knows about one instance; the orphan's directory is all that
      // is left of a deleted one.
      fm.fleetConfig = { defaults: {}, instances: { alive: { working_directory: "/tmp" } } } as never;
      const orphan = writeLog("deleted-instance-t1050", OVER_LIMIT);
      expect(statSync(orphan).size).toBe(OVER_LIMIT);

      sweep();

      expect(statSync(orphan).size).toBe(0);
      expect(existsSync(`${orphan}.1`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rotates a classic instance, which was never in fleetConfig.instances", () => {
    const { dir, fm, sweep, writeLog } = makeFleet();
    try {
      fm.fleetConfig = { defaults: {}, instances: {} } as never;
      const classic = writeLog("classic-hanhanv-4522", OVER_LIMIT);

      sweep();

      expect(statSync(classic).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a log that is still under the limit alone", () => {
    const { dir, sweep, writeLog } = makeFleet();
    try {
      const small = writeLog("alive", 1024);
      sweep();
      // Rotation is size-triggered; sweeping must not churn every log daily.
      expect(statSync(small).size).toBe(1024);
      expect(existsSync(`${small}.1`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives a directory with no log, and a missing instances root", () => {
    const { dir, sweep } = makeFleet();
    try {
      mkdirSync(join(dir, "instances", "no-log-here"), { recursive: true });
      expect(() => sweep()).not.toThrow();

      rmSync(join(dir, "instances"), { recursive: true, force: true });
      expect(() => sweep()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
