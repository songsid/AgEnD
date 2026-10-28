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
const home = '/home/rh/refusal', cli = '/opt/agend/dist/cli.js';
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
let child;
try {
  // Observe any TERM to the real outside fleet; only test cleanup may send one.
  writeFileSync('/home/rh/observe-term.cjs', `process.on('SIGTERM', () => require('fs').appendFileSync('/home/rh/term.calls', 'TERM\\n'));`);
  child = spawn(process.execPath, [cli, 'fleet', 'start', '--direct'], { env: { ...env, NODE_OPTIONS: '--require=/home/rh/observe-term.cjs' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const restart = agend('restart', '--yes');
  assert.equal(restart.status, 1);
  assert.match(restart.stderr, /Restart not started: fleet PID/);
  assert.match(restart.stderr, /Nothing was signalled or started/);
  assert.ok(alive(child.pid));
  assert.equal(readFileSync(home + '/fleet.lock', 'utf8'), original);
  assert.equal(readFileSync('/home/rh/.config/systemd/user/' + unit, 'utf8'), definition);
  assert.equal(ctl('show', '-p', 'MainPID', '--value', unit).stdout.trim(), '0');
  assert.ok(!existsSync('/home/rh/term.calls'), 'no TERM on update, installer or restart refusal');
  log('real restart refusal', { status: restart.status, stderr: restart.stderr.trim(), ownerAlive: true, noTerm: true, newMainPID: 0, unitUnchanged: true, lockUnchanged: true });
} finally {
  // Explicit supervisor cleanup of this disposable test's own fleet, after all assertions.
  if (child && alive(child.pid)) {
    child.kill('SIGTERM');
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'outside cleanup');
  }
  ctl('stop', unit);
}
log('PASS', { realCLI: true, realSystemdUser: true, containerOnly: true });
