// M-3770 slice 2.1c part 2 (design update-transaction §6.2, §7): the independent recovery runner (`--run`) — its
// refusals, the three locks in order with release in reverse, its record, finishing a closing attempt, and refusing
// (unchanged) what needs 2.3's restores — and the pre-start step's launch of it with the 10 s handshake. The launch is
// always stubbed: no test starts systemd-run or launchctl. The last test runs the real bundled recover.cjs --run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { advance, defaultJournalIo, finish, newAttemptId, openAttempt, planGeneration, readCurrent, readRunnerRecord, writeRunnerRecord, type AttemptRecord, type JournalIo } from "../src/update-journal.js";
import { launchRunner, runRecovery, runnerLaunchCommand, SERVICE_LOCK_FILE, type RunnerDeps } from "../src/update-recovery/runner.js";
import { defaultRecoverDeps, main } from "../src/update-recovery/recover.js";
import { buildRecoveryKit } from "../src/update-recovery/kit.js";
import { SERVICE_LOCK_FILE as SERVICE_LOCK_FILE_SRC } from "../src/service-lock.js";
import { acquireInstallLock, INSTALL_LOCK_FILE } from "../src/install-lock.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p = "runner-") => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const ID = newAttemptId(new Date("2026-11-26T08:00:00Z"), "abcdef01");
const START = { processStart: "Thu Nov 26 08:00:00 2026" };
const UPDATER = 4242, RUNNER = 5151, OTHER = 6161;
const LIVE = (pids: number[]) => ({ processStart: (p: number) => (pids.includes(p) ? START.processStart : null), exists: (p: number) => pids.includes(p) });

interface Rig { home: string; prefix: string }
const rig = (): Rig => { const root = tmp(); const home = join(root, "home"), prefix = join(root, "prefix"); mkdirSync(home); mkdirSync(prefix); return { home, prefix }; };

const identity = (r: Rig, service: "systemd" | "launchd" | null = "systemd") => ({
  ownership: { uid: 1000, home: r.home, prefix: r.prefix, packagePath: join(r.prefix, "lib", "node_modules", "@songsid", "agend"),
    binLinks: { agend: join(r.prefix, "bin", "agend"), "agend-agent": join(r.prefix, "bin", "agend-agent") },
    service: service ? { kind: service, unit: service === "systemd" ? "agend.service" : "com.agend.fleet", fragmentPath: join(r.home, "unit") } : null },
  expected: { old: { version: "2.4.0", integrity: null, bins: { agend: "/x/agend", "agend-agent": "/x/agend-agent" }, entry: "/x/cli.js", interpreter: "/usr/bin/node", execStart: null } },
  fleets: [],
});

const open = (r: Rig, opts: { withIdentity?: boolean; service?: "systemd" | "launchd" | null; updater?: { pid: number; start: { processStart: string } } } = {}): AttemptRecord => {
  const res = openAttempt(r.home, { id: ID, kind: "update", updater: opts.updater ?? { pid: UPDATER, start: START },
    from: { name: "@songsid/agend", version: "2.4.0", integrity: null }, to: { name: "@songsid/agend", version: "2.4.1", integrity: null },
    ...(opts.withIdentity === false ? {} : { extra: identity(r, opts.service === undefined ? "systemd" : opts.service) }) });
  if (!res.ok) throw new Error(res.reason);
  return res.attempt;
};

/** A terminal record whose `current` was never cleared: a crash inside finish()'s last step. */
const closing = (r: Rig): AttemptRecord => {
  let a = advance(r.home, open(r), "barrier");
  a = advance(r.home, a, "abandoning");
  const crashing: JournalIo = { ...defaultJournalIo, rename: (from, to) => { if (to.endsWith("current.closed")) throw new Error("crash before current is cleared"); defaultJournalIo.rename(from, to); } };
  expect(() => finish(r.home, a, { kind: "abandoned" }, crashing)).toThrow(/crash/);
  expect(readCurrent(r.home).state).toBe("closing");
  return a;
};

const deps = (live: number[], out: string[] = [], err: string[] = []): RunnerDeps => ({
  pid: RUNNER,
  lock: { ...LIVE(live), newToken: () => "d".repeat(32), now: () => new Date(), log: () => {} },
  liveness: LIVE(live),
  io: defaultJournalIo,
  out: l => out.push(l), err: l => err.push(l),
});
const lockFiles = (r: Rig) => [join(r.home, ".update.lock"), join(r.prefix, INSTALL_LOCK_FILE), join(r.home, SERVICE_LOCK_FILE)].filter(p => existsSync(p));

describe("M-3770 §6.2: the recovery runner (--run)", () => {
  it("uses the service lock file service-lock.ts defines (that module isn't bundled)", () => {
    expect(SERVICE_LOCK_FILE).toBe(SERVICE_LOCK_FILE_SRC);
  });

  it("finishes a closing attempt under the three locks, records itself, and releases every lock", () => {
    const r = rig(); closing(r);
    const out: string[] = [];
    expect(runRecovery(r.home, ID, deps([RUNNER], out))).toBe(0);
    expect(readCurrent(r.home).state).toBe("none");
    expect(out.join("\n")).toMatch(/is closed/);
    expect(readRunnerRecord(r.home, ID)).toMatchObject({ pid: RUNNER });
    expect(lockFiles(r)).toEqual([]);
  });

  it("refuses — taking nothing — while the updater lives, can't be told gone, or another runner acts", () => {
    const r = rig(); advance(r.home, open(r), "barrier");
    const err: string[] = [];
    expect(runRecovery(r.home, ID, deps([UPDATER, RUNNER], [], err))).toBe(1);
    expect(err.at(-1)).toMatch(/updater is still running/);
    expect(runRecovery(r.home, ID, { ...deps([RUNNER], [], err), liveness: { processStart: p => (p === UPDATER ? null : START.processStart), exists: () => true } })).toBe(1);
    expect(err.at(-1)).toMatch(/can't be told/);
    writeRunnerRecord(r.home, ID, { pid: OTHER, start: START });
    expect(runRecovery(r.home, ID, deps([RUNNER, OTHER], [], err))).toBe(1);
    expect(err.at(-1)).toMatch(/another recovery runner \(pid 6161\)/);
    expect(lockFiles(r)).toEqual([]);
    expect(readRunnerRecord(r.home, ID)).toMatchObject({ pid: OTHER });                             // untouched
  });

  it("refuses a journal that names another attempt, a manual one, or an attempt with no recorded prefix", () => {
    const r = rig(); advance(r.home, open(r, { withIdentity: false }), "barrier");
    const err: string[] = [];
    expect(runRecovery(r.home, ID, deps([RUNNER], [], err))).toBe(1);
    expect(err.at(-1)).toMatch(/npm prefix/);
    expect(runRecovery(r.home, newAttemptId(new Date(), "00000000"), deps([RUNNER], [], err))).toBe(1);
    expect(err.at(-1)).toMatch(/not this kit's/);
    const r2 = rig(); finish(r2.home, advance(r2.home, open(r2), "barrier"), { kind: "manual-recovery", reason: "t" });
    expect(runRecovery(r2.home, ID, deps([RUNNER], [], err))).toBe(1);
    expect(err.at(-1)).toMatch(/manual recovery/);
  });

  it("an interrupted attempt that needs 2.3's restores: refused with the journal unchanged, after the locks (and released)", () => {
    const r = rig();
    advance(r.home, advance(r.home, advance(r.home, open(r), "barrier"), "stopping"), "snapshotted");
    const before = readFileSync(join(r.home, ".update-journal", "attempts", ID, "attempt.json"), "utf8");
    const err: string[] = [];
    expect(runRecovery(r.home, ID, deps([RUNNER], [], err))).toBe(1);
    expect(err.at(-1)).toMatch(/resuming rolling-back from snapshotted.*can't do yet\. Nothing was changed/);
    expect(readFileSync(join(r.home, ".update-journal", "attempts", ID, "attempt.json"), "utf8")).toBe(before);
    expect(readRunnerRecord(r.home, ID)).toMatchObject({ pid: RUNNER });
    expect(lockFiles(r)).toEqual([]);
  });

  describe("evidence that changes while the locks are taken is checked again before anything is written (Prism #4515)", () => {
    /** Runner deps whose FIRST lock attempt runs `during` — i.e. after the first checks, before the locks are all held. */
    const during = (fn: () => void, live = [RUNNER, OTHER]) => { const d = deps(live); const nt = d.lock.newToken; let n = 0; d.lock = { ...d.lock, newToken: () => { if (n++ === 0) fn(); return nt(); } }; return d; };
    const runnerFile = (r: Rig) => join(r.home, ".update-journal", "attempts", ID, "runner.json");

    it("a live runner recorded meanwhile: refused; its record's bytes, current and every lock untouched/released", () => {
      const r = rig(); closing(r);
      const err: string[] = [];
      const d = during(() => writeRunnerRecord(r.home, ID, { pid: OTHER, start: START }));
      d.err = l => err.push(l);
      const bytes = () => readFileSync(runnerFile(r), "utf8");
      expect(runRecovery(r.home, ID, d)).toBe(1);
      expect(err.at(-1)).toMatch(/another recovery runner \(pid 6161\).*under the locks/);
      expect(JSON.parse(bytes())).toMatchObject({ pid: OTHER });
      expect(readCurrent(r.home).state).toBe("closing");
      expect(lockFiles(r)).toEqual([]);
    });

    it("an unreadable runner record meanwhile: refused, its bytes preserved", () => {
      const r = rig(); closing(r);
      expect(runRecovery(r.home, ID, during(() => writeFileSync(runnerFile(r), "{broken")))).toBe(1);
      expect(readFileSync(runnerFile(r), "utf8")).toBe("{broken");
      expect(readCurrent(r.home).state).toBe("closing");
      expect(lockFiles(r)).toEqual([]);
    });

    it("the attempt turned manual meanwhile: refused, no runner record written", () => {
      const r = rig();
      const a = advance(r.home, advance(r.home, advance(r.home, open(r), "barrier"), "stopping"), "snapshotted");
      expect(runRecovery(r.home, ID, during(() => { finish(r.home, a, { kind: "manual-recovery", reason: "t" }); }))).toBe(1);
      expect(existsSync(runnerFile(r))).toBe(false);
      expect(lockFiles(r)).toEqual([]);
    });

    it("the recorded prefix changed meanwhile: refused (the locked prefix is no longer the attempt's)", () => {
      const r = rig(); closing(r);
      const recordPath = join(r.home, ".update-journal", "attempts", ID, "attempt.json");
      const err: string[] = [];
      const d = during(() => { const rec = JSON.parse(readFileSync(recordPath, "utf8")); rec.ownership.prefix = join(r.prefix, "..", "elsewhere"); writeFileSync(recordPath, JSON.stringify(rec)); });
      d.err = l => err.push(l);
      expect(runRecovery(r.home, ID, d)).toBe(1);
      expect(err.at(-1)).toMatch(/npm prefix changed while the locks were taken/);
      expect(existsSync(runnerFile(r))).toBe(false);
      expect(readCurrent(r.home).state).toBe("closing");
      expect(lockFiles(r)).toEqual([]);
    });
  });

  it("the order is home → prefix → service; a lock it can't take releases the ones it took", () => {
    const other = { pid: OTHER, ...LIVE([OTHER]), newToken: () => "e".repeat(32), now: () => new Date(), log: () => {} };
    const take = (dir: string, opts: { file?: string }) => { const l = acquireInstallLock(dir, { spec: "x", agendHome: dir }, other, opts); if (!l.ok) throw new Error(l.reason); return l; };
    const r = rig(); closing(r);
    // Each lock attempt draws one token: the count shows how far the runner got, so the order is observable.
    let tokens = 0;
    const counted = () => { const d = deps([RUNNER, OTHER]); const nt = d.lock.newToken; d.lock = { ...d.lock, newToken: () => { tokens++; return nt(); } }; return d; };
    // The home lock held by another: nothing after it is taken (one attempt).
    let held = take(r.home, { file: ".update.lock" });
    expect(runRecovery(r.home, ID, counted())).toBe(1);
    expect(tokens).toBe(1);
    expect(lockFiles(r)).toEqual([join(r.home, ".update.lock")]);
    held.release();
    // The prefix lock held: the home lock it took is released; the service lock never taken.
    held = take(r.prefix, {}); tokens = 0;
    expect(runRecovery(r.home, ID, counted())).toBe(1);
    expect(tokens).toBe(2);
    expect(lockFiles(r)).toEqual([join(r.prefix, INSTALL_LOCK_FILE)]);
    held.release();
    // The service lock held: home and prefix released.
    held = take(r.home, { file: SERVICE_LOCK_FILE }); tokens = 0;
    expect(runRecovery(r.home, ID, counted())).toBe(1);
    expect(tokens).toBe(3);
    expect(lockFiles(r)).toEqual([join(r.home, SERVICE_LOCK_FILE)]);
    expect(readCurrent(r.home).state).toBe("closing");                                              // nothing done
    held.release();
    expect(runRecovery(r.home, ID, deps([RUNNER]))).toBe(0);
  });
});

describe("M-3770 §6.2: the pre-start step launches the runner outside the service, and waits for its handshake", () => {
  it("the launch command: systemd-run (--user unless root) or launchctl submit, running the kit's own runner", () => {
    const r = rig();
    const a = open(r);
    const kit = join(r.home, ".update-journal", "recovery", ID);
    const runner = [join(kit, "node"), join(kit, "recover.cjs"), "--home", r.home, "--attempt", ID, "--run"];
    expect(runnerLaunchCommand(r.home, a, 1000)).toEqual({ command: "systemd-run", args: ["--user", `--unit=agend-update-recovery-${ID}`, "--collect", "--property=KillMode=process", ...runner] });
    expect(runnerLaunchCommand(r.home, a, 0)?.args[0]).toBe(`--unit=agend-update-recovery-${ID}`);
    const r2 = rig();
    expect(runnerLaunchCommand(r2.home, open(r2, { service: "launchd" }), 501)).toEqual({ command: "launchctl", args: ["submit", "-l", `com.agend.update-recovery.${ID}`, "--", ...runner.map(x => x.replace(r.home, r2.home))] });
    const r3 = rig();
    expect(runnerLaunchCommand(r3.home, open(r3, { service: null }), 1000)).toBeNull();
  });

  it("started: its runner.json names a live process within the wait; not started: the launch failed, or no answer in time", () => {
    const r = rig(); const a = open(r);
    let clock = 0;
    const base = { sleep: (ms: number) => { clock += ms; }, now: () => clock, uid: () => 1000, liveness: LIVE([RUNNER]), io: defaultJournalIo };
    const calls: string[][] = [];
    expect(launchRunner(r.home, a, { ...base, run: (c, args) => { calls.push([c, ...args]); writeRunnerRecord(r.home, ID, { pid: RUNNER, start: START }); return 0; } })).toEqual({ started: true, pid: RUNNER });
    expect(calls).toHaveLength(1);
    rmSync(join(r.home, ".update-journal", "attempts", ID, "runner.json"));
    expect(launchRunner(r.home, a, { ...base, run: () => 1 })).toMatchObject({ started: false, reason: expect.stringMatching(/systemd-run couldn't start.*exit 1.*--run/) });
    clock = 0;
    expect(launchRunner(r.home, a, { ...base, run: () => 0 })).toMatchObject({ started: false, reason: expect.stringMatching(/didn't answer within 10 s/) });
    expect(clock).toBeGreaterThanOrEqual(10_000);
    // A stale record (a runner that's gone) is no answer.
    writeRunnerRecord(r.home, ID, { pid: OTHER, start: START }); clock = 0;
    expect(launchRunner(r.home, a, { ...base, run: () => 0 })).toMatchObject({ started: false });
  });

  it("pre-start with the owner gone launches once and refuses this start, saying a runner took over", () => {
    const r = rig(); advance(r.home, open(r), "barrier");
    const calls: string[][] = [], err: string[] = [];
    const d = defaultRecoverDeps();
    const code = main(["--home", r.home, "--attempt", ID, "--pre-start"], { ...d, liveness: LIVE([RUNNER]), err: l => err.push(l), out: () => {},
      launch: { ...d.launch, uid: () => 1000, run: (c, args) => { calls.push([c, ...args]); writeRunnerRecord(r.home, ID, { pid: RUNNER, start: START }); return 0; } } });
    expect(code).toBe(1);
    expect(calls.map(c => c[0])).toEqual(["systemd-run"]);
    expect(err.join("\n")).toMatch(/recovery runner \(pid 5151\) took over; this start is refused/);
  });
});

describe("M-3770 §6.2: the real bundled runner", () => {
  let out: string, bundle: string;
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "runner-bundle-"));
    bundle = join(out, "recover.cjs");
    const res = spawnSync(process.execPath, [join(process.cwd(), "scripts", "build-recover.mjs"), bundle], { encoding: "utf8" });
    if (res.status !== 0) throw new Error(`build-recover failed: ${res.stderr}`);
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("<kit>/node <kit>/recover.cjs --run, from outside the repository, finishes a closing attempt and leaves no lock", () => {
    const r = rig(); closing(r);
    const built = buildRecoveryKit(r.home, ID, { nodePath: process.execPath, bundlePath: bundle });
    if (!built.ok) throw new Error(built.reason);
    const res = spawnSync(join(built.dir, "node"), [join(built.dir, "recover.cjs"), "--home", r.home, "--attempt", ID, "--run"], { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(res).toMatchObject({ status: 0, stdout: expect.stringMatching(/is closed/) });
    expect(readCurrent(r.home).state).toBe("none");
    expect(lockFiles(r)).toEqual([]);
    expect(readRunnerRecord(r.home, ID)).toMatchObject({ pid: expect.any(Number) });
  });
});
