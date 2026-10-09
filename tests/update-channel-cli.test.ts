/**
 * `agend update` keeps an install on its channel. The built CLI runs from a
 * copy whose package.json says it is a beta; `npm`, `agend`, `systemctl` and
 * `launchctl` on PATH are stubs that only log, and npm's global prefix points
 * into the scratch directory — nothing real is installed, restarted or spawned.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cli = join(process.cwd(), "dist", "cli.js");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Run `agend update <args>` from an install of `installed`, with npm's tags pointing at `tags`. */
function update(installed: string, tags: { beta: string; latest: string }, args: string[], opts: { brokenNative?: boolean; staleFleet?: boolean; unitExec?: (paths: { globalCli: string; runningCli: string }) => string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "agend-update-cli-"));
  dirs.push(home);
  const agendHome = join(home, ".agend");
  mkdirSync(agendHome, { recursive: true });
  const pkg = join(home, "pkg");
  mkdirSync(pkg);
  spawnSync("cp", ["-r", join(process.cwd(), "dist"), join(pkg, "dist")]);
  spawnSync("cp", ["-r", join(process.cwd(), "templates"), join(pkg, "templates")]);
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ ...manifest, version: installed }));
  symlinkSync(join(process.cwd(), "node_modules"), join(pkg, "node_modules"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const log = join(home, "calls.log");
  writeFileSync(log, "");
  // The global install npm "makes": a package whose `agend` reports what npm last installed (#1446: the updater checks
  // the version and opens a database with the package's own better-sqlite3 on the `node` it runs under).
  const globalPkg = join(home, "lib", "node_modules", "@songsid", "agend");
  mkdirSync(join(globalPkg, "dist"), { recursive: true });
  if (opts.brokenNative) {
    // The installed package's native module crashes on open (better-sqlite3 13 on Node 20 SIGSEGVs; a throw stands in).
    mkdirSync(join(globalPkg, "node_modules", "better-sqlite3"), { recursive: true });
    writeFileSync(join(globalPkg, "node_modules", "better-sqlite3", "index.js"), "module.exports = class { constructor() { throw new Error('native open failed'); } };");
  } else {
    symlinkSync(join(process.cwd(), "node_modules"), join(globalPkg, "node_modules"));
  }
  const installedVersion = join(home, "installed-version");
  writeFileSync(installedVersion, installed);
  writeFileSync(join(globalPkg, "package.json"), JSON.stringify({ name: "@songsid/agend", version: installed, bin: { agend: "dist/cli.js" } }));
  writeFileSync(join(bin, "npm"), `#!/bin/sh
echo "npm $*" >> '${log}'
case "$*" in
  "view @songsid/agend@beta version") echo '${tags.beta}';;
  "view @songsid/agend@latest version") echo '${tags.latest}';;
  view*) echo "$2" | sed 's/.*@//';;
  "config get prefix") echo '${home}';;
  "root -g") echo '${join(home, "lib", "node_modules")}';;
  "prefix -g") echo '${home}';;
  "install -g "*) v=$(echo "$3" | sed 's/.*@//'); echo "$v" > '${installedVersion}'
    printf '{"name":"@songsid/agend","version":"%s","bin":{"agend":"dist/cli.js"}}' "$v" > '${join(globalPkg, "package.json")}';;
esac
exit 0
`);
  writeFileSync(join(globalPkg, "dist", "cli.js"), `#!/bin/sh\necho "agend $*" >> '${log}'\ncase "$*" in --version) cat '${installedVersion}';; esac\nexit 0\n`);
  chmodSync(join(globalPkg, "dist", "cli.js"), 0o755);
  symlinkSync(join(globalPkg, "dist", "cli.js"), join(bin, "agend"));
  symlinkSync(process.execPath, join(bin, "node"));
  for (const tool of ["systemctl", "launchctl"]) writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${log}'\nexit 0\n`);
  for (const f of ["npm", "systemctl", "launchctl"]) chmodSync(join(bin, f), 0o755);
  // An existing user unit (the authoritative service here), recording whatever executable the case says.
  let unitPath: string | null = null;
  if (opts.unitExec) {
    const unitDir = join(home, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    unitPath = join(unitDir, "com.agend.fleet.service");
    writeFileSync(unitPath, `[Service]\nExecStart=${opts.unitExec({ globalCli: join(globalPkg, "dist", "cli.js"), runningCli: join(pkg, "dist", "cli.js") })} fleet start\n`);
  }
  const unitBefore = unitPath ? readFileSync(unitPath, "utf8") : null;
  let fleetPid: number | null = null;
  if (opts.staleFleet) {
    // A fleet that started before the install: this CLI's own files land "later" (the stale-fleet branch). Detached
    // from this process (its shell exits), so when the restart signals it, init reaps it at once — a child of ours
    // would stay a zombie while spawnSync blocks, and the restart would wait out its full grace period.
    fleetPid = Number(spawnSync("bash", ["-c", '(exec -a "agend fleet start" sleep 60) >/dev/null 2>&1 & echo $!'], { encoding: "utf8" }).stdout.trim());
    writeFileSync(join(agendHome, "fleet.pid"), String(fleetPid));
    const later = new Date(Date.now() + 120_000);
    utimesSync(join(pkg, "dist", "cli.js"), later, later);
    spawnSync("sleep", ["0.2"]);
  }
  const r = spawnSync(process.execPath, [join(pkg, "dist", "cli.js"), "update", ...args], {
    env: {
      ...process.env, AGEND_ALLOW_TEST_FLEET_CONTROL: "1", AGEND_INSTANCE_NAME: "",
      HOME: home, AGEND_HOME: agendHome, PATH: `${bin}:/usr/bin:/bin`, npm_config_prefix: home,
    },
    encoding: "utf8", timeout: 60_000,
  });
  // A signalled child stays a zombie until this process reaps it, so liveness is "exists and not Z".
  const fleetAlive = fleetPid ? (() => {
    try { return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${fleetPid}/stat`, "utf8")); } catch { return false; }
  })() : null;
  if (fleetPid) { try { process.kill(fleetPid, "SIGKILL"); } catch { /* gone */ } }
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  const unitAfter = unitPath ? readFileSync(unitPath, "utf8") : null;
  return { r, calls, fleetAlive, unitBefore, unitAfter, out: `${r.stdout}\n${r.stderr}\n${calls.join("\n")}`, installs: calls.filter(c => c.startsWith("npm install")) };
}

describe("agend update stays on the installed channel (built CLI, stubbed npm)", () => {
  it("the CLI under test is built", () => {
    expect(existsSync(cli), "build first: these tests run dist/cli.js").toBe(true);
  });

  it("a beta install with no flag updates from @beta — never @latest", () => {
    const { r, installs, out } = update("2.1.11-beta.2", { beta: "2.1.11-beta.3", latest: "2.1.10" }, []);
    expect(installs, out).toEqual(["npm install -g @songsid/agend@2.1.11-beta.3"]);
    expect(r.status, out).toBe(0);
  });

  it("a stable install with no flag updates from @latest", () => {
    const { r, installs, out } = update("2.1.10", { beta: "2.1.11-beta.3", latest: "2.1.11" }, []);
    expect(installs, out).toEqual(["npm install -g @songsid/agend@2.1.11"]);
    expect(r.status, out).toBe(0);
  });

  it("an update that would go back a version is refused, and nothing is installed", () => {
    const { r, installs, out } = update("2.1.11-beta.2", { beta: "2.1.11-beta.1", latest: "2.1.10" }, []);
    expect(installs, out).toEqual([]);
    expect(r.status, out).toBe(1);
    expect(out).toContain("agend update --stable");
  });

  it("--beta does not override the guard either: going back still needs --stable, --version or --force", () => {
    const { r, installs, out } = update("2.1.11", { beta: "2.1.11-beta.3", latest: "2.1.11" }, ["--beta"]);
    expect(installs, out).toEqual([]);
    expect(r.status, out).toBe(1);
  });

  it("--stable moves a beta install to the stable release, even an older one", () => {
    const { r, installs, out } = update("2.1.11-beta.2", { beta: "2.1.11-beta.3", latest: "2.1.10" }, ["--stable"]);
    expect(installs, out).toEqual(["npm install -g @songsid/agend@2.1.10"]);
    expect(r.status, out).toBe(0);
  });

  it("--beta with --stable is a contradiction: refused before anything runs", () => {
    const { r, calls, out } = update("2.1.11-beta.2", { beta: "2.1.11-beta.3", latest: "2.1.10" }, ["--beta", "--stable"]);
    expect(calls, out).toEqual([]);
    expect(r.status, out).toBe(1);
  });

  it("installs exactly the version it checked, not the moving tag (#1182 review)", () => {
    // The tag was looked up as beta.3; what npm is told to install is beta.3, whatever @beta points at later.
    const { installs, calls, out } = update("2.1.11-beta.2", { beta: "2.1.11-beta.3", latest: "2.1.10" }, []);
    expect(installs, out).toEqual(["npm install -g @songsid/agend@2.1.11-beta.3"]);
    expect(calls.some(c => /install -g @songsid\/agend@(beta|latest)$/.test(c)), out).toBe(false);
  });

  it("a registry answer that is not a version installs from the tag, as when the lookup fails", () => {
    const { installs, out } = update("2.1.11-beta.2", { beta: "not-a-version", latest: "2.1.10" }, []);
    expect(installs, out).toEqual(["npm install -g @songsid/agend@beta"]);
  });

  it("`update --version` reaches the update command, and `agend --version` still prints the version (#1182 review)", () => {
    const pinned = update("2.1.11-beta.2", { beta: "2.1.11-beta.3", latest: "2.1.10" }, ["--version", "2.1.10"]);
    expect(pinned.installs, pinned.out).toEqual(["npm install -g @songsid/agend@2.1.10"]);
    expect(pinned.r.status, pinned.out).toBe(0);
    const contradiction = update("2.1.11-beta.2", { beta: "2.1.11-beta.3", latest: "2.1.10" }, ["--beta", "--stable", "--version", "2.1.10"]);
    expect(contradiction.calls, contradiction.out).toEqual([]);
    expect(contradiction.r.status, contradiction.out).toBe(1);
    const root = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
    expect(root.stdout.trim()).toBe(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version);
  });
});

// #1449 review: an update whose verification failed leaves the new version installed. Running `agend update` again
// then takes the "already installed, but the fleet predates it" branch — which must verify before it restarts.
describe("a second `agend update` after a failed verification (built CLI, stubbed npm, a stand-in stale fleet)", () => {
  it("does not restart the fleet onto an installed package that cannot open its database", { timeout: 60_000 }, () => {
    const { r, out, installs, fleetAlive } = update("2.2.0", { beta: "2.2.0", latest: "2.2.0" }, ["--stable"], { brokenNative: true, staleFleet: true });
    expect(installs, out).toEqual([]);
    expect(r.status, out).toBe(1);
    expect(out).toContain("cannot open a database");
    expect(out).toContain("Not restarting the fleet");
    expect(fleetAlive, "the running fleet was left alone").toBe(true);
  });

  it("a working installed package gets the restart — through the INSTALLED binary, not the one invoked", { timeout: 60_000 }, () => {
    // The invoking CLI is a different checkout (this build's copy) of the same version; PATH resolves the installed
    // package. Refresh and restart must go through the installed `agend`; the invoking checkout's own restart (which
    // would signal the stand-in fleet) must not run (#1449 review).
    const { out, calls, fleetAlive } = update("2.2.0", { beta: "2.2.0", latest: "2.2.0" }, ["--stable"], { staleFleet: true });
    expect(out).toContain("verified — restarting the fleet onto it");
    expect(calls).toContain("agend install --no-activate");
    expect(calls).toContain("agend restart");
    expect(fleetAlive, "only the installed agend (an inert stub here) was asked to restart").toBe(true);
  });

  it("an existing service unit that still starts another install is not restarted onto: refused, unit untouched", { timeout: 60_000 }, () => {
    const { r, out, calls, fleetAlive, unitBefore, unitAfter } = update("2.2.0", { beta: "2.2.0", latest: "2.2.0" }, ["--stable"],
      { staleFleet: true, unitExec: ({ runningCli }) => runningCli });
    expect(r.status, out).toBe(1);
    expect(out).toContain("not the verified install");
    expect(calls).not.toContain("agend restart");
    expect(unitAfter).toBe(unitBefore);
    expect(fleetAlive).toBe(true);
  });

  it("control: a unit that starts the verified install (by its bin link) is restarted onto", { timeout: 60_000 }, () => {
    const { out, calls } = update("2.2.0", { beta: "2.2.0", latest: "2.2.0" }, ["--stable"],
      { staleFleet: true, unitExec: ({ globalCli }) => globalCli });
    expect(out).toContain("verified — restarting the fleet onto it");
    expect(calls).toContain("agend restart");
  });
});

