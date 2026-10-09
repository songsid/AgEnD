"use strict";
// #1450 C2: the launcher body shared by the `agend` and `agend-agent` bins. It picks the interpreter BEFORE any module
// of the CLI's import graph loads, never downloads, and never changes PATH. Syntax old Nodes still parse.
var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");
var select = require("./runtime-select.cjs");

var FORWARDED = ["SIGTERM", "SIGHUP", "SIGUSR1", "SIGUSR2"];

function realpath(file) {
  try { return fs.realpathSync(file); } catch (e) { return null; }
}

/** `entryRelative`: the CLI inside the package, e.g. "dist/cli.js". */
module.exports = function launch(entryRelative, launcherDir) {
  var args = process.argv.slice(2);
  var chosen = select.selectRuntime(launcherDir);

  // For the updater (C4): which Node and package would this install run on? Printed, nothing started.
  if (args[0] === "--agend-select-json") {
    process.stdout.write(JSON.stringify(chosen.ok
      ? { node: chosen.node, source: chosen.source, pkgDir: chosen.pkgDir, entry: path.join(chosen.pkgDir, entryRelative), warning: chosen.warning || null }
      : { error: chosen.reason, recovery: chosen.recovery }) + "\n");
    process.exit(chosen.ok ? 0 : 1);
  }
  if (!chosen.ok) {
    process.stderr.write("\n  AgEnD cannot start: " + chosen.reason + ".\n  To repair: " + chosen.recovery + "\n\n");
    process.exit(1);
  }
  if (chosen.warning) process.stderr.write("  ⚠ AgEnD: " + chosen.warning + "\n");

  var entry = path.join(chosen.pkgDir, entryRelative);
  if (chosen.node === realpath(process.execPath)) {
    require("./run-in-process.cjs")(entry);
    return;
  }

  var env = {};
  Object.keys(process.env).forEach(function (key) { env[key] = process.env[key]; });
  env.AGEND_NODE_SELECTED = "1";
  // The handlers are in place BEFORE the spawn: a signal delivered between spawn() and their registration would kill
  // this launcher by default and orphan the CLI. (JS handlers cannot run during this synchronous block, so `child` is
  // always set by the time one does.)
  var child = null;
  FORWARDED.forEach(function (signal) {
    process.on(signal, function () { try { child.kill(signal); } catch (e) { /* gone */ } });
  });
  // A terminal's Ctrl+C reaches the whole process group, the child included: the child decides, this waits.
  process.on("SIGINT", function () {});
  child = childProcess.spawn(chosen.node, [entry].concat(args), { stdio: "inherit", env: env });
  child.on("error", function (err) {
    process.stderr.write("\n  AgEnD cannot start " + chosen.node + ": " + err.message + "\n\n");
    process.exit(1);
  });
  child.on("exit", function (code, signal) {
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
};
