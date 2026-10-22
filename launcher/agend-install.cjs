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
 * process title to `npm <command> <args>` without its flags, but argv as started shows them, and a flag is read the way
 * npm reads it (Prism r2): one that takes a value consumes the next word whatever it is (`npm --prefix run install` is an
 * install); one that takes none consumes nothing; an unknown one may be either, and both readings are kept. The npm
 * counts as idle only if every reading's command is one that cannot reify; an unknown word as the command is busy. A
 * process list that cannot be read (ps failed, a row that does not parse, this process missing from it) is not idle.
 */
var NPM_CHANGES = /^(?:install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|uninstall|un|unlink|remove|rm|r|update|up|upgrade|udpate|link|ln|ci|clean-install|install-clean|ic|isntall-clean|install-ci-test|cit|install-test|it|dedupe|ddp|find-dupes|prune|rebuild|rb)$/;
var NPM_READS = /^(?:exec|x|access|adduser|add-user|login|logout|audit|bugs|issues|cache|completion|config|c|get|set|deprecate|diff|dist-tag|dist-tags|docs|home|doctor|edit|explain|why|explore|fund|help|help-search|hook|init|create|innit|ls|list|la|ll|org|ogr|outdated|owner|author|pack|ping|pkg|prefix|profile|publish|query|repo|restart|root|run|run-script|rum|urn|sbom|search|find|s|se|shrinkwrap|star|stars|start|stop|team|test|tst|t|token|unpublish|unstar|version|verison|view|v|info|show|whoami)$/;
// npm's flags that take a value (npm 10 config definitions) and the common ones that take none.
var NPM_VALUE_FLAGS = /^(?:--(?:prefix|userconfig|globalconfig|cache|registry|loglevel|workspace|tag|otp|package|call|omit|include|before|access|scope|script-shell|shell|node-options|location|install-strategy|depth|auth-type|cafile|cert|key|proxy|https-proxy|noproxy|local-address|fetch-retries|fetch-timeout|maxsockets|user-agent|editor|browser|viewer|init-module|tag-version-prefix|preid|message|logs-dir|logs-max|replace-registry-host|cidr|expect-results|expect-result-count|sbom-format|sbom-type|lockfile-version|os|cpu|libc)|-w|-C|-c|-m)$/;
var NPM_BOOLEAN_FLAGS = /^(?:-g|-y|-f|-s|-q|-d|-dd|-ddd|-S|-D|-O|-E|-B|-P|-l|-a|-h|-H|-v|--(?:no-[a-z0-9-]+|global|yes|force|silent|quiet|dry-run|json|offline|prefer-offline|prefer-online|ignore-scripts|foreground-scripts|legacy-peer-deps|strict-peer-deps|package-lock-only|save|save-dev|save-optional|save-exact|save-prod|save-peer|save-bundle|global-style|install-links|link|verbose|long|parseable|audit|fund|workspaces|include-workspace-root|if-present|production|usage|help|version|all|unicode|progress|update-notifier|bin-links|rebuild-bundle|engine-strict|prefer-dedupe|read-only|provenance|timing|umask))$/;
function isNpmCommand(word) { return NPM_CHANGES.test(word) || NPM_READS.test(word); }
function npmCommands(args) {
  var words = args.split(/\s+/).filter(function (w) { return w !== ""; });
  var at = -1;
  for (var k = 0; k < words.length && k < 3; k++) {
    if (/(?:^|\/)(?:npm|npx)$/.test(words[k]) || /(?:^|\/)(?:npm|npx)-cli\.js$/.test(words[k])) { at = k; break; }
  }
  if (at < 0) return null;
  if (/npx(?:-cli\.js)?$/.test(words[at])) return ["exec"];
  // Every command this argv can mean: `pending` = the next word may be an unknown flag's value.
  var readings = function (from, pending) {
    for (var w = from; w < words.length; w++) {
      var word = words[w];
      if (word.charAt(0) === "-") {
        if (word.indexOf("=") >= 0 || NPM_BOOLEAN_FLAGS.test(word)) { pending = false; continue; }
        if (NPM_VALUE_FLAGS.test(word)) { w++; pending = false; continue; }   // its value, whatever it says
        pending = true;   // unknown: a value may follow, or not
        continue;
      }
      var asCommand = isNpmCommand(word) ? [word] : ["?"];
      return pending ? asCommand.concat(readings(w + 1, false)) : asCommand;
    }
    return pending ? [] : ["?"];
  };
  var all = readings(at + 1, false);
  return all.length ? all : ["?"];
}
function npmIdleFromProcessList(output, ownPid) {
  var rows = String(output).trim().split("\n").map(function (line) {
    var m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return m ? { pid: Number(m[1]), parent: Number(m[2]), args: m[3] } : null;
  });
  if (!rows.length || rows.some(function (row) { return !row; })) return false;
  if (!rows.some(function (row) { return row.pid === ownPid; })) return false;
  return !rows.some(function (row) {
    var commands = npmCommands(row.args);
    return commands !== null && !commands.every(function (c) { return NPM_READS.test(c); });
  });
}
function npmIdle(deps) {
  var r = deps.run("ps", ["-A", "-o", "pid=,ppid=,args="], { timeoutMs: 5000 });
  return r.status === 0 && npmIdleFromProcessList(r.stdout, deps.pid);
}

/** Move a leftover into `<prefix>/.agend-quarantine/<time>-<pid>/` — kept as evidence, never deleted here. */
function quarantine(prefix, source, deps, name) {
  var dir = path.join(prefix, ".agend-quarantine", new Date(deps.now()).toISOString().replace(/[:.]/g, "-") + "-" + deps.pid);
  fs.mkdirSync(dir, { recursive: true });
  var to = path.join(dir, name || path.basename(source));
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
 * The lock of updaters from before #2264 (src/install-lock.ts acquireInstallLock), which they alone understand — so it is
 * kept by their own rules (Prism r3): a record in their format (pid + start time, read by install-admission.cjs, so a
 * running old updater sees this installer as a live holder and waits); a holder judged as they judge it (live, stale or
 * unknown — unknown blocks); and a stale lock moved only by the holder of `<lock>.reclaim` (claimed whole), under which
 * the lock can change only by its own holder — proven gone. Nothing is ever moved aside to be judged afterwards. One
 * thing more than they do: a lock that cannot be read (created, never filled: the user's, cut short) — their
 * create-then-write keeps the file open from the create to the write, and no one else can open it to write it (theirs is
 * open(wx)). So it counts as stale only when it is proven that no process has it open (openedBy); its age is no evidence
 * (Prism r4: an old writer paused between open and write for a minute is still admitted when it resumes).
 */
var lockReaders = require("./install-admission.cjs");
/**
 * Does any process have `file` open? true / false, or null when that cannot be told — which blocks. Only processes of the
 * file's owner can have created it and hold it open to write (its creator is its owner). Linux: every such process's
 * /proc/<pid>/fd, matched by device and inode. A process of the same user whose descriptors cannot be read is one that
 * made itself non-dumpable (sd-pam, ssh-agent, gpg-agent); Node never does, so it is an old updater only if its command
 * line names node or agend — then, and when even that cannot be read, null. macOS: lsof (exit 1 with no output = none).
 * Elsewhere: null.
 */
/** What a descriptor's link names when it is no file on disk: it cannot be the lock. */
var NOT_A_FILE = /^(?:(?:pipe|socket):\[\d+\]|anon_inode:.*|\/dev\/(?:null|zero|u?random|full|tty\w*|console|ptmx|pts\/\d+))$/;
/** Why the last openedBy answered as it did (a refusal names it, so a stuck host says exactly what could not be read). */
var openedWhy = "";
function openedBy(file, deps) {
  openedWhy = "";
  var unknown = function (why) { openedWhy = why; return null; };
  var because = function (e, what) { return (e && e.code ? e.code : String(e)) + " on " + what; };
  if (deps.openedBy) return deps.openedBy(file);
  // Only a definite "it is gone" (ENOENT) may be skipped; a permission, I/O or any other error proves nothing (Prism r5:
  // /proc/<pid>/fd is behind ptrace checks) → unknown, which blocks.
  var stat = deps.procStat || fs.statSync;
  var readdir = deps.procReaddir || fs.readdirSync;
  var gone = function (e) { return e && e.code === "ENOENT"; };
  var st;
  try { st = stat(file); } catch (e) { return gone(e) ? false : unknown(because(e, file)); }
  if (process.platform === "linux") {
    var pids;
    try { pids = fs.readdirSync("/proc").filter(function (n) { return /^\d+$/.test(n); }); } catch (e) { return unknown(because(e, "/proc")); }
    for (var k = 0; k < pids.length; k++) {
      var owner;
      try { owner = stat("/proc/" + pids[k]).uid; } catch (e) { if (gone(e)) continue; return unknown(because(e, "/proc/" + pids[k])); }   // gone meanwhile, or unknown
      if (owner !== st.uid) continue;
      var fds;
      // A process this one may not inspect (EACCES: non-dumpable, or other credentials — the kernel's ptrace check on
      // its descriptors) is not an old updater, a plain node process of this user, unless its command line says so.
      var notInspectable = function (pid, what) {
        var cmdline = null;
        try { cmdline = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8"); } catch (e2) { if (gone(e2)) return "gone"; }
        if (cmdline === null || /node|agend/i.test(cmdline)) return "EACCES on " + what + " (" + (cmdline === null ? "its command line unreadable" : JSON.stringify(cmdline.replace(/\0/g, " ").trim().slice(0, 80))) + ")";
        return "skip";
      };
      try { fds = readdir("/proc/" + pids[k] + "/fd"); } catch (e) {
        if (gone(e)) continue;
        if (e.code !== "EACCES") return unknown(because(e, "/proc/" + pids[k] + "/fd"));
        var verdict = notInspectable(pids[k], "/proc/" + pids[k] + "/fd");
        if (verdict === "gone" || verdict === "skip") continue;
        return unknown(verdict);
      }
      for (var f = 0; f < fds.length; f++) {
        var seen;
        var fdPath = "/proc/" + pids[k] + "/fd/" + fds[f];
        try { seen = stat(fdPath); } catch (e) {
          if (gone(e)) continue;   // closed meanwhile
          // Its target cannot be stat'ed (a security module, as on CI runners): the link itself still names it. A pipe,
          // a socket, an anonymous inode or a terminal/null device is not the lock (a regular file in the prefix).
          var target = null, linkError = null;
          try { target = (deps.procReadlink || fs.readlinkSync)(fdPath); } catch (e2) { if (gone(e2)) continue; linkError = e2; }
          if (target !== null && NOT_A_FILE.test(target)) continue;
          if (target === null && e.code === "EACCES" && linkError && linkError.code === "EACCES") {
            // Neither its target nor its link may be read: the process is not inspectable at all (CI runners have one).
            var seenAs = notInspectable(pids[k], fdPath);
            if (seenAs === "gone" || seenAs === "skip") break;
            return unknown(seenAs);
          }
          return unknown(because(e, fdPath) + (target !== null ? " → " + target : ""));
        }
        if (seen.dev === st.dev && seen.ino === st.ino) { openedWhy = "pid " + pids[k] + " has it open"; return true; }
      }
    }
    return false;
  }
  if (process.platform === "darwin") {
    var r = deps.run(fs.existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof", ["-nP", "-t", "--", file], { timeoutMs: 15000 });
    if (r.status === 0 && String(r.stdout).trim()) { openedWhy = "pid " + String(r.stdout).trim().split("\n").join(", ") + " has it open"; return true; }
    if (r.status === 1 && !String(r.stdout).trim() && !String(r.stderr).trim()) return false;
    return unknown("lsof exited " + (r.status === null ? r.error || r.signal : r.status) + (String(r.stderr).trim() ? ": " + String(r.stderr).trim().slice(0, 120) : ""));
  }
  return unknown("no way to see open files on " + process.platform);
}
/** An unreadable lock that may still be being written: refused, saying what was seen. */
function beingWritten(lock, why) {
  return "the install lock " + lock + " is being written by another AgEnD install, or whether it still is cannot be told" + (why ? " (" + why + ")" : "") + "; run this again in a moment";
}
function legacyRecord(prefix, deps, spec, home) {
  var r = deps.lockReaders || lockReaders;
  var ticks = r.startTicks(deps.pid), boot = r.bootId();
  var record = { pid: deps.pid, processStart: r.processStart(deps.pid) || "" };
  if (ticks !== null && boot !== null) { record.startTicks = ticks; record.bootId = boot; }
  record.prefix = prefix; record.targetSpec = spec; record.agendHome = home;
  record.token = require("crypto").randomBytes(16).toString("hex");
  record.createdAt = new Date(deps.now()).toISOString();
  return JSON.stringify(record) + "\n";
}
function legacyState(text, file, deps) {
  var r = deps.lockReaders || lockReaders;
  var holder = r.parse(text);
  if (holder) return { state: holder.pid === deps.pid ? "stale" : r.holderState(holder, { exists: deps.alive, processStart: r.processStart, startTicks: r.startTicks, bootId: r.bootId }), pid: holder.pid };
  if (!fs.existsSync(file)) return { state: "gone" };
  var open = openedBy(file, deps);
  return { state: open === false ? "stale" : "unknown", unreadable: true, why: openedWhy };
}
/** Move a stale legacy lock away by their rule: only under `<lock>.reclaim`, and only the bytes judged. */
function reclaimLegacy(prefix, lock, judged, judgedState, record, deps) {
  var marker = lock + ".reclaim";
  if (!createWhole(marker, record, deps)) {
    var other = (deps.lockReaders || lockReaders).parse(readText(marker) || "");
    var otherState = other ? legacyState(readText(marker) || "", marker, deps).state : "unknown";
    return otherState === "live" ? { refuse: "another install is replacing the stale lock on " + prefix + "; run this again in a moment" }
      : { refuse: "a reclaim marker " + marker + " was left behind (pid " + (other ? other.pid : "unknown") + "); if no `agend update` runs, remove it and run this again" };
  }
  try {
    if (deps.onStep) deps.onStep("legacy-reclaimed");
    // Under the marker the lock changes only by its own (gone) holder: still the one judged, else nothing is moved.
    if (readText(lock) !== judged) return { changed: true };
    // An unreadable one: still not open anywhere (no writer can open it again: theirs is open(wx) on a new file).
    if (judgedState.unreadable && openedBy(lock, deps) !== false) return { refuse: beingWritten(lock, openedWhy) };
    quarantine(prefix, lock, deps);
    return { moved: true };
  } finally {
    if (readText(marker) === record) { try { fs.unlinkSync(marker); } catch (e) { /* gone */ } }
  }
}

var ENTRIES = ".agend-install.d";
function holderOf(text) {
  var holder = null;
  try { holder = JSON.parse(text); } catch (e) { holder = null; }
  return holder && typeof holder.pid === "number" ? holder : null;
}

/**
 * Admission (#2264 review): this installer owns the prefix before anything in it is touched, and keeps it through the
 * repair, the install, its retry and the rollback.
 *
 * Between these installers it is announce-then-check — nothing of another installer is ever moved to decide it (Prism
 * r2: a takeover of a shared lock path can always move a newer owner's lock by a stale reader). Each installer writes an
 * entry of its own, `<prefix>/.agend-install.d/<pid>-<random>` (whole, written aside and linked), and only then lists the
 * others: one whose writer runs → it withdraws its own entry and refuses (75). Of two that race, at least the later one
 * sees the earlier's entry, so two are never admitted (both may refuse: run again). An entry whose writer is gone has a
 * name no one else will ever write, so it is moved to quarantine without a race.
 *
 * The admitted installer then also holds `<prefix>/.agend-install.lock`, the lock updaters from before #2264 take, by
 * their rules (above): one of theirs that runs, or whose holder cannot be told → refuse; a stale one is moved to
 * quarantine under their `.reclaim` marker. Its token is this installer's: every npm install it runs presents it
 * (AGEND_INSTALL_TOKEN), because a release from before #2264 — a target installed by --spec, the previous version put
 * back — admits its own postinstall only for the token of the live lock (#2286 review).
 * Returns { release, notes, token } or { refuse }.
 */
function admit(prefix, deps, opts) {
  opts = opts || {};
  // The prefix as old updaters name it (realpath): one lock however the prefix was reached.
  try { prefix = fs.realpathSync(prefix); } catch (e) { /* the writes below say */ }
  var dir = path.join(prefix, ENTRIES);
  var name = deps.pid + "-" + (deps.nonce ? deps.nonce() : require("crypto").randomBytes(8).toString("hex"));
  var mine = path.join(dir, name);
  var record = JSON.stringify({ pid: deps.pid, by: "agend-install", createdAt: new Date(deps.now()).toISOString() }) + "\n";
  var notes = [];
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* the create below says */ }
  if (!createWhole(mine, record, deps)) return { refuse: "cannot write an install entry in " + dir };
  var withdraw = function () { if (readText(mine) === record) { try { fs.unlinkSync(mine); } catch (e) { /* gone */ } } };
  if (deps.onStep) deps.onStep("announced");
  var others = [];
  try { others = fs.readdirSync(dir).filter(function (n) { return n !== name && !/\.tmp$/.test(n); }); } catch (e) { withdraw(); return { refuse: "cannot list " + dir }; }
  for (var k = 0; k < others.length; k++) {
    var holder = holderOf(readText(path.join(dir, others[k])));
    if (holder && holder.pid !== deps.pid && deps.alive(holder.pid)) {
      withdraw();
      return { refuse: "another AgEnD install (pid " + holder.pid + ") is running in " + prefix + "; let it finish, then run this again" };
    }
  }
  others.forEach(function (n) {
    // Gone (or written by no installer): its name is its writer's alone.
    try { quarantine(prefix, path.join(dir, n), deps); notes.push("moved aside an install entry left by an installer that is no longer running"); } catch (e) { /* gone */ }
  });

  var lock = path.join(prefix, LOCK);
  var legacy = legacyRecord(prefix, deps, opts.spec || "", opts.home || "");
  for (var attempt = 0; attempt < 3; attempt++) {
    if (createWhole(lock, legacy, deps)) {
      return { notes: notes, token: JSON.parse(legacy).token, release: function () {
        if (readText(lock) === legacy) { try { fs.unlinkSync(lock); } catch (e) { /* gone */ } }
        withdraw();
      } };
    }
    var text = readText(lock);
    if (text === null) continue;
    var judged = legacyState(text, lock, deps);
    if (judged.state === "gone") continue;
    if (judged.state !== "stale") {
      withdraw();
      return { refuse: judged.unreadable
        ? beingWritten(lock, judged.why)
        : "another AgEnD install (pid " + judged.pid + ") is running in " + prefix + "; let it finish, then run this again" };
    }
    if (deps.onStep) deps.onStep("legacy-judged");
    var taken = reclaimLegacy(prefix, lock, text, judged, legacy, deps);
    if (taken.refuse) { withdraw(); return { refuse: taken.refuse }; }
    if (taken.moved) notes.push(judged.unreadable ? "moved aside an install lock that could not be read" : "moved aside an install lock left by pid " + judged.pid + " (no longer running)");
  }
  withdraw();
  return { refuse: "another AgEnD install keeps claiming " + lock + "; let it finish, then run this again" };
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
/** The fleet that runs now: the live process fleet.pid names, else 0. */
function fleetPid(home, deps) {
  var pid = Number(String(readText(path.join(home, "fleet.pid")) || "").trim());
  return pid > 0 && deps.alive(pid) ? pid : 0;
}
function fleetRunning(home, deps) { return fleetPid(home, deps) > 0; }

function versionOf(agendBin, deps) {
  var r = deps.run(agendBin, ["--version"], { timeoutMs: 60000 });
  return r.status === 0 ? last(r.stdout).replace(/^v/i, "") : null;
}

/**
 * #2420: what an update whose new service does not come up goes back to — the 2.2 updater's C6 rollback
 * (src/package-preimage.ts, src/service-activation.ts), here for every update this installer runs. Before npm, the
 * installed package (with its node_modules: its bundled Node, the runtime receipt and key) is copied to
 * `<prefix>/.agend-rollback/<version>-<time>/agend` — the same filesystem, so putting it back is a rename — with where
 * each of its bin links points; and the service definition's bytes are kept. Only on a host with a service: a
 * hand-started fleet's restart is not rolled back (2.2 neither: its ownership cannot be proven).
 */
var ROLLBACK_DIR = ".agend-rollback";
/** A copy a rollback could not use is kept on purpose (its answer names it): this file in it says why. */
var KEPT = "kept.txt";
/**
 * Copies left by an installer that died before its own clean-up (SIGKILL, a killed cgroup): each is a whole package
 * with its Node (~235 MB) and nothing else ever removes it. Only this installer's names (`<version>-<time>-<pid>`), only
 * when that pid no longer runs, and never one a rollback kept on purpose; called while this installer owns the prefix,
 * so no other installer is writing one. 2.2's updater's copies (`<version>-<time>`, which it prunes itself) are left.
 */
function pruneStale(prefix, deps) {
  var base = path.join(prefix, ROLLBACK_DIR);
  var names = [];
  try { names = fs.readdirSync(base); } catch (e) { return []; }
  var notes = [];
  names.forEach(function (name) {
    var m = /-\d{3}Z-(\d+)$/.exec(name);
    if (!m || Number(m[1]) === deps.pid || deps.alive(Number(m[1]))) return;
    var dir = path.join(base, name);
    if (fs.existsSync(path.join(dir, KEPT))) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); notes.push("removed a rollback copy left by an installer that is no longer running (" + name + ")"); } catch (e) { /* tried again next time */ }
  });
  return notes;
}
function binNames(pkgDir) {
  var p = readJson(path.join(pkgDir, "package.json"));
  return p && p.bin && typeof p.bin === "object" ? Object.keys(p.bin) : [];
}
function takePreimage(root, prefix, deps) {
  var pkg = path.join(root, "@songsid", "agend");
  var version = isAgendPackage(pkg);
  if (!version) return { preimage: null };
  var dir = path.join(prefix, ROLLBACK_DIR, version + "-" + new Date(deps.now()).toISOString().replace(/[:.]/g, "-") + "-" + deps.pid);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 448 });
    fs.cpSync(pkg, path.join(dir, "agend"), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) { /* nothing to keep */ }
    return { refuse: "the installed AgEnD could not be copied aside for a rollback (" + (e && e.message ? e.message : String(e)) + ")" };
  }
  var links = {};
  binNames(pkg).forEach(function (name) {
    var link = path.join(prefix, "bin", name);
    try { links[name] = fs.lstatSync(link).isSymbolicLink() ? fs.readlinkSync(link) : null; } catch (e) { links[name] = null; }
  });
  return { preimage: { dir: dir, version: version, links: links } };
}
/** The preimage back in place of what npm installed, and its bin links (a bin only the new release has goes). */
function restorePreimage(root, prefix, p) {
  var pkg = path.join(root, "@songsid", "agend");
  var aside = path.join(p.dir, "replaced");
  var names = binNames(pkg);
  try {
    if (fs.existsSync(pkg)) fs.renameSync(pkg, aside);
    fs.renameSync(path.join(p.dir, "agend"), pkg);
  } catch (e) {
    return "the previous package could not be put back from " + p.dir + " (" + (e && e.message ? e.message : String(e)) + ")";
  }
  Object.keys(p.links).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
  for (var k = 0; k < names.length; k++) {
    var link = path.join(prefix, "bin", names[k]);
    var isLink = false;
    try { isLink = fs.lstatSync(link).isSymbolicLink(); } catch (e) { isLink = false; }
    if (isLink) { try { fs.unlinkSync(link); } catch (e) { /* gone */ } }
    if (p.links[names[k]]) {
      try { fs.symlinkSync(p.links[names[k]], link); } catch (e) { return link + " could not be restored (" + (e && e.message ? e.message : String(e)) + ")"; }
    }
  }
  try { fs.rmSync(p.dir, { recursive: true, force: true }); } catch (e) { /* the copy is spent either way */ }
  return null;
}

/** The service as its manager names it: the system unit `agend`, the user unit `com.agend.fleet`, the launchd job. */
function serviceOf(kind, deps) {
  var home = deps.env.HOME || os.homedir();
  if (kind === "system") return { kind: kind, unit: "agend", scope: [], file: deps.systemUnit || "/etc/systemd/system/agend.service" };
  if (kind === "user") return { kind: kind, unit: "com.agend.fleet", scope: ["--user"], file: path.join(home, ".config", "systemd", "user", "com.agend.fleet.service") };
  if (kind === "launchd") return { kind: kind, label: "com.agend.fleet", domain: "gui/" + deps.uid, file: path.join(home, "Library", "LaunchAgents", "com.agend.fleet.plist") };
  return null;
}
var MANAGER_MS = 15 * 60 * 1000;   // a stop waits out the fleet's own stop grace; a start, its READY
function manage(svc, args, deps, timeoutMs) {
  if (svc.kind === "launchd") return deps.run("launchctl", args, { timeoutMs: timeoutMs || 15000 });
  var env = deps.env;
  // `systemctl --user` reaches the user's manager through XDG_RUNTIME_DIR (its private socket: no D-Bus needed).
  if (svc.kind === "user" && !env.XDG_RUNTIME_DIR && deps.uid >= 0) env = Object.assign({}, env, { XDG_RUNTIME_DIR: "/run/user/" + deps.uid });
  return deps.run("systemctl", svc.scope.concat(args), { timeoutMs: timeoutMs || 15000, env: env });
}
/**
 * What the manager says of the service: { known, running, stopped, pid }. systemd: active with a main pid is running;
 * inactive or failed is stopped (anything else — activating, an auto-restart, deactivating — is neither). launchd: a
 * loaded job in state running with a pid is running; launchctl print's "not loaded" (113, or 125: no such domain) is
 * stopped. A query that does not complete is not known.
 */
function serviceState(svc, deps) {
  if (svc.kind === "launchd") {
    var p = manage(svc, ["print", svc.domain + "/" + svc.label], deps);
    if (p.signal || p.status === null) return { known: false };
    if (p.status === 113 || p.status === 125) return { known: true, running: false, stopped: true, pid: 0 };
    if (p.status !== 0) return { known: false };
    var pid = /^\s*pid = (\d+)\s*$/m.exec(p.stdout);
    var state = /^\s*state = (.+?)\s*$/m.exec(p.stdout);
    var runs = /^\s*runs = (\d+)\s*$/m.exec(p.stdout);
    var running = !!pid && !!state && state[1] === "running";
    return { known: true, running: running, stopped: false, pid: running ? Number(pid[1]) : 0, state: state ? state[1] : "", runs: runs ? Number(runs[1]) : -1 };
  }
  var r = manage(svc, ["show", "-p", "ActiveState", "-p", "SubState", "-p", "MainPID", "-p", "NeedDaemonReload", svc.unit], deps);
  if (r.status !== 0 || r.signal) return { known: false };
  var props = {};
  String(r.stdout).split("\n").forEach(function (line) { var at = line.indexOf("="); if (at > 0) props[line.slice(0, at)] = line.slice(at + 1).trim(); });
  if (!props.ActiveState) return { known: false };
  var main = Number(props.MainPID) || 0;
  return { known: true, running: props.ActiveState === "active" && main > 0, stopped: props.ActiveState === "inactive" || props.ActiveState === "failed",
    pid: main, state: props.ActiveState + "/" + (props.SubState || ""), needReload: props.NeedDaemonReload === "yes" };
}
function clockOf(deps) { return deps.monotonicNow || function () { return Number(process.hrtime.bigint() / BigInt(1000000)); }; }
function sleepOf(deps) { return deps.sleep || function (ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }; }
/** Poll launchd (bounded, monotonic) until `done(state)` — a bootout returns before the job is gone (macOS 15). */
function awaitLaunchd(svc, deps, done) {
  var clock = clockOf(deps), sleep = sleepOf(deps);
  var deadline = clock() + 10000;
  for (;;) {
    var s = serviceState(svc, deps);
    if (done(s) || clock() >= deadline) return s;
    sleep(100);
  }
}
/** The fleet's web/health port: fleet.yaml's top-level `health_port:`, else the fleet's default. */
function healthPort(home) {
  var m = /^health_port:[ \t]*(\d+)[ \t]*(?:#.*)?$/m.exec(readText(path.join(home, "fleet.yaml")) || "");
  return m ? Number(m[1]) : 19280;
}
/** Does a fleet that finished starting answer GET /health there (200, or 503 with its problems listed)? */
function healthAnswers(port, deps) {
  if (deps.health) return deps.health(port);
  var script = "require('http').get({host:'127.0.0.1',port:" + Number(port) + ",path:'/health',timeout:3000},function(r){var b='';r.on('data',function(d){b+=d});" +
    "r.on('end',function(){try{process.exit(JSON.parse(b).startupComplete===true?0:3)}catch(e){process.exit(4)}})}).on('error',function(){process.exit(5)}).on('timeout',function(){process.exit(6)})";
  return deps.run(process.execPath, ["-e", script], { timeoutMs: 10000 }).status === 0;
}
var LAUNCHD_READY_MS = 5 * 60 * 1000;
var LAUNCHD_STEADY_MS = 60 * 1000;
/**
 * #2420: launchd starts a job without waiting for it (nothing like systemd's READY): `agend restart` / `agend start`
 * return before the fleet runs, and a fleet that exits at start is started again by KeepAlive, forever. So under launchd
 * the fleet proves itself: the job runs the pid fleet.pid names (the fleet writes it as it starts), and /health answers
 * with its startup complete — or, with no answer there (its port taken: the fleet then runs without it), that same pid
 * has run for a minute. The job started again (its runs count grew) is a fleet that exited. null: up; else why not.
 */
function launchdReady(svc, home, deps) {
  var clock = clockOf(deps), sleep = sleepOf(deps);
  var deadline = clock() + LAUNCHD_READY_MS, port = healthPort(home), firstRuns = null, steadyPid = 0, steadySince = 0;
  for (;;) {
    var s = serviceState(svc, deps);
    if (s.known && s.stopped) return "the job is not loaded";
    if (s.known) {
      if (firstRuns === null) firstRuns = s.runs;
      else if (s.runs > firstRuns) return "the fleet exited and launchd started it again (runs " + firstRuns + " → " + s.runs + ")";
      if (s.running && fleetPid(home, deps) === s.pid) {
        if (healthAnswers(port, deps)) return null;
        if (steadyPid !== s.pid) { steadyPid = s.pid; steadySince = clock(); }
        else if (clock() - steadySince >= LAUNCHD_STEADY_MS) return null;
      } else steadyPid = 0;
    }
    if (clock() >= deadline) return "the fleet did not come up within " + LAUNCHD_READY_MS / 1000 + "s (launchd: " + (s.known ? s.state || "no state" : "state unknown") + ")";
    sleep(1000);
  }
}
function stopService(svc, deps) {
  if (svc.kind === "launchd") {
    manage(svc, ["bootout", svc.domain + "/" + svc.label], deps);
    return awaitLaunchd(svc, deps, function (s) { return s.known && s.stopped; });
  }
  // A stop cancels a queued restart job and ends an auto-restart: what systemd then reports is settled.
  manage(svc, ["stop", svc.unit], deps, MANAGER_MS);
  return serviceState(svc, deps);
}
function startService(svc, home, deps) {
  if (svc.kind === "launchd") {
    var boot = manage(svc, ["bootstrap", svc.domain, svc.file], deps);
    if (boot.status !== 0) return { known: true, running: false, stopped: true, pid: 0, why: "launchctl bootstrap exited " + (boot.status === null ? boot.signal : boot.status) };
    var notUp = launchdReady(svc, home, deps);
    if (notUp) return { known: true, running: false, pid: 0, why: notUp };
    return serviceState(svc, deps);
  }
  // The failed start may have used up the unit's start limit: cleared, as `agend restart` does.
  manage(svc, ["reset-failed", svc.unit], deps);
  var started = manage(svc, ["start", svc.unit], deps, MANAGER_MS);
  var s = serviceState(svc, deps);
  if (started.status !== 0 && !s.running) s.why = "systemctl start exited " + (started.status === null ? started.signal : started.status);
  return s;
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
  var admitted = admit(prefix, deps, { spec: spec, home: home });
  admitted.notes && admitted.notes.forEach(function (n) { log("  ↺ " + n); });
  if (admitted.refuse) {
    // Refused: another installer owns the prefix. Only the marker of the `agend update` that started THIS installer
    // says so; anyone else's (the running update's) is left exactly as it is.
    claimed = claimMarker(home, deps, { ownOnly: true });
    return fail("lock", admitted.refuse);
  }
  var preimage = null, definition = null, keepPreimage = false;
  try {
    claimed = claimMarker(home, deps, {});
    setStage(home, claimed, "downloading", { version: version }, deps);
    var fixed = repair(root, prefix, deps);
    fixed.notes.forEach(function (n) { log("  ↺ " + n); });
    pruneStale(prefix, deps).forEach(function (n) { log("  ↺ " + n); });
    var previous = isAgendPackage(path.join(root, "@songsid", "agend"));
    var bin = path.join(prefix, "bin", "agend");
    // #2420: on a host with a service, what an update whose new service does not come up goes back to.
    var svc = serviceOf(serviceKind(deps), deps);
    if (svc && previous) {
      var taken = takePreimage(root, prefix, deps);
      if (taken.refuse) return fail("install", "Not updating: " + taken.refuse + ". Nothing was changed");
      preimage = taken.preimage;
      definition = readText(svc.file);
    }
    // #2286 review: the lock's token, for a release from before #2264 (its postinstall refuses any other install).
    var npmEnv = Object.assign({}, deps.env);
    npmEnv[lockReaders.TOKEN_ENV] = admitted.token;
    var install = function () { return deps.run("npm", ["install", "-g", spec], { inherit: true, env: npmEnv }); };
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
        var back = deps.run("npm", ["install", "-g", previousAt >= 0 ? args[previousAt + 1] : "@songsid/agend@" + previous], { inherit: true, env: npmEnv });
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
    // #2420: the fleet the service ran before this update (its fleet.pid, alive): a failure that never stopped it
    // keeps it, one that did brings the previous service back.
    var fleetBefore = fleetPid(home, deps);
    /**
     * #2420: the new release's service did not come up (its refresh failed, or its restart or start did). With a
     * preimage, the previous package and service definition go back and the previous service runs again — the 2.2
     * updater's C6 rollback. What the manager is still running or starting is stopped first and must be proven
     * stopped, or nothing is rolled back; a fleet the failure never stopped (the same pid still runs) is left running.
     * Without a preimage (no service before this update, no previous AgEnD), it says what to run, as before.
     */
    var rollBack = function (stage, why, hint) {
      if (!preimage || !svc) return fail(stage, why + "; " + hint);
      var name = svc.kind === "launchd" ? "the launchd job " + svc.label : "the " + (svc.kind === "user" ? "user" : "system") + " unit " + svc.unit;
      var kept = "; the previous package is kept in " + preimage.dir;
      log("  ↩ " + why + " — rolling back to v" + preimage.version);
      var untouched = fleetBefore > 0 && fleetPid(home, deps) === fleetBefore;
      if (!untouched) {
        var now = serviceState(svc, deps);
        if (!now.known) { keepPreimage = true; return fail(stage, why + ". What runs " + name + " now cannot be told, so nothing was rolled back" + kept + " — check it, then run `agend restart`"); }
        var stopped = stopService(svc, deps);
        if (!stopped.known || !stopped.stopped) { keepPreimage = true; return fail(stage, why + ". " + name + " could not be stopped (" + (stopped.known ? stopped.state : "its state cannot be told") + "), so nothing was rolled back" + kept); }
      }
      var notBack = restorePreimage(root, prefix, preimage);
      if (notBack) { keepPreimage = true; return fail(stage, why + ". " + notBack + " — reinstall it: npm install -g @songsid/agend@" + preimage.version); }
      var restored = [];
      if (definition !== null && readText(svc.file) !== definition) {
        try { fs.writeFileSync(svc.file, definition); } catch (e) { return fail(stage, why + ". v" + preimage.version + " is back, but " + svc.file + " could not be restored (" + (e && e.code ? e.code : String(e)) + ") — run `agend install --no-activate`, then `agend start`"); }
      }
      if (svc.kind === "launchd") {
        // The refresh's activation plan names the new plist: never left for a later `agend restart` to act on.
        try { fs.unlinkSync(path.join(home, "service-plan.json")); } catch (e) { /* none */ }
      } else {
        var reload = manage(svc, ["daemon-reload"], deps);
        var loaded = reload.status === 0 ? serviceState(svc, deps) : { known: false };
        if (!loaded.known || loaded.needReload) restored.push("run `systemctl" + (svc.kind === "user" ? " --user" : "") + " daemon-reload`: systemd may still have the new definition loaded");
      }
      var back = versionOf(bin, deps);
      var what = "the previous package (v" + preimage.version + ") and " + name + " were restored";
      if (back !== preimage.version) restored.push(bin + " reports " + (back || "nothing") + ", not v" + preimage.version);
      var outcome;
      if (untouched) outcome = what + "; the previous service was never stopped and still runs (pid " + fleetBefore + ")";
      else if (fleetBefore > 0) {
        var started = startService(svc, home, deps);
        outcome = started.running ? what + "; the previous service is running (pid " + started.pid + ")"
          : what + ", but the previous service did not start (" + (started.why || (started.known ? started.state : "its state cannot be told")) + ") — run `agend start`";
      } else outcome = what + "; the service was stopped before this update and is left stopped — `agend start` starts it";
      return fail(stage, why + ". Rolled back: " + outcome + (restored.length ? "; " + restored.join("; ") : "") + ". The update did not succeed");
    };
    if (kind) {
      var service = deps.run(bin, ["install", "--no-activate"], { inherit: true });
      if (service.status !== 0) return rollBack("starting", "`agend install --no-activate` could not refresh the " + kind + " service (exit " + service.status + ")", "AgEnD v" + version + " is installed — run `agend install --no-activate`, then `agend restart`");
    }
    var env = Object.assign({}, deps.env, { AGEND_RESTART_ORIGIN: upgrade ? "agend-update" : "agend-install" });
    if (fleetRunning(home, deps) && (kind || upgrade)) {
      var restarted = deps.run(bin, ["restart", "--yes"], { inherit: true, env: env });
      // 75: the restart job is still running (systemd goes on with it); the new fleet settles the marker.
      if (restarted.status !== 0 && restarted.status !== 75) return rollBack("stopping", "the fleet did not restart onto v" + version + " (exit " + restarted.status + ")", "run `agend restart`");
    } else if (kind) {
      var started = deps.run(bin, ["start"], { inherit: true, env: env });
      if (started.status !== 0) return rollBack("starting", "the " + kind + " service did not start (exit " + started.status + ")", "AgEnD v" + version + " is installed — run `agend start`");
    }
    // Under launchd an exit 0 is not the fleet running (above): it must come up on the new release first.
    var activated = restarted ? restarted.status === 0 : !!started;
    if (svc && svc.kind === "launchd" && activated) {
      var notUp = launchdReady(svc, home, deps);
      if (notUp) return rollBack(restarted ? "stopping" : "starting", "the launchd job did not come up on v" + version + ": " + notUp, "run `agend restart`");
    }
    return 0;
  } finally {
    // Spent (put back), or not needed: only a rollback that could not finish keeps its copy, says where, and marks it
    // so that no later installer prunes it.
    if (preimage && !keepPreimage) { try { fs.rmSync(preimage.dir, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
    if (preimage && keepPreimage && fs.existsSync(preimage.dir)) {
      try { fs.writeFileSync(path.join(preimage.dir, KEPT), "AgEnD v" + preimage.version + ", kept by the installer of v" + version + " (pid " + deps.pid + ") after a rollback it could not finish. Remove this directory once you no longer need it.\n"); } catch (e) { /* the answer already named it */ }
    }
    admitted.release();
  }
}

module.exports = { main: main, repair: repair, admit: admit, openedBy: openedBy, setStage: setStage, claimMarker: claimMarker, npmIdleFromProcessList: npmIdleFromProcessList, npmCommands: npmCommands, LOCK: LOCK };
if (require.main === module) process.exit(main(process.argv.slice(2)));
