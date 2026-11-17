import { z } from "zod";
import { epoch, uuid } from "./validation.js";

/** Hub-only welcome offer. Never append it to a member's 16/17-name hello. */
export const HUB_ROOM_CONTEXT_CAPABILITY = "room-context-v1";
export const roomContextStateSchema = z.strictObject({ generation: uuid, after: epoch, through: epoch.min(1) })
  .refine(v => v.after < v.through, "Invalid context interval");
export const roomContextRequestSchema = z.strictObject({ exposureId: uuid, generation: uuid,brief:z.literal(true).optional() });
export const roomContextInputSchema = roomContextRequestSchema.omit({brief:true}).extend({ messageId: uuid });
const outcome = { ok: z.boolean(), code: z.enum(["stale", "denied", "not-found"]).optional() };
export const roomContextResultSchema = roomContextRequestSchema.extend(outcome);
export const roomContextInputResultSchema = roomContextInputSchema.extend(outcome);
export type HubRoomContextState = z.infer<typeof roomContextStateSchema>;
export type HubRoomContextRequest = z.infer<typeof roomContextRequestSchema>;
export type HubRoomContextInput = z.infer<typeof roomContextInputSchema>;
export type HubRoomContextResult = z.infer<typeof roomContextResultSchema>;
export type HubRoomContextInputResult = z.infer<typeof roomContextInputResultSchema>;
