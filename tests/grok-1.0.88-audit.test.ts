import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { grokConsumedMarker } from '../src/grok-delivery-proof.js';
import { GrokBackend, readGrokInputBox, readGrokTakenMarkers } from '../src/backend/grok.js';

const fixture = (file: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'grok-1.0.88-audit', file), 'utf8');
const backend = () => new GrokBackend('/tmp/grok-1088-audit-test');
const active = (b: GrokBackend, pane: string) => b.getRuntimeDialogs().filter(d =>
  d.isActive ? d.isActive(pane) : (d.pattern.lastIndex = 0, d.pattern.test(pane)));

describe('Grok1.0.88 real weekly-limit scrollback', () => {
  it('recognizes the Tab-only footer and returns with a literal tab, never a paid choice', () => {
    const pane = fixture('weekly-scrollback.pane.txt');
    expect(pane.trimEnd().split('\n').at(-1)).toContain('Tab:question');
    const dialogs = active(backend(), pane);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.autoResolutionKey).toBe('grok-weekly-limit-scrollback');
    expect(dialogs[0]!.keys).toEqual(['\t']);
    expect(dialogs[0]!.literalKeys).toBe(true);
    expect(dialogs[0]!.inputBlocked).toBe(true);
    expect(readGrokInputBox(pane)).toBeNull();
  });

  it('keeps old Tab/Space captures compatible with the same literal tab', () => {
    const pane = fixture('weekly-scrollback.pane.txt').replace('Tab:question', 'Tab/Space:question');
    expect(active(backend(), pane).map(d => d.keys)).toEqual([['\t']]);
  });

  it.each([
    ['another action', (p: string) => p.replace('Tab:question', 'Tab:upgrade')],
    ['an added paid row', (p: string) => p.replace('3 (○) Try Again', '4 (○) Buy a subscription\n  ┃  3 (○) Try Again')],
    ['a current composer below history', (p: string) => p + '\n╭────────────────────╮\n│ ❯                  │\n╰────────────────────╯\nShift+Tab:mode │ Ctrl+x:shortcuts\n'],
  ] as const)('refuses %s', (_name, change) => {
    expect(active(backend(), change(fixture('weekly-scrollback.pane.txt')))).toEqual([]);
  });
});

describe('Grok1.0.88 sign-in before a usable composer', () => {
  it('holds the actual unauthenticated screen even though the ready pattern sees a prompt', () => {
    const pane = fixture('login-unavailable.pane.txt');
    const b = backend();
    expect(b.getReadyPattern().test(pane)).toBe(true);
    const startup = b.getStartupDialogs().filter(d => d.isActive ? d.isActive(pane) : d.pattern.test(pane));
    expect(startup).toContainEqual(expect.objectContaining({ keys: [], inputBlocked: true, blocksDelivery: true }));
    expect(active(b, pane)).toContainEqual(expect.objectContaining({ keys: [], inputBlocked: true, blocksDelivery: true }));
  });

  it('does not turn stale sign-in labels above a current composer into an active hold', () => {
    const pane = fixture('login-unavailable.pane.txt') + '\n╭────────────────────╮\n│ ❯                  │\n╰────────────────────╯\nShift+Tab:mode │ Ctrl+x:shortcuts\n';
    expect(active(backend(), pane)).toEqual([]);
  });
});

describe('Grok1.0.88 captured delivery and lifecycle contract', () => {
  it.each(['11-short-taken-busy', '21-long-taken-busy', '22-busy-queued', '30-before-cancel', '40-error-500', '65-compact', '80-busy'])('%s stays busy', name => {
    const pane = fixture('panes/' + name + '.pane.txt');
    expect(backend().getBusyPattern().test(pane)).toBe(true);
  });
  it.each(['core-120-ready', '12-short-done', '23-queue-drained', '31-after-cancel', '60-tool', '61-mcp', '62-model', '63-effort', '64-unknown-model', '66-quit-once', '68-resume', '69-new', 'core-80-ready', '81-done', '84-dismissed', '105-dismissed'])('%s is an idle composer', name => {
    const pane = fixture('panes/' + name + '.pane.txt');
    expect(backend().getBusyPattern().test(pane)).toBe(false);
    expect(readGrokInputBox(pane)).not.toBeNull();
    expect(active(backend(), pane)).toEqual([]);
  });
  it.each(['core-120-trust', 'core-80-trust'])('%s is held before input', name => {
    const pane = fixture('panes/' + name + '.pane.txt');
    expect(readGrokInputBox(pane)).toBeNull();
    expect(backend().getStartupDialogs().some(d => d.pattern.test(pane) && d.description.includes('workspace trust'))).toBe(true);
  });
  it('cancel restores the unsubmitted draft', () => {
    expect(readGrokInputBox(fixture('panes/31-after-cancel.pane.txt'))).toEqual({text:'stall forever b', collapsedPastes:0});
  });
  it.each(['40-error-429', '82-rate-limit', '120-rate-limit-text'])('%s retains rate-limit classification', name => {
    const pane = fixture('panes/' + name + '.pane.txt');
    expect(backend().getErrorPatterns().filter(e => e.pattern.test(pane)).map(e => e.type)).toEqual(['rate_limit']);
  });
  it('retains the explicit outdated-CLI refusal', () => {
    expect(backend().getErrorPatterns().filter(e => e.pattern.test(fixture('panes/40-error-426.pane.txt'))).map(e => e.type)).toEqual(['outdated_cli']);
  });
  it.each(['100-picker', '104-after-tab', '83-weekly'])('%s only dismisses before reset', name => {
    expect(active(backend(), fixture('panes/' + name + '.pane.txt')).map(d => d.keys)).toEqual([['X']]);
  });
  it.each(['101-scrollback', '102-scrollback-x', '103-after-space'])('%s recovers with a literal tab', name => {
    expect(active(backend(), fixture('panes/' + name + '.pane.txt')).map(d => d.keys)).toEqual([['\t']]);
  });
  it.each(['1.0.77','1.0.88'])('live literal-tab/X on%s spends no additional request', version => {
    const counts = JSON.parse(fixture('requests-' + version + '.json'));
    expect(counts.beforeKeys).toBeGreaterThan(0);
    expect(counts.afterKeys).toBe(counts.beforeKeys);
  });
});

describe('Grok1.0.88 positive input proof', () => {
  const marker = (c: string) => '[agend-delivery-id:' + c.repeat(8) + '-1111-4111-8111-' + c.repeat(12) + ']';
  it('drafts and a never-sent collapsed paste do not count as taken', () => {
    expect(readGrokTakenMarkers(fixture('panes/10-short-draft.pane.txt'))).not.toContain(marker('a'));
    expect(readGrokTakenMarkers(fixture('panes/20-long-draft.pane.txt'))).not.toContain(marker('b'));
    expect(readGrokTakenMarkers(fixture('panes/70-never-enter.pane.txt'))).toEqual([]);
    expect(fixture('10-before-enter.jsonl')).toBe('');
    expect(fixture('70-never-enter.jsonl')).toBe('');
  });
  it('the real echo and queued row prove their own leading markers', () => {
    expect(readGrokTakenMarkers(fixture('panes/11-short-taken-busy.pane.txt'))).toContain(marker('a'));
    expect(readGrokTakenMarkers(fixture('panes/22-busy-queued.pane.txt'))).toEqual([marker('b'), marker('c')]);
  });
  it('the structured user record proves Enter before an answer, scoped to its UUID', () => {
    const rows = fixture('11-after-enter.jsonl');
    const id = JSON.parse(rows.trim().split('\n')[0]!).params.sessionId;
    expect(grokConsumedMarker(rows, id, marker('a'))).toBe('user');
    expect(grokConsumedMarker(rows, 'ffffffff-1111-4111-8111-ffffffffffff', marker('a'))).toBeNull();
    expect(grokConsumedMarker(rows.replaceAll('user_message_chunk','agent_message_chunk'), id, marker('a'))).toBeNull();
  });
});

describe('Grok1.0.88 reset-time retry rendering', () => {
  it('two Downs select Try Again, and another Down does not wrap to a paid row', () => {
    const rows = (name: string) => fixture('panes/' + name + '.ansi.txt').split('\n').filter(line => line.includes('(○)'));
    const two = rows('130-two-downs'), three = rows('131-third-down');
    expect(two).toHaveLength(3);
    expect(three).toEqual(two);
    expect(two[2]).toContain('\u001b[48;2;54;54;54m3 ');
    expect(two[2]).toContain('Try Again');
  });
  it('a locally restored allowance returns to the idle composer', () => {
    const pane = fixture('panes/132-retry-success.pane.txt');
    expect(pane).toContain('mock reply');
    expect(readGrokInputBox(pane)).not.toBeNull();
    expect(backend().getBusyPattern().test(pane)).toBe(false);
  });
  it('a still-limited retry re-shows the modal and dismissal sends no second retry', () => {
    expect(active(backend(), fixture('panes/133-still-limited.pane.txt')).map(d => d.keys)).toEqual([['X']]);
    expect(readGrokInputBox(fixture('panes/134-still-dismissed.pane.txt'))).not.toBeNull();
    const counts = JSON.parse(fixture('retry-requests.json'));
    expect(counts.afterRetryAndDismiss).toBe(counts.beforeRetry + 1);
  });
});
