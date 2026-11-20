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
}
export interface PackPoint { x: number; y: number }
/** #2691: a seat reserved for `for` (lent while they are all elsewhere when `lend`); a plain seat has neither. */
export interface PackSeat extends PackPoint { for?: string[]; lend?: boolean }
export interface PackArea { name: string; rect: { x: number; y: number; w: number; h: number }; seats: PackSeat[] }
/** `label` (#2574): its name tag, or null. `activeOn`/`hides` (#2698): when it turns active, and whether it hides its people then. */
export interface PackFurniture { id: string; sprite: PackStrip; x: number; y: number; depth: number | "y"; activeWhen: string[] | null; activeSprite: PackStrip | null;
  activeFor?: string[] | null; loop?: boolean; activeOn?: "state" | "seated"; hides?: boolean; label: string | null }
export interface CheckedPack {
  format: 1; id: string; scale: number; background?: string; foreground?: string; matte?: string;
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
  dialogBox?: { frame?: string; slice?: number; background?: string; border?: string; text?: string; name?: string };
  /** #3685: areas an idle person now and then visits (a free seat there, for minSeconds–maxSeconds); absent: none. */
  idleVisits?: Array<{ area: string; weight: number; minSeconds: number; maxSeconds: number }>;
}
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
export const CHAR_DEPTH: number;
export const PACK_STATES: string[];
export const BUBBLE_KEYS: string[];
export const STRIP_LIMITS: { sheetFrames: number; sheets: number; frames: number; minMs: number; maxMs: number };
export function own<T = unknown>(o: unknown, k: unknown): T | undefined;
export function inherited(k: unknown): boolean;
export function matteOk(v: unknown): v is string;
export function checkStrip(v: unknown, at?: string, scale?: number): PackStrip;
export function stripSheets(st: PackStrip | null | undefined): PackStripSheet[];
export function stripImages(st: PackStrip | null | undefined): string[];
export function stripFrameAt(st: PackStrip | null | undefined, ms: number): number;
export function stripCell(st: PackStrip | null | undefined, frame: number): { src: string; col: number };
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
export function checkLayoutOverrides(x: unknown): { ok: true; overrides: LayoutOverrides } | { ok: false; error: string };
export function applyOverrides(pack: CheckedPack, ov: LayoutOverrides | null | undefined): { ok: true; pack: CheckedPack } | { ok: false; error: string };
export function fitNight<T extends LayoutOverrides | null | undefined>(pack: CheckedPack, ov: T): T;
export function fitSeatFor<T extends LayoutOverrides | null | undefined>(pack: CheckedPack, ov: T): T;
export function overridesBetween(pack: CheckedPack, edited: CheckedPack): LayoutOverrides | null;
export function poseStrip(set: Record<string, PackStrip> | null | undefined, pose: string, heading?: { dx: number; dy: number } | null): { strip: PackStrip; mirror: boolean } | null;
export function walkStrip(f: { walk?: Record<string, PackStrip> | null; walking?: boolean; heading?: { dx: number; dy: number } | null } | null | undefined): { strip: PackStrip; mirror: boolean } | null;
export function stripBox(st: PackStrip, x: number, y: number, mirror?: boolean): { x: number; y: number; w: number; h: number };
