/**
 * #908 (regression after #938): kiro-cli still dumped core (SIGABRT, ~1 GB
 * each in %TEMP%\wsl-crashes) on `agend update`. The fleet runs as a systemd
 * unit with the default KillMode=control-group, and the tmux server and every
 * CLI live in that unit's cgroup — so systemd SIGTERMed all of them at the same
 * moment as the fleet, before the fleet's own graceful per-instance quit
 * (#938's drain) could run. Both observed waves line up with systemd stopping
 * the unit; the fleet log shows every quit failing (`quitSent: false`) as the
 * tmux server went down underneath it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSystemdKillModeMixed, ensureSystemdUnitHardening, renderSystemdUnit, unitCoredumpFilterState, unitDropInCandidates } from "../src/service-installer.js";

const vars = {
  label: "com.agend.fleet", execPath: "/usr/local/bin/agend", workingDirectory: "/home/u/.agend",
  logPath: "/home/u/.agend/daemon.log", path: "/usr/local/bin:/usr/bin:/bin",
};
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-908-")); dirs.push(d); return d; };
/** A unit as AgEnD wrote it before #908: the same, with no KillMode. */
const legacyUnit = () => renderSystemdUnit(vars).split("\n")
  .filter(l => !/^(KillMode|CoredumpFilter|LimitCORE|StartLimitIntervalSec|StartLimitBurst)=/.test(l) && !/^#/.test(l))
  .map(l => (/^TimeoutStartSec=/.test(l) ? "TimeoutStartSec=0" : l))
  .join("\n");
const serviceSection = (unit: string) => unit.split(/^\[Install\]/m)[0]!.split(/^\[Service\]/m)[1]!;

describe("the unit stops the fleet process only (#908)", () => {
  it("a fresh install renders KillMode=mixed in [Service]", () => {
    expect(serviceSection(renderSystemdUnit(vars))).toMatch(/^KillMode=mixed$/m);
  });
});

describe("existing installs are brought up to KillMode=mixed before a restart", () => {
  it("adds it to a unit that has none, inside [Service], once", () => {
    const path = join(tmp(), "com.agend.fleet.service");
    writeFileSync(path, legacyUnit());
    expect(readFileSync(path, "utf8")).not.toMatch(/KillMode/);
    expect(ensureSystemdKillModeMixed(path)).toBe("added");
    const after = readFileSync(path, "utf8");
    expect(serviceSection(after)).toMatch(/^KillMode=mixed$/m);
    expect(after.split(/^\[Install\]/m)[1]).not.toMatch(/KillMode/);
    // Everything else is untouched.
    expect(after.replace("KillMode=mixed\n", "")).toBe(legacyUnit());
    expect(ensureSystemdKillModeMixed(path)).toBe("present");
    expect(readFileSync(path, "utf8")).toBe(after);
  });

  it("leaves an operator's own KillMode alone", () => {
    const path = join(tmp(), "u.service");
    const custom = legacyUnit().replace("TimeoutStopSec=60", "TimeoutStopSec=60\nKillMode=process");
    writeFileSync(path, custom);
    expect(ensureSystemdKillModeMixed(path)).toBe("custom");
    expect(readFileSync(path, "utf8")).toBe(custom);
  });

  it("does not write what it cannot parse", () => {
    const dir = tmp();
    expect(ensureSystemdKillModeMixed(join(dir, "missing.service"))).toBe("unreadable");
    const odd = join(dir, "odd.service");
    writeFileSync(odd, "[Unit]\nDescription=x\n");
    expect(ensureSystemdKillModeMixed(odd)).toBe("unreadable");
    expect(readFileSync(odd, "utf8")).toBe("[Unit]\nDescription=x\n");
  });
});

describe("#1113: crash dumps, start timeout and start limit", () => {
  const unitSection = (unit: string) => unit.split(/^\[Service\]/m)[0]!;

  it("a fresh install renders them in the right sections", () => {
    const unit = renderSystemdUnit(vars);
    expect(serviceSection(unit)).toMatch(/^CoredumpFilter=0$/m);
    expect(serviceSection(unit)).toMatch(/^LimitCORE=0$/m);
    expect(serviceSection(unit)).toMatch(/^TimeoutStartSec=15min$/m);
    expect(serviceSection(unit)).not.toMatch(/^TimeoutStartSec=0$/m);
    // StartLimit* belong to [Unit]; systemd ignores them in [Service].
    expect(unitSection(unit)).toMatch(/^StartLimitIntervalSec=30min$/m);
    expect(unitSection(unit)).toMatch(/^StartLimitBurst=4$/m);
    expect(serviceSection(unit)).not.toMatch(/StartLimit/);
  });

  it.skipIf(spawnSync("systemd-analyze", ["--version"]).status !== 0)("the rendered unit passes `systemd-analyze verify` (real systemd)", () => {
    const dir = tmp();
    const path = join(dir, "agend-1113-verify.service");
    writeFileSync(path, renderSystemdUnit({ ...vars, execPath: "/bin/true", workingDirectory: dir, logPath: join(dir, "x.log") }));
    const r = spawnSync("systemd-analyze", ["--user", "verify", path], { encoding: "utf8" });
    expect(`${r.stdout}${r.stderr}`.trim()).toBe("");
    expect(r.status).toBe(0);
  });

  it("an installed unit is brought up to date: missing ones added, AgEnD's old TimeoutStartSec=0 upgraded, once", () => {
    const path = join(tmp(), "com.agend.fleet.service");
    writeFileSync(path, legacyUnit());
    const result = ensureSystemdUnitHardening(path);
    expect(result).toEqual({ kind: "ok", directives: {
      StartLimitIntervalSec: "added", StartLimitBurst: "added", TimeoutStartSec: "upgraded",
      KillMode: "added", CoredumpFilter: "added", LimitCORE: "added",
    } });
    const after = readFileSync(path, "utf8");
    expect(unitSection(after)).toMatch(/^StartLimitIntervalSec=30min\nStartLimitBurst=4$/m);
    expect(serviceSection(after)).toMatch(/^TimeoutStartSec=15min$/m);
    expect(serviceSection(after)).toMatch(/^KillMode=mixed\nCoredumpFilter=0\nLimitCORE=0$/m);
    expect(after.split(/^\[Install\]/m)[1]).toBe(legacyUnit().split(/^\[Install\]/m)[1]);
    // Every pre-existing line survives, in order.
    const kept = after.split("\n").filter(l => !/^(StartLimitIntervalSec|StartLimitBurst|KillMode|CoredumpFilter|LimitCORE)=/.test(l));
    expect(kept.join("\n")).toBe(legacyUnit().replace("TimeoutStartSec=0", "TimeoutStartSec=15min"));
    const again = ensureSystemdUnitHardening(path);
    expect(again.kind === "ok" && Object.values(again.directives).every(v => v === "present")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(after);
  });

  it("an operator's own values are left exactly as they are", () => {
    const path = join(tmp(), "u.service");
    const custom = legacyUnit()
      .replace("TimeoutStartSec=0", "TimeoutStartSec=5min")
      .replace("TimeoutStopSec=60", "TimeoutStopSec=60\nCoredumpFilter=0x33\nLimitCORE=infinity")
      .replace("After=network.target", "After=network.target\nStartLimitBurst=10");
    writeFileSync(path, custom);
    const result = ensureSystemdUnitHardening(path);
    expect(result.kind === "ok" && result.directives).toMatchObject({
      TimeoutStartSec: "custom", CoredumpFilter: "custom", LimitCORE: "custom", StartLimitBurst: "custom",
      StartLimitIntervalSec: "added", KillMode: "added",
    });
    const after = readFileSync(path, "utf8");
    expect(after).toContain("TimeoutStartSec=5min");
    expect(after).toContain("CoredumpFilter=0x33");
    expect(after).toContain("StartLimitBurst=10");
    expect(after).not.toMatch(/StartLimitBurst=4/);
  });

  it("CoredumpFilter is judged on every assignment: a later one, a second [Service], a drop-in, and a reset (#1122 review)", () => {
    const dir = tmp();
    const state = (main: string, dropIn?: string) => {
      const path = join(dir, `u${Math.random().toString(36).slice(2)}.service`);
      writeFileSync(path, main);
      if (dropIn !== undefined) { mkdirSync(`${path}.d`); writeFileSync(join(`${path}.d`, "override.conf"), dropIn); }
      const r = ensureSystemdUnitHardening(path);
      return { result: r.kind === "ok" ? r.directives.CoredumpFilter : r.kind, text: readFileSync(path, "utf8") };
    };
    const base = legacyUnit();
    expect(state(base.replace("TimeoutStopSec=60", "TimeoutStopSec=60\nCoredumpFilter=0\nCoredumpFilter=0x33")).result).toBe("custom");
    expect(state(`${base}\n[Service]\nCoredumpFilter=0x33\n`).result).toBe("custom");
    expect(state(base, "[Service]\nCoredumpFilter=0x33\n").result).toBe("custom");
    // An empty assignment drops every mask before it; an explicit 0 after it is AgEnD's 0 again.
    expect(state(base.replace("TimeoutStopSec=60", "TimeoutStopSec=60\nCoredumpFilter=0x33\nCoredumpFilter=\nCoredumpFilter=0")).result).toBe("present");
    // A TRAILING empty assignment restores the inherited filter (normally 0x33): the operator's call (#1122 r2).
    expect(state(base.replace("TimeoutStopSec=60", "TimeoutStopSec=60\nCoredumpFilter=0\nCoredumpFilter=")).result).toBe("custom");
    expect(state(base.replace("TimeoutStopSec=60", "TimeoutStopSec=60\nCoredumpFilter=")).result).toBe("custom");
    expect(state(base.replace("TimeoutStopSec=60", "TimeoutStopSec=60\nCoredumpFilter=0"), "[Service]\nCoredumpFilter=\n").result).toBe("custom");
    // A drop-in setting 0 is enough: nothing added to the main file.
    const viaDropIn = state(base, "[Service]\nCoredumpFilter=0\n");
    expect(viaDropIn.result).toBe("present");
    expect(viaDropIn.text).not.toMatch(/CoredumpFilter/);
  });

  it("a type-wide service.d drop-in counts too, ordered by file name with the unit's own drop-ins (#1122 r2)", () => {
    const dir = tmp();
    const path = join(dir, "com.agend.fleet.service");
    writeFileSync(path, legacyUnit().replace("TimeoutStopSec=60", "TimeoutStopSec=60\nCoredumpFilter=0"));
    mkdirSync(join(dir, "service.d"));
    writeFileSync(join(dir, "service.d", "50-custom.conf"), "[Service]\nCoredumpFilter=0x33\n");
    expect(unitDropInCandidates(path)).toEqual([join(dir, "service.d", "50-custom.conf")]);
    const r = ensureSystemdUnitHardening(path);
    expect(r.kind === "ok" && r.directives.CoredumpFilter).toBe("custom");
    // The unit's own 60-zero.conf sorts after 50-custom.conf: a later 0 does not undo the ORed 0x33…
    mkdirSync(`${path}.d`);
    writeFileSync(join(`${path}.d`, "60-zero.conf"), "[Service]\nCoredumpFilter=0\n");
    expect(unitDropInCandidates(path)).toEqual([join(dir, "service.d", "50-custom.conf"), join(`${path}.d`, "60-zero.conf")]);
    expect(unitCoredumpFilterState(readFileSync(path, "utf8"), unitDropInCandidates(path))).toBe("custom");
    // …but an empty assignment before it does.
    writeFileSync(join(`${path}.d`, "60-zero.conf"), "[Service]\nCoredumpFilter=\nCoredumpFilter=0\n");
    expect(unitCoredumpFilterState(readFileSync(path, "utf8"), unitDropInCandidates(path))).toBe("zero");
    // Same file name in both: the unit's own drop-in hides the type-wide one.
    writeFileSync(join(`${path}.d`, "50-custom.conf"), "[Service]\nCoredumpFilter=0\n");
    expect(unitDropInCandidates(path)).toContain(join(`${path}.d`, "50-custom.conf"));
    expect(unitDropInCandidates(path)).not.toContain(join(dir, "service.d", "50-custom.conf"));
  });

  it("an explicit drop-in list (systemd's DropInPaths) is used as given", () => {
    const dir = tmp();
    const path = join(dir, "u.service");
    writeFileSync(path, legacyUnit().replace("TimeoutStopSec=60", "TimeoutStopSec=60\nCoredumpFilter=0"));
    const elsewhere = join(dir, "elsewhere.conf");
    writeFileSync(elsewhere, "[Service]\nCoredumpFilter=0x33\n");
    const r = ensureSystemdUnitHardening(path, { dropInPaths: [elsewhere] });
    expect(r.kind === "ok" && r.directives.CoredumpFilter).toBe("custom");
    expect(unitCoredumpFilterState(readFileSync(path, "utf8"), [])).toBe("zero");
  });

  it.each(["022", "002"])("a migrated unit keeps its 0600 mode under umask %s (#1122 review: Environment= may hold credentials)", (mask) => {
    const previous = process.umask(Number.parseInt(mask, 8));
    try {
      const path = join(tmp(), "private.service");
      writeFileSync(path, legacyUnit());
      chmodSync(path, 0o600);
      expect(ensureSystemdUnitHardening(path).kind).toBe("ok");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const killmodeOnly = join(tmp(), "private2.service");
      writeFileSync(killmodeOnly, legacyUnit());
      chmodSync(killmodeOnly, 0o600);
      expect(ensureSystemdKillModeMixed(killmodeOnly)).toBe("added");
      expect(statSync(killmodeOnly).mode & 0o777).toBe(0o600);
      // Not merely "0600 always": whatever the original had is what it keeps.
      const groupRead = join(tmp(), "group.service");
      writeFileSync(groupRead, legacyUnit());
      chmodSync(groupRead, 0o640);
      ensureSystemdUnitHardening(groupRead);
      expect(statSync(groupRead).mode & 0o777).toBe(0o640);
    } finally { process.umask(previous); }
  });

  it("CoredumpFilter=0x0 already counts as present", () => {
    const path = join(tmp(), "u.service");
    writeFileSync(path, legacyUnit().replace("TimeoutStopSec=60", "TimeoutStopSec=60\nCoredumpFilter=0x0"));
    const result = ensureSystemdUnitHardening(path);
    expect(result.kind === "ok" && result.directives.CoredumpFilter).toBe("present");
  });

  it("a unit without [Unit] still gets its [Service] fixes; one without [Service] is not touched", () => {
    const dir = tmp();
    const noUnit = join(dir, "a.service");
    writeFileSync(noUnit, legacyUnit().replace(/^\[Unit\][\s\S]*?(?=^\[Service\])/m, ""));
    const result = ensureSystemdUnitHardening(noUnit);
    expect(result.kind === "ok" && result.directives.CoredumpFilter).toBe("added");
    expect(result.kind === "ok" && "StartLimitBurst" in result.directives).toBe(false);
    const odd = join(dir, "odd.service");
    writeFileSync(odd, "[Unit]\nDescription=x\n");
    expect(ensureSystemdUnitHardening(odd)).toEqual({ kind: "unreadable" });
    expect(readFileSync(odd, "utf8")).toBe("[Unit]\nDescription=x\n");
    expect(ensureSystemdUnitHardening(join(dir, "missing.service"))).toEqual({ kind: "unreadable" });
  });
});

describe("`agend restart` (what `agend update` spawns) fixes the unit before reloading it", () => {
  const cli = join(process.cwd(), "dist", "cli.js");
  /**
   * The built CLI's `agend restart` with a throwaway HOME and a recording stub
   * systemctl. The stub keeps what systemd has LOADED apart from the file, as
   * systemd does: it starts at `loaded` (default control-group, a unit loaded
   * before #908), a successful daemon-reload loads the file's KillMode, and
   * `show -p KillMode --value` prints the loaded one. `pinLoaded` keeps the
   * loaded value whatever a reload says; `failShow` makes `show` fail.
   */
  function restart(unitText: string | null, opts: { failReload?: boolean; unreadable?: boolean; readOnlyDir?: boolean; loaded?: string; pinLoaded?: boolean; failShow?: boolean; systemdVersion?: number; pinFilter?: boolean; system?: boolean; dropIn?: string; typeDropIn?: string; dropInPaths?: string; dropInPathsAfterReload?: boolean; dropInName?: string } = {}) {
    const home = tmp();
    const unitDir = join(home, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    const unit = join(unitDir, "com.agend.fleet.service");
    if (unitText !== null) writeFileSync(unit, unitText);
    if (opts.typeDropIn !== undefined) {
      mkdirSync(join(unitDir, "service.d"), { recursive: true });
      writeFileSync(join(unitDir, "service.d", "50-custom.conf"), opts.typeDropIn);
    }
    if (opts.dropIn !== undefined) {
      mkdirSync(`${unit}.d`, { recursive: true });
      writeFileSync(join(`${unit}.d`, opts.dropInName ?? "override.conf"), opts.dropIn);
    }
    if (opts.unreadable) chmodSync(unit, 0o000);
    if (opts.readOnlyDir) chmodSync(unitDir, 0o555);
    const bin = join(home, "bin");
    mkdirSync(bin);
    const log = join(home, "systemctl.log");
    writeFileSync(log, "");
    const loaded = join(home, "systemctl.loaded");
    writeFileSync(loaded, `${opts.loaded ?? "control-group"}\n`);
    const filterLoaded = join(home, "systemctl.filter");
    writeFileSync(filterLoaded, "0x33\n"); // systemd's default until a reload loads the unit's own
    // Records each call with whether the unit already had KillMode=mixed then.
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh
has=no; grep -q '^KillMode=mixed$' '${unit}' 2>/dev/null && has=yes
echo "$* killmode=$has" >> '${log}'
case "$*" in *is-active*) echo active;; esac
case "$*" in *daemon-reload*)
  [ "${opts.failReload ? "1" : "0"}" = 1 ] && exit 1
  if [ "${opts.pinLoaded ? "1" : "0"}" = 0 ]; then
    v=$(sed -n 's/^KillMode=//p' '${unit}' 2>/dev/null | head -n1); echo "\${v:-control-group}" > '${loaded}'
  fi
  if [ "${opts.pinFilter ? "1" : "0"}" = 0 ]; then
    f=$(sed -n 's/^CoredumpFilter=//p' '${unit}' 2>/dev/null | head -n1)
    case "$f" in 0|0x0) echo 0x0;; "") echo 0x33;; *) echo "$f";; esac > '${filterLoaded}'
  fi;;
esac
case "$*" in *--version*) echo "systemd ${opts.systemdVersion ?? 249} (stub)";; esac
case "$*" in *"show -p CoredumpFilter --value"*) cat '${filterLoaded}';; esac
case "$*" in *"show -p DropInPaths --value"*)
  if [ "${opts.dropInPathsAfterReload ? "1" : "0"}" = 0 ] || grep -q daemon-reload '${log}'; then printf '%s\\n' '${opts.dropInPaths ?? ""}'; fi;;
esac
case "$*" in *"show -p KillMode --value"*)
  [ "${opts.failShow ? "1" : "0"}" = 1 ] && exit 1
  cat '${loaded}';;
esac
exit 0
`);
    chmodSync(join(bin, "systemctl"), 0o755);
    // `system`: the CLI finds a system unit. Only that one path is redirected,
    // inside the child process, to the throwaway unit (and away from the user
    // unit, so the system branch is the one taken).
    let preload: string[] = [];
    if (opts.system) {
      const file = join(home, "system-unit.mjs");
      writeFileSync(file, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const SYS = "/etc/systemd/system/agend.service"; const REAL = ${JSON.stringify(unit)};
const map = p => (String(p) === SYS ? REAL : String(p) === REAL ? "/nonexistent-user-unit" : p);
for (const name of ["existsSync", "readFileSync", "statSync", "writeFileSync", "renameSync", "chmodSync", "readdirSync"]) {
  const orig = fs[name]; fs[name] = (p, ...rest) => orig(map(p), ...rest);
}
syncBuiltinESMExports();
`);
      preload = ["--import", `file://${file}`];
    }
    const r = spawnSync(process.execPath, [...preload, cli, "restart"], {
      env: { ...process.env, HOME: home, AGEND_HOME: join(home, ".agend"), PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8", timeout: 60_000,
    });
    if (opts.unreadable) chmodSync(unit, 0o600);
    if (opts.readOnlyDir) chmodSync(unitDir, 0o755);
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    return { r, calls, unit, out: `${r.stdout}\n${r.stderr}`, restarted: calls.some(c => (opts.system ? /^restart agend\b/ : /^--user restart com\.agend\.fleet/).test(c)) };
  }

  it.skipIf(!existsSync(cli))("adds KillMode=mixed before `systemctl --user daemon-reload` (built CLI, stubbed systemctl)", () => {
    const { r, calls, out, restarted } = restart(legacyUnit());
    const reload = calls.find(c => c.startsWith("--user daemon-reload"));
    expect(reload, `${out}\n${calls.join("\n")}`).toBe("--user daemon-reload killmode=yes");
    expect(restarted).toBe(true);
    expect(calls.find(c => c.startsWith("--user restart"))).toMatch(/killmode=yes$/);
    expect(r.stdout).toContain("KillMode=mixed");
  });

  it.skipIf(!existsSync(cli))("if the reload fails after adding it, it does not restart on the old control-group unit (#1070 review)", () => {
    const { r, calls, out, restarted } = restart(legacyUnit(), { failReload: true });
    expect(calls.some(c => c.startsWith("--user daemon-reload")), out).toBe(true);
    expect(restarted, `${out}\n${calls.join("\n")}`).toBe(false);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Not restarting");
  });

  it.skipIf(!existsSync(cli))("a unit it cannot read or parse is not restarted blind (#1070 review)", () => {
    for (const [label, text, opts] of [
      ["no [Service] section", "[Unit]\nDescription=x\n", {}],
      ["unreadable file", legacyUnit(), { unreadable: true }],
      ["unit it cannot update", legacyUnit(), { readOnlyDir: true }],
    ] as const) {
      const { r, calls, out, restarted } = restart(text, opts);
      expect(restarted, `${label}\n${out}\n${calls.join("\n")}`).toBe(false);
      expect(calls.some(c => c.startsWith("--user daemon-reload")), label).toBe(false);
      expect(r.status, label).toBe(1);
      expect(r.stderr, label).toContain("Not restarting");
    }
  });

  // The path `agend update` takes: the new binary's `install --no-activate`
  // has already written KillMode=mixed, so this restart finds it "present".
  it.skipIf(!existsSync(cli))("a unit that already has mixed in the file still needs systemd to have LOADED it", () => {
    const failed = restart(renderSystemdUnit(vars), { failReload: true });
    expect(failed.restarted, `${failed.out}\n${failed.calls.join("\n")}`).toBe(false);
    expect(failed.r.status).toBe(1);
    expect(failed.r.stderr).toContain("KillMode=control-group loaded");
    expect(failed.r.stderr).toContain("Not restarting");

    const ok = restart(renderSystemdUnit(vars));
    expect(ok.restarted, `${ok.out}\n${ok.calls.join("\n")}`).toBe(true);
    expect(ok.r.status).toBe(0);
    const order = ok.calls.map(c => c.split(" ").slice(0, 4).join(" "));
    const killModeShow = order.indexOf("--user show -p KillMode");
    expect(killModeShow).toBeGreaterThan(order.findIndex(c => c.startsWith("--user daemon-reload")));
    expect(order.findIndex(c => c.startsWith("--user restart"))).toBeGreaterThan(killModeShow);
  });

  it.skipIf(!existsSync(cli))("a reload that succeeds but leaves systemd on another KillMode, or an unreadable one, is refused", () => {
    for (const [label, text, opts] of [
      ["added, loaded stays control-group", legacyUnit(), { pinLoaded: true }],
      ["present, loaded stays control-group", renderSystemdUnit(vars), { pinLoaded: true }],
      ["show fails", renderSystemdUnit(vars), { failShow: true }],
    ] as const) {
      const { r, calls, out, restarted } = restart(text, opts);
      expect(calls.some(c => c.startsWith("--user daemon-reload")), label).toBe(true);
      expect(restarted, `${label}\n${out}\n${calls.join("\n")}`).toBe(false);
      expect(r.status, label).toBe(1);
      expect(r.stderr, label).toContain("Not restarting");
    }
  });

  // #1113: the crash-dump, start-timeout and start-limit directives ride the same migration.
  it.skipIf(!existsSync(cli))("#1113: fills in CoredumpFilter=0 etc. before the reload, verifies it loaded, then restarts", () => {
    const { r, calls, out, restarted, unit } = restart(legacyUnit());
    expect(restarted, `${out}\n${calls.join("\n")}`).toBe(true);
    const text = readFileSync(unit, "utf8");
    expect(serviceSection(text)).toMatch(/^CoredumpFilter=0$/m);
    expect(serviceSection(text)).toMatch(/^TimeoutStartSec=15min$/m);
    const order = calls.map(c => c.split(" ").slice(0, 4).join(" "));
    const show = order.findIndex(c => c.startsWith("--user show -p CoredumpFilter"));
    expect(show).toBeGreaterThan(order.findIndex(c => c.startsWith("--user daemon-reload")));
    expect(order.findIndex(c => c.startsWith("--user restart"))).toBeGreaterThan(show);
    expect(r.stdout).toContain("CoredumpFilter");
  });

  it.skipIf(!existsSync(cli))("#1113: a reload that leaves systemd on the default CoredumpFilter is refused (systemd 246+)", () => {
    const { r, calls, out, restarted } = restart(legacyUnit(), { pinFilter: true });
    expect(restarted, `${out}\n${calls.join("\n")}`).toBe(false);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CoredumpFilter=0x33 loaded");
    expect(r.stderr).toContain("Not restarting");
  });

  it.skipIf(!existsSync(cli))("#1113: a systemd that predates CoredumpFilter is warned about, not locked out of restarts", () => {
    const { r, calls, out, restarted } = restart(legacyUnit(), { pinFilter: true, systemdVersion: 245 });
    expect(restarted, `${out}\n${calls.join("\n")}`).toBe(true);
    expect(r.stdout).toContain("predates CoredumpFilter");
  });

  it.skipIf(!existsSync(cli))("#1113: an operator's own CoredumpFilter is left alone, warned, and not gated", () => {
    const { r, out, restarted, unit } = restart(legacyUnit().replace("TimeoutStopSec=60", "TimeoutStopSec=60\nCoredumpFilter=0x33"));
    expect(restarted, out).toBe(true);
    expect(r.stdout).toContain("sets its own CoredumpFilter");
    expect(readFileSync(unit, "utf8")).toContain("CoredumpFilter=0x33");
  });

  it.skipIf(!existsSync(cli))("#1122 r2: an operator's type-wide service.d CoredumpFilter is honoured, not gated", () => {
    const { r, out, restarted, unit } = restart(renderSystemdUnit(vars), { typeDropIn: "[Service]\nCoredumpFilter=0x33\n", pinFilter: true });
    expect(restarted, out).toBe(true);
    expect(r.stdout).toContain("sets its own CoredumpFilter");
    expect(readFileSync(unit, "utf8")).toMatch(/^CoredumpFilter=0$/m);
  });

  it.skipIf(!existsSync(cli))("#1122 r2: a drop-in only systemd knows about (DropInPaths) is honoured too", () => {
    const elsewhere = join(tmp(), "90-elsewhere.conf");
    writeFileSync(elsewhere, "[Service]\nCoredumpFilter=0x33\n");
    const { restarted, out } = restart(renderSystemdUnit(vars), { dropInPaths: elsewhere, pinFilter: true });
    expect(restarted, out).toBe(true);
    // Reported by systemd only once the reload loaded it (e.g. a load path AgEnD does not scan).
    const late = restart(renderSystemdUnit(vars), { dropInPaths: elsewhere, dropInPathsAfterReload: true, pinFilter: true });
    expect(late.restarted, late.out).toBe(true);
    expect(late.r.stdout).toContain("sets its own CoredumpFilter");
  });

  it.skipIf(!existsSync(cli))("#1122 r2: a trailing empty CoredumpFilter= (inherit) is the operator's, not gated; with no operator mask the loaded value still gates", () => {
    const inherit = restart(renderSystemdUnit(vars).replace("CoredumpFilter=0", "CoredumpFilter=0\nCoredumpFilter="), { pinFilter: true });
    expect(inherit.restarted, inherit.out).toBe(true);
    expect(inherit.r.stdout).toContain("sets its own CoredumpFilter");
    // No operator mask anywhere, loaded still 0x33: refused (the gate is not bypassed by any nonzero loaded value).
    const gated = restart(renderSystemdUnit(vars), { pinFilter: true });
    expect(gated.restarted, gated.out).toBe(false);
    expect(gated.r.stderr).toContain("Not restarting");
  });

  it.skipIf(!existsSync(cli))("#1122 r3: a unit-specific drop-in elsewhere (reported by systemd) shadows a same-named service.d one — reload failed, loaded 0x33 → refused", () => {
    const other = join(tmp(), "com.agend.fleet.service.d");
    mkdirSync(other);
    writeFileSync(join(other, "50-custom.conf"), "[Service]\nCoredumpFilter=\nCoredumpFilter=0\n");
    const { r, out, restarted } = restart(renderSystemdUnit(vars), {
      typeDropIn: "[Service]\nCoredumpFilter=0x33\n", dropInPaths: join(other, "50-custom.conf"), pinFilter: true, failReload: true, loaded: "mixed",
    });
    expect(restarted, out).toBe(false);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CoredumpFilter=0x33 loaded"); // refused by the filter gate, not KillMode
    expect(r.stdout).not.toContain("sets its own CoredumpFilter");
  });

  it.skipIf(!existsSync(cli))("#1122 r3: reported and on-disk drop-ins are applied in file-name order, not report-then-disk", () => {
    const elsewhere = join(tmp(), "90-custom.conf");
    writeFileSync(elsewhere, "[Service]\nCoredumpFilter=0x33\n");
    const { r, out, restarted } = restart(renderSystemdUnit(vars), {
      dropIn: "[Service]\nCoredumpFilter=\nCoredumpFilter=0\n", dropInName: "50-reset.conf", dropInPaths: elsewhere, pinFilter: true, failReload: true, loaded: "mixed",
    });
    // 50 (reset, 0) then 90 (0x33): the operator's mask stands — warned, restarted.
    expect(restarted, out).toBe(true);
    expect(r.stdout).toContain("sets its own CoredumpFilter");
  });

  it.skipIf(!existsSync(cli))("#1113: the start-limit counter is reset for the targeted unit, user AND system, before the restart (#1122 review)", () => {
    const user = restart(renderSystemdUnit(vars));
    const u = user.calls.map(c => c.replace(/ killmode=\w+$/, ""));
    expect(u.indexOf("--user reset-failed com.agend.fleet"), user.out).toBeGreaterThanOrEqual(0);
    expect(u.findIndex(c => c.startsWith("--user restart"))).toBeGreaterThan(u.indexOf("--user reset-failed com.agend.fleet"));

    const system = restart(renderSystemdUnit(vars), { system: true });
    const c = system.calls.map(x => x.replace(/ killmode=\w+$/, ""));
    expect(system.restarted, `${system.out}\n${c.join("\n")}`).toBe(true);
    expect(c.indexOf("reset-failed agend")).toBeGreaterThanOrEqual(0);
    expect(c.findIndex(x => x.startsWith("restart agend"))).toBeGreaterThan(c.indexOf("reset-failed agend"));
    expect(c.some(x => x.startsWith("--user"))).toBe(false);
  });

  it.skipIf(!existsSync(cli))("#1113: an operator's CoredumpFilter in a `systemctl edit` drop-in is honoured, not gated (#1122 review)", () => {
    const { r, out, restarted, unit } = restart(renderSystemdUnit(vars), { dropIn: "[Service]\nCoredumpFilter=0x33\n", pinFilter: true });
    expect(restarted, out).toBe(true);
    expect(r.stdout).toContain("sets its own CoredumpFilter");
    expect(readFileSync(unit, "utf8")).toMatch(/^CoredumpFilter=0$/m); // main file untouched
  });

  it.skipIf(!existsSync(cli))("an operator's own KillMode is respected: warned, and the restart goes ahead", () => {
    const { r, out, restarted, unit } = restart(legacyUnit().replace("TimeoutStopSec=60", "TimeoutStopSec=60\nKillMode=process"));
    expect(restarted, out).toBe(true);
    expect(r.stdout).toContain("sets its own KillMode");
    expect(readFileSync(unit, "utf8")).toContain("KillMode=process");
  });
});

/**
 * Opt-in (`AGEND_SYSTEMD_E2E=1`, a user systemd): real transient units. The
 * main process quits its detached child gracefully on SIGTERM, as the fleet
 * quits its CLIs; the child records which signal reached it first. Uses the
 * KillMode the real unit template renders, so a template regression flips it.
 */
describe.skipIf(process.env.AGEND_SYSTEMD_E2E !== "1")("real systemd: who signals a detached child on stop", () => {
  function probe(killMode: string): string {
    const dir = tmp();
    const out = join(dir, "out");
    writeFileSync(join(dir, "child.sh"), `#!/bin/sh
trap 'echo CHILD_GOT_SIGTERM >> "$1"; exit 0' TERM
trap 'echo CHILD_QUIT_GRACEFULLY >> "$1"; exit 0' USR1
echo $$ > "$1.pid"
while :; do sleep 1; done
`);
    writeFileSync(join(dir, "main.sh"), `#!/bin/sh
setsid "$(dirname "$0")/child.sh" "$1" </dev/null >/dev/null 2>&1 &
sleep 1
trap 'sleep 1; kill -USR1 "$(cat "$1.pid")"; sleep 1; exit 0' TERM
while :; do sleep 1; done
`);
    chmodSync(join(dir, "child.sh"), 0o755);
    chmodSync(join(dir, "main.sh"), 0o755);
    const unit = `agend-908-probe-${process.pid}-${killMode}`;
    execFileSync("systemd-run", ["--user", "--quiet", `--unit=${unit}`, "-p", `KillMode=${killMode}`, "-p", "TimeoutStopSec=10", join(dir, "main.sh"), out]);
    execFileSync("sleep", ["3"]);
    execFileSync("systemctl", ["--user", "stop", unit]);
    execFileSync("sleep", ["1"]);
    spawnSync("systemctl", ["--user", "reset-failed", unit]);
    return readFileSync(out, "utf8").trim();
  }

  it("the template's KillMode lets the fleet quit its CLIs; control-group SIGTERMs them", () => {
    const rendered = /^KillMode=(\w[\w-]*)$/m.exec(renderSystemdUnit(vars))?.[1] ?? "control-group";
    expect(probe(rendered)).toBe("CHILD_QUIT_GRACEFULLY");
    expect(probe("control-group")).toBe("CHILD_GOT_SIGTERM"); // what every unit before #908 did
  }, 60_000);
});
