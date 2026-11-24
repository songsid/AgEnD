/**
 * M-3533 R2b: a shared agent's pictures in room offices (hub-office-visit.md "Decided while building": each place shows what the
 * Fleet shows in the same kind of place). The disc is what the owner's sidebar shows for the agent (a profile picture, its theme
 * avatar when the owner shows agents' themes, its bot's avatar, a Discord custom emoji); the card is its identity-card portrait.
 *
 * The member reports which pictures each published exposure has (`agent.pictures`); the Hub answers with the content hashes it
 * does not hold yet, and the member sends those in chunks (`agent.picture`). The Hub keeps one copy per hash, only while some
 * shared agent's report names it. Nothing else of the Fleet crosses: no file names or paths, no other agents, no settings.
 * Over the caps the member sends the agent's entry without that picture and says so (`tooLarge`): only its owner is told.
 */
import { z } from "zod";
import { hash, uuid } from "./validation.js";

export const HUB_AGENT_PICTURES_CAPABILITY = "agent-pictures-v1";
/** The disc, whatever its source: a PNG is reduced to 64×64; a JPEG, webp or GIF goes as it is, up to this. */
export const HUB_PICTURE_DISC_MAX = 64 * 1024;
/** Everything one agent's pictures may take on the Hub (the design's 512 KB): the disc first, the portrait in what is left. */
export const HUB_PICTURE_AGENT_MAX = 512 * 1024;
/** Raw bytes per chunk: base64 (4/3) plus the frame envelope stays under HUB_LIMITS.frame (256 KiB), as attachments. */
export const HUB_PICTURE_CHUNK = 180 * 1024;
export const HUB_PICTURE_AGENTS_MAX = 128;
/** The sides a PNG is reduced to (the member's web-png.ts resampler). */
export const HUB_PICTURE_DISC_SIDE = 64;
export const HUB_PICTURE_PORTRAIT_SIDE = 256;

export const pictureMimeSchema = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export type HubPictureMime = z.infer<typeof pictureMimeSchema>;
export const pictureSlotSchema = z.enum(["disc", "portrait"]);
export type HubPictureSlot = z.infer<typeof pictureSlotSchema>;
export const pictureRefSchema = z.strictObject({ sha256: hash, mime: pictureMimeSchema, size: z.number().int().min(1).max(HUB_PICTURE_AGENT_MAX) });
export type HubPictureRef = z.infer<typeof pictureRefSchema>;

export const agentPicturesRowSchema = z.strictObject({
  exposureId: uuid, disc: pictureRefSchema.nullable(), portrait: pictureRefSchema.nullable(),
  /** A picture the agent has, left out because it is over its cap; its owner's My agents row says so. */
  tooLarge: z.array(pictureSlotSchema).min(1).max(2).optional(),
}).refine(r => !r.disc || r.disc.size <= HUB_PICTURE_DISC_MAX, "Disc too large")
  .refine(r => (r.disc?.size ?? 0) + (r.portrait?.size ?? 0) <= HUB_PICTURE_AGENT_MAX, "Pictures too large")
  .refine(r => !r.tooLarge || (new Set(r.tooLarge).size === r.tooLarge.length && r.tooLarge.every(slot => r[slot] === null)), "Invalid tooLarge");
export type HubAgentPicturesRow = z.infer<typeof agentPicturesRowSchema>;
export const agentPicturesSchema = z.strictObject({ revision: hash, agents: z.array(agentPicturesRowSchema).max(HUB_PICTURE_AGENTS_MAX) })
  .refine(v => new Set(v.agents.map(a => a.exposureId)).size === v.agents.length, "Duplicate agent");
export type HubAgentPictures = z.infer<typeof agentPicturesSchema>;
/** The Hub's answer to a report: the hashes it wants (each named by the report, none it holds). */
export const agentPicturesResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), need: z.array(hash).max(HUB_PICTURE_AGENTS_MAX * 2) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(["stale", "revoked", "unavailable"]) }),
]);
export type HubAgentPicturesResult = z.infer<typeof agentPicturesResultSchema>;

const MAX_CHUNKS = Math.ceil(HUB_PICTURE_AGENT_MAX / HUB_PICTURE_CHUNK);
export const agentPictureChunkSchema = z.strictObject({
  sha256: hash, mime: pictureMimeSchema, size: z.number().int().min(1).max(HUB_PICTURE_AGENT_MAX),
  index: z.number().int().min(0).max(MAX_CHUNKS - 1), count: z.number().int().min(1).max(MAX_CHUNKS),
  data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(Math.ceil(HUB_PICTURE_CHUNK / 3) * 4),
}).refine(c => c.count === Math.ceil(c.size / HUB_PICTURE_CHUNK) && c.index < c.count, "Invalid chunk");
export type HubAgentPictureChunk = z.infer<typeof agentPictureChunkSchema>;
export const agentPictureResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), stored: z.boolean() }),
  z.strictObject({ ok: z.literal(false), code: z.enum(["invalid", "not-wanted", "stale", "revoked", "unavailable"]) }),
]);
export type HubAgentPictureResult = z.infer<typeof agentPictureResultSchema>;

/** The picture's type from its first bytes, or null: the Hub stores and serves only what these say it is. */
export function sniffPicture(bytes: Uint8Array): HubPictureMime | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  return null;
}
