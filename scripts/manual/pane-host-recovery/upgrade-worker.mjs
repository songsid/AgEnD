/** Explicitly approved Windows scratch proof only; no tokens/captures/provider records on stdout. */
import assert from 'node:assert/strict';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
let phase = 'arguments';
process.on('uncaughtException', error => { process.stdout.write(JSON.stringify({ failed: true, phase, kind: error.name, code: error.code || error.cause?.code }) + '\n'); process.stdin.destroy(); process.exitCode = 1; });
const [bundle, root, mode, action, arg] = process.argv.slice(2);
assert(process.platform === 'win32' && win32.normalize(root).toLowerCase().startsWith('c:\\users\\changhansung\\agend-adapter-proto\\upgrade-'));
const load = name => import(pathToFileURL(join(bundle, 'dist', name + '.js')).href);
phase = 'imports';
if (mode === 'local') {
 process.env.LOCALAPPDATA = join(root, 'localdata');
 const { serveLocalPaneRelay } = await load('runtime-pane-stdio');
 serveLocalPaneRelay(process.stdin, process.stdout); // Real default open, deliberately no injected factory.
} else if (mode === 'inspect') {
 const directory = arg;
 assert(win32.normalize(directory).toLowerCase().startsWith(win32.normalize(root).toLowerCase() + '\\'));
 const descriptor = JSON.parse(await readFile(join(directory, 'host.json'), 'utf8'));
 const rows = JSON.parse(await readFile(join(directory, 'state', 'panes.json'), 'utf8')).panes;
 const panes = Array.isArray(rows) ? rows : Object.values(rows);
 const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
 if (action === 'kill-owned') {
  // The descriptor is from this fresh private scratch profile, never a PID supplied by the caller.
  const result = await promisify(execFile)(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
   ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${descriptor.pid}'; [Console]::Write($p.CommandLine)`, 'utf16le').toString('base64')], { timeout: 15000 });
  assert(result.stdout.toLowerCase().includes(root.toLowerCase()) && result.stdout.includes('runtime-pane-service.js'));
  await promisify(execFile)(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(descriptor.pid), '/T', '/F'], { timeout: 30000 });
  const deadline = performance.now() + 15000;
  while ([descriptor.pid, ...panes.map(p => p.pid).filter(Boolean)].some(alive)) {
   assert(performance.now() < deadline, 'Owned tree exit unconfirmed');
   await new Promise(done => setTimeout(done, 100));
  }
 }
 process.stdout.write(JSON.stringify({ boot: descriptor.hostBootId, alive: alive(descriptor.pid), processesAlive: panes.filter(p => p.pid && alive(p.pid)).length,
  systemBootProof: !!descriptor.systemBootId }) + '\n');
} else if (mode === 'paired') {
 const [{ RuntimeClient, pairRuntime }, { RuntimeClientStore }] = await Promise.all(['runtime-client', 'runtime-client-store'].map(load));
 const lines = createInterface({ input: process.stdin });
 phase = 'initial-frame';
 const initial = await new Promise(done => lines.once('line', line => done(JSON.parse(line))));
 const store = new RuntimeClientStore(join(root, 'profile'));
 phase = 'loopback-ready';
 for (let attempt = 0; ; attempt++) {
  try { await fetch(new URL('/scratch-ready', initial.server), { signal: AbortSignal.timeout(1000) }); break; }
  catch (error) { if (attempt >= 99) throw error; await new Promise(done => setTimeout(done, 100)); }
 }
 phase = 'pairing';
 if (initial.code) {
  await pairRuntime({ ...initial, store, name: 'scratch-upgrade-proof', pollMs: 100,
   report: text => { const fp = /Pairing fingerprint: ([A-F0-9-]+)/.exec(text)?.[1]; if (fp) process.stdout.write(JSON.stringify({ fingerprint: fp }) + '\n'); } });
 }
 const client = new RuntimeClient({ store, reconnectMs: 100, pollMs: 50,
  bridge: { probe: async () => ({ home: root, clis: [] }), get: () => null, prepareWorkspace: async () => { throw Error('No exec'); }, start() { throw Error('No exec'); }, cancel() {}, close() {}, releaseUnknown() {} } });
 await client.start(); process.stdout.write(JSON.stringify({ ready: true, machineId: store.credentials().machineId }) + '\n');
 lines.once('line', async () => { await client.stop(); lines.close(); process.stdin.destroy(); });
} else throw Error('Unknown scratch mode');
