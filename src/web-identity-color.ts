/**
 * #1958: an instance's identity colour — the cue people scan the sidebar by — and where it shows (its placements: the
 * name, a bar at the row's left edge, the avatar's ring). docs/design/1958-identity-color.md has the decisions.
 *
 * The colour, in a fixed order:
 *   1. person  — a person's pick from the web dashboard (this module's store), shared host-wide like the profile and
 *                the identity card;
 *   2. agent   — the agent's own (#1629 theme.identity.color, else its theme accent), only where the viewer shows
 *                agents' themes;
 *   3. role    — the own bot's colour from its highest coloured Discord role (never a shared bot's);
 *   4. auto    — one of a few soft colours, chosen by a stable hash of the name (two instances may share one).
 * The placements, likewise: a person's choice for this instance > the agent's (theme.identity.show, while themes are
 * shown) > the host's default (web prefs `color.show`, else ring + bar). The host may turn colours off altogether
 * (`color.off`): nothing is drawn, and every pick is kept for when they come back.
 *
 * A colour is kept and sent as `preset:<id>`, `auto:<id>` (both drawn with their light or dark value, readable on the
 * page's background) or `#rrggbb` (a custom colour, drawn as it is; name text uses a readable shade of it).
 * Its own table (instance_identity), never new columns on instance_profile or instance_card: "Clear card" leaves the
 * colour alone, and an older AgEnD reading profiles.db sees what it knew.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { canonicalColor, contrastRatio, THEME_DEFAULTS, type ThemeMode } from "./web-theme.js";
import { canonicalIdentityColor, canonicalPlacements, DEFAULT_PLACEMENTS, type IdentityColor, type Placement } from "./web-identity-palette.js";

export { AUTO_PALETTE, autoIdentityColor, canonicalIdentityColor, canonicalPlacements, DEFAULT_PLACEMENTS, IDENTITY_PALETTE, identityColorValue, PLACEMENTS,
  type AutoId, type IdentityColor, type Placement, type PresetId } from "./web-identity-palette.js";

/** The sidebar's own background (src/ui/shared/tokens.css --bg-sidebar), where names are drawn as well as the page's. */
export const SIDEBAR_BG: Record<ThemeMode, string> = { light: "#f9f9f9", dark: "#171717" };
export type IdentityColorSource = "person" | "agent" | "role" | "auto";
export type PlacementSource = "person" | "agent" | "host";

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

/** The tiers one instance has, as the status frame carries them (`auto` always). */
export interface IdentityColorTiers { person?: IdentityColor; agent?: string; role?: string; auto: IdentityColor }
/** The placement tiers one instance has (the host's default is the viewer's prefs, not the instance's). */
export interface PlacementTiers { person?: Placement[]; agent?: Placement[] }

/**
 * The colour in force and where it comes from. `showThemes`: whether the viewer shows agents' themes (fx.show, not
 * safe mode) — when not, the agent's tier is skipped, as the rest of the agent's theme is.
 */
export function resolveIdentityColor(t: IdentityColorTiers, opts: { showThemes: boolean }): { color: IdentityColor; source: IdentityColorSource } {
  if (t.person) return { color: t.person, source: "person" };
  const agent = opts.showThemes ? canonicalIdentityColor(t.agent) : null;
  if (agent) return { color: agent, source: "agent" };
  const role = canonicalColor(t.role);
  if (role) return { color: role as IdentityColor, source: "role" };
  return { color: t.auto, source: "auto" };
}
/** Where the colour shows: a person's choice, else the agent's (themes shown), else the host's default, else ring + bar. */
export function resolvePlacements(t: PlacementTiers, opts: { showThemes: boolean; hostDefault?: unknown }): { show: Placement[]; source: PlacementSource } {
  const person = canonicalPlacements(t.person);
  if (person) return { show: person, source: "person" };
  const agent = opts.showThemes ? canonicalPlacements(t.agent) : null;
  if (agent) return { show: agent, source: "agent" };
  return { show: canonicalPlacements(opts.hostDefault) ?? [...DEFAULT_PLACEMENTS], source: "host" };
}

/** A person's choice for one instance: a colour, the places it shows, or both (null: not chosen — the next tier). */
export interface PersonIdentity { color: IdentityColor | null; show: Placement[] | null }
export type ColorWrite = { ok: true } | { ok: false; status: 400 | 503; error: string; detail?: string };

const ready = new WeakSet<Database.Database>();
function table(db: Database.Database): Database.Database {
  if (!ready.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS instance_identity (
      instance_name TEXT PRIMARY KEY,
      color TEXT,
      show TEXT,
      updated_at INTEGER
    );`);
    // The first cut of this table (instance_color, colour only, on feat/2.3-web-mod before 2.3 ships): its picks carry
    // over once, never over a newer choice. The old table is left as it is.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'instance_color'").get()) {
      db.exec("INSERT OR IGNORE INTO instance_identity (instance_name, color, show, updated_at) SELECT instance_name, color, NULL, updated_at FROM instance_color");
    }
    ready.add(db);
  }
  return db;
}
const parseShow = (raw: string | null): Placement[] | null => {
  if (raw === null) return null;
  try { return canonicalPlacements(JSON.parse(raw)); } catch { return null; }
};

/** The people's choices, one row per instance. */
export class IdentityColorStore {
  constructor(private readonly openDb: () => Database.Database, private readonly now: () => number = () => Date.now()) {}

  get(name: string): PersonIdentity {
    const row = table(this.openDb()).prepare("SELECT color, show FROM instance_identity WHERE instance_name = ?").get(name) as { color: string | null; show: string | null } | undefined;
    return { color: row?.color ? canonicalIdentityColor(row.color) : null, show: parseShow(row?.show ?? null) };
  }
  /** Every choice, for a status read: only when profiles.db exists and has the table — a read creates nothing. */
  static all(dataDir: string, openDb: () => Database.Database): Map<string, PersonIdentity> {
    if (!existsSync(join(dataDir, "profiles.db"))) return new Map();
    try {
      const db = openDb();
      const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      const out = new Map<string, PersonIdentity>();
      if (has("instance_identity")) {
        for (const r of db.prepare("SELECT instance_name, color, show FROM instance_identity").all() as Array<{ instance_name: string; color: string | null; show: string | null }>) {
          // A value this version cannot read is no choice, not an error.
          const p: PersonIdentity = { color: r.color ? canonicalIdentityColor(r.color) : null, show: parseShow(r.show) };
          if (p.color || p.show) out.set(r.instance_name, p);
        }
      } else if (has("instance_color")) {
        // Not migrated yet (nothing has written since): the first cut's picks read as they are.
        for (const r of db.prepare("SELECT instance_name, color FROM instance_color").all() as Array<{ instance_name: string; color: string }>) {
          const c = canonicalIdentityColor(r.color);
          if (c) out.set(r.instance_name, { color: c, show: null });
        }
      }
      return out;
    } catch { return new Map(); }
  }
  /**
   * A person's choice, field by field: only the fields given change; `null` (or "" for the colour) clears one — the next
   * tier shows again. Both checked before anything is written. A row with nothing left is removed.
   */
  set(name: string, patch: { color?: unknown; show?: unknown }): ColorWrite {
    const next = this.check(patch);
    if (!next.ok) return next;
    try {
      const db = table(this.openDb());
      const prev = this.get(name);
      const color = next.color === undefined ? prev.color : next.color;
      const show = next.show === undefined ? prev.show : next.show;
      if (color === null && show === null) db.prepare("DELETE FROM instance_identity WHERE instance_name = ?").run(name);
      else db.prepare(`INSERT INTO instance_identity (instance_name, color, show, updated_at) VALUES (@n, @c, @s, @t)
        ON CONFLICT(instance_name) DO UPDATE SET color = excluded.color, show = excluded.show, updated_at = excluded.updated_at`)
        .run({ n: name, c: color, s: show === null ? null : JSON.stringify(show), t: this.now() });
    } catch (err) { return { ok: false, status: 503, error: "color_write_failed", detail: (err as Error).message }; }
    return { ok: true };
  }
  /** The patch, checked: `undefined` for a field not given, `null` to clear it. Writes nothing. */
  check(patch: { color?: unknown; show?: unknown }): { ok: true; color?: IdentityColor | null; show?: Placement[] | null } | { ok: false; status: 400; error: string; detail: string } {
    const out: { ok: true; color?: IdentityColor | null; show?: Placement[] | null } = { ok: true };
    if (patch.color !== undefined) {
      const v = patch.color;
      if (v === null || (typeof v === "string" && !v.trim())) out.color = null;
      else { const c = canonicalIdentityColor(v); if (!c) return { ok: false, status: 400, error: "color", detail: "a preset id or a hex colour #rrggbb" }; out.color = c; }
    }
    if (patch.show !== undefined) {
      if (patch.show === null) out.show = null;
      else { const s = canonicalPlacements(patch.show); if (!s) return { ok: false, status: 400, error: "color_show", detail: "a list of where the colour shows: name, bar, ring (each once; [] for nowhere)" }; out.show = s; }
    }
    return out;
  }
}
