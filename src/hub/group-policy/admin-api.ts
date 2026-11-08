/**
 * #3298 S-89: the HTTP presentation of Administration → Group permissions and of the signed-in welcome, over S-88's control
 * (admin-dto.ts, contract on M-2624). This layer only checks the closed request shapes, passes the SESSION's own context (the
 * control itself calls `requireAdmin`; the welcome calls `requirePerson`) and maps answers to statuses. It decides nothing.
 * Mounted only when both the control and the welcome are composed (until then: 404, and the session carries no mark).
 */
import { applyRequest, previewRequest, resolveRequest, resumeRequest, type GroupAdminContext, type GroupWelcomeContext, type GroupWelcomeResponse, type HubGroupAdminControl } from "./admin-dto.js";
import type { HubActor, PersonKey } from "../types.js";

export const GROUP_POLICY_FEATURE = "group-policy-v1";
export interface GroupHttpDeps { readonly control: HubGroupAdminControl; readonly welcome: (ctx: GroupWelcomeContext) => Promise<GroupWelcomeResponse> }
/** What this layer needs of the request: the session's own fresh checks, and the compose helpers. */
export interface GroupHttpRequest {
  readonly path: string; readonly method: string;
  readonly ctx: { readonly requestId: string; current(): boolean; requireAdmin(): Promise<HubActor>; requirePerson(): Promise<PersonKey> };
  signedIn(): unknown; csrf(): unknown; body(): Promise<Record<string, unknown>>;
  send(status: number, body: unknown): void;
}
const STATUS: Record<string, number> = { conflict: 409, "stale-preview": 409, expired: 409, "group-mismatch": 409, "repair-required": 409, unsupported: 422, invalid: 400, denied: 403, unknown: 503 };

/** Handles the group routes; false when the path isn't one of them. */
export async function handleGroupHttp(deps: GroupHttpDeps | undefined, q: GroupHttpRequest): Promise<boolean> {
  const { path, method } = q;
  const admin = path === "/hub/v1/admin/group-policy" || path.startsWith("/hub/v1/admin/group-policy/");
  if (!admin && path !== "/hub/v1/me/welcome") return false;
  if (!deps) { q.send(404, { code: "not-found" }); return true; }
  // Bound to the session's own context: a value passed in never stands for who is asking.
  const adminCtx: GroupAdminContext = { requestId: q.ctx.requestId, current: () => q.ctx.current(), requireAdmin: () => q.ctx.requireAdmin() };
  const answer = (a: { ok: boolean; code?: string }) => q.send(a.ok ? 200 : STATUS[a.code ?? "unknown"] ?? 409, a);
  const parsed = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, raw: unknown): T | null => { const r = schema.safeParse(raw); return r.success ? r.data : null; };
  const bad = () => q.send(400, { code: "invalid" });
  if (path === "/hub/v1/me/welcome") {
    if (method !== "GET") { q.send(405, { code: "method" }); return true; }
    q.signedIn();
    q.send(200, await deps.welcome({ requestId: q.ctx.requestId, current: () => q.ctx.current(), requirePerson: () => q.ctx.requirePerson() }));
    return true;
  }
  if (path === "/hub/v1/admin/group-policy") {
    if (method === "GET") { q.signedIn(); answer(await deps.control.read(adminCtx)); return true; }
    if (method === "PUT") { q.csrf(); const input = parsed(applyRequest, await q.body()); if (!input) return bad(), true; answer(await deps.control.apply(input, adminCtx)); return true; }
    q.send(405, { code: "method" }); return true;
  }
  if (method !== "POST") { q.send(405, { code: "method" }); return true; }
  q.csrf();
  const raw = await q.body();
  if (path === "/hub/v1/admin/group-policy/resolve") {
    const input = parsed(resolveRequest, raw); if (!input) return bad(), true;
    // A refusal is input feedback (200 with its reason), never authority.
    const r = await deps.control.resolve(input, adminCtx); q.send(200, r.ok ? r : { reason: r.reason }); return true;
  }
  if (path === "/hub/v1/admin/group-policy/preview") { const input = parsed(previewRequest, raw); if (!input) return bad(), true; answer(await deps.control.preview(input, adminCtx)); return true; }
  if (path === "/hub/v1/admin/group-policy/resources/resume") { const input = parsed(resumeRequest, raw); if (!input) return bad(), true; answer(await deps.control.resume(input, adminCtx)); return true; }
  q.send(404, { code: "not-found" }); return true;
}
