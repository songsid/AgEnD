/** Owner-only inventory and owner requests; neither ability consumes a member hello slot. */
import { z } from "zod";
import { epoch, hash, person, plain, uuid } from "./validation.js";

export const HUB_AGENT_CATALOG_CAPABILITY = "agent-catalog-v1";
export const HUB_EXPOSURE_REQUEST_CAPABILITY = "exposure-request-v1";
export const HUB_SHARE_REQUEST_TTL = 10 * 60_000;
export const HUB_AGENT_CATALOG_MAX = 128;
const instance = plain(128).refine(s => !!s && s === s.trim() && !/[\u0000-\u001f\u007f]/.test(s));
const label = (max: number) => plain(max).refine(s => !/[\u0000-\u001f\u007f]/.test(s));
const reason = z.enum(["delivery-unavailable", "remote-windows", "ambiguous-agent"]);
export const exposurePointerSchema = z.strictObject({ id: uuid, revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), state: z.enum(["published", "withdrawn", "frozen"]) });
const rowBase = z.strictObject({ instance, displayName: label(256), description: label(512),
  avatar: z.strictObject({ emoji: label(64).nullable(), color: z.string().regex(/^#[a-f0-9]{6}$/i).nullable() }).nullable(),
  kind: z.enum(["agent", "classic-room"]), general: z.boolean(), exposure: exposurePointerSchema.nullable().optional() });
export const agentCatalogRowSchema = z.union([
  rowBase.extend({ shareable: z.literal(true) }),
  rowBase.extend({ shareable: z.literal(false), reason }),
]);
export const agentCatalogSchema = z.strictObject({ revision: hash, enabled: z.boolean(),
  // A member advertises requests only with its durable notice/Undo processor mounted.
  requests: z.boolean(), agents: z.array(agentCatalogRowSchema).max(HUB_AGENT_CATALOG_MAX) })
  .refine(v => new Set(v.agents.map(a => a.instance)).size === v.agents.length)
  .refine(v => v.enabled || v.agents.length === 0)
  .refine(v => v.agents.every(row => v.requests ? Object.hasOwn(row, "exposure") : !Object.hasOwn(row, "exposure")));
export const agentCatalogRefreshSchema = z.strictObject({});
export const exposureRequestSchema = z.strictObject({ by: person, byName: label(256).optional(), catalogRevision: hash,
  share: z.array(instance).max(64), stop: z.array(uuid).max(64), createdAt: epoch, expiresAt: epoch })
  .refine(v => v.share.length + v.stop.length > 0 && v.share.length + v.stop.length <= 64)
  .refine(v => new Set(v.share).size === v.share.length && new Set(v.stop).size === v.stop.length)
  .refine(v => v.expiresAt > v.createdAt && v.expiresAt - v.createdAt <= HUB_SHARE_REQUEST_TTL);
const refusal = z.enum(["not-owner", "switched-off", "stale-list", "not-shareable", "limit", "not-allowed", "unknown-agent", "expired", "unavailable"]);
export { refusal as exposureRequestRefusalSchema };
const resultRow = z.union([
  z.strictObject({ instance, ok: z.literal(true), before: exposurePointerSchema.nullable(), after: exposurePointerSchema }),
  z.strictObject({ instance, ok: z.literal(false), code: refusal }),
  z.strictObject({ exposureId: uuid, ok: z.literal(true), before: exposurePointerSchema, after: exposurePointerSchema }),
  z.strictObject({ exposureId: uuid, ok: z.literal(false), code: refusal }),
]);
export const exposureRequestResultSchema = z.strictObject({ noticeAt: epoch, undoUntil: epoch, results: z.array(resultRow).min(1).max(64) })
  .refine(v => v.undoUntil === v.noticeAt + 24 * 60 * 60_000)
  .refine(v => new Set(v.results.map(r => "instance" in r ? `agent:${r.instance}` : `exposure:${r.exposureId}`)).size === v.results.length);
export type HubAgentCatalogRow = z.infer<typeof agentCatalogRowSchema>;
export type HubAgentCatalog = z.infer<typeof agentCatalogSchema>;
export type HubExposureRequest = z.infer<typeof exposureRequestSchema>;
export type HubExposureRequestResult = z.infer<typeof exposureRequestResultSchema>;

export const exposureRequestAckSchema = z.strictObject({ ok: z.literal(true) });
export const exposureUndoSchema = z.strictObject({ originalRequestId: uuid, noticeAt: epoch,
  results: z.array(z.union([
    z.strictObject({ index: z.number().int().min(0).max(63), ok: z.literal(true), before: exposurePointerSchema, after: exposurePointerSchema }),
    z.strictObject({ index: z.number().int().min(0).max(63), ok: z.literal(false), code: refusal }),
  ])).min(1).max(64) }).refine(v => new Set(v.results.map(row => row.index)).size === v.results.length);
export const exposureUndoResultSchema = z.strictObject({ ok: z.literal(true) });
export type HubExposurePointer = z.infer<typeof exposurePointerSchema>;
export type HubExposureUndo = z.infer<typeof exposureUndoSchema>;
