import {REQUEST_CONTEXT_BLOCKER_FAMILIES} from "./request-context-drain-projection.js";
/** Host-owner UI boundary. Kept independent from the installer so Off still works after a failed install. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { t } from "./locale.js";

import { readBoundedWebBody } from "./web-body.js";
import { isSettingsReplay, settingsRequestExecution } from "./settings-request-capability.js";
import type { SettingsExecution } from "./settings-transaction.js";

export const REQUEST_CONTEXT_ENABLE_UNAVAILABLE = "request-context-enable-unavailable";
const label = z.string().min(1).max(256);
export const RequestContextControlViewSchema = z.strictObject({
  revision: z.number().int().nonnegative(), enabled: z.boolean(), everActivated: z.boolean(), attempted: z.boolean(),
  restartCount: z.number().int().positive().max(1000).optional(),
  goBack: z.strictObject({ attemptIds: z.array(z.string().regex(/^\d{8}T\d{6}Z-[a-f0-9]{8}$/)).min(1).max(1024), availableUntil: z.iso.datetime(), timeZone: label }).optional(),
  phase: z.enum(["on", "off", "draining", "blocked"]), canChange: z.boolean(),
  /** A failed confirmed On remains explanatory after rollback, SSE refresh or page reload. Never raw diagnostics. */
  enableFailed: z.boolean().optional(),
  /** Release guard: enabling is unavailable; disabling remains supported. */
  enableUnavailable: z.boolean().optional(),
  blockers: z.array(z.strictObject({ id: label, kind: z.enum(["legacy", "peers", "owners", "recovery", "update", "returns", "tickets", "work"]),
    families:z.array(z.enum(REQUEST_CONTEXT_BLOCKER_FAMILIES)).max(10).optional(), unknownEnd:z.boolean().optional(),
    labels: z.array(label).max(64), ownerCause: z.enum(["work", "update"]).optional(),
    agents: z.array(z.strictObject({ id: label, label })).max(64).optional(), action: z.enum(["inspect", "stop-waiting", "decline", "withdraw", "stop-work", "acknowledge", "retire"]).optional() })).max(128),
});
export type RequestContextControlView = z.infer<typeof RequestContextControlViewSchema>;
export const RequestContextControlDecisionSchema = z.discriminatedUnion("action", [
  z.strictObject({ revision: z.number().int().nonnegative(), action: z.enum(["enable", "disable", "check"]) }),
  z.strictObject({ revision: z.number().int().nonnegative(), action: z.literal("resolve"), blockerId: label,
    resolution: z.enum(["stop-waiting", "decline", "withdraw", "stop-work", "acknowledge", "retire"]) }),
]);
export type RequestContextControlDecision = z.infer<typeof RequestContextControlDecisionSchema>;
export interface RequestContextControlPrincipal {
  /** Exact admitted session/account binding, not a browser-provided key. */
  readonly binding: string;
  readonly verified: boolean;
  readonly person?:import("./contact-auth-types.js").ContactPerson;
  /** Present only on the server-created, independently confirmed Settings replay. */
  readonly execution?: SettingsExecution;
  current(): boolean;
}
export interface RequestContextControlHost {
  principal(req: IncomingMessage, url: URL): RequestContextControlPrincipal | null;
  permitContinuation(req: IncomingMessage, res: ServerResponse): boolean;
  read(actor: RequestContextControlPrincipal): RequestContextControlView | Promise<RequestContextControlView>;
  /** Already-derived state for passive channels; never runs readiness or any installer mutation. */
  snapshot(): RequestContextControlView | null;
  /** Read-only readiness refresh. Must never activate, resolve work or emit the enable notice. */
  recheck(actor: RequestContextControlPrincipal): RequestContextControlView | Promise<RequestContextControlView>;
  /** The owner must recheck actor.execution at the actual commit after any asynchronous preparation. */
  change(input: Readonly<RequestContextControlDecision>, actor: RequestContextControlPrincipal): RequestContextControlView | Promise<RequestContextControlView>;
}
export function projectRequestContextControl(req: IncomingMessage, url: URL, host: RequestContextControlHost | undefined,
  value: unknown): RequestContextControlView | undefined {
  try {
    const actor = host?.principal(req, url);
    if (!live(actor ?? null)) return;
    const view = RequestContextControlViewSchema.parse(value);
    if (!actor!.current()) return;
    return { ...view, canChange: view.canChange && actor!.verified };
  } catch { return; }
}
export function projectRequestContextNeeds(req: IncomingMessage, url: URL, host: RequestContextControlHost | undefined,
  items: unknown[]): unknown[] {
  return items.flatMap(item => {
    if (!item || typeof item !== "object" || (item as { reason?: string }).reason !== "request_context_cutover") return [item];
    const view = projectRequestContextControl(req, url, host, (item as { requestContextCutover?: unknown }).requestContextCutover);
    return view && (view.everActivated || view.attempted) ? [{ ...item, requestContextCutover: view }] : [];
  });
}
export function requestContextControlSnapshot(req: IncomingMessage, url: URL, host: RequestContextControlHost | undefined): RequestContextControlView | null | undefined {
  if (!host) return;
  try { return projectRequestContextControl(req, url, host, host.snapshot?.()) ?? null; }
  catch { return null; }
}
const live = (actor: RequestContextControlPrincipal | null): actor is RequestContextControlPrincipal => {
  try { return !!actor && actor.current() === true; } catch { return false; }
};

const confirmedPrincipals = new WeakMap<object, { host: RequestContextControlHost; principal: RequestContextControlPrincipal }>();
/** Capture the original verified principal, not its credentials. No body/header can mint this continuation. */
export function prepareRequestContextControlReplay(req: IncomingMessage, url: URL, host: RequestContextControlHost):
  (replay: IncomingMessage, confirmedCurrent: () => boolean) => void {
  const first = host.principal(req, url);
  if (!first?.verified || !live(first)) throw Error("verification-required");
  const current = () => {
    try { const now = host.principal(req, url); return live(first) && live(now) && now.verified && now.binding === first.binding; }
    catch { return false; }
  };
  return (replay, confirmedCurrent) => {
    const execution = settingsRequestExecution(replay);
    if (!isSettingsReplay(replay) || !execution || !current() || !confirmedCurrent()) throw Error("verification-required");
    execution.assert();
    confirmedPrincipals.set(replay, { host, principal: Object.freeze({ binding: first.binding, verified: true, execution,...(first.person?{person:first.person}:{}),
      current: () => current() && confirmedCurrent() }) });
  };
}
const principalOf = (req: IncomingMessage, url: URL, host: RequestContextControlHost): RequestContextControlPrincipal | null => {
  const confirmed = confirmedPrincipals.get(req);
  if (confirmed && confirmed.host !== host) throw Error("owner-required");
  return confirmed?.principal ?? host.principal(req, url);
};

function answer(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
export function handleRequestContextControlApi(req: IncomingMessage, res: ServerResponse, url: URL, host?: RequestContextControlHost): boolean {
  if (url.pathname !== "/api/settings/request-context") return false;
  if (!host) { answer(res, 404, { error: "not-found" }); return true; }
  if (url.searchParams.size || !["GET", "POST"].includes(req.method ?? "GET")) { answer(res, 400, { error: "invalid-request" }); return true; }
  let actor: RequestContextControlPrincipal | null;
  try { actor = principalOf(req, url, host); } catch { answer(res, 503, { error: "unavailable" }); return true; }
  if (!live(actor)) { answer(res, 403, { error: "owner-required" }); return true; }
  const first = actor;
  const current = () => {
    const now = principalOf(req, url, host);
    if (!live(first) || !live(now) || now.binding !== first.binding) throw Error("owner-required");
    return now;
  };
  void (async () => {
    try {
      let value: RequestContextControlView, mutated = false;
      if (req.method === "POST") {
        if (!confirmedPrincipals.has(req) && !host.permitContinuation(req, res)) return;
        let input: RequestContextControlDecision;
        try { const body = await readBoundedWebBody(req, 4096); input = RequestContextControlDecisionSchema.parse(JSON.parse(body.toString("utf8"))); }
        catch { throw Error("invalid-request"); }
        const admitted = current();
        if (input.action !== "check" && (!first.verified || !admitted.verified || !confirmedPrincipals.has(req))) throw Error("verification-required");
        // Revision/host role/installation epoch and the offered blocker/action must also match inside the owning transaction.
        mutated = input.action !== "check";
        admitted.execution?.assert();
        if (input.action === "enable" && (await host.read(admitted)).enableUnavailable) throw Error(REQUEST_CONTEXT_ENABLE_UNAVAILABLE);
        value = input.action === "check" ? await host.recheck(admitted) : await host.change(input, admitted);
        if (admitted.execution && !admitted.execution.completed) admitted.execution.complete();
      } else value = await host.read(first);
      const after = current();
      if (mutated && !after.verified) throw Error("verification-required");
      const view = RequestContextControlViewSchema.parse(value);
      answer(res, 200, { ...view, canChange: view.canChange && after.verified });
    } catch (error) {
      const code = error instanceof Error ? error.message : "unavailable";
      if (code === REQUEST_CONTEXT_ENABLE_UNAVAILABLE) {
        answer(res, 409, { error: code, message: t("request_context_control.enableUnavailable") }); return;
      }
      const known = ["owner-required", "verification-required", "stale", "unavailable", "invalid-request"].includes(code);
      answer(res, code === "stale" ? 409 : ["owner-required", "verification-required"].includes(code) ? 403 : code === "invalid-request" ? 400 : 503,
        { error: known ? code : "unavailable" });
    }
  })();
  return true;
}
