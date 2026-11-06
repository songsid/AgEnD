/** Run only in a scheduled Windows scratch window. Local fake server, dummy pairing, no CLI/account/policy/PATH changes. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from './ws/wrapper.mjs';
import { runtimeInstallCommand } from './runtime-commands.mjs';
if (process.platform !== 'win32') throw Error('Scheduled native Windows scratch scope required');
const input = dirname(fileURLToPath(import.meta.url)), scope = resolve(input, '..');
if (!/^agend-runtime-update-[a-f0-9]{32}$/.test(scope.split(/[\\/]/).at(-1))) throw Error('Use the reserved private scratch subtree');
const identities = JSON.parse(readFileSync(join(input, 'inputs.json'), 'utf8'));
const [a, b] = identities.map(value => ({ ...value, archive: readFileSync(join(input, `${value.label}.zip`)) }));
for (const value of [a, b]) assert.equal(createHash('sha256').update(value.archive).digest('hex'), value.sha256);
const template = readFileSync(join(input, 'install.ps1'), 'utf8');
const ownedChildren = new Set();
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(check, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  for (;;) { if (await check()) return; if (Date.now() > deadline) throw Error(`Timed out: ${label}`); await sleep(150); }
}
function execute(executable, args, env, log) {
  const child = spawn(executable, args, { shell: false, cwd: scope, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    windowsVerbatimArguments: basename(executable).toLowerCase() === 'cmd.exe' });
  const finished = new Promise((done, fail) => { child.once('error', fail); child.once('close', code => done(code)); });
  const owned = { child, finished }; ownedChildren.add(owned);
  void finished.finally(() => ownedChildren.delete(owned)).catch(() => {});
  child.stdout.on('data', bytes => log.push(bytes.toString())); child.stderr.on('data', bytes => log.push(bytes.toString()));
  return { child, finished };
}
const results = [];
for (const mode of ['busy', 'sha', 'forward', 'rollback', 'lost-ack']) {
  console.log(JSON.stringify({ leg: mode, step: 'start' }));
  const root = join(scope, mode); mkdirSync(root, { mode: 0o700 });
  const install = join(root, 'install'), profile = join(root, 'profile'), user = join(root, 'user');
  mkdirSync(user); mkdirSync(join(user, 'AppData', 'Local'), { recursive: true }); mkdirSync(join(user, 'AppData', 'Roaming'));
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  const env = { ...process.env, USERPROFILE: user, HOME: user, LOCALAPPDATA: join(user, 'AppData', 'Local'), APPDATA: join(user, 'AppData', 'Roaming'),
    PATH: `${dirname(process.execPath)};${join(systemRoot, 'System32')}`, AGEND_RUNTIME_NO_PATH: '1', AGEND_RUNTIME_INSTALL_DIR: install };
  const log = [], events = [], requests = [], proofs = new Map(), machineId = randomUUID();
  let target = a, generations = 0, normal = 0, trial = 0, busy = 0, activations = 0, activates = [], runner, observe, matches, acquire, store, scan, failure, runnerFailure;
  let holdArchive = false, heldArchive;
  const waitFor = (check, label) => until(() => { if (runnerFailure) throw runnerFailure; return check(); }, label);
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/runtime/install.ps1') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(template.replaceAll('@@AGEND_RUNTIME_VERSION@@', a.version).replaceAll('@@AGEND_RUNTIME_SHA256@@', a.sha256)); return;
    }
    res.setHeader('ETag', `"${target.version}-${target.sha256}"`);
    if (req.url === '/runtime/v1/bundle/windows.json') { res.end(JSON.stringify({ version: target.version, sha256: target.sha256, bytes: target.bytes })); return; }
    if (req.url === '/runtime/v1/bundle/windows.zip') {
      if (holdArchive) { heldArchive = res; return; }
      res.end(mode === 'sha' && target === b ? a.archive : target.archive); return;
    }
    res.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/runtime/v1/connect' || req.headers.authorization !== `Bearer ${'b'.repeat(64)}`) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      let generation;
      ws.on('message', bytes => {
        const frame = JSON.parse(bytes.toString());
        if (frame.type === 'hello') {
          generation = ++generations;
          if (frame.updateTrialId) {
            trial++; events.push({ type: 'trial', version: frame.runtimeInfo.version, id: frame.updateTrialId });
            if (mode === 'rollback') { ws.close(1008, 'Rehearsal candidate refused'); return; }
            assert.equal(frame.runtimeInfo.version, b.version);
          } else { normal++; events.push({ type: 'normal', version: frame.runtimeInfo.version }); }
          target = b; ws.send(JSON.stringify({ v: 1, type: 'welcome', machineId, generation, updateProtocol: 1 })); return;
        }
        if (frame.type !== 'update.control') return;
        events.push({ type: frame.phase, id: frame.id, generation: frame.generation }); assert.equal(frame.generation, generation);
        const response = phase => ws.send(JSON.stringify({ ...frame, phase }));
        if (frame.phase === 'prepare') { if (mode === 'busy') { busy++; response('busy'); } else response('prepared'); }
        if (frame.phase === 'ready') response('commit');
        if (frame.phase === 'cancel') response('cancelled');
        if (frame.phase === 'activate') {
          activates.push(frame.id);
          if (mode === 'lost-ack' && activates.length === 1) return;
          if (activations === 0) activations++; response('activated');
        }
      });
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pointer = () => readFileSync(join(install, 'bin/current.txt'), 'utf8');
  const folderA = `${a.version}+${a.sha256.slice(0, 8)}`, folderB = `${b.version}+${b.sha256.slice(0, 8)}`;
  function state() {
    const receipt = JSON.parse(readFileSync(join(install, '.agend-runtime-install.json'), 'utf8'));
    const file = join(profile, 'runtime-updates', receipt.id, machineId, 'runtime-update.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  }
  function recordProofs() {
    const dir = join(install, '.agend-runtime-owners');
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const owner = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      for (const proof of [owner.parent, owner.child].filter(Boolean)) proofs.set(JSON.stringify(proof), proof);
    }
  }
  try {
    const script = template.replaceAll('@@AGEND_RUNTIME_VERSION@@', a.version).replaceAll('@@AGEND_RUNTIME_SHA256@@', a.sha256);
    const command = runtimeInstallCommand(origin, createHash('sha256').update(script).digest('hex'));
    const encoded = Buffer.from(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${command}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`, 'utf16le').toString('base64');
    const installing = execute(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], env, log);
    assert.equal(await installing.finished, 0); assert.equal(pointer(), folderA);
    const receipt = JSON.parse(readFileSync(join(install, '.agend-runtime-install.json'), 'utf8')); assert.deepEqual(receipt.origins, [origin]); assert.equal(receipt.shared, false);
    const imported = await import(pathToFileURL(join(install, folderA, 'dist/runtime-client-store.js')));
    ({ observeRuntimeProcess: observe, runtimeProcessMatches: matches, acquireRuntimeInstallLock: acquire } = await import(pathToFileURL(join(install, folderA, 'dist/runtime-update-lock.js'))));
    if (mode === 'busy') {
      const lease = await acquire(install, { type: 'installer' });
      try {
        const conflict = execute(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], env, log);
        assert.notEqual(await conflict.finished, 0); lease.assert(); assert.equal(pointer(), folderA);
      } finally { lease.release(); }
      holdArchive = true;
      // A reinstall of an already selected tree skips downloading. Use a fresh owned probe root so the real download holds the lease.
      const probeRoot = join(root, 'lock-probe'), powershell = execute(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { ...env, AGEND_RUNTIME_INSTALL_DIR: probeRoot }, log);
      let probeEnded = false; void powershell.finished.then(() => { probeEnded = true; });
      await until(() => { if (probeEnded && !heldArchive) throw Error('PowerShell probe ended before holding the download'); return !!heldArchive; }, 'PowerShell-held download');
      const lockFile = join(probeRoot, '.agend-runtime-install.lock/owner.json'), proof = JSON.parse(readFileSync(lockFile, 'utf8'));
      assert.equal(matches(proof, await observe(proof.pid)), true);
      await assert.rejects(acquire(probeRoot, { type: 'supervisor' }), error => error.reason === 'held');
      holdArchive = false; heldArchive.end(a.archive); assert.equal(await powershell.finished, 0);
      // A positively ended PowerShell writer may be reclaimed by Node with the exact original proof.
      const lockDir = join(probeRoot, '.agend-runtime-install.lock'); mkdirSync(lockDir); writeFileSync(join(lockDir, 'owner.json'), JSON.stringify(proof));
      const stale = await acquire(probeRoot, { type: 'supervisor' }); stale.release();
      console.log(JSON.stringify({ leg: mode, step: 'native-shared-lock-controls-pass' }));
    }
    store = new imported.RuntimeClientStore(profile); store.saveCredentials({ server: origin, machineId, credential: 'b'.repeat(64), name: 'Fake rehearsal Runtime' });
    const credentials = readFileSync(join(profile, 'connection.json'), 'utf8');
    runner = execute(join(systemRoot, 'System32/cmd.exe'), ['/d', '/s', '/c', `""${join(install, 'bin/agend-runtime.cmd')}" run --profile "${profile}""`], env, log);
    void runner.finished.then(code => { if (code !== 0) runnerFailure = Error(`Scratch shim exited with ${code}`); });
    scan = setInterval(recordProofs, 100);
    if (mode === 'busy') { await waitFor(() => busy > 0, 'busy defer'); assert.equal(pointer(), folderA); assert.equal(trial, 0); assert.equal(normal, 1); }
    else if (mode === 'sha') { await waitFor(() => state()?.failed?.sha256 === b.sha256, 'SHA refusal'); assert.equal(pointer(), folderA); assert.equal(trial, 0); }
    else if (mode === 'rollback') { await waitFor(() => normal >= 2 && state()?.failed?.sha256 === b.sha256, 'automatic rollback'); assert.equal(pointer(), folderA); assert.equal(trial, 1); assert.equal(activations, 0); }
    else { await waitFor(() => activations === 1 && state()?.attempt === undefined && pointer() === folderB, 'positive activation'); assert.equal(trial, 1); assert.equal(normal, 1);
      if (mode === 'lost-ack') { assert.equal(activates.length, 2); assert.equal(activates[0], activates[1]); } }
    assert.equal(readFileSync(join(profile, 'connection.json'), 'utf8'), credentials);
    assert.ok(requests.every(path => ['/runtime/install.ps1', '/runtime/v1/bundle/windows.json', '/runtime/v1/bundle/windows.zip'].includes(path)));
    recordProofs(); results.push({ mode, passed: true, normal, trial, activations, exactActivationRetries: activates.length,
      pairingUnchanged: true, selected: pointer() === folderA ? 'old' : 'new', processProofs: proofs.size });
  } catch (error) { failure = error; writeFileSync(join(scope, `${mode}-private.log`), log.join('') + '\n' + JSON.stringify(events)); }
  finally {
    holdArchive = false; heldArchive?.destroy();
    if (scan) clearInterval(scan); recordProofs();
    // Only exact birth/boot/PID identities recorded in this harness's fresh install may be stopped.
    for (const proof of proofs.values()) if (matches(proof, await observe(proof.pid)) === true) process.kill(proof.pid);
    for (const proof of proofs.values()) await until(async () => matches(proof, await observe(proof.pid)) === false, 'owned process exit', 30_000);
    if (runner) await runner.finished;
    for (const owned of [...ownedChildren]) {
      if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill();
      await owned.finished.catch(() => {});
    }
    if (!failure && mode === 'busy') {
      // Reverse direction: PowerShell reclaims an actually ended Node writer, not a made-up PID.
      const proof = proofs.values().next().value, lockDir = join(install, '.agend-runtime-install.lock');
      assert.ok(proof); mkdirSync(lockDir); writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ version: 1, type: 'supervisor', nonce: randomUUID(), ...proof }));
      target = a;
      const command = runtimeInstallCommand(origin, createHash('sha256').update(template.replaceAll('@@AGEND_RUNTIME_VERSION@@', a.version).replaceAll('@@AGEND_RUNTIME_SHA256@@', a.sha256)).digest('hex'));
      const encoded = Buffer.from(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${command}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`, 'utf16le').toString('base64');
      const reclaiming = execute(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], env, log);
      assert.equal(await reclaiming.finished, 0); assert.equal(existsSync(lockDir), false); assert.equal(pointer(), folderA);
      results.at(-1).nativeSharedLockControls = ['Node blocks PowerShell', 'PowerShell blocks Node', 'Node reaps ended PowerShell', 'PowerShell reaps ended Node'];
    }
    for (const ws of sockets.clients) ws.terminate(); await new Promise(done => sockets.close(done));
    server.closeAllConnections(); await new Promise(done => server.close(done));
    if (!failure) rmSync(root, { recursive: true, force: true });
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ leg: mode, step: 'pass-and-cleaned' }));
}
writeFileSync(join(scope, 'receipt.json'), JSON.stringify({ version: 1, node: process.version, inputs: identities, results, cleanup: { ownedProcessesGone: true, legDirectoriesRemoved: true } }, null, 2));
console.log(JSON.stringify({ passed: results.length, cleanup: true }));
