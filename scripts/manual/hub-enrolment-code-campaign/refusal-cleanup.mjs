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

/** The Hub uses authority for code retirement; accept it only with the exact unissued server record. */
export function refusalCleanupReason({ reason, binding, remote, codeEnded }) {
  if (reason !== 'code-ended') return reason;
  if (!remote || remote.stage !== 'ended' || remote.reason !== 'authority' || remote.issuedHash !== null
    || !remote.enrolmentCodeId || !codeEnded || ['requestId','operationId','fleetId'].some(k => remote.binding?.[k] !== binding[k]))
    throw Error('Exact ended-code retirement proof required');
  return 'authority';
}
