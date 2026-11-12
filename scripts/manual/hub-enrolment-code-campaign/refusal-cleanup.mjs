/** Fixture cleanup only: a terminal remote refusal may remove Cancel during locator resolution. */
export async function settleRefusalCleanup({ read, click, wait, reason }) {
  const done = () => {
    const r = read();
    return !r.issued && r.outcomeKnown && (r.stage === 'cancelled' || r.stage === 'ended' && r.reason === reason);
  };
  if (!done()) {
    try { await click(); } catch (error) { if (!done()) throw error; }
  }
  await wait(done);
  return read().stage;
}
