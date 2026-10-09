#!/usr/bin/env node
// preinstall-guard.cjs — runs as npm's `preinstall` lifecycle hook.
// No dependencies: only built-in Node.js APIs.
//
// better-sqlite3 v13 requires Node-API 10, available from:
//   Node 22.14.0 LTS   (released 2025-02-06)
//   Node 23.6.0        (released 2025-01-13)
//   Node 24+
//
// This guard exits 1 when the running Node does not support N-API 10 so
// npm aborts the install and keeps the previously installed version intact.
//
// --ignore-scripts bypasses this check; see Upgrade Notes in the changelog.

"use strict";

const [maj, min] = process.versions.node.split(".").map(Number);
const ok =
  maj >= 24 ||
  (maj === 23 && min >= 6) ||
  (maj === 22 && min >= 14);

if (!ok) {
  process.stderr.write(
    "\n" +
    "  AgEnD 2.2 needs Node >=22.14; npm is aborting this install.\n" +
    "\n" +
    "  Running: Node " + process.versions.node + "\n" +
    "  Required: ^22.14.0 || ^23.6.0 || >=24\n" +
    "\n" +
    "  Update Node to a compatible version, then retry:\n" +
    "    npm install -g @songsid/agend\n" +
    "\n",
  );
  process.exit(1);
}
