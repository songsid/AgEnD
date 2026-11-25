// Child of check-request-context-downgrade.mjs: original published code, isolated data, no Fleet/backend execution.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [packageRoot, scratch, mode] = process.argv.slice(2);
assert.equal(resolve(scratch), process.env.AGEND_HOME);
assert.match(scratch, /[/\\]agend-request-context-[^/\\]+[/\\][^/\\]+$/);
assert.ok(['off', 'active-queued', 'active-claimed', 'active-empty'].includes(mode));
const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
assert.ok(['2.3.3', '2.4.0-beta.22', '2.4.0-beta.23'].includes(version));
assert.match(process.versions.node, /^22\./);
let forbidden = 0;
const refuse = api => () => { forbidden++; throw Error(`Forbidden probe API: ${api}`); };
for (const api of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[api] = refuse(api);
net.Socket.prototype.connect = refuse('connect');
http.request = http.get = refuse('http'); https.request = https.get = refuse('https'); globalThis.fetch = refuse('fetch');
syncBuiltinESMExports();
const require = createRequire(join(packageRoot, 'package.json'));
const Database = require('better-sqlite3');
const sqlite = require('better-sqlite3/package.json').version;
assert.match(sqlite, /^13\./);
const { DeliveryOutbox } = await import(pathToFileURL(join(packageRoot, 'dist/delivery-outbox.js')).href);
const path = join(scratch, 'delivery-outbox.db');
const snapshot = () => { const db = new Database(path, { readonly: true }); try {
  return JSON.stringify(['deliveries', 'delivery_attempts', 'human_delivery_receipts'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
} finally { db.close(); } };
const before = snapshot();
let recovered = false, claimed = 0, dispatchCallbacks = 0, startupPublished = false;
const errors = [];
const blocked = fn => { try { fn(); assert.fail('old code unexpectedly wrote scoped work'); }
  catch (error) { const causes = []; for (let e = error; e; e = e.cause) causes.push(String(e));
    assert.match(causes.join('\n'), /no such function: agend_request_context_dispatch_version/); errors.push('missing-dispatch-function'); } };
let outbox;
try {
  outbox = new DeliveryOutbox(path, 'old-probe');
  if (mode === 'off') {
    outbox.recoverForBoot('old-probe'); recovered = true;
    const next = outbox.claimNext('old-probe', () => 'target-boot', new Set());
    assert.ok(next); claimed++;
    if (outbox.begin(next.deliveryId, 'target-boot', next.attemptNo) === 'begun') dispatchCallbacks++;
    assert.equal(dispatchCallbacks, 1);
  } else {
    blocked(() => outbox.recoverForBoot('old-probe'));
    if (mode === 'active-queued') {
      blocked(() => outbox.claimNext('old-probe', () => 'target-boot', new Set()));
      const [row] = outbox.listPending(); assert.ok(row);
      assert.equal(outbox.begin(row.deliveryId, 'target-boot', 1), 'stale');
    }
    if (mode === 'active-claimed') {
      const [row] = outbox.listPending(); assert.ok(row);
      blocked(() => outbox.begin(row.deliveryId, 'target-boot', row.attemptNo));
    }
    blocked(() => outbox.admit({ operationId: 'old-new-op', sourceKey: 'old-new-key', sourceInstance: 'source',
      sourceDaemonBootId: 'source-boot', targetInstance: 'worker', kind: 'fleet_inbound', payload: { type: 'fleet_inbound', content: 'Another synthetic input' } }));
    assert.equal(snapshot(), before);
  }
} finally { outbox?.close(); }
if (mode !== 'off') {
  // Execute the original startup recovery helper; no services, adapters, daemons or model processes are started.
  const { FleetManager } = await import(pathToFileURL(join(packageRoot, 'dist/fleet-manager.js')).href);
  const manager = Object.assign(Object.create(FleetManager.prototype), { dataDir: scratch, managerBootId: 'old-startup',
    logger: { error() {}, warn() {}, info() {} } });
  blocked(() => manager.ensureDeliveryOutbox());
  startupPublished = !!manager.deliveryOutbox;
  assert.equal(startupPublished, false); assert.equal(snapshot(), before);
}
assert.equal(forbidden, 0); assert.equal(claimed, mode === 'off' ? 1 : 0); assert.equal(dispatchCallbacks, mode === 'off' ? 1 : 0);
console.log(JSON.stringify({ version, node: process.versions.node, sqlite, mode, recovered, claimed, dispatchCallbacks,
  startupPublished, guardedFailures: errors.length, rowsUnchanged: mode === 'off' ? null : snapshot() === before, forbiddenCalls: forbidden }));
