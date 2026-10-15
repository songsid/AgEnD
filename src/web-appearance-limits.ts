/**
 * #1629 r4.1 Q3 (b): the identity card's upload limits are fleet configuration (`web.appearance`), under hard bounds
 * no configuration passes. r4's numbers are the defaults. A value outside its bound is clamped and said so (the config
 * validator's warnings: `agend doctor`, the fleet log at startup, Settings); one out-of-range number never stops the
 * fleet. A limit applies to new uploads only: nothing stored is ever checked again or deleted because a limit moved.
 */

export interface CardPictureLimit { maxWidth: number; maxHeight: number; maxBytes: number }
export interface AppearanceLimits {
  portrait: CardPictureLimit;
  banner: CardPictureLimit;
  /** Card and theme pictures an instance's agent may hold (r1 §4, r4 §1). */
  quota: { files: number; bytes: number };
}
export interface AppearanceLimitsConfig {
  portrait?: { max_width?: number; max_height?: number; max_kib?: number };
  banner?: { max_width?: number; max_height?: number; max_kib?: number };
  instance_quota?: { files?: number; mib?: number };
}

const KIB = 1024, MIB = 1024 * 1024;
/** r4 §1's numbers, in `web.appearance`'s own units. */
export const APPEARANCE_DEFAULTS = {
  portrait: { max_width: 1024, max_height: 1536, max_kib: 1536 },
  banner: { max_width: 1600, max_height: 600, max_kib: 768 },
  instance_quota: { files: 8, mib: 4 },
} as const;
/** [floor, ceiling] per setting (r4.1 Q3 (b)). */
export const APPEARANCE_BOUNDS = {
  portrait: { max_width: [64, 2048], max_height: [64, 3072], max_kib: [32, 4096] },
  banner: { max_width: [64, 3200], max_height: [64, 1200], max_kib: [32, 2048] },
  instance_quota: { files: [2, 16], mib: [1, 16] },
} as const satisfies Record<string, Record<string, readonly [number, number]>>;

export interface LimitWarning { path: string; message: string }

/**
 * The limits in force for `config` (the fleet's `web.appearance`, possibly absent or malformed), and why any value
 * differs from what was written. Unknown keys and wrong types are warned about and their defaults used.
 */
export function effectiveAppearanceLimits(config: unknown): { limits: AppearanceLimits; warnings: LimitWarning[] } {
  const warnings: LimitWarning[] = [];
  const root = isObj(config) ? config : {};
  if (config !== undefined && config !== null && !isObj(config)) warnings.push({ path: "web.appearance", message: "must be a mapping — the defaults are used" });
  for (const k of Object.keys(root)) if (!Object.hasOwn(APPEARANCE_DEFAULTS, k)) warnings.push({ path: `web.appearance.${k}`, message: `unknown key (known: ${Object.keys(APPEARANCE_DEFAULTS).join(", ")}) — ignored` });
  const read = <G extends keyof typeof APPEARANCE_DEFAULTS>(group: G): Record<keyof typeof APPEARANCE_DEFAULTS[G], number> => {
    const defaults = APPEARANCE_DEFAULTS[group] as Record<string, number>;
    const bounds = APPEARANCE_BOUNDS[group] as Record<string, readonly [number, number]>;
    const raw = Object.hasOwn(root, group) ? (root as Record<string, unknown>)[group] : undefined;
    const given = isObj(raw) ? raw : {};
    if (raw !== undefined && !isObj(raw)) warnings.push({ path: `web.appearance.${group}`, message: "must be a mapping — the defaults are used" });
    for (const k of Object.keys(given)) if (!Object.hasOwn(defaults, k)) warnings.push({ path: `web.appearance.${group}.${k}`, message: `unknown key (known: ${Object.keys(defaults).join(", ")}) — ignored` });
    const out: Record<string, number> = {};
    for (const [k, def] of Object.entries(defaults)) {
      const path = `web.appearance.${group}.${k}`;
      const v = Object.hasOwn(given, k) ? given[k] : undefined;
      if (v === undefined) { out[k] = def; continue; }
      if (typeof v !== "number" || !Number.isInteger(v)) { warnings.push({ path, message: `must be a whole number — the default ${def} is used` }); out[k] = def; continue; }
      const [floor, ceiling] = bounds[k]!;
      if (v < floor) { warnings.push({ path, message: `${v} is below the floor ${floor} — ${floor} is used` }); out[k] = floor; continue; }
      if (v > ceiling) { warnings.push({ path, message: `${v} is above the ceiling ${ceiling} — ${ceiling} is used` }); out[k] = ceiling; continue; }
      out[k] = v;
    }
    return out as Record<keyof typeof APPEARANCE_DEFAULTS[G], number>;
  };
  const p = read("portrait"), b = read("banner"), q = read("instance_quota");
  return {
    limits: {
      portrait: { maxWidth: p.max_width, maxHeight: p.max_height, maxBytes: p.max_kib * KIB },
      banner: { maxWidth: b.max_width, maxHeight: b.max_height, maxBytes: b.max_kib * KIB },
      quota: { files: q.files, bytes: q.mib * MIB },
    },
    warnings,
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
