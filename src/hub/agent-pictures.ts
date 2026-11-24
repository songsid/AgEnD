/**
 * M-3533 R2b: the Hub's copy of shared agents' pictures (agent-pictures-model.ts). One stored file per content hash, kept only
 * while some published agent's latest report names it; a report replaces its Fleet's rows. Read only after the caller's own
 * authorization (a room member's, through the room service). Nothing here is served by itself.
 */
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readExposure } from "./catalog.js";
import { personKeyString } from "./identity.js";
import type { HubCore } from "./http/core.js";
import type { HubLinkContext } from "./server.js";
import { HubProtocolError, validated } from "./validation.js";
import {
  agentPictureChunkSchema, agentPicturesSchema, HUB_AGENT_PICTURES_CAPABILITY, HUB_PICTURE_CHUNK, sniffPicture,
  type HubAgentPictureResult, type HubAgentPicturesResult, type HubPictureMime, type HubPictureSlot,
} from "./agent-pictures-model.js";

export const HUB_AGENT_PICTURES_MIGRATION = Object.freeze({ component: "s3-agent-pictures", version: 1, up(db: Database.Database) {
  db.exec(`CREATE TABLE hub_agent_picture_files(sha256 TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL, stored_at INTEGER NOT NULL)`);
  // Each picture's declared type and size are kept with its hash: a file is stored, and shown, only when it is exactly that (Prism #4393).
  db.exec(`CREATE TABLE hub_agent_pictures(exposure_id TEXT PRIMARY KEY REFERENCES hub_exposures(id) ON DELETE CASCADE,
    fleet_id TEXT NOT NULL, generation INTEGER NOT NULL, disc TEXT, disc_mime TEXT, disc_size INTEGER, portrait TEXT, portrait_mime TEXT, portrait_size INTEGER,
    too_large TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)`);
} });

interface Row { exposure_id: string; fleet_id: string; generation: number; disc: string | null; disc_mime: string | null; disc_size: number | null;
  portrait: string | null; portrait_mime: string | null; portrait_size: number | null; too_large: string }
/** The row's picture in `slot` is held as declared: the stored file has that hash, type and size. */
const heldAs = (db: Database.Database, r: Row, slot: HubPictureSlot): boolean => {
  const [h, mime, size] = slot === "disc" ? [r.disc, r.disc_mime, r.disc_size] : [r.portrait, r.portrait_mime, r.portrait_size];
  return !!h && !!db.prepare("SELECT 1 FROM hub_agent_picture_files WHERE sha256=? AND mime=? AND length(bytes)=?").get(h, mime, size);
};
/** How long a retired row or file may outlive a revocation that sent no report (withdrawals sweep at once). */
export const HUB_PICTURES_SWEEP_MS = 60_000;
/** An agent's pictures as a room may show them: only pictures the Hub holds; `tooLarge` is for its owner alone. */
export interface HubAgentPictureLook { disc?: string; portrait?: string; tooLarge?: HubPictureSlot[] }
interface Assembly { sha256: string; mime: HubPictureMime; size: number; count: number; next: number; parts: Buffer[] }

const slotsOf = (s: string): HubPictureSlot[] => s.split(",").filter((x): x is HubPictureSlot => x === "disc" || x === "portrait");

export class HubAgentPictures {
  private readonly links = new Map<string, HubLinkContext>();
  private readonly assembling = new WeakMap<HubLinkContext, Assembly>();
  /** Called with the exposures whose shown pictures changed (rooms tell their open pages). */
  changed: ((exposureIds: string[]) => void) | null = null;
  constructor(private readonly core: HubCore) {}

  private fleetOf(link: HubLinkContext) {
    if (!link.current()) throw new HubProtocolError("stale");
    if (!link.features.has(HUB_AGENT_PICTURES_CAPABILITY)) throw new HubProtocolError("incompatible");
    const fleet = this.core.deps.store.read().fleets.find(f => f.id === link.fleetId);
    if (!fleet || fleet.status !== "active" || personKeyString(fleet.owner) !== personKeyString(link.owner)) throw new HubProtocolError("revoked");
    const known = this.links.get(fleet.id);
    if (known && known !== link && known.current()) throw new HubProtocolError("stale");
    return fleet;
  }
  private shown(db: Database.Database, rows: Row[]): Map<string, string> {
    return new Map(rows.map(r => [r.exposure_id, JSON.stringify([heldAs(db, r, "disc") ? r.disc : null, heldAs(db, r, "portrait") ? r.portrait : null, r.too_large])]));
  }
  /** Drop rows whose agent is no longer a published share of a current Fleet, then files no row names. */
  private sweep(db: Database.Database): void {
    const fleets = this.core.deps.store.read().fleets;
    for (const row of db.prepare("SELECT exposure_id,fleet_id,generation FROM hub_agent_pictures").all() as Row[]) {
      const f = fleets.find(x => x.id === row.fleet_id), e = readExposure(db, row.exposure_id);
      if (!f || f.status !== "active" || f.generation !== row.generation || !e || e.fleet_id !== row.fleet_id || e.state !== "published")
        db.prepare("DELETE FROM hub_agent_pictures WHERE exposure_id=?").run(row.exposure_id);
    }
    // A file lives only while some row names it as it is — its type and size (Prism #4393 R2): a reference that declares it
    // otherwise is never shown and keeps nothing alive, whatever order the reports and uploads came in.
    db.prepare(`DELETE FROM hub_agent_picture_files WHERE NOT EXISTS (SELECT 1 FROM hub_agent_pictures p WHERE
      (p.disc = hub_agent_picture_files.sha256 AND p.disc_mime = hub_agent_picture_files.mime AND p.disc_size = length(hub_agent_picture_files.bytes))
      OR (p.portrait = hub_agent_picture_files.sha256 AND p.portrait_mime = hub_agent_picture_files.mime AND p.portrait_size = length(hub_agent_picture_files.bytes)))`).run();
  }
  prune(): void { this.core.atomic(db => this.sweep(db)); }

  /** `agent.pictures`: this Fleet's agents and their pictures now; the answer names the hashes the Hub still needs. */
  report(value: unknown, link: HubLinkContext): HubAgentPicturesResult {
    const body = validated(agentPicturesSchema, value);
    let changed: string[] = [];
    const need = this.core.atomic(db => {
      const fleet = this.fleetOf(link);
      const before = db.prepare("SELECT * FROM hub_agent_pictures WHERE fleet_id=?").all(fleet.id) as Row[];
      const shownBefore = this.shown(db, before);
      db.prepare("DELETE FROM hub_agent_pictures WHERE fleet_id=?").run(fleet.id);
      for (const a of body.agents) {
        const e = readExposure(db, a.exposureId);
        // A row for an agent that is not this Fleet's published share is not an error (the report may cross a withdrawal): skipped.
        if (!e || e.fleet_id !== fleet.id || e.state !== "published" || e.owner !== personKeyString(fleet.owner)) continue;
        // Prism (#4393 R1): a hash fixes its bytes, so a picture held already with another type or size than this row declares
        // can never be this row's. It is not recorded: it keeps no file alive, and an agent never holds more than its cap.
        const fits = (ref: { sha256: string; mime: string; size: number } | null) => {
          if (!ref) return null;
          const held = db.prepare("SELECT mime, length(bytes) AS size FROM hub_agent_picture_files WHERE sha256=?").get(ref.sha256) as { mime: string; size: number } | undefined;
          return !held || (held.mime === ref.mime && held.size === ref.size) ? ref : null;
        };
        const disc = fits(a.disc), portrait = fits(a.portrait);
        db.prepare("INSERT INTO hub_agent_pictures VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(a.exposureId, fleet.id, fleet.generation,
          disc?.sha256 ?? null, disc?.mime ?? null, disc?.size ?? null, portrait?.sha256 ?? null, portrait?.mime ?? null, portrait?.size ?? null,
          (a.tooLarge ?? []).join(","), this.core.now());
      }
      this.sweep(db);
      const after = db.prepare("SELECT * FROM hub_agent_pictures WHERE fleet_id=?").all(fleet.id) as Row[];
      const shownAfter = this.shown(db, after);
      changed = [...new Set([...shownBefore.keys(), ...shownAfter.keys()])].filter(id => shownBefore.get(id) !== shownAfter.get(id));
      this.links.set(fleet.id, link);
      // A hash held already is not asked for again: its bytes are fixed, so a held file either is what a row declares or is
      // never shown for it.
      const want = new Set<string>();
      for (const r of after) for (const h of [r.disc, r.portrait]) if (h && !db.prepare("SELECT 1 FROM hub_agent_picture_files WHERE sha256=?").get(h)) want.add(h);
      return [...want];
    });
    this.assembling.delete(link);
    if (changed.length) this.notify(changed);
    return { ok: true, need };
  }

  /** `agent.picture`: one chunk of a picture this Fleet's report named and the Hub does not hold. */
  chunk(value: unknown, link: HubLinkContext): HubAgentPictureResult {
    const c = validated(agentPictureChunkSchema, value);
    const data = Buffer.from(c.data, "base64");
    if (data.length !== (c.index === c.count - 1 ? c.size - HUB_PICTURE_CHUNK * (c.count - 1) : HUB_PICTURE_CHUNK)) return { ok: false, code: "invalid" };
    const wanted = this.core.atomic(db => {
      const fleet = this.fleetOf(link);
      if (db.prepare("SELECT 1 FROM hub_agent_picture_files WHERE sha256=?").get(c.sha256)) return "held" as const;
      // Only a picture a row of this Fleet declares with exactly this type and size (the caps were checked on that row).
      return db.prepare(`SELECT 1 FROM hub_agent_pictures WHERE fleet_id=? AND ((disc=? AND disc_mime=? AND disc_size=?) OR (portrait=? AND portrait_mime=? AND portrait_size=?))`)
        .get(fleet.id, c.sha256, c.mime, c.size, c.sha256, c.mime, c.size) ? "wanted" as const : "no" as const;
    });
    if (wanted === "held") { this.assembling.delete(link); return { ok: true, stored: true }; }
    if (wanted === "no") { this.assembling.delete(link); return { ok: false, code: "not-wanted" }; }
    let a = this.assembling.get(link);
    if (c.index === 0) { a = { sha256: c.sha256, mime: c.mime, size: c.size, count: c.count, next: 0, parts: [] }; this.assembling.set(link, a); }
    if (!a || a.sha256 !== c.sha256 || a.mime !== c.mime || a.size !== c.size || a.count !== c.count || a.next !== c.index) { this.assembling.delete(link); return { ok: false, code: "invalid" }; }
    a.parts.push(data); a.next++;
    if (a.next < a.count) return { ok: true, stored: false };
    this.assembling.delete(link);
    const bytes = Buffer.concat(a.parts);
    if (bytes.length !== a.size || createHash("sha256").update(bytes).digest("hex") !== a.sha256 || sniffPicture(bytes) !== a.mime) return { ok: false, code: "invalid" };
    const exposures = this.core.atomic(db => {
      const fleet = this.fleetOf(link);
      const rows = db.prepare(`SELECT exposure_id FROM hub_agent_pictures WHERE fleet_id=? AND ((disc=? AND disc_mime=? AND disc_size=?) OR (portrait=? AND portrait_mime=? AND portrait_size=?))`)
        .all(fleet.id, a!.sha256, a!.mime, a!.size, a!.sha256, a!.mime, a!.size) as { exposure_id: string }[];
      if (!rows.length) return null;
      db.prepare("INSERT OR IGNORE INTO hub_agent_picture_files VALUES(?,?,?,?)").run(a!.sha256, a!.mime, bytes, this.core.now());
      // Every agent showing it now (another Fleet's agent may share the same picture).
      return (db.prepare("SELECT exposure_id FROM hub_agent_pictures WHERE disc=? OR portrait=?").all(a!.sha256, a!.sha256) as { exposure_id: string }[]).map(r => r.exposure_id);
    });
    if (!exposures) return { ok: false, code: "not-wanted" };
    this.notify(exposures);
    return { ok: true, stored: true };
  }

  private notify(ids: string[]): void { try { this.changed?.(ids); } catch { /* a room refresh is best effort */ } }

  /** A Fleet's published agents' pictures the Hub holds (exposure id → hashes). Call after the caller's authorization. */
  looksOf(fleetId: string): Map<string, HubAgentPictureLook> {
    return this.core.atomic(db => {
      const fleet = this.core.deps.store.read().fleets.find(f => f.id === fleetId);
      const out = new Map<string, HubAgentPictureLook>();
      if (!fleet || fleet.status !== "active") return out;
      for (const r of db.prepare("SELECT * FROM hub_agent_pictures WHERE fleet_id=? AND generation=?").all(fleetId, fleet.generation) as Row[]) {
        const e = readExposure(db, r.exposure_id);
        if (!e || e.fleet_id !== fleetId || e.state !== "published") continue;
        const tooLarge = slotsOf(r.too_large);
        out.set(r.exposure_id, { ...(heldAs(db, r, "disc") ? { disc: r.disc! } : {}), ...(heldAs(db, r, "portrait") ? { portrait: r.portrait! } : {}), ...(tooLarge.length ? { tooLarge } : {}) });
      }
      return out;
    });
  }
  /** A held picture's bytes. Call only after the caller's authorization names this hash. */
  file(sha256: string): { mime: HubPictureMime; bytes: Buffer } | null {
    return this.core.atomic(db => {
      const row = db.prepare("SELECT mime,bytes FROM hub_agent_picture_files WHERE sha256=?").get(sha256) as { mime: HubPictureMime; bytes: Buffer } | undefined;
      return row ? { mime: row.mime, bytes: Buffer.from(row.bytes) } : null;
    });
  }
  disconnected(fleetId: string): void { this.links.delete(fleetId); }
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Sweep retired rows and unnamed files every HUB_PICTURES_SWEEP_MS (a revoked Fleet sends no report); reads hide them at once. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.prune(); } catch { /* the next sweep */ } }, HUB_PICTURES_SWEEP_MS);
    this.timer.unref?.();
  }
  close(): void { this.links.clear(); if (this.timer) clearInterval(this.timer); this.timer = null; }
}
