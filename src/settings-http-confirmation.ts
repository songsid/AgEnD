import type { IncomingMessage, ServerResponse } from "node:http";
import { ServerResponse as Response } from "node:http";
import { readBoundedWebBody } from "./web-body.js";
import { requestSessionBinding } from "./connection-secrets.js";
import { cacheSettingsBody, createSettingsReplay, settingsRequestExecution } from "./settings-request-capability.js";
import { prepareSettingsEffect, isSettingsMutation, type SettingsEffectContext } from "./settings-effect.js";
import { SettingsConfirmationStore, SettingsConfirmationError, type SettingsPendingView } from "./settings-confirmation.js";
import { SettingsExecution, settingsFingerprint } from "./settings-transaction.js";
import { gatewayRequestContext } from "./web-request-context.js";

export interface SettingsPrincipal {
  id: string; label: string; source: SettingsPendingView["source"]; current(): boolean;
  /** Only an authenticated local web administrator supplies this; setup/header/public principals do not. */
  localAdmin?(): boolean;
}
export interface SettingsBaseline extends SettingsEffectContext { fingerprint: string }
/**
 * #2170: the requester's own confirmation — a web-verified session whose account is an admin of exactly the change's
 * effect owners. `current()` is asked again at execution (store.decide); `done` hears the outcome (General's notice).
 */
export interface SettingsSelfConfirmation { label: string; current(): boolean; done?(view: SettingsPendingView): void | Promise<void> }
export type SettingsRequestHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body));
}
/** The same server-side gate serves a running fleet and the no-fleet SetupHost. */
export class SettingsHttpConfirmation {
  private passed = new WeakSet<object>();
  constructor(readonly store: SettingsConfirmationStore, private readonly options: {
    principal(req: IncomingMessage): SettingsPrincipal | null;
    baseline(): Promise<SettingsBaseline>;
    snapshot(): unknown;
    job?(id: string): Promise<boolean>;
    applied?(path: string, result: unknown, execution: SettingsExecution): void | Promise<void>;
    /** #2170: this request's own confirmation, or null (the chat or host confirmation, as before). */
    selfConfirm?(req: IncomingMessage, id: string): SettingsSelfConfirmation | null;
  }) {}
  handle(req: IncomingMessage, res: ServerResponse, url: URL, next: SettingsRequestHandler): boolean {
    if (settingsRequestExecution(req) || this.passed.has(req)) return false;
    const path = url.pathname, method = req.method ?? "GET";
    const pending = path.match(/^\/api\/settings\/pending(?:\/([0-9a-f]{32}))?$/);
    if (pending && (method === "GET" || method === "DELETE" && pending[1])) {
      const principal = this.options.principal(req);
      if (!principal?.current()) { json(res, 401, { error: "session_required" }); return true; }
      const result = pending[1] ? method === "DELETE" ? this.store.withdraw(pending[1], principal.id) : this.store.get(pending[1], principal.id) : this.store.list(principal.id);
      json(res, result === null ? 404 : 200, result === null ? { error: "not_found" } : result); return true;
    }
    if (!isSettingsMutation(method, path)) return false;
    // #1620: the web settings (sessions, the browser terminal, the public link itself) are never changed over the
    // temporary public link — the same rule as tokens and secrets: refused before anything is proposed.
    if ((path === "/api/settings/fleet/web" || path.startsWith("/api/settings/public-tunnel-token/")) && gatewayRequestContext(req)) { json(res, 403, { error: "web_settings_not_over_public_link" }); return true; }
    // #1629 r4.1 Q3 (b): the card's upload limits too (absent from the public link's manifest as well).
    if (path === "/api/settings/fleet/appearance" && gatewayRequestContext(req)) { json(res, 403, { error: "appearance_settings_not_over_public_link" }); return true; }
    void this.prepare(req, res, url, next).catch(err => json(res, err instanceof SettingsConfirmationError ? err.status : 409,
      { error: err instanceof SettingsConfirmationError ? err.code : "settings_confirmation_unavailable" }));
    return true;
  }
  private async prepare(req: IncomingMessage, res: ServerResponse, url: URL, next: SettingsRequestHandler): Promise<void> {
    const method = req.method ?? "POST", raw = method === "DELETE" ? Buffer.from("{}") : await readBoundedWebBody(req, 512 * 1024);
    if (res.destroyed || req.aborted) return;
    let body: unknown; try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch { throw new SettingsConfirmationError(400, "invalid_json"); }
    const principal = this.options.principal(req);
    const localAdmin = principal?.localAdmin ? () => principal.current() && principal.localAdmin?.() === true : undefined;
    const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"]
      : body && typeof body === "object" && typeof (body as any).idempotency_key === "string" ? (body as any).idempotency_key : undefined;
    const requestFingerprint = settingsFingerprint([method, url.pathname, body]);
    if (principal?.current() && key) {
      const prior = this.store.findRequest(principal.id, key, requestFingerprint);
      if (prior) { json(res, 202, { ok: true, result: "pending_confirmation", pending_change: prior }); return; }
    }
    const baseline = await this.options.baseline();
    if (res.destroyed || req.aborted) return;
    const classifiedSnapshot = settingsFingerprint(this.options.snapshot());
    const effect = prepareSettingsEffect(method, url.pathname, body, baseline, requestSessionBinding(req), key);
    if (!effect.diff) {
      const execution = new SettingsExecution({ current: () => principal ? principal.current() : true,
        snapshot: () => this.options.snapshot(), expectedFingerprint: classifiedSnapshot });
      res.once?.("finish", () => execution.close()); res.once?.("close", () => execution.cancel());
      this.passed.add(req); cacheSettingsBody(req, raw, execution, requestSessionBinding(req), localAdmin); next(req, res, url); return;
    }
    if (!principal?.current()) throw new SettingsConfirmationError(401, "session_required");
    const binding = requestSessionBinding(req), snapshot = settingsFingerprint(this.options.snapshot());
    const payload = { method, url: url.pathname + url.search, key, body: Buffer.from(raw), binding, localAdmin };
    const result = this.store.propose({ session: principal.id, key: key ?? `operation:${requestFingerprint}`,
      requestFingerprint, fingerprint: effect.diff.fingerprint, section: effect.diff.section, requestedBy: principal.label,
      source: principal.source, summary: effect.diff.summary, affectedConnections: effect.diff.affectedConnections, authority: effect.diff.authority,
      bytes: raw.length, remainingMs: effect.proof?.remainingMs,
      current: () => principal.current(), snapshot: () => this.options.snapshot(),
      unchanged: async () => (await this.options.baseline()).fingerprint === baseline.fingerprint && settingsFingerprint(this.options.snapshot()) === snapshot,
      apply: async (_current, execution) => {
        // Recheck after replay/body/queue awaits in the real handler and actual job.
        execution.assert();
        const replay = createSettingsReplay(payload, execution);
        const response = await new Promise<{ status: number; body: any }>((yes, no) => {
          const collector = new Response(replay);
          collector.end = ((chunk: any) => {
            try { yes({ status: collector.statusCode, body: JSON.parse(String(chunk ?? "{}")) }); } catch { no(new Error("invalid_apply_response")); }
            return collector;
          }) as typeof collector.end;
          try { if (!next(replay, collector, new URL(payload.url, "http://localhost"))) no(new Error("unsupported_apply")); }
          catch (err) { no(err); }
        });
        if (response.status >= 400) throw new Error("apply_rejected");
        if (response.body.job_id && (!this.options.job || !await this.options.job(response.body.job_id))) throw new Error("apply_job_failed");
        await this.options.applied?.(url.pathname, response.body, execution);
        return response.body;
      }, discard: () => { payload.body.fill(0); effect.proof?.discard(); },
    });
    // #2170: a web-verified admin of exactly this change's effect owners confirms it by applying it. The store claims it
    // (state "applying") before the chat prompt is queued to run, so no card is posted; every check of a confirmation
    // still runs at execution, with this requester's authority asked again (self.current()).
    const self = result.reused ? null : this.options.selfConfirm?.(req, result.view.id) ?? null;
    if (self) {
      const decided = this.store.decide(result.view.id, "confirm", { ...self, via: "web" });
      void decided.then(view => self.done?.(view)).catch(() => {});
      json(res, 202, { ok: true, result: "pending_confirmation", pending_change: this.store.get(result.view.id, principal.id) ?? result.view });
      return;
    }
    json(res, 202, { ok: true, result: "pending_confirmation", pending_change: result.view });
  }
}
