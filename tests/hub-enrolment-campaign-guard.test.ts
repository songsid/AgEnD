/** Light, pure interlock tests. They never import the launch entry or start a process/container/browser. */
import { describe, expect, it } from 'vitest';
import { requireWindow } from '../scripts/manual/hub-enrolment-code-campaign/guard.mjs';
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
  it('accepts the exact source during its later explicit-GO window', () => { const p = plan(); expect(requireWindow(p, source, now)).toBe(p); });
});
