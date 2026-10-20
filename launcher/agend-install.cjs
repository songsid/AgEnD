#!/usr/bin/env node
"use strict";
// #2264: AgEnD's one installer. Install, upgrade and repair are this file, always run from the TARGET release itself:
//
//   npm exec --yes --package @songsid/agend@<version> -- agend-install [--upgrade]
//
// install.sh (and so the Windows installer) and `agend update` both end here, so the newest install logic runs on every
// install — never an old updater that happens to be on the host. It installs exactly the version it ships in, and:
//   1. repairs what an interrupted install left in the npm prefix (see repair(): the lock first; npm's leftovers only
//      while no other npm runs; the only copy of AgEnD put back, anything else moved to quarantine, never deleted);
//   2. `npm install -g @songsid/agend@<this version>` (once more only if repairing moved something npm itself left);
//   3. proves `<prefix>/bin/agend --version` is this version; otherwise says what runs now — the previous version that
//      npm kept is left as it is, and only an `agend` that does not run is reinstalled;
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
/** A whole AgEnD package in `dir` — its package.json and every bin it names — gives its version; a partial one, null. */
function isAgendPackage(dir) {
  var p = readJson(path.join(dir, "package.json"));
  if (!p || p.name !== "@songsid/agend" || typeof p.version !== "string" || !p.bin || typeof p.bin !== "object") return null;
  var bins = Object.keys(p.bin).map(function (k) { return p.bin[k]; });
  return bins.length && bins.every(function (b) { return typeof b === "string" && fs.existsSync(path.join(dir, b)); }) ? p.version : null;
}

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
 * Is npm provably idle on this host — is no npm process changing installed packages? Only an npm that installs,
 * uninstalls, updates, links or rebuilds can be reifying this prefix; `npm exec` (AgEnD fleets run their MCP servers
 * that way, for hours), `npm view`, `npm run` cannot. This installer's own `npm exec` ancestors are never counted (the
 * ancestor walk is Sentinel's, #2267 c284ce9d). npm rewrites its process title to `npm <command> <args>` without its
 * flags, so `-g` cannot be seen: any changing npm counts. A process list that cannot be read is not idle.
 */
var NPM_CHANGES = /^(?:install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|uninstall|un|unlink|remove|rm|r|update|up|upgrade|udpate|link|ln|ci|clean-install|install-clean|ic|isntall-clean|install-ci-test|cit|install-test|it|dedupe|ddp|find-dupes|prune|rebuild|rb)$/;
function npmCommand(args) {
  var words = args.split(/\s+/);
  var at = -1;
  for (var k = 0; k < words.length && k < 3; k++) {
    if (/(?:^|\/)(?:npm|npx)$/.test(words[k]) || /(?:^|\/)(?:npm|npx)-cli\.js$/.test(words[k])) { at = k; break; }
  }
  if (at < 0) return null;
  if (/npx/.test(words[at])) return "exec";
  for (var w = at + 1; w < words.length; w++) if (words[w] && words[w].charAt(0) !== "-") return words[w];
  return "";
}
function npmIdleFromProcessList(output, ownPid) {
  var rows = String(output).trim().split("\n").map(function (line) {
    var m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return m ? { pid: Number(m[1]), parent: Number(m[2]), args: m[3] } : null;
  });
  if (!rows.length || rows.some(function (row) { return !row; })) return false;
  var ancestors = {};
  var pid = ownPid;
  while (pid > 1 && !ancestors[pid]) {
    ancestors[pid] = true;
    var row = rows.filter(function (r) { return r.pid === pid; })[0];
    if (!row) return false;
    pid = row.parent;
  }
  return !rows.some(function (row) {
    if (ancestors[row.pid]) return false;
    var command = npmCommand(row.args);
    return command !== null && NPM_CHANGES.test(command);
  });
}
function npmIdle(deps) {
  var r = deps.run("ps", ["-A", "-o", "pid=,ppid=,args="], { timeoutMs: 5000 });
  return r.status === 0 && npmIdleFromProcessList(r.stdout, deps.pid);
}

/** Move a leftover into `<prefix>/.agend-quarantine/<time>-<pid>/` — kept as evidence, never deleted here. */
function quarantine(prefix, source, deps) {
  var dir = path.join(prefix, ".agend-quarantine", new Date(deps.now()).toISOString().replace(/[:.]/g, "-") + "-" + deps.pid);
  fs.mkdirSync(dir, { recursive: true });
  var to = path.join(dir, path.basename(source));
  fs.renameSync(source, to);
  return to;
}

/**
 * What an interrupted install leaves, put right — in this order (#2264 review):
 *   1. the install lock: another installer alive → stop here, touch nothing; one whose writer is gone, or that cannot be
 *      read, is moved to quarantine;
 *   2. npm must be provably idle (above) before anything of npm's is touched — otherwise its leftovers are left alone;
 *   3. npm's retire sibling `@songsid/.agend-<hash>` (npm moves the installed package there before it writes the new
 *      one; killed in between, every later `npm install -g` fails ENOTEMPTY on it): the only copy of AgEnD is put back
 *      (a partial new package in its place goes to quarantine); any other sibling, and npm's retired bin links
 *      `bin/.agend-<hash>`, go to quarantine.
 */
function repair(root, prefix, deps) {
  var notes = [];
  var lockFile = path.join(prefix, LOCK);
  var text = null;
  try { text = fs.readFileSync(lockFile, "utf8"); } catch (e) { text = null; }
  if (text !== null) {
    var holder = null;
    try { holder = JSON.parse(text); } catch (e) { holder = null; }
    var live = holder && typeof holder.pid === "number" && holder.pid !== deps.pid && deps.alive(holder.pid);
    if (live) return { ok: false, notes: notes, changed: false, reason: "another AgEnD install (pid " + holder.pid + ") is running in " + prefix + "; let it finish, then run this again" };
    try { quarantine(prefix, lockFile, deps); } catch (e) { /* gone meanwhile */ }
    notes.push(holder ? "moved aside an install lock left by pid " + holder.pid + " (no longer running)" : "moved aside an install lock that could not be read");
  }
  var scope = path.join(root, "@songsid");
  var current = path.join(scope, "agend");
  var siblings = [];
  try { siblings = fs.readdirSync(scope).filter(function (n) { return /^\.agend-/.test(n); }); } catch (e) { siblings = []; }
  var binDir = path.join(prefix, "bin");
  var binSiblings = [];
  try { binSiblings = fs.readdirSync(binDir).filter(function (n) { return /^\.agend(-agent|-install)?-[A-Za-z0-9]{8}$/.test(n); }); } catch (e) { binSiblings = []; }
  if (!siblings.length && !binSiblings.length) return { ok: true, notes: notes, changed: false };
  if (!(deps.npmIdle || npmIdle)(deps)) {
    notes.push("another npm is running on this host, so what an earlier install left in " + scope + " was not touched");
    return { ok: true, notes: notes, changed: false };
  }
  siblings.forEach(function (name) {
    var dir = path.join(scope, name);
    var version = isAgendPackage(dir);
    if (version && !isAgendPackage(current)) {
      if (fs.existsSync(current)) quarantine(prefix, current, deps);
      fs.renameSync(dir, current);
      notes.push("put back AgEnD v" + version + " that an interrupted install had moved aside (" + name + ")");
      return;
    }
    notes.push("moved " + name + ", left by an interrupted install, to " + quarantine(prefix, dir, deps));
  });
  binSiblings.forEach(function (name) {
    try { quarantine(prefix, path.join(binDir, name), deps); notes.push("moved bin/" + name + ", left by an interrupted install, to quarantine"); } catch (e) { /* gone */ }
  });
  return { ok: true, notes: notes, changed: true };
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
    var bin = path.join(prefix, "bin", "agend");
    var install = function () { return deps.run("npm", ["install", "-g", spec], { inherit: true }); };
    var done = install();
    if (done.status !== 0) {
      // npm itself can leave its sibling behind (a failure inside its own move): once more, only if repairing moved one.
      var again = repair(root, prefix, deps);
      again.notes.forEach(function (n) { log("  ↺ " + n); });
      if (again.changed) done = install();
    }
    var got = done.status === 0 ? versionOf(bin, deps) : null;
    if (got !== version) {
      var why = done.status !== 0 ? "npm install -g " + spec + " failed (exit " + (done.status === null ? done.signal : done.status) + ")"
        : "after npm install, " + bin + " reports " + (got || "nothing") + ", not v" + version;
      // What actually runs now. npm rolls a failed install back itself: when the previous version still runs, nothing
      // else is done and that is what is said. Only an `agend` that does not run is reinstalled.
      var running = versionOf(bin, deps);
      if (running && done.status !== 0) return fail("install", why + "; v" + running + " is still installed and runs — nothing was changed");
      if (previous && previous !== version) {
        repair(root, prefix, deps);
        var back = deps.run("npm", ["install", "-g", previousAt >= 0 ? args[previousAt + 1] : "@songsid/agend@" + previous], { inherit: true });
        if (back.status === 0 && versionOf(bin, deps) === previous) return fail("install", why + "; v" + previous + " was reinstalled and runs");
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

module.exports = { main: main, repair: repair, claimLock: claimLock, setStage: setStage, npmIdleFromProcessList: npmIdleFromProcessList, LOCK: LOCK };
if (require.main === module) process.exit(main(process.argv.slice(2)));
