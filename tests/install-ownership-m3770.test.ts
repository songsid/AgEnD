// M-3770 slice 2.1b part 2 (design update-transaction §3.1–3.3): ownership proven and re-proven, the per-stage
// expected tuples (old, new, the install intent's partial), the journaled identity's validation, and which fleet
// generation may be stopped — on a real temp prefix with real symlinks.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkStage, fsOwnershipDeps, identityOf, openingIdentity, proveOwnership, readArtifactTuple, recordExpectedNew, recordInstallIntent, stopTarget,
  type ArtifactTuple, type InstallIntent, type OwnedService, type OwnershipDeps,
} from "../src/install-ownership.js";
import { ackGeneration, advance, newAttemptId, openAttempt, planGeneration, readCurrent, type AttemptRecord, type Stage } from "../src/update-journal.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ID = newAttemptId(new Date("2026-11-26T05:00:00Z"), "1a2b3c4d");
const NODE = "/opt/node22/bin/node";
const EXEC = ["/usr/bin/agend", "fleet", "start"];
const NONCE = "c".repeat(32), TRIAL = "f".repeat(32);

interface Rig { root: string; home: string; prefix: string; pkg: string; unit: string; deps: OwnershipDeps; service: OwnedService; exec: { argv: string[] | null }; node: { path: string | null } }

function rig(): Rig {
  const root = mkdtempSync(join(tmpdir(), "own-")); dirs.push(root);
  const home = join(root, "home"), prefix = join(root, "prefix"), pkg = join(prefix, "lib", "node_modules", "@songsid", "agend");
  mkdirSync(home); mkdirSync(join(prefix, "bin"), { recursive: true });
  const unit = join(root, "agend.service"); writeFileSync(unit, "[Service]\nExecStart=/usr/bin/agend fleet start\n");
  install(pkg, prefix, "2.4.0", "sha512-old");
  const exec = { argv: EXEC as string[] | null }, node = { path: NODE as string | null };
  const deps = fsOwnershipDeps({ interpreterOf: () => node.path, execStart: () => exec.argv });
  return { root, home, prefix, pkg, unit, deps, service: { kind: "systemd", unit: "agend.service", fragmentPath: unit }, exec, node };
}

function install(pkg: string, prefix: string, version: string, integrity: string | null) {
  rmSync(pkg, { recursive: true, force: true });
  mkdirSync(join(pkg, "dist"), { recursive: true }); mkdirSync(join(pkg, "launcher"));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@songsid/agend", version }));
  writeFileSync(join(pkg, "dist", "cli.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(pkg, "launcher", "agend"), "#!/bin/sh\n"); writeFileSync(join(pkg, "launcher", "agend-agent"), "#!/bin/sh\n");
  for (const name of ["agend", "agend-agent"]) { rmSync(join(prefix, "bin", name), { force: true }); symlinkSync(join(pkg, "launcher", name), join(prefix, "bin", name)); }
  writeFileSync(join(prefix, "lib", "node_modules", ".package-lock.json"), JSON.stringify({ packages: { "node_modules/@songsid/agend": integrity ? { integrity } : {} } }));
}

const prove = (r: Rig) => proveOwnership({ home: r.home, prefix: r.prefix, service: r.service }, r.deps);
const tupleOf = (r: Rig): ArtifactTuple => {
  const own = prove(r); if (!own.ok) throw new Error(own.reason);
  const t = readArtifactTuple(own.value, r.deps); if (t.state !== "complete") throw new Error(t.reason);
  return t.tuple;
};
const live = (r: Rig) => { const ownership = prove(r); return { ownership, tuple: ownership.ok ? readArtifactTuple(ownership.value, r.deps) : { state: "partial" as const, reason: "-", paths: [], interpreter: null, execStart: null } }; };

function opened(r: Rig, oldFleet: { pid: number; nonce: string } | null = { pid: 4100, nonce: NONCE }): AttemptRecord {
  const own = prove(r); if (!own.ok) throw new Error(own.reason);
  const res = openAttempt(r.home, { id: ID, kind: "update", updater: { pid: 4242, start: { processStart: "x" } },
    from: { name: "@songsid/agend", version: "2.4.0", integrity: "sha512-old" }, to: { name: "@songsid/agend", version: "2.4.1", integrity: "sha512-new" },
    extra: openingIdentity(own.value, tupleOf(r), oldFleet, new Date()) });
  if (!res.ok) throw new Error(res.reason);
  return res.attempt;
}
const walk = (r: Rig, a: AttemptRecord, stages: Stage[]) => stages.reduce((acc, s) => advance(r.home, acc, s), a);
const intentOf = (r: Rig): InstallIntent => ({ preimage: { dir: join(r.home, "pre"), manifestSha256: "e".repeat(64) },
  destination: { packagePath: r.pkg, binLinks: [join(r.prefix, "bin", "agend"), join(r.prefix, "bin", "agend-agent")] },
  target: { name: "@songsid/agend", version: "2.4.1", integrity: "sha512-new" }, command: ["npm", "install", "-g", "@songsid/agend@2.4.1"] });

describe("M-3770 §3.1: ownership", () => {
  it("is proven as realpaths: home, prefix, the package PATH (not its contents), the unit's fragment", () => {
    const r = rig();
    const own = prove(r);
    expect(own).toEqual({ ok: true, value: { uid: process.getuid!(), home: r.home, prefix: r.prefix, packagePath: r.pkg, service: { kind: "systemd", unit: "agend.service", fragmentPath: r.unit } } });
    rmSync(r.pkg, { recursive: true });
    expect(prove(r).ok).toBe(true);                                                                   // contents are the tuple's question
  });

  it("can't be proven without a home, a prefix or the unit's fragment, or for another user's prefix", () => {
    const r = rig();
    expect(proveOwnership({ home: join(r.root, "nope"), prefix: r.prefix, service: null }, r.deps)).toMatchObject({ ok: false, reason: expect.stringMatching(/home/) });
    expect(proveOwnership({ home: r.home, prefix: join(r.root, "nope"), service: null }, r.deps)).toMatchObject({ ok: false, reason: expect.stringMatching(/prefix/) });
    expect(proveOwnership({ home: r.home, prefix: r.prefix, service: { ...r.service, fragmentPath: join(r.root, "gone.service") } }, r.deps)).toMatchObject({ ok: false, reason: expect.stringMatching(/definition/) });
    const other = { ...r.deps, uid: () => 4321, ownerUid: () => 1234 };
    expect(proveOwnership({ home: r.home, prefix: r.prefix, service: null }, other)).toMatchObject({ ok: false, reason: expect.stringMatching(/belongs to uid 1234/) });
  });

  it("a mismatch abandons before installing and goes to manual-recovery from installing on", () => {
    const r = rig();
    let a = walk(r, opened(r), ["barrier"]);
    const moved = { ...r.deps, realpath: (p: string) => (p === r.unit ? join(r.root, "elsewhere.service") : r.deps.realpath(p)) };
    const own = proveOwnership({ home: r.home, prefix: r.prefix, service: r.service }, moved);
    expect(checkStage(a, { ownership: own, tuple: live(r).tuple })).toEqual({ ok: false, to: "abandon", reason: "ownership changed (service.fragmentPath)" });
    a = walk(r, a, ["stopping", "snapshotted", "installing"]);
    expect(checkStage(a, { ownership: own, tuple: live(r).tuple })).toMatchObject({ ok: false, to: "manual-recovery" });
    expect(checkStage(a, { ownership: { ok: false, reason: "home gone" }, tuple: live(r).tuple })).toMatchObject({ ok: false, to: "manual-recovery", reason: expect.stringMatching(/can't be proven/) });
  });
});

describe("M-3770 §3.2: expected tuples per stage", () => {
  it("reads the live tuple: version, the hidden lockfile's integrity, both bins, entry, Node, ExecStart", () => {
    const r = rig();
    expect(tupleOf(r)).toEqual({ version: "2.4.0", integrity: "sha512-old", entry: join(r.pkg, "dist", "cli.js"), interpreter: NODE, execStart: EXEC,
      bins: { agend: join(r.pkg, "launcher", "agend"), "agend-agent": join(r.pkg, "launcher", "agend-agent") } });
  });

  it("before installing: only old; trial/proving/committing: only new", () => {
    const r = rig();
    let a = walk(r, opened(r), ["barrier", "stopping", "snapshotted"]);
    expect(checkStage(a, live(r))).toEqual({ ok: true, found: "old" });
    r.exec.argv = ["/usr/bin/agend", "fleet", "start", "--direct"];
    expect(checkStage(a, live(r))).toMatchObject({ ok: false, to: "abandon", reason: expect.stringMatching(/expected.old/) });
    r.exec.argv = EXEC;
    a = advance(r.home, a, "installing");
    a = recordInstallIntent(r.home, a, intentOf(r));
    install(r.pkg, r.prefix, "2.4.1", "sha512-new");
    a = recordExpectedNew(r.home, a, tupleOf(r));
    a = advance(r.home, a, "trial");
    expect(checkStage(a, live(r))).toEqual({ ok: true, found: "new" });
    install(r.pkg, r.prefix, "2.4.0", "sha512-old");                                                   // put back under a trial: not what trial expects
    expect(checkStage(a, live(r))).toMatchObject({ ok: false, to: "manual-recovery", reason: expect.stringMatching(/expected.new.*2\.4\.0/) });
  });

  it("installing: old, new, or partial INSIDE the intent's destination; outside it, or no intent, is manual-recovery", () => {
    const r = rig();
    let a = walk(r, opened(r), ["barrier", "stopping", "snapshotted", "installing"]);
    rmSync(join(r.pkg, "dist"), { recursive: true });                                                // npm died half-way
    expect(checkStage(a, live(r))).toMatchObject({ ok: false, to: "manual-recovery", reason: expect.stringMatching(/no install intent/) });
    a = recordInstallIntent(r.home, a, intentOf(r));
    expect(checkStage(a, live(r))).toEqual({ ok: true, found: "partial" });
    // A bin link npm left pointing outside the destination: not a partial of this install.
    unlinkSync(join(r.prefix, "bin", "agend")); symlinkSync(join(r.root, "agend.service"), join(r.prefix, "bin", "agend"));
    expect(checkStage(a, live(r))).toMatchObject({ ok: false, to: "manual-recovery", reason: expect.stringMatching(/outside the intent's destination/) });
    unlinkSync(join(r.prefix, "bin", "agend")); symlinkSync(join(r.pkg, "launcher", "agend"), join(r.prefix, "bin", "agend"));
    r.exec.argv = null;                                                                              // the service definition unreadable
    expect(checkStage(a, live(r))).toMatchObject({ ok: false, to: "manual-recovery", reason: expect.stringMatching(/ExecStart/) });
    r.exec.argv = EXEC; r.node.path = "/usr/bin/node";
    install(r.pkg, r.prefix, "2.4.1", "sha512-new");
    expect(checkStage(a, live(r))).toMatchObject({ ok: false, to: "manual-recovery", reason: expect.stringMatching(/Node changed/) });
  });

  it("rolling-back compares with what the restore says is current", () => {
    const r = rig();
    let a = walk(r, opened(r), ["barrier", "stopping", "snapshotted", "installing"]);
    a = recordInstallIntent(r.home, a, intentOf(r));
    install(r.pkg, r.prefix, "2.4.1", "sha512-new");
    a = recordExpectedNew(r.home, a, tupleOf(r));
    a = walk(r, a, ["trial", "rolling-back"]);
    expect(checkStage(a, live(r))).toMatchObject({ ok: false, to: "manual-recovery", reason: expect.stringMatching(/restore's current state/) });
    expect(checkStage(a, live(r), "new")).toEqual({ ok: true, found: "new" });
    expect(checkStage(a, live(r), "old")).toMatchObject({ ok: false, to: "manual-recovery" });
    install(r.pkg, r.prefix, "2.4.0", "sha512-old");
    expect(checkStage(a, live(r), "old")).toEqual({ ok: true, found: "old" });
  });
});

describe("M-3770 §3.2: the journaled identity", () => {
  it("survives the journal's round trip, and a malformed field is never proven", () => {
    const r = rig();
    const a = opened(r);
    const back = (readCurrent(r.home) as { attempt: AttemptRecord }).attempt;
    expect(identityOf(back)).toEqual(identityOf(a));
    expect(identityOf({ ...back, ownership: { ...(back.ownership as object), uid: -1 } })).toBeNull();
    expect(identityOf({ ...back, expected: { old: { ...(back.expected as { old: object }).old, bins: { agend: null, "agend-agent": null, extra: "/x" } } } })).toBeNull();
    expect(checkStage({ ...back, expected: undefined }, live(r))).toMatchObject({ ok: false, to: "abandon", reason: expect.stringMatching(/missing or malformed/) });
  });

  it("intent only in installing and once; expected.new only in installing and once", () => {
    const r = rig();
    let a = walk(r, opened(r), ["barrier"]);
    expect(() => recordInstallIntent(r.home, a, intentOf(r))).toThrow(/installing/);
    a = walk(r, a, ["stopping", "snapshotted", "installing"]);
    expect(() => recordInstallIntent(r.home, a, { ...intentOf(r), preimage: { dir: "/p", manifestSha256: "short" } })).toThrow(/malformed/);
    a = recordInstallIntent(r.home, a, intentOf(r));
    expect(a.substep).toBe("intent");
    expect(() => recordInstallIntent(r.home, a, intentOf(r))).toThrow(/already/);
    a = recordExpectedNew(r.home, a, tupleOf(r));
    expect(() => recordExpectedNew(r.home, a, tupleOf(r))).toThrow(/already/);
  });
});

describe("M-3770 §3.3: which fleet may be stopped", () => {
  it("stopping: only the recorded old generation (pid + nonce), with a matching MainPID", () => {
    const r = rig();
    const a = walk(r, opened(r), ["barrier", "stopping"]);
    expect(stopTarget(a, { pid: 4100, nonce: NONCE }, 4100)).toMatchObject({ ok: true, generation: { gen: "old", pid: 4100 } });
    expect(stopTarget(a, { pid: 4100, nonce: NONCE }, null)).toMatchObject({ ok: true });            // detached: no manager
    expect(stopTarget(a, { pid: 4999, nonce: NONCE }, null)).toMatchObject({ ok: false, reason: expect.stringMatching(/no recorded generation/) });
    expect(stopTarget(a, { pid: 4100, nonce: "d".repeat(32) }, null)).toMatchObject({ ok: false });
    expect(stopTarget(a, { pid: 4100, nonce: NONCE }, 5000)).toMatchObject({ ok: false, reason: expect.stringMatching(/MainPID 5000/) });
    expect(stopTarget(a, null, null)).toMatchObject({ ok: false });
    const r2 = rig();
    expect(stopTarget(opened(r2, null), { pid: 1, nonce: NONCE }, null)).toMatchObject({ ok: false, reason: expect.stringMatching(/opened/) });
  });

  it("rolling-back: only the acknowledged trial generation; the old one is not stopped there", () => {
    const r = rig();
    let a = walk(r, opened(r), ["barrier", "stopping", "snapshotted", "installing"]);
    a = recordInstallIntent(r.home, a, intentOf(r));
    a = recordExpectedNew(r.home, a, tupleOf(r));
    a = advance(r.home, a, "trial");
    a = planGeneration(r.home, a, "trial", TRIAL);
    a = ackGeneration(r.home, a, TRIAL, 4300);
    a = advance(r.home, a, "rolling-back");
    expect(stopTarget(a, { pid: 4300, nonce: TRIAL }, 4300)).toMatchObject({ ok: true, generation: { gen: "trial", pid: 4300 } });
    expect(stopTarget(a, { pid: 4100, nonce: NONCE }, null)).toMatchObject({ ok: false, reason: expect.stringMatching(/generation old, not trial/) });
  });
});
