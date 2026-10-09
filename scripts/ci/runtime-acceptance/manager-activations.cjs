"use strict";
// #1450 runtime acceptance: which stubbed service-manager calls (one per line, as the hop's stubs log them) would have
// ACTIVATED something. A line's command is judged after any `sudo` (and its options) and after the manager's own
// options — `systemctl --no-pager --user restart x`, `sudo -n systemctl --user start x` — never by position alone.
// Usage: node manager-activations.cjs <log>   → prints each activating line; exits 1 if there is any.
var path = require("path");

var VERBS = ["restart", "start", "stop", "kill", "reload-or-restart", "try-restart", "kickstart", "bootstrap", "bootout", "load", "unload", "enable", "reenable", "isolate"];
/** Options whose value is the next word. */
var SUDO_VALUE = ["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D"];
var MANAGER_VALUE = ["-H", "--host", "-M", "--machine", "-p", "--property", "-t", "--type", "-s", "--signal", "--state", "-n", "--lines", "-o", "--output", "--root", "--job-mode", "--kill-whom"];

function activation(line) {
  var w = String(line).trim().split(/\s+/).filter(Boolean);
  while (w.length && path.basename(w[0]) === "sudo") {
    w.shift();
    while (w.length && w[0].charAt(0) === "-") { var f = w.shift(); if (SUDO_VALUE.indexOf(f) >= 0) w.shift(); }
  }
  if (!w.length || !/^(systemctl|launchctl)$/.test(path.basename(w[0]))) return null;
  for (var i = 1; i < w.length; i++) {
    if (w[i].charAt(0) === "-") { if (MANAGER_VALUE.indexOf(w[i]) >= 0) i++; continue; }
    return VERBS.indexOf(w[i]) >= 0 ? w[i] : null;
  }
  return null;
}

module.exports = { activation: activation };
if (require.main === module) {
  var lines = require("fs").readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
  var bad = lines.filter(function (l) { return activation(l) !== null; });
  bad.forEach(function (l) { console.log(l); });
  process.exit(bad.length ? 1 : 0);
}
