#!/usr/bin/env node
// Disposable hosted VM only. Inert Node fixtures; never import a fleet or backend.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { readSystemdRuntime, systemdRunning, systemdStopped } from "../../dist/systemd-runtime.js";

const OUT = resolve(process.argv[2] ?? "cgroup-receipt.json");
const receipt = { state: "pending", scope: "disposable GitHub-hosted Linux VM; inert private unit and children only", checks: [] };
const save = () => writeFileSync(OUT, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
const check = (name, value) => { receipt.checks.push({ name, pass: !!value }); assert.ok(value, name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (name, predicate, ms = 10_000) => {
  const until = performance.now() + ms;
  while (performance.now() < until) { if (predicate()) return; await sleep(50); }
  throw Error(`deadline: ${name}`);
};
const run = (command, args) => {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 8000, env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, LANG: "C" } });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const sd = (...args) => run("systemctl", ["--user", ...args]);
const success = r => r.status === 0 && r.signal === null;
const read = path => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const owner = pid => {
  try { const text = readFileSync(`/proc/${pid}/stat`, "utf8"), fields = text.slice(text.lastIndexOf(")") + 2).split(" "); return { birth: fields[19], state: fields[0] }; }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
};
const gone = (pid, birth) => { const p = owner(pid); return p === null || p.birth !== birth || p.state === "Z"; };
const quote = value => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", () => "$$")}"`;

let root, unit, linked = false, outside;
try {
  check("explicit_disposable_opt_in", process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_OS === "Linux" && process.env.AGEND_DISPOSABLE_CGROUP_PROBE === "1");
  const init = readFileSync("/proc/1/comm", "utf8").trim();
  if (init !== "systemd" || !success(sd("show-environment"))) {
    receipt.state = "parked"; receipt.reason = init !== "systemd" ? "PID1 is not systemd" : "runner user manager unavailable";
    save(); process.exitCode = 2;
  } else {
    writeFileSync("/proc/self/coredump_filter", "0");
    root = mkdtempSync(join(process.env.RUNNER_TEMP, "agend-cgroup1490-"));
    mkdirSync(join(root, "home"), { mode: 0o700 });
    unit = `agend-cgroup1490-${process.pid}-${process.env.GITHUB_RUN_ID}.service`;
    const file = join(root, unit), main = join(root, "main.mjs"), worker = join(root, "worker.mjs");
    const mainState = join(root, "main.json"), go = join(root, "go.json"), strategy = join(root, "strategy");
    const launchModule = resolve("dist/update-launch.js");
    const installedFixture = join(root, "installed '$HOME; agend");
    const shellQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";
    writeFileSync(installedFixture, "#!/bin/sh\nexec " + [process.execPath, worker, root, unit].map(shellQuote).join(" ") + ' "$@"\n', {mode: 0o700});
    writeFileSync(strategy, "plain");
    writeFileSync(worker, `import {readFileSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
const [dir,unit]=process.argv.slice(2),pid=process.pid,file=dir+'/updater-'+pid+'.json';let started=false;
process.on('SIGTERM',()=>{});
const stamp=()=>writeFileSync(file,JSON.stringify({pid,started,args:process.argv.slice(4),cwd:process.cwd(),sentinel:process.env.AGEND_SCOPE_SENTINEL}));stamp();
setInterval(()=>{stamp();let go;try{go=JSON.parse(readFileSync(dir+'/go.json','utf8'));}catch{};
if(!started&&go?.pid===pid){started=true;stamp();const r=spawnSync('systemctl',['--user','restart',unit],{timeout:12000,stdio:'ignore'});writeFileSync(dir+'/completed-'+pid+'.json',JSON.stringify({status:r.status,signal:r.signal}));}},100);
`, { mode: 0o600 });
    writeFileSync(main, `import {spawn} from 'node:child_process';import {writeFileSync,readFileSync} from 'node:fs';
const [dir,unit,worker,launchModule,installed]=process.argv.slice(2);process.on('SIGTERM',()=>{});
const mode=readFileSync(dir+'/strategy','utf8');let command=process.execPath,args=[worker,dir,unit],scope;
if(mode==='scope'){const {resolveUpdateLaunch}=await import(launchModule);const plan=await resolveUpdateLaunch(installed);if(!plan.ok)throw Error(plan.reason);({command,args,scope}=plan);}
const child=spawn(command,args,{detached:true,stdio:'ignore',env:{...process.env,AGEND_SCOPE_SENTINEL:'literal $HOME; scope'}});child.unref();
const state={pid:process.pid,updater:child.pid,scope};writeFileSync(dir+'/main.json',JSON.stringify(state));writeFileSync(dir+'/parent-'+process.pid+'.json',JSON.stringify(state));setInterval(()=>{},10000);
`, { mode: 0o600 });
    const line = ["/usr/bin/env", "-i", `HOME=${join(root, "home")}`, "PATH=/usr/bin:/bin", `XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR}`, "LANG=C", process.execPath, main, root, unit, worker, launchModule, installedFixture].map(quote).join(" ");
    writeFileSync(file, `[Unit]\nDescription=Private inert updater cgroup probe\n[Service]\nType=simple\nWorkingDirectory=${quote(join(root, "home"))}\nExecStart=${line}\nKillMode=mixed\nSendSIGKILL=yes\nTimeoutStopSec=2s\nRestart=no\n`, { mode: 0o600 });
    check("private_runtime_link", success(sd("link", "--runtime", file))); linked = true;
    check("actual_user_manager_reload", success(sd("daemon-reload")));
    const fragment = sd("show", unit, "-p", "FragmentPath", "--value");
    check("loaded_fragment_is_own_file", success(fragment) && realpathSync(fragment.stdout.trim()) === realpathSync(file));
    const mode = sd("show", unit, "-p", "KillMode", "--value");
    check("loaded_kill_mode_mixed", success(mode) && mode.stdout.trim() === "mixed");
    const timeout = sd("show", unit, "-p", "TimeoutStopUSec", "--value");
    check("loaded_fixture_grace_2s", success(timeout) && timeout.stdout.trim() === "2s");
    outside = spawn(process.execPath, ["-e", "setInterval(()=>{},10000)"], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
    const outsideBirth = owner(outside.pid)?.birth;
    const start = async (scoped = false) => {
      rmSync(mainState, { force: true });
      check("private_start", success(sd("start", unit)));
      await wait("inert fixture ready", () => { const s = read(mainState); return s && read(join(root, `updater-${s.updater}.json`)); });
      const state = read(mainState);
      state.mainBirth = owner(state.pid)?.birth; state.updaterBirth = owner(state.updater)?.birth;
      check("owned_births_readable", !!state.mainBirth && !!state.updaterBirth && !!outsideBirth);
      check(scoped ? "scoped_updater_has_independent_cgroup" : "detached_updater_inherits_unit_cgroup", (readFileSync(`/proc/${state.pid}/cgroup`, "utf8") === readFileSync(`/proc/${state.updater}/cgroup`, "utf8")) === !scoped);
      check("outside_control_has_other_cgroup", readFileSync(`/proc/${state.pid}/cgroup`, "utf8") !== readFileSync(`/proc/${outside.pid}/cgroup`, "utf8"));
      const runtime = readSystemdRuntime(run, true, unit);
      check("production_reader_native_running", systemdRunning(runtime) && runtime.pid === state.pid && runtime.killMode === "mixed");
      return state;
    };
    const first = await start();
    const startedAt = performance.now();
    check("external_private_stop_completed", success(sd("stop", unit)));
    receipt.stop_elapsed_ms = Math.round(performance.now() - startedAt);
    await wait("old private children gone", () => gone(first.pid, first.mainBirth) && gone(first.updater, first.updaterBirth));
    check("stop_killed_detached_updater", gone(first.updater, first.updaterBirth));
    check("production_reader_native_stopped", systemdStopped(readSystemdRuntime(run, true, unit)));
    check("outside_control_survives_stop", !gone(outside.pid, outsideBirth));
    const second = await start();
    writeFileSync(go, JSON.stringify({ pid: second.updater }), { mode: 0o600 });
    await wait("updater enters native restart", () => read(join(root, `updater-${second.updater}.json`))?.started === true);
    await wait("native restart has replacement main", () => { const s = read(mainState); return s && s.pid !== second.pid && !gone(s.pid, owner(s.pid)?.birth); });
    await wait("self-restart old updater gone", () => gone(second.updater, second.updaterBirth));
    check("self_restart_killed_updater_before_return", gone(second.updater, second.updaterBirth) && read(join(root, `completed-${second.updater}.json`)) === null);
    check("replacement_private_service_active", success(sd("is-active", unit)));
    check("outside_control_survives_restart", !gone(outside.pid, outsideBirth));
    check("private_stop_before_scope_control", success(sd("stop", unit)));
    writeFileSync(strategy, "scope");
    const third = await start(true);
    const thirdWorker = read(join(root, `updater-${third.updater}.json`));
    check("scope_preserves_literal_positional_argv", JSON.stringify(thirdWorker.args) === JSON.stringify(["update"]));
    check("scope_preserves_environment", thirdWorker.sentinel === "literal $HOME; scope");
    check("scope_preserves_working_directory", thirdWorker.cwd === join(root, "home"));
    writeFileSync(go, JSON.stringify({ pid: third.updater }), { mode: 0o600 });
    await wait("scoped updater returns from native restart", () => read(join(root, `completed-${third.updater}.json`)) !== null);
    const completed = read(join(root, `completed-${third.updater}.json`));
    check("scoped_self_restart_returns_success", completed.status === 0 && completed.signal === null);
    check("scoped_updater_survives_own_restart", !gone(third.updater, third.updaterBirth));
    check("scope_replacement_private_service_active", success(sd("is-active", unit)));
    check("outside_control_survives_scope_restart", !gone(outside.pid, outsideBirth));
    receipt.state = "reproduced_and_fixed";
    receipt.launch_sha256 = createHash("sha256").update(readFileSync(new URL("../../src/update-launch.ts", import.meta.url))).digest("hex");
    receipt.fixture_grace_seconds = 2;
    receipt.production_grace_claim = "Mechanism only; no claim about 300s production timing";
    receipt.reader_sha256 = createHash("sha256").update(readFileSync(new URL("../../src/systemd-runtime.ts", import.meta.url))).digest("hex");
    receipt.probe_sha256 = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
  }
} catch (error) { receipt.state = "failed"; receipt.error = String(error?.message ?? error); process.exitCode = 1; }
finally {
  if (linked) {
    const stopped = sd("stop", unit), disabled = sd("disable", "--runtime", unit), reload = sd("daemon-reload");
    const scopes = root ? readdirSync(root).filter(f => /^parent-\d+\.json$/.test(f)).map(f => read(join(root,f))?.scope).filter(Boolean) : [];
    const scopesStopped = scopes.map(scope => /^agend-updater-[a-f0-9]{32}\.scope$/.test(scope) && success(sd("stop", scope))).every(Boolean);
    receipt.cleanup = { scopesStopped, stopped: success(stopped), disabled: success(disabled), reloaded: success(reload) };
    if (!Object.values(receipt.cleanup).every(Boolean)) { receipt.state = "failed"; process.exitCode = 1; }
  }
  if (outside) { const exit = once(outside, "exit"); outside.kill("SIGINT"); await exit; }
  if (root) rmSync(root, { recursive: true, force: true });
  save(); console.log(JSON.stringify(receipt));
}
