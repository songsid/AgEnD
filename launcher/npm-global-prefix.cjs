"use strict";
// M-3806: npm 11 and 12 redact UUID-like text in everything they print (@npmcli/redact). For a global prefix whose
// path contains a UUID, `npm prefix -g` and `npm root -g` print `***` in its place, and a caller then checks, locks or
// creates a folder that doesn't exist. `npm config get prefix` refuses outright ("The prefix option is protected"),
// on npm 10 too (callers then read `npm prefix -g`). npm has no option to print unredacted. A program npm starts still
// gets the real path, in `npm_config_global_prefix`. So when an answer is redacted, ask that way, and take the answer
// only if npm, redacting it, would print exactly what it printed (Fable #4526 F2). The ask runs from the filesystem
// root (`neutralCwd`): from inside a project npm puts its node_modules/.bin first on PATH, and a project's own `node`
// would answer (and run).
// Shared by the release's installer and the compiled CLI: keep syntax usable by old npm's Node.
var path = require("path");

/** npm's redaction marker (@npmcli/redact's REPLACE). No real path contains it. */
var MASK = "***";

/** `npm exec -c` runs this in a shell (sh or cmd.exe) with npm's environment; no quoting needed in either. */
var PRINT = "node -p process.env.npm_config_global_prefix";

/** The arguments (after the npm binary) that print npm's global prefix as a child sees it: never redacted. */
var ASK = ["exec", "-c", PRINT];

/** @npmcli/redact's UUID matcher: what npm 11/12 replace with `***`. */
var UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** What npm 11/12 would print for this text. */
function redact(text) {
  return String(text).replace(UUID, MASK);
}

/** Where the ask runs: the filesystem (drive) root, an ancestor of no project, so no project's .bin is on npm's PATH. */
function neutralCwd() {
  return path.parse(process.cwd()).root || path.sep;
}

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
 * The real answer for what npm printed as `seen` (redacted), or "": an absolute path that npm, redacting it, prints
 * exactly as `seen` — each `***` stood for a UUID, and nothing else differs.
 */
function confirmed(seen, real, platform) {
  var p = (platform || process.platform) === "win32" ? path.win32 : path.posix;
  return real && !masked(real) && p.isAbsolute(real) && redact(real) === seen ? real : "";
}

/**
 * The global prefix and root from npm's answers (`npm prefix -g`, `npm root -g`), unmasked. `ask()` runs npm with
 * `ASK` from `neutralCwd()` and returns its stdout; it is called only when an answer was redacted. Returns
 * { prefix, root } (both "" when there is no confirmed answer). A redacted root becomes npm's layout under the real
 * prefix, which must redact to what npm printed too.
 */
function resolve(prefixOut, rootOut, ask, platform) {
  var prefix = lastLine(prefixOut);
  var root = rootOut === undefined ? undefined : lastLine(rootOut);
  if (masked(prefix) || (root !== undefined && masked(root))) {
    var real = "";
    try { real = lastLine(ask()); } catch (e) { real = ""; }
    prefix = masked(prefix) ? confirmed(prefix, real, platform) : (prefix === real ? real : "");
    if (root !== undefined && masked(root)) root = prefix ? confirmed(root, rootOf(prefix, platform), platform) : "";
    if (root !== undefined && !root) prefix = "";
    if (!prefix && root !== undefined) root = "";
  }
  return root === undefined ? { prefix: prefix } : { prefix: prefix, root: root };
}

module.exports = { MASK: MASK, PRINT: PRINT, ASK: ASK, masked: masked, redact: redact, neutralCwd: neutralCwd, lastLine: lastLine, rootOf: rootOf, confirmed: confirmed, resolve: resolve };
