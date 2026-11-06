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

/** The environment the bundled tmux runs with: its own terminfo first, a UTF-8 locale, and never a caller's $TMUX. */
function tmuxEnv(candidate, base) {
  var env = {};
  var from = base || process.env;
  Object.keys(from).forEach(function (k) { if (k !== "TMUX" && k !== "TMUX_PANE") env[k] = from[k]; });
  env.TERMINFO_DIRS = candidate.terminfo + (from.TERMINFO_DIRS ? ":" + from.TERMINFO_DIRS : ":/usr/share/terminfo:/lib/terminfo:/usr/lib/terminfo");
  if (!/UTF-?8/i.test(String(from.LC_ALL || from.LC_CTYPE || from.LANG || ""))) env.LC_CTYPE = "C.UTF-8";
  return env;
}

/**
 * Prove the bundled tmux. Returns { ok: true, tmux, sha256, size, mtime, real } or { ok: false, reason }.
 * deps.spawnSync / deps.pid / deps.socket are seams for tests; the smoke socket is unique to this process and always
 * killed.
 */
function verifyTmux(candidate, pin, deps) {
  var d = deps || {};
  var spawn = d.spawnSync || childProcess.spawnSync;
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
  var why = function (r) { return r.error ? String(r.error.message || r.error) : r.signal ? "signal " + r.signal : "exit " + r.status + (r.stderr.trim() ? ": " + r.stderr.trim().split("\n").pop() : ""); };
  // Every call names the throwaway socket, -V included: nothing here can reach the default or AgEnD's server.
  var sock = d.socket || "agend-verify-" + (d.pid || process.pid);
  var v = run(["-L", sock, "-V"]);
  if (v.status !== 0) return { ok: false, reason: "the bundled tmux did not run (" + why(v) + ")" };
  if (v.stdout.trim() !== "tmux " + want.tmux) return { ok: false, reason: "the bundled tmux says '" + v.stdout.trim() + "', not 'tmux " + want.tmux + "'" };
  // A throwaway server on that socket of its own: never the default socket, never AgEnD's `agend` socket.
  var failed = null;
  var socketPath = "";
  try {
    var steps = [
      ["new-session", ["-L", sock, "-f", "/dev/null", "new-session", "-d", "-s", "verify", "-x", "80", "-y", "10"]],
      ["has-session", ["-L", sock, "has-session", "-t", "verify"]],
      ["capture-pane", ["-L", sock, "capture-pane", "-p", "-t", "verify"]],
      ["kill-server", ["-L", sock, "kill-server"]],
    ];
    for (var i = 0; i < steps.length && !failed; i++) {
      var r = run(steps[i][1]);
      if (r.status !== 0) failed = steps[i][0] + " failed (" + why(r) + ")";
      // Where the server put its socket, asked while it is up: tmux leaves the file behind after kill-server.
      if (i === 0 && !failed) {
        var sp = run(["-L", sock, "display-message", "-p", "-t", "verify", "#{socket_path}"]);
        if (sp.status === 0) socketPath = sp.stdout.trim();
      }
    }
    if (!failed) {
      // Gone, positively: has-session must now fail.
      var after = run(["-L", sock, "has-session"]);
      if (after.status === 0) failed = "its server was still running after kill-server";
    }
  } finally {
    if (failed) run(["-L", sock, "kill-server"]);
    removeStaleSocket(socketPath, sock, run);
  }
  if (failed) return { ok: false, reason: "the bundled tmux's private-socket check failed: " + failed };
  var real = fs.realpathSync(candidate.tmux);
  var fin = fs.statSync(real);
  return { ok: true, tmux: want.tmux, sha256: sum, size: fin.size, mtime: Math.floor(fin.mtimeMs / 1000), real: real };
}

/**
 * Remove the throwaway socket file, and only that: its name is this run's socket name, it is a socket, and no server
 * answers on it any more. Anything else stays where it is.
 */
function removeStaleSocket(socketPath, sock, run) {
  if (!socketPath || path.basename(socketPath) !== sock) return;
  try {
    if (!fs.lstatSync(socketPath).isSocket()) return;
    if (run(["-L", sock, "has-session"]).status === 0) return;
    fs.unlinkSync(socketPath);
  } catch (e) { /* already gone, or not ours to remove */ }
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
  verifyTmux: verifyTmux, writeReceipt: writeReceipt, readReceipt: readReceipt, receiptShapeOk: receiptShapeOk, receiptText: receiptText,
};
