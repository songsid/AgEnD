/** Compiled CLI in private scratch homes; runtime construction and service mutation are explicit inert failures. */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const repo = fileURLToPath(new URL('../../../', import.meta.url)), root = mkdtempSync(join(tmpdir(), 'agend-handoff-smoke-'));
const app = join(root, 'app'), results = [];
try {
  mkdirSync(app); for (const dir of ['dist', 'launcher']) cpSync(join(repo, dir), join(app, dir), { recursive: true });
  cpSync(join(repo, 'package.json'), join(app, 'package.json')); symlinkSync(join(repo, 'node_modules'), join(app, 'node_modules'), 'dir');
  writeFileSync(join(app, 'dist/fleet-manager.js'), 'export class FleetManager { constructor() { throw Error("NO_RUNTIME_CONSTRUCTION"); } }\n');
  cpSync(join(app, 'dist/service-installer.js'), join(app, 'dist/service-installer.real.js'));
  writeFileSync(join(app, 'dist/service-installer.js'), `export * from './service-installer.real.js';
    export function inspectService() { return {installed:true,path:'/inert/service',manager:'inert'}; }
    export function uninstallService() { throw Error('NO_SERVICE_MUTATION'); }
    export function installService() { throw Error('NO_SERVICE_MUTATION'); }
    export function activateService() { throw Error('NO_SERVICE_MUTATION'); }
  `);
  for (const locale of ['en', 'zh-TW']) for (const mode of ['valid', 'missing', 'foreign-purpose']) {
    const home = join(root, locale + ' space\' ' + mode); mkdirSync(home, { mode: 0o700 }); mkdirSync(join(home, 'hub'), { mode: 0o700 });
    writeFileSync(join(home, 'fleet.yaml'), JSON.stringify({ defaults: { locale }, instances: {} }));
    writeFileSync(join(home, 'hub/keep-secret'), 'DUMMY_SECRET_NEVER_IN_OUTPUT', { mode: 0o600 });
    const record = { v:1,purpose:mode === 'foreign-purpose'?'authorization':'installation-record',recordedAt:'2026-01-01T00:00:00.000Z',
      hubId:'00000000-0000-4000-8000-000000000001',webOrigin:'https://hub.example.test:8443',memberOrigin:'https://hub.example.test:9443',spkiSha256:'a'.repeat(64),coexistence:'dedicated',serviceLabel:'com.agend.fleet',paths:['fleet.yaml','hub/','fleet.log'] };
    if (mode !== 'missing') writeFileSync(join(home, 'hub/install-inventory.json'), JSON.stringify(record), { mode: 0o600 });
    const snapshot = () => createHash('sha256').update(readFileSync(join(home, 'fleet.yaml'))).update(readFileSync(join(home, 'hub/keep-secret'))).digest('hex'), before = snapshot();
    const r = spawnSync(process.execPath, [join(app, 'dist/cli.js'), 'hub', 'handoff'], { cwd: home, timeout: 10000, encoding: 'utf8',
      env: { HOME:home, AGEND_HOME:home, PATH:'/usr/bin:/bin', LANG:'en_US.UTF-8', NO_COLOR:'1' } });
    assert.equal(r.status, mode === 'valid' ? 0 : 1, r.stderr); assert.equal(snapshot(), before);
    assert(!(r.stdout+r.stderr).includes('DUMMY_SECRET_NEVER_IN_OUTPUT')); assert(!(r.stdout+r.stderr).includes('NO_SERVICE_MUTATION')); assert(!(r.stdout+r.stderr).includes('NO_RUNTIME_CONSTRUCTION'));
    if (mode === 'valid') {
      assert(r.stdout.includes(locale === 'en' ? 'Hub installation record' : 'Hub 安裝紀錄'));
      assert(r.stdout.includes('agend stop') && r.stdout.includes('agend uninstall') && r.stdout.includes('hub handoff'));
      assert(r.stdout.includes('/inert/service')); assert(!r.stdout.includes('--force'));
    } else assert(r.stderr.includes(locale === 'en' ? 'missing or unreadable' : '找不到私人 Hub 安裝紀錄'));
    results.push({ locale, mode, exit:r.status, filesUnchanged:true, lifecycleActions:false });
  }
  console.log(JSON.stringify({ passed:results.length, cases:results }, null, 2));
} finally { rmSync(root, { recursive:true, force:true }); }
