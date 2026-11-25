/**
 * M-3533 R2c: an agent's own character for the Hub's room offices (hub-office-visit.md, Lumen's R2c decisions 1–3).
 * - Its own: the set the owner gave it by name (`byInstance`) in the first of the owner's offices, in their own order, that
 *   holds it and whose pack names it; else in the page's own "All" office's pack. Never a pack's `default`.
 * - Only the poses a room office shows (ROOM_CHARACTER_POSES); a missing one is filled inside the set (stand, else idle) so
 *   the agent is drawn wholly with its set; the walks may be missing (the Fleet's own walk → idle).
 * - Each pose cut into its own PNG (hub-picture-reduce.ts cropCharacter): nothing else on a shared sheet crosses.
 */
import { own, stripCell, type CheckedPack, type PackStrip } from "./ui/fleet-office-pack.js";
import { ROOM_CHARACTER_FRAMES_MAX, ROOM_CHARACTER_POSES, ROOM_CHARACTER_REQUIRED, type HubCharacterStrip, type RoomCharacterPose } from "./hub/agent-pictures-model.js";
import type { CharacterCut } from "./hub-picture-reduce.js";

/** A pose's strip as the Hub keeps it, but its picture (hash, type and size come once it is cut). */
export type CharacterMeta = Omit<HubCharacterStrip, "sha256" | "mime" | "size">;
/** A set ready to cut: each pose's playback fields and its cells, and the pack pictures (`src`) they read. */
export interface CharacterPlan { poses: Partial<Record<RoomCharacterPose, { meta: CharacterMeta; cut: CharacterCut }>>; sources: string[] }

/** The pose a missing one is drawn with, inside the set (Lumen R2c 2): stand, else idle; idle, else stand. */
const FILL: Record<(typeof ROOM_CHARACTER_REQUIRED)[number], readonly string[]> = {
  working: ["stand", "idle"], paused: ["stand", "idle"], idle: ["stand"], stand: ["idle"],
};

/**
 * The room cuts of a pack's character set, or null: it has neither idle nor stand to fill from, or a pose longer than
 * ROOM_CHARACTER_FRAMES_MAX frames (a room strip is one PNG of at most that many cells).
 */
export function characterPlan(set: Record<string, PackStrip> | null | undefined): CharacterPlan | null {
  if (!set || typeof set !== "object") return null;
  const strips = new Map<RoomCharacterPose, PackStrip>();
  for (const pose of ROOM_CHARACTER_POSES) { const st = own(set, pose) as PackStrip | undefined; if (st) strips.set(pose, st); }
  for (const pose of ROOM_CHARACTER_REQUIRED) {
    if (strips.has(pose)) continue;
    const from = FILL[pose].map(p => own(set, p) as PackStrip | undefined).find(Boolean);
    if (!from) return null;
    strips.set(pose, from);
  }
  const poses: CharacterPlan["poses"] = {}, sources = new Set<string>();
  for (const [pose, st] of strips) {
    if (!(st.frames >= 1 && st.frames <= ROOM_CHARACTER_FRAMES_MAX)) return null;
    const cells = Array.from({ length: st.frames }, (_, f) => { const c = stripCell(st, f); return { file: c.src, col: c.col, row: c.row ?? 0 }; });
    for (const c of cells) sources.add(c.file);
    poses[pose] = {
      meta: { frames: st.frames, w: st.w, h: st.h, fps: st.fps, ...(st.durations ? { durations: [...st.durations] } : {}), ...(st.once ? { once: true as const } : {}),
        ...(st.loopFrom ? { loopFrom: st.loopFrom } : {}), ax: st.ax, ay: st.ay, dw: st.dw, dh: st.dh },
      cut: { pose, w: st.w, h: st.h, cells },
    };
  }
  return { poses, sources: [...sources] };
}

/** An office as the owner keeps it, and the packs it can name (web-office-store.ts, web-office-skins.ts). */
export interface CharacterOffices {
  offices: ReadonlyArray<{ skin: string; members: readonly string[] }>;
  autoSkin?: string | null;
  /** Whether an office holds the agent (web-office-acts.ts officeMembers: everyone, picked, or a team's). */
  holds(office: { members: readonly string[] }, agent: string): boolean;
  pack(id: string): CheckedPack | null;
}
/**
 * The pack and set an agent wears by name (Lumen R2c 1): the first office of the owner's own order holding it whose pack
 * names it in `byInstance`, else the "All" office's (`autoSkin`). Another office naming another set later changes nothing.
 */
export function ownCharacter(o: CharacterOffices, agent: string): { packId: string; set: string } | null {
  const named = (packId: string | null | undefined) => {
    if (!packId) return null;
    const pack = o.pack(packId), set = pack ? own(pack.byInstance, agent) : undefined;
    return pack && typeof set === "string" && own(pack.characters, set) ? { packId, set } : null;
  };
  for (const office of o.offices) if (o.holds(office, agent)) { const hit = named(office.skin); if (hit) return hit; }
  return named(o.autoSkin ?? null);
}
