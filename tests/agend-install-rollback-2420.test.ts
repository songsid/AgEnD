/**
 * #2420: an update whose new service does not come up goes back — the previous package, its service definition and the
 * previous service — as the 2.2 updater's C6 rollback did. Fable's repro: under a systemctl shim that turns the first
 * restart of com.agend.fleet into a stop + exit 1, the 2.3 installer left the fleet stopped on the new version.
 *
 * The installer's own logic in a scratch prefix and AGEND_HOME: npm is a stub that replaces the package the way npm
 * does (package dir and bin links), and systemd / launchd are a fake manager that keeps the unit's state. The real
 * managers are covered by the rehearsal legs (systemd user and system, launchd on a real Mac).
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..");
const installer = createRequire(import.meta.url)("../launcher/agend-install.cjs") as { main(argv: string[], deps: Record<string, unknown>): number };
const lockReaders = createRequire(import.meta.url)("../launcher/install-admission.cjs") as Record<string, unknown>;
const NEW = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }).version;
const OLD = "2.3.0-beta.1";
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

type Kind = "user" | "system" | "launchd";
interface RigOpts {
  kind: Kind | null;
  /** The fleet runs before the update (pid 9191). */
  running?: boolean;
  /** What the new release's `agend <args>` does: its exit status, and what it leaves the manager in. */
  agend?: (args: string[], m: Manager) => number;
  /** `systemctl show` / `launchctl print` cannot be read. */
  unreadable?: boolean;
  /** `systemctl stop` / `launchctl bootout` leaves the service still activating. */
  stopSticks?: boolean;
  /** The previous service fails its start too. */
  startFails?: boolean;
  previous?: boolean;
  /** What a settled stop leaves: a unit whose fleet exited on its own stays `failed` (default inactive). */
  stopLeaves?: "inactive" | "failed";
  /** The restored `agend` does not answer --version. */
  restoredMute?: boolean;
}
interface Manager {
  state: "active" | "inactive" | "failed" | "activating"; pid: number; loaded: boolean; nextPid: number; printsLoadedAfterBootout: number;
  /** The fleet the manager runs now (0: none) — the one before it exits. */
  setFleet(pid: number): void;
}

function pkg(dir: string, version: string, bins: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@songsid/agend", version, bin: bins }));
  for (const b of Object.values(bins)) { mkdirSync(join(dir, b, ".."), { recursive: true }); writeFileSync(join(dir, b), `${version}\n`); }
  // The bundled runtime, its receipt and key live in the package (#1450): they go back with it.
  mkdirSync(join(dir, "node_modules", "runtime"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "runtime", "node"), `node for ${version}\n`);
  writeFileSync(join(dir, ".agend-runtime-receipt.json"), `receipt ${version}\n`);
}
const OLD_BINS = { agend: "launcher/agend", "agend-agent": "launcher/agend-agent" };
const NEW_BINS = { agend: "launcher/agend", "agend-agent": "launcher/agend-agent", "agend-install": "launcher/agend-install.cjs" };

function rig(o: RigOpts) {
  const root = mkdtempSync(join(tmpdir(), "agend-2420-")); roots.push(root);
  const prefix = join(root, "prefix"), nodeModules = join(prefix, "lib", "node_modules"), home = join(root, "agend-home"), userHome = join(root, "user-home");
  for (const d of [nodeModules, home, userHome, join(prefix, "bin")]) mkdirSync(d, { recursive: true });
  const pkgDir = join(nodeModules, "@songsid", "agend");
  const link = (bins: Record<string, string>) => {
    for (const [name, rel] of Object.entries(bins)) {
      try { rmSync(join(prefix, "bin", name)); } catch { /* none */ }
      symlinkSync(join("..", "lib", "node_modules", "@songsid", "agend", rel), join(prefix, "bin", name));
    }
  };
  if (o.previous !== false) { pkg(pkgDir, OLD, OLD_BINS); link(OLD_BINS); }
  const systemUnit = join(root, "etc-agend.service");
  const file = o.kind === "system" ? systemUnit
    : o.kind === "user" ? join(userHome, ".config", "systemd", "user", "com.agend.fleet.service")
    : o.kind === "launchd" ? join(userHome, "Library", "LaunchAgents", "com.agend.fleet.plist") : null;
  const oldDefinition = o.kind === "launchd" ? "<plist>old</plist>\n" : "[Service]\nExecStart=/old/agend fleet start\n";
  if (file) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, oldDefinition); }
  const live = new Set<number>([4242]);
  const setFleet = (pid: number) => {
    if (m.pid) live.delete(m.pid);
    m.pid = pid;
    if (pid) { live.add(pid); writeFileSync(join(home, "fleet.pid"), String(pid)); }
  };
  const m: Manager = { state: o.running ? "active" : "inactive", pid: 0, loaded: o.kind === "launchd", nextPid: 7000, printsLoadedAfterBootout: 0, setFleet };
  if (o.running) setFleet(9191);
  writeFileSync(join(home, "fleet.yaml"), "instances: {}\n");
  const calls: string[] = [], log: string[] = [];
  const ok = (stdout = "") => ({ status: 0, signal: null, stdout, stderr: "" });
  const run = (cmd: string, args: string[]) => {
    const line = `${cmd} ${args.join(" ")}`;
    if (line === "npm root -g") return ok(nodeModules + "\n");
    if (line === "npm prefix -g") return ok(prefix + "\n");
    if (line === "ps -A -o pid=,ppid=,args=") return ok("4242 1 node agend-install.cjs\n");
    if (cmd === "npm" && args[0] === "install") {
      calls.push(line);
      // As npm does: the package replaced, its bins linked.
      rmSync(pkgDir, { recursive: true, force: true });
      pkg(pkgDir, NEW, NEW_BINS); link(NEW_BINS);
      return ok();
    }
    if (cmd === join(prefix, "bin", "agend")) {
      if (args[0] === "--version") {
        try {
          const v = readFileSync(realpathSync(cmd), "utf8");
          return o.restoredMute && v.trim() === OLD && calls.length > 0 ? { status: 1, signal: null, stdout: "", stderr: "" } : ok(v);
        } catch { return { status: 127, signal: null, stdout: "", stderr: "" }; }
      }
      calls.push(`agend ${args.join(" ")}`);
      if (args[0] === "install" && file) writeFileSync(file, o.kind === "launchd" ? "<plist>new</plist>\n" : "[Service]\nExecStart=/new/agend fleet start\n");
      if (args[0] === "install" && o.kind === "launchd") writeFileSync(join(home, "service-plan.json"), "{}");
      return { status: o.agend ? o.agend(args, m) : 0, signal: null, stdout: "", stderr: "" };
    }
    calls.push(line);
    if (cmd === "systemctl") {
      const verb = args.filter(a => a !== "--user")[0];
      if (verb === "show") {
        if (o.unreadable) return { status: 1, signal: null, stdout: "", stderr: "Failed to connect to bus" };
        return ok(`ActiveState=${m.state}\nSubState=${m.state === "active" ? "running" : "dead"}\nMainPID=${m.pid}\nNeedDaemonReload=no\n`);
      }
      if (verb === "stop") { if (o.stopSticks) { m.state = "activating"; return ok(); } m.state = o.stopLeaves ?? "inactive"; setFleet(0); return ok(); }
      if (verb === "start") {
        if (o.startFails) { m.state = "failed"; return { status: 1, signal: null, stdout: "", stderr: "" }; }
        m.state = "active"; setFleet(m.nextPid++); return ok();
      }
      return ok();
    }
    if (cmd === "launchctl") {
      if (args[0] === "print") {
        if (o.unreadable) return { status: 5, signal: null, stdout: "", stderr: "" };
        if (m.printsLoadedAfterBootout > 0) { m.printsLoadedAfterBootout--; return ok(`state = running\n\tpid = ${m.pid}\n`); }
        if (!m.loaded) return { status: 113, signal: null, stdout: "", stderr: "Could not find service" };
        return ok(m.pid ? `\tstate = running\n\tpid = ${m.pid}\n` : "\tstate = not running\n");
      }
      if (args[0] === "bootout") {
        if (o.stopSticks) return ok();
        // launchd answers before the job is gone (macOS 15): the next print still finds it.
        m.printsLoadedAfterBootout = 1; m.loaded = false; setFleet(0); return ok();
      }
      if (args[0] === "bootstrap") {
        if (o.startFails) return { status: 5, signal: null, stdout: "", stderr: "Input/output error" };
        m.loaded = true; setFleet(m.nextPid++); return ok();
      }
      return ok();
    }
    return ok();
  };
  let clock = 0;
  const deps = {
    pid: 4242, uid: 501, now: () => Date.now(), log: (l: string) => log.push(l), alive: (pid: number) => live.has(pid),
    env: { HOME: userHome, AGEND_HOME: home, XDG_RUNTIME_DIR: "/run/user/501" }, systemUnit,
    lockReaders: { ...lockReaders, processStart: () => null, startTicks: () => null, bootId: () => null },
    run, sleep: () => { clock += 100; }, monotonicNow: () => clock,
  };
  const version = () => { try { return readFileSync(realpathSync(join(prefix, "bin", "agend")), "utf8").trim(); } catch { return null; } };
  const links = () => Object.fromEntries(readdirSync(join(prefix, "bin")).map(n => [n, lstatSync(join(prefix, "bin", n)).isSymbolicLink() ? readlinkSync(join(prefix, "bin", n)) : "file"]));
  const rollbackDir = () => { const d = join(prefix, ".agend-rollback"); return existsSync(d) ? readdirSync(d) : []; };
  const main = () => installer.main(["--upgrade", "--spec", `@songsid/agend@${NEW}`], deps);
  return { root, prefix, pkgDir, home, file, oldDefinition, m, calls, log, deps, version, links, rollbackDir, main, live };
}

/** Fable's shim: the first restart of the unit becomes a stop, and systemctl exits 1 (what `agend restart` reports as 1). */
const shimRestart = (args: string[], m: Manager) => {
  if (args[0] !== "restart") return 0;
  m.state = "inactive"; m.setFleet(0);
  return 1;
};
const failure = (r: ReturnType<typeof rig>) => r.log.filter(l => l.startsWith("  ✗")).join("\n");
const manager = (r: ReturnType<typeof rig>) => r.calls.filter(c => c.startsWith("systemctl") || c.startsWith("launchctl"));
const OLD_LINKS = { agend: "../lib/node_modules/@songsid/agend/launcher/agend", "agend-agent": "../lib/node_modules/@songsid/agend/launcher/agend-agent" };

describe("#2420 a new service that does not come up: the previous package, unit and service come back", () => {
  it.each([["user", "--user ", "com.agend.fleet"], ["system", "", "agend"]] as const)("systemd %s unit, Fable's shim (restart → stop + exit 1): stopped, restored, reloaded, the previous service started", (kind, scope, unit) => {
    const r = rig({ kind, running: true, agend: shimRestart });
    expect(r.main()).toBe(1);
    expect(r.calls.filter(c => c.startsWith("agend"))).toEqual(["agend install --no-activate", "agend restart --yes"]);
    expect(manager(r)).toEqual([
      `systemctl ${scope}show -p ActiveState -p SubState -p MainPID -p NeedDaemonReload ${unit}`,
      `systemctl ${scope}stop ${unit}`,
      `systemctl ${scope}show -p ActiveState -p SubState -p MainPID -p NeedDaemonReload ${unit}`,
      `systemctl ${scope}daemon-reload`,
      `systemctl ${scope}show -p ActiveState -p SubState -p MainPID -p NeedDaemonReload ${unit}`,
      `systemctl ${scope}reset-failed ${unit}`,
      `systemctl ${scope}start ${unit}`,
      `systemctl ${scope}show -p ActiveState -p SubState -p MainPID -p NeedDaemonReload ${unit}`,
    ]);
    expect(r.version()).toBe(OLD);
    expect(readFileSync(join(r.pkgDir, ".agend-runtime-receipt.json"), "utf8")).toBe(`receipt ${OLD}\n`);
    expect(readFileSync(join(r.pkgDir, "node_modules", "runtime", "node"), "utf8")).toBe(`node for ${OLD}\n`);
    expect(r.links()).toEqual(OLD_LINKS);   // agend-install (only the new release has it) is gone
    expect(readFileSync(r.file!, "utf8")).toBe(r.oldDefinition);
    expect(r.m).toMatchObject({ state: "active", pid: 7000 });
    expect(readFileSync(join(r.home, "fleet.pid"), "utf8")).toBe("7000");
    expect(failure(r)).toContain(`the fleet did not restart onto v${NEW} (exit 1). Rolled back: the previous package (v${OLD}) and the ${kind} unit ${unit} were restored; the previous service is running (pid 7000). The update did not succeed`);
    expect(r.rollbackDir()).toEqual([]);
  });

  it("launchd: the new release's activation left a job running (a new pid) — booted out (waited for), restored, plan removed, the previous job bootstrapped", () => {
    const r = rig({ kind: "launchd", running: true, agend: (args, m) => {
      if (args[0] !== "restart") return 0;
      // `agend restart`'s planned activation failed and put the previous plist's job back — over the NEW package.
      m.setFleet(5555); return 1;
    } });
    expect(r.main()).toBe(1);
    expect(manager(r)).toEqual([
      "launchctl print gui/501/com.agend.fleet",
      "launchctl bootout gui/501/com.agend.fleet",
      "launchctl print gui/501/com.agend.fleet",   // still there: launchd answers before the job is gone
      "launchctl print gui/501/com.agend.fleet",
      `launchctl bootstrap gui/501 ${r.file}`,
      "launchctl print gui/501/com.agend.fleet",
    ]);
    expect(r.version()).toBe(OLD);
    expect(readFileSync(r.file!, "utf8")).toBe(r.oldDefinition);
    expect(existsSync(join(r.home, "service-plan.json"))).toBe(false);
    expect(failure(r)).toContain(`Rolled back: the previous package (v${OLD}) and the launchd job com.agend.fleet were restored; the previous service is running (pid 7000)`);
    expect(r.rollbackDir()).toEqual([]);
  });

  it.each(["user", "launchd"] as const)("%s: a failure that never stopped the fleet (same pid runs): package and definition back, nothing stopped or started", kind => {
    const r = rig({ kind, running: true, agend: args => (args[0] === "restart" ? 1 : 0) });
    expect(r.main()).toBe(1);
    expect(manager(r)).toEqual(kind === "user" ? ["systemctl --user daemon-reload", "systemctl --user show -p ActiveState -p SubState -p MainPID -p NeedDaemonReload com.agend.fleet"] : []);
    expect(r.version()).toBe(OLD);
    expect(readFileSync(r.file!, "utf8")).toBe(r.oldDefinition);
    expect(failure(r)).toContain("the previous service was never stopped and still runs (pid 9191)");
  });

  it("the refresh itself fails (`install --no-activate` exit 1): rolled back the same way; no restart is attempted", () => {
    const r = rig({ kind: "user", running: true, agend: args => (args[0] === "install" ? 1 : 0) });
    expect(r.main()).toBe(1);
    expect(r.calls.filter(c => c.startsWith("agend"))).toEqual(["agend install --no-activate"]);
    expect(r.version()).toBe(OLD);
    expect(readFileSync(r.file!, "utf8")).toBe(r.oldDefinition);
    expect(failure(r)).toContain("could not refresh the user service (exit 1). Rolled back:");
  });

  it("a service stopped before the update whose new start fails: restored and left stopped, and it says how to start it", () => {
    const r = rig({ kind: "user", running: false, agend: (args, m) => { if (args[0] !== "start") return 0; m.state = "failed"; return 1; } });
    expect(r.main()).toBe(1);
    expect(manager(r).map(c => c.split(" ")[2])).toEqual(["show", "stop", "show", "daemon-reload", "show"]);
    expect(r.version()).toBe(OLD);
    expect(failure(r)).toContain("the service was stopped before this update and is left stopped — `agend start` starts it");
  });

  it("a real start failure: the new fleet exits, systemd leaves the unit `failed` (also after the stop) — that is settled, and rolled back", () => {
    const r = rig({ kind: "user", running: true, stopLeaves: "failed", agend: (args, m) => { if (args[0] !== "restart") return 0; m.state = "failed"; m.setFleet(0); return 1; } });
    expect(r.main()).toBe(1);
    expect(r.version()).toBe(OLD);
    expect(failure(r)).toContain("the previous service is running (pid 7000)");
  });

  it("the restored `agend` does not answer: the rollback says so, never that the previous version runs cleanly", () => {
    const r = rig({ kind: "user", running: true, agend: shimRestart, restoredMute: true });
    expect(r.main()).toBe(1);
    expect(failure(r)).toMatch(/agend reports nothing, not v2\.3\.0-beta\.1/);
  });

  it("the previous service does not start either: restored, and it says so (never claims it runs)", () => {
    const r = rig({ kind: "system", running: true, agend: shimRestart, startFails: true });
    expect(r.main()).toBe(1);
    expect(r.version()).toBe(OLD);
    expect(failure(r)).toMatch(/were restored, but the previous service did not start \(systemctl start exited 1\) — run `agend start`/);
    expect(failure(r)).not.toMatch(/service is running/);
  });

  it("launchd: the previous job cannot be bootstrapped — said, never claimed", () => {
    const r = rig({ kind: "launchd", running: true, agend: (args, m) => { if (args[0] !== "restart") return 0; m.setFleet(0); m.loaded = false; return 1; }, startFails: true });
    expect(r.main()).toBe(1);
    expect(failure(r)).toMatch(/the previous service did not start \(launchctl bootstrap exited 5\)/);
  });
});

describe("#2420 nothing is rolled back unless it is proven safe; what is kept is named", () => {
  it("the manager cannot be read: nothing stopped or restored; the copy is kept and named", () => {
    const r = rig({ kind: "user", running: true, agend: shimRestart, unreadable: true });
    expect(r.main()).toBe(1);
    expect(r.calls.some(c => / (stop|start|daemon-reload) /.test(c + " "))).toBe(false);
    expect(r.version()).toBe(NEW);
    expect(r.rollbackDir()).toHaveLength(1);
    expect(failure(r)).toMatch(/cannot be told, so nothing was rolled back; the previous package is kept in .*\.agend-rollback/);
  });
  it.each(["user", "launchd"] as const)("%s: the failed service does not settle stopped: nothing restored, the copy kept", kind => {
    const r = rig({ kind, running: true, agend: (args, m) => { if (args[0] !== "restart") return 0; m.setFleet(5555); return 1; }, stopSticks: true });
    expect(r.main()).toBe(1);
    expect(r.version()).toBe(NEW);
    expect(r.rollbackDir()).toHaveLength(1);
    expect(failure(r)).toMatch(/could not be stopped .* so nothing was rolled back/);
  });
  it("the package cannot be copied aside: not updating, nothing changed (npm never runs)", () => {
    const r = rig({ kind: "user", running: true });
    writeFileSync(join(r.prefix, ".agend-rollback"), "a file where the directory goes");
    expect(r.main()).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.version()).toBe(OLD);
    expect(failure(r)).toMatch(/Not updating: the installed AgEnD could not be copied aside for a rollback/);
  });
});

describe("#2420 the success path is unchanged", () => {
  it.each(["user", "system", "launchd"] as const)("%s: refresh + restart, no manager call of the installer's own, the copy removed", kind => {
    const r = rig({ kind, running: true });
    expect(r.main()).toBe(0);
    expect(r.calls).toEqual([`npm install -g @songsid/agend@${NEW}`, "agend install --no-activate", "agend restart --yes"]);
    expect(r.version()).toBe(NEW);
    expect(r.rollbackDir()).toEqual([]);
  });
  it("a restart still pending (75): not a failure, nothing rolled back", () => {
    const r = rig({ kind: "user", running: true, agend: args => (args[0] === "restart" ? 75 : 0) });
    expect(r.main()).toBe(0);
    expect(manager(r)).toEqual([]);
    expect(r.version()).toBe(NEW);
    expect(r.rollbackDir()).toEqual([]);
  });
  it("no service (a hand-started fleet): no copy is taken, and a failed restart says what to run, as before", () => {
    const r = rig({ kind: null, running: true, agend: args => (args[0] === "restart" ? 1 : 0) });
    expect(r.main()).toBe(1);
    expect(manager(r)).toEqual([]);
    expect(r.version()).toBe(NEW);
    expect(failure(r)).toBe(`  ✗ the fleet did not restart onto v${NEW} (exit 1); run \`agend restart\``);
  });
  it("no previous AgEnD (a fresh install under an existing unit): nothing to roll back to, the message as before", () => {
    const r = rig({ kind: "user", running: false, previous: false, agend: args => (args[0] === "start" ? 1 : 0) });
    expect(r.main()).toBe(1);
    expect(failure(r)).toBe(`  ✗ the user service did not start (exit 1); AgEnD v${NEW} is installed — run \`agend start\``);
  });
});
