"use strict";
// #1450 C1: may this install of @songsid/agend proceed? Called by the postinstall, inside npm's transaction (a refusal
// makes npm roll the install back). The lock is the updater's (src/install-lock.ts): `<prefix>/.agend-install.lock`,
// next to the package it guards. The prefix comes from WHERE this package is — never from the environment.
//   - no lock, no token            → a plain external install: proceed (the documented restriction covers the rest);
//   - a live lock, its own token   → the updater's own npm child: proceed;
//   - a live lock, other/no token  → a foreign install while AgEnD owns the prefix: refuse;
//   - a token, but no live lock    → late or stale (it cannot authorise a successor): refuse;
//   - a lock that cannot be read   → refuse, naming the file (unknown ownership blocks).
// Same syntax constraints as runtime-platform.cjs: this may run on an old Node.
var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");

var LOCK = ".agend-install.lock";
var TOKEN_ENV = "AGEND_INSTALL_TOKEN";

/** `<prefix>/lib/node_modules/@songsid/agend` → `<prefix>`; null for any other layout (a local install, a checkout). */
function globalPrefix(pkgDir) {
  var scope = path.dirname(pkgDir);
  var nodeModules = path.dirname(scope);
  var lib = path.dirname(nodeModules);
  if (path.basename(pkgDir) !== "agend" || path.basename(scope) !== "@songsid" || path.basename(nodeModules) !== "node_modules" || path.basename(lib) !== "lib") return null;
  return path.dirname(lib);
}

/** As the updater reads it: `ps -o lstart=` under LC_ALL=C (same TZ, inherited). */
function processStart(pid) {
  try {
    var env = {};
    Object.keys(process.env).forEach(function (k) { env[k] = process.env[k]; });
    env.LC_ALL = "C";
    var r = childProcess.spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, env: env, stdio: ["ignore", "pipe", "ignore"] });
    var text = String(r.stdout || "").trim();
    return r.status === 0 && text ? text : null;
  } catch (e) {
    return null;
  }
}

function parse(text) {
  var r;
  try { r = JSON.parse(text); } catch (e) { return null; }
  return r && typeof r.pid === "number" && r.pid > 0 && typeof r.processStart === "string" && r.processStart
    && typeof r.token === "string" && /^[0-9a-f]{32,}$/.test(r.token) && typeof r.prefix === "string" ? r : null;
}

/** { ok: true, why } or { ok: false, reason }. deps (tests): env, processStart. */
function admit(pkgDir, deps) {
  var d = deps || {};
  var env = d.env || process.env;
  var start = d.processStart || processStart;
  var token = env[TOKEN_ENV] || "";
  var real;
  try { real = fs.realpathSync(pkgDir); } catch (e) { real = pkgDir; }
  var prefix = globalPrefix(real);
  if (!prefix) return token ? { ok: false, reason: "an AgEnD install token was presented, but this is not a global install it could belong to" } : { ok: true, why: "not a global install" };
  try { prefix = fs.realpathSync(prefix); } catch (e) { /* as derived */ }
  var lockPath = path.join(prefix, LOCK);
  var text = null;
  try { text = fs.readFileSync(lockPath, "utf8"); } catch (e) {
    if (e.code !== "ENOENT") return { ok: false, reason: "the install lock " + lockPath + " cannot be read (" + e.code + ")" };
  }
  if (text === null) {
    return token ? { ok: false, reason: "an AgEnD install token was presented, but no update holds " + lockPath + " (a late or stale token)" } : { ok: true, why: "no lock: an external install" };
  }
  var lock = parse(text);
  if (!lock) return { ok: false, reason: "the install lock " + lockPath + " cannot be read as a lock; if no `agend update` is running, remove it and retry" };
  var live = start(lock.pid) === lock.processStart;
  if (!live) {
    return token ? { ok: false, reason: "the AgEnD update that held " + lockPath + " is gone, so its token cannot authorise this install" } : { ok: true, why: "a stale lock and no token: an external install" };
  }
  if (lock.prefix !== prefix) return { ok: false, reason: "the install lock " + lockPath + " names another prefix (" + lock.prefix + ")" };
  if (token && token === lock.token) return { ok: true, why: "the updater's own install" };
  return { ok: false, reason: "an `agend update` (pid " + lock.pid + ") is installing into " + prefix + " right now; wait for it, then retry" };
}

module.exports = { LOCK: LOCK, TOKEN_ENV: TOKEN_ENV, admit: admit, globalPrefix: globalPrefix, processStart: processStart };
