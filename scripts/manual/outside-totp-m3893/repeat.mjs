// Repeat the original failing HTTP lifecycle with per-case fixture/cleanup, no retries.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, openSync, closeSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const source = 'tests/outside-connections-3008.test.ts';
const temporary = 'tests/.m3893-outside-totp-loop.test.ts';
const output = resolve('.artifacts/m3893/repeat');
const count = 200;
const title = 'Off closes the link and ends every session from outside; setting up a new app ends them too; removing turns it off';
const text = readFileSync(source, 'utf8');
const needle = `it(${JSON.stringify(title)}, async () => {`;
if (text.split(needle).length !== 2 || existsSync(temporary)) throw new Error('unexpected fixture or existing temporary file');
const digest = data => createHash('sha256').update(data).digest('hex');
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const before = { head: head(), sourceSha256: digest(text), count };
mkdirSync(output, { recursive: true });
writeFileSync(temporary, text.replace(needle, `it.each(Array.from({ length: ${count} }, (_, n) => n + 1))(${JSON.stringify(title + ' [run %i]')}, async () => {`), { flag: 'wx' });
const fd = openSync(resolve(output, 'vitest.log'), 'w');
let result;
try {
  result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', temporary, '--maxWorkers=1', '--bail=1', '-t', title,
    '--reporter=json', '--outputFile=' + resolve(output, 'report.json')], { stdio: ['ignore', fd, fd] });
} finally {
  closeSync(fd);
  rmSync(temporary);
}
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`series stopped: exit ${result.status}; inspect ${output}/vitest.log and report.json`);
const report = JSON.parse(readFileSync(resolve(output, 'report.json'), 'utf8'));
const passed = report.testResults.flatMap(r => r.assertionResults).filter(r => r.status === 'passed' && r.title.startsWith(title));
if (passed.length !== count || report.numFailedTests !== 0 || !report.success) throw new Error('incomplete or failed series');
if (head() !== before.head || digest(readFileSync(source)) !== before.sourceSha256) throw new Error('source or HEAD changed during series');
const summary = { ...before, passed: passed.length, failed: report.numFailedTests, reportSha256: digest(readFileSync(resolve(output, 'report.json'))),
  scope: '200 serial lifecycle cases in one Vitest worker/process with a warmed module graph; new FleetManager, temp directory, random authenticator and cleanup for each. No contention injection, timeout change or retry.' };
writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
