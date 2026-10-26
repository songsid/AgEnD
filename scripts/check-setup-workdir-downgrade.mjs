// #2726: what the setup page writes for an agent given no working directory — its own workspace, written as the absolute
// path <AGEND_HOME>/workspaces/<name> — loads unchanged on the published rollback loaders (2.3.1, 2.2.6): the same shape
// every release writes. Web only and with a bot. Pure: no fleet, CLI, account or process use.
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
const home = mkdtempSync(join(tmpdir(), 'agend-setup-workdir-downgrade-'));
process.env.AGEND_HOME = home;
const { draftQuickstart, draftWebOnly, planQuickstart, validateWizardInput, withWorkingDirectory } = await import('../dist/quickstart-api.js');
const want = join(home, 'workspaces', 'agent-1');
const WEB = { web_only: true, backend: 'claude-code', working_directory: '', instance_name: 'agent-1' };
const BOT = { platform: 'telegram', token_env: 'AGEND_BOT_TOKEN', backend: 'claude-code', working_directory: '', instance_name: 'agent-1', group_id: '-100123', admin_user_id: '42' };
const written = [];
for (const body of [WEB, BOT]) {
  assert.equal(validateWizardInput(body), null);
  const input = withWorkingDirectory(body), blank = { defaults: {}, instances: {} };
  const draft = body.web_only ? draftWebOnly(blank, input)
    : draftQuickstart(blank, input, planQuickstart(input, { backends: [], has_fleet: false, channels: [] }));
  assert.equal(draft.instances['agent-1'].working_directory, want);
  written.push({ kind: body.web_only ? 'web' : 'bot', text: yaml.dump(draft, { quotingType: '"', forceQuotes: false }) });
}
const roots = process.argv.slice(2); assert.ok(roots.length, 'pass published package roots');
let checked = 0;
try {
  for (const root of roots) {
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    assert.ok(['2.3.1', '2.2.6'].includes(version), `unexpected rollback version ${version}`);
    const { validateFleetConfig } = await import(pathToFileURL(join(resolve(root), 'dist/config-validator.js')).href);
    const { loadFleetConfig } = await import(pathToFileURL(join(resolve(root), 'dist/config.js')).href);
    for (const { kind, text } of written) {
      const file = join(home, `fleet-${version}-${kind}.yaml`); writeFileSync(file, text);
      const parsed = yaml.load(text);
      assert.equal(validateFleetConfig(parsed).valid, true, `${version} ${kind}: ${JSON.stringify(validateFleetConfig(parsed).errors)}`);
      assert.equal(loadFleetConfig(file).instances['agent-1'].working_directory, want, `${version} ${kind}: the same folder`);
      checked++;
    }
  }
} finally { rmSync(home, { recursive: true, force: true }); }
console.log(JSON.stringify({ setupWorkdirDowngrade: 'ok', checked }));
