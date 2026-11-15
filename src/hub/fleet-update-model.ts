/** Fixed remote-update data. No command, URL, executable path or install authority is accepted here. */
import { z } from "zod";
import { epoch, uuid } from "./validation.js";
import { recommendedVersionSchema } from "./recommendation-model.js";
export const fleetUpdateReasonSchema = z.enum(["busy-24h", "offline-7d", "owner-disabled", "not-service", "already-current", "request-open",
  "unsupported", "revoked", "not-found", "version-not-found", "npm-unavailable", "no-permission", "update-running", "launch-failed", "rollback-failed", "interrupted"]);
export type FleetUpdateReason = z.infer<typeof fleetUpdateReasonSchema>;
export const fleetUpdateStateSchema = z.enum(["waiting", "updating", "done", "rolled-back", "expired", "cancelled", "refused", "failed"]);
export const fleetUpdateRequestSchema = z.strictObject({ id: uuid, version: recommendedVersionSchema, requestedAt: epoch, expiresAt: epoch,
  requestedBy: z.strictObject({ name: z.string().min(1).max(256) }) });
export const fleetUpdateCancelSchema = z.strictObject({ id: uuid, version: recommendedVersionSchema });
export const fleetUpdateStatusSchema = z.strictObject({ id: uuid, version: recommendedVersionSchema, sequence: epoch.min(1), state: fleetUpdateStateSchema,
  waitingSince: epoch.optional(), startedAt: epoch.optional(), expiresAt: epoch.optional(), reasonCode: fleetUpdateReasonSchema.optional(), currentVersion: recommendedVersionSchema.optional() });
export const fleetUpdateStatusAckSchema = z.strictObject({ id: uuid, version: recommendedVersionSchema, sequence: epoch.min(1) });
export type FleetUpdateRequest = z.infer<typeof fleetUpdateRequestSchema>;
export type FleetUpdateStatus = z.infer<typeof fleetUpdateStatusSchema>;
export type FleetUpdateStatusAck = z.infer<typeof fleetUpdateStatusAckSchema>;
export interface HubFleetUpdate extends FleetUpdateRequest {
  fleetId: string; updatedAt: number; waitingSince: number | null; startedAt: number | null;
  state: "queued" | FleetUpdateStatus["state"]; cancelRequested: boolean; reasonCode?: FleetUpdateReason; currentVersion?: string;
}
export const openFleetUpdate = (state: HubFleetUpdate["state"]): boolean => state === "queued" || state === "waiting" || state === "updating";
