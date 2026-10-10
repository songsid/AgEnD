#!/usr/bin/env node
// preinstall-guard.cjs — runs as npm's `preinstall` lifecycle hook.
// No dependencies: only built-in Node.js APIs and the package's own launcher/ helpers.
//
// better-sqlite3 v13 requires Node-API 10, available from:
//   Node 22.14.0 LTS   (released 2025-02-06)
//   Node 23.6.0        (released 2025-01-13)
//   Node 24+
//
// #1450: where this release pins a bundled Node for a supported host (Linux glibc >= 2.28 or macOS 11+, x64/arm64),
// the system Node's version is NEVER a reason to refuse — 20, 18, 16, any Node whose npm can run the install: AgEnD
// will not run on it. preinstall cannot verify the bundled Node (it is not on disk yet); launcher/postinstall.cjs
// proves it inside the same npm transaction and refuses (npm rolls back, the previous install stays) if it cannot.
// The one refusal here: a host no bundled Node covers (musl, 32-bit, another OS, older glibc/macOS, or a release that
// pins none) AND a system Node older than ENGINES — AgEnD would install and then not start.
// Old syntax only (var, no ?. ??, no trailing call commas): this runs under whatever Node runs npm.
//
// Exiting 1 aborts the install. A previous install stays — except when AgEnD 2.1's updater started this one: it
// removes the previous AgEnD first (#1487), so the refusal says so and gives the restore commands (old-updater-note.cjs).
// --ignore-scripts bypasses this check; see Upgrade Notes in the changelog.

"use strict";

var path = require("path");
var fs = require("fs");
var platform = require(path.join(__dirname, "..", "launcher", "runtime-platform.cjs"));
var oldUpdater = require(path.join(__dirname, "..", "launcher", "old-updater-note.cjs"));

var ENGINES = "^22.14.0 || ^23.6.0 || >=24";
var running = process.versions.node;
var napi = Number(process.versions.napi);

if (platform.satisfiesEngines(running, ENGINES) && napi >= 10) process.exit(0);

var manifest = {};
try { manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")); } catch (e) { /* none */ }
var host = platform.hostPlatform();
var pinned = manifest.optionalDependencies && manifest.optionalDependencies["@songsid/agend-node-" + host.id];
var support = platform.runtimeSupport(host);
if (pinned && support.supported) {
  // The bundled Node is pinned and fits this host: postinstall verifies it before the install can complete.
  process.exit(0);
}

process.stderr.write(
  "\n" +
  "  AgEnD 2.2 needs Node >=22.14; npm is aborting this install.\n" +
  "\n" +
  "  Running: Node " + running + "\n" +
  "  Required: " + ENGINES + "\n" +
  (pinned ? "  " + support.reason + ", so AgEnD's bundled Node cannot be used here either.\n" : "") +
  "\n" +
  "  Update Node to a compatible version, then retry:\n" +
  "    npm install -g @songsid/agend\n" +
  "\n" +
  (function () { var note = oldUpdater.oldUpdaterNote(oldUpdater.oldUpdaterState(process.env)); return note ? note + "\n" : ""; })()
);
process.exit(1);
