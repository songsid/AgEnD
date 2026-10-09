import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [phase, packageRoot, scratch] = process.argv.slice(2);
assert.ok(['create', 'old', 'return'].includes(phase));
assert.equal(resolve(scratch), process.env.AGEND_HOME);
assert.match(scratch, /[/\\]agend-downgrade-[^/\\]+$/);
if (phase === 'old') assert.match(process.versions.node, /^20\./);
// Fail before native execution, even if a future leaf-module import starts a
// probe. Both ESM and CJS imports see the guard. No inspector, adapters or tmux.
for (const api of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[api] = () => { throw new Error(`Forbidden process API in data-only probe: ${api}`); };
}
syncBuiltinESMExports();
try { writeFileSync('/proc/self/coredump_filter', '0'); } catch { /* non-Linux */ }
const load = relative => import(pathToFileURL(join(packageRoot, 'dist', relative)).href);
const require = createRequire(join(packageRoot, 'package.json'));
const Database = require('better-sqlite3');
const sqlitePackage = require('better-sqlite3/package.json').version;
const yaml = require('js-yaml');
const { DeliveryOutbox } = await load('delivery-outbox.js');
const { SchedulerDb } = await load('scheduler/db.js');
const { EventLog } = await load('event-log.js');
const { loadFleetConfig, loadRawFleetConfig } = await load('config.js');
const statePath = join(scratch, 'probe-state.json');
const state = phase === 'create' ? {} : JSON.parse(readFileSync(statePath, 'utf8'));
const outboxPath = join(scratch, 'delivery-outbox.db');
const schedulerPath = join(scratch, 'scheduler.db');
const eventsPath = join(scratch, 'events.db');
const outbox = new DeliveryOutbox(outboxPath, `${phase}-manager`);
const scheduler = new SchedulerDb(schedulerPath);
const events = new EventLog(eventsPath);
const checks = [];
const checked = (label, fn) => { fn(); checks.push(label); };
const admit = (target, key) => outbox.admit({
  operationId: key, sourceKey: key, sourceInstance: 'scratch-source', sourceDaemonBootId: 'scratch-source-boot',
  targetInstance: target, kind: 'fleet_inbound', correlationId: key,
  payload: { type: 'fleet_inbound', content: key, meta: { message_id: key, requires_reply: 'true' } },
}).delivery;
function claim(target) {
  const row = outbox.claimNext(`${phase}-manager`, t => t === target ? 'scratch-target-boot' : null, new Set());
  assert.ok(row, target);
  return row;
}
function terminal(target, key, outcome) {
  const row = admit(target, key);
  const owner = claim(target);
  assert.equal(owner.deliveryId, row.deliveryId);
  assert.equal(outbox.begin(row.deliveryId, owner.targetDaemonBootId, owner.attemptNo), 'begun');
  assert.equal(outbox.complete(row.deliveryId, owner.targetDaemonBootId, owner.attemptNo, outcome, 'scratch evidence'), true);
  return owner;
}
function schedule(label) {
  return scheduler.create({ cron: '0 0 * * *', message: label, source: 'scratch-source', target: label,
    reply_chat_id: '-100123', reply_thread_id: '7', reply_adapter_id: 'scratch-world' });
}
if (phase === 'create') {
  checked('new delivery consumption and acknowledgement metadata', () => {
    const delivered = terminal('consumed', 'new-consumed', 'delivered');
    assert.equal(outbox.markConsumed(delivered.deliveryId, delivered.targetDaemonBootId, delivered.attemptNo, 'mid_turn', 'scratch'), 'marked');
    const uncertain = terminal('attention', 'new-attention', 'uncertain');
    assert.equal(outbox.acknowledge(uncertain.deliveryId, 'scratch-admin'), true);
    state.consumed = delivered.deliveryId; state.attention = uncertain.deliveryId;
    const claimed = admit('claimed', 'claimed-before-crash'); claim('claimed'); state.claimed = claimed.deliveryId;
    const begun = admit('begun', 'begun-before-crash'); const c = claim('begun');
    assert.equal(outbox.begin(begun.deliveryId, c.targetDaemonBootId, c.attemptNo), 'begun'); state.begun = begun.deliveryId;
  });
  checked('new retry table, tasks and decisions', () => {
    const keep = schedule('keep-retry'); const remove = schedule('delete-retry');
    state.keepSchedule = keep.id; state.removeSchedule = remove.id;
    for (const row of [keep, remove]) scheduler.putRetry({ schedule_id: row.id, run_id: `run-${row.id}`,
      deferred_at_ms: 1, deferred_pct: 99, resets_at_ms: null, due_at_ms: 2, deadline_ms: 3, deadline_kind: 'cap' });
    scheduler.recordRun(keep.id, 'deferred → delivered (retry)', 'scratch-only history');
    state.decision = scheduler.createDecision({ project_root: scratch, scope: 'fleet', title: 'scratch decision', content: 'retained', tags: ['scratch'], created_by: 'scratch-source' }).id;
    state.task = scheduler.createTask({ title: 'scratch task', created_by: 'scratch-source', priority: 'urgent' }).id;
  });
  checked('event log and reaction queue', () => {
    events.insert('scratch', 'new-event', { sentinel: 42 });
    events.logActivity('new-activity', 'scratch', 'retained');
    events.addReaction('scratch', 'scratch-message', 'scratch-user', '👍');
  });
  const kiro = await load('backend/kiro-agent.js');
  state.spec = { workingDirectory: join(scratch, 'workspace'), instance: 'worker', fleet: kiro.kiroFleetTag(scratch),
    instanceDir: join(scratch, 'instances', 'worker'), serverNames: ['agend'] };
  mkdirSync(state.spec.instanceDir, { recursive: true });
  const agentPath = kiro.writeKiroAgent(state.spec, 'scratch instructions');
  state.agentText = readFileSync(agentPath, 'utf8'); writeFileSync(`${agentPath}.bak`, state.agentText);
  // Owned helper writes only the pointer. No hub start or adapter method is called.
  const { NeedsYouHub } = await load('needs-you-hub.js');
  const hub = new NeedsYouHub({ dataDir: scratch, log() {} });
  hub.writePointer('scratch-world', { chatId: '-100123', messageId: '42', threadId: '7' });
  state.pointerText = readFileSync(join(scratch, 'needs-you-message.json'), 'utf8');
  const { SettingsConfirmationStore } = await load('settings-confirmation.js');
  let effects = 0;
  const pending = new SettingsConfirmationStore({ audit() {} });
  pending.propose({ session: 'scratch-session', key: 'request', fingerprint: 'effect', section: 'access',
    requestedBy: 'scratch', source: 'web_session', summary: ['scratch-only'], bytes: 1,
    current: () => true, unchanged: async () => true, apply: async () => { effects++; } });
  assert.equal(pending.list('scratch-session').length, 1); pending.close();
  assert.equal(effects, 0); assert.equal(new SettingsConfirmationStore({ audit() {} }).list('scratch-session').length, 0);
  checks.push('pending is memory-only; stop never applies it');
  writeFileSync(join(scratch, 'fleet.yaml'), yaml.dump({
    needs_you: { live_message: true, dm: false }, extension_sentinel: 'unknown retained only in raw',
    web: { enabled: true, view_access: 'session', public_link: { ttl_minutes: 120, protocol: 'http2' } },
    channels: [{ id: 'A', platform: 'telegram', group_id: '-100123', access: { mode: 'locked', allowed_users: ['42'] } },
      { id: 'B', platform: 'discord', guild_id: '123', access: { mode: 'locked', allowed_users: ['43'] } }],
    instances: { worker: { backend: 'kiro-cli', working_directory: state.spec.workingDirectory } },
  }));
  const config = loadFleetConfig(join(scratch, 'fleet.yaml'));
  assert.deepEqual(config.needs_you, { live_message: true, dm: false });
  state.web = config.web; state.channelIds = config.channels.map(c => c.id);
  checks.push('new owned Kiro files, pointer and config created in scratch');
  writeFileSync(statePath, JSON.stringify(state));
} else if (phase === 'old') {
  checked('old recovery keeps begun work fenced and requeues only unbegun claims', () => {
    const result = outbox.recoverForBoot('old-manager');
    assert.equal(result.queued, 1); assert.equal(result.reconciliationPending, 1);
    assert.equal(outbox.get(state.claimed).state, 'queued');
    assert.equal(outbox.get(state.begun).state, 'reconciliation_pending');
    assert.equal(outbox.get(state.consumed).state, 'delivered');
    assert.equal(outbox.get(state.attention).state, 'uncertain');
    assert.equal(outbox.admit({ operationId: 'duplicate', sourceKey: 'new-consumed', sourceInstance: 'scratch-source', sourceDaemonBootId: 'scratch',
      targetInstance: 'consumed', kind: 'fleet_inbound', payload: {} }).inserted, false);
    state.oldDelivered = terminal('old-delivery', 'old-delivered', 'delivered').deliveryId;
  });
  checked('old scheduler accepts new history; deletion cascades the new retry', () => {
    assert.ok(scheduler.get(state.keepSchedule));
    assert.equal(scheduler.getRuns(state.keepSchedule)[0].status, 'deferred → delivered (retry)');
    scheduler.update(state.keepSchedule, { message: 'edited on old', enabled: false });
    scheduler.delete(state.removeSchedule);
    assert.equal(scheduler.getDecision(state.decision).content, 'retained');
    scheduler.claimTask(state.task, 'scratch-old'); scheduler.completeTask(state.task, 'old completion');
    state.oldSchedule = schedule('created-on-old').id;
  });
  checked('old event/reaction read-write', () => {
    assert.deepEqual(events.query({ type: 'new-event' })[0].payload, { sentinel: 42 });
    assert.ok(events.listActivity().some(row => row.event === 'new-activity'));
    const reaction = events.pendingReactions('scratch'); assert.ok(reaction); events.markReactionsConsumed('scratch', reaction.maxId);
    events.insert('scratch', 'old-event', { sentinel: 43 });
  });
  checked('raw YAML retained; old normalized rewrite loses new top-level fields', () => {
    const configPath = join(scratch, 'fleet.yaml'); const text = readFileSync(configPath, 'utf8');
    const config = loadFleetConfig(configPath); const raw = loadRawFleetConfig(configPath);
    assert.equal(config.needs_you, undefined); assert.ok(raw.needs_you);
    assert.deepEqual(config.web, state.web); assert.deepEqual(config.channels.map(c => c.id), state.channelIds);
    const rewritten = yaml.load(yaml.dump(config));
    assert.equal(rewritten.needs_you, undefined); assert.equal(rewritten.extension_sentinel, undefined);
    assert.equal(readFileSync(configPath, 'utf8'), text); // Do not replace the original fixture.
  });
  // Invoke only the file-writing prototype methods, never its binary-probing constructor.
  const { KiroBackend } = await load('backend/kiro.js');
  const workingDirectory = state.spec.workingDirectory;
  const shared = join(workingDirectory, '.kiro', 'settings'); mkdirSync(shared, { recursive: true });
  const steering = join(workingDirectory, '.kiro', 'steering'); mkdirSync(steering, { recursive: true });
  const foreignWrapper = join(scratch, 'foreign-wrapper'); writeFileSync(foreignWrapper, 'inert');
  writeFileSync(join(shared, 'mcp.json'), JSON.stringify({ mcpServers: { 'agend-worker': { command: foreignWrapper, args: [] } } }));
  writeFileSync(join(steering, 'agend-worker.md'), 'foreign fleet steering');
  const backend = { instanceDir: state.spec.instanceDir };
  const cfg = { workingDirectory, instanceName: 'worker', instructions: 'old replacement',
    mcpServers: { agend: { command: 'inert-not-executed', args: [], env: {} } } };
  KiroBackend.prototype.writeConfig.call(backend, cfg);
  assert.notEqual(JSON.parse(readFileSync(join(shared, 'mcp.json'), 'utf8')).mcpServers['agend-worker'].command, foreignWrapper);
  assert.equal(readFileSync(join(steering, 'agend-worker.md'), 'utf8'), 'old replacement');
  KiroBackend.prototype.cleanup.call(backend, cfg);
  assert.equal(existsSync(join(steering, 'agend-worker.md')), false);
  assert.equal(JSON.parse(readFileSync(join(shared, 'mcp.json'), 'utf8')).mcpServers['agend-worker'], undefined);
  checks.push('old shared Kiro writers lack ownership; new agent artifacts untouched');
  writeFileSync(statePath, JSON.stringify(state));
} else {
  checked('new consumption/ack metadata survives old writes; old delivery remains readable', () => {
    const inspect = new Database(outboxPath, { readonly: true });
    try {
      assert.equal(inspect.prepare('SELECT consumed_via FROM deliveries WHERE delivery_id=?').get(state.consumed).consumed_via, 'mid_turn');
      assert.equal(inspect.prepare('SELECT acknowledged_by FROM deliveries WHERE delivery_id=?').get(state.attention).acknowledged_by, 'scratch-admin');
      assert.equal(inspect.prepare('SELECT consumed_at FROM deliveries WHERE delivery_id=?').get(state.oldDelivered).consumed_at, null);
    } finally { inspect.close(); }
    assert.equal(outbox.get(state.oldDelivered).state, 'delivered');
    assert.equal(outbox.needsAttention('1970-01-01T00:00:00.000Z').some(r => r.deliveryId === state.attention), false);
    assert.equal(outbox.get(state.begun).state, 'reconciliation_pending');
  });
  checked('retained retry stays readable, deleted schedule retry is gone, task result survives', () => {
    assert.equal(scheduler.getRetry(state.keepSchedule).run_id, `run-${state.keepSchedule}`);
    assert.equal(scheduler.getRetry(state.removeSchedule), null);
    assert.equal(scheduler.get(state.keepSchedule).enabled, false);
    assert.equal(scheduler.get(state.keepSchedule).message, 'edited on old');
    assert.ok(scheduler.get(state.oldSchedule)); assert.equal(scheduler.getTask(state.task).status, 'done');
  });
  checked('new event reads old write; consumed reaction stays consumed', () => {
    assert.deepEqual(events.query({ type: 'old-event' })[0].payload, { sentinel: 43 });
    assert.equal(events.pendingReactions('scratch'), null);
  });
  const kiro = await load('backend/kiro-agent.js');
  checked('new Kiro agent and backup byte-preserved; pointer is not acknowledgement authority', () => {
    const path = kiro.kiroAgentPath(state.spec);
    assert.equal(readFileSync(path, 'utf8'), state.agentText); assert.equal(readFileSync(`${path}.bak`, 'utf8'), state.agentText);
    assert.equal(kiro.isOwnKiroAgent(JSON.parse(state.agentText), state.spec), true);
    assert.equal(readFileSync(join(scratch, 'needs-you-message.json'), 'utf8'), state.pointerText);
  });
  const { NeedsYouHub } = await load('needs-you-hub.js');
  const hub = new NeedsYouHub({ dataDir: scratch, log() {} });
  assert.deepEqual(hub.readPointers()['scratch-world'], { chatId: '-100123', messageId: '42', threadId: '7' });
  assert.equal(hub.acks.size, 0);
}
outbox.close(); scheduler.close(); events.close();
const versions = {};
for (const [label, path] of [['outbox', outboxPath], ['scheduler', schedulerPath], ['events', eventsPath]]) {
  const db = new Database(path);
  checked(`${label} integrity and foreign keys`, () => {
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []);
  });
  versions[label] = db.pragma('user_version', { simple: true }); db.close();
}
assert.equal(versions.outbox, phase === 'old' ? 4 : 5);
console.log(JSON.stringify({ phase, node: process.versions.node, sqlitePackage, userVersion: versions, checks }));
