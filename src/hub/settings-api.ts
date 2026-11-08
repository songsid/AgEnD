/**
 * M-2682: Hub Administration → This Hub. The Hub administrator sees what this Hub is (read-only: name, Hub ID, the member
 * key fingerprint members pin, the issuer key id, the AgEnD version) and renames it — or clears its name — through the
 * host's one writer for sealed settings (settings-commit.ts). Two steps: prepare answers a redacted summary and an opaque
 * reference bound to this session and person; commit takes only that reference. Nothing else of hub.* is changed here.
 *
 *   GET  /hub/v1/admin/hub                → { name, hubId, memberSpkiSha256, issuerKeyId, version, rename }
 *   POST /hub/v1/admin/hub/name/prepare   { name: string | null } → { ref, summary, expiresAt }
 *   POST /hub/v1/admin/hub/name/commit    { ref } → { ok, summary }   (the Hub then reloads with its new name)
 */
import { HubSettingsError, type HubSettingsWriter } from "./settings-commit.js";
import type { HubActor } from "./types.js";

export interface HubSettingsHttpDeps {
  info: Readonly<{ hubId: string; memberSpkiSha256: string; issuerKeyId: string; version: string | null }>;
  /** The name this Hub was mounted with ("" = none). */
  name: string;
  writer?: HubSettingsWriter;
}
export interface HubSettingsHttpRequest {
  readonly path: string; readonly method: string;
  readonly ctx: { readonly requestId: string; current(): boolean; requireAdmin(): Promise<HubActor> };
  signedIn(): unknown; csrf(): unknown; body(): Promise<Record<string, unknown>>;
  send(status: number, body: unknown): void;
  /** Synchronous audit append (its own transaction); throws when it can't be recorded. */
  audit(event: { requestId: string; actor: Extract<HubActor, { kind: "directory" }>; action: string; result: "held" | "completed"; reasonCode?: string }): void;
}
const STATUS: Record<string, number> = { invalid: 400, unchanged: 409, stale: 409, expired: 409, busy: 409, denied: 403, unavailable: 503, recovery: 503 };

/** Handles the This Hub routes; false when the path isn't one of them. */
export async function handleHubSettingsHttp(deps: HubSettingsHttpDeps | undefined, q: HubSettingsHttpRequest): Promise<boolean> {
  const { path, method } = q;
  if (path !== "/hub/v1/admin/hub" && path !== "/hub/v1/admin/hub/name/prepare" && path !== "/hub/v1/admin/hub/name/commit") return false;
  if (!deps) { q.send(404, { code: "not-found" }); return true; }
  const admin = async (): Promise<Extract<HubActor, { kind: "directory" }>> => {
    const actor = await q.ctx.requireAdmin();
    if (actor.kind !== "directory" || !q.ctx.current()) throw new HubSettingsError("denied");
    return actor;
  };
  const refused = (e: unknown) => {
    if (e instanceof HubSettingsError) { q.send(STATUS[e.code] ?? 409, { ok: false, code: e.code }); return; }
    throw e;
  };
  if (path === "/hub/v1/admin/hub") {
    if (method !== "GET") { q.send(405, { code: "method" }); return true; }
    q.signedIn(); await admin();
    q.send(200, { ok: true, name: deps.name || null, ...deps.info, rename: !!deps.writer });
    return true;
  }
  if (method !== "POST") { q.send(405, { code: "method" }); return true; }
  q.signedIn(); q.csrf();
  try {
    const body = await q.body();
    const actor = await admin();
    if (!deps.writer) throw new HubSettingsError("unavailable");
    const who = { person: actor.person, sessionId: actor.sessionId, requestId: q.ctx.requestId };
    if (path.endsWith("/prepare")) {
      if (!Object.hasOwn(body, "name")) throw new HubSettingsError("invalid");
      q.send(200, { ok: true, ...deps.writer.prepare({ kind: "rename", name: body.name as string | null }, who) });
      return true;
    }
    if (typeof body.ref !== "string") throw new HubSettingsError("invalid");
    // No await from here: the audit, the commit and its record run as one synchronous step.
    q.audit({ requestId: q.ctx.requestId, actor, action: "hub.settings.rename", result: "held" });
    const done = deps.writer.commit(body.ref, who, () => q.ctx.current());
    // The rename is committed and its receipt kept; a failure to add this second record doesn't undo it.
    try { q.audit({ requestId: q.ctx.requestId, actor, action: "hub.settings.rename", result: "completed", reasonCode: done.receiptId }); } catch { /* the held record and the receipt remain */ }
    q.send(200, { ok: true, summary: done.summary });
  } catch (e) { refused(e); }
  return true;
}
