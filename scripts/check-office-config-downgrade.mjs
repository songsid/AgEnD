// Pure config admission/round-trip proof against published rollback validators, and (#2706) the stored offices against
// the published Office store: an office saved with Edit-layout overrides survives a rollback's read and save. No fleet,
// CLI or account use.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
for (const api of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[api] = () => { throw Error(`Forbidden process API: ${api}`); };
syncBuiltinESMExports();
const { normalizeOfficeStorage, dashboardFeaturesOffIn } = await import('../dist/dashboard-permissions.js');
const { OfficeStore } = await import('../dist/web-office-store.js');
// #2706: one office with every part of an Edit layout (the night places, reservations and mail drop kept beside it
// since #2665/#2691/#2736; the rest since #2706), one without.
const LAID = { id: 'laid', name: 'Laid out', skin: 'snug', members: ['team:core'],
  overrides: { pack: 'snug', door: [600, 710], seats: { lounge: [[780, 280]] }, furnitureNight: { bed: [300, 420] }, seatFor: { desks: { 0: { for: ['alpha'], lend: false } } }, mailDrop: [640, 420] } };
const PLAIN = { id: 'plain', name: 'Plain', skin: 'studio', members: [] };
const bare = ({ overrides, ...o }) => o;
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
      const config = { defaults: { dashboard: { office: on, office_packs: on, task_board: false } }, instances: { agent: { working_directory: dir, dashboard: { office: !on, office_packs: !on } } } };   // #2692: office_packs too
      normalizeOfficeStorage(config);
      assert.equal(config.defaults.dashboard.office, undefined);
      assert.equal(config.instances.agent.dashboard.office, undefined);
      assert.equal(config.defaults.office_access, on); assert.equal(config.instances.agent.office_access, !on);
      assert.equal(config.defaults.dashboard.office_packs, undefined); assert.equal(config.defaults.office_pack_access, on); assert.equal(config.instances.agent.office_pack_access, !on);
      assert.equal(validateFleetConfig(config).valid, true, JSON.stringify(validateFleetConfig(config).errors));
      const file = join(dir, 'fleet.yaml'); writeFileSync(file, yaml.dump(config));
      const old = loadFleetConfig(file);
      assert.equal(validateFleetConfig(old).valid, true);
      writeFileSync(file, yaml.dump(old));
      const returned = yaml.load(readFileSync(file, 'utf8'));
      assert.equal(returned.defaults.office_access, on); assert.equal(returned.instances.agent.office_access, !on);
      assert.equal(returned.defaults.office_pack_access, on); assert.equal(returned.instances.agent.office_pack_access, !on);
      assert.equal(dashboardFeaturesOffIn(returned, 'agent').includes('office_packs'), on);
      assert.equal(dashboardFeaturesOffIn(returned, 'agent').includes('office'), on);
      assert.equal(dashboardFeaturesOffIn(returned, 'classic-room').includes('office'), !on);
      console.log(`PASS ${version}: Office default=${on}, instance=${!on}; validator accepts, old load/rewrite preserves, current gates restore`);
      checked++;
    }
    // #2706: the stored offices. 2.2.6 has no Office (it never reads web-offices.json); 2.3.1 reads and saves it.
    const oldStore = join(resolve(root), 'dist/web-office-store.js');
    if (version === '2.2.6') {
      assert.equal(existsSync(oldStore), false, '2.2.6 is not expected to have an Office store');
      console.log(`PASS ${version}: no Office store, web-offices.json is never read`);
    } else {
      const { OfficeStore: OldStore } = await import(pathToFileURL(oldStore).href);
      const home = mkdtempSync(join(dir, 'offices-'));
      assert.equal(new OfficeStore(home).replace([LAID, PLAIN], 0).ok, true);
      const old = new OldStore(home), seen = old.list();
      assert.equal(seen.readable, true);
      assert.deepEqual(seen.offices.map(o => o.id), ['laid', 'plain'], `${version} drops an office with overrides on read`);
      assert.deepEqual(new OfficeStore(home).list().offices, [LAID, PLAIN], 'an old read changes nothing');
      const saved = old.replace(seen.offices, seen.rev);
      assert.equal(saved.ok, true, JSON.stringify(saved));
      assert.deepEqual(new OfficeStore(home).list().offices, [bare(LAID), PLAIN], `${version}'s save keeps every office (without its layout)`);
      console.log(`PASS ${version}: an office with Edit-layout overrides survives the old read and the old save (its layout left out)`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
assert.equal(checked, roots.length * 2);
