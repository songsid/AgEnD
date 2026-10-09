"use strict";
// #1450 runtime acceptance: judge the hop's stubbed service-manager calls. The stubs log each call as one record,
// `<name>( <len>:<bytes>)*\n` — every argument length-prefixed, so its boundaries survive (an `echo "$*"` log cannot
// tell `-p 'a b'` from `-p a b`). The judgement FAILS CLOSED: a call is allowed only when it is plainly read-only.
//   - sudo: never (a hop on a writable prefix has no reason to);
//   - systemctl / launchctl: every option must be known (with its value, if it takes one), and the verb must be on the
//     read-only allowlist. An unknown option, a missing verb, or any other verb is an activation.
// Usage: node manager-activations.cjs <log>   → prints each refused call; exits 1 if there is any.
var fs = require("fs");

var SYSTEMCTL_FLAGS = ["--user", "--system", "--no-pager", "--no-legend", "--no-ask-password", "--quiet", "-q", "--value", "--all", "-a", "--full", "-l", "--plain"];
var SYSTEMCTL_VALUED = ["-p", "--property", "-t", "--type", "--state", "-o", "--output", "-n", "--lines"];
var SYSTEMCTL_READS = ["is-active", "is-enabled", "is-failed", "show", "status", "cat", "list-units", "list-unit-files", "list-dependencies", "show-environment", "daemon-reload", "reset-failed"];
var LAUNCHCTL_READS = ["print", "print-disabled", "getenv", "list", "managername", "manageruid", "managerpid", "version", "help"];

/** The records of a stub log: [{ name, args }]; null when the log is not well-formed (ambiguity: refused). */
function parseLog(buf) {
  var text = buf.toString("latin1"), out = [], i = 0;
  while (i < text.length) {
    var j = i;
    while (j < text.length && text.charAt(j) !== " " && text.charAt(j) !== "\n") j++;
    var rec = { name: text.slice(i, j), args: [] };
    i = j;
    while (i < text.length && text.charAt(i) === " ") {
      var colon = text.indexOf(":", i + 1);
      var len = colon > i ? text.slice(i + 1, colon) : "";
      if (!/^(0|[1-9]\d*)$/.test(len) || colon + 1 + Number(len) > text.length) return null;
      rec.args.push(Buffer.from(text.slice(colon + 1, colon + 1 + Number(len)), "latin1").toString("utf8"));
      i = colon + 1 + Number(len);
    }
    if (text.charAt(i) !== "\n" || !rec.name) return null;
    i++;
    out.push(rec);
  }
  return out;
}

/** Why this call is not plainly read-only — or null. The WHOLE argv is judged: options before and after the verb. */
function refusal(rec) {
  if (rec.name === "sudo") return "sudo was called";
  var systemctl = rec.name === "systemctl";
  var reads = systemctl ? SYSTEMCTL_READS : rec.name === "launchctl" ? LAUNCHCTL_READS : null;
  if (!reads) return "an unknown stubbed program " + rec.name;
  var flags = systemctl ? SYSTEMCTL_FLAGS : [];
  var valued = systemctl ? SYSTEMCTL_VALUED : [];
  var verb = null, version = false;
  for (var i = 0; i < rec.args.length; i++) {
    var a = rec.args[i];
    if (systemctl && a === "--version") { version = true; continue; }
    // launchctl's options come after its verb (`kickstart -k`); before a verb, or for systemctl anywhere, every option
    // must be known — and a valued one must have its value.
    if (a.charAt(0) === "-" && (systemctl || verb === null)) {
      if (flags.indexOf(a) >= 0) continue;
      if (valued.indexOf(a) >= 0) { if (i + 1 >= rec.args.length) return "the option " + a + " without its value"; i++; continue; }
      var eq = a.indexOf("=");
      if (/^--[a-z-]+=/.test(a) && valued.indexOf(a.slice(0, eq)) >= 0 && eq + 1 < a.length) continue;
      return "an option it cannot judge (" + a + ")";
    }
    if (verb === null) {
      if (reads.indexOf(a) < 0) return "the verb " + a;
      verb = a;
      continue;
    }
    if (!systemctl && a.charAt(0) === "-") return "an option it cannot judge (" + a + ")";   // a read verb takes none here
  }
  if (version) return verb === null ? null : "--version with the verb " + verb;
  return verb === null ? "no verb" : null;
}

module.exports = { parseLog: parseLog, refusal: refusal };
if (require.main === module) {
  var recs = parseLog(fs.readFileSync(process.argv[2]));
  if (recs === null) { console.log("  the stub log is not well-formed"); process.exit(1); }
  var bad = recs.filter(function (r) { return refusal(r) !== null; });
  bad.forEach(function (r) { console.log("  " + refusal(r) + ": " + r.name + " " + JSON.stringify(r.args)); });
  process.exit(bad.length ? 1 : 0);
}
