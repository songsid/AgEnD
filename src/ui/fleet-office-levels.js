// #2661: the Office levels on the page — what the host serves (GET /ui/office-levels, src/office-levels.ts: the level from
// each instance's lifetime work, and where the viewer may see them, the numbers behind it) put into words and colours:
// the tier a level is in, its title (the page's generic ones, or a skin pack's `levels.titles`), a title a pack pins on
// someone (`levels.fixed`, which may hide the number), the badge's text and the XP bar. Pure: no DOM, no fetch.
import { t, register } from "/assets/app-i18n.js";

register("olv", {
  en: { t0: "Novice", t1: "Apprentice", t2: "Adept", t3: "Expert", t4: "Master", t5: "Legend" },
  "zh-TW": { t0: "新手", t1: "學徒", t2: "熟手", t3: "專家", t4: "大師", t5: "傳奇" },
});

/** The tiers by the level each starts at: grey, green, blue, the filled blue, gold, red (#2661). */
export const TIER_FROM = [0, 10, 20, 35, 50, 100];
/** The tier (0–5) a level is in. */
export const tierOf = (level) => { let i = 0; while (i + 1 < TIER_FROM.length && level >= TIER_FROM[i + 1]) i++; return i; };

/**
 * A tier's badge colours from the dashboard's tokens (no palette of its own: the status tokens and their tints, as the
 * renderer reads them, readPal). { bg, fg, line }.
 */
export function tierColours(tier, pal) {
  switch (tier) {
    case 1: return { bg: pal.okBg, fg: pal.ok, line: pal.ok };
    case 2: return { bg: pal.accentDim, fg: pal.accent, line: pal.accent };
    case 3: return { bg: pal.accent, fg: pal.surface, line: pal.accent };
    case 4: return { bg: pal.warnBg, fg: pal.warn, line: pal.warn };
    case 5: return { bg: pal.dangerBg, fg: pal.danger, line: pal.danger };
    default: return { bg: pal.surface2, fg: pal.text2, line: pal.border };
  }
}

/** A level as the badge writes it: up to 999 whole, then 1.1k, 12k (never wider than four characters). */
export function badgeText(level) {
  if (level < 1000) return String(level);
  const k = level / 1000;
  return k < 10 ? `${Math.floor(k * 10) / 10}k` : `${Math.floor(k)}k`;
}

/** The title for a level: the pack's table (the last entry it has reached), else the page's tier name. */
export function titleOf(level, titles) {
  if (Array.isArray(titles) && titles.length) {
    let name = null;
    for (const e of titles) if (level >= e.from) name = e.name;
    if (name) return name;
  }
  return t(`olv.t${tierOf(level)}`);
}

/** What a pack pins on `name` (an instance or an NPC's id): { title, hideLevel } or null. */
export function fixedOf(name, levels) {
  const f = levels && levels.fixed;
  return f && Object.prototype.hasOwnProperty.call(f, name) ? f[name] : null;
}

/** Work tokens to reach a level (the host's curve: level = floor(√(work ÷ unit))). */
export const workFor = (level, unit) => level * level * unit;

/** The XP bar: { next, toNext, pct (0–1) } — the next level, the work it still needs, how far along this level is. */
export function xpOf(level, work, unit) {
  const from = workFor(level, unit), to = workFor(level + 1, unit);
  return { next: level + 1, toNext: Math.max(0, to - work), pct: to > from ? Math.min(1, Math.max(0, (work - from) / (to - from))) : 0 };
}

/** Tokens in short words: 950, 12.3K, 260M, 1.2B. */
export function tokens(n) {
  const v = Math.max(0, n);
  if (v < 1000) return String(Math.round(v));
  const [d, s] = v >= 1e9 ? [1e9, "B"] : v >= 1e6 ? [1e6, "M"] : [1e3, "K"];
  const x = v / d;
  return `${x < 100 ? Math.floor(x * 10) / 10 : Math.floor(x)}${s}`;
}

/**
 * What the host answered (GET /ui/office-levels), checked: { enabled, unit, detail, levels: name → entry } with every
 * entry's numbers sane (anything odd: no levels at all).
 */
export function levelsOk(v) {
  const none = { enabled: false, unit: 100000, detail: false, levels: new Map() };
  if (!v || typeof v !== "object" || v.enabled !== true || typeof v.levels !== "object" || !v.levels) return none;
  const unit = Number.isFinite(v.unit) && v.unit > 0 ? v.unit : 100000;
  const n = (x) => Number.isFinite(x) && x >= 0;
  const out = new Map();
  for (const [name, e] of Object.entries(v.levels)) {
    if (!e || !Number.isInteger(e.level) || e.level < 0) continue;
    const detail = v.detail === true && n(e.workTokens) && e.today && n(e.today.workTokens) && n(e.today.requests);
    out.set(name, detail
      ? { level: e.level, workTokens: e.workTokens, estimated: e.estimated === true, today: { workTokens: e.today.workTokens, requests: e.today.requests },
        firstSeen: typeof e.firstSeen === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.firstSeen) ? e.firstSeen : null }
      : { level: e.level });
  }
  return { enabled: true, unit, detail: v.detail === true, levels: out };
}

/**
 * The badge a person's name tag carries: { text, tier } — or { mark: true } for a pinned title that hides the level —
 * or null (levels off, or none for them).
 */
export function badgeOf(name, lv, levels) {
  if (!lv || !lv.enabled) return null;
  const fx = fixedOf(name, levels);
  if (fx && fx.hideLevel) return { mark: true, tier: 0 };
  const e = lv && lv.levels.get(name);
  if (!e) return null;
  return { text: badgeText(e.level), tier: tierOf(e.level) };
}
