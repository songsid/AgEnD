"use strict";
// #1450 runtime acceptance: the hop's fail-fast process boundary. Preloaded (NODE_OPTIONS=--require) into every Node
// process of a hop leg — the old 2.1.12 updater, the new release's launcher and CLI, anything they spawn. A hop must
// install, verify and refresh, but never start a fleet or drive a real service manager. Any attempt fails AT ONCE and
// is appended to $AGEND_BOUNDARY_LOG, which the job gates on:
//   - a fleet start in any form: argv `fleet start` (a node entry, `agend`, the launcher), or `fleet start` in a shell
//     string — and this very process, when it was itself started as one;
//   - systemctl / launchctl by absolute path (by name they reach the PATH stubs, which log and fail).
// Old syntax: it also runs inside the old updater's Node (16, 18 or 20).
var cp = require("child_process");
var fs = require("fs");
var path = require("path");
var LOG = process.env.AGEND_BOUNDARY_LOG;
var PRELOAD = "--require=" + __filename;
/** Whether a NODE_OPTIONS value really preloads this file (a token, not a mention). */
function preloads(value) {
  var t = String(value || "").split(/\s+/);
  for (var i = 0; i < t.length; i++) {
    if (t[i] === PRELOAD) return true;
    if ((t[i] === "--require" || t[i] === "-r") && t[i + 1] === __filename) return true;
  }
  return false;
}
/**
 * The environment the hop started this process with, captured before any child exists: the only authority for the
 * startup hooks a child may run with and for which directory holds the hop's own manager stubs.
 */
function trusted(env) {
  var t = {
    nodeOptions: preloads(env.NODE_OPTIONS) ? String(env.NODE_OPTIONS) : (String(env.NODE_OPTIONS || "") + " " + PRELOAD).trim(),
    stubs: env.AGEND_BOUNDARY_STUBS ? path.resolve(env.AGEND_BOUNDARY_STUBS) : null,
    loader: {},
  };
  Object.keys(env).forEach(function (k) { if (/^(LD_|DYLD_)/.test(k)) t.loader[k] = env[k]; });
  return t;
}
var TRUSTED = trusted(process.env);

var MANAGERS = /^(systemctl|launchctl)$/;
var SHELLS = /^(sh|bash|dash|zsh|ksh)$/;
/** Words that start a compound and leave the NEXT word in command position. */
var KEYWORDS = /^(if|then|elif|else|fi|while|until|do|done|!|\{|\}|time|coproc)$/;
/** Commands whose words are not commands (a later `do` / `)` starts one). */
var NOT_COMMANDS = /^(for|case|select|function)$/;
/** Programs that run commands from their arguments in ways not modelled here: never in a hop. */
var RUNNERS = /^(sudo|doas|su|runuser|pkexec|chroot|nsenter|unshare|xargs|parallel|watch|source|\.|eval|exec)$/;
/** Shell builtins that change the environment or how later words resolve: unsupported in a hop. */
var ENV_CHANGERS = /^(export|unset|cd|pushd|popd|alias|unalias|hash|set|declare|typeset|readonly|local|enable|shopt|trap)$/;
/** Variables that change what a name resolves to, what a shell runs at start, or the boundary itself. */
var GUARDED_VARS = /^(PATH|BASH_ENV|ENV|NODE_OPTIONS|LD_[A-Z_]*|DYLD_[A-Z_]*|AGEND_BOUNDARY_[A-Z_]*)$/;
/**
 * Wrappers that run the rest of their words as a command (as shell words OR as programs, e.g. /usr/bin/env), with
 * the options each takes. An option not listed here is not guessed at: refused — that includes env's -i/- (clears the
 * environment, and with it this boundary), -S (a command line of its own), -C and -P (another directory or PATH).
 */
var WRAPPERS = {
  env: { flags: ["-0", "--null"], unset: ["-u", "--unset"], assignments: true },
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
 * removed and `dyn` set when a word holds an expansion. { redirect: true } when an unquoted < or > appears (a
 * redirection can take the command position: unsupported). null: unterminated quote.
 */
function shellCommands(text) {
  var commands = [[]], word = null, q = null, redirect = false;
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
    if (c === "<" || c === ">") { redirect = true; end(); continue; }
    if (/\s/.test(c) && c !== "\n") { end(); continue; }
    if (/[;&|()\n]/.test(c)) { end(); commands.push([]); continue; }
    add(c, c === "$" || c === "`");
  }
  if (q) return null;
  end();
  return { redirect: redirect, commands: commands.filter(function (cmd) { return cmd.length > 0; }) };
}

/** The script a shell runs: { script } for `-c`, else { refusal } (a file, stdin, startup files, interactive). */
function shellScript(args) {
  var hasC = false;
  for (var i = 0; i < args.length; i++) {
    var a = String(args[i]);
    if (a === "--") { i++; break; }
    if (a.slice(0, 2) === "--") {
      if (a === "--rcfile" || a === "--init-file" || a === "--login") return { refusal: "a shell with startup files (" + a + ")" };
      continue;
    }
    if ((a.charAt(0) === "-" || a.charAt(0) === "+") && a.length > 1) {
      if (/[^a-zA-Z]/.test(a.slice(1))) return { refusal: "a shell option it cannot read (" + a + ")" };
      if (/[ils]/.test(a.slice(1))) return { refusal: "an interactive, login or stdin shell (" + a + ")" };
      if (a.indexOf("c") > 0) hasC = true;
      if (a.indexOf("o") > 0) i++;                                    // -o <option>, also inside a cluster (-eo pipefail)
      continue;
    }
    break;
  }
  if (!hasC) return { refusal: "a shell that runs a script file or stdin" };
  return i < args.length ? { script: String(args[i]) } : { refusal: "a shell -c without its command" };
}

/** The file `name` resolves to on this PATH from `cwd`, as exec does: an empty entry is cwd, a relative one is under it. */
function onPath(name, pathVar, cwd) {
  var dirs = String(pathVar === undefined ? "" : pathVar).split(":");
  for (var i = 0; i < dirs.length; i++) {
    var f = path.resolve(cwd, dirs[i] || ".", name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch (e) { /* next */ }
  }
  return null;
}

/**
 * An environment the boundary can reason about: no shell startup files, and no startup hook the trusted hop did not
 * start with — NODE_OPTIONS is the trusted value, or dropped/blank (keepBoundary restores it); loader variables
 * (LD_*, DYLD_*) are the trusted ones or absent. (The stub directory is never read from a child's env: keepBoundary
 * hands every child the trusted one, and a shell assignment to AGEND_BOUNDARY_* is refused.)
 */
function envViolation(env) {
  if (env.BASH_ENV !== undefined || env.ENV !== undefined) return "a shell startup file in the environment (BASH_ENV/ENV)";
  if (env.NODE_OPTIONS !== undefined && env.NODE_OPTIONS !== "" && env.NODE_OPTIONS !== TRUSTED.nodeOptions) return "a NODE_OPTIONS the hop did not start with (" + env.NODE_OPTIONS + ")";
  var keys = Object.keys(env);
  for (var i = 0; i < keys.length; i++) {
    if (/^(LD_|DYLD_)/.test(keys[i]) && env[keys[i]] !== TRUSTED.loader[keys[i]]) return "a loader variable the hop did not start with (" + keys[i] + ")";
  }
  return null;
}

/**
 * Why this command — words with its effective environment — may not run in a hop, or null. One path for direct
 * spawns (shell: false) and for every command of a shell string (shell: true).
 */
function judgeWords(words, env, cwd, shell, depth, text) {
  if ((depth || 0) > 4) return "nested too deep: " + text;
  var i = 0;
  for (;;) {
    while (shell && i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text)) {
      if (GUARDED_VARS.test(words[i].text.slice(0, words[i].text.indexOf("=")))) return "an assignment to " + words[i].text.split("=")[0] + ": " + text;
      i++;
    }
    if (i >= words.length) return null;
    var word = words[i];
    if (shell && !word.dyn && KEYWORDS.test(word.text)) { i++; continue; }
    if (shell && !word.dyn && NOT_COMMANDS.test(word.text)) return null;
    var name = path.basename(word.text);
    var spec = !word.dyn && Object.prototype.hasOwnProperty.call(WRAPPERS, name) ? WRAPPERS[name] : null;
    if (!spec) break;
    i++;
    var positional = spec.positional || 0;
    while (i < words.length) {
      var a = words[i];
      if (a.dyn) return "an expansion in " + name + "'s words: " + text;
      if (a.text === "--") { i++; break; }
      if (spec.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a.text)) {
        if (GUARDED_VARS.test(a.text.slice(0, a.text.indexOf("=")))) return name + " setting " + a.text.split("=")[0] + ": " + text;
        i++;
        continue;
      }
      if (a.text.charAt(0) !== "-" || (a.text === "-" && (spec.flags || []).indexOf("-") < 0)) break;
      if ((spec.lookup || []).indexOf(a.text) >= 0) return null;                    // command -v: looks up, runs nothing
      if ((spec.flags || []).indexOf(a.text) >= 0) { i++; continue; }
      if ((spec.unset || []).indexOf(a.text) >= 0) {
        if (i + 1 >= words.length) return name + " " + a.text + " without its value: " + text;
        if (GUARDED_VARS.test(words[i + 1].text)) return name + " unsetting " + words[i + 1].text + ": " + text;
        i += 2;
        continue;
      }
      if ((spec.valued || []).indexOf(a.text) >= 0) { if (i + 1 >= words.length) return name + " " + a.text + " without its value: " + text; i += 2; continue; }
      var attached = (spec.valued || []).filter(function (v) { return /^-[a-zA-Z]$/.test(v) && a.text.indexOf(v) === 0 && a.text.length > 2; })[0]
        || (spec.valued || []).filter(function (v) { return v.slice(0, 2) === "--" && a.text.indexOf(v + "=") === 0; })[0];
      if (attached) { i++; continue; }
      return "an option of " + name + " it cannot judge (" + a.text + "): " + text;
    }
    while (positional > 0 && i < words.length) { if (words[i].dyn) return "an expansion as " + name + "'s argument: " + text; i++; positional--; }
  }
  if (i >= words.length) return null;
  var cmd = words[i];
  var base = path.basename(cmd.text);
  var rest = words.slice(i + 1).map(function (x) { return x.text; });
  if (cmd.dyn) return "an expansion as a command word (" + cmd.text + "): " + text;
  if (RUNNERS.test(base)) return base + " in a hop: " + text;
  if (shell && ENV_CHANGERS.test(base)) return base + " (changes the environment) in a hop: " + text;
  if (base === "find" && rest.some(function (x) { return /^-(exec|execdir|ok|okdir)$/.test(x); })) return "find -exec in a hop: " + text;
  for (var j = 0; j < rest.length - 1; j++) if (rest[j] === "fleet" && rest[j + 1] === "start") return "fleet start: " + text;
  if (MANAGERS.test(base)) {
    if (cmd.text.indexOf("/") >= 0) return "service manager by path: " + text;
    // A bare name: it must resolve, on THIS command's PATH from its cwd, to the stub in the hop's TRUSTED directory.
    var found = onPath(base, env.PATH, cwd);
    if (!TRUSTED.stubs || !found || found !== path.join(TRUSTED.stubs, base)) return base + " that does not resolve to the hop's stub (" + (found || "nothing") + "): " + text;
  }
  if (SHELLS.test(base)) {
    var sc = shellScript(rest);
    if (sc.refusal) return sc.refusal + ": " + text;
    var nested = shellViolation(sc.script, env, (depth || 0) + 1, cwd);
    if (nested) return nested;
  }
  return null;
}

/** Why this shell string, run with `env` from `cwd`, may not run in a hop — or null. */
function shellViolation(text, env, depth, cwd) {
  env = env || process.env;
  cwd = path.resolve(cwd || process.cwd());
  if (/(\$\(|`|<\(|>\()/.test(text)) return "a command or process substitution: " + text;
  var parsed = shellCommands(text);
  if (parsed === null) return "an unterminated quote: " + text;
  if (parsed.redirect) return "a redirection: " + text;
  for (var c = 0; c < parsed.commands.length; c++) {
    var v = judgeWords(parsed.commands[c], env, cwd, true, depth, text);
    if (v) return v;
  }
  return null;
}

/** Why this program + argv, run with `env` from `cwd`, may not run in a hop — or null. */
function violation(file, args, env, cwd) {
  env = env || process.env;
  cwd = path.resolve(cwd || process.cwd());
  var all = [String(file)].concat((args || []).map(String));
  var bad = envViolation(env);
  if (bad) return bad + ": " + all.join(" ");
  return judgeWords(all.map(function (t) { return { text: t, dyn: false }; }), env, cwd, false, 0, all.join(" "));
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
  // Every child keeps this boundary: its NODE_OPTIONS (judged trusted, dropped or blank) becomes the trusted one.
  var keepBoundary = function (env) {
    var e = {};
    Object.keys(env || process.env).forEach(function (k) { e[k] = (env || process.env)[k]; });
    e.NODE_OPTIONS = TRUSTED.nodeOptions;
    e.AGEND_BOUNDARY_LOG = LOG;
    if (TRUSTED.stubs) e.AGEND_BOUNDARY_STUBS = TRUSTED.stubs;
    return e;
  };
  var originalSpawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function (options) {
    var env = {};
    (options.envPairs || []).forEach(function (pair) { var i = pair.indexOf("="); env[pair.slice(0, i)] = pair.slice(i + 1); });
    var v = violation(options.file, options.args.slice(1), env, options.cwd);
    if (v) stop(v);
    var kept = keepBoundary(env);
    options.envPairs = Object.keys(kept).map(function (k) { return k + "=" + kept[k]; });
    return originalSpawn.call(this, options);
  };
  ["spawnSync", "execFileSync"].forEach(function (name) {
    var original = cp[name];
    cp[name] = function (file, args, options) {
      if (!Array.isArray(args)) { options = args; args = []; }
      options = options || {};
      var env = options.env || process.env;
      var v = options.shell ? violation("/bin/sh", ["-c", [file].concat(args).join(" ")], env, options.cwd) : violation(file, args, env, options.cwd);
      if (v) stop(v);
      var opts = {};
      Object.keys(options).forEach(function (k) { opts[k] = options[k]; });
      opts.env = keepBoundary(options.env);
      return original.call(this, file, args, opts);
    };
  });
  var originalExecSync = cp.execSync;
  cp.execSync = function (command, options) {
    options = options || {};
    var v = violation("/bin/sh", ["-c", String(command)], options.env || process.env, options.cwd);
    if (v) stop(v);
    var opts = {};
    Object.keys(options).forEach(function (k) { opts[k] = options[k]; });
    opts.env = keepBoundary(options.env);
    return originalExecSync.call(this, command, opts);
  };
  // ESM `import { spawnSync } from "node:child_process"` (AgEnD's own code) sees these only once synced.
  var mod = require("module");
  if (mod.syncBuiltinESMExports) mod.syncBuiltinESMExports();
}

module.exports = {
  violation: violation, shellViolation: shellViolation, shellCommands: shellCommands,
  /** Unit tests only (no boundary is installed without AGEND_BOUNDARY_LOG): judge as a hop started with `env`. */
  trustForTests: function (env) { if (LOG) throw new Error("the installed boundary keeps its trusted environment"); TRUSTED = trusted(env); },
};
