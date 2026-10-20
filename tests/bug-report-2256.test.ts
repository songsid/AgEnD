import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { approveDraft, approvedIssueLink, createReportDraft, draftDigest, logExcerpt, MAX_ISSUE_URL, MAX_LOG_BYTES, readLogTail, serializeDraft, sinceMs, writePrivate } from '../src/bug-report.js';
import { registerBugReportCommand, runBugReport, type BugReportDeps } from '../src/bug-report-cli.js';
const until = Date.parse('2026-10-20T09:30:00Z'), since = until - 30 * 60_000;
const secrets = ['sk-' + 'synthonly'.repeat(6), '123456789:' + 'syntheticX'.repeat(4), 'ghp_' + 'syntheticX'.repeat(4)];
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agend-bug2256-')); dirs.push(dir);
  const out = join(dir, 'review.json');
  const printed: string[] = [];
  const deps: BugReportDeps = {
    home: dir, now: () => until, version: '2.3.0-beta.16', environment: () => 'AgEnD 2.3.0-beta.16\nNode v22.23.3\nWSL yes',
    readTail: readLogTail, readText: p => readFile(p, 'utf8'), write: writePrivate, print: s => printed.push(s),
    journal: vi.fn(async () => '2026-10-20T09:29:00Z journal: EAI_AGAIN token=tiny-secret'),
    submit: vi.fn(async () => 'https://github.com/songsid/AgEnD/issues/1'),
  };
  await writeFile(join(dir, 'daemon.log'), [
    JSON.stringify({ time: since - 1, msg: 'SIGKILL' }),
    JSON.stringify({ time: until - 1000, msg: `EAI_AGAIN ${secrets[0]}`, userId: '1234', chatId: '4321', text: 'private chat phrase', backend: 'codex', backendVersion: '1.2.3' }),
    JSON.stringify({ time: until + 1, msg: 'ECONNRESET' }),
  ].join('\n'));
  await writeFile(join(dir, 'fleet.log'), `2026-10-20T09:29:00Z Uncaught exception: Error: Opening handshake has timed out\n at connect (/home/privateuser/agend/socket.js:5:3)\n${secrets[1]}\nprivate user prose`);
  return { dir, out, deps, printed };
}
function sample(overrides: Partial<Parameters<typeof createReportDraft>[0]> = {}) {
  return createReportDraft({ title: 'Login failed', description: 'The login did not work', steps: 'Run login', environment: 'Node v22', since, until, logs: [], ...overrides });
}
describe('bug report approval and collection', () => {
  it('default registered CLI flow writes private redacted report and snapshot, then requires exact approval before a secret-free link', async () => {
    const f = await fixture();
    // From defaults except output location; no custom title/window/privacy or delivery flags.
    const command = () => { const p = new Command(); registerBugReportCommand(p, f.deps.version, f.deps); return p; };
    await command().parseAsync(['node', 'agend', 'bug-report', '--out', f.out]);
    expect(f.deps.submit).not.toHaveBeenCalled();
    expect(f.deps.journal).toHaveBeenCalledWith(since, until);
    const snapshot = await readFile(f.out, 'utf8'), draft = JSON.parse(snapshot);
    const report = await readFile(f.out + '.md', 'utf8');
    expect(report).toBe(draft.report); expect((await stat(f.out)).mode & 0o777).toBe(0o600); expect((await stat(f.out + '.md')).mode & 0o777).toBe(0o600);
    const shown = f.printed.join('\n');
    for (const raw of [...secrets, 'private chat phrase', 'privateuser', 'tiny-secret']) { expect(shown).not.toContain(raw); expect(snapshot).not.toContain(raw); }
    expect(report).toContain('EAI_AGAIN'); expect(report).toContain('Opening handshake has timed out'); expect(report).toContain('1.2.3');
    expect(report).not.toContain('SIGKILL'); expect(report).not.toContain('ECONNRESET');
    expect(shown).not.toContain('https://github.com');
    await command().parseAsync(['node', 'agend', 'bug-report', '--draft', f.out, '--approve', draftDigest(snapshot)]);
    const url = new URL(f.printed.at(-1)!);
    expect(url.origin + url.pathname).toBe('https://github.com/songsid/AgEnD/issues/new');
    expect(url.searchParams.get('body')).toBe(draft.body); expect(url.searchParams.get('title')).toBe(draft.title);
    for (const secret of secrets) expect(decodeURIComponent(url.href)).not.toContain(secret);
    expect(f.deps.submit).not.toHaveBeenCalled();
  });
  it('collects only existing cached CLI version/date fields without exposing catalog, binary path or profile credentials', async () => {
    const f = await fixture(); await mkdir(join(f.dir, 'cli-env'));
    await writeFile(join(f.dir, 'cli-env/codex.json'), JSON.stringify({ version: 'codex-cli 0.109.0', probedAt: until - 1000, models: ['private catalog'], binary: { path: '/home/privateuser/bin/codex' }, token: secrets[0] }));
    await runBugReport({ out: f.out }, f.deps);
    const snapshot = await readFile(f.out, 'utf8');
    expect(snapshot).toContain('0.109.0'); expect(snapshot).toContain('may be stale');
    for (const word of ['private catalog', 'privateuser', secrets[0]]) expect(snapshot).not.toContain(word);
    expect(f.deps.submit).not.toHaveBeenCalled();
  });
  it('final report and approved body preserve scoped stack frames, filename title, durations and exit codes without re-exposing IDs', () => {
    const draft = sample({ title: 'crash after fleet.yaml edit', description: 'daemon.log grew; see cli.js', logs: [{ source: 'daemon log', text: JSON.stringify({ time: until - 1000, durationMs: 123456, exitCode: 137, userId: 123456789, err: { stack: 'Error: failed\n    at FleetManager.start (/usr/lib/node_modules/@songsid/agend/dist/fleet-manager.js:120:7)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)' } }) }] });
    expect(logExcerpt('2026-10-20T09:29:00Z ERROR (fleet): at FleetManager.start (/usr/lib/node_modules/@songsid/agend/dist/fleet-manager.js:120:7)', since, until)).toContain('…/@songsid/agend/dist/fleet-manager.js:120:7');
    expect(draft.title).toBe('crash after fleet.yaml edit'); expect(draft.report).toContain('daemon.log grew; see cli.js');
    expect(draft.report).toContain('…/@songsid/agend/dist/fleet-manager.js:120:7'); expect(draft.report).toContain('node:internal/process/task_queues:95:5');
    expect(draft.report).toContain('"durationMs":123456'); expect(draft.report).toContain('"exitCode":137'); expect(draft.report).not.toContain('123456789');
    const serialized = serializeDraft(draft); const url = approvedIssueLink(serialized, draftDigest(serialized));
    expect(new URL(url).searchParams.get('body')).toBe(draft.body);
  });
  it('handles a bounded line with fifty thousand INFO tokens without repeated suffix scanning', () => {
    const start = performance.now(); const result = logExcerpt('INFO '.repeat(50_000) + 'EAI_AGAIN', since, until);
    expect(result).toContain('EAI_AGAIN'); expect(performance.now() - start).toBeLessThan(2000);
  });
  it('withholds unknown timestamp prose but labels canonical untimestamped stderr evidence', () => {
    const output = logExcerpt('Uncaught exception: Error: Opening handshake has timed out\n at connect (/home/alice/x.js:5:3)\nprivate phrase', since, until);
    expect(output).toContain('[time unknown]'); expect(output).toContain('Opening handshake has timed out'); expect(output).not.toContain('private phrase'); expect(output).not.toContain('alice');
  });
  it('rejects stale approval after any text/attachment or delivery-mode change; never submits', async () => {
    const f = await fixture(); await runBugReport({ out: f.out }, f.deps);
    const snapshot = await readFile(f.out, 'utf8'), digest = draftDigest(snapshot);
    for (const key of ['title', 'body', 'report']) {
      const draft = JSON.parse(snapshot); draft[key] += ' changed';
      await writeFile(f.out, serializeDraft(draft));
      await expect(runBugReport({ draft: f.out, approve: digest }, f.deps)).rejects.toThrow('changed');
    }
    await writeFile(f.out, snapshot);
    await expect(runBugReport({ draft: f.out, approve: digest, submit: true }, f.deps)).rejects.toThrow('Invalid draft');
    await expect(runBugReport({ draft: f.out }, f.deps)).rejects.toThrow('both');
    await expect(runBugReport({ draft: f.out, approve: digest, title: 'new title' }, f.deps)).rejects.toThrow('cannot change');
    expect(f.deps.submit).not.toHaveBeenCalled();
  });
  it('rejects an unredacted credential edit even with a matching digest', () => {
    const draft = sample(); draft.body += ' token=tiny'; const serialized = serializeDraft(draft);
    expect(() => approvedIssueLink(serialized, draftDigest(serialized))).toThrow('unredacted');
    expect(() => approveDraft('null', draftDigest('null'), 'link')).toThrow();
  });
  it('uses bounded URL with explicit manual-attachment overflow and preserves the full exact report file', async () => {
    const f = await fixture();
    await runBugReport({ out: f.out, description: '失敗原因與重現'.repeat(1800), steps: 'one two three' }, f.deps);
    const serialized = await readFile(f.out, 'utf8'), draft = JSON.parse(serialized);
    expect(draft.overflow).toBe(true); expect(draft.body).toContain('attach'); expect(draft.report).toContain('失敗原因與重現'.repeat(1800));
    expect(await readFile(f.out + '.md', 'utf8')).toBe(draft.report);
    await runBugReport({ draft: f.out, approve: draftDigest(serialized) }, f.deps);
    const url = f.printed.at(-1)!;
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL); expect(new URL(url).searchParams.get('body')).toBe(draft.body);
    expect(new URL(url).searchParams.get('title')).toBe(draft.title); expect(f.deps.submit).not.toHaveBeenCalled();
  });
  it('optional gh calls only the approved submission boundary with the exact reviewed text', async () => {
    const f = await fixture(); await runBugReport({ out: f.out, submit: true, description: `Failure ${secrets[2]}` }, f.deps);
    expect(f.deps.submit).not.toHaveBeenCalled();
    const snapshot = await readFile(f.out, 'utf8'), draft = JSON.parse(snapshot);
    await runBugReport({ draft: f.out, approve: draftDigest(snapshot), submit: true }, f.deps);
    expect(f.deps.submit).toHaveBeenCalledExactlyOnceWith(draft.title, draft.body);
    expect(f.printed.at(-1)).toBe('https://github.com/songsid/AgEnD/issues/1');
  });
  it('auth/submission failure does not retry or fall back to another transport', async () => {
    const f = await fixture(); await runBugReport({ out: f.out, submit: true }, f.deps);
    vi.mocked(f.deps.submit).mockRejectedValue(new Error('uncertain result'));
    const snapshot = await readFile(f.out, 'utf8');
    await expect(runBugReport({ draft: f.out, approve: draftDigest(snapshot), submit: true }, f.deps)).rejects.toThrow('uncertain');
    expect(f.deps.submit).toHaveBeenCalledTimes(1);
  });
  it('missing logs/journal still produce a shareable file with explicit limitations', async () => {
    const f = await fixture(); f.deps.readTail = vi.fn().mockRejectedValue(new Error('raw error with secret')); f.deps.journal = vi.fn().mockRejectedValue(new Error('raw stderr'));
    await runBugReport({ out: f.out }, f.deps);
    const report = await readFile(f.out + '.md', 'utf8'); expect(report).toContain('unavailable'); expect(report).not.toContain('raw stderr'); expect(report).not.toContain('raw error');
  });
  it('caps large tails, refuses symlinks and never overwrites an output or follows output symlinks', async () => {
    const f = await fixture(); const huge = join(f.dir, 'huge.log');
    await writeFile(huge, 'old-secret\n' + 'x'.repeat(MAX_LOG_BYTES) + '\n2026-10-20T09:29:00Z EAI_AGAIN');
    const tail = await readLogTail(huge); expect(tail.truncated).toBe(true); expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(MAX_LOG_BYTES); expect(tail.text).not.toContain('old-secret');
    const link = join(f.dir, 'link'); await symlink(huge, link);
    await expect(readLogTail(link)).rejects.toThrow(); await expect(writePrivate(link, 'overwrite')).rejects.toThrow();
    await writePrivate(f.out, 'existing'); await expect(writePrivate(f.out, 'replacement')).rejects.toThrow(); expect(await readFile(f.out, 'utf8')).toBe('existing');
  });
  it.each(['0m', '8d', 'anything', '-1m', '99999999999999999999d'])('rejects invalid/unbounded window %s', value => { expect(() => sinceMs(value, until)).toThrow(); });
});
