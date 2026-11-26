/** Host-owner UI boundary. Kept independent from the installer so Off still works after a failed install. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { readBoundedWebBody } from "./web-body.js";

const label = z.string().min(1).max(256);
export const RequestContextControlViewSchema = z.strictObject({
  revision: z.number().int().nonnegative(), enabled: z.boolean(), everActivated: z.boolean(),
  phase: z.enum(["on", "off", "draining", "blocked"]), canChange: z.boolean(),
  blockers: z.array(z.strictObject({ id: label, kind: z.enum(["legacy", "peers", "owners", "recovery", "returns", "tickets", "work"]),
    labels: z.array(label).max(64), action: z.enum(["inspect", "stop-waiting", "decline", "withdraw", "stop-work"]).optional() })).max(128),
});
export type RequestContextControlView = z.infer<typeof RequestContextControlViewSchema>;
export interface RequestContextControlPrincipal {
  /** Exact admitted session/account binding, not a browser-provided key. */
  readonly binding: string;
  readonly verified: boolean;
  current(): boolean;
}
export interface RequestContextControlHost {
  principal(req: IncomingMessage, url: URL): RequestContextControlPrincipal | null;
  permitContinuation(req: IncomingMessage, res: ServerResponse): boolean;
  read(actor: RequestContextControlPrincipal): RequestContextControlView | Promise<RequestContextControlView>;
  change(input: Readonly<{ revision: number; action: "enable" | "disable" | "check" }>, actor: RequestContextControlPrincipal): RequestContextControlView | Promise<RequestContextControlView>;
}
const decision = z.strictObject({ revision: z.number().int().nonnegative(), action: z.enum(["enable", "disable", "check"]) });
const live = (actor: RequestContextControlPrincipal | null): actor is RequestContextControlPrincipal => {
  try { return !!actor && actor.current() === true; } catch { return false; }
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
  try { actor = host.principal(req, url); } catch { answer(res, 503, { error: "unavailable" }); return true; }
  if (!live(actor)) { answer(res, 403, { error: "owner-required" }); return true; }
  const first = actor;
  const current = () => {
    const now = host.principal(req, url);
    if (!live(first) || !live(now) || now.binding !== first.binding) throw Error("owner-required");
    return now;
  };
  void (async () => {
    try {
      let value: RequestContextControlView;
      if (req.method === "POST") {
        if (!first.verified) throw Error("verification-required");
        if (!host.permitContinuation(req, res)) return;
        let input: z.infer<typeof decision>;
        try { const body = await readBoundedWebBody(req, 4096); input = decision.parse(JSON.parse(body.toString("utf8"))); }
        catch { throw Error("invalid-request"); }
        const admitted = current();
        if (!admitted.verified) throw Error("verification-required");
        // Revision/host role/installation epoch must also be checked inside the owning transaction.
        value = await host.change(input, admitted);
      } else value = await host.read(first);
      const after = current();
      if (req.method === "POST" && !after.verified) throw Error("verification-required");
      const view = RequestContextControlViewSchema.parse(value);
      answer(res, 200, { ...view, canChange: view.canChange && after.verified });
    } catch (error) {
      const code = error instanceof Error ? error.message : "unavailable";
      const known = ["owner-required", "verification-required", "stale", "unavailable", "invalid-request"].includes(code);
      answer(res, code === "stale" ? 409 : ["owner-required", "verification-required"].includes(code) ? 403 : code === "invalid-request" ? 400 : 503,
        { error: known ? code : "unavailable" });
    }
  })();
  return true;
}
