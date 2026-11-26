// M-3770 slice 2.1c (design update-transaction §6.1, §6.2): the pre-start decision table, the handoff environment
// file, the attempt's owner (updater or recovery runner), and the kit: built, verified, and its bundled recover.cjs run
// on the kit's own Node from outside the repository, with nothing of the package to load.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { advance, ackGeneration, claimHandoff, fleetStartGate, finish, newAttemptId, openAttempt, ownerState, planGeneration, readCurrent, writeRunnerRecord, type AttemptRecord } from "../src/update-journal.js";
import { applyHandoffEnv, handoffEnvPath, operatorCommand, preStartDecision } from "../src/update-recovery/pre-start.js";
import { buildRecoveryKit, verifyRecoveryKit } from "../src/update-recovery/kit.js";
import { acquireServiceLock, admitServiceCommand, SERVICE_LOCK_TOKEN_ENV } from "../src/service-lock.js";
import type { InstallLockDeps } from "../src/install-lock.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = () => { const h = mkdtempSync(join(tmpdir(), "recov-")); homes.push(h); return h; };
const ID = newAttemptId(new Date("2026-11-26T06:00:00Z"), "0e0f1011");
const START = { processStart: "Thu Nov 26 06:00:00 2026" };
const UPDATER = 4242, RUNNER = 5151;
const NONCE = "a".repeat(32), LATER = "b".repeat(32);
const LIVE = (pids: number[]) => ({ processStart: (p: number) => (pids.includes(p) ? START.processStart : null), exists: (p: number) => pids.includes(p) });
const open = (h: string, updater: { pid: number; start: { processStart: string } } = { pid: UPDATER, start: START }): AttemptRecord => {
  const r = openAttempt(h, { id: ID, kind: "update", updater, from: { name: "@songsid/agend", version: "2.4.0", integrity: null }, to: { name: "@songsid/agend", version: "2.4.1", integrity: null } });
  if (!r.ok) throw new Error(r.reason);
  return r.attempt;
};

describe("M-3770 §6.2: the pre-start decision table", () => {
  it("none and closing start; unknown and manual refuse with the way out", () => {
    const h = home();
    expect(preStartDecision(h, readCurrent(h), "gone")).toEqual({ kind: "start" });
    let a = advance(h, open(h), "barrier");
    a = finish(h, a, { kind: "manual-recovery", reason: "test" });
    expect(preStartDecision(h, readCurrent(h), "live")).toMatchObject({ kind: "refuse", reason: expect.stringContaining(operatorCommand(h, ID)) });
    writeFileSync(join(h, ".update-journal", "current"), "nonsense\n");
    expect(preStartDecision(h, readCurrent(h), "live")).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/can't be read.*--resolve/) });
  });

  it("open: a live owner hands off its NEWEST planned, unconsumed generation, else refuses; gone starts the runner; unknown refuses", () => {
    const h = home();
    let a = advance(h, open(h), "barrier");
    expect(preStartDecision(h, readCurrent(h), "live")).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/AgEnD is updating \(attempt .*, barrier\)/) });
    a = planGeneration(h, a, "trial", NONCE);
    a = planGeneration(h, a, "rollback", LATER);
    expect(preStartDecision(h, readCurrent(h), "live")).toEqual({ kind: "handoff", attemptId: ID, nonce: LATER });
    a = ackGeneration(h, a, LATER, 300);
    expect(preStartDecision(h, readCurrent(h), "live")).toEqual({ kind: "handoff", attemptId: ID, nonce: NONCE });   // the older, still unconsumed
    a = ackGeneration(h, a, NONCE, 301);
    expect(preStartDecision(h, readCurrent(h), "live")).toMatchObject({ kind: "refuse" });
    expect(preStartDecision(h, readCurrent(h), "gone")).toEqual({ kind: "start-runner", attemptId: ID, stage: "barrier" });
    expect(preStartDecision(h, readCurrent(h), "unknown")).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/can't be told/) });
  });

  it("handoff.env carries the nonce for a handoff and is removed for any other decision", () => {
    const h = home();
    advance(h, open(h), "barrier");
    applyHandoffEnv(h, { kind: "handoff", attemptId: ID, nonce: NONCE }, ID);
    expect(readFileSync(handoffEnvPath(h, ID), "utf8")).toBe(`AGEND_UPDATE_HANDOFF=${NONCE}\n`);
    applyHandoffEnv(h, { kind: "refuse", reason: "x" }, ID);
    expect(existsSync(handoffEnvPath(h, ID))).toBe(false);
    applyHandoffEnv(h, { kind: "start" }, ID);                                                     // already gone: fine
  });
});

describe("M-3770 §6.2: the attempt's owner is its updater or its recorded recovery runner", () => {
  it("live when either lives; unknown when either can't be told or the runner record can't be read; gone only when both are", () => {
    const h = home();
    const a = planGeneration(h, advance(h, open(h), "barrier"), "rollback", NONCE);
    expect(ownerState(h, a, LIVE([]))).toBe("gone");                                              // no runner recorded
    writeRunnerRecord(h, ID, { pid: RUNNER, start: START });
    expect(ownerState(h, a, LIVE([RUNNER]))).toBe("live");
    expect(ownerState(h, a, LIVE([]))).toBe("gone");
    expect(ownerState(h, a, { processStart: p => (p === RUNNER ? null : START.processStart), exists: p => p === RUNNER })).toBe("unknown");
    writeFileSync(join(h, ".update-journal", "attempts", ID, "runner.json"), "{broken");
    expect(ownerState(h, a, LIVE([]))).toBe("unknown");
  });

  it("the runner's own start may claim its planned generation, and passes the fleet start gate, with the updater gone", () => {
    const h = home();
    planGeneration(h, advance(h, open(h), "barrier"), "rollback", NONCE);
    expect(fleetStartGate(h, NONCE, LIVE([]))).toMatchObject({ ok: false });                        // no runner: recovery's
    writeRunnerRecord(h, ID, { pid: RUNNER, start: START });
    expect(fleetStartGate(h, NONCE, LIVE([RUNNER]))).toEqual({ ok: true });
    expect(claimHandoff(h, ID, NONCE, { pid: 600, start: START }, LIVE([RUNNER]))).toBe(true);
  });

  it("the service lock's token admits the runner's child when the runner holds the lock", () => {
    const h = home();
    advance(h, open(h), "barrier");
    writeRunnerRecord(h, ID, { pid: RUNNER, start: START });
    const deps = (pid: number, live: number[]): InstallLockDeps => ({ pid, processStart: p => (live.includes(p) || p === pid ? START.processStart : null),
      exists: p => live.includes(p) || p === pid, newToken: () => "c".repeat(32), now: () => new Date(), log: () => {} });
    const held = acquireServiceLock(h, ID, deps(RUNNER, [RUNNER]));
    if (!held.ok) throw new Error(held.reason);
    expect(admitServiceCommand(h, "start", deps(700, [RUNNER, 700]), { [SERVICE_LOCK_TOKEN_ENV]: held.token })).toMatchObject({ ok: true, viaToken: true });
  });
});

describe("M-3770 §6.1: the kit", () => {
  let out: string, bundle: string;
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "recov-bundle-"));
    bundle = join(out, "recover.cjs");
    const r = spawnSync(process.execPath, [join(process.cwd(), "scripts", "build-recover.mjs"), bundle], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`build-recover failed: ${r.stderr}`);
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("the bundle is closed: it requires node built-ins only", () => {
    const text = readFileSync(bundle, "utf8");
    const required = [...text.matchAll(/require\(["']([^"']+)["']\)/g)].map(m => m[1]!);
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) expect(name).toMatch(/^(node:)?[a-z_]+(\/[a-z_]+)?$/);
    expect(text).not.toMatch(/require\(["']\.{1,2}\//);
  });

  it("is built (node copied, run alone, manifest), verified, and refused when a file is changed or the Node can't run alone", () => {
    const h = home();
    const built = buildRecoveryKit(h, ID, { nodePath: process.execPath, bundlePath: bundle });
    if (!built.ok) throw new Error(built.reason);
    expect(verifyRecoveryKit(h, ID)).toMatchObject({ ok: true, manifest: { attemptId: ID, home: h } });
    chmodSync(join(built.dir, "recover.cjs"), 0o600);
    writeFileSync(join(built.dir, "recover.cjs"), "tampered");
    expect(verifyRecoveryKit(h, ID)).toMatchObject({ ok: false, reason: expect.stringMatching(/recover\.cjs doesn't match/) });
    expect(buildRecoveryKit(h, ID, { nodePath: process.execPath, bundlePath: bundle })).toMatchObject({ ok: false });   // never reused
    const h2 = home();
    expect(buildRecoveryKit(h2, ID, { nodePath: process.execPath, bundlePath: bundle, runsAlone: () => false })).toMatchObject({ ok: false, reason: expect.stringMatching(/doesn't run alone/) });
    expect(existsSync(join(h2, ".update-journal", "recovery", ID, "kit.json"))).toBe(false);
  });

  it("the kit's recover.cjs runs on the kit's Node from outside the repository: start, handoff (env written), refuse", () => {
    const h = home();
    const run = (args: string[]) => spawnSync(join(h, ".update-journal", "recovery", ID, "node"), [join(h, ".update-journal", "recovery", ID, "recover.cjs"), ...args],
      { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    // The updater is this test process (live, by its real start): a planned generation is handed off.
    const admission = require(join(process.cwd(), "launcher", "install-admission.cjs")) as { processStart(pid: number): string | null };
    let a = advance(h, open(h, { pid: process.pid, start: { processStart: admission.processStart(process.pid)! } }), "barrier");
    a = advance(h, advance(h, a, "stopping"), "snapshotted");
    const built = buildRecoveryKit(h, ID, { nodePath: process.execPath, bundlePath: bundle });
    if (!built.ok) throw new Error(built.reason);
    expect(run(["--home", h])).toMatchObject({ status: 2 });                                          // usage
    const refused = run(["--home", h, "--pre-start"]);
    expect(refused).toMatchObject({ status: 1, stderr: expect.stringMatching(/AgEnD is updating \(attempt .*, snapshotted\)/) });
    planGeneration(h, a, "trial", NONCE);
    expect(run(["--home", h, "--pre-start"])).toMatchObject({ status: 0 });
    expect(readFileSync(handoffEnvPath(h, ID), "utf8")).toBe(`AGEND_UPDATE_HANDOFF=${NONCE}\n`);
  });

  it("with the updater gone, the kit's pre-start refuses and names the operator command", () => {
    const h = home();
    advance(h, open(h, { pid: 2 ** 22 - 3, start: START }), "barrier");                             // a pid that isn't running
    const built = buildRecoveryKit(h, ID, { nodePath: process.execPath, bundlePath: bundle });
    if (!built.ok) throw new Error(built.reason);
    const r = spawnSync(join(built.dir, "node"), [join(built.dir, "recover.cjs"), "--home", h, "--pre-start"], { cwd: tmpdir(), env: {}, encoding: "utf8" });
    expect(r).toMatchObject({ status: 1, stderr: expect.stringContaining(operatorCommand(h, ID)) });
  });
});
