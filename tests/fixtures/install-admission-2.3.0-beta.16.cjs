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
    // #1947: 15 s, not 5: on a host running many agents a ps that answers late made the holder "unknown" (a refusal).
    var r = childProcess.spawnSync(PS, ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 15000, env: env, stdio: ["ignore", "pipe", "ignore"] });
    var text = String(r.stdout || "").trim();
    return r.status === 0 && text ? text : null;
  } catch (e) {
    return null;
  }
}

/**
 * #1947: on Linux, a process's start time in clock ticks since boot (/proc/<pid>/stat field 22): fixed for the life of
 * the process, whatever happens to the wall clock. `ps -o lstart` derives a wall time from the boot time, which moves
 * when the clock is stepped (NTP, a VM or WSL resyncing), so the same process could print a different second. null:
 * not Linux, or not readable.
 */
function startTicks(pid) {
  if (process.platform !== "linux") return null;
  var text;
  try { text = fs.readFileSync("/proc/" + pid + "/stat", "utf8"); } catch (e) { return null; }
  var fields = text.slice(text.lastIndexOf(")") + 2).split(" ");   // field 3 (state) onwards; comm may hold spaces
  var ticks = fields[19];
  return /^\d+$/.test(ticks || "") ? ticks : null;
}

/**
 * #1947: this boot's identity (/proc/sys/kernel/random/boot_id). Start ticks count from boot, so they identify a
 * process only within one boot: a lock that outlived a reboot names a process of another boot. null: not readable.
 */
function bootId() {
  var text;
  try { text = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch (e) { return null; }
  return /^[0-9a-f-]{36}$/.test(text) ? text : null;
}

/** #1947: how far two lstart texts of one process may differ (a clock step between the two reads); 1 s resolution. */
var START_TOLERANCE_MS = 2000;

/**
 * The same start, as `ps -o lstart=` printed it under LC_ALL=C and TZ=UTC: identical, or both read as times at most
 * START_TOLERANCE_MS apart. Text that does not read as a time compares exactly.
 */
function sameStartText(recorded, seen) {
  if (recorded === seen) return true;
  var a = Date.parse(recorded + " UTC"), b = Date.parse(seen + " UTC");
  return isFinite(a) && isFinite(b) && Math.abs(a - b) <= START_TOLERANCE_MS;
}

/** Does `pid` exist? Only a definite "no such process" is no. */
function exists(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

/**
 * The lock holder's state: "live" (that very process), "stale" (PROVEN gone: no such pid, or the pid is now a process
 * that started at another time), or "unknown" (it exists but its start time cannot be read) — which blocks, never
 * counts as stale. A lock that records its holder's start ticks (Linux, #1947) is judged by them and its boot, never by
 * the wall clock: another boot → stale; this boot, the same ticks → live (whatever the clock did); other ticks →
 * stale; the boot or the ticks unreadable → unknown. Any other lock (every 2.2 beta's, or macOS) by the lstart text,
 * within START_TOLERANCE_MS. deps (tests): exists, processStart, startTicks, bootId.
 */
function holderState(lock, deps) {
  var d = deps || {};
  if (!(d.exists || exists)(lock.pid)) return "stale";
  if (typeof lock.startTicks === "string") {
    var boot = (d.bootId || bootId)();
    if (boot === null || boot === undefined) return "unknown";
    if (boot !== lock.bootId) return "stale";
    var ticks = (d.startTicks || startTicks)(lock.pid);
    if (ticks === null || ticks === undefined) return "unknown";
    return ticks === lock.startTicks ? "live" : "stale";
  }
  var seen = (d.processStart || processStart)(lock.pid);
  if (seen === null || seen === undefined) return "unknown";
  return sameStartText(lock.processStart, seen) ? "live" : "stale";
}

function parse(text) {
  var r;
  try { r = JSON.parse(text); } catch (e) { return null; }
  return r && typeof r === "object" && Number.isSafeInteger(r.pid) && r.pid > 0 && typeof r.processStart === "string" && r.processStart
    && typeof r.prefix === "string" && typeof r.token === "string" && /^[0-9a-f]{32,}$/.test(r.token)
    && typeof r.targetSpec === "string" && typeof r.agendHome === "string" && typeof r.createdAt === "string"
    // #1947: start ticks and the boot they count from come together, or neither.
    && ((r.startTicks === undefined && r.bootId === undefined)
      || (typeof r.startTicks === "string" && /^\d+$/.test(r.startTicks) && typeof r.bootId === "string" && /^[0-9a-f-]{36}$/.test(r.bootId))) ? r : null;
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

module.exports = {
  LOCK: LOCK, TOKEN_ENV: TOKEN_ENV, admit: admit, globalPrefix: globalPrefix, processStart: processStart, startTicks: startTicks, bootId: bootId,
  sameStartText: sameStartText, START_TOLERANCE_MS: START_TOLERANCE_MS, exists: exists, holderState: holderState, parse: parse,
};
