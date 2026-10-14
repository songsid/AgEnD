/**
 * #1804: on a host with no D-Bus user bus (no dbus-user-session), `busctl --user` cannot connect while `systemctl --user`
 * still reaches the manager through `$XDG_RUNTIME_DIR/systemd/private`. The update must still prove what systemd will
 * run — from systemctl and the unit file, never by guessing — and say which of these it was when it cannot.
 * The command shapes below were captured from a real systemd 249 (249.11-0ubuntu3.22, ubuntu:22.04, no
 * dbus-user-session). Everything here runs against scripted runners: no systemd, no fleet.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activateService, parseUnitExec, readLoadedUnit, type UnitFileSource } from "../src/service-activation.js";
import { busUnreachable, readSystemdRuntime } from "../src/systemd-runtime.js";
import { guardSystemd } from "../src/restart-guard.js";
import { renderSystemdUnit } from "../src/service-installer.js";
import type { CommandResult } from "../src/update-install.js";
import { activationWorld } from "./support/activation-world-1490.js";

const NO_BUS: CommandResult = { status: 1, signal: null, stdout: "", stderr: "Failed to connect to bus: No such file or directory\n" };
const ok = (stdout = ""): CommandResult => ({ status: 0, signal: null, stdout, stderr: "" });

describe("which busctl failures mean 'no bus'", () => {
  it.each([
    ["Failed to connect to bus (no user bus socket)", NO_BUS, true],
    ["busctl not spawned at all", { status: null, signal: null, stdout: "", stderr: "" }, true],
    ["a call the bus refused", { status: 1, signal: null, stdout: "", stderr: "Call failed: Unit name x is not valid.\n" }, false],
    ["busctl killed by our timeout", { status: null, signal: "SIGTERM" as NodeJS.Signals, stdout: "", stderr: "" }, false],
    ["success", ok("{}"), false],
  ])("%s → %s", (_name, result, want) => expect(busUnreachable(result)).toBe(want));
});

describe("the unit file, read as systemd reads it — or refused", () => {
  const rendered = renderSystemdUnit({
    label: "com.agend.fleet", execPath: "/usr/lib/node_modules/@songsid/agend/dist/cli.js", nodePath: "/opt/node 22/bin/node",
    path: "/opt/node22/bin:/usr/bin", workingDirectory: "/root/.agend", logPath: "/root/.agend/fleet.log", isRoot: true, agendHome: "/srv/agend 100%",
  });

  it("what `agend install` writes: argv, Environment= and the quoting it uses (a space, a %)", () => {
    const parsed = parseUnitExec(rendered);
    expect(parsed).toMatchObject({
      ok: true,
      argv: ["/opt/node 22/bin/node", "/usr/lib/node_modules/@songsid/agend/dist/cli.js", "fleet", "start"],
      env: { TERM: "xterm-256color", AGEND_HOME: "/srv/agend 100%", IS_SANDBOX: "1" },
      unset: [],
    });
    // buildServicePath appends its fallbacks after the caller's PATH.
    expect((parsed as { env: Record<string, string> }).env.PATH).toMatch(/^\/opt\/node22\/bin:\/usr\/bin(:|$)/);
  });

  const unit = (service: string) => `[Unit]\nDescription=x\n\n[Service]\n${service}\n\n[Install]\nWantedBy=default.target\n`;
  it.each([
    ["two ExecStart", 'ExecStart="/n" "/c" fleet start\nExecStart=/n /c fleet start', /not exactly one command \(2/],
    ["a reset then one", "ExecStart=\nExecStart=/n /c fleet start", /not exactly one command/],
    ["no ExecStart", "Type=notify", /not exactly one command \(0/],
    ["a prefix", "ExecStart=-/n /c fleet start", /has a prefix/],
    ["a specifier", "ExecStart=/n %h/c fleet start", /% specifier/],
    ["a variable", "ExecStart=/n $CLI fleet start", /has \$/],
    ["a C escape systemd would undo", 'ExecStart="/n\\x41" /c fleet start', /backslash escape/],
    ["a line continuation", "ExecStart=/n /c \\\n  fleet start", /line continuation/],
    ["a second command", "ExecStart=/n /c fleet start ; /bin/true", /lone ;/],
    ["a relative program", "ExecStart=node /c fleet start", /not an absolute path/],
    ["a non-breaking space", "ExecStart=/n /c fleet start", /whitespace or control/],
    ["EnvironmentFile=", "ExecStart=/n /c fleet start\nEnvironmentFile=-/etc/agend.env", /EnvironmentFile=/],
    ["PassEnvironment=", "ExecStart=/n /c fleet start\nPassEnvironment=NODE_OPTIONS", /PassEnvironment=/],
    ["$$ in Environment=", "ExecStart=/n /c fleet start\nEnvironment=A=x$$y", /\$\$/],
    ["an assignment without =", "ExecStart=/n /c fleet start\nEnvironment=JUSTANAME", /invalid assignment/],
  ])("%s → refused", (_name, service, reason) => {
    const parsed = parseUnitExec(unit(service));
    expect(parsed.ok).toBe(false);
    expect((parsed as { reason: string }).reason).toMatch(reason);
  });

  it("sections, comments, resets and UnsetEnvironment= are read as systemd reads them", () => {
    expect(parseUnitExec([
      "[Unit]", "ExecStart=/not/this one", "[Service]", "# ExecStart=/commented", "  ExecStart = /n /c fleet start  ",
      "Environment=A=1 B=2", "Environment=", "Environment='C=3 4' D=5%%", "UnsetEnvironment=C=3", "[Service]", "Environment=E=$x",
    ].join("\n"))).toEqual({ ok: true, argv: ["/n", "/c", "fleet", "start"], env: { C: "3 4", D: "5%", E: "$x" }, unset: ["C=3"] });
  });
});

/** systemd 249's own `systemctl --user show` output for a loaded, running unit with no drop-ins (captured). */
function busless(over: { show?: Record<string, string[] | null>; showStatus?: number; env?: string; envStatus?: number } = {}) {
  const calls: string[] = [];
  const base: Record<string, string[]> = {
    LoadState: ["loaded"], FragmentPath: ["/root/.config/systemd/user/com.agend.fleet.service"], DropInPaths: [""],
    NeedDaemonReload: ["no"], PassEnvironment: [""], ActiveState: ["active"], SubState: ["running"], MainPID: ["82"],
    ControlPID: ["0"], Job: [""], Type: ["notify"], KillMode: ["mixed"], SendSIGKILL: ["yes"],
  };
  const run = (command: string, args: string[]): CommandResult => {
    calls.push([command, ...args].join(" "));
    if (command === "busctl") return NO_BUS;
    if (command === "systemctl" && args.includes("show-environment")) {
      return over.envStatus ? { status: over.envStatus, signal: null, stdout: "", stderr: "Failed to connect to bus: No such file or directory\n" } : ok(over.env ?? "HOME=/root\nPATH=/usr/local/bin:/usr/bin:/bin\n");
    }
    if (command === "systemctl" && args.includes("show")) {
      if (over.showStatus) return { status: over.showStatus, signal: null, stdout: "", stderr: "Failed to connect to bus: No such file or directory\n" };
      const wanted = args.find(a => a.startsWith("--property="))!.slice("--property=".length).split(",");
      const lines = wanted.flatMap(key => {
        const values = key in (over.show ?? {}) ? over.show![key] : base[key];
        return (values ?? []).map(v => `${key}=${v}`);
      });
      return ok(lines.join("\n") + "\n");
    }
    throw Error(`unexpected ${command} ${args.join(" ")}`);
  };
  return { run, calls };
}

const UNIT_PATH = "/root/.config/systemd/user/com.agend.fleet.service";
const UNIT = "[Service]\nType=notify\nExecStart=\"/opt/node/bin/node\" \"/pkg/dist/cli.js\" fleet start\nEnvironment=PATH=/opt/node/bin:/usr/bin\nKillMode=mixed\n";
const fileOf = (text: string | (() => string | null), realpath?: (p: string) => string | null): UnitFileSource => ({
  path: UNIT_PATH, readFile: p => (p === UNIT_PATH ? (typeof text === "function" ? text() : text) : null), ...(realpath ? { realpath } : {}),
});

describe("readLoadedUnit without a bus: proven from systemctl and the unit file", () => {
  it("loaded, from our file, no drop-ins, no reload pending: the file's ExecStart, over the manager's environment", () => {
    const { run, calls } = busless({ env: "HOME=/root\nPATH=/usr/bin\nLANG=C.UTF-8\n" });
    expect(readLoadedUnit(run, true, "com.agend.fleet", fileOf(UNIT))).toEqual({ ok: true, unit: {
      tuple: { program: "/opt/node/bin/node", argv: ["/opt/node/bin/node", "/pkg/dist/cli.js", "fleet", "start"], env: { HOME: "/root", PATH: "/opt/node/bin:/usr/bin", LANG: "C.UTF-8" } },
      needDaemonReload: false,
    } });
    expect(calls).toEqual([
      "busctl --user --json=short call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager LoadUnit s com.agend.fleet.service",
      "systemctl --user show com.agend.fleet.service --property=LoadState,FragmentPath,DropInPaths,NeedDaemonReload,EnvironmentFiles,PassEnvironment",
      "systemctl --user show-environment",
    ]);
  });

  it.each([
    ["a reload is pending", { show: { NeedDaemonReload: ["yes"] } }, /cannot prove .* NeedDaemonReload is yes/],
    ["a drop-in applies", { show: { DropInPaths: ["/root/.config/systemd/user/com.agend.fleet.service.d/z.conf"] } }, /drop-ins apply to it \(.*z\.conf\)/],
    ["an EnvironmentFile (one line per file)", { show: { EnvironmentFiles: ["/root/x.env (ignore_errors=no)", "/root/y.env (ignore_errors=yes)"] } }, /EnvironmentFile=/],
    ["PassEnvironment", { show: { PassEnvironment: ["NODE_OPTIONS"] } }, /PassEnvironment=/],
    ["another fragment", { show: { FragmentPath: ["/etc/systemd/user/com.agend.fleet.service"] } }, /loaded it from \/etc\/systemd\/user/],
    ["a generated unit (no fragment)", { show: { FragmentPath: [""] } }, /loaded it from no file/],
    ["masked", { show: { LoadState: ["masked"] } }, /load state is masked/],
    ["an unreadable reload flag", { show: { NeedDaemonReload: null } }, /NeedDaemonReload is unreadable/],
    ["the manager's PATH printed quoted, and the unit sets none", { env: "PATH=$'/usr/bin:/a b'\n" }, /manager's PATH is printed quoted/],
    ["show-environment fails", { envStatus: 1 }, /manager's environment cannot be read/],
  ])("%s → refused, saying the bus is unreachable and why the file cannot stand in", (_name, over, reason) => {
    const { run } = busless(over as Parameters<typeof busless>[0]);
    const unit = reason.source.includes("PATH is printed") ? UNIT.replace(/^Environment=PATH.*\n/m, "") : UNIT;
    const read = readLoadedUnit(run, true, "com.agend.fleet", fileOf(unit));
    expect(read.ok).toBe(false);
    expect((read as { reason: string }).reason).toMatch(/^the D-Bus user bus cannot be reached \(busctl exited 1: Failed to connect to bus: No such file or directory\), and systemctl cannot prove com\.agend\.fleet\.service is its unit file: /);
    expect((read as { reason: string }).reason).toMatch(reason);
  });

  it("the file changing while systemd is asked → refused", () => {
    let n = 0;
    const read = readLoadedUnit(busless().run, true, "com.agend.fleet", fileOf(() => (n++ === 0 ? UNIT : `${UNIT}# edited\n`)));
    expect(read).toMatchObject({ ok: false, reason: expect.stringMatching(/changed while systemd was asked/) });
  });

  it("a symlinked home: FragmentPath names the same file through another path", () => {
    const { run } = busless({ show: { FragmentPath: ["/data/root/.config/systemd/user/com.agend.fleet.service"] } });
    const same = (p: string) => p.replace(/^\/data/, "");
    expect(readLoadedUnit(run, true, "com.agend.fleet", fileOf(UNIT, same)).ok).toBe(true);
    expect(readLoadedUnit(run, true, "com.agend.fleet", fileOf(UNIT)).ok).toBe(false);
  });

  it("a quoted manager value other than PATH is kept as printed; an interpreter variable is set whatever its quoting", () => {
    const read = readLoadedUnit(busless({ env: "Q=$'a b'\nNODE_OPTIONS=$'--require /x.js'\n" }).run, true, "com.agend.fleet", fileOf(UNIT));
    expect(read).toMatchObject({ ok: true, unit: { tuple: { env: { Q: "$'a b'", NODE_OPTIONS: "$'--require /x.js'" } } } });
  });

  it("the four reasons stay apart", () => {
    // 1. neither busctl nor systemctl reaches the manager
    expect(readLoadedUnit(busless({ showStatus: 1 }).run, true, "com.agend.fleet", fileOf(UNIT))).toEqual({ ok: false,
      reason: "neither busctl nor systemctl can reach the systemd --user manager (busctl exited 1: Failed to connect to bus: No such file or directory; systemctl --user show exited 1: Failed to connect to bus: No such file or directory)" });
    // 2. systemd does not know the unit
    expect(readLoadedUnit(busless({ show: { LoadState: ["not-found"], FragmentPath: [""] } }).run, true, "com.agend.fleet", fileOf(UNIT)))
      .toEqual({ ok: false, reason: "systemd does not know com.agend.fleet.service" });
    // 3. the bus is there, and LoadUnit failed: no systemctl fallback
    const calls: string[] = [];
    const refused = (command: string, args: string[]): CommandResult => { calls.push(command); return { status: 1, signal: null, stdout: "", stderr: "Call failed: Access denied\n" }; };
    expect(readLoadedUnit(refused, true, "com.agend.fleet", fileOf(UNIT))).toEqual({ ok: false, reason: "busctl could not load com.agend.fleet.service (exited 1: Call failed: Access denied)" });
    expect(calls).toEqual(["busctl"]);
    // 4. no bus, and the file cannot stand in (see the table above); with no file at all:
    expect(readLoadedUnit(busless().run, true, "com.agend.fleet")).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot prove .* no unit file was given/) });
  });
});

describe("readSystemdRuntime without a bus: systemctl show, as systemd 249 prints it", () => {
  it.each([
    ["running, no job (`Job=` is empty)", {}, { active: "active", sub: "running", pid: 82, control: 0, job: 0, type: "notify", killMode: "mixed", sendSigkill: true }],
    ["a queued job (`Job=15`)", { Job: ["15"], ActiveState: ["activating"], SubState: ["start"] }, { active: "activating", sub: "start", pid: 82, control: 0, job: 15, type: "notify", killMode: "mixed", sendSigkill: true }],
    ["stopped", { ActiveState: ["inactive"], SubState: ["dead"], MainPID: ["0"], SendSIGKILL: ["no"] }, { active: "inactive", sub: "dead", pid: 0, control: 0, job: 0, type: "notify", killMode: "mixed", sendSigkill: false }],
  ])("%s", (_name, show, want) => {
    expect(readSystemdRuntime(busless({ show }).run, true, "com.agend.fleet")).toEqual(want);
  });

  it.each([
    ["Job missing", { Job: null }], ["Job=0 (never printed by systemd)", { Job: ["0"] }], ["MainPID not a number", { MainPID: ["x"] }],
    ["SendSIGKILL unreadable", { SendSIGKILL: ["maybe"] }], ["a property printed twice", { Type: ["notify", "simple"] }],
  ])("%s → unknown (null), never a guess", (_name, show) => {
    expect(readSystemdRuntime(busless({ show: show as Record<string, string[] | null> }).run, true, "com.agend.fleet")).toBeNull();
  });

  it("systemctl unreachable too → unknown", () => {
    expect(readSystemdRuntime(busless({ showStatus: 1 }).run, true, "com.agend.fleet")).toBeNull();
  });
});

/** The #1490 world (private files, scripted manager), with busctl unable to connect and systemctl answering `show`. */
function buslessWorld(root: string, opts: { dropIn?: boolean; needReload?: boolean } = {}) {
  const w = activationWorld(root);
  let loaded = w.oldUnit;
  const run = (command: string, args: string[]): CommandResult => {
    if (command === "busctl") { w.calls.push(`busctl ${args.join(" ")}`); return NO_BUS; }
    if (command === "systemctl" && args.includes("show-environment")) { w.calls.push("systemctl show-environment"); return ok("HOME=/root\n"); }
    if (command === "systemctl" && args.includes("show")) {
      w.calls.push(`systemctl show ${args.find(a => a.startsWith("--property="))}`);
      const onDisk = w.deps.readFile(w.unitPath);
      const values: Record<string, string> = {
        LoadState: "loaded", FragmentPath: w.unitPath, DropInPaths: opts.dropIn ? `${w.unitPath}.d/override.conf` : "",
        NeedDaemonReload: opts.needReload || loaded !== onDisk ? "yes" : "no", PassEnvironment: "",
        ActiveState: w.state.active, SubState: w.state.sub, MainPID: String(w.state.pid), ControlPID: String(w.state.control),
        Job: w.state.job ? String(w.state.job) : "", Type: w.state.type, KillMode: w.state.killMode, SendSIGKILL: w.state.sendSigkill ? "yes" : "no",
      };
      const wanted = args.find(a => a.startsWith("--property="))!.slice("--property=".length).split(",");
      return ok(wanted.filter(k => k in values).map(k => `${k}=${values[k]}`).join("\n") + "\n");
    }
    const r = w.run(command, args);
    if (command === "systemctl" && args.includes("daemon-reload") && r.status === 0) loaded = w.deps.readFile(w.unitPath)!;
    return r;
  };
  return { ...w, deps: { ...w.deps, run } };
}

describe("agend update on a host without a user bus", () => {
  const roots: string[] = [];
  const root = () => { const r = mkdtempSync(join(tmpdir(), "agend-busless-")); roots.push(r); return r; };
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  const manager = (w: { unitPath: string }) => ({ kind: "systemd" as const, unit: "com.agend.fleet", user: true, unitPath: w.unitPath });

  it("the unit is provably the one AgEnD wrote: the update restarts through systemd", () => {
    const w = buslessWorld(root());
    w.setRestart("restarted");
    expect(activateService(manager(w), w.verified, w.deps)).toEqual({ ok: true, via: "restart" });
    expect(w.calls).toContain("restart");
    expect(w.calls).toContain("systemctl show --property=LoadState,FragmentPath,DropInPaths,NeedDaemonReload,EnvironmentFiles,PassEnvironment");
    expect(w.calls).not.toContain("restore-package");
    expect(w.deps.readFile(w.unitPath)).toBe(w.newUnit);
  });

  it.each([
    ["a drop-in applies", { dropIn: true }, /drop-ins apply to it/],
    ["systemd still needs a reload", { needReload: true }, /NeedDaemonReload is yes/],
  ])("%s: refused before anything stops, the previous unit and package go back, and the reason is the real one", (_name, opts, reason) => {
    const w = buslessWorld(root(), opts);
    w.setRestart("restarted");
    const outcome = activateService(manager(w), w.verified, w.deps) as { ok: boolean; stopped: boolean; message: string };
    expect(outcome.ok).toBe(false);
    expect(outcome.stopped).toBe(false);
    expect(outcome.message).toMatch(/Cannot prove what systemd will run for com\.agend\.fleet: the D-Bus user bus cannot be reached/);
    expect(outcome.message).toMatch(reason);
    expect(outcome.message).not.toMatch(/does not know/);
    // The rollback line says what was seen, not "does not show it loaded".
    expect(outcome.message).toMatch(/the previous com\.agend\.fleet is back on disk, but what systemd loaded cannot be confirmed: the D-Bus user bus cannot be reached/);
    expect(outcome.message).toContain("Previous package restored");
    expect(w.calls).not.toContain("restart");
    expect(w.deps.readFile(w.unitPath)).toBe(w.oldUnit);
    expect(w.version()).toBe("2.1.12");
  });

  it("a failed restart is recovered without a bus too: previous package and unit back, the previous service running", () => {
    const w = buslessWorld(root());
    w.setRestart("failed");
    const outcome = activateService(manager(w), w.verified, w.deps);
    expect(outcome).toEqual({ ok: false, stopped: false,
      message: "  ✗ Fleet restart failed. The previous package and loaded unit were restored; the previous service is running. The update did not succeed." });
    expect(w.deps.readFile(w.unitPath)).toBe(w.oldUnit);
    expect(w.version()).toBe("2.1.12");
    expect(w.state).toMatchObject({ active: "active", sub: "running", pid: 222 });
  });

  it("with the bus: unchanged — no systemctl show, no show-environment", () => {
    const w = activationWorld(root());
    w.setRestart("restarted");
    expect(activateService(manager(w), w.verified, w.deps)).toEqual({ ok: true, via: "restart" });
    expect(w.calls.filter(c => /^systemctl .*show/.test(c))).toEqual([]);
  });
});

describe("agend restart's guard without a bus (the update's restart goes through it)", () => {
  const expected = { node: "/opt/node/bin/node", entry: "/pkg/dist/cli.js" };
  const deps = { realpath: (p: string) => p, isExecutable: () => true };
  it("proven from the unit file: allowed", () => {
    expect(guardSystemd(busless().run, true, "com.agend.fleet", expected, deps, fileOf(UNIT))).toEqual({ ok: true });
  });
  it("no unit file to prove against: refused, saying so", () => {
    expect(guardSystemd(busless().run, true, "com.agend.fleet", expected, deps)).toMatchObject({ ok: false, reason: expect.stringMatching(/no unit file was given/) });
  });
  it("a drop-in: refused", () => {
    expect(guardSystemd(busless({ show: { DropInPaths: ["/x.conf"] } }).run, true, "com.agend.fleet", expected, deps, fileOf(UNIT)).ok).toBe(false);
  });
});
