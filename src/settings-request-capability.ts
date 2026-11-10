import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { JoinLocalAuthority, JoinLocalSession } from "./hub/join/local-journal.js";
import type { SettingsExecution } from "./settings-transaction.js";

interface Continuation { body: Buffer; execution: SettingsExecution; binding: string; localAdmin?: () => boolean; localSession?: JoinLocalSession; confirmedCurrent?: () => boolean; label?: string }
const continuations = new WeakMap<object, Continuation>();
const bodies = new WeakMap<object, Buffer>();
const replays = new WeakSet<object>();
export function isSettingsReplay(req: object): boolean { return replays.has(req); }
/** Only server code creates a replay; bearer cookies/tokens are never replayed. */
export function createSettingsReplay(input: { method: string; url: string; key?: string; body: Buffer; binding: string; localAdmin?: () => boolean; localSession?: JoinLocalSession; confirmedCurrent?: () => boolean; label?: string }, execution: SettingsExecution): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = input.method; req.url = input.url; replays.add(req);
  req.headers = input.key ? { "idempotency-key": input.key } : {};
  continuations.set(req, { body: Buffer.from(input.body), execution, binding: input.binding, localAdmin: input.localAdmin, localSession: input.localSession, confirmedCurrent: input.confirmedCurrent, label: input.label });
  return req;
}
export function settingsRequestExecution(req: object): SettingsExecution | undefined { return continuations.get(req)?.execution; }
/** The label of the browser that asked (the pending change's `requestedBy`), carried to its replay: what a page then shows as "started on". */
export function settingsRequestLabel(req: object): string | undefined { return continuations.get(req)?.label; }
export function settingsRequestBinding(req: object): string | undefined { return continuations.get(req)?.binding; }
/** A server-owned continuation retains authority through a current non-secret principal, never replayed headers. */
export function settingsRequestLocalAdmin(req: object): boolean {
  const continuation = continuations.get(req);
  if (!continuation?.localAdmin) return false;
  continuation.execution.assert();
  return continuation.localAdmin() === true;
}
/**
 * AGEND-144: is the administrator behind this confirmed replay STILL the one who asked and confirmed — the execution not stale (session, the store's own state and deadline,
 * the confirmation's capability: Apply now's policy, or the code's enrollment), the local-admin principal live, and the independent confirmer current? Asked again after each wait
 * and immediately before an effect that outlives the request (an installer). A lock or a claim is never a substitute for it. False for anything that is not a server-made replay.
 */
export function settingsRequestAuthorityCurrent(req: object): boolean {
  const c = continuations.get(req);
  if (!c || !replays.has(req)) return false;
  try { return c.execution.current() && c.localAdmin?.() === true && (!c.confirmedCurrent || c.confirmedCurrent() === true); } catch { return false; }
}
/** Live principal only, for settling the exact committed operation; this never admits another write. */
export function settingsRequestLocalAdminCurrent(req: object): boolean {
  return continuations.get(req)?.localAdmin?.() === true;
}
export function cacheSettingsBody(req: object, body: Buffer, execution?: SettingsExecution, binding = "", localAdmin?: () => boolean): void {
  if (execution) continuations.set(req, { body: Buffer.from(body), execution, binding, localAdmin });
  else bodies.set(req, Buffer.from(body));
}
export function cachedSettingsBody(req: object): Buffer | undefined {
  const body = continuations.get(req)?.body ?? bodies.get(req); return body ? Buffer.from(body) : undefined;
}
export function settingsWrite<T>(req: object, effect: () => T, final = true): T {
  const execution = settingsRequestExecution(req);
  return execution ? final ? execution.commit(effect) : execution.mutate(effect) : effect();
}

/** Original cookie-session and independent confirmer; minted only by the Settings replay. Never inferred from its headers. */
export function settingsRequestJoinAuthority(req: object): JoinLocalAuthority | undefined {
  const c = continuations.get(req);
  return c?.localSession && c.confirmedCurrent ? { session: c.localSession, confirmedCurrent: c.confirmedCurrent } : undefined;
}
