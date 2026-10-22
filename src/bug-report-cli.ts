import type { Command } from 'commander';
import { execFile } from './child-process.js';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, platform, release, arch } from 'node:os';
import { getAgendHome } from './paths.js';
import { redactDiagnostics } from './diagnostic-redaction.js';
import { approveDraft, approvedIssueLink, createReportDraft, DEFAULT_SINCE, draftDigest, MAX_LOG_BYTES, readLogTail, readReportInput, reviewText, serializeDraft, sinceMs, writePrivate } from './bug-report.js';

export interface BugReportOptions {
  since?: string; out?: string; title?: string; description?: string; steps?: string;
  descriptionFile?: string; stepsFile?: string; keepIdentifiers?: boolean;
  draft?: string; approve?: string; submit?: boolean;
}
export interface BugReportDeps {
  home: string; now: () => number; version: string; environment: () => string;
  readTail: typeof readLogTail; readText: (path: string) => Promise<string>;
  write: typeof writePrivate; print: (text: string) => void;
  journal: (since: number, until: number) => Promise<string>;
  submit: (title: string, body: string) => Promise<string>;
}
const run = promisify(execFile);
export function defaultBugReportDeps(version: string): BugReportDeps {
  return {
    home: getAgendHome(), now: Date.now, version,
    environment: () => `AgEnD: ${version}\nNode: ${process.version}\nRuntime: Node (${arch()})\nOS: ${platform()} ${release()}\nWSL: ${/microsoft|wsl/i.test(release()) || !!process.env.WSL_DISTRO_NAME ? 'yes' : 'no'}\nWSL distro: ${process.env.WSL_DISTRO_NAME ?? 'unknown / not applicable'}`,
    readTail: readLogTail, readText: readReportInput, write: writePrivate, print: text => console.log(text),
    journal: async (since, until) => {
      const { stdout } = await run('journalctl', ['--user', '-u', 'com.agend.fleet', '--since', new Date(since).toISOString(), '--until', new Date(until).toISOString(), '--no-pager', '-o', 'short-iso', '-n', '1500'], { timeout: 5000, maxBuffer: MAX_LOG_BYTES });
      return stdout;
    },
    submit: async (title, body) => {
      // Existing host login only. Never prompt for, read or persist a GitHub credential.
      await run('gh', ['auth', 'status', '--hostname', 'github.com'], { timeout: 10_000, maxBuffer: 16_384 });
      const temporary = await mkdtemp(join(tmpdir(), 'agend-bug-report-'));
      try {
        const bodyPath = join(temporary, 'body.md');
        await writePrivate(bodyPath, body);
        const { stdout } = await run('gh', ['issue', 'create', '-R', 'github.com/songsid/AgEnD', '--title', title, '--body-file', bodyPath], { timeout: 30_000, maxBuffer: 16_384 });
        const url = stdout.trim();
        if (!/^https:\/\/github\.com\/songsid\/AgEnD\/issues\/\d+$/.test(url)) throw new Error('Issue submission result was unclear; check GitHub before trying again.');
        return url;
      } finally { await rm(temporary, { recursive: true, force: true }); }
    },
  };
}
async function cachedBackendVersions(deps: BugReportDeps): Promise<string> {
  const lines: string[] = [];
  for (const backend of ['claude-code', 'codex', 'kiro-cli', 'grok', 'antigravity', 'muse', 'opencode']) {
    let version = 'unknown (no usable cached evidence)';
    try {
      const raw = await deps.readTail(join(deps.home, 'cli-env', backend + '.json'));
      if (!raw.truncated) {
        const cache = JSON.parse(raw.text) as { version?: unknown; probedAt?: unknown };
        const match = typeof cache.version === 'string' ? cache.version.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z]+\.\d{1,3})?\b/) : null;
        if (match) {
          const date = typeof cache.probedAt === 'number' && Number.isFinite(cache.probedAt) && cache.probedAt >= 0 && cache.probedAt <= deps.now() ? new Date(cache.probedAt).toISOString() : 'unknown';
          version = match[0] + ' (cached at ' + date + '; may be stale)';
        }
      }
    } catch { /* No probe or refresh: reading cached evidence is deliberately passive. */ }
    lines.push(backend + ' cache: ' + version);
  }
  return 'Cached backend CLI versions (may differ from incident log evidence):\n' + lines.join('\n');
}
export async function runBugReport(options: BugReportOptions, deps: BugReportDeps): Promise<void> {
  if (options.approve || options.draft) {
    if (!options.approve || !options.draft) throw new Error('Approval requires both --draft and --approve SHA256.');
    if (options.out || options.since || options.title || options.description || options.steps || options.descriptionFile || options.stepsFile || options.keepIdentifiers) throw new Error('Approval cannot change collection options; collect and review a new draft.');
    const serialized = await deps.readText(options.draft);
    const draft = approveDraft(serialized, options.approve, options.submit ? 'gh' : 'link');
    if (options.submit) {
      // Overflow report stays local: gh has no implicit attachment upload.
      if (draft.overflow) throw new Error('This report needs a manual attachment. Collect a link-mode draft and approve it instead.');
      deps.print(await deps.submit(draft.title, draft.body));
    } else deps.print(approvedIssueLink(serialized, options.approve));
    return;
  }
  const until = deps.now(), since = sinceMs(options.since ?? DEFAULT_SINCE, until);
  const narrative = async (inline: string | undefined, file: string | undefined) => {
    if (inline && file) throw new Error('Choose inline text or a text file, not both.');
    const text = file ? await deps.readText(file) : inline ?? '';
    if (text.length > 64 * 1024) throw new Error('Description/steps exceed 64 KiB; shorten them before collection.');
    return text;
  };
  const description = await narrative(options.description, options.descriptionFile);
  const steps = await narrative(options.steps, options.stepsFile);
  const logs: { source: string; text: string; truncated?: boolean }[] = [];
  for (const source of ['daemon.log', 'fleet.log']) {
    try { logs.push({ source: source === 'daemon.log' ? 'daemon log' : 'fleet stderr log', ...await deps.readTail(join(deps.home, source)) }); }
    catch { logs.push({ source: (source === 'daemon.log' ? 'daemon log' : 'fleet stderr log') + ' (unavailable: missing, unreadable, symlink or not a regular file)', text: '' }); }
  }
  try { logs.push({ source: 'journalctl user unit com.agend.fleet', text: await deps.journal(since, until) }); }
  catch { logs.push({ source: 'journalctl user unit com.agend.fleet (unavailable or exceeded bounded read)', text: '' }); }
  const draft = createReportDraft({ title: options.title ?? 'AgEnD bug report', description, steps, environment: deps.environment() + '\n' + await cachedBackendVersions(deps), since, until, logs, keepIdentifiers: options.keepIdentifiers, delivery: options.submit ? 'gh' : 'link' });
  if (options.submit && draft.overflow) throw new Error('Report requires a manual attachment. Collect without --submit.');
  const serialized = serializeDraft(draft), digest = draftDigest(serialized);
  const out = options.out ?? `agend-bug-report-${until}.json`;
  await deps.write(out, serialized);
  await deps.write(out + '.md', draft.report);
  deps.print(reviewText(draft));
  deps.print(`Local review snapshot: ${redactDiagnostics(out)}\nShareable redacted report file: ${redactDiagnostics(out + ".md")}\nNo report sent. Review the exact text above, then approve SHA256 ${digest}.\nTo ${options.submit ? 'submit with existing host gh login' : 'generate the prefilled link'}: agend bug-report --draft <draft-file> --approve ${digest}${options.submit ? ' --submit' : ''}\nIf you do not use GitHub, share the report Markdown file yourself. No upload is performed.`);
}
export function registerBugReportCommand(program: Command, version: string, dependencies?: BugReportDeps): void {
  program.command('bug-report')
    .description('Collect a private redacted report; approve its exact draft before generating a GitHub link')
    .option('--since <duration>', 'Log window (default 30m, maximum 7d)')
    .option('--out <file>', 'New private draft snapshot; also writes <file>.md')
    .option('--title <text>', 'Issue title')
    .option('--description <text>', 'Problem description')
    .option('--steps <text>', 'Steps to reproduce')
    .option('--description-file <file>', 'Read problem description from a local text file')
    .option('--steps-file <file>', 'Read reproduction steps from a local text file')
    .option('--keep-identifiers', 'Opt in to retaining emails, hosts, IPs and path usernames; secrets remain redacted')
    .option('--draft <file>', 'Previously reviewed draft snapshot')
    .option('--approve <sha256>', 'Explicit approval of the exact draft snapshot')
    .option('--submit', 'Choose optional gh submission (must be chosen during collection and approval)')
    .action(async (options: BugReportOptions) => {
      try { await runBugReport(options, dependencies ?? defaultBugReportDeps(version)); }
      catch (error) {
        // child-process errors may embed args/stderr. Never echo them into chat/console.
        const reason = error instanceof Error && !('cmd' in error) ? redactDiagnostics(error.message) : 'Diagnostic collection/submission failed; no automatic retry. Check GitHub before retrying an uncertain submission.';
        console.error(reason); process.exitCode = 1;
      }
    });
}
