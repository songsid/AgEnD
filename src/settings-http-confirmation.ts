import type { IncomingMessage, ServerResponse } from "node:http";
import { ServerResponse as Response } from "node:http";
import { readBoundedWebBody } from "./web-body.js";
import { requestSessionBinding } from "./connection-secrets.js";
import { cacheSettingsBody, createSettingsReplay, settingsRequestExecution } from "./settings-request-capability.js";
import { prepareSettingsEffect, isSettingsMutation, type SettingsEffectContext } from "./settings-effect.js";
import { SettingsConfirmationStore, SettingsConfirmationError, type SettingsPendingView } from "./settings-confirmation.js";
import { SettingsExecution, settingsFingerprint } from "./settings-transaction.js";
import { gatewayRequestContext } from "./web-request-context.js";
import {basename} from "node:path";
import {sanitizeInstanceName} from "./instance-names.js";

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
export interface SettingsSelfConfirmation { label: string; current(): boolean; done?(view: SettingsPendingView): void | Promise<void>;
  followStop?(name: string, begin: () => Promise<unknown>): Promise<void> }
export type SettingsRequestHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
/**
 * alpha.6 feedback #2c, the user's decision hmsg-468cc290 (option A): a web-only fleet's pending change confirmed on this
 * computer's own page with the owner's authenticator code — for a local admin session that is not the host operator (who has
 * "Apply now"). `state`: whether this request may (ready), could once an authenticator is set up (not_set_up), or not (null).
 * `confirm`: the code checked (one use per time step, the fleet-wide wrong-code limit), then a confirmation asked again at
 * execution — or why not.
 */
export interface SettingsTotpConfirmation {
  state(req: IncomingMessage, id: string): "ready" | "not_set_up" | "on_host" | "host_browser" | null;
  confirm(req: IncomingMessage, id: string, code: string, digest: string): (SettingsSelfConfirmation & { audit?: Record<string, unknown> }) | { error: "wrong" | "paused" | "unavailable" | "not_here" | "changed"; retryAfterMs?: number };
}
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
    /** alpha.6 #2c (hmsg-468cc290): the authenticator-code confirmation, on a web-only fleet's own page. */
    totp?: SettingsTotpConfirmation;
    /** A running Fleet may admit an ordinary New Agent request from its current local-dashboard admin.
     * Still uses the store's exact request claim, replay and execution fences; never grants this to agent requests. */
    directAgentCreation?: boolean;
  }) {}
  handle(req: IncomingMessage, res: ServerResponse, url: URL, next: SettingsRequestHandler): boolean {
    if (settingsRequestExecution(req) || this.passed.has(req)) return false;
    const path = url.pathname, method = req.method ?? "GET";
    const pending = path.match(/^\/api\/settings\/pending(?:\/([0-9a-f]{32}))?$/);
    // #2868: whether this browser could confirm a pending one itself now (#2170's own checks, asked at each read).
    const mine = (view: SettingsPendingView): SettingsPendingView => this.forPage(req, view);
    if (pending && (method === "GET" || method === "DELETE" && pending[1])) {
      const principal = this.options.principal(req);
      if (!principal?.current()) { json(res, 401, { error: "session_required" }); return true; }
      const result = pending[1] ? method === "DELETE" ? this.store.withdraw(pending[1], principal.id) : this.store.get(pending[1], principal.id) : this.store.list(principal.id);
      json(res, result === null ? 404 : 200, result === null ? { error: "not_found" } : Array.isArray(result) ? result.map(mine) : mine(result)); return true;
    }
    // #2868: "Apply now" — the requester's own pending change, confirmed by this browser exactly as its save would have
    // been (#2170): web-verified now, an admin of its effect owners, never over the public link, a General told. Anything
    // else: 403, and the change keeps waiting for General or the host.
    const self = path.match(/^\/api\/settings\/pending\/([0-9a-f]{32})\/confirm$/);
    if (self && method === "POST") {
      const principal = this.options.principal(req);
      if (!principal?.current()) { json(res, 401, { error: "session_required" }); return true; }
      const view = this.store.get(self[1], principal.id);
      if (!view) { json(res, 404, { error: "not_found" }); return true; }
      if (view.state !== "pending") { json(res, 409, { error: "confirmation_not_pending" }); return true; }
      const confirm = this.options.selfConfirm?.(req, view.id) ?? null;
      if (!confirm) { json(res, 403, { error: "self_confirm_unavailable" }); return true; }
      void this.store.decide(view.id, "confirm", { ...confirm, via: "web" }).then(done => confirm.done?.(done)).catch(() => {});
      json(res, 202, { ok: true, result: "pending_confirmation", pending_change: this.store.get(view.id, principal.id) ?? view }); return true;
    }
    // alpha.6 #2c (hmsg-468cc290): confirm a pending change with the authenticator's code, on this computer's own page.
    const totp = path.match(/^\/api\/settings\/pending\/([0-9a-f]{32})\/confirm-totp$/);
    if (totp && method === "POST") {
      const principal = this.options.principal(req);
      if (!principal?.current()) { json(res, 401, { error: "session_required" }); return true; }
      if (!this.options.totp || gatewayRequestContext(req)) { json(res, 403, { error: "totp_confirm_unavailable" }); return true; }
      void readBoundedWebBody(req, 1024).then(raw => {
        let code: unknown, digest: unknown;
        try { const b = JSON.parse(raw.toString("utf8") || "{}"); code = b?.code; digest = b?.digest; } catch { code = undefined; }
        if (typeof code !== "string" || code.length > 32 || typeof digest !== "string" || digest.length > 64) { json(res, 400, { error: "code_required" }); return; }
        if (!principal.current()) { json(res, 401, { error: "session_required" }); return; }
        const view = this.store.get(totp[1], principal.id);
        if (!view) { json(res, 404, { error: "not_found" }); return; }
        if (view.state !== "pending") { json(res, 409, { error: "confirmation_not_pending" }); return; }
        const result = this.options.totp!.confirm(req, view.id, code, digest);
        if ("error" in result) {
          if (result.error === "paused") { res.setHeader("Retry-After", String(Math.ceil((result.retryAfterMs ?? 60_000) / 1000))); json(res, 429, { error: "paused", retryAfterMs: result.retryAfterMs ?? null }); return; }
          if (result.error === "changed") { json(res, 409, { error: "confirmation_changed" }); return; }
          json(res, result.error === "wrong" ? 401 : result.error === "unavailable" ? 503 : 403, { error: result.error === "wrong" ? "wrong_code" : result.error === "unavailable" ? "unavailable" : "totp_confirm_unavailable" });
          return;
        }
        void this.store.decide(view.id, "confirm", { ...result, via: "web" }).then(done => result.done?.(done)).catch(() => {});
        json(res, 202, { ok: true, result: "pending_confirmation", pending_change: this.store.get(view.id, principal.id) ?? view });
      }, () => json(res, 400, { error: "code_required" }));
      return true;
    }
    if (!isSettingsMutation(method, path)) return false;
    // #1620: the web settings (sessions, the browser terminal, the public link itself) are never changed over the
    // temporary public link — the same rule as tokens and secrets: refused before anything is proposed.
    if ((path === "/api/settings/fleet/web" || path.startsWith("/api/settings/public-tunnel-token/")) && gatewayRequestContext(req)) { json(res, 403, { error: "web_settings_not_over_public_link" }); return true; }
    // #1629 r4.1 Q3 (b): the card's upload limits too (absent from the public link's manifest as well).
    if (path === "/api/settings/fleet/appearance" && gatewayRequestContext(req)) { json(res, 403, { error: "appearance_settings_not_over_public_link" }); return true; }
    // M-2255: Settings → Runtime's switches and limit (who may run agents where) — refused before anything is proposed.
    if (path === "/api/settings/fleet/runtimes" && gatewayRequestContext(req)) { json(res, 403, { error: "runtime_settings_not_over_public_link" }); return true; }
    if (path.startsWith("/api/settings/hub/") && gatewayRequestContext(req)) { json(res, 403, { error: "hub_settings_not_over_public_link" }); return true; }
    if (path.startsWith("/api/hub/member/") && gatewayRequestContext(req)) { json(res, 403, { error: "hub_member_not_over_public_link" }); return true; }
    if (path === "/api/hub/member/exposures" && gatewayRequestContext(req)) { json(res, 403, { error: "hub_member_not_over_public_link" }); return true; }
    if (path === "/api/settings/general-location" && gatewayRequestContext(req)) { json(res, 403, { error: "runtime_settings_not_over_public_link" }); return true; }
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
      ...(effect.diff.noSelfConfirm ? { noSelfConfirm: true as const } : {}), ...(effect.diff.hostLocalConfirm ? { hostLocalConfirm: true as const } : {}),
      ...(effect.diff.hostSessionOnly ? { hostSessionOnly: true as const } : {}),
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
        // S-35: keep the handler's own reason (e.g. "Local pane relay startup unconfirmed"); the store bounds and sanitizes it.
        if (response.status >= 400) {
          const why = response.body && typeof response.body === "object" && typeof (response.body as { error?: unknown }).error === "string"
            ? (response.body as { error: string }).error : "";
          throw new Error(why ? `apply_rejected: ${why}` : "apply_rejected");
        }
        if (response.body.job_id && (!this.options.job || !await this.options.job(response.body.job_id))) throw new Error("apply_job_failed");
        await this.options.applied?.(url.pathname, response.body, execution);
        return response.body;
      }, discard: () => { payload.body.fill(0); effect.proof?.discard(); },
    });
    // #2170: a web-verified admin of exactly this change's effect owners confirms it by applying it. The store claims it
    // (state "applying") before the chat prompt is queued to run, so no card is posted; every check of a confirmation
    // still runs at execution, with this requester's authority asked again (self.current()).
    // Creating on an already authorized runtime is an administrator's ordinary dashboard operation. General is
    // not a per-runtime prerequisite. Keep the server-owned claim/replay (including deduplication) and ask the
    // administrator capability again at execution. SetupHost, public links and agent proposals keep consent.
    const createBody=body&&typeof body==="object"&&!Array.isArray(body)?body as Record<string,unknown>:null;
    const ordinaryCreate = method === "POST" && url.pathname === "/ui/instances" && createBody
      && Object.keys(createBody).every(key => ["runtime", "native_adapter", "channel_id", "machineId",
        "directory", "topic_name", "backend", "model", "description", "systemPrompt", "sandbox", "tags", "branch",
        "detach", "worktree_path", "workflow", "backend_options", "credentialProfile"].includes(key))
      && (createBody.runtime==="windows"||sanitizeInstanceName(typeof createBody.topic_name==="string"?createBody.topic_name:basename(typeof createBody.directory==="string"?createBody.directory:""))!=="general");
    const direct = this.options.directAgentCreation === true && ordinaryCreate && principal.source === "web_session"
      && !gatewayRequestContext(req) && localAdmin?.() === true;
    const self = result.reused ? null : direct
      ? { label: principal.label, current: () => localAdmin?.() === true }
      : this.options.selfConfirm?.(req, result.view.id) ?? null;
    if (self) {
      const decided = this.store.decide(result.view.id, "confirm", { ...self, via: "web" });
      void decided.then(view => self.done?.(view)).catch(() => {});
      json(res, 202, { ok: true, result: "pending_confirmation", pending_change: this.store.get(result.view.id, principal.id) ?? result.view });
      return;
    }
    // B2b: the first answer already says how this page may confirm it (Apply now, the code, or where), not only the next read.
    json(res, 202, { ok: true, result: "pending_confirmation", pending_change: this.forPage(req, result.view, false) });
  }
  /** #2868 / B2b: how THIS request's page may confirm a pending change — Apply now, the authenticator code (with the digest
   *  it is bound to), or where to go — asked at each read. */
  private forPage(req: IncomingMessage, view: SettingsPendingView, self?: false): SettingsPendingView {
    if (view.state !== "pending") return view;
    // (`self` false: the caller has just asked — it is not — so it is not asked twice.)
    if (self !== false && this.options.selfConfirm?.(req, view.id)) return { ...view, can_self_confirm: true };
    const totp = this.options.totp?.state(req, view.id) ?? null;
    return totp ? { ...view, totp, ...(totp === "ready" ? { confirm_digest: this.store.confirmDigest(view.id) ?? undefined } : {}) } : view;
  }
}
