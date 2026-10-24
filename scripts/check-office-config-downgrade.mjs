// Pure config admission/round-trip proof against published rollback validators. No fleet, CLI or account use.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
for (const api of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[api] = () => { throw Error(`Forbidden process API: ${api}`); };
syncBuiltinESMExports();
const { normalizeOfficeStorage, dashboardFeaturesOffIn } = await import('../dist/dashboard-permissions.js');
const roots = process.argv.slice(2); assert.ok(roots.length, 'pass published package roots');
let checked = 0;
for (const root of roots) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  assert.ok(['2.3.1', '2.2.6'].includes(version), `unexpected rollback version ${version}`);
  const { validateFleetConfig } = await import(pathToFileURL(join(resolve(root), 'dist/config-validator.js')).href);
  const { loadFleetConfig } = await import(pathToFileURL(join(resolve(root), 'dist/config.js')).href);
  const dir = mkdtempSync(join(tmpdir(), 'agend-office-downgrade-'));
  try {
    for (const on of [true, false]) {
      const config = { defaults: { dashboard: { office: on, task_board: false } }, instances: { agent: { working_directory: dir, dashboard: { office: !on } } } };
      normalizeOfficeStorage(config);
      assert.equal(config.defaults.dashboard.office, undefined);
      assert.equal(config.instances.agent.dashboard.office, undefined);
      assert.equal(config.defaults.office_access, on); assert.equal(config.instances.agent.office_access, !on);
      assert.equal(validateFleetConfig(config).valid, true, JSON.stringify(validateFleetConfig(config).errors));
      const file = join(dir, 'fleet.yaml'); writeFileSync(file, yaml.dump(config));
      const old = loadFleetConfig(file);
      assert.equal(validateFleetConfig(old).valid, true);
      writeFileSync(file, yaml.dump(old));
      const returned = yaml.load(readFileSync(file, 'utf8'));
      assert.equal(returned.defaults.office_access, on); assert.equal(returned.instances.agent.office_access, !on);
      assert.equal(dashboardFeaturesOffIn(returned, 'agent').includes('office'), on);
      assert.equal(dashboardFeaturesOffIn(returned, 'classic-room').includes('office'), !on);
      console.log(`PASS ${version}: Office default=${on}, instance=${!on}; validator accepts, old load/rewrite preserves, current gates restore`);
      checked++;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
assert.equal(checked, roots.length * 2);
