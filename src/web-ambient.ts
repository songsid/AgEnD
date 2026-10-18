/**
 * #2117 (from #2115's proposal): an **ambient** effect is declarative, like a widget. The agent supplies a small closed
 * spec (a preset, its glyphs and a few numbers); the page draws it with its own code (src/ui/chat-ambient.js): plain
 * nodes animated by the Web Animations API, under the chat's content and never taking a click. No agent code runs, so
 * an ambient needs no Worker, preview origin, HTML-preview consent or FPS baseline (Canvas Worker effects do).
 *
 * A chat holds at most one looping ambient (`fall`, `rise`, `twinkle`) and one click ambient (`burst-on-click`): falling
 * petals and click stars together. One module validates and canonicalises the spec; the store keeps only what this
 * returns, and the page checks the bounds again.
 */
import { canonicalColor, canonicalText } from "./web-theme.js";

export const AMBIENT_PRESETS = ["fall", "rise", "twinkle", "burst-on-click"] as const;
export type AmbientPreset = typeof AMBIENT_PRESETS[number];
/** Where a preset is kept: a chat has one of each. */
export const AMBIENT_KINDS = ["loop", "click"] as const;
export type AmbientKind = typeof AMBIENT_KINDS[number];
export const ambientKind = (preset: AmbientPreset): AmbientKind => preset === "burst-on-click" ? "click" : "loop";

export const AMBIENT_GLYPHS_MAX = 4;
export const AMBIENT_GLYPH_GRAPHEMES = 2;
export const AMBIENT_COLORS_MAX = 5;
export const AMBIENT_SPEC_MAX_BYTES = 1024;
/** The page's caps (chat-ambient.js keeps the same numbers): 24 looping particles, 3 bursts of 16 at once. */
export const AMBIENT_LOOP_MAX = 24;
export const AMBIENT_BURST_MAX = 16;
export const AMBIENT_BURSTS_LIVE = 3;

type Range = readonly [number, number];
/** Each preset's bounds and defaults. A count is particles (loops) or particles per click (burst). */
export const AMBIENT_RULES: Record<AmbientPreset, { count: Range; countDefault: number; duration: Range; durationDefault: Range }> = {
  fall: { count: [1, AMBIENT_LOOP_MAX], countDefault: 12, duration: [4, 30], durationDefault: [9, 19] },
  rise: { count: [1, AMBIENT_LOOP_MAX], countDefault: 12, duration: [4, 30], durationDefault: [9, 19] },
  twinkle: { count: [1, AMBIENT_LOOP_MAX], countDefault: 12, duration: [1, 10], durationDefault: [2, 5] },
  "burst-on-click": { count: [4, AMBIENT_BURST_MAX], countDefault: 10, duration: [0.3, 2], durationDefault: [0.5, 0.9] },
};
export const AMBIENT_SIZE: Range = [10, 40];
export const AMBIENT_SIZE_DEFAULT: Range = [14, 22];
export const AMBIENT_SWAY_MAX = 80;
export const AMBIENT_SWAY_DEFAULT = 40;
export const AMBIENT_SPREAD: Range = [20, 120];
export const AMBIENT_SPREAD_DEFAULT: Range = [34, 90];
export const AMBIENT_ROTATE_MAX = 720;
export const AMBIENT_ROTATE_DEFAULT = 300;
export const AMBIENT_OPACITY_DEFAULT = [0, 0.85, 0.15] as const;

const KEYS = ["preset", "glyphs", "colors", "count", "duration", "size", "sway", "spread", "rotate", "opacity", "layer"] as const;
const ASSET_ID = /^[0-9a-f]{32}$/;

export type AmbientGlyph = string | { asset: string };
/** Canonical: every field present, so the page and a preview draw the same thing. */
export interface AmbientSpec {
  preset: AmbientPreset;
  glyphs: AmbientGlyph[];
  /** Empty: the theme's accent. */
  colors: string[];
  count: number;
  duration: [number, number];
  size: [number, number];
  sway: number;
  spread: [number, number];
  rotate: number;
  opacity: [number, number, number];
  layer: "behind";
}
export interface AmbientProblem { path: string; problem: string }
export type Checked<T> = { ok: true; value: T } | { ok: false; errors: AmbientProblem[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/**
 * #2155: a client that read an older declaration of the ranges (a tuple, which codex turned into `Array<string>`) sends
 * `["3", "6"]`. A plain decimal string in one of these arrays is taken as its number; anything else is left as it is,
 * for the check to refuse.
 */
const DECIMAL = /^\s*-?(?:\d+(?:\.\d*)?|\.\d+)\s*$/;
const numbers = (v: unknown): unknown => Array.isArray(v) ? v.map(x => typeof x === "string" && DECIMAL.test(x) ? Number(x) : x) : v;
/** Two decimals are plenty for seconds, pixels and opacity, and keep the stored spec short. */
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * A spec, closed and canonical: unknown keys, a value out of its preset's bounds or a glyph that is not 1..2 visible
 * graphemes (or one of this instance's `glyph` pictures, when `glyphAsset` is given) are refused.
 */
export function checkAmbient(raw: unknown, opts: { glyphAsset?: (id: string) => boolean } = {}): Checked<AmbientSpec> {
  const errors: AmbientProblem[] = [];
  const bad = (path: string, problem: string) => { errors.push({ path, problem }); };
  if (!isObj(raw)) return { ok: false, errors: [{ path: "ambient", problem: "an object { preset, glyphs, … }" }] };
  for (const k of Object.keys(raw)) if (!(KEYS as readonly string[]).includes(k)) bad(k.slice(0, 40), "unknown key");
  const preset = raw.preset as AmbientPreset;
  if (!AMBIENT_PRESETS.includes(preset)) return { ok: false, errors: [...errors, { path: "preset", problem: AMBIENT_PRESETS.join(" | ") }] };
  const rules = AMBIENT_RULES[preset];

  const glyphs: AmbientGlyph[] = [];
  if (!Array.isArray(raw.glyphs) || raw.glyphs.length < 1 || raw.glyphs.length > AMBIENT_GLYPHS_MAX) bad("glyphs", `1..${AMBIENT_GLYPHS_MAX} glyphs`);
  else raw.glyphs.forEach((g, i) => {
    if (typeof g === "string") {
      const t = canonicalText(g, 1, AMBIENT_GLYPH_GRAPHEMES);
      if (t === null) bad(`glyphs.${i}`, `1..${AMBIENT_GLYPH_GRAPHEMES} visible characters (an emoji, ✦, ❀)`); else glyphs.push(t);
    } else if (isObj(g) && Object.keys(g).length === 1 && typeof g.asset === "string" && ASSET_ID.test(g.asset)) {
      if (opts.glyphAsset && !opts.glyphAsset(g.asset)) bad(`glyphs.${i}.asset`, "not one of this instance's glyph pictures (set_web_theme_asset slot glyph)");
      else glyphs.push({ asset: g.asset });
    } else bad(`glyphs.${i}`, "a short string, or { asset: <id> }");
  });

  const colors: string[] = [];
  if (raw.colors !== undefined) {
    if (!Array.isArray(raw.colors) || raw.colors.length > AMBIENT_COLORS_MAX) bad("colors", `0..${AMBIENT_COLORS_MAX} colours`);
    else raw.colors.forEach((c, i) => { const v = canonicalColor(c); if (v === null) bad(`colors.${i}`, "#rgb or #rrggbb"); else colors.push(v); });
  }

  const int = (key: string, [lo, hi]: Range, dflt: number): number => {
    const v = raw[key];
    if (v === undefined) return dflt;
    if (!Number.isSafeInteger(v) || (v as number) < lo || (v as number) > hi) { bad(key, `a whole number ${lo}..${hi}${key === "count" ? ` for ${preset}` : ""}`); return dflt; }
    return v as number;
  };
  const num = (key: string, [lo, hi]: Range, dflt: number): number => {
    const v = raw[key];
    if (v === undefined) return dflt;
    if (!isNum(v) || v < lo || v > hi) { bad(key, `a number ${lo}..${hi}`); return dflt; }
    return round(v);
  };
  const range = (key: string, [lo, hi]: Range, dflt: Range): [number, number] => {
    const v = numbers(raw[key]);
    if (v === undefined) return [dflt[0], dflt[1]];
    if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum) || v[0] < lo || v[1] > hi || v[0] > v[1]) {
      bad(key, `[min, max] within ${lo}..${hi}${key === "duration" ? ` seconds for ${preset}` : ""}`);
      return [dflt[0], dflt[1]];
    }
    return [round(v[0]), round(v[1])];
  };

  const count = int("count", rules.count, rules.countDefault);
  const duration = range("duration", rules.duration, rules.durationDefault);
  const size = range("size", AMBIENT_SIZE, AMBIENT_SIZE_DEFAULT);
  const sway = num("sway", [0, AMBIENT_SWAY_MAX], AMBIENT_SWAY_DEFAULT);
  const spread = range("spread", AMBIENT_SPREAD, AMBIENT_SPREAD_DEFAULT);
  const rotate = num("rotate", [0, AMBIENT_ROTATE_MAX], AMBIENT_ROTATE_DEFAULT);
  let opacity: [number, number, number] = [...AMBIENT_OPACITY_DEFAULT];
  if (raw.opacity !== undefined) {
    const o = numbers(raw.opacity);
    if (!Array.isArray(o) || o.length !== 3 || !o.every(x => isNum(x) && x >= 0 && x <= 1)) bad("opacity", "[start, peak, end], each 0..1");
    else opacity = [round(o[0]), round(o[1]), round(o[2])];
  }
  if (raw.layer !== undefined && raw.layer !== "behind") bad("layer", "\"behind\" (an ambient never covers the chat)");

  if (errors.length) return { ok: false, errors };
  const spec: AmbientSpec = { preset, glyphs, colors, count, duration, size, sway, spread, rotate, opacity, layer: "behind" };
  if (Buffer.byteLength(JSON.stringify(spec), "utf8") > AMBIENT_SPEC_MAX_BYTES) return { ok: false, errors: [{ path: "ambient", problem: `at most ${AMBIENT_SPEC_MAX_BYTES} bytes` }] };
  return { ok: true, value: spec };
}

/** The glyph pictures a spec names. */
export function ambientAssets(spec: AmbientSpec): string[] {
  return spec.glyphs.flatMap(g => typeof g === "string" ? [] : [g.asset]);
}
/** One line per problem, for a tool's refusal. */
export function ambientProblems(errors: AmbientProblem[]): string {
  return errors.map(e => `${e.path}: ${e.problem}`).join("; ");
}
