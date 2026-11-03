/** Requires explicit signed-in Windows test approval. Fresh profile, loopback coordinator, no fleet or systemd. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const compiled = resolve('dist'), bundle = resolve('.artifacts/runtime-bundle'), tag = randomUUID().slice(0, 8);
const root = '/mnt/c/Users/changhansung/agend-adapter-proto/recovery-' + tag;
const nativeRoot = 'C:\\Users\\changhansung\\agend-adapter-proto\\recovery-' + tag;
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert(!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), 'Commit source before acceptance');
const home = await mkdtemp(join(process.cwd(), '.artifacts/recovery-native-'));
process.env.AGEND_HOME = home;
for (const name of ['NOTIFY_SOCKET', 'WATCHDOG_USEC', 'WATCHDOG_PID', 'TMUX']) delete process.env[name];
const load = name => import(pathToFileURL(join(compiled, name + '.js')).href);
const [{ RuntimeCoordinator }, { RuntimeNativePaneLifecycle }, { PANE_TRANSCRIPT_EMPTY_ANCHOR }] = await Promise.all(
  ['runtime-coordinator', 'native-pane-lifecycle', 'runtime-pane-transcript-protocol'].map(load));
let hub = new RuntimeCoordinator(home, { requestTimeoutMs: 45000 }), runner, reader, closed = false, phase = 'pair', native;
const messages = [], mutations = [], launches = [], receipt = { sourceHead, kind: 'paired-real-windows-pane-recovery', scratchTag: tag, passed: false };
const until = async (check, label, timeout = 90000) => {
  const deadline = performance.now() + timeout;
  while (!await check()) {
    if (messages.some(row => row.kind === 'failed') || closed) throw Error('Scratch runner failed');
    if (performance.now() > deadline) throw Error('Scratch proof deadline: ' + label);
    await new Promise(done => setTimeout(done, 250));
  }
};
const control = async (action, kind = action) => {
  const from = messages.length; runner.stdin.write(JSON.stringify({ action }) + '\n');
  await until(() => messages.slice(from).some(row => row.kind === kind), 'runner ' + action);
  return messages.slice(from).find(row => row.kind === kind);
};
const server = createServer((req, res) => { if (!hub.handlePublicRequest(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
server.on('upgrade', (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let machine, endpoint, pin, options, cursor, refusedOpen, marker = 'PANE_RECOVERY_' + tag;
try {
  await mkdir(root); await cp(bundle, join(root, 'bundle'), { recursive: true });
  await cp('scripts/manual/pane-host-recovery/runner.mjs', join(root, 'runner.mjs'));
  const ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const code = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::Write((Get-Command node.exe -CommandType Application | Select-Object -First 1).Source)";
  const nativeNode = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000, maxBuffer: 8192 }).trim();
  const node = execFileSync('wslpath', ['-u', nativeNode], { encoding: 'utf8', timeout: 5000 }).trim();
  runner = spawn(node, [win32.join(nativeRoot, 'runner.mjs'), win32.join(nativeRoot, 'bundle'), nativeRoot], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  runner.stderr.resume(); runner.once('close', () => { closed = true; });
  reader = createInterface({ input: runner.stdout }); reader.on('line', line => { try { messages.push(JSON.parse(line)); } catch { messages.push({ kind: 'failed' }); } });
  const pair = hub.createPairing(); runner.stdin.write(JSON.stringify({ server: 'http://127.0.0.1:' + server.address().port, code: pair.code }) + '\n');
  await until(() => messages.some(row => row.kind === 'fingerprint'), 'pair fingerprint');
  const pending = hub.listMachines().filter(row => row.status === 'pending'); assert.equal(pending.length, 1);
  const fingerprint = messages.find(row => row.kind === 'fingerprint').fingerprint;
  assert.equal(pending[0].pairingFingerprint, fingerprint); hub.approve(pending[0].id, fingerprint);
  await until(() => messages.some(row => row.kind === 'paired'), 'paired');
  const paired = messages.find(row => row.kind === 'paired'); machine = paired.machineId;
  assert.equal(paired.version, '0.165.0'); receipt.codexVersion = paired.version;
  await until(() => hub.machine(machine)?.status === 'online', 'online');
  endpoint = { machineId: machine, online: () => hub.machine(machine)?.status === 'online', subscribe: listener => hub.subscribe(listener),
    call: request => { if (['input', 'key', 'edit'].includes(request.action)) mutations.push(request.action); return hub.callPane(machine, request, 4); } };
  const config = { paneId: randomUUID(), launchId: randomUUID(), agentId: randomUUID(), instance: 'recovery-' + tag,
    cli: 'codex', cwd: nativeRoot, sandbox: 'read-only', model: 'gpt-6-luna', columns: 120, rows: 40 };
  options = { endpoint, launch: config, receiptFile: join(home, 'pane.json'), admit: () => assert(endpoint.online()), reserve() {},
    pin: (_launchId, id) => { assert(!pin || pin === id); pin = id; }, exited() {}, releaseAuthority() {}, mcpProof: () => 'unknown' };
  phase = 'real-turn'; native = new RuntimeNativePaneLifecycle(options); await native.acquire(() => {});
  launches.push(native.snapshot()); assert(pin);
  cursor = { sessionId: pin, offset: 0, fileId: null, anchor: PANE_TRANSCRIPT_EMPTY_ANCHOR };
  assert(await native.port.pasteText('Read-only scratch acceptance. Do not use tools or change files. Reply exactly ' + marker));
  const counts = async () => {
    let current = cursor, user = 0, assistant = 0, recordsRead = 0;
    for (let page = 0; page < 128; page++) {
      receipt.lastRead = { state: 'requested', page, user, assistant, recordsRead };
      const batch = await native.port.readTranscript(current);
      receipt.lastRead = { state: batch.state, complete: batch.complete, gap: batch.gap, page, user, assistant, recordsRead };
      assert(!batch.gap, 'Cannot prove turn counts across a transcript gap');
      if (batch.state !== 'ready') break;
      const records = Buffer.from(batch.data, 'base64').toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      recordsRead += records.length;
      const role = name => records.filter(row => row.type === 'response_item' && row.payload?.role === name && JSON.stringify(row.payload.content).includes(marker)).length;
      user += role('user'); assistant += role('assistant');
      receipt.lastRead = { state: batch.state, complete: batch.complete, gap: batch.gap, page, user, assistant, recordsRead };
      if (batch.complete || batch.cursor.offset === current.offset) break;
      current = batch.cursor;
    }
    const pane = await native.port.capturePane();
    receipt.lastScreen = { busy: native.backend.getBusyPattern().test(pane),
      errors: native.backend.getErrorPatterns().filter(row => row.pattern.test(pane)).map(row => row.type),
      dialog: [...native.backend.getStartupDialogs(), ...native.backend.getRuntimeDialogs()].some(row => row.pattern.test(pane) && (!row.isActive || row.isActive(pane))) };
    return { user, assistant };
  };
  await until(async () => (await counts()).assistant === 1, 'one real response'); assert.equal((await counts()).user, 1);
  receipt.oneMinimalTurn = true;
  const before = native.snapshot(), writes = mutations.length;
  refusedOpen = { action: 'open', operationId: randomUUID(), launch: { ...config, paneId: randomUUID(), agentId: randomUUID(), launchId: randomUUID() } };
  const refused = await hub.callPane(machine, refusedOpen, 1);
  assert(refused.noLaunch && refused.state === 'exited'); receipt.realHostNoLaunchReceipt = true;
  await native.release('detach'); await control('relay-restart', 'restarted');
  await until(() => endpoint.online(), 'relay reconnect');
  // Model a lost coordinator snapshot without changing its retained launch or open id. No provider data is copied.
  const saved = JSON.parse(await readFile(options.receiptFile, 'utf8')); delete saved.snapshot;
  await writeFile(options.receiptFile, JSON.stringify(saved), { mode: 0o600 });
  native = new RuntimeNativePaneLifecycle(options); assert.equal((await native.acquire(() => {})).disposition, 'reattached');
  assert.equal(native.snapshot().launchId, before.launchId); assert.equal(native.snapshot().hostBootId, before.hostBootId);
  assert.equal(mutations.length, writes); assert.equal((await counts()).user, 1);
  receipt.relayRestartSamePane = true; receipt.hostOriginReattachWithoutLocalSnapshot = true;
  phase = 'coordinator-restart'; await native.release('detach'); hub.close(); hub = new RuntimeCoordinator(home, { requestTimeoutMs: 45000 });
  await until(() => endpoint.online(), 'coordinator reconnect');
  native = new RuntimeNativePaneLifecycle(options); await native.acquire(() => {});
  assert.equal(native.snapshot().launchId, before.launchId); assert.equal(mutations.length, writes); assert.equal((await counts()).user, 1);
  receipt.coordinatorRestartNoReplay = true;
  phase = 'offline-exit'; await native.release('detach'); hub.close();
  await control('exit-offline', 'offline-exit'); hub = new RuntimeCoordinator(home, { requestTimeoutMs: 45000 });
  await until(() => endpoint.online(), 'exit reconnect');
  const inventory = await endpoint.call({ action: 'list' }), ended = inventory.panes.find(row => row.paneId === before.paneId);
  assert.equal(ended.launchId, before.launchId); assert.equal(ended.state, 'exited'); assert.equal(ended.sessionId, pin);
  const retainedRefusal = await hub.callPane(machine, refusedOpen, 4);
  assert(retainedRefusal.noLaunch && retainedRefusal.state === 'exited' && retainedRefusal.reattached);
  receipt.refusalNeverBecomesLaunch = true;
  receipt.positiveOfflineExit = true;
  phase = 'resume';
  options = { ...options, launch: { ...config, paneId: randomUUID(), launchId: randomUUID(), sessionId: pin }, receiptFile: join(home, 'resume.json') };
  native = new RuntimeNativePaneLifecycle(options); await native.acquire(() => {}); launches.push(native.snapshot());
  assert.equal(native.snapshot().sessionId, pin); assert.notEqual(native.snapshot().launchId, before.launchId);
  assert.equal((await counts()).user, 1); receipt.resumeSameConversation = true;
  phase = 'switch-off'; await control('state'); await native.release('close'); await hub.shutdownPaneHosts();
  await until(async () => { const state = await control('state'); return !state.descriptorPresent && state.hostsAlive === 0; }, 'empty host exits');
  receipt.switchOffHostExited = true;
  phase = 'switch-on';
  const empty = await endpoint.call({ action: 'list' }); assert.notEqual(empty.hostBootId, before.hostBootId);
  assert(empty.panes.every(row => row.state === 'exited')); receipt.switchOnNewHost = true;
  const restartedHost = await control('state'); assert(restartedHost.descriptorPresent && restartedHost.hostsAlive === 1);
  // No second real turn is needed; unit tests cover no-launch/refusal/unknown boundaries.
  await hub.shutdownPaneHosts(); await control('close', 'closed'); await until(() => closed, 'runner exit');
  receipt.passed = true;
} catch (error) {
  receipt.phase = phase; receipt.failureClass = error?.name;
  receipt.failureAt = [...String(error?.stack).matchAll(/acceptance\.mjs:(\d+):(\d+)/g)].map(match => `${match[1]}:${match[2]}`);
}
finally {
  if (runner && !closed) {
    try { await native?.release('detach'); await control('close', 'closed'); await until(() => closed, 'cleanup runner', 25000); } catch { receipt.ownedScratchRetained = true; }
  }
  reader?.close(); hub.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
  receipt.runnerExited = closed;
  if (closed && !receipt.ownedScratchRetained) { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await rm(home, { recursive: true, force: true }); receipt.scratchRemoved = true; }
  await writeFile('.artifacts/pane-recovery-native-receipt.json', JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify(receipt) + '\n');
}
if (!receipt.passed || !closed || !receipt.scratchRemoved) process.exitCode = 1;
