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
/** Words that start a compound and leave the NEXT word in command position. */
var KEYWORDS = /^(if|then|elif|else|fi|while|until|do|done|!|\{|\}|time|coproc)$/;
/** Commands whose words are not commands (a later `do` / `)` starts one). */
var NOT_COMMANDS = /^(for|case|select|function)$/;
/** Programs that run commands from their arguments in ways not modelled here: never in a hop. */
var RUNNERS = /^(sudo|doas|su|runuser|pkexec|chroot|nsenter|unshare|xargs|parallel|watch|source|\.)$/;
/**
 * Wrappers that run the rest of their words as a command, with the options each takes. An option not listed here is
 * not guessed at: the string is refused. `split`: an option whose value is itself a command line (env -S).
 */
var WRAPPERS = {
  exec: { flags: ["-c", "-l"], valued: ["-a"] },
  env: { flags: ["-i", "-0", "--ignore-environment", "--null", "-"], valued: ["-u", "--unset", "-C", "--chdir", "-P"], split: ["-S", "--split-string"], assignments: true },
  command: { flags: ["-p"], lookup: ["-v", "-V"] },
  nohup: {},
  builtin: {},
  setsid: { flags: ["-w", "-f", "-c", "--wait", "--fork", "--ctty"] },
  nice: { valued: ["-n", "--adjustment"] },
  timeout: { flags: ["--preserve-status", "--foreground", "-v", "--verbose"], valued: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
  stdbuf: { valued: ["-i", "-o", "-e", "--input", "--output", "--error"] },
};

/**
 * A shell string as the shell splits it: commands (split at ; & | ( ) and newlines), each a list of words with quotes
 * removed and `dyn` set when a word holds an expansion the shell would resolve. null: unterminated quote.
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

/** The script a shell runs: { script } for `-c`, else { refusal } (a file, stdin, or options it cannot read). */
function shellScript(args) {
  var hasC = false;
  for (var i = 0; i < args.length; i++) {
    var a = String(args[i]);
    if (a === "--") { i++; break; }
    if (a.slice(0, 2) === "--") { if (a === "--rcfile" || a === "--init-file") i++; continue; }
    if ((a.charAt(0) === "-" || a.charAt(0) === "+") && a.length > 1) {
      if (/[^a-zA-Z]/.test(a.slice(1))) return { refusal: "a shell option it cannot read (" + a + ")" };
      if (a.indexOf("c") > 0) hasC = true;
      if (a.indexOf("o") > 0) i++;                                    // -o <option>, also inside a cluster (-eo pipefail)
      continue;
    }
    break;
  }
  if (!hasC) return { refusal: "a shell that runs a script file or stdin" };
  return i < args.length ? { script: String(args[i]) } : { refusal: "a shell -c without its command" };
}

/** Why this shell string may not run in a hop — or null. Anything it cannot model counts as a violation. */
function shellViolation(text, depth) {
  if ((depth || 0) > 4) return "nested shell too deep: " + text;
  if (/(\$\(|`|<\(|>\()/.test(text)) return "a command or process substitution: " + text;
  var commands = shellCommands(text);
  if (commands === null) return "an unterminated quote: " + text;
  for (var c = 0; c < commands.length; c++) {
    var w = commands[c], i = 0;
    for (;;) {
      while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i].text)) i++;          // assignments
      if (i >= w.length) break;
      var word = w[i];
      if (!word.dyn && KEYWORDS.test(word.text)) { i++; continue; }
      if (!word.dyn && NOT_COMMANDS.test(word.text)) { i = w.length; break; }
      var spec = !word.dyn && Object.prototype.hasOwnProperty.call(WRAPPERS, word.text) ? WRAPPERS[word.text] : null;
      if (!spec) break;
      i++;
      var positional = spec.positional || 0;
      while (i < w.length) {
        var a = w[i];
        if (a.dyn) return "an expansion in " + word.text + "'s options: " + text;
        if (a.text === "--") { i++; break; }
        if (spec.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a.text)) { i++; continue; }
        if (a.text.charAt(0) !== "-" || a.text === "-" && (spec.flags || []).indexOf("-") < 0) break;
        if ((spec.lookup || []).indexOf(a.text) >= 0) { i = w.length; break; }       // command -v: looks up, runs nothing
        if ((spec.flags || []).indexOf(a.text) >= 0) { i++; continue; }
        if ((spec.valued || []).indexOf(a.text) >= 0) { if (i + 1 >= w.length) return word.text + " " + a.text + " without its value: " + text; i += 2; continue; }
        if ((spec.split || []).indexOf(a.text) >= 0) {
          if (i + 1 >= w.length) return word.text + " " + a.text + " without its value: " + text;
          var inner = shellViolation(w[i + 1].text, (depth || 0) + 1);
          if (inner) return inner;
          i += 2;
          continue;
        }
        var attached = (spec.valued || []).filter(function (v) { return /^-[a-zA-Z]$/.test(v) && a.text.indexOf(v) === 0 && a.text.length > 2; })[0]
          || (spec.valued || []).filter(function (v) { return v.slice(0, 2) === "--" && a.text.indexOf(v + "=") === 0; })[0];
        if (attached) { i++; continue; }
        return "an option of " + word.text + " it cannot judge (" + a.text + "): " + text;
      }
      while (positional > 0 && i < w.length) { if (w[i].dyn) return "an expansion as " + word.text + "'s argument: " + text; i++; positional--; }
    }
    if (i >= w.length) continue;
    var cmd = w[i];
    var base = path.basename(cmd.text);
    if (cmd.dyn) return "an expansion as a command word (" + cmd.text + "): " + text;
    if (RUNNERS.test(base)) return base + " in a hop: " + text;
    if (MANAGERS.test(base) && cmd.text.indexOf("/") >= 0) return "service manager by path: " + text;
    var rest = w.slice(i + 1).map(function (x) { return x.text; });
    if (base === "find" && rest.some(function (x) { return /^-(exec|execdir|ok|okdir)$/.test(x); })) return "find -exec in a hop: " + text;
    if (base === "eval") { var evald = shellViolation(rest.join(" "), (depth || 0) + 1); if (evald) return evald; }
    if (SHELLS.test(base)) {
      var sc = shellScript(rest);
      if (sc.refusal) return sc.refusal + ": " + text;
      var nested = shellViolation(sc.script, (depth || 0) + 1);
      if (nested) return nested;
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
  if (RUNNERS.test(base)) return base + " in a hop: " + all.join(" ");
  if (SHELLS.test(base)) {
    var sc = shellScript(args || []);
    if (sc.refusal) return sc.refusal + ": " + all.join(" ");
    return shellViolation(sc.script, 0);
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
