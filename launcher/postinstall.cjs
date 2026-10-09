#!/usr/bin/env node
"use strict";
// #1450: npm's `postinstall` for @songsid/agend. It runs under whatever Node runs npm (possibly an old one) and
// decides, inside the install transaction, whether this install can run at all — refusing (exit 1) makes npm roll the
// install back (proven by the npm-rollback-proof gate, #1455):
//   - this release's bundled Node is present (supported host): prove it — exact version, N-API ≥ 10, platform/arch,
//     and a better-sqlite3 database opened in the main thread AND in a worker — then write the receipt the launcher
//     checks on every start;
//   - no bundled Node (unsupported host, none pinned yet, optional dependencies omitted): the Node running npm must
//     qualify itself.
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var childProcess = require("child_process");
var platform = require("./runtime-platform.cjs");
var select = require("./runtime-select.cjs");
var admission = require("./install-admission.cjs");

/** Runs on the candidate Node with argv[1] = the package dir: version, N-API, and a real DB open in both threads. */
var PROOF = [
  "const { createRequire } = require('node:module');",
  "const { Worker } = require('node:worker_threads');",
  "const dir = process.argv[1];",
  "const open = () => { const D = createRequire(require('node:path').join(dir, 'package.json'))('better-sqlite3'); const db = new D(':memory:'); const one = db.prepare('select 1 as one').get().one; db.close(); return one; };",
  "if (open() !== 1) process.exit(3);",
  "const w = new Worker(`const { createRequire } = require('node:module'); const D = createRequire(require('node:path').join(${JSON.stringify(dir)}, 'package.json'))('better-sqlite3'); const db = new D(':memory:'); const one = db.prepare('select 1 as one').get().one; db.close(); require('node:worker_threads').parentPort.postMessage(one);`, { eval: true });",
  // The worker's answer AND its clean exit (the database closed inside it): any other end fails the proof.
  "let answer = null;",
  "w.on('message', one => { answer = one; });",
  "w.on('error', () => process.exit(5));",
  "w.on('exit', code => { if (code !== 0 || answer !== 1) process.exit(4); process.stdout.write(JSON.stringify({ node: process.versions.node, napi: Number(process.versions.napi), platform: process.platform, arch: process.arch })); process.exit(0); });",
].join("\n");

function refuse(reason, recovery) {
  process.stderr.write("\n  AgEnD cannot be installed here: " + reason + ".\n  npm is rolling this install back; the previous install, if any, stays.\n  " + recovery + "\n\n");
  process.exit(1);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function main(deps) {
  var d = deps || {};
  var pkg = select.packageDir(d.launcherDir || __dirname);
  if (!pkg) refuse("the installed package is not @songsid/agend", "npm install -g @songsid/agend");
  // A receipt describes THIS install's verification and nothing else: whatever is there now (one npm left behind, one
  // copied in) goes first, so selection and installation see the same state (runtime-select.cjs).
  var receiptPath = path.join(pkg.dir, select.RECEIPT);
  if (!select.absent(receiptPath)) {
    try { fs.unlinkSync(receiptPath); } catch (e) { /* checked below */ }
    if (!select.absent(receiptPath)) refuse("an old runtime receipt at " + receiptPath + " cannot be removed", "remove it, then: npm install -g @songsid/agend@" + pkg.manifest.version);
  }
  // C1: an `agend update` owns this prefix right now → only its own npm child may install (install-admission.cjs).
  var admitted = admission.admit(pkg.dir, { env: d.env, processStart: d.processStart });
  if (!admitted.ok) refuse(admitted.reason, "Never run two installs of @songsid/agend into one prefix at once, or one while `agend update` runs.");
  var host = d.host || platform.hostPlatform();
  var running = d.versions || { node: process.versions.node, napi: Number(process.versions.napi) };
  var engines = (pkg.manifest.engines && pkg.manifest.engines.node) || ">=22.14.0";
  var pin = select.pinnedRuntime(pkg.manifest, host);
  var support = platform.runtimeSupport(host);
  var log = d.log || function (line) { process.stdout.write(line + "\n"); };

  if (pin && support.supported) {
    var candidate = select.runtimeCandidate(pkg.dir, pin);
    if (candidate.exists) {
      if (!candidate.manifest || candidate.manifest.name !== pin.name || candidate.manifest.version !== pin.version) {
        refuse("the bundled Node package is not " + pin.name + "@" + pin.version, "npm install -g @songsid/agend@" + pkg.manifest.version);
      }
      var st;
      try { st = fs.lstatSync(candidate.node); } catch (e) { st = null; }
      if (!st || !st.isFile()) refuse("the bundled Node binary is missing or not a regular file", "npm install -g @songsid/agend@" + pkg.manifest.version);
      var r = childProcess.spawnSync(candidate.node, ["-e", PROOF, pkg.dir], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
      var seen = null;
      try { seen = r.status === 0 ? JSON.parse(String(r.stdout).trim()) : null; } catch (e) { seen = null; }
      var wantNode = pin.version.replace(/-agend\.\d+$/, "");
      if (!seen || seen.node !== wantNode || !(seen.napi >= select.MIN_NAPI) || seen.platform !== host.platform || seen.arch !== host.arch) {
        refuse("the bundled Node did not pass its check (" + (seen ? "Node " + seen.node + ", N-API " + seen.napi + ", " + seen.platform + "-" + seen.arch : "exit " + (r.status === null ? r.signal : r.status) + ": " + String(r.stderr || "").trim().split("\n").pop()) + ")", "npm install -g @songsid/agend@" + pkg.manifest.version);
      }
      var real = fs.realpathSync(candidate.node);
      var finalStat = fs.statSync(real);
      var receipt = {
        pinnedVersion: pin.version, nodePath: real, size: finalStat.size, mtimeMs: finalStat.mtimeMs, sha256: sha256(real),
        napi: seen.napi, platform: host.platform, arch: host.arch, libc: host.glibc ? "glibc" : null, verifiedAt: new Date().toISOString(),
      };
      var tmp = path.join(pkg.dir, select.RECEIPT + "." + process.pid + ".tmp");
      fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2) + "\n");
      fs.renameSync(tmp, path.join(pkg.dir, select.RECEIPT));
      log("  ✓ AgEnD will run on its bundled Node " + seen.node + " (verified: N-API " + seen.napi + ", a database opened in the main thread and a worker)");
      return 0;
    }
    if (select.qualifies(running, engines)) {
      log("  ⚠ AgEnD's bundled Node was not installed (--omit=optional?); it will run on this Node " + running.node);
      return 0;
    }
    refuse("its bundled Node (" + pin.name + ") was not installed, and this Node " + running.node + " is older than AgEnD needs (" + engines + ")",
      "If optional dependencies were omitted or a registry mirror blocks " + pin.name + ", allow it and retry; or install Node " + engines + " first.");
  }
  if (select.qualifies(running, engines)) return 0;
  refuse((pin ? support.reason : "this release bundles no Node") + ", and this Node " + running.node + " is older than AgEnD needs (" + engines + ")",
    "Install Node " + engines + ", then: npm install -g @songsid/agend@" + pkg.manifest.version);
}

module.exports = { main: main, PROOF: PROOF };
if (require.main === module) process.exit(main() || 0);
