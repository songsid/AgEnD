import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { t } from './locale.js';
import { diagnosticLine, diagnosticRecord, redactDiagnostics, type RedactionOptions } from './diagnostic-redaction.js';

export const ISSUE_URL = 'https://github.com/songsid/AgEnD/issues/new';
export const MAX_ISSUE_URL = 7500;
export const MAX_LOG_BYTES = 256 * 1024;
export const MAX_LOG_LINES = 1500;
export const DEFAULT_SINCE = '30m';
export function sinceMs(value: string, now = Date.now()): number {
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (!match) throw new Error(t("bugreport.since_format"));
  const duration = Number(match[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]!);
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 7 * 86_400_000) throw new Error(t("bugreport.since_range"));
  return now - duration;
}

/** No FIFO/device reads, symlink following, whole-file allocations, or modifications of live logs. */
export async function readLogTail(path: string): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(t("bugreport.not_log_file"));
    const start = Math.max(0, stat.size - MAX_LOG_BYTES);
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_LOG_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    // A partial first line could hide its timestamp or a credential prefix.
    if (start) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    return { text, truncated: start > 0 };
  } finally { await handle.close(); }
}

/** Bounded local narrative/review read, with the same FIFO/symlink restrictions as logs. */
export async function readReportInput(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error(t("bugreport.input_file"));
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

export function logExcerpt(text: string, since: number, until: number, options: RedactionOptions = {}): string {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let active: number | null = null, unknown = 0, withheld = 0;
  for (const line of lines.slice(-MAX_LOG_LINES)) {
    if (!line) continue;
    let record: Record<string, unknown> | undefined;
    try { const parsed: unknown = JSON.parse(line); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) record = parsed as Record<string, unknown>; } catch { /* pretty/plain log */ }
    const timestamp = record?.time ?? record?.timestamp;
    const match = line.match(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
    const current = typeof timestamp === 'number' ? timestamp : typeof timestamp === 'string' ? Date.parse(timestamp) : match ? Date.parse(match[0]) : null;
    if (current !== null) active = Number.isFinite(current) ? current : -1;
    if (active !== null && (active < since || active > until)) continue;
    // Inspect one bounded prefix once. Repeated INFO tokens without a colon must
    // not trigger a fresh scan of the remaining line for every token.
    const level = /\b(?:INFO|WARN|ERROR|DEBUG|FATAL)\b/.exec(line.slice(0, 256));
    const colon = level ? line.indexOf(':', level.index + level[0].length) : -1;
    const plain = colon >= 0 && colon <= 256 ? line.slice(colon + 1).trimStart() : line;
    const safe = record ? diagnosticRecord(record, options) : diagnosticLine(plain, options);
    if (!safe || safe === '{}') { withheld++; continue; }
    // fleet stderr often lacks timestamps; explicitly separate unverified-time evidence.
    if (active === null) unknown++;
    output.push(`${active === null ? '[time unknown]' : new Date(active).toISOString()} ${safe}`);
  }
  return [`Log prose/identifiers omitted; last ${MAX_LOG_LINES} lines maximum.`,
    `Untimestamped diagnostic lines: ${unknown} (cannot verify requested window); withheld lines: ${withheld}.`,
    ...output].join('\n');
}

export interface ReportInput {
  title: string; description: string; steps: string; environment: string;
  since: number; until: number; logs: { source: string; text: string; truncated?: boolean }[];
  keepIdentifiers?: boolean; delivery?: 'link' | 'gh';
}
export interface ReportDraft {
  format: 'agend-bug-report-v1'; delivery: 'link' | 'gh'; keepIdentifiers: boolean;
  title: string; body: string; report: string; overflow: boolean;
}
function encodedLength(title: string, body: string): number {
  return ISSUE_URL.length + '?title='.length + encodeURIComponent(title).length + '&body='.length + encodeURIComponent(body).length;
}
export function createReportDraft(input: ReportInput): ReportDraft {
  const options = { keepIdentifiers: input.keepIdentifiers };
  const clean = (s: string) => redactDiagnostics(s, options).replace(/\r/g, '');
  const title = Array.from(clean(input.title).replace(/[\n\t]/g, ' ')).slice(0, 140).join('') || 'AgEnD bug report';
  const report = clean(`# ${title}\n\n## Description\n${clean(input.description) || 'Please describe the problem.'}\n\n## Steps to reproduce\n${clean(input.steps) || 'Please add reproduction steps.'}\n\n## Environment\n${clean(input.environment)}\n\n## Requested window (UTC)\n${new Date(input.since).toISOString()} to ${new Date(input.until).toISOString()}\n\n## Redacted diagnostics\n${input.logs.map(l => `### ${clean(l.source)}${l.truncated ? ' (bounded tail; earlier bytes omitted)' : ''}\n\n${logExcerpt(l.text, input.since, input.until, options)}`).join('\n\n')}\n\nReview this public report before sharing. Free-form log prose, IDs and unknown fields were withheld; arbitrary secrets in the description still need your review. No transcripts, credential config or environment dump collected. Backend CLI versions come from existing unprofiled version caches and structured log fields; missing evidence is unknown, cache age is stated, and no coding CLI was executed.\n`);
  const overflow = encodedLength(title, report) > MAX_ISSUE_URL;
  const body = overflow ? `# ${title}\n\nThe full approved redacted report exceeds the prefilled-link size limit. Please attach the approved report Markdown file manually before submitting. No attachment has been uploaded.\n` : report;
  return { format: 'agend-bug-report-v1', delivery: input.delivery ?? 'link', keepIdentifiers: !!input.keepIdentifiers, title, body, report, overflow };
}
export function serializeDraft(draft: ReportDraft): string { return JSON.stringify(draft, null, 2) + '\n'; }
export function draftDigest(serialized: string): string { return createHash('sha256').update(serialized).digest('hex'); }
export function reviewText(draft: ReportDraft): string {
  return `${t("bugreport.review_delivery", draft.delivery)}\n${t("bugreport.review_title")}\n${draft.title}\n\n${t("bugreport.review_body")}\n${draft.body}\n\n${t(draft.overflow ? "bugreport.review_file_required" : "bugreport.review_file")}\n${draft.report}\n`;
}
export function approveDraft(serialized: string, digest: string, delivery: 'link' | 'gh'): ReportDraft {
  if (!/^[a-f\d]{64}$/.test(digest) || draftDigest(serialized) !== digest) throw new Error(t("bugreport.digest_mismatch"));
  const draft = JSON.parse(serialized) as ReportDraft;
  if (!draft || draft.format !== 'agend-bug-report-v1' || draft.delivery !== delivery || typeof draft.keepIdentifiers !== 'boolean'
    || typeof draft.title !== 'string' || typeof draft.body !== 'string' || typeof draft.report !== 'string' || typeof draft.overflow !== 'boolean') throw new Error(t("bugreport.invalid_draft"));
  // Reject injected extra fields, unredacted edits and ambiguous representations.
  if (serializeDraft(draft) !== serialized || Object.keys(draft).sort().join(',') !== 'body,delivery,format,keepIdentifiers,overflow,report,title') throw new Error(t("bugreport.invalid_format"));
  for (const value of [draft.title, draft.body, draft.report]) if (redactDiagnostics(value, { keepIdentifiers: draft.keepIdentifiers }) !== value) throw new Error(t("bugreport.unredacted"));
  if (encodedLength(draft.title, draft.body) > MAX_ISSUE_URL) throw new Error(t("bugreport.link_too_long"));
  return draft;
}
/** Only accepts the validated snapshot from the approval boundary. Does not open a browser. */
export function approvedIssueLink(serialized: string, digest: string): string {
  const draft = approveDraft(serialized, digest, 'link');
  return ISSUE_URL + '?title=' + encodeURIComponent(draft.title) + '&body=' + encodeURIComponent(draft.body);
}
export async function writePrivate(path: string, text: string): Promise<void> {
  await writeFile(path, text, { flag: 'wx', mode: 0o600 });
}
