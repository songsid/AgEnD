/** Compiled routing proof. The only runnable app is a fresh scratch copy with an inert FleetManager constructor. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'agend-hub-start-smoke-'));
const app = join(scratch, 'inert-app'), target = 'INERT_FLEET_CONSTRUCTOR', children = new Set(), servers = new Set();
const cases = [];
async function listener() {
  const server = createServer(socket => socket.destroy()); servers.add(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, port: server.address().port };
}
const close = server => server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
async function waitFor(test, message) {
  const until = performance.now() + 10_000;
  while (!test()) { assert(performance.now() < until, message); await delay(10); }
}
function child(args, env, cwd) {
  const proc = spawn(process.execPath, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(proc);
  const state = { proc, out: '', err: '', exit: undefined };
  proc.stdout.on('data', x => { state.out += x; }); proc.stderr.on('data', x => { state.err += x; });
  proc.once('error', err => { state.err += String(err); state.exit = -1; });
  proc.once('close', (code, signal) => { state.exit = code ?? signal; children.delete(proc); });
  return state;
}
try {
  mkdirSync(app);
  for (const folder of ['dist', 'launcher']) cpSync(join(repo, folder), join(app, folder), { recursive: true });
  cpSync(join(repo, 'package.json'), join(app, 'package.json'));
  symlinkSync(join(repo, 'node_modules'), join(app, 'node_modules'), 'dir');
  const manager = join(app, 'dist', 'fleet-manager.js');
  writeFileSync(manager, `export class FleetManager { constructor() { throw Error(${JSON.stringify(target)}); } }\n`);
  assert(readFileSync(manager, 'utf8').includes(target));
  const barrier = join(app, 'dist', 'hub', 'service-start.js'), originalBarrier = readFileSync(barrier);
  const selfPid = join(scratch, 'self-pid.mjs');
  writeFileSync(selfPid, `import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; writeFileSync(join(process.env.AGEND_HOME, 'fleet.pid'), String(process.pid));\n`);
  for (const locale of ['en', 'zh-TW']) for (const mode of ['off', 'invalid-pid', 'free', 'listener-wait', 'process-wait', 'stale-pid', 'self-pid']) {
    const home = join(scratch, locale + '-' + mode); mkdirSync(home, { mode: 0o700 });
    const a = await listener(), b = await listener(); await close(a.server);
    if (mode !== 'listener-wait') await close(b.server);
    writeFileSync(join(home, 'fleet.yaml'), JSON.stringify({ defaults: { locale }, instances: {}, hub: {
      enabled: mode !== 'off', webListen: { host: '127.0.0.1', port: a.port }, memberListen: { host: '127.0.0.1', port: b.port },
    } }));
    writeFileSync(barrier, mode === 'off' ? 'throw Error("OFF_HUB_BARRIER_MUST_STAY_UNLOADED");\n' : originalBarrier);
    const env = { HOME: home, AGEND_HOME: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'UTC', NO_COLOR: '1' };
    let sleeper;
    if (mode === 'invalid-pid') writeFileSync(join(home, 'fleet.pid'), 'not-a-PID');
    if (mode === 'process-wait' || mode === 'stale-pid') {
      sleeper = child(['-e', 'setInterval(() => {}, 1000)'], env, home);
      writeFileSync(join(home, 'fleet.pid'), String(sleeper.proc.pid));
      if (mode === 'stale-pid') utimesSync(join(home, 'fleet.pid'), new Date(1000), new Date(1000));
    }
    const run = child([...(mode === 'self-pid' ? ['--import', selfPid] : []), join(app, 'dist', 'cli.js'), 'fleet', 'start', '--direct'], env, home);
    let blockedBeforeRelease = false;
    if (mode.endsWith('-wait')) {
      await waitFor(() => run.out.includes(locale === 'en' ? 'Waiting for the previous Hub process' : '正在等待前一個 Hub 程序') || run.exit !== undefined, 'missing startup wait notice');
      await delay(300);
      assert.equal(run.exit, undefined, 'replacement must remain blocked before the owned resource closes');
      assert(!run.err.includes(target), 'runtime construction must wait for closure'); blockedBeforeRelease = true;
      if (mode === 'listener-wait') await close(b.server);
      else { sleeper.proc.kill('SIGTERM'); await waitFor(() => sleeper.exit !== undefined, 'owned sleeper did not exit'); }
    }
    await waitFor(() => run.exit !== undefined, 'inert CLI did not settle');
    assert.equal(run.exit, 1, 'the inert constructor or explicit refusal must end the command');
    assert(!run.err.includes('OFF_HUB_BARRIER_MUST_STAY_UNLOADED'));
    if (mode === 'invalid-pid') {
      assert(run.err.includes(locale === 'en' ? 'previous PID record' : '前一個 PID 紀錄'));
      assert(!run.err.includes(target), 'invalid old state must refuse before construction');
      assert.equal(readFileSync(join(home, 'fleet.pid'), 'utf8'), 'not-a-PID');
    } else assert(run.err.includes(target), 'only the inert runtime target may be reached');
    if (mode === 'stale-pid') {
      assert.equal(sleeper.exit, undefined, 'the younger unrelated process must remain alive');
      sleeper.proc.kill('SIGTERM'); await waitFor(() => sleeper.exit !== undefined, 'owned sleeper did not exit');
    }
    cases.push({ locale, mode, exit: run.exit, blockedBeforeRelease, realFleetConstructed: false });
  }
  // Drive the real install handler, but replace every service-manager entry in this scratch app with strict inert
  // modules. A fresh Background definition must target user/<uid> even before a plist exists on disk.
  for (const name of ['service-installer', 'service-plan', 'restart-guard', 'updater-caller'])
    cpSync(join(app, 'dist', name + '.js'), join(app, 'dist', name + '.real.js'));
  writeFileSync(join(app, 'dist', 'service-installer.js'), `
    export * from './service-installer.real.js';
    import { join } from 'node:path';
    import assert from 'node:assert/strict';
    export function installService(vars) {
      renderLaunchdPlist(vars); console.log('INERT_INSTALL_SERVICE'); return '/inert/service.plist';
    }
    export function activateService(path, pidPath, options) {
      assert.equal(path, '/inert/service.plist'); assert.equal(pidPath, join(process.env.AGEND_HOME, 'fleet.pid'));
      assert.deepEqual(options, { preservePidFile: true }); console.log('INERT_ACTIVATE_SERVICE');
    }
    export const getServicePath = () => null, getSystemServicePath = () => null, detectPlatform = () => 'macos';
    export const serviceHomeFor = home => ({ workingDirectory: home, logPath: join(home, 'fleet.log'), agendHome: home });
    export const launchdPlistPath = label => join(process.env.HOME, 'Library', 'LaunchAgents', label + '.plist');
    export function renderLaunchdPlist(vars) {
      assert.equal(vars.launchdSessionType, 'Background'); assert.equal(vars.agendHome, process.env.AGEND_HOME);
      return JSON.stringify({ home: vars.agendHome, session: vars.launchdSessionType });
    }
  `);
  writeFileSync(join(app, 'dist', 'service-plan.js'), `
    export * from './service-plan.real.js';
    export const revokePlan = () => {};
    export function refreshLaunchdWithoutActivating(input) {
      console.log('INERT_INSTALL_PLAN=' + JSON.stringify(input)); return { ok: true, message: 'inert plan only' };
    }
  `);
  writeFileSync(join(app, 'dist', 'restart-guard.js'), `export * from './restart-guard.real.js'; export const expectedTuple = () => ({ ok: true, expected: { entry: '/inert/entry', node: '/inert/node' } });\n`);
  writeFileSync(join(app, 'dist', 'updater-caller.js'), `export * from './updater-caller.real.js'; export const startedByUpdater = () => ({ updater: false }), systemUpdaterCallerProbe = () => ({});\n`);
  for (const locale of ['en', 'zh-TW']) {
    const home = join(scratch, locale + '-planned-install'); mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, 'fleet.yaml'), JSON.stringify({ defaults: { locale }, instances: {}, hub: { enabled: true } }));
    const env = { HOME: home, AGEND_HOME: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'UTC', NO_COLOR: '1' };
    const run = child([join(app, 'dist', 'cli.js'), 'install', '--no-activate'], env, home);
    await waitFor(() => run.exit !== undefined, 'inert install handler did not settle'); assert.equal(run.exit, 0, run.err);
    const line = run.out.split('\n').find(value => value.startsWith('INERT_INSTALL_PLAN=')); assert(line, run.out);
    const plan = JSON.parse(line.slice('INERT_INSTALL_PLAN='.length));
    assert.equal(plan.target, 'user/' + process.getuid() + '/com.agend.fleet');
    assert.equal(plan.agendHome, home); assert.equal(plan.plistPath, join(home, 'Library', 'LaunchAgents', 'com.agend.fleet.plist'));
    assert.deepEqual(JSON.parse(plan.newPlist), { home, session: 'Background' });
    cases.push({ locale, mode: 'planned-install', exit: run.exit, realServiceOperation: false });
  }
  for (const locale of ['en', 'zh-TW']) for (const mode of ['idle-install', 'active-install', 'stale-install']) {
    const home = join(scratch, locale + '-' + mode); mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, 'fleet.yaml'), JSON.stringify({ defaults: { locale }, instances: {}, hub: { enabled: true } }));
    const env = { HOME: home, AGEND_HOME: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'UTC', NO_COLOR: '1' };
    let sleeper;
    if (mode !== 'idle-install') {
      sleeper = child(['-e', 'setInterval(() => {}, 1000)'], env, home);
      writeFileSync(join(home, 'fleet.pid'), String(sleeper.proc.pid));
      if (mode === 'stale-install') utimesSync(join(home, 'fleet.pid'), new Date(1000), new Date(1000));
    }
    const run = child([join(app, 'dist', 'cli.js'), 'install'], env, home);
    await waitFor(() => run.exit !== undefined, 'inert install handler did not settle');
    if (mode === 'active-install') {
      assert.equal(run.exit, 1); assert(run.err.includes(locale === 'en' ? 'Use agend stop' : '請使用 agend stop'));
      assert(!run.out.includes('INERT_INSTALL_SERVICE')); assert(!run.out.includes('INERT_ACTIVATE_SERVICE'));
      assert.equal(readFileSync(join(home, 'fleet.pid'), 'utf8'), String(sleeper.proc.pid));
      assert.equal(sleeper.exit, undefined, 'the claimed owned process must not be signalled');
      sleeper.proc.kill('SIGTERM'); await waitFor(() => sleeper.exit !== undefined, 'owned sleeper did not exit');
    } else {
      assert.equal(run.exit, 0, run.err); assert(run.out.includes('INERT_INSTALL_SERVICE')); assert(run.out.includes('INERT_ACTIVATE_SERVICE'));
      assert(run.out.includes(locale === 'en' ? 'startup requested' : '已安裝並要求啟動'));
      if (sleeper) {
        assert.equal(sleeper.exit, undefined); assert.equal(readFileSync(join(home, 'fleet.pid'), 'utf8'), String(sleeper.proc.pid));
        sleeper.proc.kill('SIGTERM'); await waitFor(() => sleeper.exit !== undefined, 'owned sleeper did not exit');
      }
    }
    cases.push({ locale, mode, exit: run.exit, realServiceOperation: false });
  }
  assert.equal(cases.length, 22);
  const output = process.argv[2];
  if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify({ cases }, null, 2) + '\n'); }
  console.log(JSON.stringify({ passed: cases.length, cases }));
} finally {
  for (const server of servers) await close(server);
  for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
  for (const proc of [...children]) if (children.has(proc)) await new Promise(resolve => proc.once('close', resolve));
  rmSync(scratch, { recursive: true, force: true });
}
