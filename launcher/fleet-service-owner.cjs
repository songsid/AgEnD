"use strict";
// Shared by the installed CLI and the TARGET release's installer (#2823).
// A PID file is not authority to signal a process. Unknown proof always holds.
var fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
var GRACE_MS = 300000;
function defaults(options) {
  var o = options || {}, env = o.env || process.env;
  return Object.assign({
    platform: process.platform, env: env, uid: process.getuid ? process.getuid() : -1,
    read: function (p) { return fs.readFileSync(p, "utf8"); },
    stat: function (p) { return fs.statSync(p); },
    real: function (p) { return fs.realpathSync(p); },
    exists: function (p) { return fs.existsSync(p); },
    alive: function (pid) { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === "ESRCH") return false; throw e; } },
    run: function (cmd, args, opts) {
      var r = cp.spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
      return { status: r.status, stdout: r.stdout || "" };
    },
    signal: function (pid) { process.kill(pid, "SIGTERM"); },
    now: function () { return performance.now(); },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  }, o);
}
function selectedService(options) {
  var d = defaults(options);
  if (d.platform !== "linux") return null;
  var system = ["/etc/systemd/system/agend.service", "/usr/lib/systemd/system/agend.service", "/lib/systemd/system/agend.service"];
  for (var i = 0; i < system.length; i++) if (d.exists(system[i])) return { unit: "agend.service", user: false };
  if (d.exists(path.join(d.env.HOME || os.homedir(), ".config/systemd/user/com.agend.fleet.service"))) return { unit: "com.agend.fleet.service", user: true };
  return null;
}
function fields(text) {
  var out = Object.create(null);
  text.split("\n").forEach(function (line) { var at = line.indexOf("="); if (at > 0) out[line.slice(0, at)] = line.slice(at + 1); });
  return out;
}
function cgroup(text) {
  var rows = text.trim().split("\n").filter(function (r) { return /^(?:0::|\d+:name=systemd:)/.test(r); });
  if (rows.length !== 1) throw Error("unknown cgroup");
  var p = rows[0].slice(rows[0].indexOf(":", rows[0].indexOf(":") + 1) + 1);
  if (p[0] !== "/") throw Error("unknown cgroup");
  return p;
}
function inside(p, group) { return !!group && group !== "/" && (p === group || p.indexOf(group + "/") === 0); }
function processProof(pid, home, d) {
  if (!d.alive(pid)) return null;
  var proc = "/proc/" + pid, stat = d.read(proc + "/stat"), end = stat.lastIndexOf(")"), parts = stat.slice(end + 2).trim().split(/\s+/);
  if (stat.indexOf(pid + " (") !== 0 || end < 0 || !/^\d+$/.test(parts[19] || "")) throw Error("unknown birth");
  if (parts[0] === "Z" || parts[0] === "X") return null;
  if (d.stat(proc).uid !== d.uid) throw Error("foreign uid");
  var argv = d.read(proc + "/cmdline").split("\0").filter(Boolean);
  // Concrete shipped CLI, not an arbitrary process with 'fleet start' in its title.
  if (argv.length < 4 || argv.length > 5 || argv[2] !== "fleet" || argv[3] !== "start" || (argv.length === 5 && argv[4] !== "--direct")) throw Error("not a fleet command");
  var entry = d.real(argv[1]);
  if (path.basename(entry) !== "cli.js" || path.basename(path.dirname(entry)) !== "dist" || JSON.parse(d.read(path.join(path.dirname(entry), "../package.json"))).name !== "@songsid/agend") throw Error("not an AgEnD CLI");
  if (!/^node(?:js)?$/.test(path.basename(d.real(proc + "/exe")))) throw Error("not node");
  var env = Object.create(null);
  d.read(proc + "/environ").split("\0").forEach(function (v) { var at = v.indexOf("="); if (at > 0) env[v.slice(0, at)] = v.slice(at + 1); });
  var declared = env.AGEND_HOME || (env.HOME ? path.join(env.HOME, ".agend") : null);
  if (!declared || d.real(path.resolve(d.real(proc + "/cwd"), declared)) !== d.real(home)) throw Error("foreign or unreadable home");
  return { pid: pid, birth: parts[19], argv: argv, group: cgroup(d.read(proc + "/cgroup")) };
}
function inspect(home, service, options) {
  var d = defaults(options), raw, owner;
  if (d.platform !== "linux" || !service) return { kind: "none" };
  try {
    var lock = path.join(home, "fleet.lock");
    if (!d.exists(lock)) {
      var pidFile = path.join(home, "fleet.pid");
      if (d.exists(pidFile)) {
        var recorded = Number(d.read(pidFile).trim());
        if (!Number.isSafeInteger(recorded) || recorded <= 1 || d.alive(recorded)) return { kind: "unknown" };
      }
      return { kind: "none" };
    }
    raw = d.read(lock); owner = JSON.parse(raw);
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 1 || (owner.role !== undefined && owner.role !== "fleet") || typeof owner.nonce !== "string" || !owner.nonce) return { kind: "unknown" };
    var proof = processProof(owner.pid, home, d);
    if (!proof) return { kind: "none" };
    var env = Object.assign({}, d.env);
    if (service.user && !env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = "/run/user/" + d.uid;
    var r = d.run("systemctl", (service.user ? ["--user"] : []).concat(["show", service.unit, "--property=MainPID,ControlGroup,ActiveState,SubState,WorkingDirectory"]), { env: env, timeoutMs: 5000 });
    if (r.status !== 0) return { kind: "unknown" };
    var unit = fields(r.stdout), main = Number(unit.MainPID);
    if (!/^\d+$/.test(unit.MainPID || "") || !unit.ActiveState || !unit.SubState || d.real(unit.WorkingDirectory) !== d.real(home)) return { kind: "unknown" };
    // A same-unit child of an ExecStart wrapper is managed, not an orphan to kill.
    if (main > 0 && inside(proof.group, unit.ControlGroup)) return { kind: "managed", pid: owner.pid, mainPid: main };
    if (main !== 0 || !/^(?:inactive|failed)$/.test(unit.ActiveState)) return { kind: "unknown" };
    if (d.read(lock) !== raw) return { kind: "unknown" };
    return { kind: "outside", pid: owner.pid, signature: JSON.stringify([raw, proof.birth, proof.argv, proof.group]), unit: service.unit };
  } catch (e) { return { kind: "unknown" }; }
}
var messages = {
  en: {
    outside: "Update not started: fleet PID {pid} runs outside {unit}. Run agend restart to move it under systemd, then retry agend update. No package or service definition was changed.",
    unknown: "Update not started: the running fleet owner or its service ownership could not be verified. Check fleet.lock and systemctl status before retrying; no package or service definition was changed.",
    stopping: "Fleet PID {pid} runs outside {unit}; stopping it gracefully before starting the service (up to 300 seconds).",
    changed: "Restart not completed: fleet ownership changed or could not be verified. No replacement was started; inspect the running fleet before retrying.",
    timeout: "Restart not completed: fleet PID {pid} did not exit within 300 seconds. No replacement was started; inspect the running fleet before retrying.",
    ready: "Fleet is now running under {unit} (PID {pid}).",
    unconfirmed: "The service restart returned, but its fleet lock and MainPID could not be confirmed. Check systemctl status before retrying.",
    survivor: "the previously recorded fleet PID {pid} is still alive; this check does not establish which service owns it"
  },
  "zh-TW": {
    outside: "尚未開始更新：Fleet（PID {pid}）正在 {unit} 之外執行。請先執行 agend restart，交由 systemd 管理，再重試 agend update。套件與服務設定均未變更。",
    unknown: "尚未開始更新：無法確認執行中的 Fleet 或其服務歸屬。請先檢查 fleet.lock 與 systemctl status 再重試；套件與服務設定均未變更。",
    stopping: "Fleet（PID {pid}）正在 {unit} 之外執行；將先正常停止，再啟動服務（最多等待300秒）。",
    changed: "重新啟動未完成：Fleet 歸屬已改變或無法確認。未啟動替代 Fleet；請先檢查執行中的 Fleet 再重試。",
    timeout: "重新啟動未完成：Fleet（PID {pid}）未在300秒內結束。未啟動替代 Fleet；請先檢查執行中的 Fleet 再重試。",
    ready: "Fleet 已交由 {unit} 管理（PID {pid}）。",
    unconfirmed: "服務重新啟動指令已返回，但無法確認 Fleet 鎖與 MainPID 是否一致。請先檢查 systemctl status 再重試。",
    survivor: "先前記錄的 Fleet PID {pid} 仍存活；此檢查無法確認它由哪個服務管理"
  }
};
function locale(home) {
  try { var value = require("js-yaml").load(fs.readFileSync(path.join(home, "fleet.yaml"), "utf8")); if (value && value.defaults && messages[value.defaults.locale]) return value.defaults.locale; } catch (e) { /* zone fallback */ }
  return new Date().getTimezoneOffset() === -480 ? "zh-TW" : "en";
}
function text(key, state, language) { return messages[language === "zh-TW" ? language : "en"][key].replace(/\{(pid|unit)\}/g, function (_, k) { return String(state[k]); }); }
function updateRefusal(home, options) {
  var service = selectedService(options), state = inspect(home, service, options);
  return state.kind === "outside" || state.kind === "unknown" ? text(state.kind, state, (options || {}).locale || locale(home)) : null;
}
async function handoff(home, service, options) {
  var d = defaults(options), initial = inspect(home, service, d);
  if (initial.kind === "none" || initial.kind === "managed") return false;
  if (initial.kind !== "outside") throw Error(text("changed", initial, d.locale));
  if (d.log) d.log(text("stopping", initial, d.locale));
  var current = inspect(home, service, d);
  if (current.kind !== "outside" || current.signature !== initial.signature) throw Error(text("changed", initial, d.locale));
  // No awaits or output between this final identity proof and TERM. Never KILL.
  d.signal(initial.pid);
  var deadline = d.now() + GRACE_MS;
  for (;;) {
    current = inspect(home, service, d);
    if (current.kind === "none") return true;
    if (current.kind !== "outside" || current.signature !== initial.signature) throw Error(text("changed", initial, d.locale));
    var remaining = deadline - d.now();
    if (remaining <= 0) throw Error(text("timeout", initial, d.locale));
    await d.sleep(Math.min(500, remaining));
  }
}
module.exports = { selectedService: selectedService, inspect: inspect, updateRefusal: updateRefusal, handoff: handoff, text: text, locale: locale, GRACE_MS: GRACE_MS };
