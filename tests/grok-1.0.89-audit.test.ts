import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GrokBackend } from '../src/backend/grok.js';
import { grokConsumedMarker } from '../src/grok-delivery-proof.js';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/grok-1.0.89-audit/panes', name + '.pane.txt'), 'utf8');
const backend = new GrokBackend('/tmp/grok-1089-audit-test');
const error = (pane: string) => backend.getErrorPatterns().find(p => p.pattern.test(pane));
const packet = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/grok-1.0.89-audit', name), 'utf8');

describe('Grok 1.0.89 real compaction errors', () => {
  it.each([120, 80])('classifies usage-limit and credit 401s as quota at %i columns', width => {
    for (const kind of ['usage', 'credits']) {
      expect(error(fixture(`compact-401-${kind}-${width}`))).toMatchObject({ type: 'quota', action: 'notify' });
    }
  });

  it.each([120, 80])('retains a real compaction authentication error at %i columns', width => {
    expect(error(fixture(`compact-401-auth-${width}`))).toMatchObject({ type: 'auth_error', action: 'pause' });
  });

  it.each([120, 80])('handles the same captured 1.0.88 quota frames at %i columns', width => {
    for (const kind of ['usage', 'credits']) {
      expect(error(fixture(`1.0.88-compact-401-${kind}-${width}`))?.type).toBe('quota');
    }
  });

  it.each([120, 80])('does not invent quota information discarded by the ordinary 401 UI at %i columns', width => {
    for (const kind of ['usage', 'credits', 'ordinary']) {
      const pane = fixture(`401-${kind}-${width}`);
      expect(pane).toContain('Authentication required:');
      expect(error(pane)?.type).not.toBe('quota');
    }
  });

  it.each([
    'Compaction failed: Unauthorized (401): usage limit reached',
    '  ┃  Retry failed: Unauthorized (401): usage limit reached',
    '  ┃  Compaction failed: Unauthorized (401)\n\nusage limit reached',
    '  ┃  Compaction failed: Unauthorized (401)\nUser says usage limit reached',
    '  ┃  Compaction failed: Unauthorized (401)\n  ┃  detail\n  ┃  detail\n  ┃  detail\n  ┃  detail\n  ┃  usage limit reached',
  ])('does not reinterpret unrelated quota prose: %s', text => {
    expect(error(text)?.type).not.toBe('quota');
  });
});

describe('Grok 1.0.89 retained live terminal contract', () => {
  it.each(['11-short-taken-busy', '21-long-taken-busy', '22-busy-queued', '30-before-cancel', '40-error-500', '65-compact', '80-busy'])('%s is busy', name => {
    expect(backend.getBusyPattern().test(fixture(name))).toBe(true);
  });
  it.each(['12-short-done', '31-after-cancel', '60-tool', '61-mcp', '62-model', '63-effort', '64-unknown-model', '68-resume', '69-new', '81-done', '84-dismissed', '132-retry-success'])('%s retains an idle input box', name => {
    const pane = fixture(name);
    expect(backend.getBusyPattern().test(pane)).toBe(false);
    expect(backend.readInputRow(pane)).not.toBeNull();
  });
  it.each(['core-120-trust', 'core-80-trust'])('%s matches the existing trust dialog', name => {
    expect(backend.getStartupDialogs().some(d => d.pattern.test(fixture(name)) && d.description.includes('workspace trust'))).toBe(true);
  });
  it('still holds unauthenticated input without typing a menu choice', () => {
    const pane = fixture('110-no-key');
    const active = backend.getRuntimeDialogs().filter(d => d.isActive ? d.isActive(pane) : d.pattern.test(pane));
    expect(active).toContainEqual(expect.objectContaining({ keys: [], inputBlocked: true, blocksDelivery: true }));
  });
  it.each(['40-error-429', '40-error-429-text', '82-rate-limit'])('%s is a rate limit', name => {
    expect(error(fixture(name))?.type).toBe('rate_limit');
  });
  it('uses the exact structured user record as consumption, never drafts or assistant chunks', () => {
    const rows = packet('11-after-enter.jsonl');
    const sid = JSON.parse(rows.trim().split('\n')[0]!).params.sessionId;
    const marker = '[agend-delivery-id:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa]';
    expect(grokConsumedMarker(rows, sid, marker)).toBe('user');
    expect(grokConsumedMarker(packet('10-before-enter.jsonl'), sid, marker)).toBeNull();
    expect(grokConsumedMarker(packet('70-never-enter.jsonl'), sid, marker)).toBeNull();
    expect(grokConsumedMarker(rows, 'ffffffff-1111-4111-8111-ffffffffffff', marker)).toBeNull();
    expect(grokConsumedMarker(rows.replaceAll('user_message_chunk', 'agent_message_chunk'), sid, marker)).toBeNull();
  });
  it('a still-limited retry spends one request and dismissal spends none', () => {
    const counts = JSON.parse(packet('retry-requests.json'));
    expect(counts.beforeRetry).toBeGreaterThan(0);
    expect(counts.afterRetryAndDismiss).toBe(counts.beforeRetry + 1);
  });
});
