/** Light, pure interlock tests. They never import the launch entry or start a process/container/browser. */
import { describe, expect, it } from 'vitest';
import { requireWindow, requireHostBudget } from '../scripts/manual/hub-enrolment-code-campaign/guard.mjs';
const source = 'a'.repeat(40), now = 100_000;
const plan = () => ({ explicitGo: true, goReference: 'xmsg-owned-test-go', source, from: now - 1, until: now + 60_000, version: '2.3.5-alpha.16' });
describe('combined campaign requires a later explicit GO and a live non-overlapping window', () => {
  it('the allocated-window-only template cannot launch', () => { expect(() => requireWindow({ ...plan(), explicitGo: false }, source, now)).toThrow('GO'); });
  it('binds the exact source; wrong or malformed source never launches', () => {
    expect(() => requireWindow(plan(), 'b'.repeat(40), now)).toThrow('Source');
    expect(() => requireWindow({ ...plan(), source: 'main' }, 'main', now)).toThrow('Source');
  });
  it('refuses before, at the deadline, and on overlap even in an otherwise valid window', () => {
    expect(() => requireWindow(plan(), source, now - 2)).toThrow('window');
    expect(() => requireWindow(plan(), source, now + 60_000)).toThrow('window');
    expect(() => requireWindow(plan(), source, now, true)).toThrow('overlap');
  });
  it('refuses missing GO evidence, an unbounded window, and an unstamped source version', () => {
    expect(() => requireWindow({ ...plan(), goReference: '' }, source, now)).toThrow('GO');
    expect(() => requireWindow({ ...plan(), until: now + 3 * 3600_000 }, source, now)).toThrow('bounded');
    expect(() => requireWindow({ ...plan(), version: '1.22.0' }, source, now)).toThrow('version');
  });
  it('only admits the declared diagnostic sequence, never an arbitrary phase or budget', () => {
    expect(requireWindow({...plan(),mode:'diagnose-3713'},source,now).mode).toBe('diagnose-3713');
    expect(()=>requireWindow({...plan(),mode:'skip-assertions'},source,now)).toThrow('mode');
  });
  it('accepts the exact source during its later explicit-GO window', () => { const p = plan(); expect(requireWindow(p, source, now)).toBe(p); });
});

describe('swap-off host campaign limits', () => {
  it('refuses at load12 or below4GiB, and refuses missing readings', () => {
    expect(()=>requireHostBudget(12,9000)).toThrow('load');
    expect(()=>requireHostBudget(3,4095)).toThrow('memory');
    expect(()=>requireHostBudget(NaN,9000)).toThrow('unavailable');
    expect(()=>requireHostBudget(3,NaN)).toThrow('unavailable');
  });
  it('permits a bounded reading below load12 with at least4GiB available', () => {
    expect(()=>requireHostBudget(11.9,4096)).not.toThrow();
  });
});
