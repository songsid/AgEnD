// Types for fleet-office-pack.js: the page's module, which the host imports too (web-office-skins.ts,
// web-office-store.ts), so both check a skin pack and an office's layout overrides by the same rules.
/** One sheet of a multi-sheet or frame-list strip (`src` is `frames·w × h` px). */
export interface PackStripSheet { src: string; frames: number }
/** `dw` × `dh`: its displayed size in logical units (w·scale × h·scale unless the manifest says otherwise). */
export interface PackStrip {
  src: string; frames: number; w: number; h: number; fps: number; ax: number; ay: number; dw: number; dh: number;
  /** M-3394 (#4231): present on multi-sheet (`src: [...]`) and frame-list (`frames: [{ src, ms? }]`) strips. */
  sheets?: PackStripSheet[];
  /** M-3394: per-frame durations in ms (length === `frames`). */
  durations?: number[];
  /** M-3394: play once and hold the last frame. */
  once?: boolean;
  /** M-3394 (#4231): intro plays `0 .. loopFrom - 1` once, then loops `loopFrom .. frames - 1`. */
  loopFrom?: number;
  /** Sheet cells: the strip starts at this row / column of w×h cells (both present when either was given). */
  row?: number;
  col?: number;
}
export interface PackPoint { x: number; y: number }
/** #2691: a seat reserved for `for` (lent while they are all elsewhere when `lend`); a plain seat has neither. */
export interface PackSeat extends PackPoint { for?: string[]; lend?: boolean }
export interface PackArea { name: string; rect: { x: number; y: number; w: number; h: number }; seats: PackSeat[] }
/** `label` (#2574): its name tag, or null. `activeOn`/`hides` (#2698): when it turns active, and whether it hides its people then. */
export interface PackFurniture { id: string; sprite: PackStrip; x: number; y: number; depth: number | "y"; activeWhen: string[] | null; activeSprite: PackStrip | null;
  activeFor?: string[] | null; loop?: boolean; activeOn?: "state" | "seated"; hides?: boolean; label: string | null }
export interface CheckedPack {
  format: 1; id: string; scale: number; /** Its own canvas (logical units), else 1280×720. */ canvas?: { w: number; h: number }; background?: string; foreground?: string; matte?: string;
  areas: Record<string, PackArea>; stateZones: Record<string, string> | null; door: PackPoint;
  /** #2736: where a letter from another office lands, or null (the waypoint nearest the middle). */
  mailDrop: PackPoint | null;
  waypoints: Array<{ id: string; x: number; y: number }>; edges: Array<[string, string]>;
  furniture: PackFurniture[]; characters: Record<string, Record<string, PackStrip>>; byInstance: Record<string, string>;
  props: Record<string, PackStrip>; bubbles: Record<string, Record<string, string[]>>;
  /** #3681: a character set's own lines (`characters.<set>.bubbles`) and an instance's (`bubblesByInstance`); only when the pack has any. */
  bubblesBySet?: Record<string, Record<string, Record<string, string[]>>>;
  bubblesByInstance?: Record<string, Record<string, Record<string, string[]>>>;
  room: { floor?: string; wall?: string }; desk: { back?: string; front?: string; lit?: string };
  /** #2661: the Office levels' words — titles from each level up, and titles pinned on instances or NPCs. */
  levels?: LevelWords;
  /** #2861: the dialogue box's faces — each an expression (idle, working, needs) → file. */
  portraits?: { default?: PackPortrait; byInstance: Record<string, PackPortrait>; byUser: Record<string, PackPortrait>; npc: Record<string, PackPortrait> };
  /** #2861: the dialogue box's look — a 9-slice frame and colours (#rrggbb). */
  dialogBox?: { frame?: string; slice?: number; background?: string; border?: string; text?: string; name?: string;
    /** The reply over a head (the Office's "Over their head" talk): its 9-slice frame, colours and entrance. */
    bubble?: { frame?: string; slice?: number; background?: string; border?: string; text?: string; name?: string; enter?: "pop" | "fade" | "none" } };
  /** #4256: optional agent profile card preset, visual style, and layout. */
  card?: PackCard;
  /** #3685: areas an idle person now and then visits (a free seat there, for minSeconds–maxSeconds); absent: none. */
  idleVisits?: Array<{ area: string; weight: number; minSeconds: number; maxSeconds: number }>;
  /** M-3432 (#4255): optional custom snacks the viewer may drag-to-feed or place on the floor. */
  snacks?: PackSnack[];
  /** A train on a loop of track (fleet-office-vehicles.js); agents ride by office_set `ride`. */
  vehicles?: PackVehicle[];
}
/** M-3432 (#4255): one custom snack item from a pack's `snacks` list. */
export interface PackSnack {
  id: string;
  label?: string | { en?: string; "zh-TW"?: string };
  sprite: PackStrip;
  eat?: PackStrip;
  radius: number;
}
/** #4256: agent profile card style and layout from a skin pack. */
export type CardPreset = "default" | "rpg" | "compact" | "dossier";
export type CardRadius = "none" | "sm" | "md" | "lg";
export type CardAvatarSize = "sm" | "md" | "lg";
export type CardAvatarSource = "sprite" | "portrait";
export type CardHeaderAlign = "left" | "center";
export type CardSection = "header" | "level" | "rows" | "now" | "tell" | "actions";
export type CardRowKey = "office" | "model" | "backend" | "today" | "firstSeen";
export type CardHideKey = "instance" | "title" | "badge" | "level" | "xpBar" | "office" | "model" | "backend" | "today" | "firstSeen" | "now";
export interface PackCardStyle {
  background?: string; border?: string; text?: string; muted?: string; accent?: string;
  barTrack?: string; barFill?: string; buttonBg?: string; buttonText?: string; buttonPrimaryBg?: string; buttonPrimaryText?: string;
  backgroundImage?: string; frame?: string; slice?: number; radius?: CardRadius;
}
export interface PackCardLayout {
  avatarSize?: CardAvatarSize; avatarSource?: CardAvatarSource; headerAlign?: CardHeaderAlign; width?: number; gap?: number;
  sections?: CardSection[]; rows?: CardRowKey[]; rowColumns?: 1 | 2; hide?: CardHideKey[];
}
export type CardEnter = "none" | "fade" | "pop" | "rise" | "slide" | "bounce";
export interface PackCardMotion { enter: CardEnter; ms: number }
export interface PackCard { preset?: CardPreset; style?: PackCardStyle; layout?: PackCardLayout; motion?: PackCardMotion }
/** #2861: a portrait's files by the state it is shown in (at least one). */
export type PackPortrait = Partial<Record<"idle" | "working" | "needs", string>>;
/** #2661: the Office levels' words (a pack's `levels`; #3679: the fleet-wide one too). */
export interface LevelWords { titles?: Array<{ from: number; name: string }>; fixed?: Record<string, { title: string; hideLevel: boolean }> }
export interface LayoutOverrides {
  pack: string;
  seats?: Record<string, Array<[number, number]>>;
  furniture?: Record<string, [number, number]>;
  /** #2665: an item's night place (an item with a `night` only). */
  furnitureNight?: Record<string, [number, number]>;
  /** #2691: a seat's reservation by area and slot ("0", "1", …), in place of the pack's; `for: []` is none. */
  seatFor?: Record<string, Record<string, { for: string[]; lend: boolean }>>;
  door?: [number, number];
  /** #2736: where a letter from another office lands. */
  mailDrop?: [number, number];
  waypoints?: Array<{ id: string; x: number; y: number }>;
  edges?: Array<[string, string]>;
}
export const LOGICAL: { w: number; h: number };
export const CANVAS: { min: { w: number; h: number }; max: { w: number; h: number } };
export function canvasOf(pack: unknown): { w: number; h: number };
export const CHAR_DEPTH: number;
export const PACK_STATES: string[];
export const BUBBLE_KEYS: string[];
export const STRIP_LIMITS: { sheetFrames: number; sheets: number; frames: number; minMs: number; maxMs: number };
export const SNACK_LIMITS: { max: number; minRadius: number; maxRadius: number; defaultRadius: number; labelMax: number };
export function snackLabel(snack: PackSnack | null | undefined, lang?: string): string;
export function stripDurationMs(st: PackStrip | null | undefined): number;
export function own<T = unknown>(o: unknown, k: unknown): T | undefined;
export function inherited(k: unknown): boolean;
export function matteOk(v: unknown): v is string;
export function relativeLuminance(hex: string): number | null;
export function contrastRatio(hexA: string, hexB: string): number;
export const CARD_PRESETS: CardPreset[];
export const CARD_ENTERS: CardEnter[];
export const CARD_RADII: CardRadius[];
export const CARD_AVATAR_SIZES: CardAvatarSize[];
export const CARD_AVATAR_SOURCES: CardAvatarSource[];
export const CARD_HEADER_ALIGNS: CardHeaderAlign[];
export const CARD_SECTIONS: CardSection[];
export const CARD_ROWS: CardRowKey[];
export const CARD_HIDE: CardHideKey[];
export const CARD_STYLE_COLORS: string[];
export const CARD_LIMITS: { widthMin: number; widthMax: number; gapMax: number; motionMsMin: number; motionMsMax: number; sliceMax: number; textContrast: number; uiContrast: number };
export function checkStrip(v: unknown, at?: string, scale?: number): PackStrip;
export function stripSheets(st: PackStrip | null | undefined): PackStripSheet[];
export function stripImages(st: PackStrip | null | undefined): string[];
export function stripFrameAt(st: PackStrip | null | undefined, ms: number): number;
export function stripCell(st: PackStrip | null | undefined, frame: number): { src: string; col: number; row?: number };
export function stripMaxFps(st: PackStrip | null | undefined): number;
export function packMaxFps(pack: CheckedPack | null | undefined): number;
export function createClipClocks(): { elapsed(key: string, strip: PackStrip | null | undefined, ms: number): number; prune(seen: ReadonlySet<string>): void; clear(): void };
export function checkSkinPack(x: unknown, opts?: { kept?: boolean }): { ok: true; pack: CheckedPack } | { ok: false; error: string };
/** #3679: a fleet-wide `levels`, by a pack's rules. */
export function checkLevels(v: unknown): { ok: true; levels: LevelWords } | { ok: false; error: string };
export function skinPackOk(x: unknown): CheckedPack | null;
export function packImages(pack: CheckedPack): string[];
export function packSceneImages(pack: CheckedPack): string[];
export function packPortraitImages(pack: CheckedPack): string[];
export const PORTRAIT_STATES: string[];
export function packStrips(pack: CheckedPack): Array<{ at: string; strip: PackStrip }>;
export function checkLayoutOverrides(x: unknown, canvas?: { w: number; h: number }): { ok: true; overrides: LayoutOverrides } | { ok: false; error: string };
export function applyOverrides(pack: CheckedPack, ov: LayoutOverrides | null | undefined): { ok: true; pack: CheckedPack } | { ok: false; error: string };
export function fitNight<T extends LayoutOverrides | null | undefined>(pack: CheckedPack, ov: T): T;
export function fitSeatFor<T extends LayoutOverrides | null | undefined>(pack: CheckedPack, ov: T): T;
export function overridesBetween(pack: CheckedPack, edited: CheckedPack): LayoutOverrides | null;
export const PREVIEW_POSES: string[];
export function previewLook<T extends { pose?: string }>(look: T, pose: string): T & { pose: string; heading?: { dx: number; dy: number }; basePose?: string };
export function poseStrip(set: Record<string, PackStrip> | null | undefined, pose: string, heading?: { dx: number; dy: number } | null): { strip: PackStrip; mirror: boolean } | null;
export function walkStrip(f: { walk?: Record<string, PackStrip> | null; walking?: boolean; heading?: { dx: number; dy: number } | null } | null | undefined): { strip: PackStrip; mirror: boolean } | null;
export function stripBox(st: PackStrip, x: number, y: number, mirror?: boolean): { x: number; y: number; w: number; h: number };

/** A pack's vehicle, checked: round its closed `path` at `speed` units a second, waiting at each stop; riders sit at `seats`. */
export interface PackVehicle {
  id: string; label?: string; sprite: PackStrip | null; sprites?: Partial<Record<"right" | "left" | "up" | "down", PackStrip>>;
  fronts?: Partial<Record<"right" | "left" | "up" | "down", PackStrip>>;
  path: PackPoint[]; speed: number; stops: Array<{ at: number; seconds: number; platform: PackPoint }>; seats: Array<{ dx: number; dy: number }>;
}
export const VEHICLE_LIMITS: { vehicles: number; path: number; stops: number; seats: number; minSpeed: number; maxSpeed: number; defaultSpeed: number; maxSeconds: number; defaultSeconds: number; offset: number };
