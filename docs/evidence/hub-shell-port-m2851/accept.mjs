// One blocked old-head failure, one unmodified control, one candidate under the same collision.
// Only owned loopback listeners/browser fixtures; never stop an existing listener.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const repo = resolve(process.env.REPO ?? process.cwd());
const control = resolve(process.env.CONTROL);
const out = resolve(process.env.OUT ?? join(repo, '.artifacts/acceptance'));
const chrome = resolve(process.env.CHROME), pw = resolve(process.env.PW_DIR), fonts = resolve(process.env.FONTCONFIG_FILE);
mkdirSync(out, { recursive: true });
const git = async (cwd, ...args) => (await exec('git', args, { cwd })).stdout.trim();
const source = {};
for (const [name, cwd] of [['control', control], ['candidate', repo]]) {
  assert.equal(await git(cwd, 'status', '--porcelain', '--', 'src', 'scripts/manual/smoke', 'scripts/manual/smoke-fixture', 'tests/helpers/hub-s3b-rig.ts'), '');
  source[name] = { head: await git(cwd, 'rev-parse', 'HEAD'), tree: await git(cwd, 'rev-parse', 'HEAD^{tree}'), inputs: {} };
  for (const path of ['src', 'scripts/manual/smoke', 'scripts/manual/smoke-fixture', 'tests/helpers/hub-s3b-rig.ts']) source[name].inputs[path] = await git(cwd, 'rev-parse', `HEAD:${path}`);
}
assert.equal(source.control.head, 'e1b88cd8edd4d6c4656a6dbae8f9c68239025dee');
assert.equal(source.control.inputs.src, source.candidate.inputs.src);
assert.equal(source.control.inputs['tests/helpers/hub-s3b-rig.ts'], source.candidate.inputs['tests/helpers/hub-s3b-rig.ts']);
const env = { ...process.env, PW_DIR: pw, CHROME: chrome, FONTCONFIG_FILE: fonts, GATE: 'ci', XDG_CONFIG_HOME: join(out, 'xdg-config'), XDG_DATA_HOME: join(out, 'xdg-data') };
mkdirSync(env.XDG_CONFIG_HOME, { recursive: true }); mkdirSync(env.XDG_DATA_HOME, { recursive: true });
const owned = [], alreadyOccupied = [];
async function reserve() {
  for (let port = 48700; port < 48790; port++) {
    const server = createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      owned.push(server);
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; alreadyOccupied.push(port); }
  }
}
async function release() { await Promise.all(owned.splice(0).map(server => new Promise(resolve => server.close(resolve)))); }
async function run(label, cwd) {
  const output = join(out, label); mkdirSync(output, { recursive: true });
  let result;
  try {
    const value = await exec(process.execPath, [join(repo, 'node_modules/tsx/dist/cli.mjs'), 'scripts/manual/smoke/smoke-hub-shell-gate.mts'], {
      cwd, env: { ...env, REPO: cwd, OUT: output }, timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    });
    result = { exit: 0, stdout: value.stdout, stderr: value.stderr };
  } catch (error) { result = { exit: error.code, signal: error.signal, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
  writeFileSync(join(out, label + '.log'), result.stdout + result.stderr);
  // An old-head bind failure precedes the gate's cleanup. Never preserve fixture private keys as evidence.
  const gateDir = join(output, 'smoke-hub-shell-gate');
  for (const name of readdirSync(gateDir)) if (name.startsWith('keys-')) rmSync(join(gateDir, name), { recursive: true, force: true });
  return result;
}
let blocked, baseline, candidate;
try {
  await reserve();
  blocked = await run('blocked-control', control);
  assert.equal(blocked.exit, 1); assert.match(blocked.stderr, /EADDRINUSE/);
  await release();
  baseline = await run('control', control); assert.equal(baseline.exit, 0, baseline.stdout + baseline.stderr);
  await reserve();
  candidate = await run('candidate-blocked-range', repo); assert.equal(candidate.exit, 0, candidate.stdout + candidate.stderr);
} finally { await release(); }
const readResult = label => { const value = JSON.parse(readFileSync(join(out, label, 'smoke-hub-shell-gate/result.json'), 'utf8')); delete value.seconds; return value; };
const before = readResult('control'), after = readResult('candidate-blocked-range');
assert.deepEqual(after, before);
assert.ok(Object.keys(after).length > 100);
assert.ok(Object.entries(after).every(([key, value]) => key === 'gate' || value === 'PASS'));
const match = /Hub shell gate listener: https:\/\/127\.0\.0\.1:(\d+)/.exec(candidate.stdout); assert.ok(match);
const candidatePort = Number(match[1]); assert.ok(candidatePort < 48700 || candidatePort >= 48790);
writeFileSync(join(out, 'control-result.json'), JSON.stringify(before, null, 2) + '\n');
writeFileSync(join(out, 'candidate-result.json'), JSON.stringify(after, null, 2) + '\n');
const receipt = { source, browser: (await exec(chrome, ['--version'])).stdout.trim(), node: process.version,
  playwright: JSON.parse(readFileSync(join(pw, 'node_modules/playwright-core/package.json'), 'utf8')).version,
  fontconfigDigest: createHash('sha256').update(readFileSync(fonts)).digest('hex'), harnessDigest: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  reservedRange: [48700, 48789], preexistingOccupied: [...new Set(alreadyOccupied)], blockedControlExit: blocked.exit,
  controlExit: baseline.exit, candidateExit: candidate.exit, candidatePort, checks: Object.keys(after).length - 1, identicalResults: true,
  scope: 'GATE=ci desk-light-en/phone-dark-zh-TW. Same local browser/fonts; no claim of GitHub-hosted control rerun. Existing listeners were neither stopped nor modified.' };
writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(`Old head collision refused; control/candidate ${receipt.checks} identical passing checks; candidate port ${candidatePort}.`);
