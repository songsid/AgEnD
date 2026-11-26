// M-3770 slice 2.5 (S-252 part 3): the update driven forward on a scratch home, prefix and unit — opened to committed,
// and its two ways back: abandon before the snapshot (the old fleet restarted as generation old, the held work handed
// back, the route off) and the rollback after it. The service manager, the fleets, npm and the trial's proof are
// stand-ins: no real fleet, no systemctl, no npm.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFleetLockRecord } from "../src/fleet-lock.js";
import type { ArtifactTuple, Ownership, TupleRead } from "../src/install-ownership.js";
import { defaultJournalIo, finishClosing, newAttemptId, openAttempt, readCurrent, readMarks, type AttemptRecord, type FleetGeneration, type JournalIo } from "../src/update-journal.js";
import { abandonAttempt, commitAttempt, runUpdate, type UpdateDeps } from "../src/update-forward.js";
import { readRetained } from "../src/update-retained.js";
import { dropInPath } from "../src/update-recovery/route.js";
import { parsePlist } from "../src/service-activation.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "forward-")); dirs.push(d); return d; };
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

interface Opts { noFleet?: boolean; noService?: boolean }
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
  const fragment = join(root, "agend.service"); writeFileSync(fragment, UNIT);
  const o: Ownership = { uid: 1000, home, prefix, packagePath: join(prefix, "lib", "node_modules", "@songsid", "agend"),
    binLinks: { agend: join(prefix, "bin", "agend"), "agend-agent": join(prefix, "bin", "agend-agent") },
    service: opts.noService ? null : { kind: "systemd", unit: "agend.service", fragmentPath: fragment } };
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

describe("M-3770 2.5: the update, forward to committed", () => {
  it("barrier, the old fleet stopped and fenced, drained, snapshotted, installed, the trial taken over and proven, committed", () => {
    const w = world();
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps());
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    expect(endState(w)).toEqual(COMMITTED);
    expect(w.alive.has(OLD)).toBe(false);
    const trialPid = readFleetLockRecord(w.home)!.pid;
    expect(w.calls).toEqual(["barrier", "reload", "stop", "drain", "install", "start:trial", `prove:${trialPid}`, "reload", "leave-trial", "start-agents", "deliver-inbox", "run-deferred"]);
    expect(r.attempt.stage).toBe("committed");
    expect(gens(r.attempt)).toEqual(["old:acked:dead", "trial:acked"]);
    expect(r.attempt.history.filter(h => h.stage === "committing" && h.substep).map(h => h.substep)).toEqual(["retained", "route-removed", "left-trial", "agents-started", "inbox-delivered", "deferred-run"]);
    const kept = readRetained(w.home);
    expect(kept.ok && kept.entries.map(e => [e.attemptId, e.from, e.version, e.unitPreimage !== null])).toEqual([[ID, "2.4.0", "2.4.1", true]]);
    expect(kept.ok && Date.parse(kept.entries[0]!.expiresAt) - Date.parse(kept.entries[0]!.committedAt)).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("no fleet ran when it opened (detached, no service): the fence is taken afresh, and the trial is spawned with its nonce", () => {
    const w = world({ noFleet: true, noService: true });
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps());
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    expect(endState(w)).toEqual(COMMITTED);
    expect(w.calls).not.toContain("stop");
    expect(w.calls).not.toContain("reload");
    expect(gens(r.attempt)).toEqual(["trial:acked"]);
    const kept = readRetained(w.home);
    expect(kept.ok && kept.entries[0]!.unitPreimage).toBeNull();
  });

  it("a crash at every journal write in committing: commitAttempt resumes it to the same end state, never rolling back", () => {
    for (let at = 1; ; at++) {
      const w = world();
      let armed = false;
      let crashed = false;
      const crashing = w.deps({ crashAt: at, crashFrom: () => armed, onCrash: () => { crashed = true; }, prove: () => { armed = true; return { ok: true }; } });
      try { runUpdate(w.home, w.attempt, PLAN, crashing); } catch { /* the process died */ }
      if (!crashed) { expect(at).toBeGreaterThan(8); expect(endState(w)).toEqual(COMMITTED); break; }
      const read = readCurrent(w.home);
      if (read.state === "none") { /* the crash came after current was cleared: done */ }
      else if (read.state === "closing") finishClosing(w.home, read.attempt);
      else if (read.state === "open" && read.attempt.stage === "committing") {
        const r = commitAttempt(w.home, read.attempt, w.deps());
        expect(r.ok, `crash at ${at}: ${r.ok ? "" : r.reason}`).toBe(true);
      } else {
        // The crash landed inside the write to committing: the journal still reads proving (the runner rolls that back).
        expect(read.state === "open" && read.attempt.stage, `crash at ${at}`).toBe("proving");
        continue;
      }
      expect(endState(w), `crash at ${at}`).toEqual(COMMITTED);
      const kept = readRetained(w.home);
      expect(kept.ok && kept.entries.length, `crash at ${at}`).toBe(1);
    }
  }, 60_000);                                                                        // ~40 whole updates on disk

  it("a commit step that fails leaves the attempt committing, and a later run finishes it without repeating the steps done", () => {
    const w = world();
    let fails = true;
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps({ commit: { leaveTrial: () => true, startAgents: () => !fails, deliverInbox: () => true, runDeferred: () => true } }));
    expect(r.ok === false && r.outcome).toBe("retry");
    expect(readCurrent(w.home).state).toBe("open");
    fails = false;
    const left: string[] = [];
    const again = commitAttempt(w.home, r.attempt, w.deps({ commit: { leaveTrial: () => { left.push("leave"); return true; }, startAgents: () => true, deliverInbox: () => true, runDeferred: () => true } }));
    expect(again.ok).toBe(true);
    expect(left).toEqual([]);                                                        // left-trial was done; not repeated
    expect(endState(w)).toEqual(COMMITTED);
  });
});

describe("M-3770 2.5: abandon before the snapshot", () => {
  it("the barrier finds the fleet busy: abandoned with the old fleet never stopped, the held work handed back, no route written", () => {
    const w = world();
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps({ barrier: () => ({ ok: false, reason: "fleet was not idle" }) }));
    expect(r.ok === false && r.outcome).toBe("abandoned");
    expect(w.alive.has(OLD)).toBe(true);
    expect(readFleetLockRecord(w.home)).toMatchObject({ pid: OLD, nonce: OLD_NONCE, role: "fleet" });
    expect(w.calls).toEqual(["hand-back"]);
    expect(r.attempt.history.filter(h => h.stage === "abandoning" && h.substep).map(h => h.substep)).toEqual(["restart-old", "hand-back"]);
    expect({ ...endState(w), lockRole: undefined }).toEqual({ ...ROLLED_BACK, lockRole: undefined });
  });

  it("the drain fails after the old fleet stopped: it is restarted as generation old from the fence, the work handed back, the route off", () => {
    const w = world();
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps({ drain: () => ({ ok: false, reason: "a CLI writer held the state lease for 60 s" }) }));
    expect(r.ok === false && r.outcome).toBe("abandoned");
    expect(r.ok === false && r.reason).toMatch(/state lease/);
    expect(w.calls).toEqual(["barrier", "reload", "stop", "start:old", "hand-back", "reload"]);
    expect(gens(r.attempt)).toEqual(["old:acked:dead", "old:acked"]);
    expect(endState(w)).toEqual(ROLLED_BACK);
    expect(readMarks(w.home)).toEqual({ ok: true, marks: [] });                       // abandon marks nothing
  });

  it("the snapshot fails (a writer still present): abandoned before anything is installed, the old fleet restarted", () => {
    const w = world();
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps({ proveWritersGone: () => ({ ok: false, reason: "pid 777 has fleet.yaml open" }) }));
    expect(r.ok === false && r.outcome).toBe("abandoned");
    expect(r.ok === false && r.reason).toMatch(/the snapshot failed: .*pid 777/);
    expect(w.calls).not.toContain("install");
    expect(gens(r.attempt)).toEqual(["old:acked:dead", "old:acked"]);
    expect(endState(w)).toEqual(ROLLED_BACK);
  });

  it("no fleet ran, and the drain fails: the fence is released, nothing is started", () => {
    const w = world({ noFleet: true });
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps({ drain: () => ({ ok: false, reason: "busy" }) }));
    expect(r.ok === false && r.outcome).toBe("abandoned");
    expect(existsSync(join(w.home, "fleet.lock"))).toBe(false);
    expect(w.calls.filter(c => c.startsWith("start"))).toEqual([]);
    expect(readCurrent(w.home).state).toBe("none");
  });

  it("hand-back fails: the attempt stays abandoning (retryable), and a later run finishes it without restarting the old fleet again", () => {
    const w = world();
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps({ drain: () => ({ ok: false, reason: "busy" }), handBack: () => false }));
    expect(r.ok === false && r.outcome).toBe("retry");
    expect(readCurrent(w.home).state).toBe("open");
    const again = abandonAttempt(w.home, r.attempt, w.deps(), "busy");
    expect(again.ok === false && again.outcome).toBe("abandoned");
    expect(w.calls.filter(c => c === "start:old")).toHaveLength(1);
    expect(endState(w)).toEqual(ROLLED_BACK);
  });

  it("the old fleet's restart takes fleet.lock over after the wait gave up: retryable, and the next run acknowledges it, not a second start", () => {
    const w = world();
    const base = w.deps();
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps({ drain: () => ({ ok: false, reason: "busy" }), waitTakeover: () => null }));
    expect(r.ok === false && r.outcome).toBe("retry");
    expect(r.ok === false && r.reason).toMatch(/old generation didn't take fleet\.lock over in time/);
    const again = abandonAttempt(w.home, r.attempt, base, "busy");
    expect(again.ok === false && again.outcome).toBe("abandoned");
    expect(gens(again.attempt)).toEqual(["old:acked:dead", "old:acked"]);
    expect(w.calls.filter(c => c === "start:old")).toHaveLength(1);
    expect(endState(w)).toEqual(ROLLED_BACK);
  });

  it("the old fleet runs without holding fleet.lock: abandoned, nothing stopped", () => {
    const w = world();
    rmSync(join(w.home, "fleet.lock"));
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps());
    expect(r.ok === false && r.outcome).toBe("manual");                               // abandon then finds no fleet.lock for a recorded fleet
    expect(r.ok === false && r.reason).toMatch(/fleet\.lock is gone, but the old fleet was recorded running/);
    expect(w.calls).not.toContain("stop");
    expect(w.alive.has(OLD)).toBe(true);
  });
});

describe("M-3770 2.5: rolled back after the snapshot", () => {
  it("the install fails: rolled back — the home, the package and the unit as before, the old version running, 2.4.1 marked", () => {
    const w = world();
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps({ install: () => { installPackage(w.o, "2.4.1"); writeFileSync(join(w.home, "new-state.json"), "{}"); return { ok: false, reason: "npm exited 1" }; } }));
    expect(r.ok === false && r.outcome).toBe("rolled-back");
    expect(r.ok === false && r.reason).toMatch(/the install failed: npm exited 1/);
    expect(endState(w)).toEqual(ROLLED_BACK);
    expect(readMarks(w.home)).toMatchObject({ ok: true, marks: [{ version: "2.4.1", attemptId: ID }] });
  });

  it("the install leaves a partial package: rolled back", () => {
    const w = world();
    const base = w.deps();
    let installed = false;
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps({
      install: () => { installed = true; installPackage(w.o, "2.4.1"); return { ok: true }; },
      live: () => (installed ? { ownership: { ok: true, value: w.o }, tuple: { state: "partial", reason: "no dist/cli.js", paths: [], interpreter: "/n", execStart: null, unresolved: [] } } : base.live()),
    }));
    expect(r.ok === false && r.reason).toMatch(/partial package \(no dist\/cli\.js\)/);
    expect(endState(w)).toEqual(ROLLED_BACK);
  });

  it("the install puts another version in place: rolled back", () => {
    const w = world();
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps({ install: () => { installPackage(w.o, "2.4.2"); return { ok: true }; } }));
    expect(r.ok === false && r.reason).toMatch(/put 2\.4\.2 in place, not 2\.4\.1/);
    expect(endState(w)).toEqual(ROLLED_BACK);
  });

  it("the trial never takes fleet.lock over: rolled back (the trial's plan revoked, the rollback generation started)", () => {
    const w = world();
    const base = w.deps();
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps({ manager: { ...base.manager, start: h => (h.gen === "trial" ? (w.calls.push("start:trial"), true) : base.manager.start(h)) } }));
    expect(r.ok === false && r.outcome).toBe("rolled-back");
    expect(r.ok === false && r.reason).toMatch(/trial fleet didn't come up/);
    expect(gens(r.attempt)).toEqual(["old:acked:dead", "trial:voided", "rollback:acked"]);
    expect(endState(w)).toEqual(ROLLED_BACK);
    expect(w.calls.slice(w.calls.indexOf("start:trial") + 1, w.calls.indexOf("start:trial") + 2)).toEqual(["stop"]);   // a late start stopped first
  });

  it("the trial takes fleet.lock over late, after the wait gave up, and still runs: it is acknowledged, stopped as the trial, rolled back", () => {
    const w = world();
    const base = w.deps();
    let stops = 0, trialNonce = "";
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps({
      waitTakeover: nonce => (nonce === trialNonce ? null : base.waitTakeover(nonce)),                // the trial's takeover lands after the wait
      manager: { ...base.manager,
        start: h => { if (h.gen === "trial") trialNonce = h.nonce; return base.manager.start(h); },
        stop: () => (++stops === 2 ? true : base.manager.stop()) },                                     // the forward driver's own stop misses it
    }));
    expect(r.ok === false && r.outcome, r.ok ? "" : r.reason).toBe("rolled-back");
    expect(gens(r.attempt)).toEqual(["old:acked:dead", "trial:acked:dead", "rollback:acked"]);
    expect(endState(w)).toEqual(ROLLED_BACK);
  });

  it("the trial doesn't prove itself: its fleet stopped, rolled back", () => {
    const w = world();
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps({ prove: () => ({ ok: false, reason: "the web UI never answered" }) }));
    expect(r.ok === false && r.outcome).toBe("rolled-back");
    expect(gens(r.attempt)).toEqual(["old:acked:dead", "trial:acked:dead", "rollback:acked"]);
    expect(endState(w)).toEqual(ROLLED_BACK);
    expect(w.calls.filter(c => c === "stop")).toHaveLength(2);                       // the old fleet, then the trial
  });

  it("the live identity stops matching after the install: manual-recovery, nothing rolled back", () => {
    const w = world();
    const base = w.deps();
    let n = 0;
    const r = runUpdate(w.home, w.attempt, PLAN, w.deps({ live: () => (++n >= 4 ? { ...base.live(), ownership: { ok: false, reason: "the prefix moved" } } : base.live()) }));
    expect(r.ok === false && r.outcome).toBe("manual");
    expect(r.attempt.stage).toBe("manual-recovery");
    expect(readCurrent(w.home).state).toBe("manual");
  });
});
