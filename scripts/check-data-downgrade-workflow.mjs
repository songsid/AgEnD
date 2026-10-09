// Exercise the checked-in workflow command with a genuinely failing probe.
// Never runs a fleet, backend, or valid data compatibility phase.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = yaml.load(readFileSync(join(repo, '.github/workflows/data-downgrade.yml'), 'utf8'));
const steps = workflow.jobs['data-downgrade'].steps.filter(step => step.id === 'roundtrip');
assert.equal(steps.length, 1, 'There must be one authoritative roundtrip step');
const step = steps[0];
assert.equal(typeof step.run, 'string');
assert.ok(step.shell === undefined || step.shell === 'bash', 'Model only the workflow Linux bash shells');

// Match GitHub's documented Linux shell behavior: unspecified is bash -e;
// explicit shell: bash is bash --noprofile --norc -e -o pipefail.
// Derive this from the real step so removing its shell declaration goes red.
const flags = step.shell === 'bash'
  ? ['--noprofile', '--norc', '-e', '-o', 'pipefail']
  : ['-e'];
const scratch = mkdtempSync(join(tmpdir(), 'agend-downgrade-workflow-'));
try {
  symlinkSync(join(repo, 'scripts'), join(scratch, 'scripts'), 'dir');
  const result = spawnSync('bash', [...flags, '-c', step.run], {
    cwd: scratch,
    // Empty baseline arguments make the actual runner fail its first assertion,
    // before it imports stores or creates a data directory. No tokens inherited.
    env: {
      PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', OLD_PACKAGE: '', OLD_NODE: '',
    },
    encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024,
  });
  assert.equal(result.error, undefined, `Workflow shell failed to run: ${result.error}`);
  assert.match(result.stderr, /AssertionError/, 'The real probe must actually fail, not a missing executable');
  assert.equal(result.status, 1, 'A failed probe must fail the workflow step even when tee succeeds');
  assert.equal(readFileSync(join(scratch, 'data-downgrade.json'), 'utf8'), '', 'An empty artifact is not proof of success');
  console.log(JSON.stringify({ negativeProbe: 'AssertionError', workflowShell: step.shell, pipelineExitCode: result.status }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
