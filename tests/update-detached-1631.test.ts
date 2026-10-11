/**
 * #1631 through the built CLI. A hand-started fleet on a host whose user systemd cannot be reached:
 * - A: two consecutive `agend update`s both complete (restart through the new binary) and leave no unit behind — the
 *   updater never runs the new binary's `install --no-activate`, which (like any binary before #1631 B) creates one;
 * - B: the REAL `install --no-activate` writes nothing only when it is certain an updater in flight started it, and
 *   creates the unit for every manual run (no marker, stale marker, dead pid, unrelated pid); an existing unit is
 *   still rewritten.
 * Stubs only: `npm`, `systemctl`, `busctl`, `launchctl` on PATH; scratch HOME and npm prefix; nothing is started.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cli = join(process.cwd(), "dist", "cli.js");
const dirs: string[] = [];
const cleanupKills: Array<() => void> = [];
afterEach(() => { for (const k of cleanupKills.splice(0)) k(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-1631-")); dirs.push(d); return d; };
const unitOf = (home: string) => join(home, ".config", "systemd", "user", "com.agend.fleet.service");
/** systemctl / busctl as on a host with no reachable user manager (a container, WSL without systemd, SSH, no linger). */
const noManager = (log: string, name: string) => `#!/bin/sh\necho "${name} $*" >> '${log}'\necho "Failed to connect to bus: No medium found" >&2\nexit 1\n`;

function updateWorld() {
  const home = scratch();
  const agendHome = join(home, ".agend"); mkdirSync(agendHome, { recursive: true });
  const pkg = join(home, "pkg"); mkdirSync(pkg);
  for (const d of ["dist", "templates", "launcher"]) spawnSync("cp", ["-r", join(process.cwd(), d), join(pkg, d)]);
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ ...manifest, version: "2.2.0-beta.2" }));
  symlinkSync(join(process.cwd(), "node_modules"), join(pkg, "node_modules"));
  const bin = join(home, "bin"); mkdirSync(bin);
  const log = join(home, "calls.log"); writeFileSync(log, "");
  const globalPkg = join(home, "lib", "node_modules", "@songsid", "agend");
  mkdirSync(join(globalPkg, "dist"), { recursive: true });
  symlinkSync(join(process.cwd(), "node_modules"), join(globalPkg, "node_modules"));
  const installed = join(home, "installed-version"); writeFileSync(installed, "2.2.0-beta.2");
  const beta = join(home, "beta-version");
  writeFileSync(join(globalPkg, "package.json"), JSON.stringify({ name: "@songsid/agend", version: "2.2.0-beta.2", bin: { agend: "dist/cli.js" } }));
  writeFileSync(join(bin, "npm"), `#!/bin/sh
echo "npm $*" >> '${log}'
case "$*" in
  "view @songsid/agend@beta version") cat '${beta}';;
  *"--json") exit 1;;
  view*) echo "$2" | sed 's/.*@//';;
  "config get prefix") echo '${home}';;
  "root -g") echo '${join(home, "lib", "node_modules")}';;
  "prefix -g") echo '${home}';;
  "install -g "*) v=$(echo "$3" | sed 's/.*@//'); echo "$v" > '${installed}'
    printf '{"name":"@songsid/agend","version":"%s","bin":{"agend":"dist/cli.js"}}' "$v" > '${join(globalPkg, "package.json")}';;
esac
exit 0
`);
  // The NEW binary as any version before #1631 B behaves: `install --no-activate` writes the unit; `restart` succeeds.
  writeFileSync(join(globalPkg, "dist", "cli.js"), [
    "#!/usr/bin/env node", "const fs = require('fs'), path = require('path');",
    `fs.appendFileSync(${JSON.stringify(log)}, 'agend ' + process.argv.slice(2).join(' ') + '\\n');`,
    `if (process.argv[2] === '--version') process.stdout.write(fs.readFileSync(${JSON.stringify(installed)}, 'utf8'));`,
    `if (process.argv[2] === 'install') { fs.mkdirSync(path.dirname(${JSON.stringify(unitOf(home))}), { recursive: true }); fs.writeFileSync(${JSON.stringify(unitOf(home))}, '[Service]\\nExecStart=/x/node /x/cli.js fleet start\\n'); }`,
  ].join("\n") + "\n");
  chmodSync(join(globalPkg, "dist", "cli.js"), 0o755);
  symlinkSync(join(globalPkg, "dist", "cli.js"), join(bin, "agend"));
  writeFileSync(join(bin, "systemctl"), noManager(log, "systemctl"));
  writeFileSync(join(bin, "busctl"), noManager(log, "busctl"));
  writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "launchctl $*" >> '${log}'\nexit 0\n`);
  for (const f of ["npm", "systemctl", "busctl", "launchctl"]) chmodSync(join(bin, f), 0o755);
  symlinkSync(process.execPath, join(bin, "node"));
  const update = (next: string) => {
    writeFileSync(beta, next);
    const from = readFileSync(installed, "utf8").trim();
    // The installed version runs the update: its package.json is what `agend update` reads as "installed".
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ ...manifest, version: from }));
    writeFileSync(log, "");
    const r = spawnSync(process.execPath, [join(pkg, "dist", "cli.js"), "update"], {
      env: { ...process.env, AGEND_ALLOW_TEST_FLEET_CONTROL: "1", AGEND_INSTANCE_NAME: "", HOME: home, AGEND_HOME: agendHome, PATH: `${bin}:/usr/bin:/bin`, npm_config_prefix: home },
      encoding: "utf8", timeout: 90_000,
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    return { r, calls, out: `${r.stdout}\n${r.stderr}\n${calls.join("\n")}` };
  };
  return { home, update, installed };
}

describe("#1631 A: a hand-started fleet, no reachable user manager — every update completes, no unit is created", () => {
  it("the CLI under test is built", () => { expect(existsSync(cli), "build first").toBe(true); });

  it("two consecutive updates both complete through the new binary's restart and leave no unit", { timeout: 120_000 }, () => {
    const w = updateWorld();
    const first = w.update("2.2.0-beta.3");
    expect(first.r.status, first.out).toBe(0);
    expect(first.calls).toContain("agend restart");
    expect(first.calls.filter(c => c.startsWith("agend install")), "the updater never asks for a service file").toEqual([]);
    expect(existsSync(unitOf(w.home)), "no unit after the first update").toBe(false);
    const second = w.update("2.2.0-beta.4");
    expect(second.r.status, second.out).toBe(0);
    expect(readFileSync(w.installed, "utf8").trim()).toBe("2.2.0-beta.4");
    expect(second.calls).toContain("agend restart");
    expect(second.out).not.toContain("back in place");
    expect(existsSync(unitOf(w.home)), "no unit after the second update").toBe(false);
  });

  it("control — a unit already there (an earlier `agend install`): the r5 fail-safe stands, the update is rolled back", { timeout: 120_000 }, () => {
    const w = updateWorld();
    mkdirSync(join(w.home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(unitOf(w.home), "[Service]\nExecStart=/old/node /old/cli.js fleet start\n");
    const r = w.update("2.2.0-beta.3");
    expect(r.r.status, r.out).toBe(1);
    expect(r.calls, "the existing unit is refreshed").toContain("agend install --no-activate");
    expect(r.out).toContain("back in place");
  });
});

describe("#1631 B: the real `install --no-activate` creates nothing only for a certain updater refresh", () => {
  /** Run the built CLI's `install --no-activate`. `parent` = what the process above it does first (sh, as data). */
  function install(opts: { marker?: (parentPid: string) => string; mtimeAgoMs?: number; existing?: string } = {}) {
    const home = scratch();
    const agendHome = join(home, ".agend"); mkdirSync(agendHome, { recursive: true });
    const bin = join(home, "bin"); mkdirSync(bin);
    const log = join(home, "calls.log"); writeFileSync(log, "");
    for (const t of ["systemctl", "busctl"]) { writeFileSync(join(bin, t), noManager(log, t)); chmodSync(join(bin, t), 0o755); }
    symlinkSync(process.execPath, join(bin, "node"));
    if (opts.existing) { mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true }); writeFileSync(unitOf(home), opts.existing); }
    const markerFile = join(agendHome, "update-in-progress.json");
    // The parent shell writes the marker (with its own pid, as markUpdateInProgress does), then runs the install as
    // its child — the updater → refresh relation. `$$` is that shell's pid.
    const script = [
      opts.marker ? `printf '%s' "${opts.marker("$$").replace(/"/g, '\\"')}" > '${markerFile}'` : ":",
      opts.mtimeAgoMs ? `touch -d "@$(( $(date +%s) - ${Math.round(opts.mtimeAgoMs / 1000)} ))" '${markerFile}'` : ":",
      `'${process.execPath}' '${cli}' install --no-activate; echo "rc=$?"`,
    ].join("\n");
    const r = spawnSync("sh", ["-c", script], {
      env: { ...process.env, HOME: home, AGEND_HOME: agendHome, PATH: `${bin}:/usr/bin:/bin`, AGEND_INSTANCE_NAME: "" },
      encoding: "utf8", timeout: 60_000,
    });
    return { r, out: `${r.stdout}\n${r.stderr}`, unit: existsSync(unitOf(home)) ? readFileSync(unitOf(home), "utf8") : null };
  }
  const fresh = (pid: string) => `{"startedAt":${Date.now()},"pid":${pid}}`;
  /** A live process that is no ancestor of the install. */
  const sibling = () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    cleanupKills.push(() => child.kill());
    return child.pid!;
  };

  it("started by the updater (fresh marker naming its live parent): no unit is created", { timeout: 60_000 }, () => {
    const { out, unit } = install({ marker: fresh });
    expect(out).toContain("rc=0");
    expect(out).toContain("No service to refresh");
    expect(unit).toBeNull();
  });

  const manual: Array<[string, Parameters<typeof install>[0]]> = [
    ["no marker", {}],
    ["a stale marker naming its parent (left by a crashed update, 16 min old)", { marker: fresh, mtimeAgoMs: 16 * 60_000 }],
    ["a fresh marker naming a dead pid", { marker: () => `{"startedAt":${Date.now()},"pid":2147483000}` }],
    ["a fresh marker naming an unrelated live pid (a sibling `sleep`, started before the marker)", { marker: () => `{"startedAt":${Date.now()},"pid":${sibling()}}` }],
    ["a fresh marker for another target version", { marker: (pid: string) => `{"startedAt":${Date.now()},"pid":${pid},"progress":{"stage":"installed","version":"9.9.9","target":{"adapterId":"a","chatId":"c","messageId":"m"}}}` }],
  ];
  it.each(manual)("a manual run with %s: the unit is created as always", { timeout: 60_000 }, (_label, opts) => {
    const { out, unit } = install(opts);
    expect(out).toContain("rc=0");
    expect(out).not.toContain("No service to refresh");
    expect(unit, out).toContain("ExecStart=");
  });

  it("a unit already there is still rewritten, also when the updater started the refresh", { timeout: 60_000 }, () => {
    const { out, unit } = install({ marker: fresh, existing: "[Service]\nExecStart=/old/node /old/cli.js fleet start\n" });
    expect(out).toContain("rc=0");
    expect(unit).not.toContain("/old/cli.js");
    expect(unit).toContain("ExecStart=");
  });
});
