// M-3770 (Fable #4536 nit): createUpdateFence leaves no partial fleet.lock when its write or fsync fails after the
// O_EXCL create — otherwise every later pass would refuse with "appeared meanwhile".
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fail = vi.hoisted(() => ({ fsync: false }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: (fd: number) => { if (fail.fsync) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); return fs.fsyncSync(fd); } };
});
const { createUpdateFence, readFleetLockRecord } = await import("../src/fleet-lock.js");

const dirs: string[] = [];
afterEach(() => { fail.fsync = false; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ID = "20261126T150000Z-feedf00d";

describe("M-3770: createUpdateFence", () => {
  it("a failed fsync after the create removes the partial lock, and the next pass takes the fence", () => {
    const home = mkdtempSync(join(tmpdir(), "fence-")); dirs.push(home);
    fail.fsync = true;
    const first = createUpdateFence(home, { pid: 4242, attemptId: ID });
    expect(first).toMatchObject({ ok: false, reason: expect.stringMatching(/can't be written \(EIO/) });
    expect(existsSync(join(home, "fleet.lock"))).toBe(false);
    fail.fsync = false;
    const second = createUpdateFence(home, { pid: 4242, attemptId: ID });
    expect(second.ok).toBe(true);
    expect(readFleetLockRecord(home)).toMatchObject({ pid: 4242, role: "update", attemptId: ID, handoff: null });
  });

  it("an existing lock is never removed: refused as appeared meanwhile, left as it was", () => {
    const home = mkdtempSync(join(tmpdir(), "fence-")); dirs.push(home);
    expect(createUpdateFence(home, { pid: 1111, attemptId: ID }).ok).toBe(true);
    expect(createUpdateFence(home, { pid: 2222, attemptId: ID })).toEqual({ ok: false, reason: "fleet.lock appeared meanwhile" });
    expect(readFleetLockRecord(home)?.pid).toBe(1111);
  });
});
