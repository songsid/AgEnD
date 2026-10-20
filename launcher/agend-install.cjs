#!/usr/bin/env node
"use strict";
// #2264: AgEnD's one installer. Install, upgrade and repair are this file, always run from the TARGET release itself:
//
//   npm exec --yes --package @songsid/agend@<version> -- agend-install [--upgrade]
//
// install.sh (and so the Windows installer) and `agend update` both end here, so the newest install logic runs on every
// install — never an old updater that happens to be on the host. It installs exactly the version it ships in, and:
//   1. repairs what an interrupted install left in the npm prefix — npm's retire sibling `@songsid/.agend-XXXX` (the old
//      package is put back when it is the only copy, otherwise removed), and an install lock nobody holds;
//   2. `npm install -g @songsid/agend@<this version>` (one retry after repairing again, for a sibling npm itself left);
//   3. proves `<prefix>/bin/agend --version` is this version, else puts the previous version back the same way;
//   4. on a host with a fleet: `agend install` (the service, enabling linger) and, for --upgrade, `agend restart`;
//   5. records each step in the update marker the fleet edits its chat message from, ending in a final state.
// Nothing here refuses a manual `npm install -g`: the lock only keeps two of THESE installers from running at once.
// Old syntax only (var, no ?. ??): this runs on whatever Node runs npm.
var fs = require("fs");
var path = require("path");
var os = require("os");
var childProcess = require("child_process");

var LOCK = ".agend-install.lock";
var MARKER = "update-in-progress.json";

function defaultDeps() {
  return {
    run: function (cmd, args, opts) {
      var o = opts || {};
      var r = childProcess.spawnSync(cmd, args, { encoding: "utf8", stdio: o.inherit ? "inherit" : ["ignore", "pipe", "pipe"], env: o.env || process.env, timeout: o.timeoutMs });
      return { status: r.status, signal: r.signal, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error ? String(r.error.code || r.error.message) : null };
    },
    log: function (line) { process.stdout.write(line + "\n"); },
    pid: process.pid,
    alive: function (pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } },
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    env: process.env,
    now: function () { return Date.now(); },
  };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; } }
function last(text) { var lines = String(text || "").trim().split("\n"); return (lines[lines.length - 1] || "").trim(); }
function isAgendPackage(dir) { var p = readJson(path.join(dir, "package.json")); return p && p.name === "@songsid/agend" && typeof p.version === "string" ? p.version : null; }

/** The update marker the fleet edits its chat message from (src/update-marker.ts): a stage, kept with its target. */
function setStage(home, stage, details, deps) {
  var file = path.join(home, MARKER);
  var marker = readJson(file);
  if (!marker || !marker.progress) return false;
  var previous = marker.progress.stage;
  marker.pid = deps.pid;
  marker.progress.stage = stage;
  if (details.version) marker.progress.version = details.version;
  if (details.error) marker.progress.error = String(details.error).replace(/\s+/g, " ").trim().slice(0, 300);
  if (stage === "failed") marker.progress.failedStage = previous;
  var tmp = file + "." + deps.pid + ".tmp";
  try { fs.writeFileSync(tmp, JSON.stringify(marker), { mode: 384 }); fs.renameSync(tmp, file); return true; } catch (e) { return false; }
}

/**
 * What an interrupted install leaves, put right. npm moves the installed package to `@songsid/.agend-<random>` before it
 * writes the new one, and moves it back on failure; killed in between, it leaves the sibling (and every later
 * `npm install -g` fails ENOTEMPTY on it) and `bin/agend` dangling. The only copy of AgEnD there is put back; any other
 * sibling is removed. A lock whose writer is gone, or that cannot be read, is removed.
 */
function repair(root, prefix, deps) {
  var notes = [];
  var scope = path.join(root, "@songsid");
  var current = path.join(scope, "agend");
  var siblings = [];
  try { siblings = fs.readdirSync(scope).filter(function (n) { return /^\.agend-/.test(n); }); } catch (e) { siblings = []; }
  siblings.forEach(function (name) {
    var dir = path.join(scope, name);
    var version = isAgendPackage(dir);
    if (version && !isAgendPackage(current)) {
      try { fs.rmSync(current, { recursive: true, force: true }); } catch (e) { /* none */ }
      fs.renameSync(dir, current);
      notes.push("put back AgEnD v" + version + " that an interrupted install had moved aside (" + name + ")");
      return;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    notes.push("removed " + name + ", left by an interrupted install");
  });
  // npm retires each bin link the same way (`bin/.agend-<hash>`): a link left there is only in the way.
  var binDir = path.join(prefix, "bin");
  var binSiblings = [];
  try { binSiblings = fs.readdirSync(binDir).filter(function (n) { return /^\.agend(-agent|-install)?-[A-Za-z0-9]{8}$/.test(n); }); } catch (e) { binSiblings = []; }
  binSiblings.forEach(function (name) {
    try { fs.unlinkSync(path.join(binDir, name)); notes.push("removed bin/" + name + ", left by an interrupted install"); } catch (e) { /* gone */ }
  });
  var lockFile = path.join(prefix, LOCK);
  var text = null;
  try { text = fs.readFileSync(lockFile, "utf8"); } catch (e) { text = null; }
  if (text !== null) {
    var holder = null;
    try { holder = JSON.parse(text); } catch (e) { holder = null; }
    var live = holder && typeof holder.pid === "number" && holder.pid !== deps.pid && deps.alive(holder.pid);
    if (live) return { ok: false, notes: notes, reason: "another AgEnD install (pid " + holder.pid + ") is running in " + prefix + "; let it finish, then run this again" };
    try { fs.unlinkSync(lockFile); } catch (e) { /* gone */ }
    notes.push(holder ? "removed an install lock left by pid " + holder.pid + " (no longer running)" : "removed an install lock that could not be read");
  }
  return { ok: true, notes: notes };
}

/** Claim the prefix for this installer: the whole record appears at once (written aside, then linked into place). */
function claimLock(prefix, deps) {
  var file = path.join(prefix, LOCK);
  var tmp = file + "." + deps.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ pid: deps.pid, by: "agend-install", createdAt: new Date(deps.now()).toISOString() }) + "\n", { mode: 384 });
  try { fs.linkSync(tmp, file); } catch (e) { fs.unlinkSync(tmp); return null; }
  fs.unlinkSync(tmp);
  return function release() {
    var mine = readJson(file);
    if (mine && mine.pid === deps.pid) { try { fs.unlinkSync(file); } catch (e) { /* gone */ } }
  };
}

/** A service AgEnD installed: the user unit, the system unit, or the launchd job. */
function hasService(deps) {
  var home = deps.env.HOME || os.homedir();
  return [path.join(home, ".config", "systemd", "user", "com.agend.fleet.service"), "/etc/systemd/system/agend.service",
    path.join(home, "Library", "LaunchAgents", "com.agend.fleet.plist")].some(function (f) { return fs.existsSync(f); });
}

function versionOf(agendBin, deps) {
  var r = deps.run(agendBin, ["--version"], { timeoutMs: 60000 });
  return r.status === 0 ? last(r.stdout).replace(/^v/i, "") : null;
}

function main(argv, injected) {
  var deps = injected || defaultDeps();
  var args = argv || [];
  var upgrade = args.indexOf("--upgrade") >= 0;
  var specAt = args.indexOf("--spec");
  // Where the previous version is reinstalled from when the new one does not prove itself (tests and mirrors).
  var previousAt = args.indexOf("--previous-spec");
  var own = readJson(path.join(__dirname, "..", "package.json")) || {};
  var version = own.version;
  // The package this installer ships in, unless a test or a mirror names another source of the same version.
  var spec = specAt >= 0 ? args[specAt + 1] : "@songsid/agend@" + version;
  // An exact `@songsid/agend@<version>` spec names the version to prove; anything else (a tarball, a tag) is this one.
  var exact = /^@songsid\/agend@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec);
  if (exact) version = exact[1];
  var home = deps.env.AGEND_HOME || path.join(os.homedir(), ".agend");
  var log = deps.log;
  var fail = function (stage, message) {
    log("  ✗ " + message);
    setStage(home, "failed", { error: message }, deps);
    return stage === "lock" ? 75 : 1;
  };

  log("  AgEnD installer v" + version + (upgrade ? " (upgrade)" : ""));
  setStage(home, "downloading", { version: version }, deps);
  var root = last(deps.run("npm", ["root", "-g"], { timeoutMs: 30000 }).stdout);
  var prefix = last(deps.run("npm", ["prefix", "-g"], { timeoutMs: 30000 }).stdout);
  if (!root || !prefix) return fail("install", "npm did not say where it installs global packages (npm root -g / npm prefix -g)");

  var fixed = repair(root, prefix, deps);
  fixed.notes.forEach(function (n) { log("  ↺ " + n); });
  if (!fixed.ok) return fail("lock", fixed.reason);
  var release = claimLock(prefix, deps);
  if (!release) return fail("lock", "another AgEnD install started in " + prefix + " just now; let it finish, then run this again");
  try {
    var previous = isAgendPackage(path.join(root, "@songsid", "agend"));
    // Discord is built in since 2.0: the old plugin package only gets in the way.
    if (isAgendPackage(path.join(root, "@songsid", "agend-plugin-discord")) || fs.existsSync(path.join(root, "@songsid", "agend-plugin-discord"))) {
      deps.run("npm", ["uninstall", "-g", "@songsid/agend-plugin-discord"], { inherit: true });
    }
    var install = function () { return deps.run("npm", ["install", "-g", spec], { inherit: true }); };
    var done = install();
    if (done.status !== 0) {
      // npm itself can leave its sibling behind (a failure inside its own move): repair and try once more.
      repair(root, prefix, deps).notes.forEach(function (n) { log("  ↺ " + n); });
      done = install();
    }
    var bin = path.join(prefix, "bin", "agend");
    var got = done.status === 0 ? versionOf(bin, deps) : null;
    if (got !== version) {
      var why = done.status !== 0 ? "npm install -g " + spec + " failed (exit " + (done.status === null ? done.signal : done.status) + ")"
        : "after npm install, " + bin + " reports " + (got || "nothing") + ", not v" + version;
      if (previous && previous !== version) {
        repair(root, prefix, deps);
        var back = deps.run("npm", ["install", "-g", previousAt >= 0 ? args[previousAt + 1] : "@songsid/agend@" + previous], { inherit: true });
        if (back.status === 0 && versionOf(bin, deps) === previous) return fail("install", why + "; v" + previous + " is back in place and works");
      }
      return fail("install", why + (previous ? "; v" + previous + " could not be put back — run the installer again" : ""));
    }
    log("  ✓ AgEnD v" + version + " is installed (" + bin + ")");
    // Root under nvm: the service, cron and non-login shells do not source nvm — give them the same agend and node.
    if (deps.uid === 0 && prefix.indexOf("/.nvm/") >= 0) {
      [["agend", bin], ["node", path.join(prefix, "bin", "node")]].forEach(function (pair) {
        deps.run("ln", ["-sf", pair[1], "/usr/local/bin/" + pair[0]], {});
      });
    }
    setStage(home, "installed", { version: version }, deps);

    // A fresh install (no fleet set up, not an upgrade): the next step is the setup wizard.
    var configured = fs.existsSync(path.join(home, "fleet.yaml")) || fs.existsSync(path.join(home, "fleet.pid"));
    if (!configured && !upgrade && !hasService(deps)) { log("  Next: run `agend quickstart` to set up AgEnD."); return 0; }
    // The service is the new release's own business: where one is installed, its `agend install` rewrites the unit (and
    // turns on linger, so the fleet outlives the login that started it). A hand-started fleet gets no unit (#1631).
    if (hasService(deps)) {
      var service = deps.run(bin, ["install"], { inherit: true });
      if (service.status !== 0) return fail("starting", "`agend install` could not set up the service (exit " + service.status + "); AgEnD v" + version + " is installed — run `agend install` again");
    }
    if (upgrade) {
      var restarted = deps.run(bin, ["restart", "--yes"], { inherit: true, env: Object.assign({}, deps.env, { AGEND_RESTART_ORIGIN: "agend-update" }) });
      if (restarted.status !== 0 && restarted.status !== 75) return fail("stopping", "the fleet did not restart onto v" + version + " (exit " + restarted.status + "); run `agend restart`");
    }
    return 0;
  } finally {
    release();
  }
}

module.exports = { main: main, repair: repair, claimLock: claimLock, setStage: setStage, LOCK: LOCK };
if (require.main === module) process.exit(main(process.argv.slice(2)));
