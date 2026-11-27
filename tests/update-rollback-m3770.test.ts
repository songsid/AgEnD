// M-3770 slice 2.5 (S-252 part 1): the rollback driven end to end on a scratch home, prefix and unit — the trial fleet
// stopped (only as the recorded trial generation), the fence re-taken, home + package + unit restored with the route
// kept, the rollback generation planned / handed off / started / acknowledged, the route taken off, rolled-back — and a
// crash injected at every journal write, each retried to the same end state. The service manager and the fleets are
// stand-ins: no real fleet, no systemctl.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFleetLock, adoptUpdateFence, readFleetLockRecord, setFleetLockHandoff } from "../src/fleet-lock.js";
import { recordInstallIntent, type Ownership } from "../src/install-ownership.js";
import { ackGeneration, advance, attemptDir, defaultJournalIo, finishClosing, newAttemptId, openAttempt, planGeneration, readCurrent, readMarks, type AttemptRecord, type JournalIo } from "../src/update-journal.js";
import { takeSnapshot } from "../src/update-snapshot.js";
import { takeAttemptPreimage } from "../src/update-package-restore.js";
import { dropInPath, writeRecoveryRoute } from "../src/update-recovery/route.js";
import { rollBack, type RollbackDeps } from "../src/update-rollback.js";
import { buildRecoveryKit } from "../src/update-recovery/kit.js";
import { runRecovery } from "../src/update-recovery/runner.js";
import { parsePlist } from "../src/service-activation.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "rollback-")); dirs.push(d); return d; };
const ID = newAttemptId(new Date("2026-11-26T14:00:00Z"), "beefcafe");
const START = { processStart: "Thu Nov 26 14:00:00 2026" };
const UPDATER = 4242, TRIAL = 5300, OLD = 5100;
const TRIAL_NONCE = "c".repeat(32);
const UNIT = "[Service]\nExecStart=/usr/bin/agend fleet start\n";
const plistArgs = (xml: string) => parsePlist(xml)?.argv ?? null;

function installPackage(o: Ownership, version: string) {
  rmSync(o.packagePath, { recursive: true, force: true });
  mkdirSync(join(o.packagePath, "dist"), { recursive: true }); mkdirSync(join(o.packagePath, "launcher"), { recursive: true });
  writeFileSync(join(o.packagePath, "package.json"), JSON.stringify({ name: "@songsid/agend", version }));
  writeFileSync(join(o.packagePath, "dist", "cli.js"), `// ${version}`);
  for (const name of ["agend", "agend-agent"] as const) {
    writeFileSync(join(o.packagePath, "launcher", name), `#!/bin/sh # ${version}`);
    rmSync(o.binLinks[name], { force: true }); symlinkSync(join(o.packagePath, "launcher", name), o.binLinks[name]);
  }
}

interface World { home: string; o: Ownership; fragment: string; alive: Set<number>; lockPid: () => number | undefined; deps: (crashAt?: number) => RollbackDeps & { io: JournalIo } }

/** A scratch world at `trial`: snapshotted home, the new package installed over a recorded preimage, the route written, the trial fleet live. */
function world(): World {
  const root = tmp(), home = join(root, "home"), prefix = join(root, "prefix");
  mkdirSync(home); mkdirSync(join(prefix, "bin"), { recursive: true }); mkdirSync(join(prefix, "lib", "node_modules", "@songsid"), { recursive: true });
  const fragment = join(root, "agend.service"); writeFileSync(fragment, UNIT);
  const o: Ownership = { uid: 1000, home, prefix, packagePath: join(prefix, "lib", "node_modules", "@songsid", "agend"),
    binLinks: { agend: join(prefix, "bin", "agend"), "agend-agent": join(prefix, "bin", "agend-agent") }, service: { kind: "systemd", unit: "agend.service", fragmentPath: fragment } };
  installPackage(o, "2.4.0");
  writeFileSync(join(home, "fleet.yaml"), "version: old\n");
  const alive = new Set<number>([UPDATER, OLD]);
  const res = openAttempt(home, { id: ID, kind: "update", updater: { pid: UPDATER, start: START },
    from: { name: "@songsid/agend", version: "2.4.0", integrity: null }, to: { name: "@songsid/agend", version: "2.4.1", integrity: null },
    extra: { ownership: o, expected: { old: { version: "2.4.0", integrity: null, bins: { agend: "/x", "agend-agent": "/y" }, entry: "/x/cli.js", interpreter: "/n", execStart: null } }, fleets: [] } });
  if (!res.ok) throw new Error(res.reason);
  let a: AttemptRecord = advance(home, advance(home, res.attempt, "barrier"), "stopping");
  // The old fleet stopped; the updater fences fleet.lock.
  alive.delete(OLD);
  const fence = acquireFleetLock(home, { pid: UPDATER, role: "update", attemptId: ID });
  const snap = takeSnapshot(home, attemptDir(home, ID), { proveWritersGone: () => ({ ok: true }) });
  if (!snap.ok) throw new Error(snap.reason);
  a = advance(home, a, "snapshotted");
  // The kit (a small stand-in for the Node binary: verified by its hashes, its run-alone check stubbed).
  const fakeNode = join(root, "node-stand-in"); writeFileSync(fakeNode, "#!/bin/sh\n");
  const bundle = join(root, "recover-stand-in.cjs"); writeFileSync(bundle, "// recover\n");
  const kit = buildRecoveryKit(home, ID, { nodePath: fakeNode, bundlePath: bundle, runsAlone: () => true });
  if (!kit.ok) throw new Error(kit.reason);
  expect(writeRecoveryRoute(home, a, { plistArgs }).ok).toBe(true);
  a = advance(home, a, "installing");
  const pre = takeAttemptPreimage(o, ID); if (!pre.ok) throw new Error(pre.reason);
  a = recordInstallIntent(home, a, { preimage: { dir: pre.dir, manifestSha256: pre.manifestSha256 }, destination: { packagePath: o.packagePath, binLinks: Object.values(o.binLinks) },
    target: { name: "@songsid/agend", version: "2.4.1", integrity: null }, command: ["npm", "install", "-g", "@songsid/agend@2.4.1"] });
  installPackage(o, "2.4.1");
  writeFileSync(join(home, "fleet.yaml"), "version: new\nmigrated: true\n");                         // the new version migrated it
  writeFileSync(join(home, "new-state.json"), "{}");
  // The trial: planned, handed off, taken over by the trial fleet, acknowledged.
  a = advance(home, a, "trial");
  a = planGeneration(home, a, "trial", TRIAL_NONCE);
  setFleetLockHandoff(fence, { nonce: TRIAL_NONCE, gen: "trial" });
  writeFileSync(join(home, "fleet.lock"), JSON.stringify({ pid: TRIAL, nonce: TRIAL_NONCE, createdAt: new Date().toISOString(), role: "fleet" }) + "\n");
  alive.add(TRIAL);
  ackGeneration(home, a, TRIAL_NONCE, TRIAL);
  let nextPid = 6000;
  const live = (pids: Set<number>) => ({ processStart: (p: number) => (pids.has(p) ? START.processStart : null), exists: (p: number) => pids.has(p) });
  const deps = (crashAt?: number): RollbackDeps & { io: JournalIo } => {
    let n = 0;
    return {
      self: { pid: UPDATER, start: START }, liveness: live(alive), isProcessAlive: p => alive.has(p),
      proveWritersGone: () => ({ ok: true }), plistArgs,
      manager: {
        mainPid: () => { const r = readFleetLockRecord(home); return r && r.role === "fleet" && alive.has(r.pid) ? r.pid : null; },
        stop: () => { const r = readFleetLockRecord(home); if (r && r.role === "fleet") alive.delete(r.pid); return true; },
        reload: () => true,
        // A start: the pre-start step hands the fence's planned nonce on; the new fleet takes fleet.lock over with it.
        start: () => {
          const fenceRec = readFleetLockRecord(home);
          if (fenceRec?.role !== "update" || !fenceRec.handoff) return false;
          const pid = nextPid++; alive.add(pid);
          writeFileSync(join(home, "fleet.lock"), JSON.stringify({ pid, nonce: fenceRec.handoff.nonce, createdAt: new Date().toISOString(), role: "fleet" }) + "\n");
          return true;
        },
      },
      waitTakeover: nonce => { const r = readFleetLockRecord(home); return r?.role === "fleet" && r.nonce === nonce ? r.pid : null; },
      io: { ...defaultJournalIo, step: () => { if (crashAt !== undefined && ++n === crashAt) throw new Error(`crash at journal step ${crashAt}`); } },
    };
  };
  return { home, o, fragment, alive, lockPid: () => readFleetLockRecord(home)?.pid, deps };
}

const current = (home: string) => { const r = readCurrent(home); if (r.state !== "open") throw new Error(`journal reads ${r.state}`); return r.attempt; };
const endState = (w: World) => ({
  fleetYaml: readFileSync(join(w.home, "fleet.yaml"), "utf8"), newState: existsSync(join(w.home, "new-state.json")),
  version: JSON.parse(readFileSync(join(w.o.packagePath, "package.json"), "utf8")).version, unit: readFileSync(w.fragment, "utf8"),
  dropIn: existsSync(dropInPath(w.o.service!)), journal: readCurrent(w.home).state, lockRole: readFleetLockRecord(w.home)?.role,
});

describe("M-3770 2.5: the recovery runner resumes a rollback (recover.cjs --run, its hands injected)", () => {
  it("the updater gone mid-trial: the runner takes the three locks, settles, rolls back through the driver, releases", () => {
    const w = world();
    w.alive.delete(UPDATER);
    const RUNNER = 7900; w.alive.add(RUNNER);
    const base = w.deps();
    const out: string[] = [], err: string[] = [];
    let settled = 0;
    const code = runRecovery(w.home, ID, {
      pid: RUNNER, liveness: base.liveness, io: defaultJournalIo, out: l => out.push(l), err: l => err.push(l),
      lock: { ...base.liveness, newToken: () => "a".repeat(32), now: () => new Date(), log: () => {} },
      hands: { manager: () => ({ ...base.manager, waitSettled: () => { settled++; return true; } }), waitTakeover: base.waitTakeover, proveWritersGone: () => ({ ok: true }), waitHandedBack: done => done() },
    });
    expect(code, err.join("\n")).toBe(0);
    expect(settled).toBe(1);
    expect(out.join("\n")).toMatch(/is rolled back/);
    expect(endState(w)).toEqual({ fleetYaml: "version: old\n", newState: false, version: "2.4.0", unit: UNIT, dropIn: false, journal: "none", lockRole: "fleet" });
    expect([".update.lock", ".service.lock"].filter(f => existsSync(join(w.home, f)))).toEqual([]);   // released
  });

  it("the rollback generation's start fails: the runner reports it as retryable, not rolled back", () => {
    const w = world();
    w.alive.delete(UPDATER);
    w.alive.add(7902);
    const base = w.deps();
    const out: string[] = [], err: string[] = [];
    const code = runRecovery(w.home, ID, {
      pid: 7902, liveness: base.liveness, io: defaultJournalIo, out: l => out.push(l), err: l => err.push(l),
      lock: { ...base.liveness, newToken: () => "e".repeat(32), now: () => new Date(), log: () => {} },
      hands: { manager: () => ({ ...base.manager, start: () => false, waitSettled: () => true }), waitTakeover: base.waitTakeover, proveWritersGone: () => ({ ok: true }), waitHandedBack: done => done() },
    });
    expect(code).toBe(1);
    expect(out.join("\n")).not.toMatch(/is rolled back/);
    expect(err.at(-1)).toMatch(/Run the recovery again\.$/);
    expect(readCurrent(w.home).state).toBe("open");
  });

  it("a refused start that never settles: refused, nothing changed", () => {
    const w = world();
    w.alive.delete(UPDATER);
    w.alive.add(7901);
    const base = w.deps();
    const err: string[] = [];
    const code = runRecovery(w.home, ID, {
      pid: 7901, liveness: base.liveness, io: defaultJournalIo, out: () => {}, err: l => err.push(l),
      lock: { ...base.liveness, newToken: () => "b".repeat(32), now: () => new Date(), log: () => {} },
      hands: { manager: () => ({ ...base.manager, waitSettled: () => false }), waitTakeover: base.waitTakeover, proveWritersGone: () => ({ ok: true }), waitHandedBack: done => done() },
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/hasn't settled/);
    expect(readFileSync(join(w.home, "fleet.yaml"), "utf8")).toBe("version: new\nmigrated: true\n");
  });
});

describe("M-3770 2.5: the rollback, end to end on a scratch world", () => {
  it("stops the recorded trial fleet, restores home + package + unit, hands the rollback generation over, takes the route off: rolled-back", () => {
    const w = world();
    const res = rollBack(w.home, current(w.home), w.deps());
    expect(res, res.ok ? "" : res.reason).toMatchObject({ ok: true, attempt: { stage: "rolled-back" } });
    expect(endState(w)).toEqual({ fleetYaml: "version: old\n", newState: false, version: "2.4.0", unit: UNIT, dropIn: false, journal: "none", lockRole: "fleet" });
    expect(w.alive.has(TRIAL)).toBe(false);                                                         // the trial fleet was stopped
    const fleets = (res.attempt.fleets as Array<{ gen: string; consumed?: boolean; dead?: boolean }>);
    expect(fleets.find(f => f.gen === "trial")).toMatchObject({ consumed: true, dead: true });
    expect(fleets.find(f => f.gen === "rollback")).toMatchObject({ consumed: true });
    const marks = readMarks(w.home);
    expect(marks.ok && marks.marks.map(m => m.version)).toEqual(["2.4.1"]);                         // the failed version is marked
  });

  it("a crash at EVERY journal write, then a retry (re-reading the journal), ends in the same state", () => {
    const ref = world();
    let steps = 0;
    const counting = ref.deps(); counting.io = { ...defaultJournalIo, step: () => { steps++; } };
    expect(rollBack(ref.home, current(ref.home), counting).ok).toBe(true);
    const want = endState(ref);
    expect(steps).toBeGreaterThan(10);
    for (let k = 1; k <= steps; k++) {
      const w = world();
      let threw = false;
      try { rollBack(w.home, current(w.home), w.deps(k)); } catch { threw = true; }
      expect(threw, `step ${k}`).toBe(true);
      const read = readCurrent(w.home);
      if (read.state === "none") { expect(endState(w), `after step ${k} (already closed)`).toEqual(want); continue; }
      if (read.state === "closing") {                                                               // the terminal record landed: the next holder clears current
        finishClosing(w.home, read.attempt);
        expect(endState(w), `after step ${k} (closing)`).toEqual(want);
        continue;
      }
      const again = rollBack(w.home, current(w.home), w.deps());
      expect(again.ok, `retry after step ${k}: ${again.ok ? "" : again.reason}`).toBe(true);
      expect(endState(w), `after step ${k}`).toEqual(want);
    }
  }, 300_000);

  it("the runner, for a dead updater: adopts its fence and rolls back", () => {
    const w = world();
    // The updater died while it still held the fence (the trial never started): put the fence back as the updater's.
    writeFileSync(join(w.home, "fleet.lock"), JSON.stringify({ pid: UPDATER, nonce: "d".repeat(32), createdAt: new Date().toISOString(), role: "update", attemptId: ID, handoff: null }) + "\n");
    w.alive.delete(TRIAL); w.alive.delete(UPDATER);
    const RUNNER = 7700; w.alive.add(RUNNER);
    const d = w.deps(); d.self = { pid: RUNNER, start: START };
    const res = rollBack(w.home, current(w.home), d);
    expect(res, res.ok ? "" : res.reason).toMatchObject({ ok: true });
    expect(endState(w)).toMatchObject({ version: "2.4.0", fleetYaml: "version: old\n", journal: "none" });
  });

  it("refuses — manual — a fleet.lock holder that isn't a recorded generation, and a live updater's fence", () => {
    const w = world();
    writeFileSync(join(w.home, "fleet.lock"), JSON.stringify({ pid: 9999, nonce: "e".repeat(32), createdAt: new Date().toISOString(), role: "fleet" }) + "\n");
    w.alive.add(9999);
    expect(rollBack(w.home, current(w.home), w.deps())).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/no recorded generation/) });
    expect(readFileSync(join(w.home, "fleet.yaml"), "utf8")).toBe("version: new\nmigrated: true\n");   // nothing restored
    const v = world();
    writeFileSync(join(v.home, "fleet.lock"), JSON.stringify({ pid: UPDATER, nonce: "d".repeat(32), createdAt: new Date().toISOString(), role: "update", attemptId: ID, handoff: null }) + "\n");
    v.alive.delete(TRIAL);
    const d = v.deps(); d.self = { pid: 7701, start: START };                                     // the runner, but the updater lives
    expect(rollBack(v.home, current(v.home), d)).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/live process/) });
  });

  it("a live generation other than the trial (the old one, say) holding fleet.lock is never stopped: manual", () => {
    const w = world();
    let a = current(w.home);
    const OLD_NONCE = "f".repeat(32);
    a = planGeneration(w.home, a, "old", OLD_NONCE);
    writeFileSync(join(w.home, "fleet.lock"), JSON.stringify({ pid: OLD, nonce: OLD_NONCE, createdAt: new Date().toISOString(), role: "fleet" }) + "\n");
    w.alive.add(OLD);
    ackGeneration(w.home, a, OLD_NONCE, OLD);
    let stopped = false;
    const d = w.deps(); d.manager.stop = () => { stopped = true; return true; };
    expect(rollBack(w.home, current(w.home), d)).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/generation old, not trial/) });
    expect(stopped).toBe(false);
  });

  it("a trial fleet that is still running after the manager's stop: manual, nothing restored", () => {
    const w = world();
    const d = w.deps(); d.manager.stop = () => true;                                               // says stopped; the fleet lives on
    expect(rollBack(w.home, current(w.home), d)).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/still running after the stop/) });
    expect(readFileSync(join(w.home, "fleet.yaml"), "utf8")).toBe("version: new\nmigrated: true\n");
  });

  it("adoptUpdateFence takes only this attempt's fence from a gone holder; it returns the caller's own as is", () => {
    const home = tmp();
    const other = newAttemptId(new Date("2026-11-26T15:00:00Z"), "00000001");
    writeFileSync(join(home, "fleet.lock"), JSON.stringify({ pid: 4242, nonce: "d".repeat(32), createdAt: "2026-11-26T00:00:00Z", role: "update", attemptId: other, handoff: null }) + "\n");
    expect(adoptUpdateFence(home, { pid: 7700, attemptId: ID }, { isProcessAlive: () => false })).toMatchObject({ ok: false, reason: expect.stringMatching(/isn't this attempt's fence/) });
    writeFileSync(join(home, "fleet.lock"), JSON.stringify({ pid: 4242, nonce: "d".repeat(32), createdAt: "2026-11-26T00:00:00Z", role: "update", attemptId: ID, handoff: null }) + "\n");
    const adopted = adoptUpdateFence(home, { pid: 7700, attemptId: ID }, { isProcessAlive: () => false });
    expect(adopted).toMatchObject({ ok: true, handle: { record: { pid: 7700, role: "update", attemptId: ID } } });
    expect(adoptUpdateFence(home, { pid: 7700, attemptId: ID }, { isProcessAlive: () => true })).toMatchObject({ ok: true, handle: { record: { pid: 7700 } } });   // its own
    // Its own, with a marker it left itself (an exception mid-reclaim): returned, and the marker cleared.
    writeFileSync(join(home, "fleet.lock.reclaim"), JSON.stringify({ pid: 7700, nonce: "9".repeat(32), createdAt: "2026-11-26T00:00:00Z", role: "update", attemptId: ID, handoff: null }) + "\n");
    expect(adoptUpdateFence(home, { pid: 7700, attemptId: ID }, { isProcessAlive: () => true })).toMatchObject({ ok: true });
    expect(existsSync(join(home, "fleet.lock.reclaim"))).toBe(false);
  });

  it("no route yet (a crash early in snapshotted) and no kit to run it: manual, naming the kit", () => {
    const w = world();
    rmSync(join(attemptDir(w.home, ID), "unit.preimage")); rmSync(dropInPath(w.o.service!));
    rmSync(join(w.home, ".update-journal", "recovery", ID), { recursive: true });
    expect(rollBack(w.home, current(w.home), w.deps())).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/recovery route can't be made: the kit/) });
  });

  it("the route kept but its kit pruned or damaged: manual before any start, not a forever-retryable start (Fable #4531 N1)", () => {
    const w = world();
    writeFileSync(join(w.home, ".update-journal", "recovery", ID, "recover.cjs"), "damaged");
    let started = false;
    const d = w.deps(); d.manager.start = () => { started = true; return true; };
    expect(rollBack(w.home, current(w.home), d)).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/can't start through the recovery route: the kit's recover\.cjs/) });
    expect(started).toBe(false);
  });

  it("a crash inside the fence's re-take (marker made, no rename yet; or rename landed, marker left) heals on the retry (Fable #4531 F1)", () => {
    // The runner's adoption crashed after its marker, before the rename: the lock is still the dead updater's.
    const w = world();
    writeFileSync(join(w.home, "fleet.lock"), JSON.stringify({ pid: UPDATER, nonce: "d".repeat(32), createdAt: new Date().toISOString(), role: "update", attemptId: ID, handoff: null }) + "\n");
    writeFileSync(join(w.home, "fleet.lock.reclaim"), JSON.stringify({ pid: 7600, nonce: "9".repeat(32), createdAt: new Date().toISOString(), role: "update", attemptId: ID, handoff: null }) + "\n");
    w.alive.delete(TRIAL); w.alive.delete(UPDATER);
    const d = w.deps(); d.self = { pid: 7700, start: START }; w.alive.add(7700);
    expect(rollBack(w.home, current(w.home), d)).toMatchObject({ ok: true });
    expect(existsSync(join(w.home, "fleet.lock.reclaim"))).toBe(false);
    // The rename landed and the marker stayed: the lock is the crashed runner's (pid gone); the new runner adopts it.
    const v = world();
    const crashed = { pid: 7600, nonce: "9".repeat(32), createdAt: new Date().toISOString(), role: "update", attemptId: ID, handoff: null };
    writeFileSync(join(v.home, "fleet.lock"), JSON.stringify(crashed) + "\n"); writeFileSync(join(v.home, "fleet.lock.reclaim"), JSON.stringify(crashed) + "\n");
    v.alive.delete(TRIAL); v.alive.delete(UPDATER);
    const e = v.deps(); e.self = { pid: 7701, start: START }; v.alive.add(7701);
    expect(rollBack(v.home, current(v.home), e)).toMatchObject({ ok: true });
    expect(existsSync(join(v.home, "fleet.lock.reclaim"))).toBe(false);
    // A marker whose taker still lives, or of another attempt, still refuses.
    const u = world();
    writeFileSync(join(u.home, "fleet.lock"), JSON.stringify({ pid: UPDATER, nonce: "d".repeat(32), createdAt: new Date().toISOString(), role: "update", attemptId: ID, handoff: null }) + "\n");
    writeFileSync(join(u.home, "fleet.lock.reclaim"), JSON.stringify({ ...crashed, pid: 7800 }) + "\n");
    u.alive.delete(TRIAL); u.alive.delete(UPDATER); u.alive.add(7800);
    const f = u.deps(); f.self = { pid: 7702, start: START }; u.alive.add(7702);
    expect(rollBack(u.home, current(u.home), f)).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/reclaim marker/) });
  });

  it("a race lost during the fence's adoption (the lock changed under it) is looked at again, not manual (Fable #4531 F2)", () => {
    const w = world();
    // The dead updater's fence; while the runner adopts it, the recorded trial's record lands (dead, so it is re-taken next round).
    const fenceRec = { pid: UPDATER, nonce: "d".repeat(32), createdAt: new Date().toISOString(), role: "update", attemptId: ID, handoff: null };
    writeFileSync(join(w.home, "fleet.lock"), JSON.stringify(fenceRec) + "\n");
    w.alive.delete(TRIAL); w.alive.delete(UPDATER);
    const d = w.deps(); d.self = { pid: 7700, start: START }; w.alive.add(7700);
    let raced = false;
    const alive = d.isProcessAlive;
    d.isProcessAlive = p => {
      if (!raced && p === UPDATER) { raced = true; writeFileSync(join(w.home, "fleet.lock"), JSON.stringify({ pid: TRIAL, nonce: TRIAL_NONCE, createdAt: new Date().toISOString(), role: "fleet" }) + "\n"); }
      return alive(p);
    };
    expect(rollBack(w.home, current(w.home), d)).toMatchObject({ ok: true });
    expect(raced).toBe(true);
  });

  it("a start that fails, or a takeover that never comes, is retryable; the retry plans afresh and completes", () => {
    const w = world();
    const d = w.deps(); const start = d.manager.start; d.manager.start = () => false;
    expect(rollBack(w.home, current(w.home), d)).toMatchObject({ ok: false, manual: false, reason: expect.stringMatching(/didn't start/) });
    d.manager.start = start;
    const wait = d.waitTakeover; d.waitTakeover = () => null;
    expect(rollBack(w.home, current(w.home), d)).toMatchObject({ ok: false, manual: false, reason: expect.stringMatching(/didn't take fleet.lock over/) });
    d.waitTakeover = wait;
    // The never-acknowledged start did take over: the retry recognises it and acknowledges it.
    expect(rollBack(w.home, current(w.home), d)).toMatchObject({ ok: true });
    expect(endState(w)).toMatchObject({ version: "2.4.0", journal: "none", lockRole: "fleet" });
  });
});
