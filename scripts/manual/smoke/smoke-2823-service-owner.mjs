// Run ONLY as the scratch user inside a disposable systemd container.
// Mount a built candidate at /opt/agend and dependencies at /deps. No accounts/backends/network.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
assert.equal(readFileSync('/proc/1/comm', 'utf8').trim(), 'systemd');
assert.equal(process.env.AGEND_2823_DISPOSABLE, 'yes');
assert.equal(process.env.HOME, '/home/rh');
const home = '/home/rh/handoff', cli = '/opt/agend/dist/cli.js';
const unit = 'com.agend.fleet.service';
const env = { ...process.env, AGEND_HOME: home, AGEND_NODE: process.execPath, XDG_RUNTIME_DIR: '/run/user/1000' };
const owner = createRequire(import.meta.url)('/opt/agend/launcher/fleet-service-owner.cjs');
const target = { unit, user: true };
const run = (cmd, args, extra = {}) => spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 30_000, ...extra });
const agend = (...args) => run(process.execPath, [cli, ...args]);
const ctl = (...args) => run('systemctl', ['--user', ...args]);
const log = (name, data) => console.log(JSON.stringify({ check: name, ...data }));
async function waitFor(fn, label, ms = 60_000) { const until = performance.now() + ms; while (performance.now() < until) { if (await fn()) return; await sleep(100); } throw Error('timeout ' + label); }
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lock = () => JSON.parse(readFileSync(home + '/fleet.lock', 'utf8'));
mkdirSync(home, { recursive: true, mode: 0o700 });
writeFileSync(home + '/fleet.yaml', 'defaults:\n  locale: en\ninstances: {}\nweb:\n  enabled: true\n');
const installed = agend('install', '--no-activate');
console.log(installed.stdout, installed.stderr); assert.equal(installed.status, 0);
assert.equal(ctl('daemon-reload').status, 0);
let child, sleeper;
try {
  // Fault injection only at the real CLI's final runtime.exit: stopAll has already released its records.
  writeFileSync('/home/rh/delay-exit.cjs', `const fs = require('fs'); const exit = process.exit.bind(process); process.exit = code => { setTimeout(() => { fs.writeFileSync('/home/rh/old-exit.json', JSON.stringify({at:Date.now(),pid:process.pid})); exit(code); }, 3000); };`);
  child = spawn(process.execPath, [cli, 'fleet', 'start', '--direct'], { env: { ...env, NODE_OPTIONS: '--require=/home/rh/delay-exit.cjs' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => process.stdout.write('outside: ' + b)); child.stderr.on('data', b => process.stdout.write('outside-error: ' + b));
  await waitFor(() => existsSync(home + '/fleet.pid') && lock().pid === child.pid, 'outside startup');
  await waitFor(async () => { try { return (await fetch('http://127.0.0.1:19280/health')).ok; } catch { return false; } }, 'health');
  const original = readFileSync(home + '/fleet.lock', 'utf8');
  const definition = readFileSync('/home/rh/.config/systemd/user/' + unit, 'utf8');
  assert.equal(owner.inspect(home, target).kind, 'outside');
  // Metadata-only npm stub: ANY installation is a failure and recorded. It is not a service/backend stub.
  mkdirSync('/home/rh/guard', { recursive: true });
  writeFileSync('/home/rh/guard/npm', '#!/bin/sh\necho "$*" >> /home/rh/npm.calls\ncase "$1" in view) echo "${2##*@}";; *) exit 91;; esac\n', { mode: 0o700 });
  const guardedEnv = { ...env, PATH: '/home/rh/guard:' + env.PATH };
  const update = run(process.execPath, [cli, 'update', '--version', '9.9.9'], { env: guardedEnv });
  assert.equal(update.status, 1); assert.match(update.stderr, /Update not started: fleet PID/);
  assert.equal(readFileSync(home + '/fleet.lock', 'utf8'), original);
  assert.equal(readFileSync('/home/rh/.config/systemd/user/' + unit, 'utf8'), definition);
  assert.ok(alive(child.pid));
  assert.ok(!/^(?:install|exec) /m.test(readFileSync('/home/rh/npm.calls', 'utf8')));
  log('real CLI update refusal', { status: update.status, stderr: update.stderr.trim(), owner: child.pid });
  const same = run(process.execPath, [cli, 'update', '--version', JSON.parse(readFileSync('/opt/agend/package.json', 'utf8')).version], { env: guardedEnv });
  assert.equal(same.status, 1); assert.match(same.stderr, /Update not started: fleet PID/);
  const chat = run(process.execPath, [cli, 'update', '--version', '9.9.9', '--yes'], { env: { ...guardedEnv, AGEND_RESTART_ORIGIN: 'chat-update', AGEND_INSTANCE_NAME: 'scratch-only' } });
  assert.equal(chat.status, 1); assert.match(chat.stderr, /Update not started: fleet PID/);
  log('same-version and chat-origin preflight refusal', { same: same.status, chat: chat.status, oldOwnerAlive: alive(child.pid) });

  // The target installer must refuse before it even asks npm for the prefix (old updater coverage).
  const install = run(process.execPath, ['/opt/agend/launcher/agend-install.cjs', '--upgrade'], { env: guardedEnv });
  assert.equal(install.status, 1); assert.match(install.stdout, /Update not started: fleet PID/);
  assert.ok(!/^(?:install|exec|root|prefix) /m.test(readFileSync('/home/rh/npm.calls', 'utf8')));
  assert.equal(readFileSync(home + '/fleet.lock', 'utf8'), original);
  log('target installer refusal', { status: install.status, stdout: install.stdout.trim() });
  const restart = agend('restart', '--yes'); console.log(restart.stdout, restart.stderr);
  assert.equal(restart.status, 0);
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'old fleet exit');
  const newPid = Number(ctl('show', '-p', 'MainPID', '--value', unit).stdout.trim());
  assert.notEqual(newPid, child.pid); assert.equal(lock().pid, newPid);
  const oldExit = JSON.parse(readFileSync('/home/rh/old-exit.json', 'utf8'));
  assert.equal(oldExit.pid, child.pid);
  assert.ok(Date.parse(lock().createdAt) >= oldExit.at, 'replacement lock must wait for original process exit, not just record removal');
  log('records released before real process exit', { oldExitAt: oldExit.at, replacementClaimAt: Date.parse(lock().createdAt), waitedForExit: true });
  assert.equal(owner.inspect(home, target).kind, 'managed');
  assert.match(restart.stdout, /Fleet is now running under/);
  assert.equal(owner.updateRefusal(home), null);
  log('real restart handoff', { oldPid: child.pid, newPid, lockPid: lock().pid, unit: ctl('is-active', unit).stdout.trim() });
  assert.equal(ctl('stop', unit).status, 0);
  // Real non-AgEnD PID, including a stale/reused PID record, must receive no TERM.
  sleeper = spawn('/bin/sleep', ['1000'], { env, stdio: 'ignore' });
  writeFileSync(home + '/fleet.lock', JSON.stringify({ pid: sleeper.pid, role: 'fleet', nonce: 'stale-reused-record' }));
  const bad = agend('restart', '--yes'); assert.equal(bad.status, 1); assert.ok(alive(sleeper.pid));
  assert.match(bad.stderr, /ownership changed or could not be verified/);
  assert.equal(ctl('show', '-p', 'MainPID', '--value', unit).stdout.trim(), '0');
  log('real unrelated/reused PID refused', { status: bad.status, alive: alive(sleeper.pid) });
  // Real different-home AgEnD fleet also receives no signal.
  const foreignHome = '/home/rh/foreign'; mkdirSync(foreignHome, { mode: 0o700 });
  writeFileSync(foreignHome + '/fleet.yaml', 'instances: {}\nhealth_port: 19281\nweb:\n  enabled: true\n');
  const foreign = spawn(process.execPath, [cli, 'fleet', 'start', '--direct'], { env: { ...env, AGEND_HOME: foreignHome }, stdio: 'ignore' });
  try {
    await waitFor(() => existsSync(foreignHome + '/fleet.pid'), 'foreign start');
    writeFileSync(home + '/fleet.lock', JSON.stringify({ pid: foreign.pid, role: 'fleet', nonce: 'wrong-home' }));
    const refused = agend('restart', '--yes'); assert.equal(refused.status, 1); assert.ok(alive(foreign.pid));
    log('real foreign-home refused', { status: refused.status, alive: alive(foreign.pid) });
  } finally { foreign.kill('SIGTERM'); await waitFor(() => foreign.exitCode !== null || foreign.signalCode !== null, 'foreign exit'); }
  // Clear only these private acceptance records before starting our next real owner.
  const { unlinkSync } = await import('node:fs'); unlinkSync(home + '/fleet.lock');
  if (existsSync(home + '/fleet.pid')) unlinkSync(home + '/fleet.pid');
  child = spawn(process.execPath, [cli, 'fleet', 'start', '--direct'], { env, stdio: 'ignore' });
  await waitFor(() => existsSync(home + '/fleet.pid'), 'hung owner start');
  process.kill(child.pid, 'SIGSTOP'); // Container-only: hold graceful shutdown, not the main host.
  const began = performance.now();
  const timeoutResult = await new Promise(resolve => {
    const p = spawn(process.execPath, [cli, 'restart', '--yes'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; p.stdout.on('data', b => { stdout += b; }); p.stderr.on('data', b => { stderr += b; });
    p.on('exit', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(timeoutResult.code, 1); assert.match(timeoutResult.stderr, /did not exit within 300 seconds/);
  assert.ok(performance.now() - began >= 300_000); assert.ok(alive(child.pid));
  assert.equal(ctl('show', '-p', 'MainPID', '--value', unit).stdout.trim(), '0');
  assert.equal(lock().pid, child.pid);
  log('real 300s TERM-only timeout', { ...timeoutResult, elapsedMs: Math.round(performance.now() - began), ownerAlive: true, newMainPID: 0 });
} finally {
  if (child && alive(child.pid)) { try { process.kill(child.pid, 'SIGCONT'); } catch {} child.kill('SIGTERM'); }
  if (sleeper) sleeper.kill('SIGTERM');
  ctl('stop', unit);
}
log('PASS', { realCLI: true, realSystemdUser: true, containerOnly: true });
