// Types for fleet-office-pack.js: the page's module, which the host imports too (web-office-skins.ts,
// web-office-store.ts), so both check a skin pack and an office's layout overrides by the same rules.
/** `dw` × `dh`: its displayed size in logical units (w·scale × h·scale unless the manifest says otherwise). */
export interface PackStrip { src: string; frames: number; w: number; h: number; fps: number; ax: number; ay: number; dw: number; dh: number }
export interface PackPoint { x: number; y: number }
/** #2691: a seat reserved for `for` (lent while they are all elsewhere when `lend`); a plain seat has neither. */
export interface PackSeat extends PackPoint { for?: string[]; lend?: boolean }
export interface PackArea { name: string; rect: { x: number; y: number; w: number; h: number }; seats: PackSeat[] }
/** `label` (#2574): its name tag, or null. */
export interface PackFurniture { id: string; sprite: PackStrip; x: number; y: number; depth: number | "y"; activeWhen: string[] | null; activeSprite: PackStrip | null; label: string | null }
export interface CheckedPack {
  format: 1; id: string; scale: number; background?: string; foreground?: string; matte?: string;
  areas: Record<string, PackArea>; stateZones: Record<string, string> | null; door: PackPoint;
  waypoints: Array<{ id: string; x: number; y: number }>; edges: Array<[string, string]>;
  furniture: PackFurniture[]; characters: Record<string, Record<string, PackStrip>>; byInstance: Record<string, string>;
  props: Record<string, PackStrip>; bubbles: Record<string, Record<string, string[]>>;
  room: { floor?: string; wall?: string }; desk: { back?: string; front?: string; lit?: string };
}
export interface LayoutOverrides {
  pack: string;
  seats?: Record<string, Array<[number, number]>>;
  furniture?: Record<string, [number, number]>;
  /** #2665: an item's night place (an item with a `night` only). */
  furnitureNight?: Record<string, [number, number]>;
  /** #2691: a seat's reservation by area and slot ("0", "1", …), in place of the pack's; `for: []` is none. */
  seatFor?: Record<string, Record<string, { for: string[]; lend: boolean }>>;
  door?: [number, number];
  waypoints?: Array<{ id: string; x: number; y: number }>;
  edges?: Array<[string, string]>;
}
export const LOGICAL: { w: number; h: number };
export const CHAR_DEPTH: number;
export const PACK_STATES: string[];
export function own<T = unknown>(o: unknown, k: unknown): T | undefined;
export function inherited(k: unknown): boolean;
export function matteOk(v: unknown): v is string;
export function checkStrip(v: unknown, at?: string, scale?: number): PackStrip;
export function checkSkinPack(x: unknown, opts?: { kept?: boolean }): { ok: true; pack: CheckedPack } | { ok: false; error: string };
export function skinPackOk(x: unknown): CheckedPack | null;
export function packImages(pack: CheckedPack): string[];
export function packStrips(pack: CheckedPack): Array<{ at: string; strip: PackStrip }>;
export function checkLayoutOverrides(x: unknown): { ok: true; overrides: LayoutOverrides } | { ok: false; error: string };
export function applyOverrides(pack: CheckedPack, ov: LayoutOverrides | null | undefined): { ok: true; pack: CheckedPack } | { ok: false; error: string };
export function fitNight<T extends LayoutOverrides | null | undefined>(pack: CheckedPack, ov: T): T;
export function fitSeatFor<T extends LayoutOverrides | null | undefined>(pack: CheckedPack, ov: T): T;
export function overridesBetween(pack: CheckedPack, edited: CheckedPack): LayoutOverrides | null;
export function poseStrip(set: Record<string, PackStrip> | null | undefined, pose: string, heading?: { dx: number; dy: number } | null): { strip: PackStrip; mirror: boolean } | null;
export function walkStrip(f: { walk?: Record<string, PackStrip> | null; walking?: boolean; heading?: { dx: number; dy: number } | null } | null | undefined): { strip: PackStrip; mirror: boolean } | null;
export function stripBox(st: PackStrip, x: number, y: number, mirror?: boolean): { x: number; y: number; w: number; h: number };
