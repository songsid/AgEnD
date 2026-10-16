/**
 * #1958: an instance's identity colour — the cue people scan the sidebar by. One colour per instance, resolved in a
 * fixed order (docs/design/1958-identity-color.md):
 *
 *   1. person  — a person's pick from the web dashboard (this module's store: profiles.db `instance_color`), shared
 *                host-wide like the profile and the identity card;
 *   2. agent   — the agent's theme accent (#1629 theme.accent), only where the viewer shows agents' themes;
 *   3. role    — the own bot's colour from its highest coloured Discord role (today's ring; never a shared bot's);
 *   4. auto    — one of the palette's presets, chosen by a stable hash of the instance's name.
 *
 * A colour is stored and sent as `preset:<id>` (drawn with that preset's light or dark value, both readable on the
 * page's background) or `#rrggbb` (a custom colour, drawn as it is; name text uses a readable shade of it).
 * Its own table, never new columns on instance_profile or instance_card: "Clear card" leaves the colour alone, and an
 * older AgEnD reading profiles.db sees what it knew.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { canonicalColor, contrastRatio, THEME_DEFAULTS, type ThemeMode } from "./web-theme.js";

/** The sidebar's own background (src/ui/shared/tokens.css --bg-sidebar), where names are drawn as well as the page's. */
export const SIDEBAR_BG: Record<ThemeMode, string> = { light: "#f9f9f9", dark: "#171717" };

/** The palette: each preset's value on the light and on the dark page — at least 4.5:1 against the page and the sidebar. */
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
export type PresetId = (typeof IDENTITY_PALETTE)[number]["id"];
const PRESETS: ReadonlyMap<string, (typeof IDENTITY_PALETTE)[number]> = new Map(IDENTITY_PALETTE.map(p => [p.id, p]));
/** What the store and the status frame carry: a preset, or a custom colour. */
export type IdentityColor = `preset:${PresetId}` | `#${string}`;
export type IdentityColorSource = "person" | "agent" | "role" | "auto";

/**
 * A colour as a person or a request gives it — a preset's id ("blue", or "preset:blue") or a hex colour ("#abc",
 * "#aabbcc", any case) — in the form it is kept; null for anything else.
 */
export function canonicalIdentityColor(v: unknown): IdentityColor | null {
  if (typeof v !== "string") return null;
  const id = v.startsWith("preset:") ? v.slice("preset:".length) : v;
  if (PRESETS.has(id)) return `preset:${id as PresetId}`;
  return canonicalColor(v) as IdentityColor | null;
}

/** The colour drawn for `c` on a page in `mode`: a preset's value for that mode, a custom colour as it is. */
export function identityColorValue(c: IdentityColor, mode: ThemeMode): string {
  const p = c.startsWith("preset:") ? PRESETS.get(c.slice("preset:".length)) : undefined;
  return p ? p[mode] : c;
}

/**
 * The shade of `hex` that name text uses on a page in `mode`: the colour itself if it reads at 4.5:1 against the
 * page's and the sidebar's backgrounds, else the nearest step toward black (light page) or white (dark page) that does.
 */
export function readableShade(hex: string, mode: ThemeMode): string {
  const backgrounds = [THEME_DEFAULTS[mode].bg, SIDEBAR_BG[mode]];
  const base = canonicalColor(hex);
  if (!base) return THEME_DEFAULTS[mode].text;
  const toward = mode === "light" ? 0 : 255;
  const channels = [1, 3, 5].map(i => parseInt(base.slice(i, i + 2), 16));
  for (let step = 0; step <= 20; step++) {
    const mix = channels.map(c => Math.round(c + (toward - c) * (step / 20)));
    const shade = `#${mix.map(c => c.toString(16).padStart(2, "0")).join("")}`;
    if (backgrounds.every(bg => contrastRatio(shade, bg) >= 4.5)) return shade;
  }
  return THEME_DEFAULTS[mode].text;
}

/** The automatic colour: a preset chosen by the instance's name (32-bit FNV-1a), the same on every load. */
export function autoIdentityColor(name: string): IdentityColor {
  let h = 0x811c9dc5;
  for (const unit of new TextEncoder().encode(name)) { h ^= unit; h = Math.imul(h, 0x01000193) >>> 0; }
  return `preset:${IDENTITY_PALETTE[h % IDENTITY_PALETTE.length]!.id}`;
}

/** The tiers one instance has, as the status frame carries them (`auto` always). */
export interface IdentityColorTiers { person?: IdentityColor; agent?: string; role?: string; auto: IdentityColor }

/**
 * The colour in force and where it comes from. `showThemes`: whether the viewer shows agents' themes (fx.show, not
 * safe mode) — when not, the agent's tier is skipped, as the rest of the agent's theme is.
 */
export function resolveIdentityColor(t: IdentityColorTiers, opts: { showThemes: boolean }): { color: IdentityColor; source: IdentityColorSource } {
  if (t.person) return { color: t.person, source: "person" };
  const agent = opts.showThemes ? canonicalColor(t.agent) : null;
  if (agent) return { color: agent as IdentityColor, source: "agent" };
  const role = canonicalColor(t.role);
  if (role) return { color: role as IdentityColor, source: "role" };
  return { color: t.auto, source: "auto" };
}

export type ColorWrite = { ok: true } | { ok: false; status: 400 | 503; error: string; detail?: string };

const ready = new WeakSet<Database.Database>();
function table(db: Database.Database): Database.Database {
  if (!ready.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS instance_color (
      instance_name TEXT PRIMARY KEY,
      color TEXT NOT NULL,
      updated_at INTEGER
    );`);
    ready.add(db);
  }
  return db;
}

/** The people's picks, one per instance. */
export class IdentityColorStore {
  constructor(private readonly openDb: () => Database.Database, private readonly now: () => number = () => Date.now()) {}

  get(name: string): IdentityColor | null {
    const row = table(this.openDb()).prepare("SELECT color FROM instance_color WHERE instance_name = ?").get(name) as { color: string } | undefined;
    return row ? canonicalIdentityColor(row.color) : null;
  }
  /** Every pick, for a status read: only when profiles.db exists and has the table — a read creates nothing. */
  static all(dataDir: string, openDb: () => Database.Database): Map<string, IdentityColor> {
    if (!existsSync(join(dataDir, "profiles.db"))) return new Map();
    try {
      const db = openDb();
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'instance_color'").get()) return new Map();
      const out = new Map<string, IdentityColor>();
      for (const r of db.prepare("SELECT instance_name, color FROM instance_color").all() as Array<{ instance_name: string; color: string }>) {
        const c = canonicalIdentityColor(r.color);
        if (c) out.set(r.instance_name, c);                    // a row this version cannot read is no colour, not an error
      }
      return out;
    } catch { return new Map(); }
  }
  /** A person's pick (`null`, "" or spaces: Reset — the next tier shows again). Checked before anything is written. */
  set(name: string, value: unknown): ColorWrite {
    const clear = value === null || (typeof value === "string" && !value.trim());
    const color = clear ? null : canonicalIdentityColor(value);
    if (!clear && !color) return { ok: false, status: 400, error: "color", detail: `a preset (${IDENTITY_PALETTE.map(p => p.id).join(", ")}) or a hex colour #rrggbb` };
    try {
      const db = table(this.openDb());
      if (color) db.prepare(`INSERT INTO instance_color (instance_name, color, updated_at) VALUES (@n, @c, @t)
        ON CONFLICT(instance_name) DO UPDATE SET color = excluded.color, updated_at = excluded.updated_at`).run({ n: name, c: color, t: this.now() });
      else db.prepare("DELETE FROM instance_color WHERE instance_name = ?").run(name);
    } catch (err) { return { ok: false, status: 503, error: "color_write_failed", detail: (err as Error).message }; }
    return { ok: true };
  }
}
