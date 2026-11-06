// Run only as a fresh user in a capped network-disabled disposable systemd container.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { WebSessionStore, tokenEpoch } from '/opt/agend/dist/web-session.js';
assert.equal(process.env.AGEND_2829_DISPOSABLE, 'yes');
assert.equal(process.env.HOME, '/home/cfg');
assert.equal(readFileSync('/proc/1/comm', 'utf8').trim(), 'systemd');
const require = createRequire(import.meta.url), Database = require('better-sqlite3');
const home = '/home/cfg/config-history-2829', cli = '/opt/agend/dist/cli.js', unit = 'agend-history-2829.service';
const base = 'http://127.0.0.1:19389';
const env = { ...process.env, AGEND_HOME: home, AGEND_NODE: process.execPath, XDG_RUNTIME_DIR: '/run/user/1001' };
const run = (cmd, args, extra = {}) => spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 90_000, ...extra });
const ctl = (...args) => run('systemctl', ['--user', ...args]);
const agend = (...args) => run(process.execPath, [cli, ...args]);
const pid = () => Number(ctl('show', '-p', 'MainPID', '--value', unit).stdout.trim());
const log = (check, fields = {}) => console.log(JSON.stringify({ check, ...fields }));
async function waitFor(fn, label, ms = 60_000) { const until = performance.now() + ms; while (performance.now() < until) { try { if (await fn()) return; } catch {} await sleep(200); } throw Error('timeout ' + label); }
mkdirSync(home, { recursive: true, mode: 0o700 });
const fleetGood = 'defaults:\n  locale: en\n  tips: false\nfleet_label: stored-fleet\ninstances: {}\nhealth_port: 19389\nweb:\n  enabled: true\n';
const fleetBad = fleetGood + 'fleet_label: notice-test-secret\n';
const classicGood = 'defaults:\n  reply_triggers: false\nchannels: {}\n';
const classicBad = classicGood + 'defaults:\n  reply_triggers: true\n';
const fp = home + '/fleet.yaml', cp = home + '/classicBot.yaml';
writeFileSync(fp, fleetGood, { mode: 0o600 }); writeFileSync(cp, classicGood, { mode: 0o600 });
// Synthetic local-admin session fixture in this private HOME before the real fleet reads it. No account or login.
const token = randomBytes(24).toString('hex'); writeFileSync(home + '/web.token', token, { mode: 0o600 });
const session = new WebSessionStore({ dataDir: home }).create({ tier: 'admin', surface: 'local', label: 'private acceptance', tokenEpoch: tokenEpoch(token) });
const get = async path => { const r = await fetch(base + path, { headers: { cookie: 'agend_session=' + session.sessionId }, signal: AbortSignal.timeout(5000) }); assert.equal(r.status, 200, path + ' HTTP ' + r.status); return r.json(); };
const items = async () => (await get('/ui/poll?after=')).needs.filter(i => i.type === 'config');
const rows = file => { const db = new Database(home + '/config-history.db', { readonly: true }); try { return db.prepare('SELECT * FROM config_versions WHERE file=? ORDER BY id').all(file); } finally { db.close(); } };
const unitDir = '/home/cfg/.config/systemd/user'; mkdirSync(unitDir, { recursive: true });
writeFileSync(unitDir + '/' + unit, `[Unit]\nDescription=Private AgEnD YAML-history acceptance\n[Service]\nType=notify\nNotifyAccess=all\nWatchdogSec=60\nWorkingDirectory=${home}\nEnvironment=AGEND_HOME=${home}\nEnvironment=AGEND_NODE=${process.execPath}\nEnvironment=PATH=/usr/local/bin:/usr/bin:/bin\nExecStart=${process.execPath} ${cli} fleet start --direct\nRestart=on-failure\nRestartSec=1\nKillMode=mixed\nTimeoutStartSec=90\nTimeoutStopSec=30\nStandardOutput=append:${home}/fleet.log\nStandardError=append:${home}/fleet.log\n`);
assert.equal(ctl('daemon-reload').status, 0);
async function ready(previous = 0) {
  await waitFor(async () => { const p = pid(); if (!p || p === previous) return false; const h = await get('/health'); return h.startupComplete === true; }, 'ready replacement');
}
async function crashOwned() {
  const old = pid(); assert.ok(old > 1);
  assert.equal(JSON.parse(readFileSync(home + '/fleet.lock', 'utf8')).pid, old);
  assert.ok(readFileSync('/proc/' + old + '/cmdline', 'utf8').includes(cli));
  assert.ok(readFileSync('/proc/' + old + '/environ', 'utf8').split('\0').includes('AGEND_HOME=' + home));
  process.kill(old, 'SIGKILL'); // Only this harness's verified private fleet, never the host service.
  await ready(old); return { old, current: pid() };
}
try {
  const start = ctl('start', unit); assert.equal(start.status, 0, start.stderr); await ready();
  assert.equal(rows('fleet.yaml').at(-1).content, fleetGood); assert.equal(rows('classicBot.yaml').at(-1).content, classicGood);
  log('valid startup history', { pid: pid(), copies: [rows('fleet.yaml').length, rows('classicBot.yaml').length] });
  writeFileSync(fp, fleetBad);
  await waitFor(async () => (await items()).some(i => i.reason === 'config_invalid' && i.configIssue.file === 'fleet.yaml'), 'Fleet A');
  const a = (await items())[0]; assert.ok(!a.detail.includes('notice-test-secret')); assert.match(a.detail, /The next restart would use/);
  assert.equal(agend('reload').status, 0); await sleep(1500);
  assert.equal((await items()).length, 1); assert.equal((await items())[0].id, a.id);
  const validation = agend('validate'); assert.equal(validation.status, 1);
  assert.equal(readFileSync(fp, 'utf8'), fleetBad); assert.equal(rows('fleet.yaml').length, 1);
  // Other file is read normally on the restart, independently of the broken Fleet source.
  const changedClassic = classicGood.replace('false', 'true'); writeFileSync(cp, changedClassic);
  const firstCrash = await crashOwned();
  await waitFor(async () => (await items()).some(i => i.reason === 'config_fallback' && i.configIssue.file === 'fleet.yaml'), 'Fleet B');
  assert.equal((await get('/api/settings/fleet')).fleet_label, 'stored-fleet');
  assert.equal(rows('classicBot.yaml').at(-1).content, changedClassic);
  assert.equal(readFileSync(fp, 'utf8'), fleetBad);
  log('Fleet duplicate -> one A -> owned SIGKILL -> B', { ...firstCrash, notice: (await items())[0].detail, rawUnchanged: true, storedLabel: 'stored-fleet', otherFileLoadedNormally: true });
  writeFileSync(fp, fleetGood); assert.equal(agend('reload').status, 0);
  await waitFor(async () => (await items()).length === 0, 'Fleet repaired reload');
  writeFileSync(cp, classicBad);
  await waitFor(async () => (await items()).some(i => i.reason === 'config_invalid' && i.configIssue.file === 'classicBot.yaml'), 'Classic A');
  const secondCrash = await crashOwned();
  await waitFor(async () => (await items()).some(i => i.reason === 'config_fallback' && i.configIssue.file === 'classicBot.yaml'), 'Classic B');
  assert.equal(readFileSync(cp, 'utf8'), classicBad);
  log('Classic duplicate -> A -> owned SIGKILL -> B', { ...secondCrash, notice: (await items())[0].detail, rawUnchanged: true });
  writeFileSync(fp, fleetBad);
  await waitFor(async () => (await items()).length === 2, 'two independent errors');
  const thirdCrash = await crashOwned();
  await waitFor(async () => { const list = await items(); return list.length === 2 && list.every(i => i.reason === 'config_fallback'); }, 'both B');
  assert.equal(readFileSync(fp, 'utf8'), fleetBad); assert.equal(readFileSync(cp, 'utf8'), classicBad);
  log('both files recover independently', { ...thirdCrash, files: (await items()).map(i => i.configIssue.file), rawUnchanged: true });
} finally { ctl('stop', unit); }
for (const file of ['fleet.yaml', 'classicBot.yaml']) {
  const noHome = '/home/cfg/no-history-' + file; mkdirSync(noHome, { mode: 0o700 });
  writeFileSync(noHome + '/fleet.yaml', file === 'fleet.yaml' ? fleetBad : fleetGood, { mode: 0o600 });
  writeFileSync(noHome + '/classicBot.yaml', file === 'classicBot.yaml' ? classicBad : classicGood, { mode: 0o600 });
  const failed = run(process.execPath, [cli, 'fleet', 'start', '--direct'], { env: { ...env, AGEND_HOME: noHome } });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, new RegExp('Cannot start: ' + file));
  assert.match(failed.stderr, /No usable stored valid copy/);
  assert.equal(readFileSync(noHome + '/' + file, 'utf8'), file === 'fleet.yaml' ? fleetBad : classicBad);
  log('no history clear startup failure', { file, status: failed.status, message: failed.stderr.split('\n').find(l => l.includes('Cannot start:')), rawUnchanged: true });
}
log('PASS', { realCLI: true, realSystemdUser: true, accounts: false, isolatedOnly: true });
