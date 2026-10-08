#!/usr/bin/env node
// preinstall-guard.cjs — runs as npm's `preinstall` lifecycle hook.
// No dependencies: only built-in Node.js APIs.
//
// better-sqlite3 v13 requires Node-API 10, available from:
//   Node 22.14.0 LTS   (released 2025-02-06)
//   Node 23.6.0        (released 2025-01-13)
//   Node 24+
//
// This guard exits 1 on incompatible Node so npm aborts the install and
// rolls back to the previously installed version — protecting a machine
// running the OLD updater (2.1.x) that can only issue a warning about
// `engines` but still allows the install to proceed.
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
    "  ERROR  AgEnD requires Node.js ^22.14.0 || ^23.6.0 || >=24.\n" +
    "         better-sqlite3 v13 uses Node-API 10, available from\n" +
    "         Node 22.14.0 LTS, Node 23.6.0, or Node 24+.\n" +
    "\n" +
    "  Running: Node " + process.versions.node + "\n" +
    "\n" +
    "  Upgrade Node first, then retry:\n" +
    "    nvm install 22 && nvm use 22\n" +
    "    npm install -g @songsid/agend\n" +
    "\n" +
    "  npm is aborting this install. Your existing agend version\n" +
    "  remains in place.\n" +
    "\n",
  );
  process.exit(1);
}
