// M-3770 slice 2.1b (design update-transaction §3.3, §3.4, §4.2, §4.3): fleet.lock's update role and its claimed
// handoff; the journal's planned generations and single-use claim; the service lock and its token; the CLI's state
// lease, between connections and between processes; and the static gate on the CLI's state writers.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFleetLock, fleetLockHeldByAnother, readFleetLockRecord, setFleetLockHandoff } from "../src/fleet-lock.js";
import { ackGeneration, advance, claimHandoff, newAttemptId, openAttempt, planGeneration, readCurrent, voidGeneration, type AttemptRecord } from "../src/update-journal.js";
import { acquireServiceLock, admitServiceCommand, SERVICE_LOCK_TOKEN_ENV } from "../src/service-lock.js";
import { takeExclusiveLease, takeSharedLease } from "../src/state-lease.js";
import type { InstallLockDeps } from "../src/install-lock.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = () => { const h = mkdtempSync(join(tmpdir(), "locks-")); homes.push(h); return h; };
const ID = newAttemptId(new Date("2026-11-26T03:00:00Z"), "0a0b0c0d");
const NONCE = "a".repeat(32), OTHER = "b".repeat(32);
const START = { processStart: "Thu Nov 26 03:00:00 2026" };
const open = (h: string): AttemptRecord => {
  const r = openAttempt(h, { id: ID, kind: "update", updater: { pid: 4242, start: START }, from: { name: "@songsid/agend", version: "2.4.0", integrity: null }, to: { name: "@songsid/agend", version: "2.4.1", integrity: null } });
  if (!r.ok) throw new Error(r.reason);
  return r.attempt;
};

describe("M-3770 2.1b: fleet.lock's update role (§4.3)", () => {
  const live = { isProcessAlive: () => true, readCommandLine: () => "node agend update" };

  it("a fence needs its attempt id; while the updater lives, every start is refused — it is never 'stale' for not being a fleet", () => {
    const h = home();
    expect(() => acquireFleetLock(h, { pid: 100, role: "update" })).toThrow(/attempt id/);
    acquireFleetLock(h, { pid: 100, role: "update", attemptId: ID });
    expect(() => acquireFleetLock(h, { pid: 200, handoffNonce: null, ...live })).toThrow(/AgEnD is updating/);
    expect(fleetLockHeldByAnother(h, { pid: 200, ...live })).toBe(true);
    expect(() => acquireFleetLock(h, { pid: 200, handoffNonce: null, isProcessAlive: () => false })).toThrow(/stopped updater/);   // recovery owns it
  });

  it("the planned nonce plus the claim takes it over atomically; a wrong nonce or a lost claim refuses", () => {
    const h = home();
    const fence = acquireFleetLock(h, { pid: 100, role: "update", attemptId: ID });
    const planned = setFleetLockHandoff(fence, { nonce: NONCE, gen: "trial" });
    expect(planned?.record.handoff).toEqual({ nonce: NONCE, gen: "trial" });
    expect(() => acquireFleetLock(h, { pid: 200, handoffNonce: OTHER, claimHandoff: () => true, ...live })).toThrow(/AgEnD is updating/);
    expect(() => acquireFleetLock(h, { pid: 201, handoffNonce: NONCE, claimHandoff: () => false, ...live })).toThrow(/claimed/);
    const taken = acquireFleetLock(h, { pid: 202, handoffNonce: NONCE, claimHandoff: () => true, ...live });
    expect(taken.record).toMatchObject({ pid: 202, role: "fleet", nonce: NONCE });
    expect(readFleetLockRecord(h)).toMatchObject({ pid: 202, role: "fleet", nonce: NONCE });
    expect(setFleetLockHandoff(planned!, null)).toBeNull();                                          // the fence is no longer the updater's
  });
});

describe("M-3770 2.1b: planned generations and the single-use claim (§3.3, §4.3)", () => {
  it("only a planned, unconsumed nonce can be claimed, by exactly one claimant", () => {
    const h = home();
    let a = advance(h, open(h), "barrier");
    expect(claimHandoff(h, ID, NONCE, { pid: 300, start: START })).toBe(false);                     // not planned yet
    a = planGeneration(h, a, "trial", NONCE);
    expect(() => planGeneration(h, a, "rollback", NONCE)).toThrow(/never reused/);
    expect(claimHandoff(h, ID, NONCE, { pid: 300, start: START })).toBe(true);
    expect(claimHandoff(h, ID, NONCE, { pid: 300, start: START })).toBe(true);                      // the same claimant's retry
    expect(claimHandoff(h, ID, NONCE, { pid: 301, start: START })).toBe(false);                     // a second contender
    a = ackGeneration(h, a, NONCE, 300);
    expect((readCurrent(h) as { attempt: AttemptRecord }).attempt.fleets).toEqual([expect.objectContaining({ gen: "trial", nonce: NONCE, pid: 300, consumed: true })]);
    a = planGeneration(h, a, "rollback", OTHER);
    a = voidGeneration(h, a, OTHER);
    expect(claimHandoff(h, ID, OTHER, { pid: 302, start: START })).toBe(false);                     // voided: never reused
  });
});

describe("M-3770 2.1b: the service lock (§3.4)", () => {
  const deps = (pid: number, live: number[]): InstallLockDeps => {
    let n = 0;
    return { pid, processStart: p => (live.includes(p) || p === pid ? "Thu Nov 26 03:00:00 2026" : null), exists: p => live.includes(p) || p === pid,
      newToken: () => (++n).toString(16).padStart(32, "0"), now: () => new Date(), log: () => {} };
  };

  it("a command takes it briefly when free; while a live update holds it, commands are refused at once, naming the attempt and its stage", () => {
    const h = home();
    const free = admitServiceCommand(h, "restart", deps(500, [500]), {});
    expect(free).toMatchObject({ ok: true, viaToken: false });
    if (free.ok) free.release();
    advance(h, open(h), "barrier");
    const held = acquireServiceLock(h, ID, deps(100, [100]));
    expect(held.ok).toBe(true);
    const refused = admitServiceCommand(h, "start", deps(501, [100, 501]), {});
    expect(refused).toEqual({ ok: false, reason: `\`agend start\` is refused: AgEnD is updating (attempt ${ID}, barrier). The update owns the service until it ends.` });
  });

  it("the updater's own child is admitted by the lock record's token, and only while that holder lives", () => {
    const h = home();
    const held = acquireServiceLock(h, ID, deps(100, [100]));
    if (!held.ok) throw new Error(held.reason);
    expect(admitServiceCommand(h, "restart", deps(600, [100, 600]), { [SERVICE_LOCK_TOKEN_ENV]: held.token })).toMatchObject({ ok: true, viaToken: true });
    expect(admitServiceCommand(h, "restart", deps(600, [100, 600]), { [SERVICE_LOCK_TOKEN_ENV]: "f".repeat(32) }).ok).toBe(false);
    // The holder gone: its token admits nothing; the stale lock is reclaimed by a normal command.
    const after = admitServiceCommand(h, "restart", deps(601, [601]), { [SERVICE_LOCK_TOKEN_ENV]: held.token });
    expect(after).toMatchObject({ ok: true, viaToken: false });
  });
});

describe("M-3770 2.1b: the state lease (§4.2 step 3)", () => {
  it("SHARED holders block the updater's EXCLUSIVE until they finish (the drain); EXCLUSIVE refuses new writers", () => {
    const h = home();
    const reader = takeSharedLease(h, "schedule");
    if (!reader.ok) throw new Error(reader.reason);
    expect(takeExclusiveLease(h, 150)).toMatchObject({ ok: false, reason: expect.stringMatching(/still runs/) });
    reader.lease.release();
    const ex = takeExclusiveLease(h, 1000);
    if (!ex.ok) throw new Error(ex.reason);
    expect(takeSharedLease(h, "topic", { busyMs: 100 })).toMatchObject({ ok: false, reason: expect.stringMatching(/AgEnD is updating/) });
    ex.lease.release();
    const again = takeSharedLease(h, "topic");
    expect(again.ok).toBe(true);
    if (again.ok) again.lease.release();
  });

  it("the journal is checked AFTER the lease: an open attempt refuses a writer even with the lease free", () => {
    const h = home();
    open(h);
    expect(takeSharedLease(h, "schedule")).toMatchObject({ ok: false, reason: `\`agend schedule\` is refused: AgEnD is updating (attempt ${ID} is opened).` });
  });

  it("between processes: another process's SHARED lock holds the drain; it ends when that process exits (the kernel drops it)", async () => {
    const h = home();
    const child = spawn(process.execPath, ["-e", `
      const D = require(${JSON.stringify(require.resolve("better-sqlite3"))});
      const db = new D(${JSON.stringify(join(h, ".state-lease.sqlite"))}); db.pragma("journal_mode = DELETE");
      db.exec("BEGIN DEFERRED"); db.prepare("SELECT count(*) FROM sqlite_master").get();
      process.stdout.write("held\\n"); setTimeout(() => process.exit(0), 1500);`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>(r => child.stdout!.once("data", () => r()));
    expect(takeExclusiveLease(h, 200).ok).toBe(false);
    await new Promise<void>(r => child.once("exit", () => r()));
    const ex = takeExclusiveLease(h, 2000);
    expect(ex.ok).toBe(true);
    if (ex.ok) ex.lease.release();
  });
});

describe("M-3770 2.1b: the CLI's state writers and service commands go through the locks (a static gate)", () => {
  const cli = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");
  it("scheduler.db is opened only by openCliSchedulerDb, which takes the lease; every fleet.yaml patch holds it first", () => {
    expect(cli.match(/new SchedulerDb\(/g)).toHaveLength(1);
    expect(cli).toMatch(/function openCliSchedulerDb\(\): SchedulerDb \{\n  holdStateLease\("schedule"\);\n  return new SchedulerDb\(/);
    const patches = [...cli.matchAll(/^( *)applyFleetYamlPatches\(FLEET_CONFIG_PATH,/gm)];
    expect(patches.length).toBeGreaterThan(0);
    for (const m of patches) expect(cli.slice(0, m.index).trimEnd().endsWith('holdStateLease("topic");')).toBe(true);
  });
  it("agend start, stop, restart (the whole service) and install take the service lock", () => {
    for (const command of ["start", "stop", "install"]) expect(cli).toContain(`guardServiceCommand("${command}")`);
    expect(cli).toContain('if (!instance && !guardServiceCommand("restart")) return;');
  });
});
