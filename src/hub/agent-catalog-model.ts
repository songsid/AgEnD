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
const rowBase = z.strictObject({ instance, displayName: label(256), description: label(512),
  avatar: z.strictObject({ emoji: label(64).nullable(), color: z.string().regex(/^#[a-f0-9]{6}$/i).nullable() }).nullable(),
  kind: z.enum(["agent", "classic-room"]), general: z.boolean() });
export const agentCatalogRowSchema = z.union([
  rowBase.extend({ shareable: z.literal(true) }),
  rowBase.extend({ shareable: z.literal(false), reason }),
]);
export const agentCatalogSchema = z.strictObject({ revision: hash, enabled: z.boolean(),
  // Foundation deliberately cannot advertise remote mutation before notice/Undo is mounted.
  requests: z.literal(false), agents: z.array(agentCatalogRowSchema).max(HUB_AGENT_CATALOG_MAX) })
  .refine(v => new Set(v.agents.map(a => a.instance)).size === v.agents.length)
  .refine(v => v.enabled || v.agents.length === 0);
export const agentCatalogRefreshSchema = z.strictObject({});
export const exposureRequestSchema = z.strictObject({ by: person, catalogRevision: hash,
  share: z.array(instance).max(64), stop: z.array(uuid).max(64), createdAt: epoch, expiresAt: epoch })
  .refine(v => v.share.length + v.stop.length > 0 && v.share.length + v.stop.length <= 64)
  .refine(v => new Set(v.share).size === v.share.length && new Set(v.stop).size === v.stop.length)
  .refine(v => v.expiresAt > v.createdAt && v.expiresAt - v.createdAt <= HUB_SHARE_REQUEST_TTL);
const refusal = z.enum(["not-owner", "switched-off", "stale-list", "not-shareable", "limit", "not-allowed", "unknown-agent", "expired", "unavailable"]);
const resultRow = z.union([
  z.strictObject({ instance, ok: z.literal(true) }),
  z.strictObject({ instance, ok: z.literal(false), code: refusal }),
  z.strictObject({ exposureId: uuid, ok: z.literal(true) }),
  z.strictObject({ exposureId: uuid, ok: z.literal(false), code: refusal }),
]);
export const exposureRequestResultSchema = z.strictObject({ results: z.array(resultRow).min(1).max(64) })
  .refine(v => new Set(v.results.map(r => "instance" in r ? `agent:${r.instance}` : `exposure:${r.exposureId}`)).size === v.results.length);
export type HubAgentCatalogRow = z.infer<typeof agentCatalogRowSchema>;
export type HubAgentCatalog = z.infer<typeof agentCatalogSchema>;
export type HubExposureRequest = z.infer<typeof exposureRequestSchema>;
export type HubExposureRequestResult = z.infer<typeof exposureRequestResultSchema>;
