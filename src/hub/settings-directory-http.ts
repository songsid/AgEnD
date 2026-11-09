/** Configured-administrator Hub listener adapter. The fleet/D3 listener acquires its own authority separately. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HubActor } from "./types.js";
import type { HubDirectorySettingsControl } from "./settings-directory-control.js";
import type { HubDirectoryBrowserSessions } from "./settings-directory-runtime.js";
import type { HubDirectoryResponse } from "./directory-response-owner.js";
import { HubProtocolError } from "./validation.js";
import { HubSettingsError } from "./settings-commit.js";
import { HubDirectoryProofError } from "./settings-directory-proof.js";

export const HUB_DIRECTORY_SETTINGS_FEATURE = "directory-settings-v1";
const PREFIX = "/hub/v1/admin/hub/directory";
const STATUS: Readonly<Record<string, number>> = Object.freeze({ invalid: 400, denied: 403, revoked: 403, reauthentication: 403,
  trust: 409, stale: 409, expired: 409, unchanged: 409, conflict: 409, busy: 409, backpressure: 429, unavailable: 503, recovery: 503, uncertain: 503 });
const known = (error: unknown): error is HubSettingsError | HubDirectoryProofError | HubProtocolError =>
  error instanceof HubSettingsError || error instanceof HubDirectoryProofError || error instanceof HubProtocolError;
async function invoke<T>(work: () => T | Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw known(error) ? error : new HubProtocolError("unavailable"); }
}
export function directorySettingsRefusal(error: unknown) {
  const code = known(error) ? error.code : "unavailable";
  return Object.hasOwn(STATUS, code) ? { status: STATUS[code]!, code } : { status: 503, code: "unavailable" };
}
export interface HubDirectorySettingsHttpRequest {
  req: IncomingMessage; res: ServerResponse; path: string; method: string; query: URLSearchParams;
  ctx: { token: string | null; requestId: string; current(): boolean; requireAdmin(): Promise<HubActor> };
  signedIn(): unknown; csrf(): unknown; body(): Promise<Record<string, unknown>>;
  send(status: number, value: unknown): void;
  sessions: HubDirectoryBrowserSessions;
  capture?(proof: () => boolean): HubDirectoryResponse;
}
export async function handleHubDirectorySettingsHttp(create: (() => Promise<HubDirectorySettingsControl>) | undefined, q: HubDirectorySettingsHttpRequest): Promise<boolean> {
  if (q.path !== PREFIX && !["/prepare", "/test", "/save", "/cancel"].some(action => q.path === PREFIX + action)) return false;
  if (!create) { q.send(404, { code: "not-found" }); return true; }
  if (q.query.size) { q.send(400, { code: "invalid" }); return true; }
  const action = q.path.slice(PREFIX.length);
  if (q.method !== (action ? "POST" : "GET")) { q.send(405, { code: "method" }); return true; }
  q.signedIn(); if (action) q.csrf();
  let disconnected = false;
  const closed = () => { if (!q.res.writableEnded) disconnected = true; };
  q.res.once("close", closed);
  const current = () => !disconnected && q.ctx.current() === true;
  try {
    const actor = await q.ctx.requireAdmin();
    if (actor.kind !== "directory" || !current()) throw new HubProtocolError("denied");
    const context = { actor: { kind: "hub-administrator" as const, person: { ...actor.person }, sessionId: actor.sessionId, requestId: q.ctx.requestId }, current };
    const input = action ? await q.body() : undefined;
    q.signedIn(); if (!current()) throw new HubProtocolError("revoked");
    const control = await invoke(create);
    q.signedIn(); if (!current()) throw new HubProtocolError("revoked");
    let result: unknown;
    if (!action) result = await invoke(() => control.read(context));
    else if (action === "/prepare") result = await invoke(() => control.prepare(input, context));
    else if (action === "/test") result = await invoke(() => control.test(input, context));
    else if (action === "/cancel") result = await invoke(() => control.cancel(input, context));
    else {
      if (!q.ctx.token || !q.capture) throw new HubProtocolError("unavailable");
      const rotation = q.sessions.prepareDirectoryRotation(q.ctx.token, context.actor);
      try { await invoke(() => control.apply(input, context, { capture: () => q.capture!(current), rotation })); }
      finally { rotation.discard(); }
      return true; // The Save owns its original response, including known pre-decision refusals. Never send twice.
    }
    q.signedIn(); if (!current()) throw new HubProtocolError("revoked");
    q.send(200, result);
  } catch (error) {
    // Capture may already have replied, or discarded an uncertain outcome. Neither can be converted to another packet.
    if (q.res.headersSent || q.res.writableEnded || q.res.destroyed) return true;
    const refusal = directorySettingsRefusal(error);
    if (refusal.code === "backpressure") q.res.setHeader("Retry-After", "10");
    // SignedOut and transport HTTP errors retain the existing listener's exact handling.
    if (!known(error)) throw error;
    q.send(refusal.status, { ok: false, code: refusal.code });
  } finally { q.res.removeListener("close", closed); }
  return true;
}
