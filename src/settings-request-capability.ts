import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { SettingsExecution } from "./settings-transaction.js";

interface Continuation { body: Buffer; execution: SettingsExecution; binding: string; localAdmin?: () => boolean }
const continuations = new WeakMap<object, Continuation>();
const bodies = new WeakMap<object, Buffer>();
const replays = new WeakSet<object>();
export function isSettingsReplay(req: object): boolean { return replays.has(req); }
/** Only server code creates a replay; bearer cookies/tokens are never replayed. */
export function createSettingsReplay(input: { method: string; url: string; key?: string; body: Buffer; binding: string; localAdmin?: () => boolean }, execution: SettingsExecution): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = input.method; req.url = input.url; replays.add(req);
  req.headers = input.key ? { "idempotency-key": input.key } : {};
  continuations.set(req, { body: Buffer.from(input.body), execution, binding: input.binding, localAdmin: input.localAdmin });
  return req;
}
export function settingsRequestExecution(req: object): SettingsExecution | undefined { return continuations.get(req)?.execution; }
export function settingsRequestBinding(req: object): string | undefined { return continuations.get(req)?.binding; }
/** A server-owned continuation retains authority through a current non-secret principal, never replayed headers. */
export function settingsRequestLocalAdmin(req: object): boolean {
  const continuation = continuations.get(req);
  if (!continuation?.localAdmin) return false;
  continuation.execution.assert();
  return continuation.localAdmin() === true;
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
