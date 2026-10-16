/**
 * #1629 r4 §4 (option A): a mod bundle — one JSON file, `<name>-<version>.agendmod.json`, at most 8 MiB, that carries a
 * look: a theme (with its pictures), identity defaults (a card's tagline and bio — never card pictures), widget specs
 * with their values, effect entries (CW1: Sol's runtime validates them), and a person's own CSS (with its assets).
 * No zip: no extraction, no symlinks, no paths outside the file.
 *
 * Checking is pure and whole: closed schemas everywhere; every path matches MOD_PATH with no `..`; every file's sha256
 * matches its bytes and every file is named by exactly one part; each part goes through its own validator (the theme's
 * checkTheme and picture checks, web-widget.ts, the owner-CSS checker, the effect entry checker). Nothing is written
 * here. The bundle's identity is the hash of its canonical manifest and file list — `version` is for people.
 */
import { createHash } from "node:crypto";
import { compareVersions } from "./agent-whats-new.js";
import { checkEffectEntry } from "./web-effect-bundle.js";
import { resolveEffectParams } from "./web-effect.js";
import type { AppearanceLimits } from "./web-appearance-limits.js";
import { checkOwnerCss, OWNER_CSS_MAX_BYTES } from "./web-owner-css.js";
import { MEDIA_EXT, type MediaKind, sniffMedia, stripMetadata } from "./web-image-meta.js";
import { canonicalBio, canonicalTagline, canonicalText, checkTheme, type Theme } from "./web-theme.js";
import { prepareThemeAsset } from "./web-theme-store.js";
import { checkWidgetData, checkWidgetSpec, WIDGET_SLOTS, type WidgetData, type WidgetSlot, type WidgetSpec } from "./web-widget.js";

export const MOD_FORMAT = "agend-mod";
export const MOD_MAX_BYTES = 8 * 1024 * 1024;
export const MOD_MAX_FILES = 128;
export const MOD_MAX_EFFECTS = 8;
/** A path inside a bundle: lowercase, no leading dot or slash, no `..` segment, no empty segment. */
export const MOD_PATH = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Owner-CSS assets a bundle may carry (the owner-CSS store's own kinds). */
const CSS_ASSET_KINDS: ReadonlySet<MediaKind> = new Set(["png", "jpeg", "webp", "gif", "woff2"]);

export interface ModProblem { path: string; problem: string }
export interface ModManifest {
  name: string;
  version: string;
  title: string;
  description?: string;
  author?: string;
  requires?: { agend: string };
  contents: {
    theme?: string;
    identity?: string;
    widgets?: Partial<Record<WidgetSlot, string>>;
    effects?: string[];
    ownerCss?: { css: string; assets?: string[] };
  };
}
/** An effect entry's files (relative to its directory), as the effect runtime's checker takes them. */
export type EffectFiles = ReadonlyMap<string, Uint8Array>;
/** What the plan shows of an effect entry (the runtime's checker says it). */
export interface EffectSummary { id: string; title: string; bytes: number; regions: string[]; wants: string[]; params: string[] }
/**
 * The effect runtime's side, as the bundle needs it (CW1, Sol's B2): the pure entry checker and param resolver. Null
 * while this fleet has no effect runtime: a bundle with effects is then refused (effects_unavailable).
 */
export interface ModEffectChecker {
  check(files: EffectFiles): { ok: true; summary: EffectSummary; manifest: unknown } | { ok: false; problems: ModProblem[] };
  /** Resolve a placement's overrides against the entry's params: the non-default ones, or refused. */
  params(manifest: unknown, overrides: unknown): { ok: true; overrides: Record<string, unknown> } | { ok: false; error: string };
}

export interface ModPicture { path: string; slot: "background" | "avatar"; id: string; kind: MediaKind; kept: Uint8Array }
export interface CheckedMod {
  id: string;
  manifest: ModManifest;
  /** The raw file's size. */
  bytes: number;
  theme?: { theme: Theme; pictures: ModPicture[]; effects: Array<{ effect: string; params: Record<string, unknown> }> };
  identity?: { tagline?: string; bio?: string };
  widgets: Partial<Record<WidgetSlot, { spec: WidgetSpec; data: WidgetData }>>;
  effects: Array<{ path: string; files: EffectFiles; summary: EffectSummary; manifest: unknown }>;
  ownerCss?: { text: string; assets: Array<{ path: string; id: string; kind: MediaKind; kept: Uint8Array }> };
}
export interface ModContext {
  /** The running AgEnD version (`requires.agend` is checked against it); null: unknown, a `requires` is refused. */
  agendVersion: string | null;
  limits: AppearanceLimits;
  effects: ModEffectChecker | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const hash32 = (b: Uint8Array) => sha256(b).slice(0, 32);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
function pathOk(p: unknown): p is string {
  return typeof p === "string" && MOD_PATH.test(p) && !p.split("/").some(seg => seg === "" || seg === "." || seg === "..") && !p.endsWith("/");
}
/** Stable JSON: keys sorted at every level. */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => Array.isArray(x) ? x.map(norm)
    : x !== null && typeof x === "object" ? Object.fromEntries(Object.keys(x as object).sort().map(k => [k, norm((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(norm(v));
}
/** A bundle's identity: the first 32 hex of the sha256 of its canonical manifest and sorted [path, sha256] list. */
export function modBundleId(manifest: unknown, files: Iterable<[string, string]>): string {
  const list = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(canonicalJson({ manifest, files: list })).slice(0, 32);
}

function checkManifest(raw: unknown, ctx: ModContext, bad: (path: string, problem: string) => void): ModManifest | null {
  if (!isObj(raw)) { bad("manifest", "an object"); return null; }
  const known = ["name", "version", "title", "description", "author", "requires", "contents"];
  for (const k of Object.keys(raw)) if (!known.includes(k)) bad(`manifest.${k}`, "unknown key");
  const m: Partial<ModManifest> = {};
  if (typeof raw.name === "string" && SLUG.test(raw.name)) m.name = raw.name; else bad("manifest.name", "a-z, 0-9 and - (1..64)");
  if (typeof raw.version === "string" && SEMVER.test(raw.version)) m.version = raw.version; else bad("manifest.version", "MAJOR.MINOR.PATCH");
  const title = canonicalText(raw.title, 1, 60);
  if (title === null) bad("manifest.title", "1..60 characters on one line"); else m.title = title;
  for (const [k, max] of [["description", 280], ["author", 60]] as const) {
    if (raw[k] === undefined) continue;
    const t = canonicalText(raw[k], 1, max);
    if (t === null) bad(`manifest.${k}`, `1..${max} characters on one line`); else m[k] = t;
  }
  if (raw.requires !== undefined) {
    const r = raw.requires;
    const want = isObj(r) && Object.keys(r).length === 1 && typeof r.agend === "string" ? r.agend : null;
    const min = want ? /^>=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(want) : null;
    if (!min) bad("manifest.requires", "{ agend: \">=MAJOR.MINOR.PATCH\" }");
    else {
      const cmp = ctx.agendVersion ? compareVersions(ctx.agendVersion, min[1]!) : null;
      if (cmp === null || cmp < 0) bad("manifest.requires", `needs AgEnD ${want}; this fleet runs ${ctx.agendVersion ?? "an unknown version"}`);
      else m.requires = { agend: want! };
    }
  }
  const c = raw.contents;
  if (!isObj(c)) { bad("manifest.contents", "an object"); return null; }
  for (const k of Object.keys(c)) if (!["theme", "identity", "widgets", "effects", "ownerCss"].includes(k)) bad(`manifest.contents.${k}`, "unknown key");
  const contents: ModManifest["contents"] = {};
  for (const k of ["theme", "identity"] as const) if (c[k] !== undefined) { if (pathOk(c[k])) contents[k] = c[k] as string; else bad(`manifest.contents.${k}`, "a path in the bundle"); }
  if (c.widgets !== undefined) {
    if (!isObj(c.widgets)) bad("manifest.contents.widgets", "{ chat_header?, details?, sidebar? }");
    else {
      const w: Partial<Record<WidgetSlot, string>> = {};
      for (const [slot, p] of Object.entries(c.widgets)) {
        if (!(WIDGET_SLOTS as readonly string[]).includes(slot)) bad(`manifest.contents.widgets.${slot}`, "chat_header, details or sidebar");
        else if (!pathOk(p)) bad(`manifest.contents.widgets.${slot}`, "a path in the bundle");
        else w[slot as WidgetSlot] = p;
      }
      contents.widgets = w;
    }
  }
  if (c.effects !== undefined) {
    if (!Array.isArray(c.effects) || c.effects.length > MOD_MAX_EFFECTS || new Set(c.effects).size !== c.effects.length || !c.effects.every(pathOk)) bad("manifest.contents.effects", `at most ${MOD_MAX_EFFECTS} distinct directory paths`);
    else contents.effects = c.effects as string[];
  }
  if (c.ownerCss !== undefined) {
    const o = c.ownerCss;
    if (!isObj(o) || Object.keys(o).some(k => k !== "css" && k !== "assets") || !pathOk(o.css) || (o.assets !== undefined && (!Array.isArray(o.assets) || !o.assets.every(pathOk) || new Set(o.assets).size !== o.assets.length)))
      bad("manifest.contents.ownerCss", "{ css: path, assets?: [path] }");
    else contents.ownerCss = { css: o.css as string, ...(o.assets ? { assets: o.assets as string[] } : {}) };
  }
  if (!Object.keys(contents).length) bad("manifest.contents", "names nothing");
  m.contents = contents;
  return m as ModManifest;
}

/**
 * Parse and check a whole bundle. `text` is the file as uploaded (UTF-8 JSON). All or nothing: the first problems are
 * returned (at most 20), and nothing in a refused bundle is ever used.
 */
export function checkModBundle(text: string, ctx: ModContext): { ok: true; mod: CheckedMod } | { ok: false; problems: ModProblem[] } {
  const problems: ModProblem[] = [];
  const bad = (path: string, problem: string) => { if (problems.length < 20) problems.push({ path, problem }); };
  const fail = () => ({ ok: false as const, problems });
  const size = Buffer.byteLength(text, "utf8");
  if (size > MOD_MAX_BYTES) { bad("", `at most ${MOD_MAX_BYTES / 1024 / 1024} MiB`); return fail(); }
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { bad("", "not JSON"); return fail(); }
  if (!isObj(doc)) { bad("", "an object { format, v, manifest, files }"); return fail(); }
  for (const k of Object.keys(doc)) if (!["format", "v", "manifest", "files"].includes(k)) bad(k, "unknown key");
  if (doc.format !== MOD_FORMAT) bad("format", `must be "${MOD_FORMAT}"`);
  if (doc.v !== 1) bad("v", "must be 1");
  const manifest = checkManifest(doc.manifest, ctx, bad);

  // Every file: a good path, its bytes, its sha256.
  const files = new Map<string, Uint8Array>();
  const shas = new Map<string, string>();
  if (!isObj(doc.files)) bad("files", "an object { path: { sha256, b64 } }");
  else {
    const entries = Object.entries(doc.files);
    if (entries.length > MOD_MAX_FILES) bad("files", `at most ${MOD_MAX_FILES}`);
    else for (const [p, f] of entries) {
      if (!pathOk(p)) { bad(`files.${String(p).slice(0, 80)}`, "a lowercase path: a-z 0-9 . _ - /, no .. or empty segment"); continue; }
      if (!isObj(f) || Object.keys(f).length !== 2 || typeof f.sha256 !== "string" || !SHA256.test(f.sha256) || typeof f.b64 !== "string" || !B64.test(f.b64) || f.b64.length % 4 !== 0) { bad(`files.${p}`, "{ sha256, b64 }"); continue; }
      const bytes = Buffer.from(f.b64, "base64");
      if (sha256(bytes) !== f.sha256) { bad(`files.${p}`, "sha256 does not match its bytes"); continue; }
      files.set(p, bytes); shas.set(p, f.sha256);
    }
    // A path that is both a file and a directory prefix of another would be two things.
    for (const p of files.keys()) if ([...files.keys()].some(q => q.startsWith(`${p}/`))) bad(`files.${p}`, "both a file and a directory");
  }
  if (problems.length || !manifest) return fail();

  const used = new Set<string>();
  const take = (p: string, where: string): Uint8Array | null => {
    const b = files.get(p);
    if (!b) { bad(where, `no file ${p}`); return null; }
    if (used.has(p)) { bad(where, `${p} is already used by another part`); return null; }
    used.add(p);
    return b;
  };
  const json = (p: string, where: string): unknown => {
    const b = take(p, where);
    if (!b) return undefined;
    try { return JSON.parse(utf8.decode(b)); } catch { bad(where, `${p}: not UTF-8 JSON`); return undefined; }
  };
  const mod: CheckedMod = { id: modBundleId(manifest, shas), manifest, bytes: size, widgets: {}, effects: [] };
  const c = manifest.contents;

  // Effects first: the theme's placements name them.
  const effectPaths = new Set(c.effects ?? []);
  if (c.effects?.length) {
    if (!ctx.effects) bad("manifest.contents.effects", "effects_unavailable: this fleet has no effect runtime yet");
    else for (const dir of c.effects) {
      const entry = new Map<string, Uint8Array>();
      for (const [p, b] of files) if (p.startsWith(`${dir}/`)) { entry.set(p.slice(dir.length + 1), b); used.add(p); }
      if (!entry.size) { bad(`effects.${dir}`, "no files under it"); continue; }
      const r = ctx.effects.check(entry);
      if (!r.ok) { for (const q of r.problems) bad(`effects.${dir}/${q.path}`, q.problem); continue; }
      mod.effects.push({ path: dir, files: entry, summary: r.summary, manifest: r.manifest });
    }
  }

  if (c.theme) {
    const raw = json(c.theme, "manifest.contents.theme");
    if (raw !== undefined) {
      if (!isObj(raw)) bad("theme", "an object");
      else {
        const { effects: placed, ...look } = raw;
        if (look.card !== undefined) bad("theme.card", "a card travels as identity (tagline, bio) — never in the theme, and its pictures never in a bundle");
        // Pictures are named by path in a bundle: each is checked as an upload to its slot, then named by its id.
        const pictures: ModPicture[] = [];
        const picture = (p: unknown, slot: "background" | "avatar", where: string): string | null => {
          if (!pathOk(p)) { bad(where, "a path in the bundle"); return null; }
          const b = take(p, where);
          if (!b) return null;
          const r = prepareThemeAsset(slot, b, ctx.limits);
          if (!r.ok) { bad(where, `${r.error}${r.detail ? `: ${r.detail}` : ""}`); return null; }
          if (pictures.some(x => x.id === r.id)) { bad(where, "the same picture as another slot's: a picture holds one slot"); return null; }
          pictures.push({ path: p, slot, id: r.id, kind: r.kind, kept: r.kept });
          return r.id;
        };
        const input: Record<string, unknown> = { ...look };
        if (isObj(look.background)) { const id = picture(look.background.image, "background", "theme.background.image"); if (id) input.background = { ...look.background, image: id }; }
        if (look.avatar !== undefined) { const id = picture(look.avatar, "avatar", "theme.avatar"); if (id) input.avatar = id; }
        const checked = checkTheme(input, { assets: new Set(pictures.map(p => p.id)) });
        if (!checked.ok) for (const e of checked.errors) bad(`theme.${e.path}`, e.problem);
        const effects: Array<{ effect: string; params: Record<string, unknown> }> = [];
        if (placed !== undefined) {
          if (!Array.isArray(placed) || placed.length > 2) bad("theme.effects", "at most 2 [{ effect, params? }]");
          else placed.forEach((p, i) => {
            const where = `theme.effects.${i}`;
            if (!isObj(p) || Object.keys(p).some(k => k !== "effect" && k !== "params") || typeof p.effect !== "string") { bad(where, "{ effect: path, params? }"); return; }
            if (!effectPaths.has(p.effect)) { bad(where, `${p.effect} is not one of this bundle's effects`); return; }
            const entry = mod.effects.find(e => e.path === p.effect);
            if (!entry || !ctx.effects) return;                      // its own problem is reported already
            const r = ctx.effects.params(entry.manifest, p.params ?? {});
            if (!r.ok) { bad(`${where}.params`, r.error); return; }
            if (effects.some(e => e.effect === p.effect)) { bad(where, "placed twice"); return; }
            effects.push({ effect: p.effect, params: r.overrides });
          });
        }
        if (checked.ok) mod.theme = { theme: checked.theme, pictures, effects };
      }
    }
  }

  if (c.identity) {
    const raw = json(c.identity, "manifest.contents.identity");
    if (raw !== undefined) {
      if (!isObj(raw) || Object.keys(raw).some(k => k !== "tagline" && k !== "bio") || !Object.keys(raw).length) bad("identity", "{ tagline?, bio? }");
      else {
        const id: { tagline?: string; bio?: string } = {};
        if (raw.tagline !== undefined) { const t = canonicalTagline(raw.tagline); if (t === null) bad("identity.tagline", "one line, 1..60 characters"); else id.tagline = t; }
        if (raw.bio !== undefined) { const t = canonicalBio(raw.bio); if (t === null) bad("identity.bio", "1..280 characters, at most 3 line breaks"); else id.bio = t; }
        mod.identity = id;
      }
    }
  }

  for (const [slot, p] of Object.entries(c.widgets ?? {}) as Array<[WidgetSlot, string]>) {
    const raw = json(p, `manifest.contents.widgets.${slot}`);
    if (raw === undefined) continue;
    if (!isObj(raw) || Object.keys(raw).length !== 2 || !("spec" in raw) || !("data" in raw)) { bad(`widgets.${slot}`, "{ spec, data }"); continue; }
    const spec = checkWidgetSpec(raw.spec, slot);
    if (!spec.ok) { for (const e of spec.errors) bad(`widgets.${slot}.${e.path}`, e.problem); continue; }
    const data = checkWidgetData(raw.data, spec.value);
    if (!data.ok) { for (const e of data.errors) bad(`widgets.${slot}.${e.path}`, e.problem); continue; }
    mod.widgets[slot] = { spec: spec.value, data: { ...data.value } };
  }

  if (c.ownerCss) {
    const assets: NonNullable<CheckedMod["ownerCss"]>["assets"] = [];
    for (const p of c.ownerCss.assets ?? []) {
      const b = take(p, `ownerCss.assets.${p}`);
      if (!b) continue;
      const kind = sniffMedia(b);
      const kept = kind && CSS_ASSET_KINDS.has(kind) ? stripMetadata(b, kind) : null;
      if (!kind || !kept) { bad(`ownerCss.assets.${p}`, "png, webp, jpeg, gif or woff2"); continue; }
      assets.push({ path: p, id: hash32(kept), kind, kept });
    }
    const cssBytes = take(c.ownerCss.css, "manifest.contents.ownerCss.css");
    if (cssBytes) {
      let text: string | null = null;
      try { text = utf8.decode(cssBytes); } catch { bad("ownerCss.css", "not UTF-8"); }
      if (text !== null) {
        if (cssBytes.length > OWNER_CSS_MAX_BYTES) bad("ownerCss.css", `at most ${OWNER_CSS_MAX_BYTES / 1024} KiB`);
        else {
          // url("asset:<id>") names one of the bundle's CSS assets by the id it will have (the hash of its kept bytes).
          const checked = checkOwnerCss(text, new Set(assets.map(a => a.id)));
          if (!checked.ok) bad("ownerCss.css", `${checked.error.problem}${checked.error.detail ? `: ${checked.error.detail}` : ""}`);
          else mod.ownerCss = { text, assets };
        }
      }
    }
  }

  for (const p of files.keys()) if (!used.has(p)) bad(`files.${p}`, "not used by any part");
  return problems.length ? fail() : { ok: true, mod };
}

/** A file's entry for a bundle being built (export). */
export function modFile(bytes: Uint8Array): { sha256: string; b64: string } {
  return { sha256: sha256(bytes), b64: Buffer.from(bytes).toString("base64") };
}
/** The extension a picture or CSS asset is exported under. */
export function modAssetName(base: string, kind: MediaKind): string { return `${base}.${MEDIA_EXT[kind]}`; }

/**
 * The effect runtime's checker (CW1: Sol's src/web-effect-bundle.ts and src/web-effect.ts) as a bundle uses it. Used
 * once the fleet has an effect library to install into; until then the fleet passes null and effects are refused.
 */
export function cw1EffectChecker(): ModEffectChecker {
  return {
    check(files) {
      const r = checkEffectEntry(files);
      if (!r.ok) return { ok: false, problems: r.problems };
      const m = r.manifest;
      return { ok: true, manifest: m, summary: { id: r.id, title: m.title, bytes: r.bytes, regions: [...m.regions], wants: [...m.wants], params: Object.keys(m.params ?? {}) } };
    },
    params(manifest, overrides) {
      const r = resolveEffectParams(manifest as Parameters<typeof resolveEffectParams>[0], overrides);
      return r.ok ? { ok: true, overrides: { ...r.overrides } } : { ok: false, error: r.error };
    },
  };
}
