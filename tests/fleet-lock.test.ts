import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFleetLock, releaseFleetLock } from "../src/fleet-lock.js";

function tempHome(): string {
  const dir = join(tmpdir(), `agend-fleet-lock-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("fleet singleton lock", () => {
  it("refuses a second fleet while the recorded fleet owner is alive", () => {
    const dir = tempHome();
    try {
      const first = acquireFleetLock(dir, { pid: 41001, nonce: "first" });
      expect(() => acquireFleetLock(dir, {
        pid: 41002,
        nonce: "second",
        isProcessAlive: pid => pid === 41001,
        readCommandLine: () => "/usr/bin/node /opt/agend/dist/cli.js fleet start",
      })).toThrow(/already running \(PID 41001/);
      expect(readFileSync(join(dir, "fleet.lock"), "utf8")).toBe(first.serialized);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces a stale dead-owner lock atomically", () => {
    const dir = tempHome();
    try {
      writeFileSync(join(dir, "fleet.lock"), JSON.stringify({
        pid: 42001,
        nonce: "stale",
        createdAt: "2026-01-01T00:00:00.000Z",
      }) + "\n");
      const next = acquireFleetLock(dir, {
        pid: 42002,
        nonce: "next",
        isProcessAlive: () => false,
      });
      expect(readFileSync(join(dir, "fleet.lock"), "utf8")).toBe(next.serialized);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("only lets the exact owner remove the lock", () => {
    const dir = tempHome();
    try {
      const owner = acquireFleetLock(dir, { pid: 43001, nonce: "owner" });
      const impostor = { ...owner, serialized: owner.serialized.replace("owner", "impostor") };
      expect(releaseFleetLock(impostor)).toBe(false);
      expect(readFileSync(join(dir, "fleet.lock"), "utf8")).toBe(owner.serialized);
      expect(releaseFleetLock(owner)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
