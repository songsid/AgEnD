// Actual published outbox/startup helper probes. The runner alone chooses disposable data; no live AGEND_HOME argument.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const { DeliveryOutbox } = await import('../dist/delivery-outbox.js');
const packages = process.argv.slice(2).map(root => realpathSync(resolve(root)));
assert.equal(packages.length, 3, 'Supply published 2.3.3, beta.22 and beta.23 package roots');
assert.deepEqual(packages.map(p => JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).version).sort(),
  ['2.3.3', '2.4.0-beta.22', '2.4.0-beta.23']);
const root = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'agend-request-context-'));
const results = [];
try {
  for (const packageRoot of packages) for (const mode of ['off', 'active-queued', 'active-claimed', 'active-empty']) {
    const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
    const scratch = join(root, `${version}-${mode}`); mkdirSync(scratch);
    const outbox = new DeliveryOutbox(join(scratch, 'delivery-outbox.db'), 'current-probe', { requestContextDispatchVersion: 1 });
    outbox.createHumanReceipt({ targetInstance: 'worker', originalBody: 'Synthetic pending receipt', inputKind: 'fleet_inbound',
      managerBootId: 'previous-probe', origin: { platform: 'web', adapter_id: null, user_id: null, username: null, platform_message_id: null, ingress: 'web' } });
    if (mode !== 'active-empty') outbox.admit({ operationId: 'scoped-example', sourceKey: 'scoped-key', sourceInstance: 'source',
      sourceDaemonBootId: 'source-boot', targetInstance: 'worker', kind: 'fleet_inbound', payload: { type: 'fleet_inbound',
        content: 'On behalf of Demo guest. Synthetic fixture only; authority: none.', meta: { request_context_version: '1' } } });
    if (mode === 'active-claimed') assert.ok(outbox.claimNext('previous-probe', () => 'target-boot', new Set()));
    if (mode !== 'off') outbox.activateRequestContextBarrier(); outbox.close();
    // Explicit allowlist: no tokens, NODE_OPTIONS, IPC addresses or current account settings.
    const result = spawnSync(process.execPath, [join(here, 'request-context-downgrade-phase.mjs'), packageRoot, scratch, mode], {
      cwd: scratch, env: { PATH: dirname(process.execPath), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', AGEND_HOME: scratch,
        XDG_DATA_HOME: join(scratch, 'xdg'), KIRO_HOME: join(scratch, 'kiro') },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, 'Probe runtime must finish');
    assert.equal(result.status, 0, `${version}/${mode}: ${result.stderr}\n${result.stdout}`);
    results.push(JSON.parse(result.stdout));
  }
  console.log(JSON.stringify({ cases: results.length, results }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
