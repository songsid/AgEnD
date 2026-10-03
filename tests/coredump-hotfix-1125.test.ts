/**
 * #1113 hotfix (beta.2 /update stuck): systemd 249 silently ignores
 * CoredumpFilter= in a unit file, so #1122's loaded-value gate refused every
 * `agend restart`, `/update` reported "fleet restart failed", and the fleet kept
 * running the previous version — which a second `/update` then called "already
 * up to date". (a) the gate is gone; (b) the fleet sets its own coredump_filter,
 * inherited by everything it starts; (c) `agend update` restarts a fleet that
 * predates the installed package.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { coredumpFilterLaunchPrefix, disableCoredumpMemory, limitFleetCoreDumps } from "../src/coredump-filter.js";
import { processStartMs, runningFleetPredatesInstall } from "../src/update-check.js";
import { renderSystemdUnit } from "../src/service-installer.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-1125-")); dirs.push(d); return d; };
const linux = process.platform === "linux" && existsSync("/proc/self/coredump_filter");
const cli = join(process.cwd(), "dist", "cli.js");
const builtFilter = join(process.cwd(), "dist", "coredump-filter.js");

describe("(b) the fleet sets its own coredump_filter", () => {
  it("writes 0, reports already/kept/unsupported/failed honestly", () => {
    const path = join(tmp(), "coredump_filter");
    writeFileSync(path, "00000033\n");
    expect(disableCoredumpMemory(path, "linux", {})).toBe("set");
    expect(readFileSync(path, "utf8")).toBe("0");
    expect(disableCoredumpMemory(path, "linux", {})).toBe("already");
    writeFileSync(path, "00000033\n");
    expect(disableCoredumpMemory(path, "linux", { AGEND_KEEP_COREDUMP_FILTER: "1" })).toBe("kept");
    expect(readFileSync(path, "utf8")).toBe("00000033\n");
    expect(disableCoredumpMemory(path, "darwin", {})).toBe("unsupported");
    expect(disableCoredumpMemory(join(tmp(), "missing"), "linux", {})).toBe("unsupported");
    // A file that ignores the write (as a kernel refusing it would).
    const stuck = join(tmp(), "stuck");
    writeFileSync(stuck, "00000033\n");
    chmodSync(stuck, 0o444);
    expect(disableCoredumpMemory(stuck, "linux", {})).toBe("failed");
    // A write that is accepted but does not take: verified by reading it back.
    expect(disableCoredumpMemory("/dev/null", "linux", {})).toBe("failed");
  });

  it.skipIf(!linux || !existsSync(builtFilter))("is inherited by a child process AND by a pane of a tmux server it starts (real /proc, real tmux)", () => {
    const dir = tmp();
    const paneOut = join(dir, "pane");
    const socket = `agend-1125-${process.pid}`;
    const script = `
      import { disableCoredumpMemory } from ${JSON.stringify(builtFilter)};
      import { execFileSync, spawnSync } from "node:child_process";
      const outcome = disableCoredumpMemory();
      const child = execFileSync("cat", ["/proc/self/coredump_filter"], { encoding: "utf8" }).trim();
      spawnSync("tmux", ["-L", ${JSON.stringify(socket)}, "new-session", "-d", "-s", "x",
        "sh -c 'cat /proc/self/coredump_filter > ${paneOut}; sleep 1'"]);
      console.log(JSON.stringify({ outcome, child }));
    `;
    try {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, AGEND_KEEP_COREDUMP_FILTER: "" } });
      expect(r.status, r.stderr).toBe(0);
      const got = JSON.parse(r.stdout.trim().split("\n").pop()!);
      expect(["set", "already"]).toContain(got.outcome);
      expect(got.child).toBe("00000000");
      for (let i = 0; i < 50 && !existsSync(paneOut); i++) spawnSync("sleep", ["0.1"]);
      expect(readFileSync(paneOut, "utf8").trim()).toBe("00000000");
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
    }
  });
});

describe("(b) every AgEnD CLI launch sets its own filter — even in a tmux server the fleet did not start (#1125 review)", () => {
  it("the prefix applies on Linux only and honours the opt-out", () => {
    expect(coredumpFilterLaunchPrefix("linux", {})).toBe("echo 0 2>/dev/null >/proc/self/coredump_filter; ");
    expect(coredumpFilterLaunchPrefix("linux", { AGEND_KEEP_COREDUMP_FILTER: "1" })).toBe("");
    expect(coredumpFilterLaunchPrefix("darwin", {})).toBe("");
  });

  it.skipIf(!existsSync(cli))("the daemon puts it in front of every launch command (built daemon.js)", () => {
    const daemon = readFileSync(join(process.cwd(), "dist", "daemon.js"), "utf8");
    expect(daemon).toMatch(/const cmd = coredumpFilterLaunchPrefix\(\) \+ `\$\{envPrefix\} ` \+ this\.backend\.buildCommand\(launchConfig\);/);
  });

  // A server that already existed with the default (0x33) filter — the
  // default socket may hold the user's own session, which AgEnD reuses and
  // never kills. Real tmux, private socket; dash and bash as default-shell.
  it.skipIf(!linux)("a new pane of an EXISTING 0x33 server gets 0 with the prefix, 0x33 without (real tmux)", () => {
    const dir = tmp();
    const sock = join(dir, "sock");
    const tm = (...args: string[]) => spawnSync("tmux", ["-S", sock, ...args], { encoding: "utf8" });
    // Start the server from a shell whose filter is the kernel default.
    spawnSync("sh", ["-c", `echo 0x33 > /proc/self/coredump_filter; exec tmux -S '${sock}' new-session -d -s user 'sleep 60'`]);
    try {
      for (const shell of ["/bin/dash", "/bin/bash"].filter(existsSync)) {
        tm("set-option", "-g", "default-shell", shell);
        const withPrefix = join(dir, `with-${shell.split("/").pop()}`);
        const without = join(dir, `without-${shell.split("/").pop()}`);
        tm("new-window", "-d", `${coredumpFilterLaunchPrefix("linux", {})}cat /proc/self/coredump_filter > ${withPrefix}; sleep 1`);
        tm("new-window", "-d", `cat /proc/self/coredump_filter > ${without}; sleep 1`);
        const written = (f: string) => existsSync(f) && readFileSync(f, "utf8").trim() !== "";
        for (let i = 0; i < 50 && !(written(withPrefix) && written(without)); i++) spawnSync("sleep", ["0.1"]);
        expect(readFileSync(without, "utf8").trim(), `${shell}: the server's own filter`).toBe("00000033");
        expect(readFileSync(withPrefix, "utf8").trim(), `${shell}: the launch prefix`).toBe("00000000");
      }
    } finally {
      tm("kill-server");
    }
  });
});

describe("(b) the fleet start-up step", () => {
  it("logs the outcome; only a failed write is an error", () => {
    const run = (outcome: ReturnType<typeof disableCoredumpMemory>) => {
      const info: string[] = []; const error: string[] = [];
      limitFleetCoreDumps({ info: m => info.push(m), error: m => error.push(m) }, () => outcome);
      return { info, error };
    };
    expect(run("set").info).toEqual([expect.stringContaining("coredump_filter=0")]);
    expect(run("already").info).toHaveLength(1);
    expect(run("failed").error).toEqual([expect.stringContaining("#1113")]);
    expect(run("kept")).toEqual({ info: [], error: [] });
    expect(run("unsupported")).toEqual({ info: [], error: [] });
  });

  // Starting a real fleet is off the table (it joins whatever tmux server it
  // reaches and cleans it up), so the wiring is checked in the BUILT CLI: the
  // singleton claim every fleet start goes through calls the step after taking
  // the lock and before returning — i.e. before FleetManager spawns anything.
  it.skipIf(!existsSync(cli))("every fleet start goes through it: the built CLI calls it inside claimFleetSingleton, after the lock", () => {
    const text = readFileSync(cli, "utf8");
    const body = /function claimFleetSingleton\(\) \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? "";
    expect(body).toMatch(/setProcessFleetLock\(acquireFleetLock[\s\S]*limitFleetCoreDumps\([\s\S]*return true;/);
    // Both fleet entry points (fleet start, and the restart-with-new-code path) claim first.
    expect(text.match(/if \(!claimFleetSingleton\(\)\)\s*return;\s*const \{ FleetManager \}/g)?.length).toBe(2);
  });
});

describe("(c) a fleet that predates the installed package", () => {
  it("is detected from its start time; unknown is never a restart", () => {
    const installed = Date.parse("2026-10-03T04:27:39Z");
    const started = (ms: number | null) => () => ms;
    const fleet = () => true;
    expect(runningFleetPredatesInstall({ pid: 42, installedAtMs: installed, processStartMs: started(installed - 60_000), isFleetProcess: fleet })).toBe(true);
    expect(runningFleetPredatesInstall({ pid: 42, installedAtMs: installed, processStartMs: started(installed + 60_000), isFleetProcess: fleet })).toBe(false);
    // Within the margin: a fleet restarted right as the package landed.
    expect(runningFleetPredatesInstall({ pid: 42, installedAtMs: installed, processStartMs: started(installed - 1_000), isFleetProcess: fleet })).toBe(false);
    expect(runningFleetPredatesInstall({ pid: null, installedAtMs: installed, processStartMs: started(0), isFleetProcess: fleet })).toBe(false);
    expect(runningFleetPredatesInstall({ pid: 42, installedAtMs: installed, processStartMs: started(null), isFleetProcess: fleet })).toBe(false);
    expect(runningFleetPredatesInstall({ pid: 42, installedAtMs: Number.NaN, processStartMs: started(0), isFleetProcess: fleet })).toBe(false);
    // Not confirmed to be a fleet (recycled/unrelated pid, unreadable command line): never.
    expect(runningFleetPredatesInstall({ pid: 42, installedAtMs: installed, processStartMs: started(installed - 60_000), isFleetProcess: () => false })).toBe(false);
  });

  it("reads a real process start time; a missing pid is null", () => {
    const self = processStartMs(process.pid);
    expect(self).not.toBeNull();
    expect(self!).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(self!).toBeGreaterThan(Date.now() - 24 * 3_600_000);
    expect(processStartMs(2 ** 22 + 12345)).toBeNull();
  });
});

/**
 * A live process whose command line is `argv0` (`exec -a`), double-forked so
 * it is NOT this test's child: a fleet under systemd is nobody's child here,
 * and a signalled child of ours would linger as a zombie that still "exists".
 */
function startOrphan(argv0: string, script?: string): number {
  const body = script === undefined ? "sleep 300" : `bash -c ${JSON.stringify(script)}`;
  const r = spawnSync("bash", ["-c", `(exec -a ${JSON.stringify(argv0)} ${body} </dev/null >/dev/null 2>&1 &) ; sleep 0.2; pgrep -n -f ${JSON.stringify(`^${argv0}`)}`], { encoding: "utf8" });
  const pid = Number.parseInt(r.stdout.trim(), 10);
  if (!Number.isInteger(pid)) throw new Error(`could not start ${argv0}: ${r.stderr}`);
  return pid;
}

describe("`agend update` when the package is already current (built CLI copy, stubbed npm + systemctl)", () => {
  /** A live process whose command line reads like a fleet (`exec -a`), or not. */
  function liveProcess(argv0: string): { pid: number; stop(): void } {
    const pid = startOrphan(argv0);
    return { pid, stop: () => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } };
  }

  /**
   * Runs `agend update --beta` from a fresh COPY of dist/: its cli.js mtime is
   * "now", so a process started before the copy predates the install.
   */
  function update(fleetPid: number | null) {
    const home = tmp();
    const agendHome = join(home, ".agend");
    mkdirSync(agendHome, { recursive: true });
    if (fleetPid !== null) writeFileSync(join(agendHome, "fleet.pid"), `${fleetPid}\n`);
    spawnSync("sleep", ["2.5"]); // past the 2 s margin
    const pkg = join(home, "pkg");
    mkdirSync(pkg);
    spawnSync("cp", ["-r", join(process.cwd(), "dist"), join(pkg, "dist")]);
    spawnSync("cp", ["-r", join(process.cwd(), "templates"), join(pkg, "templates")]);
    spawnSync("cp", [join(process.cwd(), "package.json"), join(pkg, "package.json")]);
    symlinkSync(join(process.cwd(), "node_modules"), join(pkg, "node_modules"));
    const unitDir = join(home, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "com.agend.fleet.service"), renderSystemdUnit({
      label: "com.agend.fleet", execPath: "/usr/local/bin/agend", workingDirectory: agendHome,
      logPath: join(agendHome, "daemon.log"), path: "/usr/bin:/bin",
    }));
    const bin = join(home, "bin");
    mkdirSync(bin);
    const log = join(home, "calls.log");
    writeFileSync(log, "");
    const version = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version;
    writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> '${log}'\ncase "$*" in view*) echo '${version}';; esac\nexit 0\n`);
    // systemd 249 as observed: CoredumpFilter stays 0x33 whatever the unit file says.
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh
echo "systemctl $*" >> '${log}'
case "$*" in *is-active*) echo active;; esac
case "$*" in *"show -p KillMode --value"*) echo mixed;; esac
case "$*" in *"show -p CoredumpFilter --value"*) echo 0x33;; esac
exit 0
`);
    chmodSync(join(bin, "npm"), 0o755);
    chmodSync(join(bin, "systemctl"), 0o755);
    const r = spawnSync(process.execPath, [join(pkg, "dist", "cli.js"), "update", "--beta"], {
      env: { ...process.env, AGEND_ALLOW_TEST_FLEET_CONTROL: "1", AGEND_INSTANCE_NAME: "", HOME: home, AGEND_HOME: agendHome, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8", timeout: 60_000,
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    return { r, calls, out: `${r.stdout}\n${r.stderr}`, restarted: calls.some(c => /^systemctl --user restart com\.agend\.fleet/.test(c)) };
  }

  it.skipIf(!existsSync(cli) || !linux)("restarts a confirmed fleet that started before the install — and a loaded CoredumpFilter=0x33 no longer blocks it", () => {
    const fleet = liveProcess("node /opt/agend/bin/agend fleet start");
    try {
      const { r, out, calls, restarted } = update(fleet.pid);
      expect(restarted, `${out}\n${calls.join("\n")}`).toBe(true);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("the running fleet started before it was");
      expect(calls.some(c => c.startsWith("npm install"))).toBe(false); // nothing to install
    } finally { fleet.stop(); }
  });

  it.skipIf(!existsSync(cli) || !linux)("never restarts for an old process that is NOT a fleet: recycled or unrelated pid in a stale fleet.pid (#1125 review)", () => {
    const stranger = liveProcess("node /home/u/some-other-tool.js serve");
    try {
      const { r, out, restarted } = update(stranger.pid);
      expect(restarted, out).toBe(false);
      expect(r.stdout).toContain("Already up to date");
      expect(r.stdout).not.toContain("the running fleet started before it was");
    } finally { stranger.stop(); }
    // pid 1 (init) predates everything and is alive — still not a fleet.
    expect(update(1).restarted).toBe(false);
  });

  it.skipIf(!existsSync(cli))("leaves a fleet that is already running the installed code alone; no fleet → nothing", () => {
    expect(update(process.pid).restarted).toBe(false); // the test runner: not a fleet, and newer anyway
    expect(update(null).restarted).toBe(false);
    expect(update(2 ** 22 + 4321).restarted).toBe(false); // a pid that does not exist
  });
});

describe("detached `agend restart` signals only a confirmed fleet (built CLI; `agend` stubbed so no fleet starts)", () => {
  function detachedRestart(argv0: string | null, script?: string) {
    const home = tmp();
    const agendHome = join(home, ".agend");
    mkdirSync(agendHome, { recursive: true });
    const proc = argv0 === null ? null : { pid: startOrphan(argv0, script) };
    if (proc) writeFileSync(join(agendHome, "fleet.pid"), `${proc.pid}\n`);
    const bin = join(home, "bin");
    mkdirSync(bin);
    const log = join(home, "calls.log");
    writeFileSync(log, "");
    // The detached branch would `sh -c "agend fleet start"`: never a real fleet here.
    writeFileSync(join(bin, "agend"), `#!/bin/sh\necho "agend $*" >> '${log}'\nexit 0\n`);
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh\nexit 1\n`);
    chmodSync(join(bin, "agend"), 0o755);
    chmodSync(join(bin, "systemctl"), 0o755);
    const r = spawnSync(process.execPath, [cli, "restart"], {
      env: { ...process.env, AGEND_ALLOW_TEST_FLEET_CONTROL: "1", AGEND_INSTANCE_NAME: "", HOME: home, AGEND_HOME: agendHome, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8", timeout: 60_000,
    });
    spawnSync("sleep", ["0.5"]);
    let alive = false;
    if (proc) { try { process.kill(proc.pid!, 0); alive = true; } catch { alive = false; } }
    if (proc) { try { process.kill(proc.pid!, "SIGKILL"); } catch { /* gone */ } }
    return { r, alive, calls: readFileSync(log, "utf8"), pidFileLeft: existsSync(join(agendHome, "fleet.pid")) };
  }

  it.skipIf(!existsSync(cli) || !linux || process.env.AGEND_SYSTEMD_UNIT_PRESENT === "1")("an unrelated process named by a stale fleet.pid is never signalled", () => {
    const res = detachedRestart("node /home/u/some-other-tool.js serve");
    expect(res.alive, `${res.r.stdout}${res.r.stderr}`).toBe(true);
    expect(res.calls).not.toContain("agend fleet start");
    expect(res.pidFileLeft).toBe(false); // treated as a stale pid file
  });

  it.skipIf(!existsSync(cli) || !linux || process.env.AGEND_SYSTEMD_UNIT_PRESENT === "1")("a confirmed detached fleet is stopped and started again", () => {
    const res = detachedRestart("node /opt/agend/bin/agend fleet start");
    expect(res.alive, `${res.r.stdout}${res.r.stderr}`).toBe(false);
    expect(res.calls).toContain("agend fleet start");
  });

  // Both wait out the ~10 s SIGTERM grace period.
  it.skipIf(!existsSync(cli) || !linux || process.env.AGEND_SYSTEMD_UNIT_PRESENT === "1")("a fleet that ignores SIGTERM is SIGKILLed", () => {
    const res = detachedRestart("node /opt/agend/bin/agend fleet start", "trap '' TERM; while :; do sleep 0.1; done");
    expect(res.alive, `${res.r.stdout}${res.r.stderr}`).toBe(false);
    expect(res.calls).toContain("agend fleet start");
  }, 60_000);

  it.skipIf(!existsSync(cli) || !linux || process.env.AGEND_SYSTEMD_UNIT_PRESENT === "1")("the pid is re-confirmed before SIGKILL: one that stopped being the fleet is left alone", () => {
    // On SIGTERM the same pid becomes an unrelated process — a pid reused
    // during the grace period, without the race.
    const res = detachedRestart("node /opt/agend/bin/agend fleet start", "trap 'exec -a reused-by-another-tool sleep 300' TERM; while :; do sleep 0.1; done");
    expect(res.alive, `${res.r.stdout}${res.r.stderr}`).toBe(true);
  }, 60_000);
});

/**
 * Opt-in (`AGEND_SYSTEMD_E2E=1`, a user systemd): the template loaded as a REAL
 * unit file by the user manager — the one check that tells a directive systemd
 * applies from one it silently ignores (systemd 249 ignores CoredumpFilter= in
 * a unit file; stubs, `systemd-analyze verify` and transient `systemd-run -p`
 * all said otherwise). Every directive `agend restart` gates on must load from
 * the file; the dump size must come from the fleet's own coredump_filter.
 * Throwaway unit in the user unit dir under a unique name, removed after; never
 * a shared service.d.
 */
describe.skipIf(process.env.AGEND_SYSTEMD_E2E !== "1" || !linux || !existsSync(builtFilter))("real user unit file (opt-in)", () => {
  /** Directives whose LOADED value `agend restart` refuses to restart without. */
  const GATED = { KillMode: "mixed" } as const;

  it("gated directives load from the unit file, and the fleet's own filter reaches its children", () => {
    const dir = tmp();
    const name = `agend-1125-e2e-${process.pid}`;
    const unitPath = join(process.env.HOME!, ".config", "systemd", "user", `${name}.service`);
    const childOut = join(dir, "child-filter");
    const launcher = join(dir, "launcher.mjs");
    writeFileSync(launcher, `
      import { disableCoredumpMemory } from ${JSON.stringify(builtFilter)};
      import { execFileSync } from "node:child_process";
      import { writeFileSync } from "node:fs";
      disableCoredumpMemory();
      writeFileSync(${JSON.stringify(childOut)}, execFileSync("cat", ["/proc/self/coredump_filter"], { encoding: "utf8" }));
      setInterval(() => {}, 1000);
    `);
    const exec = join(dir, "agend");
    writeFileSync(exec, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(launcher)}\n`);
    chmodSync(exec, 0o755);
    writeFileSync(unitPath, renderSystemdUnit({ label: name, execPath: exec, workingDirectory: dir, logPath: join(dir, "log"), path: "/usr/bin:/bin" }));
    const sc = (...args: string[]) => spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
    try {
      expect(sc("daemon-reload").status).toBe(0);
      for (const [key, value] of Object.entries(GATED)) {
        expect(sc("show", "-p", key, "--value", name).stdout.trim(), `${key} must load from a unit file to be gated on`).toBe(value);
      }
      sc("start", "--no-block", name);
      for (let i = 0; i < 100 && !existsSync(childOut); i++) spawnSync("sleep", ["0.1"]);
      expect(readFileSync(childOut, "utf8").trim()).toBe("00000000");
    } finally {
      sc("stop", name);
      rmSync(unitPath, { force: true });
      sc("daemon-reload");
      sc("reset-failed", name);
    }
  }, 60_000);
});

/**
 * The upgrade the stranded users take: an older `agend update` (beta.2, which
 * still has the gate) installs the new version and runs the restart through
 * the FRESHLY INSTALLED binary (`which agend`), never through itself. So the
 * restart that has to get past systemd 249's ignored CoredumpFilter is the new
 * code's — the one without the gate — and the update lands in one go.
 */
describe("upgrade path: the restart runs through the newly installed binary (built CLI, stubbed npm/agend/systemctl)", () => {
  it.skipIf(!existsSync(cli))("installs, then `<installed agend> restart` restarts the fleet despite a loaded CoredumpFilter=0x33", () => {
    const home = tmp();
    const agendHome = join(home, ".agend");
    mkdirSync(agendHome, { recursive: true });
    const unitDir = join(home, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "com.agend.fleet.service"), renderSystemdUnit({
      label: "com.agend.fleet", execPath: "/usr/local/bin/agend", workingDirectory: agendHome,
      logPath: join(agendHome, "daemon.log"), path: "/usr/bin:/bin",
    }));
    const bin = join(home, "bin");
    mkdirSync(bin);
    const log = join(home, "calls.log");
    writeFileSync(log, "");
    // npm: a newer version is published; install is a no-op that "lands" it.
    writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> '${log}'\ncase "$*" in view*) echo '99.0.0-beta.3';; "config get prefix") echo '${home}';; esac\nexit 0\n`);
    // `agend` on PATH = the freshly installed binary: this build.
    writeFileSync(join(bin, "agend"), `#!/bin/sh\necho "agend $*" >> '${log}'\nexec '${process.execPath}' '${cli}' "$@"\n`);
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh
echo "systemctl $*" >> '${log}'
case "$*" in *is-active*) echo active;; esac
case "$*" in *"show -p KillMode --value"*) echo mixed;; esac
case "$*" in *"show -p CoredumpFilter --value"*) echo 0x33;; esac
exit 0
`);
    for (const f of ["npm", "agend", "systemctl"]) chmodSync(join(bin, f), 0o755);
    const r = spawnSync(process.execPath, [cli, "update", "--beta"], {
      env: { ...process.env, AGEND_ALLOW_TEST_FLEET_CONTROL: "1", AGEND_INSTANCE_NAME: "", HOME: home, AGEND_HOME: agendHome, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8", timeout: 120_000,
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    const out = `${r.stdout}\n${r.stderr}\n${calls.join("\n")}`;
    expect(calls.some(c => c.startsWith("npm install -g @songsid/agend@beta")), out).toBe(true);
    const installedRestart = calls.findIndex(c => c === "agend restart");
    expect(installedRestart, out).toBeGreaterThan(calls.findIndex(c => c.startsWith("npm install")));
    expect(calls.findIndex(c => c.startsWith("systemctl --user restart com.agend.fleet")), out).toBeGreaterThan(installedRestart);
    expect(r.status, out).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toContain("Not restarting");
  });
});
