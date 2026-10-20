#!/usr/bin/env node
"use strict";
// #2264: AgEnD's one installer. Install, upgrade and repair are this file, always run from the TARGET release itself:
//
//   npm exec --yes --package @songsid/agend@<version> -- agend-install [--upgrade]
//
// install.sh (and so the Windows installer) and `agend update` both end here, so the newest install logic runs on every
// install — never an old updater that happens to be on the host. It installs exactly the version it ships in, and:
//   1. owns the npm prefix first (admit(): a live installer's lock → stop, nothing changed) and keeps it to the end;
//   2. repairs what an interrupted install left in the prefix (repair(): only while no npm changes packages; the only
//      copy of AgEnD put back, anything else moved to quarantine, never deleted);
//   3. `npm install -g @songsid/agend@<this version>` (once more only if repairing moved something npm itself left);
//   4. proves `<prefix>/bin/agend --version` is this version; otherwise says what runs now — the previous version that
//      npm kept is left as it is, and only an `agend` that does not run is reinstalled;
//   5. on a host with a service: `agend install --no-activate` under the manager it has, then the fleet is restarted
//      (or started, when its service is stopped); a hand-started fleet is restarted by an upgrade only;
//   6. records each step in the update marker the fleet edits its chat message from — only a marker it owns.
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

/**
 * The update marker the fleet edits its chat message from (src/update-marker.ts) — written only while this installer
 * owns it (#2264 review). It is claimed once this installer holds the prefix: when the `agend update` that started it
 * wrote it (AGEND_UPDATE_OWNER_PID), or when its writer is gone (an update that died: the user's stuck "downloading").
 * A marker another live process writes — a running update's, a new fleet's — is never changed. Every write re-reads it
 * and writes only while this installer is still its writer (a new update or a new fleet that took it over keeps it).
 */
function claimMarker(home, deps, opts) {
  var marker = readJson(path.join(home, MARKER));
  if (!marker || !marker.progress || typeof marker.pid !== "number") return null;
  var owner = Number(deps.env.AGEND_UPDATE_OWNER_PID) || 0;
  var ours = marker.pid === deps.pid || (owner > 0 && marker.pid === owner);
  if (!ours && (opts.ownOnly || deps.alive(marker.pid))) return null;
  return writeMarker(home, marker, deps);
}
function writeMarker(home, marker, deps) {
  var file = path.join(home, MARKER);
  marker.pid = deps.pid;
  var tmp = file + "." + deps.pid + ".tmp";
  try { fs.writeFileSync(tmp, JSON.stringify(marker), { mode: 384 }); fs.renameSync(tmp, file); return true; } catch (e) { return false; }
}
function setStage(home, claimed, stage, details, deps) {
  if (!claimed) return false;
  var marker = readJson(path.join(home, MARKER));
  if (!marker || !marker.progress || marker.pid !== deps.pid) return false;
  var previous = marker.progress.stage;
  marker.progress.stage = stage;
  if (details.version) marker.progress.version = details.version;
  if (details.error) marker.progress.error = String(details.error).replace(/\s+/g, " ").trim().slice(0, 300);
  if (stage === "failed") marker.progress.failedStage = previous;
  return writeMarker(home, marker, deps);
}

/**
 * Is npm provably idle on this host — is no npm process changing installed packages? Only an npm that installs,
 * uninstalls, updates, links or rebuilds can be reifying this prefix. `npm exec` (this installer's own ancestor; AgEnD
 * fleets run their MCP servers that way, for hours), `npm view`, `npm run` cannot, so they do not count. npm rewrites its
 * process title to `npm <command> <args>` without its flags, but argv as started shows them: a flag's value is skipped
 * (`npm --prefix /x install`), and an npm whose command cannot be told for sure counts as busy. A process list that
 * cannot be read (ps failed, a row that does not parse, this process missing from it) is not idle (#2264 review).
 */
var NPM_CHANGES = /^(?:install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|uninstall|un|unlink|remove|rm|r|update|up|upgrade|udpate|link|ln|ci|clean-install|install-clean|ic|isntall-clean|install-ci-test|cit|install-test|it|dedupe|ddp|find-dupes|prune|rebuild|rb)$/;
var NPM_READS = /^(?:exec|x|access|adduser|add-user|login|logout|audit|bugs|issues|cache|completion|config|c|get|set|deprecate|diff|dist-tag|dist-tags|docs|home|doctor|edit|explain|why|explore|fund|help|help-search|hook|init|create|innit|ls|list|la|ll|org|ogr|outdated|owner|author|pack|ping|pkg|prefix|profile|publish|query|repo|restart|root|run|run-script|rum|urn|sbom|search|find|s|se|shrinkwrap|star|stars|start|stop|team|test|tst|t|token|unpublish|unstar|version|verison|view|v|info|show|whoami)$/;
function isNpmCommand(word) { return NPM_CHANGES.test(word) || NPM_READS.test(word); }
function npmCommand(args) {
  var words = args.split(/\s+/);
  var at = -1;
  for (var k = 0; k < words.length && k < 3; k++) {
    if (/(?:^|\/)(?:npm|npx)$/.test(words[k]) || /(?:^|\/)(?:npm|npx)-cli\.js$/.test(words[k])) { at = k; break; }
  }
  if (at < 0) return null;
  if (/npx(?:-cli\.js)?$/.test(words[at])) return "exec";
  for (var w = at + 1; w < words.length; w++) {
    var word = words[w];
    if (!word) continue;
    if (word.charAt(0) === "-") {
      // `--flag value`: the next word is its value unless it is itself a command (`--global install`).
      if (word.indexOf("=") < 0 && w + 1 < words.length && words[w + 1].charAt(0) !== "-" && !isNpmCommand(words[w + 1])) w++;
      continue;
    }
    return isNpmCommand(word) ? word : "?";
  }
  return "?";
}
function npmIdleFromProcessList(output, ownPid) {
  var rows = String(output).trim().split("\n").map(function (line) {
    var m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return m ? { pid: Number(m[1]), parent: Number(m[2]), args: m[3] } : null;
  });
  if (!rows.length || rows.some(function (row) { return !row; })) return false;
  if (!rows.some(function (row) { return row.pid === ownPid; })) return false;
  return !rows.some(function (row) {
    var command = npmCommand(row.args);
    return command !== null && !NPM_READS.test(command);
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

function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch (e) { return null; } }
/** Create `file` holding `text` only if it does not exist: written aside, then linked into place (whole or not at all). */
function createWhole(file, text, deps) {
  var tmp = file + "." + deps.pid + ".tmp";
  fs.writeFileSync(tmp, text, { mode: 384 });
  try { fs.linkSync(tmp, file); return true; } catch (e) { return false; } finally { try { fs.unlinkSync(tmp); } catch (e) { /* gone */ } }
}

/**
 * Move a lock whose holder is gone out of the way, without ever moving one a live installer took since it was judged.
 * Takers go one at a time (a `.takeover` claim held for a few milliseconds); under it, the lock is re-read, and only the
 * very bytes that were judged stale are moved. A `.takeover` left by a killed taker is itself replaced the same way:
 * moved aside, compared, and put back if it was not the one judged.
 */
function takeOver(prefix, file, judged, deps) {
  var gate = file + ".takeover";
  var mine = JSON.stringify({ pid: deps.pid, createdAt: new Date(deps.now()).toISOString() });
  if (!createWhole(gate, mine, deps)) {
    var held = readText(gate);
    var holder = null;
    try { holder = JSON.parse(held); } catch (e) { holder = null; }
    if (held === null || (holder && typeof holder.pid === "number" && deps.alive(holder.pid))) return "busy";
    if (!moveIfUnchanged(prefix, gate, held, deps) || !createWhole(gate, mine, deps)) return "busy";
  }
  try {
    if (deps.onStep) deps.onStep("takeover");
    var now = readText(file);
    if (now === null) return "gone";
    if (now !== judged) return "changed";
    quarantine(prefix, file, deps);
    return "taken";
  } finally {
    if (readText(gate) === mine) { try { fs.unlinkSync(gate); } catch (e) { /* gone */ } }
  }
}
function moveIfUnchanged(prefix, file, judged, deps) {
  var aside = file + ".aside." + deps.pid;
  try { fs.renameSync(file, aside); } catch (e) { return false; }
  if (readText(aside) === judged) { quarantine(prefix, aside, deps); return true; }
  try { fs.linkSync(aside, file); } catch (e) { /* a third one claimed it meanwhile: it holds it */ }
  try { fs.unlinkSync(aside); } catch (e) { /* gone */ }
  return false;
}

/**
 * Admission: this installer owns the prefix before anything in it is touched, and keeps it through the repair, the
 * install, its retry and the rollback (#2264 review). A live installer's lock → refuse, nothing changed. One whose
 * writer is gone, or that cannot be read, is moved to quarantine (takeOver) and the prefix claimed. The record appears
 * whole or not at all. Returns { release, notes } or { refuse }.
 */
function admit(prefix, deps) {
  var file = path.join(prefix, LOCK);
  var record = JSON.stringify({ pid: deps.pid, by: "agend-install", createdAt: new Date(deps.now()).toISOString() }) + "\n";
  var notes = [];
  for (var attempt = 0; attempt < 5; attempt++) {
    if (createWhole(file, record, deps)) {
      return { notes: notes, release: function () { if (readText(file) === record) { try { fs.unlinkSync(file); } catch (e) { /* gone */ } } } };
    }
    var text = readText(file);
    if (text === null) continue;
    var holder = null;
    try { holder = JSON.parse(text); } catch (e) { holder = null; }
    if (holder && typeof holder.pid === "number" && holder.pid !== deps.pid && deps.alive(holder.pid)) {
      return { refuse: "another AgEnD install (pid " + holder.pid + ") is running in " + prefix + "; let it finish, then run this again" };
    }
    var taken = takeOver(prefix, file, text, deps);
    if (taken === "busy") return { refuse: "another AgEnD install is taking over " + file + " right now; run this again in a moment" };
    if (taken === "taken") notes.push(holder ? "moved aside an install lock left by pid " + holder.pid + " (no longer running)" : "moved aside an install lock that could not be read");
  }
  return { refuse: "another AgEnD install keeps claiming " + prefix + "; let it finish, then run this again" };
}

/**
 * What an interrupted install leaves, put right — only by the installer that owns the prefix (admit), and only while
 * npm is provably idle (above); otherwise npm's leftovers are left alone. npm's retire sibling `@songsid/.agend-<hash>`
 * (npm moves the installed package there before it writes the new one; killed in between, every later `npm install -g`
 * fails ENOTEMPTY on it): the only whole copy of AgEnD is put back (a partial new package in its place goes to
 * quarantine); any other sibling, and npm's retired bin links `bin/.agend-<hash>`, go to quarantine. The lock is not
 * this function's: it never reads or moves one.
 */
function repair(root, prefix, deps) {
  var notes = [];
  var scope = path.join(root, "@songsid");
  var current = path.join(scope, "agend");
  var siblings = [];
  try { siblings = fs.readdirSync(scope).filter(function (n) { return /^\.agend-/.test(n); }); } catch (e) { siblings = []; }
  var binDir = path.join(prefix, "bin");
  var binSiblings = [];
  try { binSiblings = fs.readdirSync(binDir).filter(function (n) { return /^\.agend(-agent|-install)?-[A-Za-z0-9]{8}$/.test(n); }); } catch (e) { binSiblings = []; }
  if (!siblings.length && !binSiblings.length) return { notes: notes, changed: false };
  if (!(deps.npmIdle || npmIdle)(deps)) {
    notes.push("another npm is running on this host, so what an earlier install left in " + scope + " was not touched");
    return { notes: notes, changed: false };
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
  return { notes: notes, changed: true };
}

/**
 * The service AgEnD installed, as `agend restart` picks its authority: the legacy system unit first, then the user unit
 * or the launchd job. null: a hand-started fleet, or none.
 */
function serviceKind(deps) {
  var home = deps.env.HOME || os.homedir();
  if (fs.existsSync(deps.systemUnit || "/etc/systemd/system/agend.service")) return "system";
  if (fs.existsSync(path.join(home, ".config", "systemd", "user", "com.agend.fleet.service"))) return "user";
  if (fs.existsSync(path.join(home, "Library", "LaunchAgents", "com.agend.fleet.plist"))) return "launchd";
  return null;
}
/** A fleet runs now: fleet.pid names a live process. */
function fleetRunning(home, deps) {
  var pid = Number(String(readText(path.join(home, "fleet.pid")) || "").trim());
  return pid > 0 && deps.alive(pid);
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
  var targetAt = args.indexOf("--target");
  // Where the previous version is reinstalled from when the new one does not prove itself (tests and mirrors).
  var previousAt = args.indexOf("--previous-spec");
  var own = readJson(path.join(__dirname, "..", "package.json")) || {};
  var version = own.version;
  var log = deps.log;
  // `agend update` names the release it chose: this must be that release's own installer, never another one npm found
  // on PATH (a target without agend-install makes `npm exec` run whatever agend-install PATH has; #2264 review).
  if (targetAt >= 0 && args[targetAt + 1] !== version) {
    log("  ✗ this is the installer of AgEnD v" + version + ", not of v" + args[targetAt + 1] + " — nothing was changed");
    return 1;
  }
  // The package this installer ships in, unless a test or a mirror names another source of the same version.
  var spec = specAt >= 0 ? args[specAt + 1] : "@songsid/agend@" + version;
  // An exact `@songsid/agend@<version>` spec names the version to prove; anything else (a tarball, a tag) is this one.
  var exact = /^@songsid\/agend@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec);
  if (exact) version = exact[1];
  var home = deps.env.AGEND_HOME || path.join(os.homedir(), ".agend");
  var claimed = false;
  var fail = function (stage, message) {
    log("  ✗ " + message);
    setStage(home, claimed, "failed", { error: message }, deps);
    return stage === "lock" ? 75 : 1;
  };

  log("  AgEnD installer v" + version + (upgrade ? " (upgrade)" : ""));
  var root = last(deps.run("npm", ["root", "-g"], { timeoutMs: 30000 }).stdout);
  var prefix = last(deps.run("npm", ["prefix", "-g"], { timeoutMs: 30000 }).stdout);
  if (!root || !prefix) {
    claimed = claimMarker(home, deps, { ownOnly: true });
    return fail("install", "npm did not say where it installs global packages (npm root -g / npm prefix -g)");
  }
  var admitted = admit(prefix, deps);
  admitted.notes && admitted.notes.forEach(function (n) { log("  ↺ " + n); });
  if (admitted.refuse) {
    // Refused: another installer owns the prefix. Only the marker of the `agend update` that started THIS installer
    // says so; anyone else's (the running update's) is left exactly as it is.
    claimed = claimMarker(home, deps, { ownOnly: true });
    return fail("lock", admitted.refuse);
  }
  try {
    claimed = claimMarker(home, deps, {});
    setStage(home, claimed, "downloading", { version: version }, deps);
    var fixed = repair(root, prefix, deps);
    fixed.notes.forEach(function (n) { log("  ↺ " + n); });
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
    setStage(home, claimed, "installed", { version: version }, deps);

    // A fresh install (no fleet set up, not an upgrade): the next step is the setup wizard.
    var kind = serviceKind(deps);
    var configured = fs.existsSync(path.join(home, "fleet.yaml")) || fs.existsSync(path.join(home, "fleet.pid"));
    if (!configured && !upgrade && !kind) { log("  Next: run `agend quickstart` to set up AgEnD."); return 0; }
    // The service stays under the manager it has (`agend restart` picks the same one: system unit, else user unit or
    // launchd job): the new release's `agend install --no-activate` refreshes that definition without starting anything
    // (a legacy system unit is refreshed in place — never a second, user unit), then the fleet moves onto the new release:
    // restarted when it runs, started when its service is installed but stopped (the user's: the session that ran it
    // ended). A hand-started fleet gets no unit (#1631) and is restarted only by an upgrade.
    if (kind) {
      var service = deps.run(bin, ["install", "--no-activate"], { inherit: true });
      if (service.status !== 0) return fail("starting", "`agend install --no-activate` could not refresh the " + kind + " service (exit " + service.status + "); AgEnD v" + version + " is installed — run `agend install --no-activate`, then `agend restart`");
    }
    var env = Object.assign({}, deps.env, { AGEND_RESTART_ORIGIN: upgrade ? "agend-update" : "agend-install" });
    if (fleetRunning(home, deps) && (kind || upgrade)) {
      var restarted = deps.run(bin, ["restart", "--yes"], { inherit: true, env: env });
      if (restarted.status !== 0 && restarted.status !== 75) return fail("stopping", "the fleet did not restart onto v" + version + " (exit " + restarted.status + "); run `agend restart`");
    } else if (kind) {
      var started = deps.run(bin, ["start"], { inherit: true, env: env });
      if (started.status !== 0) return fail("starting", "the " + kind + " service did not start (exit " + started.status + "); AgEnD v" + version + " is installed — run `agend start`");
    }
    return 0;
  } finally {
    admitted.release();
  }
}

module.exports = { main: main, repair: repair, admit: admit, setStage: setStage, claimMarker: claimMarker, npmIdleFromProcessList: npmIdleFromProcessList, npmCommand: npmCommand, LOCK: LOCK };
if (require.main === module) process.exit(main(process.argv.slice(2)));
