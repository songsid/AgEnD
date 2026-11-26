"use strict";
// M-3805: npm 12 runs a package's install scripts only when they are allowed (`allow-scripts`). A plain
// `npm install -g @songsid/agend` then skips launcher/postinstall.cjs, the bundled Node is never verified, and AgEnD
// refuses to start. Every install AgEnD runs, and every install command it prints, allows exactly this package.
// npm 8–11 accept the same flag and variable without a warning; on them scripts run anyway.
// Old syntax only (var, no ?. ??): this runs under whatever Node runs npm.

var PACKAGE = "@songsid/agend";
/** For an `npm install -g` argv. npm 12 does not pass a flag on to the programs `npm exec` starts: see ENV. */
var FLAG = "--allow-scripts=" + PACKAGE;
/** The variable form: it does reach the programs `npm exec` starts, so a release's own installer inherits it. */
var ENV = "npm_config_allow_scripts";

/**
 * The flag that allows `spec`'s scripts. npm 12 matches a registry package by its name, but a tarball or folder only by
 * its own absolute path (a relative one is read against the global prefix, not the current directory).
 */
function flagFor(spec) {
  var s = String(spec || "");
  if (/^file:/.test(s) || /^[.~\/]/.test(s) || /\.(?:tgz|tar\.gz|tar)$/.test(s)) {
    var file = s.replace(/^file:/, "").replace(/^~(?=\/|$)/, function () { return require("os").homedir(); });   // a quoted ~ the shell left
    return "--allow-scripts=" + require("path").resolve(file);
  }
  return FLAG;
}

/** The install command a person runs to repair or install `spec`. */
function installCommand(spec) {
  return "npm install -g " + FLAG + " " + (spec || PACKAGE);
}

/**
 * The names an `allow-scripts` value lists: comma-separated text (a variable, a flag), or the JSON list `npm config ls`
 * prints (`["a","b"]`).
 */
function names(value) {
  var text = String(value === undefined || value === null ? "" : value).trim();
  var list = [text];
  if (text.charAt(0) === "[") {
    try { var parsed = JSON.parse(text); if (Array.isArray(parsed)) list = parsed.map(String); } catch (e) { /* as written */ }
  }
  var out = [];
  list.forEach(function (item) { item.split(",").forEach(function (n) { n = n.trim(); if (n) out.push(n); }); });
  return out;
}

/** Does an `allow-scripts` value already allow every version of this package? */
function covers(value) {
  return names(value).some(function (name) { return name === PACKAGE || name === PACKAGE + "@*"; });
}

/** The comma-separated value that allows this package as well as everything `value` allows. */
function withPackage(value) {
  var kept = names(value);
  if (!covers(value)) kept.push(PACKAGE);
  return kept.join(",");
}

/**
 * Is a config value for `ignore-scripts` on? npm's own rule for a boolean given as text (nopt): a number is on when not
 * 0, "false" and "null" are off, any other text is on. Not set (undefined or null): off.
 */
function scriptsIgnored(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  var v = String(value).trim();
  if (v !== "" && !isNaN(Number(v))) return Number(v) !== 0;
  if (v === "") return false;
  return v !== "false" && v !== "null";
}

module.exports = { PACKAGE: PACKAGE, FLAG: FLAG, ENV: ENV, flagFor: flagFor, installCommand: installCommand, names: names, covers: covers, withPackage: withPackage, scriptsIgnored: scriptsIgnored };
