/** Approved signed-in Windows proof. Own scratch profile only; no fleet, account edits or capture files. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
const oldRoot = resolve(process.argv[2] || '../pane-upgrade-before');
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert(!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), 'Commit source first');
const mode = process.argv[3] || 'paired'; assert(['paired', 'local'].includes(mode));
const tag = randomUUID().slice(0, 8), root = '/mnt/c/Users/changhansung/agend-adapter-proto/upgrade-' + tag;
const nativeRoot = execFileSync('wslpath', ['-w', root], { encoding: 'utf8' }).trim();
const scratch = await mkdtemp(join(process.cwd(), '.artifacts/upgrade-native-'));
process.env.AGEND_HOME = scratch;
for (const key of ['NOTIFY_SOCKET', 'WATCHDOG_USEC', 'WATCHDOG_PID', 'TMUX']) delete process.env[key];
const load = (name, base = resolve('dist')) => import(pathToFileURL(join(base, name + '.js')).href);
const [{ RuntimeCoordinator }, { NativePaneManager }, { WindowsAgents }, { nativeInstanceConfig }, { LocalPaneEndpoint }, { runtimeJobDigest }, { PANE_TRANSCRIPT_EMPTY_ANCHOR }] =
 await Promise.all(['runtime-coordinator', 'native-pane-manager', 'windows-agents', 'native-instance-registry', 'local-pane-endpoint', 'runtime-client-store', 'runtime-pane-transcript-protocol'].map(n => load(n)));
const { NativePaneManager: OldManager } = await load('native-pane-manager', join(oldRoot, 'dist'));
const ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const nodePath = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("[Console]::Write((Get-Command node.exe -CommandType Application | Select-Object -First 1).Source)", 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000 }).trim();
const node = execFileSync('wslpath', ['-u', nodePath], { encoding: 'utf8' }).trim();
const worker = win32.join(nativeRoot, 'upgrade-worker.mjs');
let hub, server, runner, reader, endpoint, manager, native, machine = 'local', hostDirectory, phase = 'prepare', failed;
const receipt = { sourceHead, oldHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: oldRoot, encoding: 'utf8' }).trim(), mode, scratchCwd: nativeRoot,
 passed: false, turns: 0, archived: [] }, threads = new Set(), hostPids = new Set(), mutations = [], configs = new Map();
const delay = ms => new Promise(done => setTimeout(done, ms));
const until = async (check, label, timeout = 120000) => { const end = performance.now() + timeout; while (!await check()) { if (workerFailure) throw Error('Scratch worker: ' + JSON.stringify(workerFailure)); assert(performance.now() < end, 'Deadline: ' + label); await delay(200); } };
const inspect = action => { const value = JSON.parse(execFileSync(node, [worker, win32.join(nativeRoot, 'new'), nativeRoot, 'inspect', action, hostDirectory], { encoding: 'utf8', timeout: 45000, maxBuffer: 8192 })); if (value.pid) hostPids.add(value.pid); return value; };
const bridge = { get: () => null, prepareWorkspace() { throw Error('No exec'); }, start() { throw Error('No exec'); } };
const store = new WindowsAgents(scratch, bridge);
let program = 'old', workerFailure;
const mcp = (body, current) => manager.handle(machine, body, current);
const startTransport = async (pair = false) => {
 if (mode === 'local') {
  endpoint = await LocalPaneEndpoint.open({ scope: runtimeJobDigest({ proof: tag }), admit() {}, maxAgents: () => 4, version: () => 'codex-cli 0.165.0',
   mcp, launch: async () => spawn(node, [worker, win32.join(nativeRoot, program), nativeRoot, 'local'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] }) });
  hostDirectory = win32.join(nativeRoot, 'localdata', 'AgEnD', 'pane-adapter', runtimeJobDigest({ proof: tag }).slice(0, 16), 'state', 'pane-host');
 } else {
  const messages = []; workerFailure = null;
  runner = spawn(node, [worker, win32.join(nativeRoot, program), nativeRoot, 'paired'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  runner.stderr.resume(); reader = createInterface({ input: runner.stdout }); reader.on('line', line => { try { const value = JSON.parse(line); messages.push(value); if (value.failed) workerFailure = value; } catch {} });
  const pairing = pair ? hub.createPairing() : null;
  runner.stdin.write(JSON.stringify({ server: 'http://127.0.0.1:' + server.address().port, ...(pairing ? { code: pairing.code } : {}) }) + '\n');
  if (pair) {
   await until(() => messages.some(m => m.fingerprint), 'fingerprint'); const pending = hub.listMachines().filter(m => m.status === 'pending'); assert.equal(pending.length, 1);
   const fp = messages.find(m => m.fingerprint).fingerprint; assert.equal(pending[0].pairingFingerprint, fp); hub.approve(pending[0].id, fp);
  }
  await until(() => messages.some(m => m.ready), 'runner ready'); machine = messages.find(m => m.ready).machineId;
  await until(() => hub.machine(machine)?.status === 'online', 'machine online');
  endpoint = { machineId: machine, epoch: () => hub.machine(machine)?.connectionEpoch ?? 'scratch-epoch', online: () => hub.machine(machine)?.status === 'online',
   version: () => 'codex-cli 0.165.0', subscribe: listener => hub.subscribe(listener), call: request => hub.callPane(machine, request, 4) };
  hostDirectory = win32.join(nativeRoot, 'profile', 'pane-host');
 }
 const call = endpoint.call.bind(endpoint); endpoint.call = request => { if (['input', 'key', 'edit', 'open'].includes(request.action)) mutations.push({ action: request.action, launch: request.launch?.launchId }); return call(request); };
};
const stopTransport = async () => {
 if (mode === 'local') endpoint?.stop();
 else if (runner && runner.exitCode === null) { runner.stdin.write('{}\n'); await Promise.race([once(runner, 'exit'), delay(15000).then(() => { throw Error('Runner did not exit'); })]); reader.close(); }
};
const options = { home: scratch, store, config: name => configs.get(name), endpoint: async () => endpoint, admit() {}, instructions: () => 'Read-only isolated acceptance. Never use tools or modify files.',
 menu: () => [{ name: 'reply', description: 'Scratch acknowledgement', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }], allowed: () => true, published: () => true, invoke: async () => ({ result: 'Scratch acknowledgement' }) };
const create = async label => {
 const agent = await store.create({ name: label, cwd: nativeRoot, cli: 'codex', sandbox: 'read-only', model: 'gpt-6-luna', ...(mode === 'paired' ? { machineId: machine } : {}) });
 const name = 'upgrade-' + agent.id; store.bindInstance(agent.id, name); const config = { ...nativeInstanceConfig(agent), native_adapter: 'pane' }; configs.set(name, config); return { agent, name, config };
};
const acquire = async (owner, cls = NativePaneManager) => {
 manager = new cls(options); native = await manager.prepare(owner.name, owner.config, () => {});
 native.bindDaemon({ paneToolResponseWritten() {} }); await native.acquire(() => {}); const pin = store.get(owner.agent.id).threadId; assert(pin); threads.add(pin); return native.snapshot();
};
const count = async (pin, marker) => {
 let cursor = { sessionId: pin, offset: 0, fileId: null, anchor: PANE_TRANSCRIPT_EMPTY_ANCHOR }, user = 0, assistant = 0;
 for (let page = 0; page < 128; page++) {
  const batch = await native.port.readTranscript(cursor); assert(!batch.gap, 'Transcript gap'); if (batch.state !== 'ready') break;
  const records = Buffer.from(batch.data, 'base64').toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  for (const record of records) if (record.type === 'response_item' && (JSON.stringify(record.payload?.content) || '').includes(marker)) {
   if (record.payload.role === 'user') user++; if (record.payload.role === 'assistant') assistant++;
  }
  if (batch.complete || batch.cursor.offset === cursor.offset) break; cursor = batch.cursor;
 }
 return { user, assistant };
};
try {
 await mkdir(root); await cp(join(oldRoot, '.artifacts/runtime-bundle'), join(root, 'old'), { recursive: true });
 await cp('.artifacts/runtime-bundle', join(root, 'new'), { recursive: true }); await cp('scripts/manual/pane-host-recovery/upgrade-worker.mjs', join(root, 'upgrade-worker.mjs'));
 if (mode === 'paired') {
  hub = new RuntimeCoordinator(scratch, { requestTimeoutMs: 45000, handlePaneMcp: (machineId, body, current) => manager.handle(machineId, body, current) });
  server = createServer((req, res) => { if (!hub.handlePublicRequest(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  server.on('upgrade', (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
 }
 phase = 'old-real-turn'; await startTransport(true); const owner = await create('Old pane'); const before = await acquire(owner, OldManager), pin = before.sessionId;
 const marker = 'UPGRADE_' + tag; assert(await native.port.pasteText('Read-only scratch proof. Do not use tools. Reply exactly ' + marker));
 await until(async () => (await count(pin, marker)).assistant === 1, 'one real response'); assert.equal((await count(pin, marker)).user, 1); receipt.turns = 1;
 // Exercise a real coordinator ledger (not a provider mutation) so its old boot identity survives the upgrade.
 await manager.handle(machine, { op: 'pane-mcp', owner: { hostBootId: before.hostBootId, paneId: before.paneId, launchId: before.launchId, agentId: owner.agent.id, instance: owner.name },
  helperId: randomUUID(), method: 'tools/call', callId: 'a'.repeat(64), params: { name: 'reply', arguments: { text: 'Scratch acknowledgement' } } }, () => true);
 const ledger = join(scratch, 'native-panes', owner.agent.id, before.launchId + '.mcp.json');
 const hashLedger = async () => createHash('sha256').update(await readFile(ledger)).digest('hex'); const ledgerHash = await hashLedger();
 await native.release('detach'); await stopTransport(); program = 'new';
 phase = 'in-place-upgrade'; await startTransport(); manager = new NativePaneManager(options); const inputBefore = mutations.length;
 await assert.rejects(() => manager.prepare(owner.name, owner.config, () => {}), e => e.recovery?.kind === 'host-upgrade');
 assert.equal(mutations.length, inputBefore); assert.equal(store.get(owner.agent.id).paneRecovery.kind, 'host-upgrade'); receipt.oldHostHeldBeforeOpen = true;
 phase = 'host-loss'; const dead = inspect('kill-owned'); assert.equal(dead.alive, false); assert.equal(dead.processesAlive, 0); receipt.ownedHostTreeKilled = true;
 if (mode === 'local') { await until(() => !endpoint.online(), 'relay loss propagated'); receipt.deadLocalRelayOffline = true; await startTransport(); }
 else {
  // Keep this RuntimeClient alive: its next independent list must rediscover its dead cached link.
  await delay(1000); await endpoint.call({ action: 'list' }); receipt.pairedClientRediscovered = true;
 }
 manager = new NativePaneManager(options); const afterKillWrites = mutations.length;
 await assert.rejects(() => manager.prepare(owner.name, owner.config, () => {}), e => e.recovery?.kind === 'exit-unconfirmed');
 assert.equal(await hashLedger(), ledgerHash); assert.equal(mutations.length, afterKillWrites); receipt.oldLedgerUnchangedWhileHeld = true;
 // A held old launch must not poison the transport or prevent an unrelated new create on this computer.
 phase = 'independent-create'; const fresh = await create('Independent pane'); await acquire(fresh); const freshPin = store.get(fresh.agent.id).threadId, freshMarker = marker + '_NEW';
 assert(await native.port.pasteText('Read-only scratch proof. No tools. Reply exactly ' + freshMarker));
 await until(async () => (await count(freshPin, freshMarker)).assistant === 1, 'independent create response'); receipt.turns++;
 await native.release('close'); receipt.newCreateWhileOldHeld = true;
 phase = 'admin-recovery'; manager = new NativePaneManager(options); await manager.recover(owner.name, owner.config, before.launchId, true, () => {});
 assert.equal(store.get(owner.agent.id).activeId, undefined); assert.equal(await hashLedger(), ledgerHash);
 const resumed = await acquire(owner); assert.equal(resumed.sessionId, pin); assert.notEqual(resumed.launchId, before.launchId);
 assert.deepEqual(await count(pin, marker), { user: 1, assistant: 1 }); receipt.sameSessionNoInputReplay = true; receipt.oldLedgerUnchangedAfterRecovery = true;
 receipt.newHostBootProof = inspect('state').systemBootProof; assert(receipt.newHostBootProof);
 await native.release('close'); phase = 'cleanup';
 const inventory = await endpoint.call({ action: 'list' }); assert(inventory.panes.every(p => p.state === 'exited'));
 await endpoint.call({ action: 'shutdown', hostBootId: inventory.hostBootId }); await stopTransport(); receipt.passed = true;
} catch (error) {
 failed = error;
 try { const screen = await native?.port.capturePaneJoined(200); if (screen) for (const match of screen.matchAll(/\bSession:\s*([a-f0-9-]{36})\b/gi)) threads.add(match[1]); if (screen !== undefined) receipt.screen = { bytes: Buffer.byteLength(screen),
  clues: ['trust', 'login', 'sign in', 'update', 'error', 'model', 'permission', 'welcome', 'OpenAI Codex', 'Context', 'shortcuts'].filter(word => screen.toLowerCase().includes(word.toLowerCase())),
  composer: native.backend.readSteerComposer?.(screen), sessionLines: screen.split('\n').filter(line => /session|\/status/i.test(line)).map(line => line.replace(/[a-f0-9]{8}-[a-f0-9-]{27}/gi, '<session-uuid>').slice(0, 160)), dialogs: [...native.backend.getStartupDialogs(), ...native.backend.getRuntimeDialogs()].filter(d => d.pattern.test(screen) && (!d.isActive || d.isActive(screen))).map(d => d.type || d.description || 'detected') }; } catch {}
 receipt.phase = phase; receipt.error = error?.name; receipt.reason = String(error?.message).slice(0, 200);
} finally {
 try { await stopTransport(); } catch { receipt.transportCleanupUnconfirmed = true; }
 try { if (hostDirectory && inspect('state').alive) inspect('kill-owned'); } catch (e) { if (!String(e).includes('ENOENT')) receipt.hostCleanupNeedsInspection = true; }
 try { await until(() => { const value = JSON.parse(execFileSync(node, [worker, win32.join(nativeRoot, 'new'), nativeRoot, 'pids', JSON.stringify([...hostPids])], { encoding: 'utf8', timeout: 15000, maxBuffer: 4096 })); return value.alive.length === 0; }, 'owned host exit', 20000); } catch { receipt.hostCleanupNeedsInspection = true; }
 hub?.close(); if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
 try { const found = JSON.parse(execFileSync(node, [worker, win32.join(nativeRoot, 'new'), nativeRoot, 'sessions'], { encoding: 'utf8', timeout: 15000, maxBuffer: 16384 })); for (const id of found.ids) threads.add(id); } catch { receipt.sessionEnumerationUnconfirmed = true; }
 // UUIDs were bound by the real lifecycle /status plus scratch cwd and the one owned prompt above.
 for (const id of threads) {
  try { const output = execFileSync('/mnt/c/Users/changhansung/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe', ['-c', 'check_for_update_on_startup=false', 'archive', id],
   { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8192, input: '' });
  assert(output.includes('Archived session ' + id + '.')); receipt.archived.push(id); } catch { receipt.archiveFailed = [...(receipt.archiveFailed || []), id]; }
 }
 if (!receipt.hostCleanupNeedsInspection && !receipt.transportCleanupUnconfirmed && !receipt.archiveFailed && !receipt.sessionEnumerationUnconfirmed) { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); await rm(scratch, { recursive: true, force: true }); receipt.scratchRemoved = true; }
 await writeFile('.artifacts/pane-upgrade-' + mode + '-receipt.json', JSON.stringify(receipt, null, 2) + '\n'); process.stdout.write(JSON.stringify(receipt) + '\n');
}
if (failed || !receipt.passed || !receipt.scratchRemoved) process.exitCode = 1;
