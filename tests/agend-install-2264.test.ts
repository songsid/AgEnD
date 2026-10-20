/**
 * #2264: the user's failed update, reproduced with REAL npm in a scratch prefix, and the one repair: the target release's
 * own installer, run the way `agend update` and install.sh run it (`npm exec --package <release> -- agend-install`).
 *
 * The user's host after `/update` (WSL, root, nvm prefix): npm had moved the installed AgEnD to its retire sibling
 * `@songsid/.agend-<hash>` and been killed before finishing — `agend: command not found`; `npm install -g` then failed
 * ENOTEMPTY on that sibling; after removing it by hand, an install lock that could not be read refused every install;
 * after removing that too, `agend start` could not reach the user's systemd. Here every one of those is in place at once
 * and a single run of the installer must end with a working `agend`, no manual step.
 *
 * Fake releases (tarballs with no dependencies, so npm works offline) stand in for @songsid/agend: their `agend` prints
 * the version and records `install`/`restart` calls; the newer one carries the REAL launcher/agend-install.cjs.
 * npm's retire name is deterministic (`.<name>-` + 8 alphanumerics of sha1(<path>) in base64 — the user's
 * `.agend-RmEK4vIL`), so the sibling left here is exactly the one npm itself collides with.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, realpathSync, statSync, utimesSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { ensureUserSystemd, type UserSystemdDeps } from "../src/user-systemd.js";
import { acquireInstallLock, type InstallLock } from "../src/install-lock.js";

const REPO = join(import.meta.dirname, "..");
const lockReaders = createRequire(import.meta.url)("../launcher/install-admission.cjs") as { processStart(pid: number): string | null; startTicks(pid: number): string | null; bootId(): string | null; parse(t: string): unknown; holderState(l: unknown, d: unknown): string };
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function release(dir: string, version: string, opts: { brokenVersion?: string } = {}): string {
  const pkg = join(dir, `src-${version}`);
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(join(pkg, "launcher"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@songsid/agend", version, bin: { agend: "bin/agend", "agend-install": "launcher/agend-install.cjs" } }));
  // The fake agend: its version, and a log of the service calls the installer makes through it.
  writeFileSync(join(pkg, "bin", "agend"), `#!/bin/sh
[ "$1" = "--version" ] && { echo ${opts.brokenVersion ?? version}; exit 0; }
echo "$*" >> "\${AGEND_HOME}/agend-calls.log"
exit 0
`);
  chmodSync(join(pkg, "bin", "agend"), 0o755);
  cpSync(join(REPO, "launcher", "agend-install.cjs"), join(pkg, "launcher", "agend-install.cjs"));
  cpSync(join(REPO, "launcher", "install-admission.cjs"), join(pkg, "launcher", "install-admission.cjs"));   // the lock's process readers
  chmodSync(join(pkg, "launcher", "agend-install.cjs"), 0o755);
  const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: pkg, encoding: "utf8", env: npmEnv(dir) });
  if (packed.status !== 0) throw new Error(`npm pack: ${packed.stderr}`);
  return join(dir, packed.stdout.trim().split("\n").pop()!);
}

/**
 * A scratch HOME (the installer looks for the service unit there, never in the real one) and a `ps` that shows only the
 * caller's own ancestry (the installer, its `npm exec`, this test's runner): the installer's npm-idle check judges that
 * for real, and an npm another test file runs at the same time — CI runs files in parallel — never reads as "npm is
 * running" here. `foreignNpm` adds one npm that is installing.
 */
function npmEnv(root: string, home?: string, opts: { foreignNpm?: boolean } = {}): NodeJS.ProcessEnv {
  const tools = join(root, "tools");
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, "ps"), `#!/bin/sh
/bin/ps -A -o pid=,ppid=,args= | awk -v start=$PPID '{ parent[$1] = $2; line[$1] = $0 } END { p = start; while (p > 1 && (p in line) && !(p in seen)) { seen[p] = 1; print line[p]; p = parent[p] } }'
${opts.foreignNpm ? `echo "  999999       1 npm install something-else"` : ""}
`);
  chmodSync(join(tools, "ps"), 0o755);
  return {
    ...process.env, PATH: `${tools}:${process.env.PATH}`, HOME: join(root, "user-home"),
    npm_config_prefix: join(root, "prefix"), npm_config_cache: join(root, "cache"), npm_config_audit: "false", npm_config_fund: "false",
    npm_config_update_notifier: "false", npm_config_offline: "true", npm_config_loglevel: "error",
    ...(home ? { AGEND_HOME: home } : {}),
  };
}
/** The user's systemd unit (what `agend install` made before): the installer then refreshes it through the new release. */
function withUnit(root: string) {
  const dir = join(root, "user-home", ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "com.agend.fleet.service"), "[Service]\nExecStart=/old/agend fleet start\n");
}
/** A fleet that runs now: fleet.pid names a live process (this test's own). */
const fleetRuns = (home: string) => writeFileSync(join(home, "fleet.pid"), String(process.pid));

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "agend-2264-")); roots.push(root);
  const home = join(root, "agend-home"); mkdirSync(home, { recursive: true });
  mkdirSync(join(root, "prefix"), { recursive: true });
  mkdirSync(join(root, "user-home"), { recursive: true });
  const npm = (args: string[], env: NodeJS.ProcessEnv = npmEnv(root, home)) => spawnSync("npm", args, { encoding: "utf8", env, timeout: 120_000 });
  const pkgDir = join(root, "prefix", "lib", "node_modules", "@songsid", "agend");
  const bin = join(root, "prefix", "bin", "agend");
  const version = () => { const r = spawnSync(bin, ["--version"], { encoding: "utf8", env: { ...process.env, AGEND_HOME: home } }); return r.status === 0 ? r.stdout.trim() : null; };
  const quarantined = () => { const q = join(root, "prefix", ".agend-quarantine"); return existsSync(q) ? readdirSync(q).flatMap(d => readdirSync(join(q, d))) : []; };
  return { root, home, npm, pkgDir, bin, version, quarantined };
}

/** npm's retire name for a path (@npmcli/arborist retire-path.js: `.${basename}-` + sha1(path) base64, alphanumerics, 8). */
const retireName = (path: string) => `.agend-${createHash("sha1").update(path).digest("base64").replace(/[^a-zA-Z0-9]+/g, "").slice(0, 8)}`;

/** The host the user was left with: everything an interrupted `/update` leaves, at once. */
function interruptedUpdate(s: ReturnType<typeof scratch>, partialVersion: string) {
  // npm moved the installed AgEnD aside, started writing the new one, and was killed: a partial new package (no bin
  // yet) in place, the old one in the retire sibling, `bin/agend` leading nowhere.
  const sibling = join(dirname(s.pkgDir), retireName(s.pkgDir));
  renameSync(s.pkgDir, sibling);
  renameSync(s.bin, join(dirname(s.bin), retireName(s.bin)));   // npm retires the bin link the same way
  mkdirSync(s.pkgDir);
  // package.json (with its bin map) is written first; the bins it names are not there yet.
  writeFileSync(join(s.pkgDir, "package.json"), JSON.stringify({ name: "@songsid/agend", version: partialVersion, bin: { agend: "./launcher/agend" } }));
  // The install lock, cut short (written, never flushed): "cannot be read as a lock".
  writeFileSync(join(s.root, "prefix", ".agend-install.lock"), '{"pid":');
  const longAgo = new Date(Date.now() - 10 * 60_000); utimesSync(join(s.root, "prefix", ".agend-install.lock"), longAgo, longAgo);   // left there since
  // The chat's progress, stuck at "downloading".
  writeFileSync(join(s.home, "update-in-progress.json"), JSON.stringify({ startedAt: Date.now() - 60_000, pid: 999999, progress: { operation: "update", stage: "downloading", target: { adapterId: "telegram", chatId: "1", messageId: "2" } } }));
  writeFileSync(join(s.home, "fleet.yaml"), "instances: {}\n");
  return sibling;
}

describe("#2264 the user's interrupted update, with real npm", { timeout: 240_000 }, () => {
  it("as left: `agend` is gone, and a plain `npm install -g` fails ENOTEMPTY on npm's own sibling (the user's step 1)", () => {
    const s = scratch();
    const v1 = release(s.root, "1.0.0"), v2 = release(s.root, "2.0.0");
    expect(s.npm(["install", "-g", v1]).status).toBe(0);
    expect(s.version()).toBe("1.0.0");
    interruptedUpdate(s, "2.0.0");
    expect(s.version(), "`agend` no longer runs").toBeNull();
    const plain = s.npm(["install", "-g", v2]);
    expect(plain.status).not.toBe(0);
    expect(plain.stderr).toMatch(/ENOTEMPTY/);
  });

  it("one run of the target's installer (npm exec, as `agend update` and install.sh run it) ends with a working agend — no manual step", () => {
    const s = scratch();
    const v1 = release(s.root, "1.0.0"), v2 = release(s.root, "2.0.0");
    expect(s.npm(["install", "-g", v1]).status).toBe(0);
    const sibling = interruptedUpdate(s, "2.0.0");
    withUnit(s.root);   // the user's host: the fleet runs as the systemd user service `agend install` made
    fleetRuns(s.home);
    const run = s.npm(["exec", "--yes", "--package", v2, "--", "agend-install", "--upgrade", "--spec", v2]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(s.version()).toBe("2.0.0");
    expect(readlinkSync(s.bin)).toContain("@songsid/agend/bin/agend");
    expect(existsSync(sibling), "npm's sibling is out of the way").toBe(false);
    expect(readdirSync(dirname(s.pkgDir)).filter(n => n.startsWith(".agend-"))).toEqual([]);
    // Nothing is deleted: the lock, the partial new package, npm's retired bin link — kept in quarantine as evidence.
    expect(s.quarantined().sort()).toEqual([".agend-install.lock", "agend", retireName(s.bin)].sort());
    expect(run.stdout, "the whole old copy wins over a partial new one").toMatch(/put back AgEnD v1\.0\.0/);
    expect(readdirSync(dirname(s.bin)).filter(n => n.startsWith(".agend")), "and npm's retired bin link").toEqual([]);
    expect(existsSync(join(s.root, "prefix", ".agend-install.lock")), "the unreadable lock is gone, and so is the installer's own").toBe(false);
    expect(run.stdout).toMatch(/moved aside an install lock that could not be read/);
    // The service is the new release's: its `agend install --no-activate` (the unit rewritten under the manager it has;
    // linger on — ensureUserSystemd below), then the restart onto it.
    expect(readFileSync(join(s.home, "agend-calls.log"), "utf8").trim().split("\n")).toEqual(["install --no-activate", "restart --yes"]);
    // The chat's progress moved on from "downloading": installed, v2.0.0 (the new fleet takes it to its final message).
    const marker = JSON.parse(readFileSync(join(s.home, "update-in-progress.json"), "utf8"));
    expect(marker.progress).toMatchObject({ stage: "installed", version: "2.0.0", target: { messageId: "2" } });
  });

  it("killed before any of the new release was written: the old AgEnD is put back first (it runs again), then updated", () => {
    const s = scratch();
    const v1 = release(s.root, "1.0.0"), v2 = release(s.root, "2.0.0");
    expect(s.npm(["install", "-g", v1]).status).toBe(0);
    const sibling = interruptedUpdate(s, "2.0.0");
    rmSync(s.pkgDir, { recursive: true });   // nothing of the new one yet: the sibling is the only copy
    const run = s.npm(["exec", "--yes", "--package", v2, "--", "agend-install", "--spec", v2]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/put back AgEnD v1\.0\.0 that an interrupted install had moved aside/);
    expect(s.version()).toBe("2.0.0");
    expect(existsSync(sibling)).toBe(false);
  });

  it("a hand-started fleet (no service unit): no unit is made (#1631), only the restart onto the new release", () => {
    const s = scratch();
    const v1 = release(s.root, "1.0.0"), v2 = release(s.root, "2.0.0");
    expect(s.npm(["install", "-g", v1]).status).toBe(0);
    interruptedUpdate(s, "2.0.0");
    fleetRuns(s.home);
    const run = s.npm(["exec", "--yes", "--package", v2, "--", "agend-install", "--upgrade", "--spec", v2]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(readFileSync(join(s.home, "agend-calls.log"), "utf8").trim().split("\n")).toEqual(["restart --yes"]);
  });

  it("the user's host after the session ended: the service is installed but stopped — refreshed, then started (re-running the one-liner)", () => {
    const s = scratch();
    const v1 = release(s.root, "1.0.0"), v2 = release(s.root, "2.0.0");
    expect(s.npm(["install", "-g", v1]).status).toBe(0);
    interruptedUpdate(s, "2.0.0");
    withUnit(s.root);
    const run = s.npm(["exec", "--yes", "--package", v2, "--", "agend-install", "--spec", v2]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(readFileSync(join(s.home, "agend-calls.log"), "utf8").trim().split("\n")).toEqual(["install --no-activate", "start"]);
  });

  it("another npm running on the host: npm's leftovers are not touched (the installer says so), and npm then fails as before", () => {
    const s = scratch();
    const v1 = release(s.root, "1.0.0"), v2 = release(s.root, "2.0.0");
    expect(s.npm(["install", "-g", v1]).status).toBe(0);
    const sibling = interruptedUpdate(s, "2.0.0");
    const run = s.npm(["exec", "--yes", "--package", v2, "--", "agend-install", "--spec", v2], npmEnv(s.root, s.home, { foreignNpm: true }));
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/another npm is running on this host, so what an earlier install left .* was not touched/);
    expect(existsSync(sibling), "left exactly where npm put it").toBe(true);
  });

  it("npm fails and the previous version still runs: nothing else is done, and that is what is said", () => {
    const s = scratch();
    const v1 = release(s.root, "1.0.0");
    expect(s.npm(["install", "-g", v1]).status).toBe(0);
    const v2 = release(s.root, "2.0.0");
    writeFileSync(join(s.home, "update-in-progress.json"), JSON.stringify({ startedAt: Date.now(), pid: 999999, progress: { operation: "update", stage: "downloading", target: { adapterId: "t", chatId: "1", messageId: "2" } } }));
    const missing = join(s.root, "no-such-release.tgz");
    const run = s.npm(["exec", "--yes", "--package", v2, "--", "agend-install", "--spec", missing]);
    expect(run.status).toBe(1);
    expect(s.version()).toBe("1.0.0");
    expect(run.stdout).toMatch(/failed \(exit \d+\); v1\.0\.0 is still installed and runs — nothing was changed/);
    expect(JSON.parse(readFileSync(join(s.home, "update-in-progress.json"), "utf8")).progress).toMatchObject({ stage: "failed", error: expect.stringContaining("still installed and runs") });
  });

  it("a release that does not prove itself: the previous one is put back and works, and the chat hears why", () => {
    const s = scratch();
    const v1 = release(s.root, "1.0.0"), bad = release(s.root, "2.0.0", { brokenVersion: "0.0.0" });
    expect(s.npm(["install", "-g", v1]).status).toBe(0);
    writeFileSync(join(s.home, "update-in-progress.json"), JSON.stringify({ startedAt: Date.now(), pid: 999999, progress: { operation: "update", stage: "downloading", target: { adapterId: "t", chatId: "1", messageId: "2" } } }));
    // The fallback reinstalls `@songsid/agend@1.0.0` from the registry; offline here, from its tarball.
    const run = s.npm(["exec", "--yes", "--package", bad, "--", "agend-install", "--spec", bad, "--previous-spec", v1]);
    expect(run.status).toBe(1);
    expect(s.version(), "the previous release runs").toBe("1.0.0");
    const marker = JSON.parse(readFileSync(join(s.home, "update-in-progress.json"), "utf8"));
    expect(marker.progress.stage).toBe("failed");
    expect(marker.progress.error).toMatch(/reports 0\.0\.0, not v2\.0\.0; v1\.0\.0 was reinstalled and runs/);
  });

  it("a live installer's lock is respected (the only thing the lock still does): nothing is installed, the chat is told", () => {
    const s = scratch();
    const v1 = release(s.root, "1.0.0"), v2 = release(s.root, "2.0.0");
    expect(s.npm(["install", "-g", v1]).status).toBe(0);
    writeFileSync(join(s.root, "prefix", ".agend-install.lock"), oldLock(process.pid, lockReaders.processStart(process.pid)!));
    const run = s.npm(["exec", "--yes", "--package", v2, "--", "agend-install", "--spec", v2]);
    expect(run.status).toBe(75);
    expect(run.stdout).toMatch(/another AgEnD install \(pid \d+\) is running/);
    expect(s.version()).toBe("1.0.0");
  });

  it("a manual `npm install -g` is never refused because of a lock: AgEnD's postinstall no longer reads one", () => {
    const postinstall = readFileSync(join(REPO, "launcher", "postinstall.cjs"), "utf8");
    expect(postinstall).not.toMatch(/install-admission|admission\.admit|old-updater-note/);
    expect(existsSync(join(REPO, "launcher", "old-updater-note.cjs")), "the 2.1.12 restore note is gone").toBe(false);
    expect(readFileSync(join(REPO, "scripts", "preinstall-guard.cjs"), "utf8")).not.toMatch(/2\.1\.12|old-updater/);
  });
});

describe("#2264 the user's systemd is reached before any `systemctl --user` (the user's steps 3 and 4)", () => {
  const fake = (over: Partial<UserSystemdDeps> & { present?: Set<string> } = {}) => {
    const present = over.present ?? new Set<string>();
    const calls: string[] = [];
    const deps: UserSystemdDeps = {
      uid: 0, user: "root", env: {}, exists: p => present.has(p),
      run: (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        // Linger starts the user's manager: its sockets appear.
        if (command === "loginctl") { present.add("/var/lib/systemd/linger/root"); present.add("/run/user/0/systemd/private"); present.add("/run/user/0/bus"); }
        return { status: 0 };
      },
      sleep: () => {}, ...over,
    };
    return { deps, calls, present };
  };

  it("root with no linger, no XDG_RUNTIME_DIR and no bus: linger on, the manager up, both variables filled", () => {
    const f = fake();
    const r = ensureUserSystemd(f.deps, { waitMs: 1_000, linger: true });
    expect(f.calls[0]).toBe("loginctl enable-linger root");
    expect(r).toEqual({ lingerEnabled: true, managerUp: true, envFilled: ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] });
    expect(f.deps.env).toMatchObject({ XDG_RUNTIME_DIR: "/run/user/0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus" });
  });

  it("a query (status, stop): only the variables are filled in — linger is never turned on, nothing is started or waited for", () => {
    const f = fake({ present: new Set(["/run/user/0/bus"]) });
    expect(ensureUserSystemd(f.deps, { waitMs: 1_000 })).toEqual({ lingerEnabled: false, managerUp: false, envFilled: ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] });
    expect(f.calls).toEqual([]);
  });

  it("linger already on and a session's variables set: nothing is changed or run", () => {
    const f = fake({ present: new Set(["/var/lib/systemd/linger/root", "/run/user/0/systemd/private", "/run/user/0/bus"]), env: { XDG_RUNTIME_DIR: "/run/user/0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus" } });
    expect(ensureUserSystemd(f.deps)).toEqual({ lingerEnabled: true, managerUp: true, envFilled: [] });
    expect(f.calls).toEqual([]);
  });

  it("linger refused (no permission): the manager is still waited for briefly, root asks for user@0, and the answer says so", () => {
    const f = fake();
    f.deps.run = (command, args) => { f.calls.push(`${command} ${args.join(" ")}`); return { status: 1 }; };
    const r = ensureUserSystemd(f.deps, { waitMs: 500, linger: true });
    expect(r).toEqual({ lingerEnabled: false, managerUp: false, envFilled: ["XDG_RUNTIME_DIR"] });
    expect(f.calls).toEqual(["loginctl enable-linger root", "systemctl start user@0.service"]);
  });
});

describe("#2264 review: npm is provably idle — no npm that changes packages runs (Prism r1: flag values, ancestors)", () => {
  const { npmIdleFromProcessList } = createRequire(import.meta.url)("../launcher/agend-install.cjs") as { npmIdleFromProcessList(out: string, pid: number): boolean };
  const ps = (rows: string[]) => rows.join("\n");
  // npm's own process title: `npm <command> <args>` without flags (observed: `npm install /x.tgz` for `npm install -g /x.tgz`).
  const own = ["  1     0 /sbin/init", " 50     1 bash", "100    50 npm exec agend-install --upgrade", "200   100 sh -c agend-install --upgrade", "300   200 node /x/agend-install.cjs --upgrade"];
  it("this installer's own `npm exec` ancestor, and npm that changes nothing (exec servers, view, run, npx): idle", () => {
    expect(npmIdleFromProcessList(ps(own), 300)).toBe(true);
    expect(npmIdleFromProcessList(ps([...own, "400     1 npm exec mcp-remote https://example.invalid/mcp", "401   400 sh -c mcp-remote", "402     1 npm view @songsid/agend version", "403     1 npm run build"]), 300), "a fleet's MCP servers run under npm exec for hours").toBe(true);
    expect(npmIdleFromProcessList(ps([...own, "404     1 node /usr/lib/node_modules/npm/bin/npm-cli.js exec something", "405     1 npx -y mcp-remote x", "406     1 npm --loglevel=silent exec y",
      "407     1 node /x/npm-cli.js --userconfig /tmp/npmrc exec mcp-remote z", "408     1 npm --loglevel silent exec y", "409     1 npm -y exec z"]), 300), "a flag's value is skipped, not taken for the command").toBe(true);
  });
  it("any npm that installs, uninstalls, updates or links — titled, as `node …/npm-cli.js`, behind flags with values, or an ancestor — is not idle", () => {
    for (const row of ["npm install /tmp/x.tgz", "node /home/u/.nvm/versions/node/v22/bin/npm install -g other", "/usr/bin/node /usr/lib/node_modules/npm/bin/npm-cli.js uninstall -g x",
      "npm i x", "npm update", "npm link", "npm uninstall @songsid/agend",
      // Prism r1: argv as started, before npm retitles itself — a flag's value is not the command.
      "node /opt/npm/bin/npm-cli.js --userconfig /tmp/npmrc install -g @songsid/agend", "npm --prefix /tmp/prefix install -g @songsid/agend", "npm --global install x",
      // Prism r2: a flag that takes a value takes the next word whatever it says — even a command's name.
      "npm --prefix run install -g @songsid/agend", "node /opt/npm/bin/npm-cli.js --userconfig config install -g @songsid/agend",
      // An unknown flag may or may not take a value: every reading counts.
      "npm --foo run install", "npm --foo exec mcp-remote"]) {
      expect(npmIdleFromProcessList(ps([...own, `400     1 ${row}`]), 300), row).toBe(false);
    }
    expect(npmIdleFromProcessList(ps([...own.slice(0, 2), "100    50 npm install -g @songsid/agend", ...own.slice(3)]), 300), "an `npm install` ancestor is an install").toBe(false);
  });
  it("an npm whose command cannot be told — none, or a word npm has no command for — is not idle", () => {
    for (const row of ["npm", "npm --prefix", "/usr/bin/npm frobnicate x", "node /x/npm-cli.js --cache"]) {
      expect(npmIdleFromProcessList(ps([...own, `400     1 ${row}`]), 300), row).toBe(false);
    }
  });
  it("a process list that cannot be read — empty, an unparseable row, our own pid missing — is not idle", () => {
    expect(npmIdleFromProcessList("", 300)).toBe(false);
    expect(npmIdleFromProcessList(ps([...own, "garbage"]), 300)).toBe(false);
    expect(npmIdleFromProcessList(ps(own), 999)).toBe(false);
  });
});

type Installer = {
  main(argv: string[], deps: Record<string, unknown>): number;
  admit(prefix: string, deps: Record<string, unknown>, opts?: { spec?: string; home?: string }): { release?: () => void; refuse?: string; notes?: string[] };
};
const installer = createRequire(import.meta.url)("../launcher/agend-install.cjs") as Installer;
const OWN_VERSION = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }).version;
/** A lock in the format updaters from before #2264 write and read (src/install-lock.ts). */
const FAKE_START = "Mon Oct 20 10:00:00 2026";
function oldLock(pid: number, processStart = FAKE_START): string {
  return JSON.stringify({ pid, processStart, prefix: "/p", targetSpec: "@songsid/agend@2.2.0", agendHome: "/h", token: "c".repeat(32), createdAt: "2026-10-20T10:00:00.000Z" }) + "\n";
}

/**
 * The installer's own logic with the outside world stubbed (Prism r1 interleavings): a real scratch prefix and AGEND_HOME
 * on disk, npm and the new `agend` as recorded stubs. `onInstall` runs inside each `npm install -g`; `live` are the pids
 * that count as running.
 */
function unitRig(opts: { onInstall?: (n: number) => void; installStatus?: number[]; live?: number[]; onStep?: (step: string) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-2264-unit-")); roots.push(root);
  const prefix = join(root, "prefix"), nodeModules = join(prefix, "lib", "node_modules"), home = join(root, "agend-home"), userHome = join(root, "user-home");
  for (const d of [nodeModules, home, userHome, join(prefix, "bin")]) mkdirSync(d, { recursive: true });
  const calls: string[] = [], log: string[] = [];
  const live = new Set([...(opts.live ?? []), 4242]);
  let installs = 0;
  const deps = {
    pid: 4242, uid: 1000, now: () => Date.now(), log: (line: string) => log.push(line), alive: (pid: number) => live.has(pid),
    env: { HOME: userHome, AGEND_HOME: home }, systemUnit: join(root, "etc-agend.service"), onStep: opts.onStep as ((step: string) => void) | undefined,
    // Old-format lock holders: a live pid "started" at FAKE_START (no start ticks), as install-admission.cjs judges them.
    lockReaders: { ...lockReaders, processStart: (pid: number) => (live.has(pid) ? FAKE_START : null), startTicks: () => null, bootId: () => null } as unknown,
    run: (cmd: string, args: string[]) => {
      const line = `${cmd} ${args.join(" ")}`;
      if (line === "npm root -g") return { status: 0, stdout: nodeModules + "\n", stderr: "" };
      if (line === "npm prefix -g") return { status: 0, stdout: prefix + "\n", stderr: "" };
      if (line === "ps -A -o pid=,ppid=,args=") return { status: 0, stdout: "4242 1 node agend-install.cjs\n", stderr: "" };
      if (cmd === "npm" && args[0] === "install") {
        installs += 1; opts.onInstall?.(installs);
        calls.push(line);
        return { status: opts.installStatus?.[installs - 1] ?? 0, stdout: "", stderr: "" };
      }
      if (args[0] === "--version") return { status: 0, stdout: OWN_VERSION + "\n", stderr: "" };
      calls.push(`agend ${args.join(" ")}`);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  const lock = join(prefix, ".agend-install.lock");
  const read = (f: string) => existsSync(f) ? readFileSync(f, "utf8") : null;
  const quarantined = () => { const q = join(prefix, ".agend-quarantine"); return existsSync(q) ? readdirSync(q).flatMap(d => readdirSync(join(q, d)).map(n => readFileSync(join(q, d, n), "utf8").slice(0, 200))) : []; };
  return { root, prefix, nodeModules, home, userHome, deps, calls, log, lock, read, quarantined, live };
}

/** The rig's deps with this host's real process readers (pids, start times, open files). */
const realDepsFor = (r: ReturnType<typeof unitRig>) => ({ ...r.deps, lockReaders: undefined, alive: (p: number) => { try { process.kill(p, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } } });

describe("#2264 review (Prism r1 P1): the installer owns the prefix before it touches anything, until it is done", () => {
  // Prism r2: admission is announce-then-check — nothing of another installer is moved to decide it.
  it("two installers racing: whoever lists second sees the first and refuses — never both admitted (both orders)", () => {
    // A announces; B then announces AND checks (inside A's window): B sees A and refuses; A then sees no live B.
    const r = unitRig();
    let b: { refuse?: string; release?: () => void } = {};
    r.deps.onStep = (step: string) => { if (step === "announced") b = installer.admit(r.prefix, { ...r.deps, pid: 7777, onStep: undefined, alive: (pid: number) => pid === 4242 }); };
    const a = installer.admit(r.prefix, r.deps);
    expect(b.refuse, "B listed second").toMatch(/pid 4242/);
    expect(a.refuse, "A is admitted").toBeUndefined();
    a.release?.();
    // Both announced before either checks: A lists first, sees B, and refuses (withdrawing); B, listing after, is admitted.
    const r2 = unitRig({ live: [7777] });
    r2.deps.onStep = (step: string) => {
      if (step === "announced") writeFileSync(join(r2.prefix, ".agend-install.d", "7777-b"), JSON.stringify({ pid: 7777, by: "agend-install" }));
    };
    expect(installer.admit(r2.prefix, r2.deps).refuse).toMatch(/pid 7777/);
    expect(readdirSync(join(r2.prefix, ".agend-install.d")), "A withdrew its own entry, and only its own").toEqual(["7777-b"]);
    const later = installer.admit(r2.prefix, { ...r2.deps, pid: 7777, onStep: undefined, alive: () => false });
    expect(later.refuse).toBeUndefined();
    later.release?.();
  });

  it("real processes racing for one prefix (12 at once, each running again when refused): never two admitted at the same time, every one gets its turn, and the prefix is free afterwards", { timeout: 60_000 }, () => {
    const r = unitRig();
    const driver = join(r.root, "race.cjs");
    writeFileSync(driver, `const fs = require("fs");
const inst = require(${JSON.stringify(join(REPO, "launcher", "agend-install.cjs"))});
const deps = { pid: process.pid, now: Date.now, alive: pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } } };
const t0 = Date.now(); while (Date.now() < Number(process.argv[3])) {}   // start together
// Refused (another holds it, or all refused at once): run again a moment later — as a user re-runs the one-liner.
for (let attempt = 0; attempt < 400; attempt++) {
  const got = inst.admit(process.argv[2], deps);
  if (got.release) {
    const from = process.hrtime.bigint();
    const until = Date.now() + 100; while (Date.now() < until) {}
    const to = process.hrtime.bigint();
    got.release();
    fs.appendFileSync(process.argv[4], from + " " + to + "\\n");
    break;
  }
  const wait = Date.now() + 5 + Math.floor(Math.random() * 40); while (Date.now() < wait) {}
}
`);
    const log = join(r.root, "admitted.log"); writeFileSync(log, "");
    const start = Date.now() + 600;
    const children = Array.from({ length: 12 }, () => spawn(process.execPath, [driver, r.prefix, String(start), log], { stdio: "ignore" }));
    return Promise.all(children.map(c => new Promise(resolve => c.on("exit", resolve)))).then(() => {
      const spans = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => l.split(" ").map(BigInt)).sort((x, y) => (x[0] < y[0] ? -1 : 1));
      expect(spans.length, "every one was admitted in turn").toBe(12);
      for (let k = 1; k < spans.length; k++) expect(spans[k]![0] > spans[k - 1]![1], "no two admissions overlap").toBe(true);
      expect(readdirSync(join(r.prefix, ".agend-install.d")), "every entry withdrawn").toEqual([]);
      expect(existsSync(r.lock), "and the lock released").toBe(false);
    });
  });

  it("an entry whose writer is gone is moved to quarantine; a live one refuses; a live pre-#2264 lock refuses", () => {
    const r = unitRig({ live: [5555] });
    mkdirSync(join(r.prefix, ".agend-install.d"), { recursive: true });
    writeFileSync(join(r.prefix, ".agend-install.d", "999999-dead"), JSON.stringify({ pid: 999999, by: "agend-install" }));
    expect(installer.main(["--spec", `@songsid/agend@${OWN_VERSION}`], r.deps)).toBe(0);
    expect(r.log.join("\n")).toMatch(/install entry left by an installer that is no longer running/);
    const live = unitRig({ live: [5555] });
    writeFileSync(live.lock, oldLock(5555));
    expect(installer.main(["--spec", `@songsid/agend@${OWN_VERSION}`], live.deps)).toBe(75);
    expect(live.read(live.lock)).toBe(oldLock(5555));
    expect(readdirSync(join(live.prefix, ".agend-install.d")), "withdrawn").toEqual([]);
  });

  it("a pre-#2264 lock judged stale, then claimed by a running old updater before it is moved: its lock is put back, untouched, and this one refuses", () => {
    const r = unitRig({ live: [5555] });
    writeFileSync(r.lock, oldLock(999999));
    const theirs = oldLock(5555);
    r.deps.onStep = (step: string) => { if (step === "legacy-judged") writeFileSync(r.lock, theirs); };
    expect(installer.main(["--spec", `@songsid/agend@${OWN_VERSION}`], r.deps)).toBe(75);
    expect(r.read(r.lock), "the old updater's lock, byte for byte").toBe(theirs);
    expect(r.quarantined()).not.toContain(theirs);
  });

  it("while it repairs, installs, retries and rolls back, the prefix stays this installer's: its own lock is never moved, and no other installer is admitted", () => {
    const seen: string[] = [];
    const r = unitRig({
      installStatus: [1, 1, 0],
      onInstall: () => {
        seen.push(JSON.parse(readFileSync(join(r.prefix, ".agend-install.lock"), "utf8")).pid);
        const peer = installer.admit(r.prefix, { ...r.deps, pid: 7777, alive: (pid: number) => pid === 4242 });
        seen.push(peer.refuse ? "peer refused" : "PEER ADMITTED");
        peer.release?.();
        // npm left its retire sibling behind: the retry's repair moves it (the case that used to drop the lock).
        mkdirSync(join(r.nodeModules, "@songsid", ".agend-AbCdEfGh"), { recursive: true });
      },
    });
    const pkg = join(r.nodeModules, "@songsid", "agend");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@songsid/agend", version: "0.0.1", bin: { agend: "bin/agend" } }));
    writeFileSync(join(pkg, "bin", "agend"), "");
    // `agend --version` never answers: npm's failures leave no working `agend`, so the rollback runs too.
    const run = r.deps.run;
    r.deps.run = ((cmd: string, args: string[]) => args[0] === "--version" ? { status: 1, stdout: "", stderr: "" } : run(cmd, args)) as typeof r.deps.run;
    expect(installer.main(["--spec", `@songsid/agend@${OWN_VERSION}`], r.deps)).toBe(1);
    expect(seen).toEqual([4242, "peer refused", 4242, "peer refused", 4242, "peer refused"]);
    expect(r.calls.filter(c => c.startsWith("npm install -g"))).toEqual([`npm install -g @songsid/agend@${OWN_VERSION}`, `npm install -g @songsid/agend@${OWN_VERSION}`, "npm install -g @songsid/agend@0.0.1"]);
    expect(r.read(r.lock), "released at the end").toBeNull();
  });

  it("a peer asking while the repair runs is refused (the repair happens under this installer's lock)", () => {
    let peer = "";
    const r = unitRig();
    mkdirSync(join(r.nodeModules, "@songsid", ".agend-AbCdEfGh"), { recursive: true });
    (r.deps as Record<string, unknown>).npmIdle = () => {
      const p = installer.admit(r.prefix, { ...r.deps, pid: 7777, alive: (pid: number) => pid === 4242 });
      peer = p.refuse ? "refused" : "ADMITTED"; p.release?.();
      return true;
    };
    expect(installer.main(["--spec", `@songsid/agend@${OWN_VERSION}`], r.deps)).toBe(0);
    expect(peer).toBe("refused");
  });
});

describe("#2264 review (Prism r1 P1): the service stays under the manager it has — refreshed without activating, then restarted or started", () => {
  const spec = () => ["--upgrade", "--spec", `@songsid/agend@${OWN_VERSION}`];
  const cases: Array<[string, (r: ReturnType<typeof unitRig>) => void]> = [
    ["a legacy system unit (/etc/systemd/system/agend.service)", r => writeFileSync(r.deps.systemUnit, "[Service]\n")],
    ["the user unit", r => { mkdirSync(join(r.userHome, ".config", "systemd", "user"), { recursive: true }); writeFileSync(join(r.userHome, ".config", "systemd", "user", "com.agend.fleet.service"), "[Service]\n"); }],
    ["the launchd job", r => { mkdirSync(join(r.userHome, "Library", "LaunchAgents"), { recursive: true }); writeFileSync(join(r.userHome, "Library", "LaunchAgents", "com.agend.fleet.plist"), "<plist/>"); }],
  ];
  it.each(cases)("%s, fleet running: `install --no-activate`, then `restart --yes` — never a plain `install` that writes and starts a user unit", (_name, setup) => {
    const r = unitRig({ live: [9191] });
    setup(r);
    writeFileSync(join(r.home, "fleet.pid"), "9191");
    expect(installer.main(spec(), r.deps)).toBe(0);
    expect(r.calls.filter(c => c.startsWith("agend"))).toEqual(["agend install --no-activate", "agend restart --yes"]);
  });
  it.each(cases)("%s, fleet stopped: `install --no-activate`, then `start`", (_name, setup) => {
    const r = unitRig();
    setup(r);
    expect(installer.main(spec(), r.deps)).toBe(0);
    expect(r.calls.filter(c => c.startsWith("agend"))).toEqual(["agend install --no-activate", "agend start"]);
  });
  it("a hand-started fleet: an upgrade restarts it and makes no unit (#1631); the one-liner leaves it alone; no fleet at all: nothing", () => {
    const up = unitRig({ live: [9191] });
    writeFileSync(join(up.home, "fleet.pid"), "9191");
    expect(installer.main(spec(), up.deps)).toBe(0);
    expect(up.calls.filter(c => c.startsWith("agend"))).toEqual(["agend restart --yes"]);
    const oneLiner = unitRig({ live: [9191] });
    writeFileSync(join(oneLiner.home, "fleet.pid"), "9191");
    expect(installer.main(["--spec", `@songsid/agend@${OWN_VERSION}`], oneLiner.deps)).toBe(0);
    expect(oneLiner.calls.filter(c => c.startsWith("agend"))).toEqual([]);
    const none = unitRig();
    expect(installer.main(spec(), none.deps)).toBe(0);
    expect(none.calls.filter(c => c.startsWith("agend"))).toEqual([]);
  });
});

describe("#2264 review (Prism r1 P2): the update marker is written only by the installer that owns it", () => {
  const marker = (pid: number, stage = "downloading") => JSON.stringify({ startedAt: 1_000, pid, progress: { operation: "update", stage, target: { adapterId: "t", chatId: "1", messageId: "2" } } });
  it("refused by a live installer's lock: another update's marker is left byte for byte", () => {
    const r = unitRig({ live: [5555] });
    writeFileSync(r.lock, oldLock(5555));
    writeFileSync(join(r.home, "update-in-progress.json"), marker(5555));
    expect(installer.main(["--spec", `@songsid/agend@${OWN_VERSION}`], r.deps)).toBe(75);
    expect(readFileSync(join(r.home, "update-in-progress.json"), "utf8")).toBe(marker(5555));
  });
  it("refused: a marker whose writer is gone (an abandoned update) is left too — the installer that holds the prefix takes it", () => {
    const r = unitRig({ live: [5555] });
    writeFileSync(r.lock, oldLock(5555));
    writeFileSync(join(r.home, "update-in-progress.json"), marker(999999));
    expect(installer.main(["--spec", `@songsid/agend@${OWN_VERSION}`], r.deps)).toBe(75);
    expect(readFileSync(join(r.home, "update-in-progress.json"), "utf8")).toBe(marker(999999));
  });
  it("refused, but started by `agend update` (its marker): the chat is told it failed", () => {
    const r = unitRig({ live: [5555, 3131] });
    writeFileSync(r.lock, oldLock(5555));
    writeFileSync(join(r.home, "update-in-progress.json"), marker(3131));
    r.deps.env = { ...r.deps.env, AGEND_UPDATE_OWNER_PID: "3131" } as typeof r.deps.env;
    expect(installer.main(["--spec", `@songsid/agend@${OWN_VERSION}`], r.deps)).toBe(75);
    expect(JSON.parse(readFileSync(join(r.home, "update-in-progress.json"), "utf8")).progress).toMatchObject({ stage: "failed", error: expect.stringContaining("pid 5555") });
  });
  it("a marker a live process (not this update) writes is never claimed; one whose writer is gone is (the user's stuck \"downloading\")", () => {
    const live = unitRig({ live: [5555] });
    writeFileSync(join(live.home, "update-in-progress.json"), marker(5555));
    expect(installer.main(["--spec", `@songsid/agend@${OWN_VERSION}`], live.deps)).toBe(0);
    expect(readFileSync(join(live.home, "update-in-progress.json"), "utf8")).toBe(marker(5555));
    const dead = unitRig();
    writeFileSync(join(dead.home, "update-in-progress.json"), marker(999999));
    expect(installer.main(["--spec", `@songsid/agend@${OWN_VERSION}`], dead.deps)).toBe(0);
    expect(JSON.parse(readFileSync(join(dead.home, "update-in-progress.json"), "utf8")).progress.stage).toBe("installed");
  });
  it("replaced while the install runs (a new update, a new fleet): the new marker is left as it is", () => {
    const fresh = JSON.stringify({ startedAt: 2_000, pid: 8888, progress: { operation: "update", stage: "downloading", target: { adapterId: "t", chatId: "9", messageId: "9" } } });
    const r = unitRig({ live: [8888], onInstall: () => writeFileSync(join(r.home, "update-in-progress.json"), fresh) });
    writeFileSync(join(r.home, "update-in-progress.json"), marker(999999));
    expect(installer.main(["--spec", `@songsid/agend@${OWN_VERSION}`], r.deps)).toBe(0);
    expect(readFileSync(join(r.home, "update-in-progress.json"), "utf8")).toBe(fresh);
  });
});

describe("#2264 review (Prism r1 P2): only the chosen release's own installer installs", () => {
  it("`--target` names another version: this installer refuses and changes nothing", () => {
    const r = unitRig();
    expect(installer.main(["--upgrade", "--target", "0.0.1"], r.deps)).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.log.join("\n")).toMatch(new RegExp(`installer of AgEnD v${OWN_VERSION.replace(/\./g, "\\.")}, not of v0\\.0\\.1`));
  });
});

describe("#2264 review (Prism r3 P1): mixed with updaters from before #2264 — their lock kept by their own rules", () => {
  // Real old-updater admission (src/install-lock.ts) for B and C, real process identities; A is the new installer.
  const oldUpdater = (pid: number) => ({
    pid, processStart: lockReaders.processStart, startTicks: lockReaders.startTicks, bootId: lockReaders.bootId,
    newToken: () => randomBytes(16).toString("hex"), now: () => new Date(), log: () => {},
  });
  const sleepers: ChildProcess[] = [];
  afterAll(() => { for (const c of sleepers) c.kill("SIGKILL"); });
  const livePid = () => { const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" }); sleepers.push(c); return c.pid!; };
  const realDeps = (r: ReturnType<typeof unitRig>, pid: number) => ({ ...r.deps, pid, lockReaders: undefined, alive: (p: number) => { try { process.kill(p, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } } });
  const staleOld = (r: ReturnType<typeof unitRig>) => writeFileSync(r.lock, oldLock(999999));   // a dead holder's record

  it("Prism's interleaving: an old updater (B) takes the stale lock over after the new installer (A) judged it; A never moves B's lock, and a third (C, old) is refused — never two admitted", () => {
    const r = unitRig();
    staleOld(r);
    const realPrefix = realpathSync(r.prefix);
    let b: InstallLock | null = null;
    const a = realDeps(r, livePid());
    a.onStep = (step: string) => { if (step === "legacy-judged" && !b) b = acquireInstallLock(r.prefix, { spec: "@songsid/agend@2.2.0", agendHome: "/h" }, oldUpdater(process.pid)); };
    const aAdmitted = installer.admit(r.prefix, a, { spec: "x", home: "/h" });
    expect(b!.ok, "B took the stale lock over by its own protocol").toBe(true);
    expect(aAdmitted.refuse, "A sees B running and stays out").toMatch(new RegExp(`pid ${process.pid}`));
    const bBytes = readFileSync(join(realPrefix, ".agend-install.lock"), "utf8");
    expect(JSON.parse(bBytes).pid, "B's lock is in place").toBe(process.pid);
    const c = acquireInstallLock(r.prefix, { spec: "@songsid/agend@2.2.0", agendHome: "/h" }, oldUpdater(livePid()));
    expect(c.ok, "C is refused: B holds it").toBe(false);
    expect(readFileSync(join(realPrefix, ".agend-install.lock"), "utf8"), "B's lock, byte for byte").toBe(bBytes);
    expect(r.quarantined().join("\n")).not.toContain(`"pid":${process.pid}`);
    (b as unknown as { release(): void }).release();
  });

  it("while the new installer holds the old updaters' reclaim marker, an old updater cannot take the stale lock over (it waits), and after it, it sees the new installer as the live holder", () => {
    const r = unitRig();
    staleOld(r);
    let b: InstallLock | null = null;
    const a = realDeps(r, livePid());
    a.onStep = (step: string) => { if (step === "legacy-reclaimed") b = acquireInstallLock(r.prefix, { spec: "@songsid/agend@2.2.0", agendHome: "/h" }, oldUpdater(process.pid)); };
    const got = installer.admit(r.prefix, a, { spec: "x", home: "/h" });
    expect(b!.ok).toBe(false);
    expect((b as unknown as { reason: string }).reason).toMatch(/replacing the stale lock/);
    expect(got.refuse, "A moved the stale lock under the marker and holds the prefix").toBeUndefined();
    const c = acquireInstallLock(r.prefix, { spec: "@songsid/agend@2.2.0", agendHome: "/h" }, oldUpdater(livePid()));
    expect(c.ok).toBe(false);
    expect((c as unknown as { reason: string }).reason, "the old updater reads the new installer's lock as a live holder").toMatch(new RegExp(`another AgEnD install is running .*pid ${a.pid}`));
    got.release!();
    expect(existsSync(r.lock), "released").toBe(false);
  });

  it("a reclaim marker of a live old updater refuses; one left by a dead one refuses with its path (their rule: never taken automatically)", () => {
    const r = unitRig();
    staleOld(r);
    writeFileSync(r.lock + ".reclaim", oldLock(process.pid, lockReaders.processStart(process.pid)!));
    const live = installer.admit(r.prefix, realDeps(r, livePid()), { spec: "x", home: "/h" });
    expect(live.refuse).toMatch(/another install is replacing the stale lock/);
    writeFileSync(r.lock + ".reclaim", oldLock(999999));
    const dead = installer.admit(r.prefix, realDeps(r, livePid()), { spec: "x", home: "/h" });
    expect(dead.refuse).toMatch(/a reclaim marker .*\.reclaim was left behind \(pid 999999\)/);
    expect(readFileSync(r.lock, "utf8"), "the stale lock untouched").toBe(oldLock(999999));
  });

  it("an old lock whose pid now belongs to another process (another start time) is stale, as old updaters judge it", () => {
    const r = unitRig({ live: [5555] });
    writeFileSync(r.lock, oldLock(5555, "Sun Jan  4 00:00:00 2026"));
    const got = installer.admit(r.prefix, r.deps, {});
    expect(got.refuse).toBeUndefined();
    expect(r.quarantined().join("\n")).toContain("Sun Jan  4 00:00:00 2026");
    got.release!();
  });

  // Prism r4: their create-then-write keeps the file open from open(wx) to the write; an empty lock's age proves nothing.
  it.skipIf(process.platform !== "linux")("a lock an old writer has created and still holds open (not written yet), however old: refused, its inode untouched — and once that writer is gone, moved (the user's, cut short)", async () => {
    const r = unitRig();
    // The old updater's claim(), paused between open(wx) and its write: a real process holding the descriptor.
    const writer = spawn(process.execPath, ["-e", `const fs = require("fs"); const fd = fs.openSync(${JSON.stringify(r.lock)}, "wx", 0o600); process.stdout.write("opened\\n"); process.stdin.once("data", () => { fs.writeSync(fd, "late"); fs.closeSync(fd); process.exit(0); });`], { stdio: ["pipe", "pipe", "ignore"] });
    await new Promise<void>(resolve => writer.stdout!.once("data", () => resolve()));
    const longAgo = new Date(Date.now() - 60 * 60_000); utimesSync(r.lock, longAgo, longAgo);   // an hour old: age is no evidence
    const inode = statSync(r.lock).ino;
    const real = realDepsFor(r);
    expect(installer.admit(r.prefix, real, {}).refuse).toMatch(/is being written by another AgEnD install/);
    expect(statSync(r.lock).ino, "the writer's file stays where its claim will find it").toBe(inode);
    writer.stdin!.write("go\n");
    await new Promise(resolve => writer.on("exit", resolve));
    expect(readFileSync(r.lock, "utf8"), "its write landed in the lock it claimed").toBe("late");
    // The user's state: created, never written, its writer gone.
    const cut = unitRig();
    writeFileSync(cut.lock, '{"pid":');
    const got = installer.admit(cut.prefix, realDepsFor(cut), {});
    expect(got.refuse).toBeUndefined();
    expect(cut.quarantined()).toContain('{"pid":');
    got.release!();
  });

  // Prism r5: /proc/<pid>/fd is behind ptrace checks — only "gone" (ENOENT) may be skipped; anything else is unknown.
  it.skipIf(process.platform !== "linux")("the writer's /proc entry or one of its descriptors cannot be read (EACCES, EIO): refused, at judgment and under .reclaim — never taken for gone", async () => {
    const r = unitRig();
    const writer = spawn(process.execPath, ["-e", `require("fs").openSync(${JSON.stringify(r.lock)}, "wx", 0o600); process.stdout.write("opened\\n"); setTimeout(() => {}, 60000);`], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>(resolve => writer.stdout!.once("data", () => resolve()));
    try {
      const failing = (match: (p: string) => boolean, code: string) => (p: string) => {
        if (match(p)) throw Object.assign(new Error(`${code}: injected`), { code });
        return statSync(p);
      };
      const pid = writer.pid!;
      for (const [what, procStat] of [
        ["its descriptors, EACCES", failing(p => p.startsWith(`/proc/${pid}/fd/`), "EACCES")],
        ["its /proc entry, EACCES", failing(p => p === `/proc/${pid}`, "EACCES")],
        ["its descriptors, EIO", failing(p => p.startsWith(`/proc/${pid}/fd/`), "EIO")],
        ["the lock itself, EACCES", failing(p => p === r.lock, "EACCES")],
      ] as const) {
        expect(installer.admit(r.prefix, { ...realDepsFor(r), procStat }, {}).refuse, what).toMatch(/is being written by another AgEnD install/);
        expect(existsSync(r.lock), `${what}: the lock stays`).toBe(true);
      }
      // Its descriptor list cannot be read: EIO → unknown; EACCES (non-dumpable) on a process whose command line names
      // node → unknown too (an old updater is a node process).
      for (const code of ["EIO", "EACCES"]) {
        const procReaddir = (p: string) => { if (p === `/proc/${pid}/fd`) throw Object.assign(new Error(code), { code }); return readdirSync(p); };
        expect(installer.admit(r.prefix, { ...realDepsFor(r), procReaddir }, {}).refuse, `descriptor list ${code}`).toMatch(/is being written by another AgEnD install/);
      }
    } finally { writer.kill("SIGKILL"); }
  });

  // CI (GitHub runner): a process whose descriptor 0 cannot be stat'ed (EACCES) — the link still names it.
  it.skipIf(process.platform !== "linux")("a descriptor that cannot be stat'ed is skipped only when its link names no file (pipe, socket, /dev/null…); a file, or an unreadable link, is unknown", async () => {
    const r = unitRig();
    writeFileSync(r.lock, '{"pid":');   // cut short, its writer gone
    const other = spawn("sleep", ["60"], { stdio: "ignore" });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      const prefixFd = `/proc/${other.pid}/fd/`;
      const procStat = (p: string) => { if (p.startsWith(prefixFd)) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return statSync(p); };
      for (const target of ["pipe:[4242]", "socket:[17]", "anon_inode:[eventfd]", "/dev/null", "/dev/pts/3"]) {
        const got = installer.admit(r.prefix, { ...realDepsFor(r), procStat, procReadlink: () => target }, {});
        expect(got.refuse, target).toBeUndefined();
        got.release!();
        writeFileSync(r.lock, '{"pid":');
      }
      for (const procReadlink of [() => r.lock, () => "/home/u/somefile", () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); }]) {
        expect(installer.admit(r.prefix, { ...realDepsFor(r), procStat, procReadlink }, {}).refuse).toMatch(/cannot be told \(EACCES on \/proc\/\d+\/fd\/\d+/);
        expect(readFileSync(r.lock, "utf8")).toBe('{"pid":');
      }
    } finally { other.kill("SIGKILL"); }
  });

  // CI (GitHub runner): a process whose descriptors' targets AND links are both refused (EACCES) — the kernel's ptrace
  // check on a process with other credentials. Not an old updater unless its command line names node or agend.
  it.skipIf(process.platform !== "linux")("a process none of whose descriptors may be inspected (stat and link both EACCES): skipped unless its command line names node/agend — then unknown, naming it", async () => {
    const r = unitRig();
    writeFileSync(r.lock, '{"pid":');   // cut short, its writer gone
    const deny = (pid: number) => ({
      procStat: (p: string) => { if (p.startsWith(`/proc/${pid}/fd/`)) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return statSync(p); },
      procReadlink: (p: string) => { if (p.startsWith(`/proc/${pid}/fd/`)) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return readlinkSync(p); },
    });
    const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
    const nodeOne = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      await new Promise(resolve => setTimeout(resolve, 150));
      const asSleep = installer.admit(r.prefix, { ...realDepsFor(r), ...deny(sleeper.pid!) }, {});
      expect(asSleep.refuse, "`sleep` is no old updater").toBeUndefined();
      asSleep.release!();
      writeFileSync(r.lock, '{"pid":');
      expect(installer.admit(r.prefix, { ...realDepsFor(r), ...deny(nodeOne.pid!) }, {}).refuse).toMatch(new RegExp(`cannot be told \\(EACCES on /proc/${nodeOne.pid}/fd/\\d+ \\(".*node`));
      expect(readFileSync(r.lock, "utf8")).toBe('{"pid":');
    } finally { sleeper.kill("SIGKILL"); nodeOne.kill("SIGKILL"); }
  });

  it.skipIf(process.platform !== "linux")("any process whose descriptor list fails other than by permission (EIO) is unknown, whatever its command line (not only node)", async () => {
    const r = unitRig();
    writeFileSync(r.lock, '{"pid":');   // cut short, its writer gone
    const other = spawn("sleep", ["60"], { stdio: "ignore" });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      const procReaddir = (p: string) => { if (p === `/proc/${other.pid}/fd`) throw Object.assign(new Error("EIO"), { code: "EIO" }); return readdirSync(p); };
      expect(installer.admit(r.prefix, { ...realDepsFor(r), procReaddir }, {}).refuse).toMatch(/is being written by another AgEnD install/);
      expect(readFileSync(r.lock, "utf8")).toBe('{"pid":');
    } finally { other.kill("SIGKILL"); }
  });

  it.skipIf(process.platform !== "linux")("the check under .reclaim alone cannot read a live process's descriptors: refused there too, the lock untouched; with every read answered, the same lock is moved", () => {
    const r = unitRig();
    writeFileSync(r.lock, '{"pid":');   // cut short, its writer gone: judged stale
    let underMarker = false;
    const second = { ...realDepsFor(r), onStep: (step: string) => { if (step === "legacy-reclaimed") underMarker = true; },
      // This test's own process (a node process of the lock owner's uid): its descriptor list cannot be read, under the
      // marker only.
      procReaddir: (p: string) => { if (underMarker && p === `/proc/${process.pid}/fd`) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return readdirSync(p); } };
    expect(installer.admit(r.prefix, second, {}).refuse).toMatch(/is being written by another AgEnD install/);
    expect(underMarker, "it got as far as the marker").toBe(true);
    expect(readFileSync(r.lock, "utf8")).toBe('{"pid":');
    const got = installer.admit(r.prefix, realDepsFor(r), {});
    expect(got.refuse, "control: every read answered → moved").toBeUndefined();
    got.release!();
  });

  it("whether a cut-short lock is open cannot be told: refused (unknown blocks)", () => {
    const r = unitRig();
    writeFileSync(r.lock, '{"pid":');
    expect(installer.admit(r.prefix, { ...r.deps, openedBy: () => null }, {}).refuse).toMatch(/is being written by another AgEnD install/);
    expect(readFileSync(r.lock, "utf8")).toBe('{"pid":');
  });
});
