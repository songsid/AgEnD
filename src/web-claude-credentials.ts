/** Secret-bearing routes are deliberately separate from the ordinary public-admin Accounts routes. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { evaluateWebRequest } from "./web-auth.js";
import type { WebApiContext } from "./web-api.js";
import { classifyWebPeer } from "./authority/web-authority.js";
import { gatewayRequestContext } from "./web-request-context.js";
import { readBoundedWebBody } from "./web-body.js";
import { ClaudeCredentialError, type ClaudeCredentialKind, type ClaudeCredentialMetadata, type CredentialActor } from "./claude-credential-vault.js";
export interface ClaudeCredentialApi {
  claudeCredentialMetadata?(profile: string | null): ClaudeCredentialMetadata | null;
  writeClaudeCredential?(profile: string | null, revision: number, change: { kind: ClaudeCredentialKind; value: string } | null, actor: CredentialActor): ClaudeCredentialMetadata;
  auditClaudeCredential?(actor: CredentialActor | null, action: string, outcome: string): void;
}
const profileSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).nullable();
const base = { profile: profileSchema, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) };
const putSchema = z.strictObject({ ...base, kind: z.enum(["api-key", "setup-token"]), value: z.string().min(16).max(16_384) });
const removeSchema = z.strictObject({ ...base, confirm: z.literal(true) });
const status = { invalid: 400, conflict: 409, unavailable: 503, "in-use": 409, "profile-unknown": 404 };
const json = (res: ServerResponse, code: number, value: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
export function handleClaudeCredentials(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext & ClaudeCredentialApi): boolean {
  if (url.pathname !== "/ui/claude-credentials") return false;
  res.setHeader("Cache-Control", "private, no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
  const method = req.method ?? "GET", action = method === "PUT" ? "set-or-replace" : method === "DELETE" ? "remove" : "read";
  const audit = (actor: CredentialActor | null, outcome: string) => { try { ctx.auditClaudeCredential?.(actor, action, outcome); } catch { /* refusal stays refused even if storage is unavailable */ } };
  const who = (): { handle: string; actor: CredentialActor } | null => {
    if (gatewayRequestContext(req) || classifyWebPeer(req) !== "loopback") return null;
    const v = evaluateWebRequest(req, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
    if (v.kind !== "allow" || v.via !== "session" || v.session.tier !== "admin") return null;
    // contactActor uses the existing current web-authority + adapter-admin proof (host operator included).
    const person = ctx.contactActor?.(req, url); if (!person) return null;
    return { handle: v.session.handle, actor: { adapterId: person.adapterId, userId: person.userId } };
  };
  const first = who();
  if (!first) { if (method !== "GET") audit(null, "local-verified-admin-required"); json(res, 403, { error: "credential_local_verified_required" }); return true; }
  if (!ctx.claudeCredentialMetadata || !ctx.writeClaudeCredential) { json(res, 503, { error: "credential_unavailable" }); return true; }
  if (method === "GET") {
    try {
      if ([...url.searchParams.keys()].some(k => k !== "profile") || url.searchParams.getAll("profile").length > 1) throw new ClaudeCredentialError("invalid");
      const parsed = profileSchema.safeParse(url.searchParams.get("profile")); if (!parsed.success) throw new ClaudeCredentialError("invalid");
      json(res, 200, { credential: ctx.claudeCredentialMetadata(parsed.data) });
    } catch (e) { const code = e instanceof ClaudeCredentialError ? e.code : "unavailable"; json(res, status[code], { error: "credential_" + code }); }
    return true;
  }
  if (method !== "PUT" && method !== "DELETE") { json(res, 405, { error: "credential_method" }); return true; }
  const length = req.headers["content-length"];
  if (typeof length === "string" && (!/^\d+$/.test(length) || Number(length) > 18_000)) {
    audit(first.actor, "body-bound"); req.resume(); json(res, 413, { error: "credential_body_bound" }); return true;
  }
  void (async () => {
    let bytes: Buffer;
    try { bytes = await readBoundedWebBody(req, 18_000); }
    catch { audit(first.actor, "body-bound"); json(res, 413, { error: "credential_body_bound" }); return; }
    try {
      const now = who();
      if (!now || now.handle !== first.handle || JSON.stringify(now.actor) !== JSON.stringify(first.actor)) { audit(first.actor, "session-changed"); json(res, 403, { error: "credential_session_changed" }); return; }
      let body: unknown; try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new ClaudeCredentialError("invalid"); }
      const parsed = (method === "PUT" ? putSchema : removeSchema).safeParse(body); if (!parsed.success) throw new ClaudeCredentialError("invalid");
      const p = parsed.data;
      const result = ctx.writeClaudeCredential!(p.profile, p.revision, "kind" in p ? { kind: p.kind, value: p.value } : null, now.actor);
      json(res, 200, { credential: result });
    } catch (e) {
      const code = e instanceof ClaudeCredentialError ? e.code : "unavailable"; audit(first.actor, code);
      json(res, status[code], { error: "credential_" + code });
    } finally { bytes.fill(0); }
  })();
  return true;
}
