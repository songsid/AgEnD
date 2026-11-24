/**
 * M-3533 R1 (docs/design/hub-office-visit.md §2): a group room's own office.
 *
 * - Room settings → Room office, on or off. Whether it starts on is ROOM_OFFICE_DEFAULT, the one place (Q5). Starting on
 *   posts no line; a manager's change does ("{name} turned the room office on/off").
 * - The office shows exactly the room's agents and its assistant (§2.2), drawn by the Hub in a built-in style, nothing
 *   of any owner's office. Each agent's state is what the room's member list already shows (the Fleet's presence),
 *   plus "answering in this room", which the Hub knows because it sent the question (§2.4).
 * - The view is the share page's (office-share.ts OfficeShareView.state/officeList) so the dashboard's one Office drawing
 *   can render it: no level, no skin pack, no words (R1).
 */
import type Database from "better-sqlite3";

/**
 * Q5, open with the owner: whether a room's office is on before a manager sets it — rooms made before this shipped
 * (`existingRooms`) and rooms made after (`newRooms`). Each answer is a change here and nowhere else: the stored value is
 * NULL until a manager sets it (existing rooms) or the room is made (new rooms), and officeOn reads NULL as the default.
 */
export const ROOM_OFFICE_DEFAULT = Object.freeze({ existingRooms: true, newRooms: true });

/** Whether a room's office is on: what a manager set, or what a room made when it was made, or the default for old rooms. */
export const officeOn = (stored: number | null): boolean => (stored === null ? ROOM_OFFICE_DEFAULT.existingRooms : stored === 1);

/** The stored value a new room starts with. */
export const newRoomOffice = (): number => Number(ROOM_OFFICE_DEFAULT.newRooms);

export const HUB_ROOM_OFFICE_MIGRATION = Object.freeze({ component: "s3-room-office", version: 1, up(db: Database.Database) {
  db.exec("ALTER TABLE hub_group_rooms ADD COLUMN office_enabled INTEGER CHECK(office_enabled IN (0,1))");
  db.exec("ALTER TABLE hub_group_rooms ADD COLUMN office_style TEXT NOT NULL DEFAULT 'studio'");
  db.exec("CREATE TABLE hub_room_office_events(post_id TEXT PRIMARY KEY REFERENCES hub_room_posts(id) ON DELETE CASCADE,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)))");
} });

/**
 * M-3533 R1b: the styles a room's office may take — the page's ROOM_STYLES (fleet-office-skin.js), largest first: the
 * studio for large rooms, the studio, and the picture styles. The Fleet's desks style is not one of them.
 */
export const ROOM_OFFICE_STYLES = ["studio-large", "studio", "cozy", "guild", "school"] as const;
export type RoomOfficeStyle = (typeof ROOM_OFFICE_STYLES)[number];

/** M-3533 R1b: a manager's style change, one line per save (the style by id; each reader's page words it). */
export const HUB_ROOM_OFFICE_STYLE_MIGRATION = Object.freeze({ component: "s3-room-office-style", version: 1, up(db: Database.Database) {
  db.exec("CREATE TABLE hub_room_office_style_events(post_id TEXT PRIMARY KEY REFERENCES hub_room_posts(id) ON DELETE CASCADE,style TEXT NOT NULL)");
} });

/** The capability a Hub offers once its room page draws the office (R1-page); until then nothing of it is reachable. */
export const HUB_ROOM_OFFICE_FEATURE = "room-office-v1";

/** The one office of a room, as a stored office reads (web-office-store.ts Office): a built-in style, its agents. */
export const ROOM_OFFICE_ID = "room";

/** An agent's place in the room's office: the share page's status-frame fields, and the Hub's own "answering here". */
export interface RoomOfficeAgent {
  name: string; display_name: string; status: "running" | "paused" | "stopped"; execution_state?: "idle" | "working";
  /** The member list's own word for it, so the page says the same (hub-room-presence.js). */
  presence: RoomPresence; answering?: true; assistant?: true;
  /** M-3533 R2a: its look as its owner's Fleet shows it (the identity colour and persona emoji its catalog sends). */
  color?: { person: string }; avatar?: { kind: "emoji"; text: string };
  /** M-3533 R2b: content hashes of the pictures the Hub holds for it (the room's picture route serves them to members). */
  picture?: { disc?: string; portrait?: string };
  /** M-3533 R2c: its own character from its owner's skin pack, a strip a pose (the room's character route serves each). */
  character?: RoomCharacter;
}
/** M-3533 R2c: an agent's own character as a room office draws it (agent-pictures.ts HubCharacterLook): a hash and the pack's fields a pose. */
export type RoomCharacter = Record<string, { sha256: string; frames: number; w: number; h: number; fps: number; durations?: number[]; once?: true; loopFrom?: number; ax: number; ay: number; dw: number; dh: number }>;

/** M-3533 R2a: an agent's look from its owner's agent catalog (agent-catalog-model.ts row `avatar`): colour, emoji. */
export interface RoomOfficeLook { color: string | null; emoji: string | null; disc?: string; portrait?: string; character?: RoomCharacter }

/** M-3533 R2a: the look a room's member list draws (its avatar): a checked colour and emoji, or null when it has neither. */
export function memberLook(look: RoomOfficeLook | null | undefined): { color?: string; emoji?: string; disc?: string; portrait?: string } | null {
  if (!look) return null;
  const color = typeof look.color === "string" && /^#[0-9a-f]{6}$/i.test(look.color) ? look.color.toLowerCase() : null;
  const emoji = typeof look.emoji === "string" && look.emoji.trim() ? look.emoji.trim() : null;
  const { disc, portrait } = pictureOf(look);
  return color || emoji || disc || portrait ? { ...(color ? { color } : {}), ...(emoji ? { emoji } : {}), ...(disc ? { disc } : {}), ...(portrait ? { portrait } : {}) } : null;
}
/** M-3533 R2b: only a content hash crosses (agent-pictures.ts holds the bytes). */
function pictureOf(look: RoomOfficeLook): { disc?: string; portrait?: string } {
  const ok = (h: unknown): h is string => typeof h === "string" && /^[a-f0-9]{64}$/.test(h);
  return { ...(ok(look.disc) ? { disc: look.disc } : {}), ...(ok(look.portrait) ? { portrait: look.portrait } : {}) };
}
/** The look onto the drawing's own fields (identity-color.js resolveColor: a chosen colour; instance-nav.js avatarOf). */
export function withLook(agent: RoomOfficeAgent, look: RoomOfficeLook | null | undefined): RoomOfficeAgent {
  if (!look) return agent;
  const color = typeof look.color === "string" && /^#[0-9a-f]{6}$/i.test(look.color) ? look.color.toLowerCase() : null;
  const emoji = typeof look.emoji === "string" && look.emoji.trim() ? look.emoji.trim() : null;
  const picture = pictureOf(look);
  // M-3533 R2c: whole or not at all (agent-pictures.ts holds a set only when every strip is held), each strip a hash.
  const character = look.character && Object.values(look.character).every(st => !!st && /^[a-f0-9]{64}$/.test(st.sha256)) && Object.keys(look.character).length ? look.character : null;
  return { ...agent, ...(color ? { color: { person: color } } : {}), ...(emoji ? { avatar: { kind: "emoji" as const, text: emoji } } : {}),
    ...(picture.disc || picture.portrait ? { picture } : {}), ...(character ? { character } : {}) };
}

/** The member list's presences: a personal agent whose computer is offline answers "later", when it is back. */
export type RoomPresence = "idle" | "working" | "paused" | "offline" | "later";

/**
 * A member list presence (and whether the Hub is waiting on its answer in this room) as the Office draws it (fleet-org.js
 * orgState): only idle and working are at work; paused is paused; offline, later or anything unknown is away.
 */
export function officeAgent(id: string, name: string, presence: RoomPresence, answering: boolean, assistant = false): RoomOfficeAgent {
  const at = presence === "idle" || presence === "working";
  const out: RoomOfficeAgent = at ? { name: id, display_name: name, status: "running", execution_state: answering || presence === "working" ? "working" : "idle", presence }
    : { name: id, display_name: name, status: presence === "paused" ? "paused" : "stopped", presence: presence === "paused" || presence === "later" ? presence : "offline" };
  if (answering && at) out.answering = true;
  if (assistant) out.assistant = true;
  return out;
}

/** The share-shaped view (OfficeShareView.state plus officeList): no teams, traffic, needs, levels, talk or words. */
export function roomOfficeView(room: { name: string; style: string }, agents: RoomOfficeAgent[], now: number) {
  return {
    instances: agents,
    org: { general: [], teams: [], instances: {} },
    needs: [],
    traffic: { now: new Date(now).toISOString(), items: [], delegations: [] },
    text: false,
    office: ROOM_OFFICE_ID,
    offices: { rev: 0, readable: true, offices: [{ id: ROOM_OFFICE_ID, name: room.name, skin: room.style, members: agents.map(a => a.name) }] },
  };
}
