/**
 * #2481: an installed version whose fleet keeps failing to start is told to the person — never rolled back. The real
 * Mac case: 2.2.6's updater reported a crash-looping 2.3 under launchd as "Service restarted" (#2277 rehearsal).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTEMPTS_FILE, STARTED_FILE, checkStartFailure, clearStartAttempts, judgeStartFailure, keptCopies, managerShowsLoop, notifyOnce, npmPrefixOf,
  parseLaunchctlPrint, parseSystemctlShow, previousVersion, readAttempts, readManager, readStarted, recordStartAttempt, recordStarted,
  type ManagerView, type StartedRecord,
} from "../src/start-failure.js";
import { startFailureLines } from "../src/start-failure-notice.js";
import { setLocale } from "../src/locale.js";

const dirs: string[] = [];
const scratch = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `agend-2481-${tag}-`)); dirs.push(d); return d; };
afterEach(() => { setLocale("en"); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const NOW = Date.parse("2026-10-23T06:30:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const V = "2.3.0";
const LOADED = (o: Partial<{ state: string; runs: number | null; lastExit: number | null; pid: number | null }> = {}): ManagerView =>
  ({ kind: "launchd", loaded: true, state: "spawn scheduled", runs: 6, lastExit: 1, pid: null, ...o });
const SYSTEMD = (o: Partial<{ active: string; sub: string; result: string; restarts: number | null; status: number | null }> = {}): ManagerView =>
  ({ kind: "systemd", active: "activating", sub: "auto-restart", result: "exit-code", restarts: 3, status: 1, ...o });
const judge = (o: Partial<Parameters<typeof judgeStartFailure>[0]> = {}) => judgeStartFailure({
  installed: V, packageAgeMs: 10 * 60_000, now: NOW, started: null, attempts: null, manager: LOADED(), ...o,
});

describe("#2481 the decision: a crash loop of the installed version, nothing else", () => {
  it("launchd: loaded, last exit non-zero, started again and again → failing, with what the manager said", () => {
    expect(judge()).toEqual({ failing: true, version: V, previous: null, detail: "launchd: exit 1, started 6 times" });
    // Two of our own attempts are enough when launchd's run count was reset (a fresh bootstrap).
    expect(judge({ manager: LOADED({ runs: 1 }), attempts: { version: V, attempts: [ago(150), ago(100)] } }).failing).toBe(true);
  });
  it("systemd: auto-restart, failed, or a failing result restarted twice → failing", () => {
    expect(judge({ manager: SYSTEMD() }).failing).toBe(true);
    expect(judge({ manager: SYSTEMD({ active: "failed", sub: "failed", result: "start-limit-hit" }) }).failing).toBe(true);
    expect(judge({ manager: SYSTEMD({ active: "activating", sub: "start", result: "exit-code", restarts: 2 }) }).failing).toBe(true);
    expect(judge({ manager: SYSTEMD() })).toMatchObject({ detail: "systemd: activating/auto-restart, result exit-code, restarted 3 times" });
    // Each rule alone: an auto-restart pending after the first failure; a failing result only once it repeated.
    expect(judge({ manager: SYSTEMD({ sub: "auto-restart", result: "", restarts: 0 }) }).failing).toBe(true);
    expect(judge({ manager: SYSTEMD({ active: "active", sub: "running", result: "exit-code", restarts: 1 }) }).failing).toBe(false);
  });
  it("never: the installed version has started here (and then nothing else is consulted)", () => {
    const started: StartedRecord = { version: V, at: ago(5), pid: 1, history: [V] };
    expect(judge({ started })).toEqual({ failing: false });
  });
  it("never: a version trying to start for less than 90 s — since its first attempt, else since its install", () => {
    expect(judge({ packageAgeMs: 60_000 })).toEqual({ failing: false });
    expect(judge({ packageAgeMs: 60_000, attempts: { version: V, attempts: [ago(100), ago(50)] } }).failing).toBe(true);
    expect(judge({ packageAgeMs: 10 * 60_000, attempts: { version: V, attempts: [ago(60), ago(30)] } })).toEqual({ failing: false });
  });
  it("never: a slow start — the job runs, one attempt, last exit 0 or none", () => {
    expect(judge({ manager: LOADED({ state: "running", runs: 1, lastExit: null, pid: 42 }), attempts: { version: V, attempts: [ago(200)] } })).toEqual({ failing: false });
    expect(judge({ manager: LOADED({ state: "running", runs: 4, lastExit: 0, pid: 42 }) })).toEqual({ failing: false });
    expect(judge({ manager: SYSTEMD({ active: "activating", sub: "start", result: "success", restarts: 0 }) })).toEqual({ failing: false });
  });
  it("never: a job running now (a pid) on stale launchd counters — a slow start; only 3 recent attempts say it restarts (Fable r1)", () => {
    const running = LOADED({ state: "running", pid: 4242, runs: 7, lastExit: 1 });
    expect(judge({ manager: running, attempts: { version: V, attempts: [ago(120)] } })).toEqual({ failing: false });
    expect(judge({ manager: LOADED({ state: "running", pid: 4242, runs: 2, lastExit: 1 }), attempts: { version: V, attempts: [ago(150), ago(100)] } })).toEqual({ failing: false });
    expect(judge({ manager: running, attempts: { version: V, attempts: [ago(300), ago(200), ago(100)] } }).failing).toBe(true);
    // "running" with no pid is launchd mid-spawn, not a running fleet: its counters count.
    expect(judge({ manager: LOADED({ state: "running", pid: null, runs: 7, lastExit: 1 }), attempts: { version: V, attempts: [ago(120)] } }).failing).toBe(true);
  });
  it("only recent attempts count: an old one (a reboot mid-start) does not make two (Fable r1)", () => {
    expect(judge({ manager: LOADED({ runs: 1 }), attempts: { version: V, attempts: [ago(3600), ago(100)] } })).toEqual({ failing: false });
  });
  it("never: a deliberate stop — launchd job not loaded, systemd inactive with success", () => {
    expect(judge({ manager: { kind: "launchd", loaded: false } })).toEqual({ failing: false });
    expect(judge({ manager: SYSTEMD({ active: "inactive", sub: "dead", result: "success", restarts: 0 }) })).toEqual({ failing: false });
    expect(judge({ manager: SYSTEMD({ active: "failed", sub: "failed", result: "success" }) })).toEqual({ failing: false });
  });
  it("no service, or one that cannot be read: only our own attempts — 3 of this version in 10 min", () => {
    const three = { version: V, attempts: [ago(500), ago(300), ago(100)] };
    expect(judge({ manager: undefined, attempts: three })).toMatchObject({ failing: true, detail: "3 start attempts in the last 10 minutes, none completed" });
    expect(judge({ manager: null, attempts: three }).failing).toBe(true);
    expect(judge({ manager: null, attempts: { version: V, attempts: [ago(900), ago(300), ago(100)] } }).failing).toBe(false);   // one too old
    expect(judge({ manager: null, attempts: { version: "2.2.6", attempts: [ago(300), ago(200), ago(100)] } }).failing).toBe(false); // another version's
    expect(judge({ manager: undefined, attempts: null }).failing).toBe(false);
  });
});

describe("#2481 the version to go back to, and the copy an updater kept", () => {
  it("the newest version that ran here comes first; then the newest kept copy; never the installed one", () => {
    const started: StartedRecord = { version: "2.2.9", at: ago(9e3), pid: 1, history: ["2.2.9", "2.2.6"] };
    expect(previousVersion(V, started, [])).toEqual({ version: "2.2.9", copy: null });
    expect(previousVersion(V, null, [{ version: V, path: "/x/a" }, { version: "2.2.6", path: "/p/.agend-rollback/2.2.6-t/agend" }]))
      .toEqual({ version: "2.2.6", copy: "/p/.agend-rollback/2.2.6-t/agend" });
    expect(previousVersion(V, { ...started, history: [V] }, [])).toBeNull();
  });
  it("names the kept copy of that version when one exists", () => {
    const started: StartedRecord = { version: "2.2.6", at: ago(9e3), pid: 1, history: ["2.2.6"] };
    expect(previousVersion(V, started, [{ version: "2.2.6", path: "/p/c" }])).toEqual({ version: "2.2.6", copy: "/p/c" });
  });
  it("reads `<prefix>/.agend-rollback`: 2.2.6's names and 2.3's `-pid` names, whole copies only, newest first", () => {
    const prefix = scratch("prefix"), base = join(prefix, ".agend-rollback");
    const copy = (name: string, whole: boolean, mtime: number) => {
      mkdirSync(join(base, name, "agend"), { recursive: true });
      if (whole) writeFileSync(join(base, name, "agend", "package.json"), "{}");
      utimesSync(join(base, name), mtime, mtime);
    };
    copy("2.2.6-2026-10-22T21-50-01-123Z", true, 2000);
    copy("2.3.0-beta.25-2026-10-21T10-00-00-000Z-4242", true, 1000);
    copy("2.2.5-2026-10-01T00-00-00-000Z", false, 3000);           // a partial copy is no source
    writeFileSync(join(base, "README"), "x");
    expect(keptCopies(prefix)).toEqual([
      { version: "2.2.6", path: join(base, "2.2.6-2026-10-22T21-50-01-123Z", "agend") },
      { version: "2.3.0-beta.25", path: join(base, "2.3.0-beta.25-2026-10-21T10-00-00-000Z-4242", "agend") },
    ]);
    expect(keptCopies(join(prefix, "none"))).toEqual([]);
  });
  it("the npm prefix of a package root", () => {
    expect(npmPrefixOf("/Users/u/rh2264/prefix/lib/node_modules/@songsid/agend")).toBe("/Users/u/rh2264/prefix");
    expect(npmPrefixOf("C:\\npm\\node_modules\\@songsid\\agend")).toBe("C:/npm");
    expect(npmPrefixOf("/home/u/src/AgEnD")).toBeNull();
  });
});

describe("#2481 the records", () => {
  it("an attempt per `fleet start`, per version; READY records the version and drops the attempts; a stop drops them", () => {
    const home = scratch("home");
    recordStartAttempt(home, "2.2.6", NOW - 5000);
    recordStartAttempt(home, V, NOW - 2000);
    expect(recordStartAttempt(home, V, NOW)).toEqual({ version: V, attempts: [ago(2), ago(0)] });
    recordStarted(home, V, 77, NOW);
    expect(readStarted(home)).toEqual({ version: V, at: ago(0), pid: 77, history: [V] });
    expect(existsSync(join(home, ATTEMPTS_FILE))).toBe(false);
    recordStarted(home, "2.3.1", 78, NOW);
    expect(readStarted(home)!.history).toEqual(["2.3.1", V]);
    recordStartAttempt(home, "2.3.1", NOW);
    clearStartAttempts(home);
    expect(readAttempts(home)).toBeNull();
  });
  it("an unreadable record is none", () => {
    const home = scratch("bad");
    writeFileSync(join(home, STARTED_FILE), "{");
    writeFileSync(join(home, ATTEMPTS_FILE), JSON.stringify({ version: 3 }));
    expect(readStarted(home)).toBeNull();
    expect(readAttempts(home)).toBeNull();
  });
});

describe("#2481 the service manager, as it answers", () => {
  it("launchctl print (macOS 15, a crash-looping job — #2277 rehearsal)", () => {
    const out = "gui/501/com.agend.fleet = {\n\tactive count = 0\n\tpath = /Users/u/Library/LaunchAgents/com.agend.fleet.plist\n\ttype = LaunchAgent\n\tstate = spawn scheduled\n\n\tprogram = /x/node\n\truns = 6\n\tlast exit code = 1\n}\n";
    expect(parseLaunchctlPrint(out)).toEqual({ kind: "launchd", loaded: true, state: "spawn scheduled", runs: 6, lastExit: 1, pid: null });
    expect(parseLaunchctlPrint("\tstate = running\n\truns = 1\n\tpid = 4242\n\tlast exit code = (never exited)\n")).toMatchObject({ state: "running", pid: 4242, lastExit: null });
  });
  it("systemctl show", () => {
    expect(parseSystemctlShow("ActiveState=activating\nSubState=auto-restart\nResult=exit-code\nNRestarts=3\nExecMainStatus=1\n"))
      .toEqual({ kind: "systemd", active: "activating", sub: "auto-restart", result: "exit-code", restarts: 3, status: 1 });
  });
  it("which manager: launchd plist, system unit, user unit; none → undefined; unreadable → null; not loaded → loaded:false", () => {
    const home = scratch("mgr");
    expect(readManager(() => ({ status: 0, stdout: "" }), { platform: "darwin", home })).toBeUndefined();
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.agend.fleet.plist"), "<plist/>");
    const calls: string[][] = [];
    const run = (r: { status: number | null; stdout: string }) => (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return r; };
    expect(readManager(run({ status: 113, stdout: "" }), { platform: "darwin", home, uid: 501 })).toEqual({ kind: "launchd", loaded: false });
    expect(calls[0]).toEqual(["launchctl", "print", "gui/501/com.agend.fleet"]);
    expect(readManager(run({ status: 5, stdout: "" }), { platform: "darwin", home })).toBeNull();
    const linux = scratch("mgr-linux");
    if (!existsSync("/etc/systemd/system/agend.service")) {
      expect(readManager(run({ status: 0, stdout: "" }), { platform: "linux", home: linux })).toBeUndefined();
      mkdirSync(join(linux, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(join(linux, ".config", "systemd", "user", "com.agend.fleet.service"), "[Service]\n");
      calls.length = 0;
      expect(readManager(run({ status: 0, stdout: "ActiveState=failed\nResult=exit-code\n" }), { platform: "linux", home: linux })).toMatchObject({ active: "failed" });
      expect(calls[0]).toEqual(["systemctl", "--user", "show", "-p", "ActiveState,SubState,Result,NRestarts,ExecMainStatus", "com.agend.fleet"]);
    }
  });
  it("the launchd rule needs a non-zero last exit; the attempts or runs say it repeats", () => {
    expect(managerShowsLoop(LOADED({ lastExit: 1, runs: 1 }), 0)).toBe(false);
    expect(managerShowsLoop(LOADED({ lastExit: 1, runs: 3 }), 0)).toBe(true);
    expect(managerShowsLoop(LOADED({ lastExit: 0, runs: 9 }), 9)).toBe(false);
  });
});

describe("#2481 the macOS notification: once per version, from the 3rd attempt, never anywhere else", () => {
  it("posts once, records that it did, and never again for that version", () => {
    const home = scratch("notify");
    const launch = vi.fn((_cmd: string, _args: string[], _opts: unknown) => ({ on: () => undefined, unref: () => undefined }));
    let r = recordStartAttempt(home, V, NOW - 2);
    expect(notifyOnce(home, r, "darwin", launch)).toBe(false);
    recordStartAttempt(home, V, NOW - 1);
    r = recordStartAttempt(home, V, NOW);
    expect(notifyOnce(home, r, "darwin", launch)).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![1]).toEqual(["-e", `display notification "AgEnD v${V} is installed but the fleet fails to start. Run: agend doctor" with title "AgEnD"`]);
    r = recordStartAttempt(home, V, NOW + 1);
    expect(r.notified).toBe(true);
    expect(notifyOnce(home, r, "darwin", launch)).toBe(false);
    expect(notifyOnce(home, { version: "2.3.1", attempts: [ago(3), ago(2), ago(1)] }, "linux", launch)).toBe(false);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe("#2481 what the person reads", () => {
  const failure = { failing: true as const, version: V, detail: "launchd: exit 1, started 6 times", previous: { version: "2.2.6", copy: "/p/.agend-rollback/2.2.6-t/agend" } };
  it("the exact version and command to go back, the kept copy's path, and where the error is (en)", () => {
    expect(startFailureLines(failure, "/h")).toEqual([
      "⚠ AgEnD v2.3.0 is installed, but the fleet fails to start (launchd: exit 1, started 6 times).",
      "  To go back to v2.2.6: npm install -g @songsid/agend@2.2.6 && agend restart",
      "  The updater kept a copy of v2.2.6: /p/.agend-rollback/2.2.6-t/agend (nothing is restored automatically).",
      "  The error is at the end of /h/fleet.log. Please report it (agend doctor shows what to include): https://github.com/songsid/AgEnD/issues/new",
    ]);
    expect(startFailureLines({ ...failure, previous: null }, "/h")[1]).toBe("  To go back: npm install -g @songsid/agend@<the version you had before> && agend restart");
  });
  it("zh-TW, with the command untouched", () => {
    setLocale("zh-TW");
    const lines = startFailureLines(failure, "/h");
    expect(lines[0]).toBe("⚠ AgEnD v2.3.0 已安裝，但 fleet 無法啟動（launchd: exit 1, started 6 times）。");
    expect(lines[1]).toContain("npm install -g @songsid/agend@2.2.6 && agend restart");
  });
});

describe("#2481 the real CLI: the banner on a person's command, not on the fleet's own or on --json", () => {
  const VERSION = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string }).version;
  const cli = (home: string, ...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    encoding: "utf8", timeout: 60_000,
    env: { ...process.env, AGEND_HOME: home, HOME: home, AGEND_ALLOW_TEST_FLEET_CONTROL: "", NODE_ENV: "test" },
  });
  const failing = () => {
    const home = scratch("cli");
    writeFileSync(join(home, ATTEMPTS_FILE), JSON.stringify({ version: VERSION, attempts: [new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 60_000).toISOString(), new Date().toISOString()] }));
    return home;
  };
  it("`agend validate` on a host whose installed version keeps failing (no service: our attempts) prints it on stderr", { timeout: 90_000 }, () => {
    const r = cli(failing(), "validate");
    expect(r.stderr).toContain(`⚠ AgEnD v${VERSION} is installed, but the fleet fails to start (3 start attempts in the last 10 minutes, none completed).`);
    expect(r.stdout).not.toContain("fails to start");
  });
  it("nothing once that version has started; nothing for `fleet …` (the service's own) or --json", { timeout: 90_000 }, () => {
    const home = failing();
    expect(cli(home, "ls", "--json").stderr).not.toContain("fails to start");
    expect(cli(home, "fleet", "logs").stderr).not.toContain("fails to start");
    writeFileSync(join(home, STARTED_FILE), JSON.stringify({ version: VERSION, at: new Date().toISOString(), pid: 1, history: [VERSION] }));
    expect(cli(home, "validate").stderr).not.toContain("fails to start");
  });
});

describe("#2481 agend doctor: a FAIL row first in Service, with the way back and fleet.log's last lines", () => {
  it("failing: the error row; not failing: no row", async () => {
    const { collectDoctorReport } = await import("../src/doctor.js");
    const home = scratch("doctor");
    writeFileSync(join(home, "fleet.yaml"), "instances: {}\n");
    writeFileSync(join(home, "fleet.log"), "starting\nError: Cannot find module './x.js'\n    at boot\n");
    const deps = (failing: boolean) => ({
      env: {}, platform: "linux" as const, run: (() => ({ status: 0, stdout: "", stderr: "" })) as never, processAlive: () => false,
      connectSocket: async () => false, networkFamily: () => ({ autoSelectFamily: true, attemptTimeoutMs: 250 }),
      collectResources: async () => ({ disk: [], memory: null }) as never, fetchFleetHealth: async () => ({}),
      systemUnitPath: () => null, codexPackage: () => null,
      startFailure: () => (failing
        ? { failing: true as const, version: "2.3.0", detail: "launchd: exit 1, started 6 times", previous: { version: "2.2.6", copy: "/p/c" } }
        : { failing: false as const }),
    });
    const service = { installed: true, path: "/x.plist", manager: "launchd", enabled: true, active: true } as never;
    const report = await collectDoctorReport(home, service, deps(true));
    const row = report.checks.find(c => c.label === "Fleet start");
    expect(row).toMatchObject({ section: "Service", status: "error" });
    expect(row!.detail.split("\n")).toEqual([
      "AgEnD v2.3.0 is installed, but the fleet fails to start (launchd: exit 1, started 6 times).",
      "  To go back to v2.2.6: npm install -g @songsid/agend@2.2.6 && agend restart",
      "  The updater kept a copy of v2.2.6: /p/c (nothing is restored automatically).",
      `  The error is at the end of ${join(home, "fleet.log")}. Please report it (agend doctor shows what to include): https://github.com/songsid/AgEnD/issues/new`,
      "    | starting", "    | Error: Cannot find module './x.js'", "    |     at boot",
    ]);
    expect(report.checks.filter(c => c.section === "Service")[0]!.label).toBe("Fleet start");
    expect(report.errors).toBeGreaterThan(0);
    expect((await collectDoctorReport(home, service, deps(false))).checks.some(c => c.label === "Fleet start")).toBe(false);
  });
});

describe("#2481 start-attempt.ts, the first import of dist/cli.js", () => {
  const run = (home: string, argv: string[]) => spawnSync(process.execPath, ["--import", "tsx", "-e",
    `process.argv = [process.argv[0], "cli.js", ...${JSON.stringify(argv)}]; await import(${JSON.stringify(join(process.cwd(), "src/start-attempt.ts"))});`], {
    encoding: "utf8", timeout: 60_000, env: { ...process.env, AGEND_HOME: home },
  });
  it("records an attempt for `fleet start` only — and a failure to record never stops it", { timeout: 90_000 }, () => {
    const home = scratch("attempt");
    expect(run(home, ["fleet", "start"]).status).toBe(0);
    expect(readAttempts(home)?.attempts).toHaveLength(1);
    expect(run(home, ["fleet", "stop"]).status).toBe(0);
    expect(run(home, ["ls"]).status).toBe(0);
    expect(readAttempts(home)?.attempts).toHaveLength(1);
    const blocked = join(scratch("ro"), "home-is-a-file"); writeFileSync(blocked, "x");
    expect(run(blocked, ["fleet", "start"]).status).toBe(0);
  });
});

describe("#2481 `agend stop` is a deliberate stop: the attempts so far are not a crash loop", () => {
  it("clears them (a scratch home with no service and no fleet — nothing else is touched)", { timeout: 90_000 }, () => {
    const home = scratch("stop");
    recordStartAttempt(home, "2.3.0", Date.now());
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "stop"], {
      // Not from an agent session (the gate would refuse it, rightly); the test env's own gate is lifted for this scratch home.
      encoding: "utf8", timeout: 60_000, env: { ...process.env, AGEND_HOME: home, HOME: home, AGEND_ALLOW_TEST_FLEET_CONTROL: "1", AGEND_INSTANCE_NAME: "" },
    });
    expect(r.error).toBeUndefined();
    expect(r.stderr).not.toContain("Refusing");
    expect(readAttempts(home)).toBeNull();
  });
});

describe("#2481 no attempt of the installed version: nothing to judge, and no service manager is asked (Fable r2)", () => {
  it("a fresh or never-started home makes no call — every command's own call sequence stays as it was", () => {
    const VERSION = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string }).version;
    const home = scratch("gate");
    const run = vi.fn((_cmd: string, _args: string[]) => ({ status: 0, stdout: "" }));
    expect(checkStartFailure(home, Date.now(), run)).toEqual({ failing: false });
    recordStartAttempt(home, "0.0.1-other", Date.now() - 300_000);
    expect(checkStartFailure(home, Date.now(), run)).toEqual({ failing: false });
    expect(run).not.toHaveBeenCalled();
    // With an attempt of this version on record, the check goes on (its answer depends on this host's service).
    recordStartAttempt(home, VERSION, Date.now() - 300_000);
    expect(() => checkStartFailure(home, Date.now(), run)).not.toThrow();
  });
});
