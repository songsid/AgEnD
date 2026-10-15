/**
 * #1629 (first design §2, §4; r2 §8; r4 §1–2): where each instance's appearance lives — its theme (web-theme.ts), where
 * its effects and widgets are placed and by whom, the pictures its theme names, and whether a person locked it.
 *
 *   <dataDir>/web-themes.json            { version: 1, rev, instances: { <name>: ThemeRecord } }   (0600, atomic)
 *   <dataDir>/web-themes/<hash>/<id>.<ext>  the instance's assets, metadata stripped, id = sha of the kept bytes
 *
 * One file for every instance (a theme is the instance's, and every viewer sees the same one — not a person's #1665
 * bucket). An unreadable file means every chat shows the default and every write is refused (503), never overwritten.
 * Instance names are own keys of a null-prototype map: "__proto__" and "constructor" are names too. Memory changes
 * only once a write is on disk.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { imageSize, MEDIA_EXT, MEDIA_MIME, type MediaKind, sniffMedia, stripMetadata } from "./web-image-meta.js";
import { checkTheme, type Theme } from "./web-theme.js";

export type AppearanceActor = "agent" | "human";
export interface Placement { id: string; by: AppearanceActor; at: number }
export interface Placements { effects: Placement[]; widgets: { chat_header?: Placement; details?: Placement } }
export type ThemeAssetSlot = "background" | "avatar";
export interface ThemeAsset { id: string; slot: ThemeAssetSlot; kind: MediaKind; bytes: number }
export interface ThemeRecord {
  theme: Theme;
  placements: Placements;
  assets: ThemeAsset[];
  /** Who made the last change (an agent's tool, or a person's reset or lock). */
  by: AppearanceActor;
  updated: number;
  /** A person locked it: every agent write is refused until unlocked (r2 (a)). */
  locked: boolean;
}
export type StoreWrite<T = Record<never, never>> = ({ ok: true; rev: number } & T) | { ok: false; status: 400 | 404 | 409 | 413 | 503; error: string; detail?: string };

/** Per-slot limits (first design §4) and the per-instance quota (r4 §1: 8 files, 4 MiB; r4.1 makes it configurable). */
export const THEME_ASSET_LIMITS: Record<ThemeAssetSlot, { maxBytes: number; maxSide: number }> = {
  background: { maxBytes: 512 * 1024, maxSide: 4096 },
  avatar: { maxBytes: 256 * 1024, maxSide: 4096 },
};
export const THEME_ASSET_QUOTA = { files: 8, bytes: 4 * 1024 * 1024 } as const;
const PICTURE_KINDS: ReadonlySet<MediaKind> = new Set(["png", "jpeg", "webp", "gif"]);
const ASSET_ID = /^[0-9a-f]{32}$/;

const hash32 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 32);
const emptyPlacements = (): Placements => ({ effects: [], widgets: {} });
const emptyRecord = (now: number): ThemeRecord => ({ theme: { v: 1 }, placements: emptyPlacements(), assets: [], by: "agent", updated: now, locked: false });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function writeBytesAtomic(path: string, bytes: Uint8Array): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try { writeFileSync(tmp, bytes, { mode: 0o600 }); renameSync(tmp, path); }
  catch (err) { try { unlinkSync(tmp); } catch { /* none */ } throw err; }
}

type State = { rev: number; records: Map<string, ThemeRecord> } | "unreadable";

export class ThemeStore {
  private state: State | null = null;
  readonly path: string;
  constructor(private readonly dataDir: string, private readonly opts: { now?: () => number } = {}) {
    this.path = join(dataDir, "web-themes.json");
  }
  private now(): number { return (this.opts.now ?? Date.now)(); }
  private assetDir(name: string): string { return join(this.dataDir, "web-themes", hash32(`instance\0${name}`)); }

  private load(): State {
    if (this.state) return this.state;
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (err) { return (this.state = (err as NodeJS.ErrnoException).code === "ENOENT" ? { rev: 0, records: new Map() } : "unreadable"); }
    try {
      const doc = JSON.parse(text) as { version?: unknown; rev?: unknown; instances?: unknown };
      if (doc.version !== 1 || !Number.isSafeInteger(doc.rev) || typeof doc.instances !== "object" || doc.instances === null) return (this.state = "unreadable");
      const records = new Map<string, ThemeRecord>();
      for (const [name, raw] of Object.entries(doc.instances as Record<string, unknown>)) {
        const r = raw as Partial<ThemeRecord>;
        const assets = Array.isArray(r.assets) ? r.assets.filter(a => a && ASSET_ID.test(String(a.id)) && (a.slot === "background" || a.slot === "avatar") && PICTURE_KINDS.has(a.kind) && Number.isSafeInteger(a.bytes)) : [];
        // A stored theme is checked again on load: one that no longer passes (a rule tightened) is the default.
        const checked = checkTheme(r.theme ?? { v: 1 }, { assets: new Set(assets.map(a => a.id)) });
        records.set(name, {
          theme: checked.ok ? checked.theme : { v: 1 },
          placements: sanePlacements(r.placements),
          assets,
          by: r.by === "human" ? "human" : "agent",
          updated: Number.isFinite(r.updated) ? (r.updated as number) : 0,
          locked: r.locked === true,
        });
      }
      return (this.state = { rev: doc.rev as number, records });
    } catch { return (this.state = "unreadable"); }
  }
  private save(records: Map<string, ThemeRecord>, rev: number): void {
    const instances: Record<string, ThemeRecord> = Object.create(null);
    for (const [name, r] of records) Object.defineProperty(instances, name, { value: r, enumerable: true, writable: true, configurable: true });
    atomicWriteFileSync(this.path, JSON.stringify({ version: 1, rev, instances }, null, 2) + "\n", { mode: 0o600 });
  }
  /** Change one record; on disk first, then in memory. */
  private commit(name: string, next: ThemeRecord | null): StoreWrite {
    const state = this.load();
    if (state === "unreadable") return { ok: false, status: 503, error: "themes_unreadable" };
    const records = new Map(state.records);
    if (next) records.set(name, next); else records.delete(name);
    const rev = state.rev + 1;
    try { this.save(records, rev); } catch (err) { return { ok: false, status: 503, error: "themes_write_failed", detail: (err as Error).message }; }
    this.state = { rev, records };
    return { ok: true, rev };
  }

  rev(): number { const s = this.load(); return s === "unreadable" ? 0 : s.rev; }
  readable(): boolean { return this.load() !== "unreadable"; }
  /** One instance's record (a copy), or a fresh default one. */
  get(name: string): ThemeRecord {
    const s = this.load();
    const r = s === "unreadable" ? undefined : s.records.get(name);
    return r ? clone(r) : emptyRecord(0);
  }
  /** Every instance's theme, for the page (GET /ui/themes): only themes that set something. */
  themes(): Record<string, Theme> {
    const out: Record<string, Theme> = Object.create(null);
    const s = this.load();
    if (s === "unreadable") return out;
    for (const [name, r] of s.records) if (Object.keys(r.theme).length > 1) Object.defineProperty(out, name, { value: clone(r.theme), enumerable: true });
    return out;
  }

  /**
   * Replace an instance's theme (already checked, web-theme.ts). An asset the old theme named and the new one no
   * longer does is deleted once the change is on disk (first design §4); one uploaded but not named yet stays.
   */
  setTheme(name: string, theme: Theme, by: AppearanceActor): StoreWrite<{ theme: Theme }> {
    const prev = this.get(name);
    const keep = referencedAssets(theme), had = referencedAssets(prev.theme);
    const next: ThemeRecord = { ...prev, theme: clone(theme), by, updated: this.now() };
    const dropped = prev.assets.filter(a => had.has(a.id) && !keep.has(a.id));
    next.assets = prev.assets.filter(a => !dropped.includes(a));
    const w = this.commit(name, next);
    if (!w.ok) return w;
    for (const a of dropped) { try { unlinkSync(join(this.assetDir(name), `${a.id}.${MEDIA_EXT[a.kind]}`)); } catch { /* already gone */ } }
    return { ...w, theme: clone(theme) };
  }

  /** A picture for the theme: magic bytes, size and dimensions for its slot, metadata stripped, the instance's quota. */
  addAsset(name: string, slot: unknown, bytes: Uint8Array): StoreWrite<{ id: string }> {
    if (slot !== "background" && slot !== "avatar") return { ok: false, status: 400, error: "slot", detail: "background or avatar" };
    const kind = sniffMedia(bytes);
    if (!kind || !PICTURE_KINDS.has(kind)) return { ok: false, status: 400, error: "asset_type", detail: "png, jpeg, webp or gif" };
    const lim = THEME_ASSET_LIMITS[slot];
    if (bytes.length > lim.maxBytes) return { ok: false, status: 413, error: "asset_too_large", detail: `at most ${lim.maxBytes / 1024} KiB for ${slot}` };
    const size = imageSize(bytes, kind);
    if (!size || size.width < 1 || size.height < 1) return { ok: false, status: 400, error: "asset_unreadable" };
    if (size.width > lim.maxSide || size.height > lim.maxSide) return { ok: false, status: 400, error: "asset_dimensions", detail: `at most ${lim.maxSide} px a side` };
    const kept = stripMetadata(bytes, kind);
    if (!kept) return { ok: false, status: 400, error: "asset_unreadable" };
    const id = hash32(kept);
    const prev = this.get(name);
    if (prev.assets.some(a => a.id === id)) return { ok: true, rev: this.rev(), id };
    if (prev.assets.length >= THEME_ASSET_QUOTA.files || prev.assets.reduce((n, a) => n + a.bytes, 0) + kept.length > THEME_ASSET_QUOTA.bytes) {
      return { ok: false, status: 409, error: "asset_quota", detail: `at most ${THEME_ASSET_QUOTA.files} files and ${THEME_ASSET_QUOTA.bytes / 1024 / 1024} MiB` };
    }
    try {
      mkdirSync(this.assetDir(name), { recursive: true, mode: 0o700 });
      writeBytesAtomic(join(this.assetDir(name), `${id}.${MEDIA_EXT[kind]}`), kept);
    } catch (err) { return { ok: false, status: 503, error: "asset_write_failed", detail: (err as Error).message }; }
    const next: ThemeRecord = { ...prev, assets: [...prev.assets, { id, slot, kind, bytes: kept.length }], updated: this.now() };
    const w = this.commit(name, next);
    if (!w.ok) { try { unlinkSync(join(this.assetDir(name), `${id}.${MEDIA_EXT[kind]}`)); } catch { /* none */ } return w; }
    return { ...w, id };
  }
  asset(name: string, id: string): { bytes: Buffer; mime: string } | null {
    if (!ASSET_ID.test(id)) return null;
    const a = this.get(name).assets.find(x => x.id === id);
    if (!a) return null;
    try { return { bytes: readFileSync(join(this.assetDir(name), `${id}.${MEDIA_EXT[a.kind]}`)), mime: MEDIA_MIME[a.kind] }; } catch { return null; }
  }

  /**
   * Reset. The agent's own (reset_web_theme): its theme only. A person's: the theme, its placements and assets — the
   * lock stays (a reset is not an unlock).
   */
  reset(name: string, by: AppearanceActor): StoreWrite {
    const prev = this.get(name);
    if (by === "agent") return this.commit(name, { ...prev, theme: { v: 1 }, by, updated: this.now() });
    const w = this.commit(name, { ...emptyRecord(this.now()), by: "human", locked: prev.locked });
    if (w.ok) { try { rmSync(this.assetDir(name), { recursive: true, force: true }); } catch { /* best effort */ } }
    return w;
  }
  /** A person's lock (r2 (a)): agents' writes are refused while it is on. */
  setLocked(name: string, locked: boolean): StoreWrite {
    const prev = this.get(name);
    return this.commit(name, { ...prev, locked, by: "human", updated: this.now() });
  }

  /**
   * Where effects and widgets are placed (B2's apply/remove tools, r4's widget tools, a person's choices). `validate`
   * is the caller's synchronous check of each id (kind, scope, wanted events), run before anything is written.
   */
  setPlacements(name: string, patch: { effects?: string[]; widgets?: { chat_header?: string | null; details?: string | null } }, by: AppearanceActor,
    validate: (what: { kind: "effect" | "widget"; id: string; slot?: "chat_header" | "details" }) => string | null): StoreWrite<{ placements: Placements }> {
    const prev = this.get(name);
    const placements = clone(prev.placements);
    const at = this.now();
    if (patch.effects !== undefined) {
      if (!Array.isArray(patch.effects) || patch.effects.length > 2 || new Set(patch.effects).size !== patch.effects.length) return { ok: false, status: 400, error: "effects", detail: "at most 2, no repeats" };
      for (const id of patch.effects) { const p = typeof id === "string" && ASSET_ID.test(id) ? validate({ kind: "effect", id }) : "id"; if (p) return { ok: false, status: 400, error: p, detail: String(id).slice(0, 40) }; }
      placements.effects = patch.effects.map(id => prev.placements.effects.find(e => e.id === id) ?? { id, by, at });
    }
    if (patch.widgets !== undefined) {
      for (const slot of ["chat_header", "details"] as const) {
        if (!Object.hasOwn(patch.widgets, slot)) continue;
        const id = patch.widgets[slot];
        if (id === null) { delete placements.widgets[slot]; continue; }
        const p = typeof id === "string" && ASSET_ID.test(id) ? validate({ kind: "widget", id, slot }) : "id";
        if (p) return { ok: false, status: 400, error: p, detail: String(id).slice(0, 40) };
        placements.widgets[slot] = prev.placements.widgets[slot]?.id === id ? prev.placements.widgets[slot]! : { id: id!, by, at };
      }
    }
    const w = this.commit(name, { ...prev, placements, by, updated: at });
    return w.ok ? { ...w, placements } : w;
  }

  /** An instance was removed: its record and its pictures go. */
  forget(name: string): void {
    const s = this.load();
    if (s !== "unreadable" && s.records.has(name)) this.commit(name, null);
    try { rmSync(this.assetDir(name), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function referencedAssets(theme: Theme): Set<string> {
  const out = new Set<string>();
  if (theme.background) out.add(theme.background.image);
  if (theme.avatar) out.add(theme.avatar);
  return out;
}
function sanePlacements(raw: unknown): Placements {
  const out = emptyPlacements();
  const r = raw as Partial<Placements> | undefined;
  const ok = (p: unknown): p is Placement => !!p && typeof p === "object" && ASSET_ID.test(String((p as Placement).id)) && ((p as Placement).by === "agent" || (p as Placement).by === "human") && Number.isFinite((p as Placement).at);
  if (r && Array.isArray(r.effects)) out.effects = r.effects.filter(ok).slice(0, 2);
  if (r && r.widgets && typeof r.widgets === "object") for (const slot of ["chat_header", "details"] as const) if (ok(r.widgets[slot])) out.widgets[slot] = r.widgets[slot];
  return out;
}
