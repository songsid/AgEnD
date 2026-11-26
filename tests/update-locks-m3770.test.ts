// M-3770 slice 2.1b (design update-transaction §3.3, §3.4, §4.2, §4.3): fleet.lock's update role and its claimed
// handoff; the journal's planned generations and single-use claim; the service lock and its token; the CLI's state
// lease, between connections and between processes; and the static gate on the CLI's state writers.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFleetLock, fleetLockHeldByAnother, readFleetLockRecord, releaseFleetLock, setFleetLockHandoff } from "../src/fleet-lock.js";
import { ackGeneration, advance, claimHandoff, defaultJournalIo, fleetStartGate, type JournalIo, finish, revokeHandoff, newAttemptId, openAttempt, planGeneration, readCurrent, updaterState, voidGeneration, type AttemptRecord } from "../src/update-journal.js";
import { acquireServiceLock, admitServiceCommand, SERVICE_LOCK_TOKEN_ENV } from "../src/service-lock.js";
import { takeExclusiveLease, takeSharedLease } from "../src/state-lease.js";
import type { InstallLockDeps } from "../src/install-lock.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = () => { const h = mkdtempSync(join(tmpdir(), "locks-")); homes.push(h); return h; };
const ID = newAttemptId(new Date("2026-11-26T03:00:00Z"), "0a0b0c0d");
const NONCE = "a".repeat(32), OTHER = "b".repeat(32);
const START = { processStart: "Thu Nov 26 03:00:00 2026" };
/** §2.7 probes where exactly `pids` are live (with START's start time); every other pid is proven gone. */
const LIVE = (pids: number[]) => ({ processStart: (p: number) => (pids.includes(p) ? START.processStart : null), exists: (p: number) => pids.includes(p) });
const UPDATER = 4242;
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
    expect(() => setFleetLockHandoff(planned!, null)).toThrow(/revoked/);                            // never replaced unrevoked
    expect(setFleetLockHandoff(planned!, null, () => true)).toBeNull();                              // the fence is no longer the updater's
  });

  it("replacing or releasing a planned handoff races the start through the SAME claim: exactly one wins", () => {
    const h = home();
    let a = advance(h, open(h), "barrier");
    a = planGeneration(h, a, "trial", NONCE);
    const updater = { pid: UPDATER, start: START };
    const revoke = (id: string, nonce: string) => revokeHandoff(h, id, nonce, updater, LIVE([UPDATER, 300])) === "revoked";
    const claim = (id: string, nonce: string, pid: number) => claimHandoff(h, id, nonce, { pid, start: START }, LIVE([UPDATER]));
    // The start wins the claim first: the updater's revoke loses, and it rewrites nothing.
    let fence = setFleetLockHandoff(acquireFleetLock(h, { pid: 100, role: "update", attemptId: ID }), { nonce: NONCE, gen: "trial" })!;
    expect(releaseFleetLock(fence)).toBe(false);                                                    // planned: never unlinked directly
    expect(claim(ID, NONCE, 300)).toBe(true);
    expect(setFleetLockHandoff(fence, null, revoke)).toBeNull();
    expect(readFleetLockRecord(h)).toMatchObject({ role: "update", handoff: { nonce: NONCE } });     // untouched: the start renames next
    expect(acquireFleetLock(h, { pid: 300, handoffNonce: NONCE, claimHandoff: claim, ...live })).toMatchObject({ record: { pid: 300, role: "fleet" } });
    // The updater revokes first: the start's claim loses, and the fence is the updater's to clear and release.
    a = planGeneration(h, a, "rollback", OTHER);
    rmSync(join(h, "fleet.lock"));
    fence = setFleetLockHandoff(acquireFleetLock(h, { pid: 100, role: "update", attemptId: ID }), { nonce: OTHER, gen: "rollback" })!;
    const cleared = setFleetLockHandoff(fence, null, revoke);
    expect(cleared?.record.handoff).toBeNull();
    expect(revoke(ID, OTHER)).toBe(true);                                                           // an exact retry
    expect(claim(ID, OTHER, 301)).toBe(false);
    expect(() => acquireFleetLock(h, { pid: 301, handoffNonce: OTHER, claimHandoff: claim, ...live })).toThrow(/AgEnD is updating/);
    expect(releaseFleetLock(cleared!)).toBe(true);
  });
});

describe("M-3770 2.1b: planned generations and the single-use claim (§3.3, §4.3)", () => {
  it("only a planned, unconsumed nonce can be claimed, by exactly one claimant", () => {
    const h = home();
    let a = advance(h, open(h), "barrier");
    expect(claimHandoff(h, ID, NONCE, { pid: 300, start: START }, LIVE([UPDATER]))).toBe(false);                     // not planned yet
    a = planGeneration(h, a, "trial", NONCE);
    expect(() => planGeneration(h, a, "rollback", NONCE)).toThrow(/never reused/);
    expect(claimHandoff(h, ID, NONCE, { pid: 300, start: START }, LIVE([UPDATER]))).toBe(true);
    expect(claimHandoff(h, ID, NONCE, { pid: 300, start: START }, LIVE([UPDATER]))).toBe(true);                      // the same claimant's retry
    expect(claimHandoff(h, ID, NONCE, { pid: 301, start: START }, LIVE([UPDATER]))).toBe(false);                     // a second contender
    a = ackGeneration(h, a, NONCE, 300);
    expect((readCurrent(h) as { attempt: AttemptRecord }).attempt.fleets).toEqual([expect.objectContaining({ gen: "trial", nonce: NONCE, pid: 300, consumed: true })]);
    a = planGeneration(h, a, "rollback", OTHER);
    a = voidGeneration(h, a, OTHER);
    expect(claimHandoff(h, ID, OTHER, { pid: 302, start: START }, LIVE([UPDATER]))).toBe(false);                     // voided: never reused
  });

  it("a claim needs the attempt's updater live: a gone or unknown updater's nonce hands nothing over (Prism #4499)", () => {
    const h = home();
    const a = planGeneration(h, advance(h, open(h), "barrier"), "trial", NONCE);
    expect(updaterState(a, LIVE([UPDATER]))).toBe("live");
    expect(claimHandoff(h, ID, NONCE, { pid: 300, start: START }, LIVE([]))).toBe(false);                     // gone
    expect(claimHandoff(h, ID, NONCE, { pid: 300, start: START }, { processStart: () => null, exists: () => true })).toBe(false);   // unknown
    expect(claimHandoff(h, ID, NONCE, { pid: 300, start: START }, LIVE([UPDATER]))).toBe(true);
  });

  it("a claimant that died before its takeover: the revoke reports it gone, so the updater voids and re-plans; a live or unknown one blocks", () => {
    const h = home();
    let a = planGeneration(h, advance(h, open(h), "barrier"), "trial", NONCE);
    expect(claimHandoff(h, ID, NONCE, { pid: 300, start: START }, LIVE([UPDATER]))).toBe(true);
    const updater = { pid: UPDATER, start: START };
    expect(revokeHandoff(h, ID, NONCE, updater, LIVE([UPDATER, 300]))).toBe("claimed-live");
    expect(revokeHandoff(h, ID, NONCE, updater, { processStart: () => null, exists: () => true })).toBe("claimant-unknown");
    expect(revokeHandoff(h, ID, NONCE, updater, LIVE([UPDATER]))).toBe("claimant-gone");
    // The updater's path on "claimant-gone": void the nonce, re-plan with a new one, rewrite its fence (the claimant can't rename).
    a = voidGeneration(h, a, NONCE);
    a = planGeneration(h, a, "trial", OTHER);
    let fence = setFleetLockHandoff(acquireFleetLock(h, { pid: UPDATER, role: "update", attemptId: ID }), { nonce: NONCE, gen: "trial" })!;
    const deadRevoke = (id: string, nonce: string) => { const r = revokeHandoff(h, id, nonce, updater, LIVE([UPDATER])); return r === "revoked" || r === "claimant-gone"; };
    fence = setFleetLockHandoff(fence, { nonce: OTHER, gen: "trial" }, deadRevoke)!;
    expect(readFleetLockRecord(h)).toMatchObject({ role: "update", handoff: { nonce: OTHER } });
    expect(claimHandoff(h, ID, NONCE, { pid: 301, start: START }, LIVE([UPDATER]))).toBe(false);              // the voided nonce: never
    expect(claimHandoff(h, ID, OTHER, { pid: 301, start: START }, LIVE([UPDATER]))).toBe(true);
  });
});

describe("M-3770 2.1b: a revoke that can't judge the claim rewrites nothing (Prism #4499 R2)", () => {
  it("a malformed claim, an unreadable one, or a probe that throws: claimant-unknown, never an exception", () => {
    const h = home();
    planGeneration(h, advance(h, open(h), "barrier"), "trial", NONCE);
    const updater = { pid: UPDATER, start: START };
    const claimPath = join(h, ".update-journal", "attempts", ID, `handoff-${NONCE}.claim`);
    writeFileSync(claimPath, "{not json");
    expect(revokeHandoff(h, ID, NONCE, updater, LIVE([UPDATER]))).toBe("claimant-unknown");
    writeFileSync(claimPath, JSON.stringify({ pid: 300 }) + "\n");                                       // no start
    expect(revokeHandoff(h, ID, NONCE, updater, LIVE([UPDATER]))).toBe("claimant-unknown");
    writeFileSync(claimPath, JSON.stringify({ pid: 300, start: START }) + "\n");
    const eacces: JournalIo = { ...defaultJournalIo, read: path => { if (path === claimPath) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return defaultJournalIo.read(path); } };
    expect(revokeHandoff(h, ID, NONCE, updater, LIVE([UPDATER]), eacces)).toBe("claimant-unknown");
    expect(revokeHandoff(h, ID, NONCE, updater, { processStart: () => { throw new Error("EIO"); }, exists: () => true })).toBe("claimant-unknown");
    expect(revokeHandoff(h, ID, NONCE, updater, LIVE([UPDATER]))).toBe("claimant-gone");              // the control: readable, 300 gone
  });
});

describe("M-3770 2.1b: every fleet start reads the journal first (§4.3, §7; Prism #4499)", () => {
  it("refuses while an attempt is open, unknown or manual — except the attempt's own planned start while its updater lives", () => {
    const h = home();
    expect(fleetStartGate(h, null, LIVE([]))).toEqual({ ok: true });                                         // no journal
    let a = planGeneration(h, advance(h, open(h), "barrier"), "trial", NONCE);
    expect(fleetStartGate(h, null, LIVE([UPDATER]))).toMatchObject({ ok: false, reason: expect.stringMatching(/AgEnD is updating \(attempt .*, barrier\)/) });
    expect(fleetStartGate(h, OTHER, LIVE([UPDATER]))).toMatchObject({ ok: false });                         // not a planned nonce
    expect(fleetStartGate(h, NONCE, LIVE([UPDATER]))).toEqual({ ok: true });
    expect(fleetStartGate(h, NONCE, LIVE([]))).toMatchObject({ ok: false, reason: expect.stringMatching(/interrupted.*--resolve/) });   // updater gone: recovery's
    expect(fleetStartGate(h, NONCE, { processStart: () => null, exists: () => true })).toMatchObject({ ok: false });   // unknown
    a = finish(h, a, { kind: "manual-recovery", reason: "test" });
    expect(fleetStartGate(h, NONCE, LIVE([UPDATER]))).toMatchObject({ ok: false, reason: expect.stringMatching(/manual recovery/) });
    writeFileSync(join(h, ".update-journal", "current"), "garbage\n");
    expect(fleetStartGate(h, null, LIVE([]))).toMatchObject({ ok: false, reason: expect.stringMatching(/can't be read/) });
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
    open(h);
    const held = acquireServiceLock(h, ID, deps(UPDATER, [UPDATER]));
    if (!held.ok) throw new Error(held.reason);
    expect(admitServiceCommand(h, "restart", deps(600, [UPDATER, 600]), { [SERVICE_LOCK_TOKEN_ENV]: held.token })).toMatchObject({ ok: true, viaToken: true });
    expect(admitServiceCommand(h, "restart", deps(600, [UPDATER, 600]), { [SERVICE_LOCK_TOKEN_ENV]: "f".repeat(32) }).ok).toBe(false);
    // The holder gone: its token admits nothing; the stale lock is reclaimed by a normal command.
    const after = admitServiceCommand(h, "restart", deps(601, [601]), { [SERVICE_LOCK_TOKEN_ENV]: held.token });
    expect(after).toMatchObject({ ok: true, viaToken: false });
  });

  it("the token is bound to the open attempt and its updater: another holder, another attempt, or no open attempt admits nothing (Prism #4499)", () => {
    const h = home();
    // A holder that isn't the attempt's updater (another pid), with the journal open on that attempt.
    open(h);
    const other = acquireServiceLock(h, ID, deps(700, [700]));
    if (!other.ok) throw new Error(other.reason);
    expect(admitServiceCommand(h, "restart", deps(600, [700, 600]), { [SERVICE_LOCK_TOKEN_ENV]: other.token }).ok).toBe(false);
    // The updater's lock, but no open attempt (another home's journal state: none).
    const h2 = home();
    const held = acquireServiceLock(h2, ID, deps(UPDATER, [UPDATER]));
    if (!held.ok) throw new Error(held.reason);
    expect(admitServiceCommand(h2, "restart", deps(600, [UPDATER, 600]), { [SERVICE_LOCK_TOKEN_ENV]: held.token }).ok).toBe(false);
  });

  it("the token's holder must be the updater by its full identity: start ticks and boot id too, when recorded (Prism #4499 R2)", () => {
    const BOOT = "0b0b0b0b-0000-4000-8000-000000000001", BOOT2 = "0b0b0b0b-0000-4000-8000-000000000002";
    const ticked = (pid: number, live: number[], ticks: string): InstallLockDeps => ({ ...deps(pid, live), startTicks: p => (live.includes(p) || p === pid ? ticks : null), bootId: () => BOOT });
    const openWith = (h: string, start: { processStart: string; startTicks?: string; bootId?: string }) => {
      const r = openAttempt(h, { id: ID, kind: "update", updater: { pid: UPDATER, start }, from: { name: "@songsid/agend", version: "2.4.0", integrity: null }, to: { name: "@songsid/agend", version: "2.4.1", integrity: null } });
      if (!r.ok) throw new Error(r.reason);
    };
    const tokenAdmits = (start: { processStart: string; startTicks?: string; bootId?: string }) => {
      const h = home();
      openWith(h, start);
      const held = acquireServiceLock(h, ID, ticked(UPDATER, [UPDATER], "123"));
      if (!held.ok) throw new Error(held.reason);
      return admitServiceCommand(h, "restart", ticked(600, [UPDATER, 600], "123"), { [SERVICE_LOCK_TOKEN_ENV]: held.token }).ok;
    };
    expect(tokenAdmits({ ...START, startTicks: "123", bootId: BOOT })).toBe(true);                     // the control: the same process
    expect(tokenAdmits({ ...START, startTicks: "999", bootId: BOOT })).toBe(false);                    // other ticks
    expect(tokenAdmits({ ...START, startTicks: "123", bootId: BOOT2 })).toBe(false);                   // another boot
    expect(tokenAdmits(START)).toBe(false);                                                            // ticks on one side only
  });

  it("a home that doesn't exist yet is created (private) and the command takes the lock the normal way — never admitted lockless", () => {
    const root = home(), h = join(root, "fresh-home");
    const admitted = admitServiceCommand(h, "start", deps(500, [500]), {});
    expect(admitted).toMatchObject({ ok: true, viaToken: false });
    expect(statSync(h).mode & 0o777).toBe(0o700);
    expect(existsSync(join(h, ".service.lock"))).toBe(true);
    // Held: an updater arriving now can't take the service until this command releases it.
    expect(acquireServiceLock(h, ID, deps(UPDATER, [UPDATER, 500])).ok).toBe(false);
    if (admitted.ok) admitted.release();
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
      process.stdout.write("held\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`], { stdio: ["pipe", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("exit", c => reject(new Error(`child exited ${c}`))); });
    expect(takeExclusiveLease(h, 200).ok).toBe(false);
    const exited = new Promise<void>(r => child.once("exit", () => r()));
    child.stdin!.end();                                                                              // the child exits: the kernel drops its lock
    await exited;
    const ex = takeExclusiveLease(h, 2000);
    expect(ex.ok).toBe(true);
    if (ex.ok) ex.lease.release();
  }, 30_000);
});

describe("M-3770 2.1b: a missing home is leased, not skipped (Prism #4499)", () => {
  it("between processes: a writer that found no home creates it and holds SHARED; the updater that then creates its journal can't drain past it", async () => {
    const root = home(), h = join(root, "fresh-home");
    // The child holds SHARED until the parent closes its stdin — no timer, so a slow start (tsx under load) can't let it
    // exit before the parent's check (Sentinel's report: a 1500 ms lifetime raced on a busy host).
    const child = spawn(process.execPath, ["--import", "tsx", "-e", `
      import { takeSharedLease } from ${JSON.stringify(join(process.cwd(), "src", "state-lease.ts"))};
      const r = takeSharedLease(${JSON.stringify(h)}, "schedule");
      if (!r.ok) { console.error(r.reason); process.exit(2); }
      process.stdout.write("held\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`], { stdio: ["pipe", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("exit", c => reject(new Error(`child exited ${c}`))); });
    expect(statSync(h).mode & 0o777).toBe(0o700);
    open(h);                                                                                         // the update begins: journal published
    expect(takeExclusiveLease(h, 200)).toMatchObject({ ok: false, reason: expect.stringMatching(/still runs/) });
    const exited = new Promise<void>(r => child.once("exit", () => r()));
    child.stdin!.end();
    await exited;
    const ex = takeExclusiveLease(h, 2000);
    expect(ex.ok).toBe(true);
    if (ex.ok) ex.lease.release();
  }, 30_000);
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
  it("the fleet start reads the journal (fleetStartGate) before it touches fleet.lock, and its claim carries the liveness probes", () => {
    const body = cli.slice(cli.indexOf("function claimFleetSingleton"), cli.indexOf("// Read version from package.json"));
    expect(body.indexOf("fleetStartGate(DATA_DIR")).toBeGreaterThan(0);
    expect(body.indexOf("fleetStartGate(DATA_DIR")).toBeLessThan(body.indexOf("acquireFleetLock(DATA_DIR"));
    expect(body).toMatch(/claimHandoff\(DATA_DIR, attemptId, nonce, \{ pid, start \}, liveness\)/);
  });
  it("agend start, stop, restart (the whole service) and install take the service lock", () => {
    for (const command of ["start", "stop", "install"]) expect(cli).toContain(`guardServiceCommand("${command}")`);
    expect(cli).toContain('if (!instance && !guardServiceCommand("restart")) return;');
  });
});
