"use strict";
// #1450 C2: one verified interpreter-selection protocol, shared by the launchers, the postinstall and the updater's
// probe of a target package. Same syntax constraints as runtime-platform.cjs. It never touches the network and does
// at most one bounded probe.
var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");
var platform = require("./runtime-platform.cjs");

var RECEIPT = ".agend-runtime.json";
var KEY = ".agend-runtime.key";
var MIN_NAPI = 10;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}

/** Physically absent (lstat: ENOENT/ENOTDIR)? A dangling symlink, or a path that cannot be inspected, is PRESENT. */
function absent(file) {
  try { fs.lstatSync(file); return false; } catch (e) { return e.code === "ENOENT" || e.code === "ENOTDIR"; }
}

/**
 * THE RECEIPT CONTRACT (#1460 review), shared word for word with the sh bins (launcher/agend), which check it before
 * they exec anything: the receipt is exactly `JSON.stringify(receipt, null, 2) + "\n"` of these keys in this order —
 * strings plain (no `"`, `\` or control characters), numbers non-negative integers, `libc` "glibc" or null. Anything
 * else — unreadable, not JSON, valid JSON in another shape or layout — is "invalid". `mtime` is whole seconds (what
 * `stat` gives a shell, and what survives a copy that preserves timestamps).
 */
var RECEIPT_KEYS = ["receipt", "pinnedVersion", "nodePath", "size", "mtime", "sha256", "napi", "platform", "arch", "libc", "verifiedAt"];
var PLAIN = /^[^"\\\u0000-\u001f]*$/;
function receiptText(r) {
  var ordered = {};
  RECEIPT_KEYS.forEach(function (k) { ordered[k] = r[k]; });
  return JSON.stringify(ordered, null, 2) + "\n";
}
function receiptShapeOk(r) {
  var int = function (n) { return typeof n === "number" && Number.isSafeInteger(n) && n >= 0; };
  var str = function (s) { return typeof s === "string" && PLAIN.test(s); };
  return r.receipt === 2 && str(r.pinnedVersion) && /^\d+\.\d+\.\d+(-agend\.\d+)?$/.test(r.pinnedVersion)
    && str(r.nodePath) && r.nodePath.charAt(0) === "/" && int(r.size) && int(r.mtime) && typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256)
    && int(r.napi) && str(r.platform) && r.platform !== "" && str(r.arch) && r.arch !== "" && (r.libc === "glibc" || r.libc === null) && str(r.verifiedAt) && r.verifiedAt !== "";
}

/** The receipt, by state: "absent" only when no file is there; "valid" only in the contract's exact form; else "invalid". */
function readReceipt(file) {
  if (absent(file)) return { state: "absent" };
  var text, value;
  try { text = fs.readFileSync(file, "utf8"); value = JSON.parse(text); } catch (e) { return { state: "invalid" }; }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== RECEIPT_KEYS.join(",")) return { state: "invalid" };
  return receiptShapeOk(value) && text === receiptText(value) ? { state: "valid", value: value } : { state: "invalid" };
}

function realpath(file) {
  try { return fs.realpathSync(file); } catch (e) { return null; }
}

/** The package that contains this launcher: realpath(launcher/..), and it must be @songsid/agend. */
function packageDir(launcherDir) {
  var dir = realpath(path.join(launcherDir, ".."));
  var manifest = dir && readJson(path.join(dir, "package.json"));
  return manifest && manifest.name === "@songsid/agend" ? { dir: dir, manifest: manifest } : null;
}

/** This release's runtime package name and exact pinned version, or null when none is pinned yet. */
function pinnedRuntime(manifest, host) {
  var name = "@songsid/agend-node-" + host.id;
  var version = manifest.optionalDependencies && manifest.optionalDependencies[name];
  return typeof version === "string" && /^\d+\.\d+\.\d+(-agend\.\d+)?$/.test(version) ? { name: name, version: version } : null;
}

/** The candidate is exactly <pkgDir>/node_modules/<name> — never require.resolve, which can walk up to an ancestor. */
function runtimeCandidate(pkgDir, pin) {
  var dir = path.join(pkgDir, "node_modules", pin.name);
  var exists = !absent(dir);
  var manifest = exists ? readJson(path.join(dir, "package.json")) : null;
  return { dir: dir, exists: exists, manifest: manifest, node: path.join(dir, "bin", "node") };
}

/** Run `node` once, bounded, to read its version and N-API level. */
function probeNode(node, timeoutMs) {
  try {
    var r = childProcess.spawnSync(node, ["-p", "JSON.stringify({ node: process.versions.node, napi: Number(process.versions.napi) })"], { encoding: "utf8", timeout: timeoutMs || 1000, stdio: ["ignore", "pipe", "ignore"] });
    if (r.status !== 0) return null;
    var v = JSON.parse(String(r.stdout).trim());
    return typeof v.node === "string" && typeof v.napi === "number" ? v : null;
  } catch (e) {
    return null;
  }
}

function qualifies(versions, engines) {
  return versions && platform.satisfiesEngines(versions.node, engines) && Number(versions.napi) >= MIN_NAPI;
}

/** POSIX `cksum`: CRC-32 (0x04C11DB7, MSB first), then the byte length (LSB first), complemented; "<crc> <length>". */
var CRC_TABLE = (function () {
  var t = [];
  for (var i = 0; i < 256; i++) { var c = i << 24; for (var j = 0; j < 8; j++) c = c & 0x80000000 ? (c << 1) ^ 0x04C11DB7 : c << 1; t.push(c >>> 0); }
  return t;
})();
function cksum(buf) {
  var crc = 0;
  var step = function (b) { crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0; };
  for (var i = 0; i < buf.length; i++) step(buf[i]);
  for (var n = buf.length; n > 0; n = Math.floor(n / 256)) step(n & 0xff);
  return ((~crc) >>> 0) + " " + buf.length;
}

/**
 * THE ADMISSION KEY (#1460 r3), the one thing the sh bins check before they exec the bundled Node — byte for byte, by
 * rebuilding it from their own measurements (launcher/agend) — and that this selection requires as well. One fact per
 * line: the host (os, cpu, glibc version / Darwin kernel), the Node's realpath, size and mtime (whole seconds), and the
 * POSIX `cksum` of both manifests and of the receipt. The postinstall writes it LAST, after everything it binds is
 * final and verified; any later change to a manifest or the receipt changes its CRC, any change to the binary its
 * size or mtime — and then neither side runs it. null when a bound file cannot be read.
 */
function runtimeKey(pkgDir, candidate, host) {
  try {
    // Bytes, never decoded text: a path is whatever bytes the filesystem has (#1460 r4), exactly as the shell prints it.
    var real = fs.realpathSync(candidate.node, { encoding: "buffer" });
    var st = fs.lstatSync(real);
    if (!st.isFile()) return null;
    var hostlib = host.platform === "linux" ? (host.glibc ? "glibc " + host.glibc : "none") : host.platform === "darwin" ? String(host.darwinRelease) : "none";
    var line = function (text) { return Buffer.from(text + "\n", "utf8"); };
    return Buffer.concat([
      line("agend-runtime-key 1"),
      line("os " + host.platform),
      line("cpu " + host.arch),
      line("host " + hostlib),
      Buffer.from("node ", "utf8"), real, Buffer.from("\n", "utf8"),
      line("size " + st.size),
      line("mtime " + Math.floor(st.mtimeMs / 1000)),
      line("package " + cksum(fs.readFileSync(path.join(pkgDir, "package.json")))),
      line("runtime " + cksum(fs.readFileSync(path.join(candidate.dir, "package.json")))),
      line("receipt " + cksum(fs.readFileSync(path.join(pkgDir, RECEIPT)))),
    ]);
  } catch (e) {
    return null;
  }
}
function keyMatches(pkgDir, candidate, host) {
  var want = runtimeKey(pkgDir, candidate, host);
  var have;
  try { have = fs.readFileSync(path.join(pkgDir, KEY)); } catch (e) { return false; }
  return want !== null && Buffer.compare(have, want) === 0;
}

/** Does the receipt the postinstall wrote still describe this exact binary? (cheap: no hashing at run time) */
function receiptMatches(receipt, candidate, pin) {
  if (!receipt || receipt.pinnedVersion !== pin.version) return false;
  var real = realpath(candidate.node);
  if (!real || real !== receipt.nodePath) return false;
  try {
    var st = fs.lstatSync(real);
    return st.isFile() && st.size === receipt.size && Math.floor(st.mtimeMs / 1000) === receipt.mtime;
  } catch (e) {
    return false;
  }
}

/**
 * Choose the Node that runs AgEnD. Result:
 *   { ok: true, node, source: "override"|"runtime"|"system", pkgDir, warning? }
 *   { ok: false, reason, recovery }
 * deps (injectable for tests): env, execPath, versions ({node, napi}), host (hostPlatform() result), probe(node).
 */
function selectRuntime(launcherDir, deps) {
  var d = deps || {};
  var env = d.env || process.env;
  var execPath = d.execPath || process.execPath;
  var running = d.versions || { node: process.versions.node, napi: Number(process.versions.napi) };
  var host = d.host || platform.hostPlatform();
  var probe = d.probe || probeNode;
  var pkg = packageDir(launcherDir);
  if (!pkg) return { ok: false, reason: "this launcher is not inside an @songsid/agend package", recovery: "npm install -g @songsid/agend" };
  var engines = (pkg.manifest.engines && pkg.manifest.engines.node) || ">=22.14.0";
  var recovery = "npm install -g @songsid/agend@" + pkg.manifest.version;

  // 1. An explicit override: absolute, executable, and passes the probe — or a clear failure, never a fallback.
  if (env.AGEND_NODE) {
    var override = env.AGEND_NODE;
    if (!path.isAbsolute(override)) return { ok: false, reason: "AGEND_NODE must be an absolute path (got " + JSON.stringify(override) + ")", recovery: "unset AGEND_NODE, or point it at a Node " + engines };
    try { fs.accessSync(override, fs.constants.X_OK); } catch (e) { return { ok: false, reason: "AGEND_NODE (" + override + ") is not an executable file", recovery: "unset AGEND_NODE, or point it at a Node " + engines }; }
    var seen = probe(override, 1000);
    if (!qualifies(seen, engines)) return { ok: false, reason: "AGEND_NODE (" + override + ") is Node " + (seen ? seen.node + " with N-API " + seen.napi : "that did not answer") + "; AgEnD needs " + engines + " with N-API " + MIN_NAPI, recovery: "unset AGEND_NODE, or point it at a Node " + engines };
    return { ok: true, node: realpath(override) || override, source: "override", pkgDir: pkg.dir };
  }

  var pin = pinnedRuntime(pkg.manifest, host);
  var support = platform.runtimeSupport(host);
  if (pin && support.supported) {
    var candidate = runtimeCandidate(pkg.dir, pin);
    var receipt = readReceipt(path.join(pkg.dir, RECEIPT));
    // 2. The verified runtime of this release — and its admission key, exactly what the sh bins check (see above).
    if (candidate.exists && candidate.manifest && candidate.manifest.name === pin.name && candidate.manifest.version === pin.version && receipt.state === "valid" && receiptMatches(receipt.value, candidate, pin) && keyMatches(pkg.dir, candidate, host)) {
      return { ok: true, node: realpath(candidate.node), source: "runtime", pkgDir: pkg.dir };   // the binary checked, never a path the receipt names
    }
    // 3. Supported platform, runtime missing/partial/corrupt: refuse — never a silent fallback. The one exception is
    //    an install where the runtime was skipped altogether — PHYSICALLY nothing there, no directory (not even a
    //    dangling link) and no receipt file (--ignore-scripts or --omit=optional) — which may use a qualifying system
    //    Node, with a warning.
    if (candidate.exists || receipt.state !== "absent" || !absent(path.join(pkg.dir, KEY))) {
      return { ok: false, reason: "the bundled Node (" + pin.name + "@" + pin.version + ") is missing, incomplete or changed since it was verified", recovery: recovery };
    }
    if (qualifies(running, engines)) {
      return { ok: true, node: realpath(execPath) || execPath, source: "system", pkgDir: pkg.dir, warning: "the bundled Node was not installed (--ignore-scripts or --omit=optional?); using this Node " + running.node };
    }
    return { ok: false, reason: "the bundled Node was not installed, and this Node " + running.node + " is older than AgEnD needs (" + engines + ")", recovery: recovery };
  }

  // 4. No runtime for this host (unsupported, or none pinned in this release): the running Node, if it qualifies.
  if (qualifies(running, engines)) return { ok: true, node: realpath(execPath) || execPath, source: "system", pkgDir: pkg.dir };
  return { ok: false, reason: (pin ? support.reason : "this release bundles no Node") + "; this Node " + running.node + " is older than AgEnD needs (" + engines + ")", recovery: "install Node " + engines + ", then " + recovery };
}

module.exports = { KEY: KEY, cksum: cksum, runtimeKey: runtimeKey, keyMatches: keyMatches, RECEIPT: RECEIPT, MIN_NAPI: MIN_NAPI, selectRuntime: selectRuntime, packageDir: packageDir, pinnedRuntime: pinnedRuntime, runtimeCandidate: runtimeCandidate, probeNode: probeNode, qualifies: qualifies, receiptMatches: receiptMatches, readReceipt: readReceipt, absent: absent, receiptText: receiptText, RECEIPT_KEYS: RECEIPT_KEYS, PLAIN: PLAIN };
