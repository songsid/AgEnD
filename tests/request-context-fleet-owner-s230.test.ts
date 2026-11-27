import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireFleetLock, captureProcessFleetLease, releaseProcessFleetLock, setProcessFleetLock } from "../src/fleet-lock.js";

const homes: string[] = [];
afterEach(() => { releaseProcessFleetLock(); for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });
function home() { const dir = mkdtempSync(join(tmpdir(), "cutover-owner-")); homes.push(dir); return dir; }
it("only the current process's actually held Fleet lock provides an installation lease", () => {
  const dir = home(); expect(captureProcessFleetLease(dir)).toBeNull();
  const handle = acquireFleetLock(dir); setProcessFleetLock(handle);
  const lease = captureProcessFleetLease(dir)!;
  expect(lease.id).toMatch(/^[a-f0-9]{64}$/); expect(lease.current()).toBe(true);
  expect(captureProcessFleetLease(home())).toBeNull();
  releaseProcessFleetLock(); expect(lease.current()).toBe(false);
  setProcessFleetLock(acquireFleetLock(dir));
  expect(captureProcessFleetLease(dir)?.id).not.toBe(lease.id); expect(lease.current()).toBe(false);
});
it("a lock replacement invalidates both the captured proof and a fresh capture without takeover or repair", () => {
  const dir = home(); setProcessFleetLock(acquireFleetLock(dir));
  const lease = captureProcessFleetLease(dir)!;
  const replacement = JSON.stringify({ pid: process.pid, nonce: "fixture-replacement", createdAt: new Date().toISOString(), role: "fleet" }) + "\n";
  writeFileSync(join(dir, "fleet.lock"), replacement);
  expect(lease.current()).toBe(false); expect(captureProcessFleetLease(dir)).toBeNull();
  expect(releaseProcessFleetLock()).toBe(false);
});
it.each(["setup-host", "update", "other-pid"] as const)("a %s lock never supplies a Fleet cutover lease", role => {
  const dir = home();
  const handle = acquireFleetLock(dir, role === "update" ? { role, attemptId: "20260101T000000Z-12345678" }
    : role === "other-pid" ? { pid: process.pid + 100000 } : { role });
  setProcessFleetLock(handle); expect(captureProcessFleetLease(dir)).toBeNull();
});
