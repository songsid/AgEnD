import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
const child = vi.hoisted(() => {
  const exec = vi.fn();
  // Native execFile has a custom promisifier returning BOTH stdout and stderr.
  Object.defineProperty(exec, Symbol.for('nodejs.util.promisify.custom'), { value: (...args: unknown[]) => new Promise((resolve, reject) => exec(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }))) });
  return { exec };
});
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFile: child.exec }));
import { defaultBugReportDeps } from '../src/bug-report-cli.js';
beforeEach(() => { child.exec.mockReset(); });
describe('diagnostic external command boundary', () => {
  it('journal is bounded, user-unit only, same explicit window; does not use shell or credentials', async () => {
    child.exec.mockImplementation((file, args, options, callback) => { callback(null, 'EAI_AGAIN', ''); return {}; });
    const deps = defaultBugReportDeps('2.3.0');
    await expect(deps.journal(1000, 2000)).resolves.toBe('EAI_AGAIN');
    expect(child.exec).toHaveBeenCalledTimes(1);
    const [file, args, options] = child.exec.mock.calls[0];
    expect(file).toBe('journalctl'); expect(args).toEqual(['--user', '-u', 'com.agend.fleet', '--since', new Date(1000).toISOString(), '--until', new Date(2000).toISOString(), '--no-pager', '-o', 'short-iso', '-n', '1500']);
    expect(options).toEqual({ timeout: 5000, maxBuffer: 256 * 1024 });
  });
  it('gh pins the approved project host, uses existing auth only, writes exact private body and cleans up afterward', async () => {
    let bodyFile = '';
    child.exec.mockImplementation((file, args, options, callback) => {
      expect(file).toBe('gh');
      if (args[0] === 'auth') { expect(args).toEqual(['auth', 'status', '--hostname', 'github.com']); callback(null, '', ''); }
      else {
        expect(args.slice(0, 6)).toEqual(['issue', 'create', '-R', 'github.com/songsid/AgEnD', '--title', 'Exact title']);
        bodyFile = args[7]; expect(readFileSync(bodyFile, 'utf8')).toBe('Exact reviewed body'); expect(statSync(bodyFile).mode & 0o777).toBe(0o600);
        callback(null, 'https://github.com/songsid/AgEnD/issues/123\n', '');
      }
      expect(options.timeout).toBeGreaterThan(0); return {};
    });
    await expect(defaultBugReportDeps('2.3.0').submit('Exact title', 'Exact reviewed body')).resolves.toBe('https://github.com/songsid/AgEnD/issues/123');
    expect(child.exec).toHaveBeenCalledTimes(2); expect(bodyFile).not.toBe(''); expect(existsSync(bodyFile)).toBe(false);
  });
  it('failed auth never starts issue create or login', async () => {
    child.exec.mockImplementation((file, args, options, callback) => { callback(new Error('not logged in'), '', ''); return {}; });
    await expect(defaultBugReportDeps('2.3.0').submit('title', 'body')).rejects.toThrow('not logged in');
    expect(child.exec).toHaveBeenCalledTimes(1); expect(child.exec.mock.calls[0][1]).toEqual(['auth', 'status', '--hostname', 'github.com']);
  });
});
