"use strict";
// M-3806: npm 11 and 12 redact UUID-like text in everything they print (@npmcli/redact). For a global prefix whose
// path contains a UUID, `npm prefix -g` and `npm root -g` print `***` in its place, and a caller then checks, locks or
// creates a folder that doesn't exist. `npm config get prefix` refuses outright ("The prefix option is protected"),
// on npm 10 too. npm has no option to print unredacted. A program npm starts still gets the real path, in
// `npm_config_global_prefix`. So when an answer is redacted or missing, ask that way.
// Shared by the release's installer and the compiled CLI: keep syntax usable by old npm's Node.
var path = require("path");

/** npm's redaction marker (@npmcli/redact's REPLACE). No real path contains it. */
var MASK = "***";

/** `npm exec -c` runs this in a shell (sh or cmd.exe) with npm's environment; no quoting needed in either. */
var PRINT = "node -p process.env.npm_config_global_prefix";

/** The arguments (after the npm binary) that print npm's global prefix as a child sees it: never redacted. */
var ASK = ["exec", "-c", PRINT];

/** True when npm redacted part of this answer. */
function masked(text) {
  return typeof text === "string" && text.indexOf(MASK) !== -1;
}

/** The last non-empty line of npm's output, trimmed ("" for none). */
function lastLine(text) {
  var lines = String(text == null ? "" : text).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

/** npm's global node_modules for a prefix, as npm lays it out: `<prefix>/node_modules` on Windows, else `<prefix>/lib/node_modules`. */
function rootOf(prefix, platform) {
  var p = (platform || process.platform) === "win32" ? path.win32 : path.posix;
  return (platform || process.platform) === "win32" ? p.join(prefix, "node_modules") : p.join(prefix, "lib", "node_modules");
}

/**
 * The global prefix and root from npm's answers, unmasked. `ask()` runs npm with `ASK` and returns its stdout; it is
 * called only when the prefix is missing ("" for a refused `npm config get prefix`) or an answer was redacted.
 * Returns { prefix, root } (either "" when npm gave no usable answer). A root is taken from npm when it is there and
 * not redacted; otherwise it is npm's layout under the real prefix.
 */
function resolve(prefixOut, rootOut, ask, platform) {
  var prefix = lastLine(prefixOut);
  var root = rootOut === undefined ? undefined : lastLine(rootOut);
  if (!prefix || masked(prefix) || (root !== undefined && (!root || masked(root)))) {
    var real = "";
    try { real = lastLine(ask()); } catch (e) { real = ""; }
    prefix = real && !masked(real) && real !== "undefined" ? real : "";
    if (root !== undefined && (!root || masked(root))) root = prefix ? rootOf(prefix, platform) : "";
  }
  return root === undefined ? { prefix: prefix } : { prefix: prefix, root: root };
}

module.exports = { MASK: MASK, PRINT: PRINT, ASK: ASK, masked: masked, lastLine: lastLine, rootOf: rootOf, resolve: resolve };
