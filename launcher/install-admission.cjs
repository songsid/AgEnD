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

/** ps by absolute path when it is where the OS keeps it: a service's or a test's PATH may not reach it. */
var PS = ["/bin/ps", "/usr/bin/ps"].filter(function (p) { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (e) { return false; } })[0] || "ps";

/**
 * A process's start time as one canonical text: `ps -o lstart=` under LC_ALL=C and TZ=UTC, so every caller — whatever
 * its own locale or time zone — reads the same text for the same process. null: it could not be read.
 */
function processStart(pid) {
  try {
    var env = {};
    Object.keys(process.env).forEach(function (k) { env[k] = process.env[k]; });
    env.LC_ALL = "C";
    env.TZ = "UTC";
    var r = childProcess.spawnSync(PS, ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, env: env, stdio: ["ignore", "pipe", "ignore"] });
    var text = String(r.stdout || "").trim();
    return r.status === 0 && text ? text : null;
  } catch (e) {
    return null;
  }
}

/** The record, exactly as the updater validates it (src/install-lock.ts parseInstallLock), or null. */
/** Does `pid` exist? Only a definite "no such process" is no. */
function exists(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

/**
 * The lock holder's state: "live" (that very process), "stale" (PROVEN gone: no such pid, or the pid is now a process
 * that started at another time), or "unknown" (it exists but its start time cannot be read) — which blocks, never
 * counts as stale. deps (tests): exists, processStart.
 */
function holderState(lock, deps) {
  var d = deps || {};
  if (!(d.exists || exists)(lock.pid)) return "stale";
  var seen = (d.processStart || processStart)(lock.pid);
  if (seen === null || seen === undefined) return "unknown";
  return seen === lock.processStart ? "live" : "stale";
}

function parse(text) {
  var r;
  try { r = JSON.parse(text); } catch (e) { return null; }
  return r && typeof r === "object" && Number.isSafeInteger(r.pid) && r.pid > 0 && typeof r.processStart === "string" && r.processStart
    && typeof r.prefix === "string" && typeof r.token === "string" && /^[0-9a-f]{32,}$/.test(r.token)
    && typeof r.targetSpec === "string" && typeof r.agendHome === "string" && typeof r.createdAt === "string" ? r : null;
}

/** { ok: true, why } or { ok: false, reason }. deps (tests): env, processStart. */
function admit(pkgDir, deps) {
  var d = deps || {};
  var env = d.env || process.env;
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
  var state = holderState(lock, d);
  if (state === "unknown") return { ok: false, reason: "whether the AgEnD update that holds " + lockPath + " (pid " + lock.pid + ") is still running cannot be told; retry" };
  if (state === "stale") {
    return token ? { ok: false, reason: "the AgEnD update that held " + lockPath + " is gone, so its token cannot authorise this install" } : { ok: true, why: "a stale lock and no token: an external install" };
  }
  if (lock.prefix !== prefix) return { ok: false, reason: "the install lock " + lockPath + " names another prefix (" + lock.prefix + ")" };
  if (token && token === lock.token) return { ok: true, why: "the updater's own install" };
  return { ok: false, reason: "an `agend update` (pid " + lock.pid + ") is installing into " + prefix + " right now; wait for it, then retry" };
}

module.exports = { LOCK: LOCK, TOKEN_ENV: TOKEN_ENV, admit: admit, globalPrefix: globalPrefix, processStart: processStart, exists: exists, holderState: holderState, parse: parse };
