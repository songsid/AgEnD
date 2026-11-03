/** Windows scratch orchestration only. Never prints credentials, native captures or provider records. */
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const [bundle, root] = process.argv.slice(2), approved = 'c:\\users\\changhansung\\agend-adapter-proto\\';
assert(process.platform === 'win32' && win32.normalize(root).toLowerCase().startsWith(approved));
const load = name => import(pathToFileURL(join(bundle, 'dist', name + '.js')).href);
const [{ RuntimeClient, pairRuntime }, { RuntimeClientStore, runtimeJobDigest }, { RuntimePaneLink }, { readPaneHostDescriptor }, { findCli, nativeCliEnvironment }] = await Promise.all(
  ['runtime-client', 'runtime-client-store', 'runtime-pane-link', 'runtime-pane-private', 'windows-cli-worker'].map(load));
const lines = createInterface({ input: process.stdin }), send = value => process.stdout.write(JSON.stringify(value) + '\n');
const initial = await new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line))));
const executable = await findCli('codex'); assert(executable);
const versionText = (await promisify(execFile)(executable.command, [...executable.args, '--version'], {
  cwd: root, env: nativeCliEnvironment(), timeout: 10000, maxBuffer: 4096, windowsHide: true, shell: false,
})).stdout;
const version = /\b\d+\.\d+\.\d+\b/.exec(versionText)?.[0]; assert(version);
const directory = join(root, 'profile'), store = new RuntimeClientStore(directory), abort = new AbortController();
let client, credentials, closing = false;
const descriptors = new Map();
const remember = () => {
  if (!credentials) return null;
  const descriptor = readPaneHostDescriptor(join(directory, 'pane-host'), runtimeJobDigest({ server: credentials.server, machineId: credentials.machineId }));
  if (descriptor) descriptors.set(descriptor.hostBootId, descriptor.pid);
  return descriptor;
};
const start = async () => {
  client = new RuntimeClient({ store, reconnectMs: 100, pollMs: 50,
    // Exec is deliberately unavailable in this pane-only proof. The ConPTY factory still resolves the real CLI.
    bridge: { probe: async () => ({ home: root, clis: [] }), prepareWorkspace: async () => { throw Error('No exec'); },
      start: () => { throw Error('No exec'); }, get: () => null, cancel: () => { throw Error('No exec'); }, close() {}, releaseUnknown() {} },
  }); await client.start();
};
const close = async () => {
  if (closing) return; closing = true; abort.abort();
  await client?.stop();
  // Cleanup is scoped to this fresh profile. Reconnect without starting any missing host.
  const descriptor = remember();
  if (descriptor) {
    const link = await RuntimePaneLink.attach(descriptor, { online: () => true, maxAgents: () => 4 });
    try { await link.retireOwned(); } finally { await link.stop(); }
  }
  const deadline = performance.now() + 20000;
  for (;;) {
    const alive = [...descriptors.values()].some(pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } });
    if (!alive) break;
    if (performance.now() > deadline) throw Error('Owned host exit remains unconfirmed');
    await new Promise(done => setTimeout(done, 100));
  }
  lines.close(); process.stdin.destroy(); send({ kind: 'closed', hostsExited: true });
};
try {
  credentials = await pairRuntime({ ...initial, store, name: 'scratch-pane-recovery', signal: abort.signal, pollMs: 100,
    report: text => { const fingerprint = /Pairing fingerprint: ([A-F0-9-]+)/.exec(text)?.[1]; if (fingerprint) send({ kind: 'fingerprint', fingerprint }); },
  });
  await start(); send({ kind: 'paired', machineId: credentials.machineId, cwd: root, version });
  let chain = Promise.resolve();
  lines.on('line', line => {
    chain = chain.then(async () => {
      const command = JSON.parse(line); assert.deepEqual(Object.keys(command), ['action']);
      if (command.action === 'relay-restart') { remember(); await client.stop(); await start(); send({ kind: 'restarted' }); }
      else if (command.action === 'state') {
        const descriptor = remember();
        const alive = [...descriptors.values()].filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }).length;
        send({ kind: 'state', descriptorPresent: !!descriptor, hostsAlive: alive });
      } else if (command.action === 'exit-offline') {
        const descriptor = remember(); assert(descriptor); await client.stop();
        const link = await RuntimePaneLink.attach(descriptor, { online: () => true, maxAgents: () => 4 });
        try {
          const inventory = await link.request({ action: 'list' });
          for (const pane of inventory.panes) if (pane.state !== 'exited') {
            assert(pane.instance.startsWith('recovery-') && pane.hostBootId === descriptor.hostBootId);
            const result = await link.request({ action: 'close', paneId: pane.paneId, launchId: pane.launchId, operationId: crypto.randomUUID(), sequence: pane.commandSequence + 1 });
            assert(result.state === 'exited');
          }
        } finally { await link.stop(); }
        await start(); send({ kind: 'offline-exit' });
      } else if (command.action === 'close') await close();
      else throw Error('Unknown scratch control');
    }).catch(async () => { send({ kind: 'failed' }); process.exitCode = 1; try { await close(); } catch { process.stdin.destroy(); lines.close(); } });
  });
  lines.once('close', () => { if (!closing) void close().catch(() => { process.exitCode = 1; }); });
} catch { send({ kind: 'failed' }); process.exitCode = 1; try { await close(); } catch { process.stdin.destroy(); lines.close(); } }
