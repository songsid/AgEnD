/**
 * #1629 (first design §1, §8; r2 §8): an agent's web theme — a small, closed, typed object. One module validates and
 * canonicalises it; the store keeps only what this returns, and the page applies only canonical values (colours as
 * "#rrggbb", choices as fixed tokens, numbers in range). Nothing here is CSS text.
 *
 * The theme is the look only. Where an agent's effects and widgets are placed is the store's (web-theme-store.ts
 * placements): `set_web_theme` never places anything.
 */

import { canonicalIdentityColor, canonicalPlacements, type IdentityColor, type Placement } from "./web-identity-palette.js";

export type Color = string;
export type AssetId = string;
export interface Palette { bg?: Color; surface?: Color; text?: Color; text2?: Color; accent?: Color; userBubble?: Color; agentBubble?: Color }
export type ThemeMode = "light" | "dark";
export interface Theme {
  v: 1;
  colors?: { light?: Palette; dark?: Palette };
  accent?: Color;
  bubble?: { radius?: number; border?: "none" | "thin" | "accent" };
  font?: "inter" | "system" | "mono";
  background?: { image: AssetId; fit: "cover" | "contain"; opacity: number };
  avatar?: AssetId;
  workingLabel?: string;
  /** r4 §1: the agent's identity card. A person's card fields (View's Edit profile) win field by field. */
  card?: ThemeCard;
  /**
   * #1958: the agent's identity colour (a preset or #rrggbb; without it, its accent) and where it shows. A person's
   * choice for this instance wins, field by field.
   */
  identity?: ThemeIdentity;
}
export interface ThemeIdentity { color?: IdentityColor; show?: Placement[] }
/** #2086: `bannerFocus` — which part of a cropped banner stays in view, 0 (top) … 100 (bottom); absent: the centre. */
export interface ThemeCard { portrait?: AssetId; banner?: AssetId; tagline?: string; bio?: string; bannerFocus?: number }
export interface ThemeProblem { path: string; problem: string }

export const THEME_MAX_BYTES = 4096;
export const PALETTE_KEYS = ["bg", "surface", "text", "text2", "accent", "userBubble", "agentBubble"] as const;
const MODES: readonly ThemeMode[] = ["light", "dark"];
const BORDERS = ["none", "thin", "accent"] as const;
const FONTS = ["inter", "system", "mono"] as const;
const FITS = ["cover", "contain"] as const;
const ASSET_ID = /^[0-9a-f]{32}$/;

/**
 * The token defaults (src/ui/shared/tokens.css) the contrast check measures a theme against — a test pins these equal
 * to the stylesheet. An agent message has no bubble of its own: its "bubble" is the page background.
 */
export const THEME_DEFAULTS: Record<ThemeMode, Required<Palette>> = {
  dark: { bg: "#212121", surface: "#2f2f2f", text: "#ececec", text2: "#b4b4b4", accent: "#7ab7ff", userBubble: "#2f2f2f", agentBubble: "#212121" },
  light: { bg: "#ffffff", surface: "#f4f4f4", text: "#0d0d0d", text2: "#5d5d5d", accent: "#0a62c2", userBubble: "#f4f4f4", agentBubble: "#ffffff" },
};
/** WCAG AA: [foreground, background, minimum ratio]. */
export const CONTRAST_PAIRS: ReadonlyArray<readonly [keyof Palette, keyof Palette, number]> = [
  ["text", "bg", 4.5], ["text", "surface", 4.5], ["text", "agentBubble", 4.5], ["text", "userBubble", 4.5],
  ["text2", "bg", 4.5], ["text2", "surface", 4.5],
  ["accent", "bg", 3],
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** "#rgb" | "#rrggbb", any case → "#rrggbb" lowercase; anything else (names, alpha, functions, text after it) → null. */
export function canonicalColor(v: unknown): Color | null {
  if (typeof v !== "string") return null;
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(v);
  if (!m) return null;
  const h = m[1]!.toLowerCase();
  return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/**
 * Control, format (incl. bidi overrides, zero-width space), line/paragraph separators: never in a label — except the
 * zero-width joiner, which emoji sequences (👨‍👩‍👧) are made of.
 */
const FORBIDDEN_TEXT = /(?!\u200d)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/**
 * At least one character that draws something: not a mark, control, format or separator, nor a blank that renders as
 * nothing (Hangul fillers, braille blank) — so a lone joiner, variation selector or filler is not a label (#1887 P3).
 */
const VISIBLE = /[^\p{M}\p{C}\p{Z}\u115f\u1160\u3164\uffa0\u2800]/u;
/** A card's bio (r4 §1): NFC, 1..280 graphemes, at most 3 line breaks ("\n" only), otherwise as one line. */
export const BIO_MAX_GRAPHEMES = 280;
export const BIO_MAX_BREAKS = 3;
export const TAGLINE_MAX_GRAPHEMES = 60;
/**
 * #1889 review: one explicit bound in UTF-16 units too, for the host and the page alike — a grapheme may be many units
 * (an emoji family is 8), so 10 per grapheme keeps every ordinary text and still bounds what is stored.
 */
export const TAGLINE_MAX_UNITS = TAGLINE_MAX_GRAPHEMES * 10;
export const BIO_MAX_UNITS = 2800;
/** A card's tagline: one line of 1..60 graphemes, at most TAGLINE_MAX_UNITS units. */
export function canonicalTagline(v: unknown): string | null {
  const t = canonicalText(v, 1, TAGLINE_MAX_GRAPHEMES);
  return t !== null && t.length <= TAGLINE_MAX_UNITS ? t : null;
}
export function canonicalBio(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFC");
  const lines = s.split("\n");
  if (s.length > BIO_MAX_UNITS || lines.length > BIO_MAX_BREAKS + 1 || s.trim() !== s || !VISIBLE.test(s)) return null;
  if (lines.some(l => FORBIDDEN_TEXT.test(l))) return null;
  const n = [...GRAPHEMES.segment(s)].length;
  return n >= 1 && n <= BIO_MAX_GRAPHEMES ? s : null;
}
/** One line of text: NFC, `min..max` graphemes, nothing invisible or directional. */
export function canonicalText(v: unknown, min: number, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFC");
  if (FORBIDDEN_TEXT.test(s) || s.trim() !== s || !VISIBLE.test(s)) return null;
  const n = [...GRAPHEMES.segment(s)].length;
  return n >= min && n <= max ? s : null;
}

function relLuminance(hex: Color): number {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export function contrastRatio(a: Color, b: Color): number {
  const [l1, l2] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

/** The palette a mode renders with: the theme's colours over the defaults (a mode's accent, else the theme's). */
export function effectivePalette(theme: Theme, mode: ThemeMode): Required<Palette> {
  return { ...THEME_DEFAULTS[mode], ...(theme.accent ? { accent: theme.accent } : {}), ...(theme.colors?.[mode] ?? {}) };
}

export interface ThemeContext {
  /** The asset ids this instance has (background and avatar must name one). */
  assets: ReadonlySet<string>;
  /** r4 §1: each asset's slot — a card's portrait and banner must name a picture uploaded for that slot. */
  slotOf?: (id: string) => string | undefined;
}

/**
 * The whole theme, checked and canonicalised: closed schema at every level, types never coerced, integers and steps,
 * colours re-serialised, text NFC and counted in graphemes, asset ids this instance has, contrast per mode, ≤ 4 KiB.
 */
export function checkTheme(input: unknown, ctx: ThemeContext): { ok: true; theme: Theme } | { ok: false; errors: ThemeProblem[] } {
  const errors: ThemeProblem[] = [];
  const bad = (path: string, problem: string) => { errors.push({ path, problem }); };
  if (!isObj(input)) return { ok: false, errors: [{ path: "", problem: "must be an object" }] };
  const out: Theme = { v: 1 };
  const known = new Set(["v", "colors", "accent", "bubble", "font", "background", "avatar", "workingLabel", "card", "identity"]);
  for (const k of Object.keys(input)) if (!known.has(k)) bad(k, "unknown key");
  if (input.v !== undefined && input.v !== 1) bad("v", "must be 1");

  if (input.colors !== undefined) {
    if (!isObj(input.colors)) bad("colors", "must be an object");
    else {
      const colors: NonNullable<Theme["colors"]> = {};
      for (const k of Object.keys(input.colors)) if (!(MODES as readonly string[]).includes(k)) bad(`colors.${k}`, "unknown key (light or dark)");
      for (const mode of MODES) {
        const pal = input.colors[mode];
        if (pal === undefined) continue;
        if (!isObj(pal)) { bad(`colors.${mode}`, "must be an object"); continue; }
        const p: Palette = {};
        for (const k of Object.keys(pal)) {
          if (!(PALETTE_KEYS as readonly string[]).includes(k)) { bad(`colors.${mode}.${k}`, "unknown key"); continue; }
          const c = canonicalColor(pal[k]);
          if (!c) bad(`colors.${mode}.${k}`, "must be a colour #rgb or #rrggbb");
          else p[k as keyof Palette] = c;
        }
        if (Object.keys(p).length) colors[mode] = sortPalette(p);
      }
      if (Object.keys(colors).length) out.colors = colors;
    }
  }
  if (input.accent !== undefined) {
    const c = canonicalColor(input.accent);
    if (!c) bad("accent", "must be a colour #rgb or #rrggbb"); else out.accent = c;
  }
  if (input.bubble !== undefined) {
    if (!isObj(input.bubble)) bad("bubble", "must be an object");
    else {
      const b: NonNullable<Theme["bubble"]> = {};
      for (const k of Object.keys(input.bubble)) if (k !== "radius" && k !== "border") bad(`bubble.${k}`, "unknown key");
      const r = input.bubble.radius;
      if (r !== undefined) { if (!Number.isInteger(r) || (r as number) < 0 || (r as number) > 24) bad("bubble.radius", "a whole number of px, 0..24"); else b.radius = r as number; }
      const bd = input.bubble.border;
      if (bd !== undefined) { if (!(BORDERS as readonly unknown[]).includes(bd)) bad("bubble.border", "none, thin or accent"); else b.border = bd as typeof BORDERS[number]; }
      if (Object.keys(b).length) out.bubble = b;
    }
  }
  if (input.font !== undefined) {
    if (!(FONTS as readonly unknown[]).includes(input.font)) bad("font", "inter, system or mono"); else out.font = input.font as typeof FONTS[number];
  }
  if (input.background !== undefined) {
    const bg = input.background;
    if (!isObj(bg)) bad("background", "must be an object");
    else {
      for (const k of Object.keys(bg)) if (!["image", "fit", "opacity"].includes(k)) bad(`background.${k}`, "unknown key");
      const okImage = typeof bg.image === "string" && ASSET_ID.test(bg.image) && ctx.assets.has(bg.image);
      if (!okImage) bad("background.image", typeof bg.image === "string" && ASSET_ID.test(bg.image) ? "no such asset of this instance" : "an asset id");
      const okFit = (FITS as readonly unknown[]).includes(bg.fit);
      if (!okFit) bad("background.fit", "cover or contain");
      const op = bg.opacity;
      const okOp = typeof op === "number" && Number.isFinite(op) && op >= 0.05 && op <= 1;
      if (!okOp) bad("background.opacity", "a number 0.05..1");
      if (okImage && okFit && okOp) out.background = { image: bg.image as string, fit: bg.fit as typeof FITS[number], opacity: Math.round((op as number) * 20) / 20 };
    }
  }
  if (input.avatar !== undefined) {
    const a = input.avatar;
    if (typeof a !== "string" || !ASSET_ID.test(a)) bad("avatar", "an asset id");
    else if (!ctx.assets.has(a)) bad("avatar", "no such asset of this instance");
    else out.avatar = a;
  }
  if (input.workingLabel !== undefined) {
    const t = canonicalText(input.workingLabel, 1, 24);
    if (t === null) bad("workingLabel", "1..24 characters on one line, no control or direction characters"); else out.workingLabel = t;
  }
  if (input.card !== undefined) {
    const c = input.card;
    if (!isObj(c)) bad("card", "must be an object");
    else {
      const card: ThemeCard = {};
      for (const k of Object.keys(c)) if (!["portrait", "banner", "tagline", "bio", "bannerFocus"].includes(k)) bad(`card.${k}`, "unknown key");
      for (const slot of ["portrait", "banner"] as const) {
        const id = c[slot];
        if (id === undefined) continue;
        if (typeof id !== "string" || !ASSET_ID.test(id)) bad(`card.${slot}`, "an asset id");
        else if (!ctx.assets.has(id)) bad(`card.${slot}`, "no such asset of this instance");
        else if (ctx.slotOf && ctx.slotOf(id) !== slot) bad(`card.${slot}`, `a picture uploaded for the ${slot} slot`);
        else card[slot] = id;
      }
      if (c.tagline !== undefined) {
        const t = canonicalTagline(c.tagline);
        if (t === null) bad("card.tagline", `1..${TAGLINE_MAX_GRAPHEMES} characters on one line, no control or direction characters`); else card.tagline = t;
      }
      if (c.bio !== undefined) {
        const b = canonicalBio(c.bio);
        if (b === null) bad("card.bio", `1..${BIO_MAX_GRAPHEMES} characters, at most ${BIO_MAX_BREAKS} line breaks, no control or direction characters`); else card.bio = b;
      }
      if (c.bannerFocus !== undefined) {
        const f = c.bannerFocus;
        if (typeof f !== "number" || !Number.isInteger(f) || f < 0 || f > 100) bad("card.bannerFocus", "a whole number from 0 (top) to 100 (bottom)"); else card.bannerFocus = f;
      }
      if (Object.keys(card).length) out.card = card;
    }
  }
  if (input.identity !== undefined) {
    const id = input.identity;
    if (!isObj(id)) bad("identity", "must be an object");
    else {
      const identity: ThemeIdentity = {};
      for (const k of Object.keys(id)) if (k !== "color" && k !== "show") bad(`identity.${k}`, "unknown key");
      if (id.color !== undefined) {
        const c = canonicalIdentityColor(id.color);
        if (!c) bad("identity.color", "a preset (red, orange, amber, lime, green, teal, cyan, blue, indigo, violet, pink, slate) or a colour #rrggbb"); else identity.color = c;
      }
      if (id.show !== undefined) {
        const s = canonicalPlacements(id.show);
        if (!s) bad("identity.show", "a list of where the colour shows: name, bar, ring (each once; [] for nowhere)"); else identity.show = s;
      }
      if (Object.keys(identity).length) out.identity = identity;
    }
  }
  if (errors.length) return { ok: false, errors };

  for (const mode of MODES) {
    const pal = effectivePalette(out, mode);
    for (const [fg, bgKey, min] of CONTRAST_PAIRS) {
      const ratio = contrastRatio(pal[fg], pal[bgKey]);
      if (ratio + 1e-9 < min) bad(`colors.${mode}.${fg}`, `contrast ${fg} on ${bgKey} is ${ratio.toFixed(2)}:1, at least ${min}:1 is needed`);
    }
  }
  if (errors.length) return { ok: false, errors };
  const canonical = canonicalTheme(out);
  if (Buffer.byteLength(JSON.stringify(canonical), "utf8") > THEME_MAX_BYTES) return { ok: false, errors: [{ path: "", problem: `larger than ${THEME_MAX_BYTES} bytes` }] };
  return { ok: true, theme: canonical };
}

function sortPalette(p: Palette): Palette {
  const out: Palette = {};
  for (const k of PALETTE_KEYS) if (p[k] !== undefined) out[k] = p[k];
  return out;
}
/** One key order, so the stored, served and tool-returned JSON are the same bytes for the same theme. */
export function canonicalTheme(t: Theme): Theme {
  const out: Theme = { v: 1 };
  if (t.colors) { const c: NonNullable<Theme["colors"]> = {}; for (const m of MODES) if (t.colors[m]) c[m] = sortPalette(t.colors[m]!); out.colors = c; }
  if (t.accent) out.accent = t.accent;
  if (t.bubble) out.bubble = { ...(t.bubble.radius !== undefined ? { radius: t.bubble.radius } : {}), ...(t.bubble.border ? { border: t.bubble.border } : {}) };
  if (t.font) out.font = t.font;
  if (t.background) out.background = { image: t.background.image, fit: t.background.fit, opacity: t.background.opacity };
  if (t.avatar) out.avatar = t.avatar;
  if (t.workingLabel) out.workingLabel = t.workingLabel;
  if (t.card) {
    const c: ThemeCard = {};
    for (const k of ["portrait", "banner", "tagline", "bio"] as const) if (t.card[k]) c[k] = t.card[k];
    if (typeof t.card.bannerFocus === "number") c.bannerFocus = t.card.bannerFocus;      // #2086: 0 (the top) is a value
    if (Object.keys(c).length) out.card = c;
  }
  if (t.identity && (t.identity.color || t.identity.show)) {
    out.identity = { ...(t.identity.color ? { color: t.identity.color } : {}), ...(t.identity.show ? { show: [...t.identity.show] } : {}) };
  }
  return out;
}

/**
 * set_web_theme's patch on the current theme: `set` merges (objects by key, values replace), then `clear` removes
 * dotted paths ("colors.dark.bg", "bubble", …). The result is checked whole: all or nothing.
 */
export function applyThemePatch(current: Theme, patch: unknown, ctx: ThemeContext): { ok: true; theme: Theme } | { ok: false; errors: ThemeProblem[] } {
  if (!isObj(patch)) return { ok: false, errors: [{ path: "", problem: "a patch { set?, clear? }" }] };
  for (const k of Object.keys(patch)) if (k !== "set" && k !== "clear") return { ok: false, errors: [{ path: k, problem: "unknown key (set or clear)" }] };
  const next = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
  if (patch.set !== undefined) {
    if (!isObj(patch.set)) return { ok: false, errors: [{ path: "set", problem: "must be an object" }] };
    mergeInto(next, patch.set);
  }
  if (patch.clear !== undefined) {
    if (!Array.isArray(patch.clear) || patch.clear.length > 32 || !patch.clear.every(p => typeof p === "string" && /^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+){0,2}$/.test(p))) {
      return { ok: false, errors: [{ path: "clear", problem: "a list of dotted paths such as colors.dark.bg" }] };
    }
    for (const path of patch.clear as string[]) clearPath(next, path.split("."));
  }
  return checkTheme(next, ctx);
}
function mergeInto(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (Object.hasOwn(target, k) && isObj(v) && isObj(target[k])) { mergeInto(target[k] as Record<string, unknown>, v); continue; }
    // An own property, whatever the name ("__proto__" included): the closed-schema check then reports it, never a prototype.
    Object.defineProperty(target, k, { value: isObj(v) ? JSON.parse(JSON.stringify(v)) : v, enumerable: true, writable: true, configurable: true });
  }
}
function clearPath(target: Record<string, unknown>, parts: string[]): void {
  const [head, ...rest] = parts;
  if (!head || !Object.hasOwn(target, head)) return;
  if (!rest.length) { delete target[head]; return; }
  const child = target[head];
  if (!isObj(child)) return;
  clearPath(child, rest);
  if (!Object.keys(child).length) delete target[head];
}
