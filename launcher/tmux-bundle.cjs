"use strict";
// M-2457 (docs/design/bundled-tmux.md §6.1, §8): AgEnD's bundled tmux, @songsid/agend-tmux-<os>-<cpu>, pinned exactly in
// @songsid/agend's optionalDependencies. postinstall proves it BEFORE anything stops the running version: the files are
// the ones the package declares (sha256, size), `tmux -V` names the pinned release, and a throwaway server on a private
// socket starts, answers, captures and is killed. A failure refuses the install, and npm keeps the previous version.
// Then the receipt, `.agend-tmux.json` next to the package, records what was proved.
// Like postinstall, this runs under whatever Node runs npm: plain ES5-style CommonJS, built-ins only.
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var childProcess = require("child_process");

var RECEIPT = ".agend-tmux.json";
var RECEIPT_KEYS = ["receipt", "pinnedVersion", "tmuxPath", "tmux", "size", "mtime", "sha256", "platform", "arch", "verifiedAt"];
var PLAIN = /^[^"\\\u0000-\u001f]*$/;
var SEMVER = /^\d+\.\d+\.\d+(-agend\.\d+)?$/;
var SMOKE_TIMEOUT_MS = 10000;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}

function absent(file) {
  try { fs.lstatSync(file); return false; } catch (e) { return e && e.code === "ENOENT"; }
}

function packageName(host) {
  return "@songsid/agend-tmux-" + host.id;
}

/** The exact pin for this host from @songsid/agend's optionalDependencies, or null (none published for it yet). */
function pinnedTmux(manifest, host) {
  var name = packageName(host);
  var version = manifest && manifest.optionalDependencies && manifest.optionalDependencies[name];
  return typeof version === "string" && SEMVER.test(version) ? { name: name, version: version } : null;
}

/** Exactly <pkgDir>/node_modules/<name>, never require.resolve (it can walk up to an ancestor's copy). */
function tmuxCandidate(pkgDir, pin) {
  var dir = path.join(pkgDir, "node_modules", pin.name);
  var exists = !absent(dir);
  return { dir: dir, exists: exists, manifest: exists ? readJson(path.join(dir, "package.json")) : null, tmux: path.join(dir, "bin", "tmux"), terminfo: path.join(dir, "share", "terminfo") };
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * The environment the bundled tmux runs with: its own terminfo first, a UTF-8 locale, never a caller's $TMUX, and no
 * shell startup hooks (the proof's pane runs /bin/sh directly; ENV/BASH_ENV would still make a shell read a file).
 */
function tmuxEnv(candidate, base) {
  var env = {};
  var from = base || process.env;
  Object.keys(from).forEach(function (k) { if (k !== "TMUX" && k !== "TMUX_PANE" && k !== "ENV" && k !== "BASH_ENV") env[k] = from[k]; });
  env.SHELL = "/bin/sh";
  env.TERMINFO_DIRS = candidate.terminfo + (from.TERMINFO_DIRS ? ":" + from.TERMINFO_DIRS : ":/usr/share/terminfo:/lib/terminfo:/usr/lib/terminfo");
  if (!/UTF-?8/i.test(String(from.LC_ALL || from.LC_CTYPE || from.LANG || ""))) env.LC_CTYPE = "C.UTF-8";
  return env;
}

/** The proof's pane program: tmux execs this argv directly (more than one argument: no shell, no login shell). */
var PANE_MARK = "agend-verify-ok";
var PANE_ARGV = ["/bin/sh", "-c", "printf '%s\\n' " + PANE_MARK + "; exec sleep 60"];

/** Milliseconds on a monotonic clock: a wall-clock step (NTP, a VM resume) must not end a wait early or stretch it. */
function monotonicMs() {
  var t = process.hrtime();
  return t[0] * 1e3 + t[1] / 1e6;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Has process `pid` exited? true only on positive evidence: no such process (ESRCH), or a zombie (it has exited and
 * waits for a parent that may never reap it, e.g. a container whose PID 1 is not an init). Anything else is false.
 */
function processGone(pid, platform) {
  try { process.kill(pid, 0); } catch (e) { return !!e && e.code === "ESRCH"; }
  try {
    if ((platform || process.platform) === "linux") {
      var stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
    }
    var ps = childProcess.spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    return ps.status === 0 && /^\s*Z/.test(String(ps.stdout));
  } catch (e) { return false; }
}

/**
 * Prove the bundled tmux. Returns { ok: true, tmux, sha256, size, mtime, real } or { ok: false, reason }.
 * The private-socket proof records the server it creates (pid, socket path and identity) and accepts its end only on
 * positive evidence: that pid gone and a clean "no server" answer on the socket. An unknown observation (a timeout, a
 * signal, an error) fails the proof, and then nothing is unlinked: the reason names what may still be running.
 * Seams for tests: deps.spawnSync, deps.pid, deps.socket, deps.processGone, deps.exitWaitMs.
 */
function verifyTmux(candidate, pin, deps) {
  var d = deps || {};
  var spawn = d.spawnSync || childProcess.spawnSync;
  var gone = d.processGone || processGone;
  var exitWaitMs = d.exitWaitMs || 5000;
  var m = candidate.manifest;
  if (!m || m.name !== pin.name || m.version !== pin.version) return { ok: false, reason: "the bundled tmux package is not " + pin.name + "@" + pin.version };
  var want = m.agendTmux;
  if (!want || typeof want.tmux !== "string" || !/^\d+\.\d+[a-z]?$/.test(want.tmux) || !/^[0-9a-f]{64}$/.test(String(want.sha256)) || !(want.size > 0)) {
    return { ok: false, reason: "the bundled tmux package does not say which binary it holds (agendTmux)" };
  }
  var st;
  try { st = fs.lstatSync(candidate.tmux); } catch (e) { st = null; }
  if (!st || !st.isFile()) return { ok: false, reason: "the bundled tmux binary is missing or not a regular file" };
  if (st.size !== want.size) return { ok: false, reason: "the bundled tmux binary is " + st.size + " bytes, not the " + want.size + " its package declares" };
  var sum = sha256(candidate.tmux);
  if (sum !== want.sha256) return { ok: false, reason: "the bundled tmux binary's sha256 is not the one its package declares" };
  var env = tmuxEnv(candidate, d.env);
  var run = function (args) {
    var r = spawn(candidate.tmux, args, { encoding: "utf8", timeout: SMOKE_TIMEOUT_MS, env: env, stdio: ["ignore", "pipe", "pipe"] });
    return { status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || ""), error: r.error || null, signal: r.signal || null };
  };
  var clean = function (r) { return !r.error && !r.signal && typeof r.status === "number"; };
  var why = function (r) { return r.error ? String(r.error.code || r.error.message || r.error) : r.signal ? "signal " + r.signal : "exit " + r.status + (r.stderr.trim() ? ": " + r.stderr.trim().split("\n").pop() : ""); };
  // Every call names the throwaway socket, -V included: nothing here can reach the default or AgEnD's server.
  var sock = d.socket || "agend-verify-" + (d.pid || process.pid);
  var v = run(["-L", sock, "-V"]);
  if (!clean(v) || v.status !== 0) return { ok: false, reason: "the bundled tmux did not run (" + why(v) + ")" };
  if (v.stdout.trim() !== "tmux " + want.tmux) return { ok: false, reason: "the bundled tmux says '" + v.stdout.trim() + "', not 'tmux " + want.tmux + "'" };

  // A throwaway server on that socket of its own: never the default socket, never AgEnD's `agend` socket.
  var failed = null;
  var server = null;      // { pid, path, id } once known
  var step = function (label, args) {
    var r = run(args);
    if (!clean(r) || r.status !== 0) failed = label + " failed (" + why(r) + ")";
    return r;
  };
  try {
    step("new-session", ["-L", sock, "-f", "/dev/null", "new-session", "-d", "-s", "verify", "-x", "80", "-y", "10"].concat(PANE_ARGV));
    if (!failed) {
      var idr = step("display-message", ["-L", sock, "display-message", "-p", "-t", "verify", "#{pid} #{socket_path}"]);
      var mm = failed ? null : /^(\d+) (\/.+)$/.exec(idr.stdout.trim());
      if (!failed && (!mm || path.basename(mm[2]) !== sock)) failed = "the server did not say which process and socket it is ('" + idr.stdout.trim() + "')";
      if (!failed) {
        var sst = socketIdentity(mm[2]);
        if (!sst) failed = "the server's socket " + mm[2] + " is not a socket";
        else server = { pid: Number(mm[1]), path: mm[2], id: sst };
      }
    }
    if (!failed) step("has-session", ["-L", sock, "has-session", "-t", "verify"]);
    if (!failed) {
      // The pane program ran: its mark is on the screen (it may take a moment to paint).
      var seen = false;
      for (var k = 0; k < 20 && !failed && !seen; k++) {
        var cap = step("capture-pane", ["-L", sock, "capture-pane", "-p", "-t", "verify"]);
        seen = !failed && cap.stdout.indexOf(PANE_MARK) >= 0;
        if (!seen && !failed) sleepMs(100);
      }
      if (!failed && !seen) failed = "capture-pane never showed the pane program's output";
    }
    if (!failed) step("kill-server", ["-L", sock, "kill-server"]);
    if (!failed) {
      // Gone, positively: the recorded pid has exited, and the socket answers a clean "no server".
      // Monotonic (alpha CI run 42287645555: the wall clock stepped mid-wait, the deadline was already past at the first
      // check, and a server killed a moment earlier was refused as "still running" in 151 ms of a 1.5 s budget).
      var deadline = monotonicMs() + exitWaitMs;
      while (!gone(server.pid) && monotonicMs() < deadline) sleepMs(50);
      if (!gone(server.pid)) failed = "its server (pid " + server.pid + ") was still running after kill-server";
      else {
        var after = run(["-L", sock, "has-session"]);
        if (!clean(after)) failed = "whether its server ended could not be confirmed (has-session: " + why(after) + ")";
        else if (after.status === 0) failed = "its server was still answering after kill-server";
        // Only tmux's own "no server" answer (exit 1) is proof; any other code is an unknown observation.
        else if (after.status !== 1) failed = "whether its server ended could not be confirmed (has-session: " + why(after) + ")";
      }
    }
  } finally {
    // Cleanup that needs no proof: ask the server to go. Unlinking needs the proof above.
    if (failed) run(["-L", sock, "kill-server"]);
  }
  if (failed) {
    var left = server ? " (server pid " + server.pid + ", socket " + server.path + " left in place)" : " (socket -L " + sock + ")";
    return { ok: false, reason: "the bundled tmux's private-socket check failed: " + failed + left };
  }
  // Reached only with the server's exit proved above.
  removeStaleSocket(server);
  var real = fs.realpathSync(candidate.tmux);
  var fin = fs.statSync(real);
  return { ok: true, tmux: want.tmux, sha256: sum, size: fin.size, mtime: Math.floor(fin.mtimeMs / 1000), real: real };
}

/**
 * Remove the socket file tmux leaves behind after kill-server — only the one this proof created and saw exit: the same
 * path, still a socket, the same identity (inode and change time). Anything else stays where it is.
 */
function removeStaleSocket(server) {
  try {
    if (socketIdentity(server.path) !== server.id) return;
    fs.unlinkSync(server.path);
  } catch (e) { /* already gone */ }
}

/**
 * A socket file's identity: its inode and its change time to the nanosecond (an inode number alone can be reused at
 * once by a file created where a removed one was). null when it is not a socket.
 */
function socketIdentity(file) {
  try {
    var st = fs.lstatSync(file, { bigint: true });
    return st.isSocket() ? st.ino + ":" + st.ctimeNs : null;
  } catch (e) { return null; }
}

function receiptText(r) {
  var o = {};
  RECEIPT_KEYS.forEach(function (k) { o[k] = r[k]; });
  return JSON.stringify(o, null, 2) + "\n";
}

function receiptShapeOk(r) {
  return !!r && r.receipt === 1 && typeof r.pinnedVersion === "string" && SEMVER.test(r.pinnedVersion)
    && typeof r.tmuxPath === "string" && PLAIN.test(r.tmuxPath) && path.isAbsolute(r.tmuxPath)
    && typeof r.tmux === "string" && /^\d+\.\d+[a-z]?$/.test(r.tmux)
    && typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256)
    && Number.isInteger(r.size) && r.size > 0 && Number.isInteger(r.mtime);
}

/** Write the receipt atomically next to the package (same rename-into-place as the runtime receipt). */
function writeReceipt(pkgDir, pin, proved, host) {
  if (!PLAIN.test(proved.real)) throw new Error("AgEnD's install path " + JSON.stringify(proved.real) + " contains a quote, backslash or control character");
  var receipt = { receipt: 1, pinnedVersion: pin.version, tmuxPath: proved.real, tmux: proved.tmux, size: proved.size, mtime: proved.mtime, sha256: proved.sha256, platform: host.platform, arch: host.arch, verifiedAt: new Date().toISOString() };
  var file = path.join(pkgDir, RECEIPT);
  var tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, receiptText(receipt));
  fs.renameSync(tmp, file);
  return receipt;
}

/**
 * The receipt, if it still describes the file on disk (size and mtime; the sha256 once per start is the caller's,
 * PR B). null otherwise: a missing, malformed or stale receipt is never trusted.
 */
function readReceipt(pkgDir, pin) {
  var r = readJson(path.join(pkgDir, RECEIPT));
  if (!receiptShapeOk(r) || (pin && r.pinnedVersion !== pin.version)) return null;
  var st;
  try { st = fs.statSync(r.tmuxPath); } catch (e) { return null; }
  return st.isFile() && st.size === r.size && Math.floor(st.mtimeMs / 1000) === r.mtime ? r : null;
}

module.exports = {
  RECEIPT: RECEIPT, RECEIPT_KEYS: RECEIPT_KEYS, SEMVER: SEMVER,
  packageName: packageName, pinnedTmux: pinnedTmux, tmuxCandidate: tmuxCandidate, tmuxEnv: tmuxEnv,
  verifyTmux: verifyTmux, processGone: processGone, PANE_ARGV: PANE_ARGV, writeReceipt: writeReceipt, readReceipt: readReceipt, receiptShapeOk: receiptShapeOk, receiptText: receiptText,
};
