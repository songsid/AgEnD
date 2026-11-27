// M-3770 slice 2.5 (S-252, Go back; design rev 16, Fable's Go back review, Sentinel's S-230 read contract): on a scratch
// home, prefix and systemd unit, an update 2.4.0 → 2.4.1 is committed, then Go back returns to 2.4.0 through the same
// transaction — the current fleet stopped and fenced, the current home snapshotted, the committed attempt's home, package
// and unit restored (no npm), the old version's trial taken over and proven, committed — and the retained entry is used.
// S-230's guard is a stand-in (#4519 isn't merged): it is asked before the attempt opens and again before the restore,
// each time with a private, verified copy of a snapshot's outbox database. No real fleet, systemctl or npm.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFleetLockRecord } from "../src/fleet-lock.js";
import type { ArtifactTuple, Ownership, TupleRead } from "../src/install-ownership.js";
import { attemptDir, defaultJournalIo, journalDir, newAttemptId, openAttempt, readAttemptRecord, readCurrent, type AttemptRecord, type FleetGeneration, type JournalIo } from "../src/update-journal.js";
import { runUpdate, type UpdateDeps } from "../src/update-forward.js";
import { goBackChanges, readGoBackOffer, runGoBack, type GoBackGuard } from "../src/update-goback.js";
import { readRetained } from "../src/update-retained.js";
import { dropInPath, removeRecoveryRoute, unwrapRecoveryRoute, wrapPlist } from "../src/update-recovery/route.js";
import { parsePlist } from "../src/service-activation.js";


const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "goback-")); dirs.push(d); return d; };
const ID = newAttemptId(new Date("2026-11-26T15:00:00Z"), "feedf00d");
const START = { processStart: "Thu Nov 26 15:00:00 2026" };
const UPDATER = 4343, OLD = 5100;
const OLD_NONCE = "a".repeat(32);
const UNIT = "[Service]\nExecStart=/usr/bin/agend fleet start\n";
const plistArgs = (xml: string) => parsePlist(xml)?.argv ?? null;
const PLAN = { target: { name: "@songsid/agend", version: "2.4.1", integrity: null }, command: ["npm", "install", "-g", "@songsid/agend@2.4.1"] };

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
const tupleOf = (o: Ownership, version: string): ArtifactTuple => ({ version, integrity: null,
  bins: { agend: join(o.packagePath, "launcher", "agend"), "agend-agent": join(o.packagePath, "launcher", "agend-agent") },
  entry: join(o.packagePath, "dist", `cli-${version}.js`), interpreter: "/n", execStart: null });

interface Opts { noFleet?: boolean; noService?: boolean; launchd?: boolean }
/** S-260: a launchd job's plist (ProgramArguments: the version's own launcher). */
const plistOf = (args: string[]) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>com.agend.fleet</string><key>ProgramArguments</key><array>${args.map(a => `<string>${a}</string>`).join("")}</array></dict></plist>\n`;
const PLIST_240 = plistOf(["/usr/local/bin/agend", "fleet", "start"]);
const PLIST_241 = plistOf(["/usr/local/bin/agend", "fleet", "start", "--since-2.4.1"]);
/** Crash injection: the `crashAt`-th journal step counted once `crashFrom` says so; `onCrash` hears it (a crash inside a
 *  step that catches I/O errors would otherwise read as a failed step, not a dead process). */
interface Crash { crashFrom?: () => boolean; crashAt?: number; onCrash?: () => void }
interface World {
  home: string; o: Ownership; fragment: string; alive: Set<number>; calls: string[]; attempt: AttemptRecord;
  deps: (over?: Partial<UpdateDeps> & Crash) => UpdateDeps & { io: JournalIo };
}

/** A scratch world at `opened`: the old version installed, its fleet (generation old) holding fleet.lock. */
function world(opts: Opts = {}): World {
  const root = tmp(), home = join(root, "home"), prefix = join(root, "prefix");
  mkdirSync(home); mkdirSync(join(prefix, "bin"), { recursive: true }); mkdirSync(join(prefix, "lib", "node_modules", "@songsid"), { recursive: true });
  const fragment = opts.launchd ? join(root, "com.agend.fleet.plist") : join(root, "agend.service");
  writeFileSync(fragment, opts.launchd ? PLIST_240 : UNIT);
  const o: Ownership = { uid: 1000, home, prefix, packagePath: join(prefix, "lib", "node_modules", "@songsid", "agend"),
    binLinks: { agend: join(prefix, "bin", "agend"), "agend-agent": join(prefix, "bin", "agend-agent") },
    service: opts.noService ? null : opts.launchd ? { kind: "launchd", unit: "com.agend.fleet", fragmentPath: fragment } : { kind: "systemd", unit: "agend.service", fragmentPath: fragment } };
  installPackage(o, "2.4.0");
  writeFileSync(join(home, "fleet.yaml"), "version: old\n");
  const alive = new Set<number>([UPDATER]);
  const fleets: FleetGeneration[] = [];
  if (!opts.noFleet) {
    alive.add(OLD);
    writeFileSync(join(home, "fleet.lock"), JSON.stringify({ pid: OLD, nonce: OLD_NONCE, createdAt: new Date().toISOString(), role: "fleet" }) + "\n");
    fleets.push({ gen: "old", nonce: OLD_NONCE, pid: OLD, plannedAt: new Date().toISOString(), consumed: true });
  }
  const res = openAttempt(home, { id: ID, kind: "update", updater: { pid: UPDATER, start: START },
    from: { name: "@songsid/agend", version: "2.4.0", integrity: null }, to: PLAN.target,
    extra: { ownership: o, expected: { old: tupleOf(o, "2.4.0") }, fleets } });
  if (!res.ok) throw new Error(res.reason);
  const fakeNode = join(root, "node-stand-in"); writeFileSync(fakeNode, "#!/bin/sh\n");
  const bundle = join(root, "recover-stand-in.cjs"); writeFileSync(bundle, "// recover\n");
  const calls: string[] = [];
  let nextPid = 6000;
  const live = (pids: Set<number>) => ({ processStart: (p: number) => (pids.has(p) ? START.processStart : null), exists: (p: number) => pids.has(p) });
  const version = () => JSON.parse(readFileSync(join(o.packagePath, "package.json"), "utf8")).version as string;
  const deps = (over: Partial<UpdateDeps> & Crash = {}): UpdateDeps & { io: JournalIo } => {
    let n = 0, dead = false;
    const { crashFrom, crashAt, onCrash, ...rest } = over;
    return {
      self: { pid: UPDATER, start: START }, liveness: live(alive), isProcessAlive: p => alive.has(p),
      proveWritersGone: () => ({ ok: true }), plistArgs,
      manager: {
        mainPid: () => { if (!o.service) return null; const r = readFleetLockRecord(home); return r && r.role === "fleet" && alive.has(r.pid) ? r.pid : null; },
        stop: () => { const r = readFleetLockRecord(home); if (r && r.role === "fleet") alive.delete(r.pid); calls.push("stop"); return true; },
        reload: () => { calls.push("reload"); return true; },
        // The pre-start step (or a detached spawn's environment) hands the nonce on; the started fleet takes fleet.lock over.
        start: handoff => {
          const fenceRec = readFleetLockRecord(home);
          if (fenceRec?.role !== "update" || fenceRec.handoff?.nonce !== handoff.nonce) return false;
          const pid = nextPid++; alive.add(pid); calls.push(`start:${handoff.gen}`);
          writeFileSync(join(home, "fleet.lock"), JSON.stringify({ pid, nonce: handoff.nonce, createdAt: new Date().toISOString(), role: "fleet" }) + "\n");
          return true;
        },
      },
      waitTakeover: nonce => { const r = readFleetLockRecord(home); return r?.role === "fleet" && r.nonce === nonce ? r.pid : null; },
      barrier: () => { calls.push("barrier"); return { ok: true }; },
      drain: () => { calls.push("drain"); return { ok: true }; },
      kit: { nodePath: fakeNode, bundlePath: bundle, runsAlone: () => true },
      install: () => {
        installPackage(o, "2.4.1");
        writeFileSync(join(home, "fleet.yaml"), "version: new\nmigrated: true\n");                     // the new version migrated it
        writeFileSync(join(home, "new-state.json"), "{}");
        calls.push("install"); return { ok: true };
      },
      live: () => ({ ownership: { ok: true, value: o }, tuple: { state: "complete", tuple: tupleOf(o, version()) } as TupleRead }),
      prove: pid => { calls.push(`prove:${pid}`); return { ok: true }; },
      commit: {
        leaveTrial: () => { calls.push("leave-trial"); return true; },
        startAgents: () => { calls.push("start-agents"); return true; },
        deliverInbox: () => { calls.push("deliver-inbox"); return true; },
        runDeferred: () => { calls.push("run-deferred"); return true; },
      },
      handBack: () => { calls.push("hand-back"); return true; },
      // A crashed process does nothing more: every later step throws too.
      io: { ...defaultJournalIo, step: () => {
        if (dead || (crashAt !== undefined && (!crashFrom || crashFrom()) && ++n === crashAt)) { dead = true; onCrash?.(); throw new Error(`crash at journal step ${crashAt}`); }
      } },
      ...rest,
    };
  };
  return { home, o, fragment, alive, calls, attempt: res.attempt, deps };
}

const endState = (w: World) => ({
  fleetYaml: readFileSync(join(w.home, "fleet.yaml"), "utf8"), newState: existsSync(join(w.home, "new-state.json")),
  version: JSON.parse(readFileSync(join(w.o.packagePath, "package.json"), "utf8")).version, unit: readFileSync(w.fragment, "utf8"),
  dropIn: w.o.service ? existsSync(dropInPath(w.o.service)) : false, journal: readCurrent(w.home).state, lockRole: readFleetLockRecord(w.home)?.role,
});
const gens = (a: AttemptRecord) => (a.fleets as FleetGeneration[]).map(g =>
  `${g.gen}:${g.dead && g.pid === undefined ? "voided" : `${g.consumed ? "acked" : "planned"}${g.dead ? ":dead" : ""}`}`);
const COMMITTED = { fleetYaml: "version: new\nmigrated: true\n", newState: true, version: "2.4.1", unit: UNIT, dropIn: false, journal: "none", lockRole: "fleet" };
const ROLLED_BACK = { fleetYaml: "version: old\n", newState: false, version: "2.4.0", unit: UNIT, dropIn: false, journal: "none", lockRole: "fleet" };


const UNIT_241 = "[Service]\nExecStart=/usr/bin/agend fleet start --since-2.4.1\n";
const GB = newAttemptId(new Date("2026-11-28T10:00:00Z"), "0bacc0de");
/** Every file under `dir`, with its sha256: the committed attempt's artifacts must not change by a byte. */
const treeHash = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => { for (const n of readdirSync(d)) { const p = join(d, n), r = rel ? `${rel}/${n}` : n; if (statSync(p).isDirectory()) walk(p, r); else out[r] = createHash("sha256").update(readFileSync(p)).digest("hex"); } };
  walk(dir, ""); return out;
};

/** 2.4.0 → 2.4.1 committed on a world whose home has a real outbox DB; then 2.4.1 runs and changes things. */
function committed(opts: Opts = {}) {
  const w = world(opts);
  const db = new Database(join(w.home, "delivery-outbox.db")); db.exec("CREATE TABLE marker(v TEXT); INSERT INTO marker VALUES ('before the update')"); db.close();
  const r = runUpdate(w.home, w.attempt, PLAN, w.deps());
  if (!r.ok) throw new Error(r.reason);
  writeFileSync(join(w.home, "after-commit.json"), "{\"new\":true}");                             // written by 2.4.1 after its commit
  writeFileSync(join(w.home, "fleet.yaml"), "version: new\nedited: later\n");
  if (w.o.service) writeFileSync(w.fragment, opts.launchd ? PLIST_241 : UNIT_241);                // 2.4.1 rewrote its unit
  return w;
}
const goBackInit = (w: World) => {
  const holder = readFleetLockRecord(w.home)!;                                                     // the 2.4.1 fleet
  return { id: GB, updater: { pid: UPDATER, start: START }, from: { name: "@songsid/agend", version: "2.4.1", integrity: null },
    extra: { ownership: w.o, expected: { old: tupleOf(w.o, "2.4.1") }, fleets: [{ gen: "old", nonce: holder.nonce, pid: holder.pid, plannedAt: new Date().toISOString(), consumed: true }] } };
};
interface GuardCall { liveDb: string; attemptId: string; committedAt: number; snapshotDb: string | null; existed: boolean; dirMode: number | null; sha: string | null }
const guardOf = (answers: boolean[]) => {
  const calls: GuardCall[] = [];
  const guard: GoBackGuard = (liveDb, attemptId, committedAt, snapshotDb) => {
    const existed = !!snapshotDb && existsSync(snapshotDb);
    calls.push({ liveDb, attemptId, committedAt, snapshotDb, existed, dirMode: snapshotDb ? statSync(join(snapshotDb, "..")).mode & 0o777 : null,
      sha: existed ? createHash("sha256").update(readFileSync(snapshotDb!)).digest("hex") : null });
    return answers[calls.length - 1] ?? true;
  };
  return { guard, calls };
};
const noNpm = { install: () => { throw new Error("npm must never run for a Go back"); } };

describe("M-3770 2.5: Go back, end to end on a scratch world", () => {
  it("the offer lists the committed update; Go back returns home, package and unit to 2.4.0, sets aside what changed since, commits and uses the entry", () => {
    const w = committed();
    const offer = readGoBackOffer(w.home);
    expect(offer.eligible.map(e => [e.attemptId, e.from, e.version])).toEqual([[ID, "2.4.0", "2.4.1"]]);
    expect(offer.latestDeadline).toBe(offer.eligible[0]!.expiresAt);
    const before = treeHash(attemptDir(w.home, ID)), preBefore = treeHash(join(w.o.prefix, ".agend-rollback", `attempt-${ID}`));
    const { guard, calls } = guardOf([true, true]);
    const r = runGoBack(w.home, ID, goBackInit(w), { ...w.deps(noNpm), guard });
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    expect(endState(w)).toEqual({ ...ROLLED_BACK });                                                 // 2.4.0's home, package and unit; route off
    expect(existsSync(join(w.home, "after-commit.json"))).toBe(false);
    expect(readFileSync(join(attemptDir(w.home, GB), "go-back", "replaced", "after-commit.json"), "utf8")).toBe("{\"new\":true}");   // set aside, named
    expect(readAttemptRecord(w.home, GB)).toMatchObject({ kind: "go-back", goBackOf: ID, stage: "committed", txProtocol: 1 });
    // The committed attempt's artifacts were only read.
    expect(treeHash(attemptDir(w.home, ID))).toEqual(before);
    expect(treeHash(join(w.o.prefix, ".agend-rollback", `attempt-${ID}`))).toEqual(preBefore);
    // Used, never offered again; the go-back itself is not go-back-able.
    const kept = readRetained(w.home);
    expect(kept.ok && kept.entries.map(e => [e.attemptId, e.used?.by ?? null])).toEqual([[ID, GB]]);
    expect(readGoBackOffer(w.home).eligible).toEqual([]);
    // The guard: asked twice, each with a private verified copy (0700, on the home's volume) that is gone afterwards.
    expect(calls.map(c => [c.liveDb, c.attemptId, c.committedAt, c.existed, c.dirMode])).toEqual([
      [join(w.home, "delivery-outbox.db"), ID, offer.eligible[0]!.committedAt, true, 0o700],
      [join(w.home, "delivery-outbox.db"), ID, offer.eligible[0]!.committedAt, true, 0o700],
    ]);
    for (const c of calls) { expect(c.snapshotDb!.startsWith(journalDir(w.home))).toBe(true); expect(existsSync(join(c.snapshotDb!, ".."))).toBe(false); }
    const committedDb = readFileSync(join(attemptDir(w.home, ID), "snapshot", "delivery-outbox.db"));
    expect(calls[0]!.sha).toBe(createHash("sha256").update(committedDb).digest("hex"));            // first: the committed snapshot's
    const goBackDb = readFileSync(join(attemptDir(w.home, GB), "snapshot", "delivery-outbox.db"));
    expect(calls[1]!.sha).toBe(createHash("sha256").update(goBackDb).digest("hex"));               // then: the fresh snapshot of now
  });

  it("the guard refuses before the attempt opens: nothing opened, nothing changed, the reason cached", () => {
    const w = committed();
    const { guard } = guardOf([false]);
    const r = runGoBack(w.home, ID, goBackInit(w), { ...w.deps(noNpm), guard });
    expect(r).toMatchObject({ ok: false, outcome: "refused", reason: expect.stringMatching(/turned on after this update/) });
    expect(readCurrent(w.home).state).toBe("none");
    expect(existsSync(attemptDir(w.home, GB))).toBe(false);
    expect(readFileSync(join(w.home, "fleet.yaml"), "utf8")).toBe("version: new\nedited: later\n");
    expect(readGoBackOffer(w.home).unavailable).toEqual([{ attemptId: ID, reason: expect.stringMatching(/turned on after this update/) }]);
  });

  it("a committed snapshot's outbox DB that doesn't match its manifest is never handed to the guard: refused", () => {
    const w = committed();
    writeFileSync(join(attemptDir(w.home, ID), "snapshot", "delivery-outbox.db"), "tampered");
    const { guard, calls } = guardOf([true, true]);
    const r = runGoBack(w.home, ID, goBackInit(w), { ...w.deps(noNpm), guard });
    expect(r).toMatchObject({ ok: false, outcome: "refused", reason: expect.stringMatching(/delivery-outbox\.db doesn't match its manifest/) });
    expect(calls).toEqual([]);
    expect(readdirSync(journalDir(w.home)).filter(n => n.startsWith("go-back-check-"))).toEqual([]);   // its copy removed
  });

  it("a guard that throws refuses (fail closed)", () => {
    const w = committed();
    const r = runGoBack(w.home, ID, goBackInit(w), { ...w.deps(noNpm), guard: () => { throw new Error("history unreadable"); } });
    expect(r).toMatchObject({ ok: false, outcome: "refused", reason: expect.stringMatching(/can't be read \(history unreadable\)/) });
    expect(readCurrent(w.home).state).toBe("none");
  });

  it("the guard refuses at snapshotted → installing (On changed meanwhile): rolled back to now, the entry still offered", () => {
    const w = committed();
    const { guard } = guardOf([true, false]);
    const r = runGoBack(w.home, ID, goBackInit(w), { ...w.deps(noNpm), guard });
    expect(r).toMatchObject({ ok: false, outcome: "rolled-back" });
    expect(readFileSync(join(w.home, "fleet.yaml"), "utf8")).toBe("version: new\nedited: later\n");
    expect(existsSync(join(w.home, "after-commit.json"))).toBe(true);
    expect(readFileSync(w.fragment, "utf8")).toBe(UNIT_241);
    expect(JSON.parse(readFileSync(join(w.o.packagePath, "package.json"), "utf8")).version).toBe("2.4.1");
    expect(readCurrent(w.home).state).toBe("none");
    expect(readGoBackOffer(w.home).eligible.map(e => e.attemptId)).toEqual([ID]);                   // not used
  });

  it("the offer refuses: expired, an old-protocol from-version, a missing snapshot, a used entry", () => {
    const w = committed();
    const offer = readGoBackOffer(w.home);
    expect(readGoBackOffer(w.home, offer.eligible[0]!.expiresAt + 1).unavailable[0]!.reason).toMatch(/window to 2\.4\.0 ended/);
    const path = join(journalDir(w.home), "retained.json"), original = readFileSync(path, "utf8");
    const edit = (f: (e: Record<string, unknown>) => void) => { const v = JSON.parse(original); f(v.entries[0]); writeFileSync(path, JSON.stringify(v)); };
    edit(e => { e.txProtocol = null; });
    expect(readGoBackOffer(w.home).unavailable[0]!.reason).toMatch(/predates this update transaction/);
    edit(e => { e.used = { by: "x", at: "y" }; });
    expect(readGoBackOffer(w.home).unavailable[0]!.reason).toMatch(/already used/);
    writeFileSync(path, original);
    const recordPath = join(attemptDir(w.home, ID), "attempt.json"), record = readFileSync(recordPath, "utf8");
    rmSync(join(attemptDir(w.home, ID), "snapshot.json"), { force: true });
    rmSync(join(attemptDir(w.home, ID), "manifest.json"), { force: true });
    const missing = readGoBackOffer(w.home);
    expect(missing.eligible).toEqual([]);
    expect(missing.unavailable[0]!.reason).toMatch(/snapshot from before the update/);
  });

  it("S-260: a launchd install goes back too — the job's plist returns to 2.4.0's through this attempt's wrapper, and the wrapper comes off at the commit", () => {
    const w = committed({ launchd: true });
    expect(readGoBackOffer(w.home).eligible.map(e => e.attemptId)).toEqual([ID]);                   // offered on launchd now
    const seen: string[] = [];
    const { guard } = guardOf([true, true]);
    const base = w.deps(noNpm);
    // What the plist says at each start (the pre-start step must guard every one of them: wrapped in THIS attempt's route).
    const r = runGoBack(w.home, ID, goBackInit(w), { ...base, guard, manager: { ...base.manager, start: handoff => { seen.push(readFileSync(w.fragment, "utf8")); return base.manager.start(handoff); } } });
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    expect(readFileSync(w.fragment, "utf8")).toBe(PLIST_240);                                       // 2.4.0's plist, route off
    expect(JSON.parse(readFileSync(join(w.o.packagePath, "package.json"), "utf8")).version).toBe("2.4.0");
    expect(seen.length).toBeGreaterThan(0);
    const trialStart = seen.at(-1)!;
    expect(trialStart).toContain("agend-update-recovery");
    expect(trialStart).toContain(GB);                                                               // this Go back's route
    expect(plistArgs(trialStart)!.slice(-3)).toEqual(["/usr/local/bin/agend", "fleet", "start"]);   // around 2.4.0's arguments
    expect(readAttemptRecord(w.home, GB)).toMatchObject({ kind: "go-back", stage: "committed" });
  });

  it("S-260: a committed Go back's still-loaded job (its wrapper around 2.4.0's arguments) reads as the fleet; anything else stays unknown", () => {
    const w = committed({ launchd: true });
    const { guard } = guardOf([true, true]);
    expect(runGoBack(w.home, ID, goBackInit(w), { ...w.deps(noNpm), guard }).ok).toBe(true);
    const deps = { verifyKit: () => true, plistArgs };
    const wrapperOf = (id: string, args: string[]) => plistArgs(wrapPlist(plistOf(args), w.home, id, args)!)!;
    expect(unwrapRecoveryRoute(wrapperOf(GB, ["/usr/local/bin/agend", "fleet", "start"]), w.home, deps)).toEqual(["/usr/local/bin/agend", "fleet", "start"]);
    expect(unwrapRecoveryRoute(wrapperOf(GB, ["/usr/local/bin/agend", "fleet", "start", "--since-2.4.1"]), w.home, deps)).toBeNull();   // its own preimage's: not what it returned to
    expect(unwrapRecoveryRoute(wrapperOf(GB, ["/usr/local/bin/other", "fleet", "start"]), w.home, deps)).toBeNull();
  });

  it("S-260: a launchd Go back refused at its second check rolls back to now: the plist is 2.4.1's again, route off", () => {
    const w = committed({ launchd: true });
    const { guard } = guardOf([true, false]);
    const r = runGoBack(w.home, ID, goBackInit(w), { ...w.deps(noNpm), guard });
    expect(r).toMatchObject({ ok: false, outcome: "rolled-back" });
    expect(readFileSync(w.fragment, "utf8")).toBe(PLIST_241);
    // A Go back that didn't commit wraps its own preimage (2.4.1's): only that reads as the fleet, never 2.4.0's.
    const deps = { verifyKit: () => true, plistArgs };
    const wrapperOf = (args: string[]) => plistArgs(wrapPlist(plistOf(args), w.home, GB, args)!)!;
    expect(unwrapRecoveryRoute(wrapperOf(["/usr/local/bin/agend", "fleet", "start", "--since-2.4.1"]), w.home, deps)).toEqual(["/usr/local/bin/agend", "fleet", "start", "--since-2.4.1"]);
    expect(unwrapRecoveryRoute(wrapperOf(["/usr/local/bin/agend", "fleet", "start"]), w.home, deps)).toBeNull();
  });

  it("Fable #4565 (a): removing a Go back's route is bound to its outcome — committed: only the target's wrapper; otherwise only its own", () => {
    const ARGS_240 = ["/usr/local/bin/agend", "fleet", "start"], ARGS_241 = [...ARGS_240, "--since-2.4.1"];
    const wrapper = (home: string, args: string[]) => wrapPlist(plistOf(args), home, GB, args)!;
    // Rolled back, the file still the wrapper around 2.4.0's (the restore of its own marked done before a crash): left as it is.
    const r = committed({ launchd: true });
    expect(runGoBack(r.home, ID, goBackInit(r), { ...r.deps(noNpm), guard: guardOf([true, false]).guard })).toMatchObject({ outcome: "rolled-back" });
    const rolled = readAttemptRecord(r.home, GB)!;
    writeFileSync(r.fragment, wrapper(r.home, ARGS_240));
    expect(removeRecoveryRoute(r.home, rolled, { plistArgs })).toMatchObject({ ok: false, reason: expect.stringContaining("isn't this route's wrapper any more") });
    expect(readFileSync(r.fragment, "utf8")).toBe(wrapper(r.home, ARGS_240));
    writeFileSync(r.fragment, wrapper(r.home, ARGS_241));                                          // its own: comes off to 2.4.1's
    expect(removeRecoveryRoute(r.home, rolled, { plistArgs })).toMatchObject({ ok: true });
    expect(readFileSync(r.fragment, "utf8")).toBe(PLIST_241);
    // Committed, the file the wrapper around its OWN preimage (2.4.1's): left; around the target's: comes off to 2.4.0's.
    const c = committed({ launchd: true });
    expect(runGoBack(c.home, ID, goBackInit(c), { ...c.deps(noNpm), guard: guardOf([true, true]).guard }).ok).toBe(true);
    const done = readAttemptRecord(c.home, GB)!;
    writeFileSync(c.fragment, wrapper(c.home, ARGS_241));
    expect(removeRecoveryRoute(c.home, done, { plistArgs })).toMatchObject({ ok: false });
    expect(readFileSync(c.fragment, "utf8")).toBe(wrapper(c.home, ARGS_241));
    writeFileSync(c.fragment, wrapper(c.home, ARGS_240));
    expect(removeRecoveryRoute(c.home, done, { plistArgs })).toMatchObject({ ok: true });
    expect(readFileSync(c.fragment, "utf8")).toBe(PLIST_240);
  });

  it("a detached install (no service) goes back too: no unit is touched", () => {
    const w = committed({ noService: true });
    const { guard } = guardOf([true, true]);
    const r = runGoBack(w.home, ID, goBackInit(w), { ...w.deps(noNpm), guard });
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    expect(JSON.parse(readFileSync(join(w.o.packagePath, "package.json"), "utf8")).version).toBe("2.4.0");
    expect(readFileSync(join(w.home, "fleet.yaml"), "utf8")).toBe("version: old\n");
  });
});

describe("M-3770 2.5: what Go back sets aside", () => {
  it("names the top-level entries changed, added or gone since the committed snapshot; hashes only same-size files, once per (path, size, mtime)", async () => {
    const w = committed();
    const snapshotDir = attemptDir(w.home, ID);
    const cache = new Map<string, string>();
    const first = goBackChanges(w.home, snapshotDir, cache);
    expect(first).toEqual({ ok: true, changed: ["after-commit.json", "fleet.yaml", "new-state.json"] });
    const hashed = cache.size;
    expect(hashed).toBeGreaterThan(0);                                                              // the same-size ones (the outbox DB)
    // The cache is read, not recomputed: a poisoned entry is believed (so nothing was hashed again).
    for (const k of cache.keys()) cache.set(k, "poisoned");
    expect(goBackChanges(w.home, snapshotDir, cache)).toEqual({ ok: true, changed: ["after-commit.json", "delivery-outbox.db", "fleet.yaml", "new-state.json"] });
    expect(cache.size).toBe(hashed);
    // A same-size edit is found by its hash.
    const db = join(w.home, "delivery-outbox.db"), bytes = readFileSync(db);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff; writeFileSync(db, bytes);
    expect(goBackChanges(w.home, snapshotDir, new Map())).toEqual({ ok: true, changed: ["after-commit.json", "delivery-outbox.db", "fleet.yaml", "new-state.json"] });
  });
});

describe("M-3770 2.5: Go back review (Fable #4547)", () => {
  it("F1: a guard that throws refuses this time only — the offer stays, and the next Go back goes through; a guard's false is cached", () => {
    const w = committed();
    let calls = 0;
    const flaky: GoBackGuard = () => { calls += 1; if (calls === 1) throw new Error("database is locked"); return true; };
    const first = runGoBack(w.home, ID, goBackInit(w), { ...w.deps(noNpm), guard: flaky });
    expect(first).toMatchObject({ ok: false, outcome: "refused", reason: expect.stringMatching(/database is locked/) });
    expect(readGoBackOffer(w.home).eligible.map(e => e.attemptId)).toEqual([ID]);                   // not cached
    const kept = readRetained(w.home);
    expect(kept.ok && kept.entries[0]!.unavailable).toBeUndefined();
    const second = runGoBack(w.home, ID, goBackInit(w), { ...w.deps(noNpm), guard: flaky });
    expect(second.ok, second.ok ? "" : second.reason).toBe(true);
  });

  it("F2: with two retained updates, only the one that made the installed version current is offered; a Go back makes the older one current; nothing once the installed version moves past", () => {
    const w = committed();                                                                          // A: 2.4.0 → 2.4.1
    const B = newAttemptId(new Date("2026-11-27T12:00:00Z"), "0b0b0b0b");
    const holder = readFleetLockRecord(w.home)!;
    const opened = openAttempt(w.home, { id: B, kind: "update", updater: { pid: UPDATER, start: START },
      from: { name: "@songsid/agend", version: "2.4.1", integrity: null }, to: { name: "@songsid/agend", version: "2.4.2", integrity: null },
      extra: { ownership: w.o, expected: { old: tupleOf(w.o, "2.4.1") }, fleets: [{ gen: "old", nonce: holder.nonce, pid: holder.pid, plannedAt: new Date().toISOString(), consumed: true }] } });
    if (!opened.ok) throw new Error(opened.reason);
    const r = runUpdate(w.home, opened.attempt, { target: { name: "@songsid/agend", version: "2.4.2", integrity: null }, command: ["npm", "i"] },
      w.deps({ install: () => { installPackage(w.o, "2.4.2"); return { ok: true }; } }));
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);                                                  // B: 2.4.1 → 2.4.2
    const offer = readGoBackOffer(w.home);
    expect(offer.eligible.map(e => [e.attemptId, e.from])).toEqual([[B, "2.4.1"]]);
    expect(offer.unavailable).toEqual([{ attemptId: ID, reason: "AgEnD 2.4.2 is installed now, not 2.4.1: Go back only returns one step" }]);
    // Go back B → 2.4.1: B used, and now A (which made 2.4.1 current) is the one step back.
    const holder2 = readFleetLockRecord(w.home)!;
    const init = { id: newAttemptId(new Date("2026-11-28T11:00:00Z"), "0c0c0c0c"), updater: { pid: UPDATER, start: START }, from: { name: "@songsid/agend", version: "2.4.2", integrity: null },
      extra: { ownership: w.o, expected: { old: tupleOf(w.o, "2.4.2") }, fleets: [{ gen: "old", nonce: holder2.nonce, pid: holder2.pid, plannedAt: new Date().toISOString(), consumed: true }] } };
    const back = runGoBack(w.home, B, init, { ...w.deps(noNpm), guard: () => true });
    expect(back.ok, back.ok ? "" : back.reason).toBe(true);
    expect(readGoBackOffer(w.home).eligible.map(e => [e.attemptId, e.from])).toEqual([[ID, "2.4.0"]]);
    // The installed version moves past (an update outside these entries): nothing is offered.
    installPackage(w.o, "2.4.3");
    expect(readGoBackOffer(w.home).eligible).toEqual([]);
  });

  it("F2: two unused entries that both made the installed version current (an ordinary downgrade later): only the newest is the one step back", () => {
    const w = committed();
    const path = join(journalDir(w.home), "retained.json");
    const v = JSON.parse(readFileSync(path, "utf8"));
    const later = { ...v.entries[0], attemptId: newAttemptId(new Date("2026-11-29T09:00:00Z"), "0d0d0d0d"), from: "2.4.2",
      committedAt: new Date(Date.parse(v.entries[0].committedAt) + 60_000).toISOString() };
    writeFileSync(path, JSON.stringify({ ...v, entries: [...v.entries, later] }));                // e.g. 2.4.2 → 2.4.1 by an ordinary update
    const offer = readGoBackOffer(w.home);
    expect(offer.eligible).toEqual([]);                                                            // the newest's own record isn't there: not offered
    expect(offer.unavailable).toEqual([
      { attemptId: ID, reason: `a later update (${later.attemptId}) made 2.4.1 current again: Go back only returns one step` },
      { attemptId: later.attemptId, reason: "the update to 2.4.1 isn't recorded as committed" },
    ]);
  });
});
