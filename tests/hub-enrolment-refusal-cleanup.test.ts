import { describe, expect, it, vi } from 'vitest';
import { settleRefusalCleanup } from '../scripts/manual/hub-enrolment-code-campaign/refusal-cleanup.mjs';
describe('owned refusal fixture settles a real terminal transition instead of chasing a removed Cancel', () => {
  const ended = () => ({ issued:false, outcomeKnown:true, stage:'ended', reason:'code-ended' });
  const wait = async (done:()=>boolean) => { expect(done()).toBe(true); };
  it('does not click a refusal that has already settled', async () => {
    const click=vi.fn();expect(await settleRefusalCleanup({read:ended,click,wait,reason:'code-ended'})).toBe('ended');expect(click).not.toHaveBeenCalled();
  });
  it('accepts the exact terminal refusal when it removes Cancel during the click', async () => {
    let r={...ended(),stage:'pending',reason:null as string|null};
    const click=vi.fn(async()=>{r=ended();throw Error('locator retired');});
    expect(await settleRefusalCleanup({read:()=>r,click,wait,reason:'code-ended'})).toBe('ended');expect(click).toHaveBeenCalledOnce();
  });
  it('still cancels a pending request and verifies its durable cancelled state', async () => {
    let r={...ended(),stage:'pending',reason:null as string|null};
    const click=vi.fn(async()=>{r={...ended(),stage:'cancelled',reason:'cancelled'};});
    expect(await settleRefusalCleanup({read:()=>r,click,wait,reason:'code-ended'})).toBe('cancelled');expect(click).toHaveBeenCalledOnce();
  });
  it.each([{issued:true},{outcomeKnown:false},{reason:'authority'},{stage:'held'}])('never hides click failure for an unproven result %j', async patch => {
    const read=()=>({...ended(),...patch}),click=vi.fn(async()=>{throw Error('click failed');});
    await expect(settleRefusalCleanup({read,click,wait,reason:'code-ended'})).rejects.toThrow('click failed');
  });
});
