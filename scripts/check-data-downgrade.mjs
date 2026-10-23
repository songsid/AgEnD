// Developer-only, two-runtime compatibility probe. Never runs a fleet or a CLI.
// Usage: node scripts/check-data-downgrade.mjs OLD_PACKAGE_ROOT OLD_NODE
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [oldPackageArg, oldNodeArg, expectedBaseline] = process.argv.slice(2);
assert.ok(oldPackageArg && oldNodeArg && expectedBaseline, 'Supply an isolated installed baseline package (2.1.12 or 2.2.6), the Node it runs on, and the baseline version it must be');
const oldPackage = realpathSync(resolve(oldPackageArg));
const oldNode = realpathSync(resolve(oldNodeArg));
// The published baselines and what each runs on: 2.1.12 on Node 20 with better-sqlite3 12; 2.2.6 — what #2483's Mac
// recovery and #2481's auto-restore go back to — on its own bundled Node 22 with better-sqlite3 13.
const BASELINES = { '2.1.12': { node: '20', sqlite: /^12\./ }, '2.2.6': { node: '22', sqlite: /^13\./ } };
const baseline = JSON.parse(readFileSync(join(oldPackage, 'package.json'), 'utf8')).version;
assert.ok(Object.hasOwn(BASELINES, baseline), `no data-downgrade expectations for baseline ${baseline}`);
// Each step names the baseline it tests: a step pointed at the other install fails instead of testing it twice.
assert.equal(baseline, expectedBaseline, `the package at ${oldPackage} is ${baseline}, this step tests ${expectedBaseline}`);
const currentPackage = resolve(here, '..');
// Only this runner chooses the data directory: callers cannot supply live AGEND_HOME.
const scratch = mkdtempSync(join(tmpdir(), 'agend-downgrade-'));
const results = [];
try {
  for (const [phase, executable, packageRoot] of [
    ['create', process.execPath, currentPackage],
    ['old', oldNode, oldPackage],
    ['return', process.execPath, currentPackage],
  ]) {
    // An explicit allowlist prevents bot tokens, NODE_OPTIONS and live IPC paths
    // from reaching the probes. No package bin, service or backend is executed.
    const env = {
      PATH: dirname(executable), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      AGEND_HOME: scratch, XDG_DATA_HOME: join(scratch, 'xdg'),
      KIRO_HOME: join(scratch, 'kiro-home'),
    };
    const result = spawnSync(executable, [join(here, 'data-downgrade-phase.mjs'), phase, packageRoot, scratch], {
      cwd: scratch, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, `${phase}: ${result.error}`);
    assert.equal(result.status, 0, `${phase}: ${result.stderr}\n${result.stdout}`);
    results.push(JSON.parse(result.stdout));
  }
  assert.equal(results[1].node.split('.')[0], BASELINES[baseline].node);
  assert.match(results[0].sqlitePackage, /^13\./);
  assert.match(results[1].sqlitePackage, BASELINES[baseline].sqlite);
  console.log(JSON.stringify({ baseline, phases: results, noFleetStarted: true }, null, 2));
} finally {
  // A runner-owned unique directory, never a path supplied by the caller.
  rmSync(scratch, { recursive: true, force: true });
}
