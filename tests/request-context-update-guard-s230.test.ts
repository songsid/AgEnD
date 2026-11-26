import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireRequestContextActivationLease, requestContextUpdateSettled } from "../src/request-context-update-guard.js";
import { acquireHomeUpdateLock, homeUpdateLockPath } from "../src/home-update-lock.js";
import { takeExclusiveLease } from "../src/state-lease.js";
import { advance, finish, openAttempt, defaultJournalIo, canAdvance, type Stage } from "../src/update-journal.js";
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
function rig() {
  const home = mkdtempSync(join(tmpdir(), "cutover-update-")); homes.push(home);
  let sequence = 0, owned = true;
  const deps = { pid: process.pid, processStart: () => "Thu Nov 26 01:00:00 2026", exists: () => true,
    newToken: () => (++sequence).toString(16).padStart(32, "0"), now: () => new Date("2026-11-26T01:00:00Z"), log: () => {} };
  const lease = () => acquireRequestContextActivationLease(home, "/fixture/install", deps, { current: () => owned });
  const opened = () => {
    const r = openAttempt(home, { id: "20261126T010203Z-0a1b2c3d", kind: "update", updater: { pid: 4242, start: { processStart: deps.processStart() } },
      from: { name: "@songsid/agend", version: "2.4.0", integrity: "sha512-old" }, to: { name: "@songsid/agend", version: "2.4.1", integrity: "sha512-new" } });
    if (!r.ok) throw Error(r.reason); return r.attempt;
  };
  return { home, deps, lease, opened, revoke: () => { owned = false; } };
}
it("an absent journal does not admit a live legacy updater, including the same install's healthy trial start", () => {
  const r = rig(), update = acquireHomeUpdateLock(r.home, { spec: "update", installPrefix: "/fixture/install" }, r.deps);
  expect(update.ok).toBe(true); expect(requestContextUpdateSettled(r.home)).toBe(true);
  expect(r.lease()).toBeNull(); if (update.ok) update.release();
  const lease = r.lease(); expect(lease?.current()).toBe(true); lease?.release();
});
it("activation holds updater exclusion and the shared drain lease until its own commit", () => {
  const r = rig(), lease = r.lease()!; expect(lease.current()).toBe(true);
  expect(acquireHomeUpdateLock(r.home, { spec: "update", installPrefix: "/other" }, r.deps).ok).toBe(false);
  expect(takeExclusiveLease(r.home, 0).ok).toBe(false);
  lease.release(); expect(lease.current()).toBe(false);
  const next = takeExclusiveLease(r.home, 0); expect(next.ok).toBe(true); if (next.ok) next.lease.release();
});
it("an open or recoverable update refuses activation even after its process lock is gone", () => {
  const r = rig(); r.opened(); expect(requestContextUpdateSettled(r.home)).toBe(false); expect(r.lease()).toBeNull();
});
it("a committed terminal record survives cleanup interruption; abandoned closing is never mistaken for committed", () => {
  const r = rig(); const a = advance(r.home, r.opened(), "abandoning");
  expect(() => finish(r.home, a, { kind: "abandoned", reason: "fixture" }, { ...defaultJournalIo, step: n => { if (n === "terminal-abandoned") throw Error("crash"); } })).toThrow();
  expect(requestContextUpdateSettled(r.home)).toBe(false); expect(r.lease()).toBeNull();
});
it("owner loss or lock replacement invalidates the final COMMIT proof without repairing the file", () => {
  const r = rig(), lease = r.lease()!;
  r.revoke(); expect(lease.current()).toBe(false); lease.release();
  const other = rig(), held = other.lease()!, path = homeUpdateLockPath(other.home);
  const replacement = readFileSync(path, "utf8").replace('request-context activation', 'replacement');
  writeFileSync(path, replacement); expect(held.current()).toBe(false); held.release();
  expect(readFileSync(path, "utf8")).toBe(replacement);
});

it("healthy trial and committing are still blocked; only the terminal committed attempt closes rollback", () => {
  const r = rig(); let a = r.opened();
  for (const stage of ["barrier", "stopping", "snapshotted", "installing", "trial", "proving", "committing"] as Stage[]) {
    a = advance(r.home, a, stage); expect(r.lease()).toBeNull();
  }
  expect(() => finish(r.home, a, { kind: "committed" }, { ...defaultJournalIo, step: n => { if (n === "terminal-committed") throw Error("crash"); } })).toThrow();
  expect(requestContextUpdateSettled(r.home)).toBe(true);
  const held = r.lease(); expect(held?.current()).toBe(true); held?.release();
  expect(canAdvance("committed", "rolling-back")).toBe(false);
});
