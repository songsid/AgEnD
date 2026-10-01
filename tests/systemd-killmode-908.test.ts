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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSystemdKillModeMixed, renderSystemdUnit } from "../src/service-installer.js";

const vars = {
  label: "com.agend.fleet", execPath: "/usr/local/bin/agend", workingDirectory: "/home/u/.agend",
  logPath: "/home/u/.agend/daemon.log", path: "/usr/local/bin:/usr/bin:/bin",
};
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-908-")); dirs.push(d); return d; };
/** A unit as AgEnD wrote it before #908: the same, with no KillMode. */
const legacyUnit = () => renderSystemdUnit(vars).split("\n").filter(l => !/^KillMode=/.test(l) && !/^#.*(#908|tmux server and every|control-group mode|SIGTERMs all of them|WSL\) before|it\. With mixed|TimeoutStopSec is SIGKILLed)/.test(l)).join("\n");
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

describe("`agend restart` (what `agend update` spawns) fixes the unit before reloading it", () => {
  const cli = join(process.cwd(), "dist", "cli.js");
  it.skipIf(!existsSync(cli))("adds KillMode=mixed before `systemctl --user daemon-reload` (built CLI, stubbed systemctl)", () => {
    const home = tmp();
    const unitDir = join(home, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    const unit = join(unitDir, "com.agend.fleet.service");
    writeFileSync(unit, legacyUnit());
    const bin = join(home, "bin");
    mkdirSync(bin);
    const log = join(home, "systemctl.log");
    // Records each call with whether the unit already had KillMode=mixed then.
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh
has=no; grep -q '^KillMode=mixed$' '${unit}' && has=yes
echo "$* killmode=$has" >> '${log}'
case "$*" in *is-active*) echo active;; esac
exit 0
`);
    chmodSync(join(bin, "systemctl"), 0o755);
    const r = spawnSync(process.execPath, [cli, "restart"], {
      env: { ...process.env, HOME: home, AGEND_HOME: join(home, ".agend"), PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8", timeout: 60_000,
    });
    const calls = readFileSync(log, "utf8").trim().split("\n");
    const reload = calls.find(c => c.startsWith("--user daemon-reload"));
    expect(reload, `${r.stdout}\n${r.stderr}\n${calls.join("\n")}`).toBe("--user daemon-reload killmode=yes");
    expect(calls.some(c => c.includes("restart com.agend.fleet") && c.endsWith("killmode=yes"))).toBe(true);
    expect(r.stdout).toContain("KillMode=mixed");
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
