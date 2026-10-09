#!/usr/bin/env node
// preinstall-guard.cjs — runs as npm's `preinstall` lifecycle hook.
// No dependencies: only built-in Node.js APIs and the package's own launcher/ helpers.
//
// better-sqlite3 v13 requires Node-API 10, available from:
//   Node 22.14.0 LTS   (released 2025-02-06)
//   Node 23.6.0        (released 2025-01-13)
//   Node 24+
//
// #1450 (sol's rule): an old host Node may proceed only toward a runtime that can be VERIFIED COMPLETE. preinstall
// cannot verify it — the bundled Node is not on disk yet — so it lets the install continue exactly when this release
// pins a bundled Node for a supported host; launcher/postinstall.cjs then proves that Node inside the same npm
// transaction and refuses (npm rolls back) if it cannot. Everything else on an old Node is refused here, as before:
// no pinned runtime, or a host the runtime packages do not cover.
//
// Exiting 1 aborts the install and keeps the previously installed version intact.
// --ignore-scripts bypasses this check; see Upgrade Notes in the changelog.

"use strict";

var path = require("path");
var fs = require("fs");
var platform = require(path.join(__dirname, "..", "launcher", "runtime-platform.cjs"));

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
  "\n",
);
process.exit(1);
