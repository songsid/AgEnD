/**
 * #1958: the identity colour's palettes and placements — no imports, so the theme's schema (web-theme.ts) and the
 * colour's resolution (web-identity-color.ts) both read them without a cycle.
 *
 * - The presets a person (or an agent) picks from: 12 clear colours.
 * - The automatic colours (the user's decision 4): a handful of soft, low-saturation colours like the default avatar
 *   colours of Telegram and Discord, chosen by a stable hash of the name. Two instances may share one.
 * Every value reads at 4.5:1 or better on the page's and the sidebar's background, in its mode (a test pins it).
 */

/** The presets: each one's value on the light and on the dark page. */
export const IDENTITY_PALETTE = [
  { id: "red", light: "#cf222e", dark: "#ff7b72" },
  { id: "orange", light: "#bc4c00", dark: "#ffa657" },
  { id: "amber", light: "#8a5d00", dark: "#e3b341" },
  { id: "lime", light: "#4d7c0f", dark: "#a3e635" },
  { id: "green", light: "#1a7f37", dark: "#56d364" },
  { id: "teal", light: "#0f766e", dark: "#2dd4bf" },
  { id: "cyan", light: "#0e7490", dark: "#22d3ee" },
  { id: "blue", light: "#0a62c2", dark: "#7ab7ff" },
  { id: "indigo", light: "#4f46e5", dark: "#a5b4fc" },
  { id: "violet", light: "#8250df", dark: "#d2a8ff" },
  { id: "pink", light: "#bf3989", dark: "#f778ba" },
  { id: "slate", light: "#57606a", dark: "#b1bac4" },
] as const;
/** The automatic colours: soft, and few on purpose (duplicates are fine). */
export const AUTO_PALETTE = [
  { id: "sand", light: "#8a6d3b", dark: "#d4b98a" },
  { id: "clay", light: "#9c5a4a", dark: "#d9a294" },
  { id: "rose", light: "#9b4f6a", dark: "#d99ab0" },
  { id: "plum", light: "#7a5a8c", dark: "#c3a6d6" },
  { id: "dusk", light: "#5a628f", dark: "#a9b0db" },
  { id: "sea", light: "#3f7286", dark: "#92c2d4" },
  { id: "moss", light: "#5b7340", dark: "#a9c48d" },
  { id: "slate", light: "#5f6b78", dark: "#aeb8c4" },
] as const;
export type PresetId = (typeof IDENTITY_PALETTE)[number]["id"];
export type AutoId = (typeof AUTO_PALETTE)[number]["id"];
/** What is stored and sent: a preset, an automatic colour (never stored), or a custom colour. */
export type IdentityColor = `preset:${PresetId}` | `auto:${AutoId}` | `#${string}`;
const PRESETS: ReadonlyMap<string, (typeof IDENTITY_PALETTE)[number]> = new Map(IDENTITY_PALETTE.map(p => [p.id, p]));
const AUTOS: ReadonlyMap<string, (typeof AUTO_PALETTE)[number]> = new Map(AUTO_PALETTE.map(p => [p.id, p]));

/** "#rgb" | "#rrggbb", any case → "#rrggbb" lowercase (web-theme.ts canonicalColor's rule); anything else → null. */
function hexColor(v: string): `#${string}` | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(v);
  if (!m) return null;
  const h = m[1]!.toLowerCase();
  return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
}

/**
 * A colour as a person or an agent gives it — a preset's id ("blue", or "preset:blue") or a hex colour ("#abc",
 * "#aabbcc", any case) — in the form it is kept; null for anything else (an automatic colour is never picked).
 */
export function canonicalIdentityColor(v: unknown): IdentityColor | null {
  if (typeof v !== "string") return null;
  const id = v.startsWith("preset:") ? v.slice("preset:".length) : v;
  if (PRESETS.has(id)) return `preset:${id as PresetId}`;
  return hexColor(v);
}

/** The colour drawn for `c` on a page in `mode`: a preset's or an automatic colour's value for that mode, a custom one as it is. */
export function identityColorValue(c: IdentityColor, mode: "light" | "dark"): string {
  const p = c.startsWith("preset:") ? PRESETS.get(c.slice(7)) : c.startsWith("auto:") ? AUTOS.get(c.slice(5)) : undefined;
  return p ? p[mode] : c;
}

/** The automatic colour: one of AUTO_PALETTE, chosen by the name (32-bit FNV-1a over its UTF-8 bytes), the same on every load. */
export function autoIdentityColor(name: string): IdentityColor {
  let h = 0x811c9dc5;
  for (const unit of new TextEncoder().encode(name)) { h ^= unit; h = Math.imul(h, 0x01000193) >>> 0; }
  return `auto:${AUTO_PALETTE[h % AUTO_PALETTE.length]!.id}`;
}

/** Where the colour shows (the user's decision 2): the name, a bar at the row's left edge, the avatar's ring. */
export const PLACEMENTS = ["name", "bar", "ring"] as const;
export type Placement = (typeof PLACEMENTS)[number];
/** The host's default where nobody chose (decision 1): ring and bar. */
export const DEFAULT_PLACEMENTS: readonly Placement[] = ["bar", "ring"];
/** A set of places, in PLACEMENTS order, no repeats; [] is "nowhere". null for anything else. */
export function canonicalPlacements(v: unknown): Placement[] | null {
  if (!Array.isArray(v) || v.length > PLACEMENTS.length || !v.every(p => (PLACEMENTS as readonly unknown[]).includes(p))) return null;
  if (new Set(v).size !== v.length) return null;
  return PLACEMENTS.filter(p => v.includes(p));
}
