/**
 * #1629 r4 §4 (r4-5): building a mod bundle from what is in force — one instance's look (theme with its pictures,
 * identity text, its widgets) and, for a person, their sidebar widget and their own CSS with its assets. The result is
 * the same format the importer checks (web-mod-bundle.ts), and it passes that check: export → import is the round trip.
 * Card pictures never travel (a card is an instance's identity, not a look).
 */
import { MEDIA_EXT, type MediaKind } from "./web-image-meta.js";
import { MOD_FORMAT, type ModManifest, modFile } from "./web-mod-bundle.js";
import type { Theme } from "./web-theme.js";
import type { WidgetData, WidgetSlot, WidgetSpec } from "./web-widget.js";
import type { AmbientKind, AmbientSpec } from "./web-ambient.js";

export interface ModExportParts {
  /**
   * The theme, and (r4-5c) the effects it places: each a CW1 entry's files as the library keeps them, written under
   * `effects/<name>/`, with the placement's non-default params. Effects travel only with the theme that places them.
   */
  theme?: { theme: Theme; picture: (id: string) => { bytes: Uint8Array; kind: MediaKind } | null; effects?: Array<{ name: string; files: ReadonlyMap<string, Uint8Array>; params: Record<string, unknown> }> };
  identity?: { tagline?: string; bio?: string };
  widgets?: Partial<Record<WidgetSlot, { spec: WidgetSpec; data: WidgetData }>>;
  /** #2117: the ambients, and their glyph pictures by id (written under glyphs/). */
  ambient?: { specs: Partial<Record<AmbientKind, AmbientSpec>>; picture: (id: string) => { bytes: Uint8Array; kind: MediaKind } | null };
  ownerCss?: { text: string; assets: Array<{ id: string; bytes: Uint8Array; kind: MediaKind }> };
}
export interface ModExportMeta { name: string; version: string; title: string; description?: string; author?: string }

const enc = new TextEncoder();
const jsonBytes = (v: unknown) => enc.encode(JSON.stringify(v, null, 2) + "\n");

/** The bundle file's text (UTF-8 JSON), or why it can't be built (a picture the theme names is missing). */
export function buildModBundle(meta: ModExportMeta, parts: ModExportParts): { ok: true; text: string; filename: string } | { ok: false; error: string } {
  const files: Record<string, { sha256: string; b64: string }> = {};
  const put = (path: string, bytes: Uint8Array) => { files[path] = modFile(bytes); };
  const contents: ModManifest["contents"] = {};
  if (parts.theme) {
    const { card: _card, ...look } = parts.theme.theme;
    void _card;
    const out: Record<string, unknown> = { ...look };
    const picture = (id: string, base: string): string | null => {
      const p = parts.theme!.picture(id);
      if (!p) return null;
      const path = `pictures/${base}.${MEDIA_EXT[p.kind]}`;
      put(path, p.bytes);
      return path;
    };
    if (look.background) { const path = picture(look.background.image, "background"); if (!path) return { ok: false, error: "picture_missing" }; out.background = { ...look.background, image: path }; }
    if (look.avatar) { const path = picture(look.avatar, "avatar"); if (!path) return { ok: false, error: "picture_missing" }; out.avatar = path; }
    const placed: Array<{ effect: string; params?: Record<string, unknown> }> = [];
    const taken = new Set<string>();
    for (const e of parts.theme.effects ?? []) {
      const base = /^[a-z0-9][a-z0-9-]{0,47}$/.test(e.name) ? e.name : "effect";
      let slug = base;
      for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
      taken.add(slug);
      const dir = `effects/${slug}`;
      for (const [rel, bytes] of e.files) put(`${dir}/${rel}`, bytes);
      (contents.effects ??= []).push(dir);
      placed.push({ effect: dir, ...(Object.keys(e.params).length ? { params: e.params } : {}) });
    }
    if (placed.length) out.effects = placed;
    put("theme.json", jsonBytes(out));
    contents.theme = "theme.json";
  }
  if (parts.identity && (parts.identity.tagline || parts.identity.bio)) {
    put("identity.json", jsonBytes({ ...(parts.identity.tagline ? { tagline: parts.identity.tagline } : {}), ...(parts.identity.bio ? { bio: parts.identity.bio } : {}) }));
    contents.identity = "identity.json";
  }
  for (const [slot, w] of Object.entries(parts.widgets ?? {}) as Array<[WidgetSlot, { spec: WidgetSpec; data: WidgetData }]>) {
    const path = `widgets/${slot.replace("_", "-")}.json`;
    put(path, jsonBytes({ spec: w.spec, data: w.data }));
    (contents.widgets ??= {})[slot] = path;
  }
  if (parts.ambient && Object.keys(parts.ambient.specs).length) {
    const out: Record<string, unknown> = {};
    for (const [kind, spec] of Object.entries(parts.ambient.specs) as Array<[AmbientKind, AmbientSpec]>) {
      const glyphs: unknown[] = [];
      for (const g of spec.glyphs) {
        if (typeof g === "string") { glyphs.push(g); continue; }
        const p = parts.ambient.picture(g.asset);
        if (!p) return { ok: false, error: "picture_missing" };
        const path = `glyphs/${g.asset}.${MEDIA_EXT[p.kind]}`;
        put(path, p.bytes);
        glyphs.push({ asset: path });
      }
      out[kind] = { ...spec, glyphs };
    }
    put("ambient.json", jsonBytes(out));
    contents.ambient = "ambient.json";
  }
  if (parts.ownerCss) {
    // The CSS names its assets as url("asset:<id>"): the id is the hash of the kept bytes, the same on import.
    const assets = parts.ownerCss.assets.map(a => { const path = `css/assets/${a.id}.${MEDIA_EXT[a.kind]}`; put(path, a.bytes); return path; });
    put("css/custom.css", enc.encode(parts.ownerCss.text));
    contents.ownerCss = { css: "css/custom.css", ...(assets.length ? { assets } : {}) };
  }
  if (!Object.keys(contents).length) return { ok: false, error: "nothing_to_export" };
  const manifest: ModManifest = { name: meta.name, version: meta.version, title: meta.title, ...(meta.description ? { description: meta.description } : {}), ...(meta.author ? { author: meta.author } : {}), contents };
  return { ok: true, text: JSON.stringify({ format: MOD_FORMAT, v: 1, manifest, files }) + "\n", filename: `${meta.name}-${meta.version}.agendmod.json` };
}
