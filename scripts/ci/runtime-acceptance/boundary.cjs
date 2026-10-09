"use strict";
// #1450 runtime acceptance: the hop's fail-fast process boundary. Preloaded (NODE_OPTIONS=--require) into every Node
// process of a hop leg — the old 2.1.12 updater, the new release's launcher and CLI, anything they spawn. A hop must
// install, verify and refresh, but never start a fleet or drive a real service manager. Any attempt fails AT ONCE and
// is appended to $AGEND_BOUNDARY_LOG, which the job gates on:
//   - a fleet start in any form: argv `fleet start` (a node entry, `agend`, the launcher), or `fleet start` in a shell
//     string — and this very process, when it was itself started as one;
//   - systemctl / launchctl by absolute path (by name they reach the PATH stubs, which log and fail).
// Old syntax: it also runs inside the old updater's Node 20.
var cp = require("child_process");
var fs = require("fs");
var path = require("path");
var LOG = process.env.AGEND_BOUNDARY_LOG;

var MANAGERS = /^(systemctl|launchctl)$/;
var SHELLS = /^(sh|bash|dash|zsh|ksh)$/;
var WRAPPERS = /^(exec|env|command|nohup|nice|time|builtin)$/;

/**
 * A shell string as the shell splits it: commands (split at ; & | ( ) and newlines), each a list of words with quotes
 * removed and `dyn` set when a word holds an expansion ($… or `…`) the shell would resolve. null: unterminated quote.
 */
function shellCommands(text) {
  var commands = [[]], word = null, q = null;
  var end = function () { if (word) commands[commands.length - 1].push(word); word = null; };
  var add = function (c, dyn) { if (!word) word = { text: "", dyn: false }; word.text += c; if (dyn) word.dyn = true; };
  for (var i = 0; i < text.length; i++) {
    var c = text.charAt(i);
    if (q === "'") { if (c === "'") q = null; else add(c, false); continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === "\\" && i + 1 < text.length) add(text.charAt(++i), false);
      else add(c, c === "$" || c === "`");
      continue;
    }
    if (c === "'" || c === '"') { q = c; if (!word) word = { text: "", dyn: false }; continue; }
    if (c === "\\" && i + 1 < text.length) { add(text.charAt(++i), false); continue; }
    if (/\s/.test(c) && c !== "\n") { end(); continue; }
    if (/[;&|()\n]/.test(c)) { end(); commands.push([]); continue; }
    add(c, c === "$" || c === "`");
  }
  if (q) return null;
  end();
  return commands.filter(function (cmd) { return cmd.length > 0; });
}

/** Why this shell string may not run in a hop — or null. Ambiguity counts as a violation. */
function shellViolation(text, depth) {
  if ((depth || 0) > 3) return "nested shell too deep: " + text;
  if (/(\$\(|`)/.test(text) && /(systemctl|launchctl)/.test(text)) return "a service manager inside a command substitution: " + text;
  var commands = shellCommands(text);
  if (commands === null) return "an unterminated quote: " + text;
  for (var c = 0; c < commands.length; c++) {
    var w = commands[c], i = 0;
    while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i].text) || (!w[i].dyn && WRAPPERS.test(w[i].text)) || (i > 0 && WRAPPERS.test(w[i - 1].text) && w[i].text.charAt(0) === "-"))) i++;
    if (i >= w.length) continue;
    var cmd = w[i];
    var base = path.basename(cmd.text);
    if (cmd.dyn) return "an expansion as a command word (" + cmd.text + "): " + text;
    if (base === "sudo") return "sudo in a hop: " + text;
    if (MANAGERS.test(base) && cmd.text.indexOf("/") >= 0) return "service manager by path: " + text;
    var rest = w.slice(i + 1).map(function (x) { return x.text; });
    if (base === "eval") { var inner = shellViolation(rest.join(" "), (depth || 0) + 1); if (inner) return inner; }
    if (SHELLS.test(base)) {
      var k = rest.indexOf("-c");
      if (k >= 0 && rest[k + 1] !== undefined) { var nested = shellViolation(rest[k + 1], (depth || 0) + 1); if (nested) return nested; }
    }
    for (var j = 0; j < rest.length - 1; j++) if (rest[j] === "fleet" && rest[j + 1] === "start") return "fleet start: " + text;
  }
  return null;
}

/** Why this program + argv may not run in a hop — or null. */
function violation(file, args) {
  var all = [String(file)].concat((args || []).map(String));
  var base = path.basename(String(file));
  for (var i = 0; i < all.length - 1; i++) if (all[i] === "fleet" && all[i + 1] === "start") return "fleet start: " + all.join(" ");
  if (MANAGERS.test(base) && String(file).indexOf("/") >= 0) return "service manager by absolute path: " + all.join(" ");
  if (base === "sudo") return "sudo in a hop: " + all.join(" ");
  if (SHELLS.test(base)) {
    var c = (args || []).indexOf("-c");
    if (c >= 0 && args[c + 1] !== undefined) return shellViolation(String(args[c + 1]), 0);
  }
  return null;
}
function stop(what) {
  if (LOG) fs.appendFileSync(LOG, process.pid + " " + what + "\n");
  var err = new Error("[runtime-acceptance boundary] " + what);
  throw err;
}

if (LOG) {
  // This process itself.
  var self = violation(process.argv[0], process.argv.slice(1));
  if (self) {
    fs.appendFileSync(LOG, process.pid + " (self) " + self + "\n");
    process.stderr.write("[runtime-acceptance boundary] refused: " + self + "\n");
    process.exit(70);
  }
  var originalSpawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function (options) {
    var v = violation(options.file, options.args.slice(1));
    if (v) stop(v);
    return originalSpawn.call(this, options);
  };
  ["spawnSync", "execFileSync"].forEach(function (name) {
    var original = cp[name];
    cp[name] = function (file, args) {
      var v = violation(file, Array.isArray(args) ? args : []);
      if (v) stop(v);
      return original.apply(this, arguments);
    };
  });
  var originalExecSync = cp.execSync;
  cp.execSync = function (command) {
    var v = violation("sh", ["-c", String(command)]);
    if (v) stop(v);
    return originalExecSync.apply(this, arguments);
  };
  // ESM `import { spawnSync } from "node:child_process"` (AgEnD's own code) sees these only once synced.
  var mod = require("module");
  if (mod.syncBuiltinESMExports) mod.syncBuiltinESMExports();
}

module.exports = { violation: violation, shellViolation: shellViolation, shellCommands: shellCommands };
