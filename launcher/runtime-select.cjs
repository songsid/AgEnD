"use strict";
// #1450 C2: one verified interpreter-selection protocol, shared by the launchers, the postinstall and the updater's
// probe of a target package. Same syntax constraints as runtime-platform.cjs. It never touches the network and does
// at most one bounded probe.
var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");
var platform = require("./runtime-platform.cjs");

var RECEIPT = ".agend-runtime.json";
var MIN_NAPI = 10;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
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
  var exists = fs.existsSync(dir);
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

/** Does the receipt the postinstall wrote still describe this exact binary? (cheap: no hashing at run time) */
function receiptMatches(receipt, candidate, pin) {
  if (!receipt || receipt.pinnedVersion !== pin.version) return false;
  var real = realpath(candidate.node);
  if (!real || real !== receipt.nodePath) return false;
  try {
    var st = fs.lstatSync(real);
    return st.isFile() && st.size === receipt.size && st.mtimeMs === receipt.mtimeMs;
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
    var receipt = readJson(path.join(pkg.dir, RECEIPT));
    // 2. The verified runtime of this release.
    if (candidate.exists && candidate.manifest && candidate.manifest.name === pin.name && candidate.manifest.version === pin.version && receiptMatches(receipt, candidate, pin)) {
      return { ok: true, node: realpath(candidate.node), source: "runtime", pkgDir: pkg.dir };   // the binary checked, never a path the receipt names
    }
    // 3. Supported platform, runtime missing/partial/corrupt: refuse — never a silent fallback. The one exception is
    //    an install where the runtime was skipped altogether (no directory, no receipt: --ignore-scripts or
    //    --omit=optional), which may use a qualifying system Node, with a warning.
    if (candidate.exists || receipt) {
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

module.exports = { RECEIPT: RECEIPT, MIN_NAPI: MIN_NAPI, selectRuntime: selectRuntime, packageDir: packageDir, pinnedRuntime: pinnedRuntime, runtimeCandidate: runtimeCandidate, probeNode: probeNode, qualifies: qualifies, receiptMatches: receiptMatches };
