// old-updater-note.cjs — #1487: what a refused install must tell someone whose AgEnD 2.1.x updater started it.
//
// 2.1.x's `agend update` (and chat /update) runs `npm unlink -g @songsid/agend` BEFORE `npm install -g`, so when this
// install is refused (preinstall-guard.cjs, launcher/postinstall.cjs) nothing stays installed: no `agend`, and the
// service cannot start after its next restart or login (proven on the real-Mac test host, #1487). That updater writes
// <AGEND_HOME>/update-in-progress.json before it unlinks; 2.2's own updater never unlinks and marks its npm child with
// AGEND_UPDATE_KEEPS_PREVIOUS=1. So: a fresh marker without that mark → the previous AgEnD is certainly gone; no marker
// (a plain npm install) → say it conditionally; 2.2's updater → nothing to add.
// Reads one small file, writes nothing, no network. Old syntax only (var, no ?. ??): it runs under any Node npm runs on.
"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");

/** A 2.1.x update older than this is not the one running now. */
var FRESH_MS = 60 * 60 * 1000;

/** "removed" (certain), "maybe" (cannot tell), or "kept" (2.2's own updater: the previous install stays). */
function oldUpdaterState(env, now) {
  env = env || process.env;
  if (env.AGEND_UPDATE_KEEPS_PREVIOUS === "1") return "kept";
  var home = env.AGEND_HOME || path.join(os.homedir(), ".agend");
  var marker;
  try { marker = JSON.parse(fs.readFileSync(path.join(home, "update-in-progress.json"), "utf8")); } catch (e) { return "maybe"; }
  var started = marker && typeof marker.startedAt === "number" ? marker.startedAt : NaN;
  var at = now === undefined ? Date.now() : now;
  return started === started && at - started >= 0 && at - started < FRESH_MS ? "removed" : "maybe";
}

var RESTORE = "    npm install -g @songsid/agend@2.1.12\n    agend install\n";

/** The lines to add to a refusal (each starts with two spaces and ends with a newline); "" when nothing applies. */
function oldUpdaterNote(state) {
  if (state === "removed") {
    return "  This install was started by AgEnD 2.1's updater (`agend update` or /update). That updater had ALREADY\n" +
      "  REMOVED the previous AgEnD before this install began, so nothing stays installed: there is no `agend`\n" +
      "  command now, and the AgEnD service will not start after its next restart or login.\n" +
      "  Put the previous version back:\n" + RESTORE;
  }
  if (state === "maybe") {
    return "  If this install was started by AgEnD 2.1's updater (`agend update` or /update): that updater had already\n" +
      "  removed the previous AgEnD before this install began, so nothing stays installed. Put it back with:\n" + RESTORE;
  }
  return "";
}

module.exports = { oldUpdaterState: oldUpdaterState, oldUpdaterNote: oldUpdaterNote, FRESH_MS: FRESH_MS };
