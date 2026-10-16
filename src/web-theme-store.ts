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
import { type AppearanceLimits, effectiveAppearanceLimits } from "./web-appearance-limits.js";
import { AGENT_WIDGET_SLOTS, type AgentWidgetSlot, checkWidgetData, checkWidgetSpec, type WidgetData, widgetId, type WidgetSpec } from "./web-widget.js";

export type AppearanceActor = "agent" | "human";
/** `params` (effects only): the effect's non-default params (CW1), checked against its manifest when placed. */
export interface Placement { id: string; by: AppearanceActor; at: number; params?: Record<string, unknown> }
/** r4-4 (option A): a widget is a declarative spec and its data (web-widget.ts); `id` is the spec's content hash. */
export interface WidgetPlacement extends Placement { spec: WidgetSpec; data: WidgetData }
export interface Placements { effects: Placement[]; widgets: { chat_header?: WidgetPlacement; details?: WidgetPlacement } }
import { THEME_ASSET_SLOTS, type ThemeAssetSlot } from "./web-asset-parts.js";
export { THEME_ASSET_SLOTS, type ThemeAssetSlot };
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

/** The theme's own picture slots (first design §4). The card's (portrait, banner) are `web.appearance`'s (r4.1 Q3 (b)). */
export const THEME_ASSET_LIMITS: Record<"background" | "avatar", { maxBytes: number; maxSide: number }> = {
  background: { maxBytes: 512 * 1024, maxSide: 4096 },
  avatar: { maxBytes: 256 * 1024, maxSide: 4096 },
};
/** Width, height and bytes a slot takes now. */
export function slotLimit(slot: ThemeAssetSlot, limits: AppearanceLimits): { maxWidth: number; maxHeight: number; maxBytes: number } {
  if (slot === "portrait" || slot === "banner") return limits[slot];
  const l = THEME_ASSET_LIMITS[slot];
  return { maxWidth: l.maxSide, maxHeight: l.maxSide, maxBytes: l.maxBytes };
}
const PICTURE_KINDS: ReadonlySet<MediaKind> = new Set(["png", "jpeg", "webp", "gif"]);
/** A card picture is a still: png, webp or jpeg (r4 §1). */
const CARD_KINDS: ReadonlySet<MediaKind> = new Set(["png", "jpeg", "webp"]);
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

/**
 * A picture for a slot, checked as an upload is (magic bytes, size and dimensions for its slot under `limits`) and with
 * its metadata stripped; its id is the hash of what is kept. Pure: the upload path and a mod bundle's check share it.
 */
export function prepareThemeAsset(slot: unknown, bytes: Uint8Array, limits: AppearanceLimits):
  { ok: true; slot: ThemeAssetSlot; kind: MediaKind; kept: Uint8Array; id: string } | { ok: false; status: 400 | 413; error: string; detail?: string } {
  if (!THEME_ASSET_SLOTS.includes(slot as ThemeAssetSlot)) return { ok: false, status: 400, error: "slot", detail: THEME_ASSET_SLOTS.join(", ") };
  const s = slot as ThemeAssetSlot;
  const card = s === "portrait" || s === "banner";
  const kind = sniffMedia(bytes);
  const kinds = card ? CARD_KINDS : PICTURE_KINDS;
  if (!kind || !kinds.has(kind)) return { ok: false, status: 400, error: "asset_type", detail: card ? "png, jpeg or webp" : "png, jpeg, webp or gif" };
  const lim = slotLimit(s, limits);
  if (bytes.length > lim.maxBytes) return { ok: false, status: 413, error: "asset_too_large", detail: `at most ${lim.maxBytes / 1024} KiB for ${s}` };
  const size = imageSize(bytes, kind);
  if (!size || size.width < 1 || size.height < 1) return { ok: false, status: 400, error: "asset_unreadable" };
  if (size.width > lim.maxWidth || size.height > lim.maxHeight) return { ok: false, status: 400, error: "asset_dimensions", detail: `at most ${lim.maxWidth}×${lim.maxHeight} px for ${s}` };
  const kept = stripMetadata(bytes, kind);
  if (!kept) return { ok: false, status: 400, error: "asset_unreadable" };
  return { ok: true, slot: s, kind, kept, id: hash32(kept) };
}

type State = { rev: number; records: Map<string, ThemeRecord> } | "unreadable";

export class ThemeStore {
  private state: State | null = null;
  readonly path: string;
  constructor(private readonly dataDir: string, private readonly opts: {
    now?: () => number; limits?: () => AppearanceLimits;
    /**
     * Effect ids no longer placed on an instance after a write that held (B2's library: collectUnreferenced, a guarded
     * collector that rechecks every reference before it deletes anything). Every write path reaches it: setPlacements,
     * applyLook and its undo, reset, forget.
     */
    effectsDropped?: (ids: string[]) => void;
  } = {}) {
    this.path = join(dataDir, "web-themes.json");
  }
  /** The limits in force now (`web.appearance`, clamped); checked at each upload, never against what is stored. */
  limits(): AppearanceLimits { return this.opts.limits?.() ?? effectiveAppearanceLimits(undefined).limits; }
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
        const assets = Array.isArray(r.assets) ? r.assets.filter(a => a && ASSET_ID.test(String(a.id)) && THEME_ASSET_SLOTS.includes(a.slot) && PICTURE_KINDS.has(a.kind) && Number.isSafeInteger(a.bytes)) : [];
        // A stored theme is checked again on load: one that no longer passes (a rule tightened) is the default.
        const checked = checkTheme(r.theme ?? { v: 1 }, { assets: new Set(assets.map(a => a.id)), slotOf: id => assets.find(a => a.id === id)?.slot });
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
    const before = state.records.get(name)?.placements.effects.map(e => e.id) ?? [];
    if (next) records.set(name, next); else records.delete(name);
    const rev = state.rev + 1;
    try { this.save(records, rev); } catch (err) { return { ok: false, status: 503, error: "themes_write_failed", detail: (err as Error).message }; }
    this.state = { rev, records };
    const after = new Set(next?.placements.effects.map(e => e.id) ?? []);
    const dropped = before.filter(id => !after.has(id));
    if (dropped.length && this.opts.effectsDropped) { try { this.opts.effectsDropped(dropped); } catch { /* the collector's own business */ } }
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

  /** The instances a person locked (the page's chat menu says Unlock for them). */
  lockedNames(): string[] {
    const s = this.load();
    return s === "unreadable" ? [] : [...s.records].filter(([, r]) => r.locked).map(([name]) => name);
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

  /**
   * A picture for the theme or its card: magic bytes, size and dimensions for its slot (the limits in force now),
   * metadata stripped, the instance's quota. An asset is its kept bytes and holds one slot: the same picture uploaded
   * again for that slot is the same id; for another slot, 409 (a card names only its own slot's pictures).
   */
  addAsset(name: string, slot: unknown, bytes: Uint8Array): StoreWrite<{ id: string }> {
    const limits = this.limits();
    const prepared = prepareThemeAsset(slot, bytes, limits);
    if (!prepared.ok) return prepared;
    const { slot: s, kind, kept, id } = prepared;
    const prev = this.get(name);
    const same = prev.assets.find(a => a.id === id);
    if (same) return same.slot === s ? { ok: true, rev: this.rev(), id } : { ok: false, status: 409, error: "asset_other_slot", detail: `this picture is already this instance's ${same.slot}` };
    const quota = limits.quota;
    if (prev.assets.length >= quota.files || prev.assets.reduce((n, a) => n + a.bytes, 0) + kept.length > quota.bytes) {
      return { ok: false, status: 409, error: "asset_quota", detail: `at most ${quota.files} files and ${quota.bytes / 1024 / 1024} MiB` };
    }
    try {
      mkdirSync(this.assetDir(name), { recursive: true, mode: 0o700 });
      writeBytesAtomic(join(this.assetDir(name), `${id}.${MEDIA_EXT[kind]}`), kept);
    } catch (err) { return { ok: false, status: 503, error: "asset_write_failed", detail: (err as Error).message }; }
    const next: ThemeRecord = { ...prev, assets: [...prev.assets, { id, slot: s, kind, bytes: kept.length }], updated: this.now() };
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
   * Where effects are placed (B2's apply/remove tools, a person's choices). Each entry is either an id — a placement
   * kept as it is (its `by`, `at` and params; a new id is placed plainly) — or `{ id, params? }`, an explicit apply that
   * always takes this call's `by` and `at` and its params (the effect's non-default overrides, already resolved), even
   * for an id already placed: so an agent re-applying a person's placement never keeps `by: "human"`. `validate` is
   * the caller's synchronous check of each (kind, scope, params), run before anything is written. Widgets have their
   * own calls below.
   */
  setPlacements(name: string, patch: { effects?: Array<string | { id: string; params?: Record<string, unknown> }> }, by: AppearanceActor,
    validate: (what: { kind: "effect"; id: string; params?: Record<string, unknown> }) => string | null): StoreWrite<{ placements: Placements }> {
    const prev = this.get(name);
    const placements = clone(prev.placements);
    const at = this.now();
    if (patch.effects !== undefined) {
      const list = Array.isArray(patch.effects) ? patch.effects : null;
      const idOf = (e: unknown) => (typeof e === "string" ? e : e && typeof e === "object" && !Array.isArray(e) ? (e as { id?: unknown }).id : undefined);
      if (!list || list.length > 2 || new Set(list.map(idOf)).size !== list.length) return { ok: false, status: 400, error: "effects", detail: "at most 2, no repeats" };
      const next: Placement[] = [];
      for (const e of list) {
        const id = idOf(e);
        const explicit = typeof e !== "string";
        const params = explicit ? (e as { params?: unknown }).params : undefined;
        const shapeOk = typeof id === "string" && ASSET_ID.test(id) && (!explicit || (Object.keys(e as object).every(k => k === "id" || k === "params")
          && (params === undefined || (!!params && typeof params === "object" && !Array.isArray(params)))));
        const p = shapeOk ? validate({ kind: "effect", id: id as string, ...(params ? { params: params as Record<string, unknown> } : {}) }) : "id";
        if (p) return { ok: false, status: 400, error: p, detail: String(id).slice(0, 40) };
        const kept = !explicit ? prev.placements.effects.find(x => x.id === id) : undefined;
        next.push(kept ?? { id: id as string, by, at, ...(params && Object.keys(params as object).length ? { params: clone(params as Record<string, unknown>) } : {}) });
      }
      placements.effects = next;
    }
    const w = this.commit(name, { ...prev, placements, by, updated: at });
    return w.ok ? { ...w, placements } : w;
  }

  /**
   * r4-4: place a widget (a spec and its data, both already checked — web-widget.ts) in one of the instance's own
   * slots, or replace it. `by` is who placed it; the same spec placed again keeps its first placement's `by` and `at`.
   */
  setWidget(name: string, slot: AgentWidgetSlot, spec: WidgetSpec, data: WidgetData, by: AppearanceActor): StoreWrite<{ widget: WidgetPlacement }> {
    const prev = this.get(name);
    const placements = clone(prev.placements);
    const at = this.now();
    const id = widgetId(spec);
    const had = prev.placements.widgets[slot];
    const widget: WidgetPlacement = had?.id === id ? { ...had, data: clone(data) } : { id, by, at, spec: clone(spec), data: clone(data) };
    placements.widgets[slot] = widget;
    const w = this.commit(name, { ...prev, placements, by, updated: at });
    return w.ok ? { ...w, widget: clone(widget) } : w;
  }
  /** r4-4: a placed widget's new data (checked against its spec by the caller); who placed it stays. */
  setWidgetData(name: string, slot: AgentWidgetSlot, data: WidgetData, by: AppearanceActor): StoreWrite<{ widget: WidgetPlacement }> {
    const prev = this.get(name);
    const had = prev.placements.widgets[slot];
    if (!had) return { ok: false, status: 404, error: "no_widget", detail: `nothing is placed in ${slot}` };
    const placements = clone(prev.placements);
    const widget: WidgetPlacement = { ...had, data: clone(data) };
    placements.widgets[slot] = widget;
    const w = this.commit(name, { ...prev, placements, by, updated: this.now() });
    return w.ok ? { ...w, widget: clone(widget) } : w;
  }
  /** r4-4: take widgets out of these slots (those placed nowhere are skipped); one write. */
  removeWidgets(name: string, slots: readonly AgentWidgetSlot[], by: AppearanceActor): StoreWrite<{ removed: AgentWidgetSlot[] }> {
    const prev = this.get(name);
    const removed = slots.filter(slot => prev.placements.widgets[slot]);
    if (!removed.length) return { ok: true, rev: this.rev(), removed };
    const placements = clone(prev.placements);
    for (const slot of removed) delete placements.widgets[slot];
    const w = this.commit(name, { ...prev, placements, by, updated: this.now() });
    return w.ok ? { ...w, removed } : w;
  }
  /**
   * Every instance's placed effects (B2's reference source for the effect library: an effect placed on an instance is
   * in use, holder "instance:<name>"). Empty when the file can't be read.
   */
  placedEffects(): Array<{ name: string; ids: string[] }> {
    const s = this.load();
    if (s === "unreadable") return [];
    return [...s.records].filter(([, r]) => r.placements.effects.length).map(([name, r]) => ({ name, ids: r.placements.effects.map(e => e.id) }));
  }
  /** Every instance's placed widgets, for the page (GET /ui/themes): `{ <name>: { <slot>: { spec, data, by } } }`. */
  widgets(): Record<string, Partial<Record<AgentWidgetSlot, { spec: WidgetSpec; data: WidgetData; by: AppearanceActor }>>> {
    const out: Record<string, Partial<Record<AgentWidgetSlot, { spec: WidgetSpec; data: WidgetData; by: AppearanceActor }>>> = Object.create(null);
    const s = this.load();
    if (s === "unreadable") return out;
    for (const [name, r] of s.records) {
      const slots: Partial<Record<AgentWidgetSlot, { spec: WidgetSpec; data: WidgetData; by: AppearanceActor }>> = {};
      for (const slot of AGENT_WIDGET_SLOTS) { const w = r.placements.widgets[slot]; if (w) slots[slot] = { spec: clone(w.spec), data: clone(w.data), by: w.by }; }
      if (Object.keys(slots).length) Object.defineProperty(out, name, { value: slots, enumerable: true });
    }
    return out;
  }

  /**
   * r4-5: a mod's look applied to one instance by a person, in ONE record write: its pictures (checked and stripped
   * already — web-mod-bundle.ts), the theme (replacing the look; the card's pictures stay), the identity's tagline and
   * bio (the card's agent-side text, which a person's own card fields still win over), widgets, and effect placements.
   * New picture files are written first; pictures the old look named and the new one does not are deleted only by
   * `finalize()`, once the whole import has succeeded — so `undo()` always puts back a complete record.
   */
  applyLook(name: string, look: {
    theme?: Theme; identity?: { tagline?: string; bio?: string };
    pictures: Array<{ slot: ThemeAssetSlot; id: string; kind: MediaKind; kept: Uint8Array }>;
    widgets?: Partial<Record<AgentWidgetSlot, { spec: WidgetSpec; data: WidgetData }>>;
    effects?: Array<{ id: string; params: Record<string, unknown> }>;
  }, by: AppearanceActor): StoreWrite<{ finalize: () => void; undo: () => StoreWrite }> {
    const s = this.load();
    if (s === "unreadable") return { ok: false, status: 503, error: "themes_unreadable" };
    const before = s.records.get(name);
    const prev = this.get(name);
    const at = this.now();
    // Pictures: an id this instance has for the same slot is reused; for another slot, refused (a picture holds one).
    const assets = [...prev.assets];
    const written: string[] = [];
    for (const p of look.pictures) {
      const same = assets.find(a => a.id === p.id);
      if (same) { if (same.slot !== p.slot) return { ok: false, status: 409, error: "asset_other_slot", detail: `${p.id} is already this instance's ${same.slot}` }; continue; }
      assets.push({ id: p.id, slot: p.slot, kind: p.kind, bytes: p.kept.length });
    }
    const card = look.identity || prev.theme.card ? { ...(prev.theme.card ?? {}), ...(look.identity ?? {}) } : undefined;
    const base: Theme = look.theme ? { ...look.theme } : { ...prev.theme };
    delete base.card;
    const theme: Theme = card && Object.keys(card).length ? { ...base, card } : base;
    const checked = checkTheme(theme, { assets: new Set(assets.map(a => a.id)), slotOf: id => assets.find(a => a.id === id)?.slot });
    if (!checked.ok) return { ok: false, status: 400, error: "theme", detail: `${checked.errors[0]!.path}: ${checked.errors[0]!.problem}` };
    // Only what the new look names (and any picture not named by the old look either: an upload still to be used) stays.
    const keep = referencedAssets(checked.theme), had = referencedAssets(prev.theme);
    const dropped = assets.filter(a => had.has(a.id) && !keep.has(a.id));
    const kept = assets.filter(a => !dropped.includes(a));
    const quota = this.limits().quota;
    if (kept.length > quota.files || kept.reduce((n, a) => n + a.bytes, 0) > quota.bytes) return { ok: false, status: 409, error: "asset_quota", detail: `at most ${quota.files} files and ${quota.bytes / 1024 / 1024} MiB` };
    const placements = clone(prev.placements);
    for (const [slot, w] of Object.entries(look.widgets ?? {}) as Array<[AgentWidgetSlot, { spec: WidgetSpec; data: WidgetData }]>) {
      placements.widgets[slot] = { id: widgetId(w.spec), by, at, spec: clone(w.spec), data: clone(w.data) };
    }
    if (look.effects) placements.effects = look.effects.slice(0, 2).map(e => ({ id: e.id, by, at, ...(Object.keys(e.params).length ? { params: clone(e.params) } : {}) }));
    const removeWritten = () => { for (const file of written) { try { unlinkSync(file); } catch { /* none */ } } };
    try {
      for (const p of look.pictures) {
        if (prev.assets.some(a => a.id === p.id)) continue;
        mkdirSync(this.assetDir(name), { recursive: true, mode: 0o700 });
        const file = join(this.assetDir(name), `${p.id}.${MEDIA_EXT[p.kind]}`);
        writeBytesAtomic(file, p.kept);
        written.push(file);
      }
    } catch (err) { removeWritten(); return { ok: false, status: 503, error: "asset_write_failed", detail: (err as Error).message }; }
    const w = this.commit(name, { ...prev, theme: checked.theme, assets: kept, placements, by, updated: at });
    if (!w.ok) { removeWritten(); return w; }
    const snapshot = before ? clone(before) : null;
    return {
      ...w,
      finalize: () => { for (const a of dropped) { try { unlinkSync(join(this.assetDir(name), `${a.id}.${MEDIA_EXT[a.kind]}`)); } catch { /* already gone */ } } },
      undo: () => { const u = this.commit(name, snapshot); if (u.ok) removeWritten(); return u; },
    };
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
  if (theme.card?.portrait) out.add(theme.card.portrait);
  if (theme.card?.banner) out.add(theme.card.banner);
  return out;
}
function sanePlacements(raw: unknown): Placements {
  const out = emptyPlacements();
  const r = raw as Partial<Placements> | undefined;
  const ok = (p: unknown): p is Placement => !!p && typeof p === "object" && ASSET_ID.test(String((p as Placement).id)) && ((p as Placement).by === "agent" || (p as Placement).by === "human") && Number.isFinite((p as Placement).at);
  if (r && Array.isArray(r.effects)) out.effects = r.effects.filter(ok).slice(0, 2).map(e => {
    const params = (e as Placement).params;
    return { id: e.id, by: e.by, at: e.at, ...(params && typeof params === "object" && !Array.isArray(params) ? { params } : {}) };
  });
  // A stored widget is checked again on load, spec and data: one that no longer passes (a rule tightened) is dropped.
  if (r && r.widgets && typeof r.widgets === "object") for (const slot of AGENT_WIDGET_SLOTS) {
    const w: unknown = r.widgets[slot];
    if (!ok(w)) continue;
    const { spec: rawSpec, data: rawData } = w as Partial<WidgetPlacement>;
    const spec = checkWidgetSpec(rawSpec, slot);
    const data = spec.ok ? checkWidgetData(rawData ?? {}, spec.value) : null;
    if (spec.ok && data?.ok && widgetId(spec.value) === w.id) out.widgets[slot] = { id: w.id, by: w.by, at: w.at, spec: spec.value, data: data.value };
  }
  return out;
}
