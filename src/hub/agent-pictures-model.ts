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
/**
 * M-3533 R2c: the agent's own character from its owner's skin pack, in the same report (`character` on a row). Offered by
 * the Hub in its welcome; a member sends `character` (or "character" in `tooLarge`) only to a Hub that offered it, so an
 * older Hub's strict row never sees the field.
 */
export const HUB_AGENT_CHARACTERS_CAPABILITY = "agent-characters-v1";
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
/** M-3533 R2c: what an owner's My agents row may say was left out — a picture, or the agent's whole character. */
export const pictureOmittedSchema = z.enum(["disc", "portrait", "character"]);
export type HubPictureOmitted = z.infer<typeof pictureOmittedSchema>;
export const pictureRefSchema = z.strictObject({ sha256: hash, mime: pictureMimeSchema, size: z.number().int().min(1).max(HUB_PICTURE_AGENT_MAX) });
export type HubPictureRef = z.infer<typeof pictureRefSchema>;

/**
 * M-3533 R2c: the poses a room office can show (Lumen's decision on R2c 2). Working, idle and paused are the member list's
 * states (offline and later draw as paused, as the Fleet draws stopped); idle agents walk; `stand` is the card's still
 * avatar. Never `needs` (a room has no such state), eat, dragged, pat (no Pat or Feed in rooms) or prop.
 */
export const ROOM_CHARACTER_POSES = ["working", "idle", "paused", "stand", "walk", "walkDown", "walkUp", "walkSide", "walkLeft"] as const;
export type RoomCharacterPose = typeof ROOM_CHARACTER_POSES[number];
/** Every one of these is in a sent set: a pose the pack lacks is filled inside the set (stand, else idle). The walks may be missing (the Fleet's own walk → idle). */
export const ROOM_CHARACTER_REQUIRED = ["working", "idle", "paused", "stand"] as const;
/** A room strip's frames, side by side in its one PNG (the pack's sheet limit, fleet-office-pack.js STRIP_LIMITS.sheetFrames). */
export const ROOM_CHARACTER_FRAMES_MAX = 32;
/**
 * One pose of the agent's set, cut from its pack into its own PNG (`frames` frames of w × h side by side): nothing else of the
 * pack crosses. The playback and placement fields are the checked pack's (fleet-office-pack.js checkStrip).
 */
export const characterStripSchema = z.strictObject({
  sha256: hash, mime: z.literal("image/png"), size: z.number().int().min(1).max(HUB_PICTURE_AGENT_MAX),
  frames: z.number().int().min(1).max(ROOM_CHARACTER_FRAMES_MAX), w: z.number().int().min(1).max(512), h: z.number().int().min(1).max(512),
  fps: z.number().min(0).max(30), durations: z.array(z.number().int().min(33).max(60_000)).max(ROOM_CHARACTER_FRAMES_MAX).optional(),
  once: z.literal(true).optional(), loopFrom: z.number().int().min(1).max(ROOM_CHARACTER_FRAMES_MAX - 1).optional(),
  ax: z.number().min(0).max(512), ay: z.number().min(0).max(512), dw: z.number().min(1).max(5120), dh: z.number().min(1).max(2880),
}).refine(s => s.ax <= s.w && s.ay <= s.h, "Anchor outside the frame")
  .refine(s => !s.durations || s.durations.length === s.frames, "One duration per frame")
  .refine(s => s.loopFrom === undefined || (s.loopFrom < s.frames && !s.once), "Invalid loopFrom");
export type HubCharacterStrip = z.infer<typeof characterStripSchema>;
export const characterSetSchema = z.partialRecord(z.enum(ROOM_CHARACTER_POSES), characterStripSchema)
  .refine(set => ROOM_CHARACTER_REQUIRED.every(p => !!set[p]), "A set needs working, idle, paused and stand")
  // A hash fixes its bytes: two poses naming one picture declare it alike (else the cap could be counted short).
  .refine(set => { const seen = new Map<string, number>(); return Object.values(set).every(st => !st || (seen.get(st.sha256) ?? st.size) === (seen.set(st.sha256, st.size), st.size)); },
    "One picture, two sizes");
export type HubCharacterSet = z.infer<typeof characterSetSchema>;
/** The bytes a set holds on the Hub: each picture once (a filled pose names its source's hash). */
export const characterSetBytes = (set: HubCharacterSet | null | undefined): number =>
  set ? [...new Map(Object.values(set).filter(Boolean).map(s => [s!.sha256, s!.size])).values()].reduce((a, b) => a + b, 0) : 0;

export const agentPicturesRowSchema = z.strictObject({
  exposureId: uuid, disc: pictureRefSchema.nullable(), portrait: pictureRefSchema.nullable(),
  /** M-3533 R2c: the agent's own character (agent-characters-v1 only), all of it or none. */
  character: characterSetSchema.nullable().optional(),
  /** A picture the agent has, left out because it is over its cap; its owner's My agents row says so. */
  tooLarge: z.array(pictureOmittedSchema).min(1).max(3).optional(),
}).refine(r => !r.disc || r.disc.size <= HUB_PICTURE_DISC_MAX, "Disc too large")
  .refine(r => (r.disc?.size ?? 0) + (r.portrait?.size ?? 0) + characterSetBytes(r.character) <= HUB_PICTURE_AGENT_MAX, "Pictures too large")
  .refine(r => !r.tooLarge || (new Set(r.tooLarge).size === r.tooLarge.length && r.tooLarge.every(slot => !r[slot])), "Invalid tooLarge");
export type HubAgentPicturesRow = z.infer<typeof agentPicturesRowSchema>;
export const agentPicturesSchema = z.strictObject({ revision: hash, agents: z.array(agentPicturesRowSchema).max(HUB_PICTURE_AGENTS_MAX) })
  .refine(v => new Set(v.agents.map(a => a.exposureId)).size === v.agents.length, "Duplicate agent");
export type HubAgentPictures = z.infer<typeof agentPicturesSchema>;
/** The Hub's answer to a report: the hashes it wants (each named by the report, none it holds). */
export const agentPicturesResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), need: z.array(hash).max(HUB_PICTURE_AGENTS_MAX * (2 + ROOM_CHARACTER_POSES.length)) }),
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
