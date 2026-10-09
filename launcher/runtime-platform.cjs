"use strict";
// #1450 C3: the one answer to "can this host run AgEnD's bundled Node?", shared by preinstall, postinstall and the
// launcher. CommonJS that very old Nodes still parse (var, function, no optional chaining): it may run on the host's
// own old Node, before anything decides which Node AgEnD itself will use.
var os = require("os");

/** The runtime packages AgEnD ships: official glibc Linux builds and macOS builds (no musl, #1450). */
var SHIPPED = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
/** The official Node 22 builds need glibc ≥ 2.28 on Linux and macOS 11 (Darwin kernel 20) or newer. */
var MIN_GLIBC = [2, 28];
var MIN_DARWIN_KERNEL = 20;

function numbers(text) {
  return String(text).split(".").map(function (part) { return parseInt(part, 10); });
}

function atLeast(have, want) {
  for (var i = 0; i < want.length; i++) {
    var h = have[i] || 0;
    if (h > want[i]) return true;
    if (h < want[i]) return false;
  }
  return true;
}

/** glibc's version when this Node runs on glibc; null on musl or when it cannot be told. */
function glibcVersion(report) {
  try {
    var r = report || (process.report && process.report.getReport && process.report.getReport());
    var v = r && r.header && r.header.glibcVersionRuntime;
    return typeof v === "string" && v ? v : null;
  } catch (e) {
    return null;
  }
}

/**
 * The host as the runtime packages see it. `probe` is injectable for tests:
 * { platform, arch, glibc (string|null), darwinRelease (string|null) }.
 */
function hostPlatform(probe) {
  var p = probe || {};
  var platform = p.platform || process.platform;
  var arch = p.arch || process.arch;
  return {
    platform: platform,
    arch: arch,
    id: platform + "-" + arch,
    glibc: "glibc" in p ? p.glibc : (platform === "linux" ? glibcVersion() : null),
    darwinRelease: "darwinRelease" in p ? p.darwinRelease : (platform === "darwin" ? os.release() : null),
  };
}

/** Whether a bundled runtime can run here, and why not. */
function runtimeSupport(host) {
  if (SHIPPED.indexOf(host.id) < 0) return { supported: false, reason: "no AgEnD runtime is published for " + host.id };
  if (host.platform === "linux") {
    if (!host.glibc) return { supported: false, reason: "this Linux is not glibc-based (musl?), and the bundled Node needs glibc" };
    if (!atLeast(numbers(host.glibc), MIN_GLIBC)) return { supported: false, reason: "glibc " + host.glibc + " is older than the 2.28 the bundled Node needs" };
  }
  if (host.platform === "darwin") {
    var kernel = numbers(host.darwinRelease || "0")[0];
    if (!(kernel >= MIN_DARWIN_KERNEL)) return { supported: false, reason: "macOS older than 11 (Darwin " + host.darwinRelease + ") cannot run the bundled Node" };
  }
  return { supported: true, reason: null };
}

/**
 * Does a Node version satisfy an `engines.node` range? Only the forms AgEnD uses: alternatives joined by `||`, each
 * `^x.y.z` (same major, at least x.y.z) or `>=x[.y[.z]]`. The version must be a full stable `x.y.z`: as in npm's
 * semver, a prerelease (`24.0.0-nightly…`, `22.14.0-rc.1`) satisfies no stable alternative.
 */
function satisfiesEngines(version, range) {
  var full = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!full) return false;
  var v = [+full[1], +full[2], +full[3]];
  return String(range).split("||").some(function (alt) {
    var a = alt.trim();
    var m;
    if ((m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(a))) return v[0] === +m[1] && atLeast(v, [+m[1], +m[2], +m[3]]);
    if ((m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(a))) return atLeast(v, [+m[1], +(m[2] || 0), +(m[3] || 0)]);
    return false;
  });
}

module.exports = { SHIPPED: SHIPPED, hostPlatform: hostPlatform, runtimeSupport: runtimeSupport, satisfiesEngines: satisfiesEngines, glibcVersion: glibcVersion };
