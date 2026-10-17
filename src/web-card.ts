/**
 * #1629 r4 §1 / r4.1: an instance's identity card — a portrait, a banner, a tagline and a bio. The agent may set its
 * own (`theme.card`, web-theme.ts); a person sets theirs in View's Edit profile, and **the person's wins field by
 * field**. This module keeps the person's side and resolves the two.
 *
 *   profiles.db `instance_card`           (instance_name, tagline, bio, portrait, banner, updated_at)
 *   <dataDir>/cards/<hash>/<slot>-<id>.<ext>   the person's pictures, metadata stripped, id = sha of the kept bytes
 *
 * Its own table (never new columns on instance_profile), so an older AgEnD reading profiles.db sees what it knew.
 * A picture row names the file it owns; only that file is ever deleted (ownership is evidence, not a name pattern).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { type AppearanceLimits } from "./web-appearance-limits.js";
import { imageSize, MEDIA_EXT, MEDIA_MIME, type MediaKind, sniffMedia, stripMetadata } from "./web-image-meta.js";
import { canonicalBio, canonicalTagline, TAGLINE_MAX_GRAPHEMES, BIO_MAX_GRAPHEMES, BIO_MAX_BREAKS, type ThemeCard } from "./web-theme.js";

export type CardSlot = "portrait" | "banner";
export const CARD_SLOTS: readonly CardSlot[] = ["portrait", "banner"];
export interface HumanCard { tagline: string | null; bio: string | null; portrait: string | null; banner: string | null; updated_at: number }
export type CardWrite = { ok: true; id?: string } | { ok: false; status: 400 | 413 | 503; error: string; detail?: string };

const CARD_KINDS: ReadonlySet<MediaKind> = new Set(["png", "jpeg", "webp"]);
/** A stored picture's file name: `<slot>-<32 hex>.<ext>` — the id is the part after the slot. */
const FILE = /^(portrait|banner)-([0-9a-f]{32})\.(png|jpg|webp)$/;
const EXT_KIND: Record<string, MediaKind> = { png: "png", jpg: "jpeg", webp: "webp" };
const hash32 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 32);

const ready = new WeakSet<Database.Database>();
function table(db: Database.Database): Database.Database {
  if (!ready.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS instance_card (
      instance_name TEXT PRIMARY KEY,
      tagline TEXT,
      bio TEXT,
      portrait TEXT,
      banner TEXT,
      updated_at INTEGER
    );`);
    // Prism #2003 P2-2: ready only when made outside a transaction — a rollback takes the table away, never the mark.
    if (!db.inTransaction) ready.add(db);
  }
  return db;
}
const EMPTY: HumanCard = { tagline: null, bio: null, portrait: null, banner: null, updated_at: 0 };

export class HumanCardStore {
  constructor(private readonly dataDir: string, private readonly openDb: () => Database.Database, private readonly now: () => number = () => Date.now()) {}
  private dir(name: string): string { return join(this.dataDir, "cards", hash32(`instance\0${name}`)); }

  get(name: string): HumanCard {
    const row = table(this.openDb()).prepare("SELECT tagline, bio, portrait, banner, updated_at FROM instance_card WHERE instance_name = ?").get(name) as HumanCard | undefined;
    return row ? { ...EMPTY, ...row } : { ...EMPTY };
  }
  /** Every person-set card, for a status read: only when profiles.db exists and has the table — a read creates nothing. */
  static all(dataDir: string, openDb: () => Database.Database): Map<string, HumanCard> {
    if (!existsSync(join(dataDir, "profiles.db"))) return new Map();
    try {
      const db = openDb();
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'instance_card'").get()) return new Map();
      const rows = db.prepare("SELECT instance_name, tagline, bio, portrait, banner, updated_at FROM instance_card").all() as Array<HumanCard & { instance_name: string }>;
      return new Map(rows.map(r => [r.instance_name, { tagline: r.tagline, bio: r.bio, portrait: r.portrait, banner: r.banner, updated_at: r.updated_at }]));
    } catch { return new Map(); }
  }

  /**
   * The tagline and bio from Edit profile: only the fields given change; "" (or spaces) or null clears one. Checked
   * with the agent's rules (one line of 1..60, a bio of 1..280 with at most 3 line breaks; no control or direction
   * characters), so a person's card draws exactly like an agent's.
   */
  setText(name: string, patch: { tagline?: unknown; bio?: unknown }): CardWrite {
    const set: Array<["tagline" | "bio", string | null]> = [];
    if (patch.tagline !== undefined) {
      const v = patch.tagline;
      if (v === null || (typeof v === "string" && !v.trim())) set.push(["tagline", null]);
      else { const t = canonicalTagline(v); if (t === null) return { ok: false, status: 400, error: "card_tagline", detail: `1..${TAGLINE_MAX_GRAPHEMES} characters on one line, no control or direction characters` }; set.push(["tagline", t]); }
    }
    if (patch.bio !== undefined) {
      const v = patch.bio;
      if (v === null || (typeof v === "string" && !v.trim())) set.push(["bio", null]);
      else { const b = canonicalBio(typeof v === "string" ? v.replace(/\r\n?/g, "\n") : v); if (b === null) return { ok: false, status: 400, error: "card_bio", detail: `1..${BIO_MAX_GRAPHEMES} characters, at most ${BIO_MAX_BREAKS} line breaks, no control or direction characters` }; set.push(["bio", b]); }
    }
    if (!set.length) return { ok: true };
    const cols = set.map(([k]) => k);
    try {
      // Column names come only from the fixed list above.
      table(this.openDb()).prepare(`INSERT INTO instance_card (instance_name, ${cols.join(", ")}, updated_at)
        VALUES (@n, ${cols.map(c => `@${c}`).join(", ")}, @t)
        ON CONFLICT(instance_name) DO UPDATE SET ${cols.map(c => `${c} = excluded.${c}`).join(", ")}, updated_at = excluded.updated_at`)
        .run({ n: name, t: this.now(), ...Object.fromEntries(set) });
    } catch (err) { return { ok: false, status: 503, error: "card_write_failed", detail: (err as Error).message }; }
    return { ok: true };
  }

  /** A person's portrait or banner: png, jpeg or webp within the limits in force, metadata stripped. Replaces theirs. */
  setPicture(name: string, slot: CardSlot, bytes: Uint8Array, limits: AppearanceLimits): CardWrite {
    const lim = limits[slot];
    if (bytes.length > lim.maxBytes) return { ok: false, status: 413, error: "card_too_large", detail: `at most ${lim.maxBytes / 1024} KiB for the ${slot}` };
    const kind = sniffMedia(bytes);
    if (!kind || !CARD_KINDS.has(kind)) return { ok: false, status: 400, error: "card_type", detail: "png, jpeg or webp" };
    const size = imageSize(bytes, kind);
    if (!size || size.width < 1 || size.height < 1) return { ok: false, status: 400, error: "card_unreadable" };
    if (size.width > lim.maxWidth || size.height > lim.maxHeight) return { ok: false, status: 400, error: "card_dimensions", detail: `at most ${lim.maxWidth}×${lim.maxHeight} px for the ${slot}` };
    const kept = stripMetadata(bytes, kind);
    if (!kept) return { ok: false, status: 400, error: "card_unreadable" };
    const id = hash32(kept);
    const file = `${slot}-${id}.${MEDIA_EXT[kind]}`;
    const prior = this.get(name)[slot];
    try {
      mkdirSync(this.dir(name), { recursive: true, mode: 0o700 });
      const tmp = join(this.dir(name), `.${file}.${process.pid}.tmp`);
      writeFileSync(tmp, kept, { mode: 0o600 });
      renameSync(tmp, join(this.dir(name), file));
      table(this.openDb()).prepare(`INSERT INTO instance_card (instance_name, ${slot}, updated_at) VALUES (@n, @f, @t)
        ON CONFLICT(instance_name) DO UPDATE SET ${slot} = @f, updated_at = @t`).run({ n: name, f: file, t: this.now() });
    } catch (err) { return { ok: false, status: 503, error: "card_write_failed", detail: (err as Error).message }; }
    if (prior && prior !== file) this.unlinkOwned(name, prior);
    return { ok: true, id };
  }
  /** Remove the person's portrait or banner (the agent's shows again, if it has one). */
  removePicture(name: string, slot: CardSlot): { ok: true; removed: boolean } | { ok: false; status: 503; error: string } {
    const prior = this.get(name)[slot];
    if (!prior) return { ok: true, removed: false };
    try { table(this.openDb()).prepare(`UPDATE instance_card SET ${slot} = NULL, updated_at = ? WHERE instance_name = ?`).run(this.now(), name); }
    catch (err) { return { ok: false, status: 503, error: (err as Error).message }; }
    this.unlinkOwned(name, prior);
    return { ok: true, removed: true };
  }
  /** "Clear card": every field the person set goes; the agent's card (theme.card) is not touched. */
  clear(name: string): { ok: true } | { ok: false; status: 503; error: string } {
    const prior = this.get(name);
    try { table(this.openDb()).prepare("DELETE FROM instance_card WHERE instance_name = ?").run(name); }
    catch (err) { return { ok: false, status: 503, error: (err as Error).message }; }
    for (const slot of CARD_SLOTS) if (prior[slot]) this.unlinkOwned(name, prior[slot]!);
    return { ok: true };
  }
  /** The person's stored picture for `slot`, if any. */
  picture(name: string, slot: CardSlot): { id: string; bytes: Buffer; mime: string } | null {
    const file = this.get(name)[slot];
    const m = file ? FILE.exec(file) : null;
    if (!m || m[1] !== slot) return null;
    try { return { id: m[2]!, bytes: readFileSync(join(this.dir(name), file!)), mime: MEDIA_MIME[EXT_KIND[m[3]!]!] }; } catch { return null; }
  }
  private unlinkOwned(name: string, file: string): void {
    if (!FILE.test(file)) return;
    try { unlinkSync(join(this.dir(name), file)); } catch { /* already gone */ }
  }
}

/** One card field as drawn, and whose it is. */
export interface ResolvedCard {
  portrait?: { id: string; by: "human" | "agent"; src: string };
  banner?: { id: string; by: "human" | "agent"; src: string };
  tagline?: { text: string; by: "human" | "agent" };
  bio?: { text: string; by: "human" | "agent" };
}
/** The id a stored picture file name carries. */
export function cardFileId(file: string | null): string | null {
  const m = file ? FILE.exec(file) : null;
  return m ? m[2]! : null;
}
/**
 * Field by field: the person's if set, else the agent's (r4 §1). Picture URLs are one same-origin path per slot
 * (/api/card/<name>/<slot>), versioned by the id drawn, so the anonymous View reader loads them like the profile's.
 */
export function resolveCard(name: string, human: HumanCard | undefined, agent: ThemeCard | undefined): ResolvedCard {
  const out: ResolvedCard = {};
  const base = `/api/card/${encodeURIComponent(name)}`;
  for (const slot of CARD_SLOTS) {
    const hid = cardFileId(human?.[slot] ?? null);
    const id = hid ?? agent?.[slot] ?? null;
    if (id) out[slot] = { id, by: hid ? "human" : "agent", src: `${base}/${slot}?v=${id}` };
  }
  if (human?.tagline) out.tagline = { text: human.tagline, by: "human" }; else if (agent?.tagline) out.tagline = { text: agent.tagline, by: "agent" };
  if (human?.bio) out.bio = { text: human.bio, by: "human" }; else if (agent?.bio) out.bio = { text: agent.bio, by: "agent" };
  return out;
}
/** A short version of what is drawn (the status frame's card_v): the page reads the card again when it moves. */
export function cardVersion(card: ResolvedCard): string | null {
  if (!Object.keys(card).length) return null;
  return hash32(JSON.stringify([card.portrait?.id, card.portrait?.by, card.banner?.id, card.banner?.by, card.tagline?.text, card.tagline?.by, card.bio?.text, card.bio?.by])).slice(0, 12);
}
