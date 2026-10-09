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

/** A service manager reached by absolute path, as a program or anywhere inside a shell string. */
var MANAGER_BY_PATH = /(^|[\s;&|(`"'=])\/[^\s;&|()`"']*\/(systemctl|launchctl)(?=$|[\s;&|)`"'])/;
function violation(file, args) {
  var all = [String(file)].concat((args || []).map(String));
  for (var i = 0; i < all.length - 1; i++) if (all[i] === "fleet" && all[i + 1] === "start") return "fleet start: " + all.join(" ");
  if (/\bfleet\s+start\b/.test(all.join(" "))) return "fleet start in a shell string: " + all.join(" ");
  if (/^(systemctl|launchctl)$/.test(path.basename(String(file))) && path.isAbsolute(String(file))) return "service manager by absolute path: " + all.join(" ");
  for (var j = 0; j < all.length; j++) if (MANAGER_BY_PATH.test(all[j])) return "service manager by absolute path in a command string: " + all.join(" ");
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
