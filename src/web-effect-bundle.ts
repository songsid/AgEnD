/** CW1: synchronous validation and normalization. No I/O, JS execution, or image decoding. */
import { Script } from "node:vm";
import { imageSize, sniffMedia, stripMetadata, MEDIA_MIME } from "./web-image-meta.js";
import { effectBundleIdentity, effectManifestJson } from "./web-effect-canonical.js";
import { parseWebEffectManifest, type WebEffectManifest } from "./web-effect.js";
export const WEB_EFFECT_MAX_BYTES = 1024 * 1024;
export const WEB_EFFECT_RAW_MAX_BYTES = 8 * 1024 * 1024;
export const WEB_EFFECT_ASSET_MAX = 16;
export interface CheckedWebEffect {
  id: string;
  sha256: string;
  manifest: WebEffectManifest;
  bytes: number;
  files: ReadonlyMap<string, Uint8Array>;
  warnings: string[];
}
export type EffectEntryResult = {
  ok: true;
} & CheckedWebEffect | {
  ok: false;
  problems: Array<{
    path: string;
    problem: string;
  }>;
};
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const assetPath = /^assets\/[a-z0-9][a-z0-9_-]{0,63}\.(png|jpe?g|webp|gif)$/;
const fail = (path: string, problem: string): EffectEntryResult => ({ ok: false, problems: [{ path, problem }] });
/** Advisory text lint only, never validation or a security boundary. Keep quoted URLs while ignoring comments. */
function workerLintText(code: string): string {
  const parts: string[] = []; let copied = 0, at = 0;
  while (at < code.length) {
    const c = code[at];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c; at++;
      while (at < code.length) { if (code[at] === "\\") { at += 2; continue; } if (code[at++] === quote) break; }
      continue;
    }
    // Escaped slashes in a regular-expression literal are not comment openers.
    if (c === "\\") { at += 2; continue; }
    if (c === "/" && (code[at + 1] === "/" || code[at + 1] === "*")) {
      parts.push(code.slice(copied, at), " ");
      if (code[at + 1] === "/") {
        at += 2; while (at < code.length && !/[\r\n\u2028\u2029]/.test(code[at]!)) at++;
      } else { at += 2; while (at < code.length && !(code[at] === "*" && code[at + 1] === "/")) at++; at = Math.min(code.length, at + 2); }
      copied = at; continue;
    }
    at++;
  }
  parts.push(code.slice(copied)); return parts.join("");
}
export function checkEffectEntry(input: ReadonlyMap<string, Uint8Array>): EffectEntryResult {
  try {
    if (!(input instanceof Map) || input.size < 2 || input.size > 20)
      return fail("<entry>", "invalid_files");
    let raw = 0, assets = 0, seen = 0;
    const snapshot = new Map<string, Uint8Array>();
    for (const [path, bytes] of input) {
      if (++seen > 20)
        return fail("<entry>", "invalid_files");
      if (typeof path !== "string" || !["effect.json", "worker.js", "poster.png", "cursor.png"].includes(path) && !assetPath.test(path))
        return fail("<entry>", "unsupported_path");
      if (!(bytes instanceof Uint8Array))
        return fail(path, "invalid_bytes");
      raw += bytes.byteLength;
      if (raw > WEB_EFFECT_RAW_MAX_BYTES)
        return fail("<entry>", "raw_entry_too_large");
      if (assetPath.test(path) && ++assets > WEB_EFFECT_ASSET_MAX)
        return fail("<entry>", "too_many_assets");
      if (snapshot.has(path))
        return fail("<entry>", "invalid_files");
      snapshot.set(path, new Uint8Array(bytes));
    }
    const manifestBytes = snapshot.get("effect.json"), script = snapshot.get("worker.js");
    if (!manifestBytes || !script)
      return fail("<entry>", "missing_entry");
    if (manifestBytes.byteLength > 64 * 1024)
      return fail("effect.json", "manifest_too_large");
    if (script.byteLength > WEB_EFFECT_MAX_BYTES)
      return fail("worker.js", "entry_too_large");
    let decoded: unknown, code: string;
    try {
      decoded = JSON.parse(utf8.decode(manifestBytes));
    }
    catch {
      return fail("effect.json", "invalid_manifest");
    }
    const parsed = parseWebEffectManifest(decoded);
    if (!parsed.ok)
      return fail("effect.json", "invalid_manifest");
    try {
      code = utf8.decode(script);
    }
    catch {
      return fail("worker.js", "invalid_utf8");
    }
    let manifest = parsed.manifest;
    if (manifest.poster && !snapshot.has("poster.png"))
      return fail("poster.png", "missing_poster");
    if (!!manifest.cursor !== snapshot.has("cursor.png"))
      return fail("cursor.png", "cursor_manifest_mismatch");
    if (snapshot.has("poster.png"))
      manifest = { ...manifest, poster: "poster.png" };
    let pixels = 0;
    const files = new Map<string, Uint8Array>();
    files.set("worker.js", Uint8Array.from(script));
    for (const [path, bytes] of snapshot) {
      if (path === "effect.json" || path === "worker.js")
        continue;
      const kind = sniffMedia(bytes);
      if (!kind || kind === "woff2")
        return fail(path, "invalid_raster");
      const extension = path.slice(path.lastIndexOf(".") + 1), expected = extension === "jpg" ? "jpeg" : extension;
      if (kind !== expected)
        return fail(path, "media_mismatch");
      const size = imageSize(bytes, kind);
      if (!size || size.width < 1 || size.height < 1 || size.width > 4096 || size.height > 4096 || size.width * size.height > 8 * 1024 * 1024)
        return fail(path, "image_dimensions");
      pixels += size.width * size.height;
      if (pixels > 8 * 1024 * 1024)
        return fail(path, "image_dimensions");
      const stripped = stripMetadata(bytes, kind);
      if (!stripped)
        return fail(path, "invalid_raster");
      if (path === "cursor.png") {
        if (kind !== "png" || stripped.byteLength > 32 * 1024 || size.width !== size.height || size.width > 64)
          return fail(path, "invalid_cursor");
        if (manifest.cursor!.hotspot.some((point, index) => point >= (index === 0 ? size.width : size.height)))
          return fail(path, "invalid_hotspot");
      }
      files.set(path, Uint8Array.from(stripped));
    }
    files.set("effect.json", new TextEncoder().encode(effectManifestJson(manifest)));
    const bytes = [...files.values()].reduce((n, v) => n + v.byteLength, 0);
    if (bytes > WEB_EFFECT_MAX_BYTES)
      return fail("<entry>", "entry_too_large");
    // Compile classic syntax only. Never run the result or expose parser excerpts.
    try {
      new Script(code, { filename: "worker.js" });
    }
    catch {
      return fail("worker.js", "invalid_classic_script");
    }
    const identity = effectBundleIdentity(manifest, files);
    const warnings: string[] = [];
    if (/\b(?:fetch|XMLHttpRequest|WebSocket|RTCPeerConnection|importScripts)\b|https?:\/\/|["\'`]\/\/|\bimport\s*\(|\btop\.|\bparent\.location/.test(workerLintText(code)))
      warnings.push("network_or_import_api_unsupported");
    return { ok: true, id: identity.id, sha256: identity.sha256, manifest, files, bytes, warnings };
  }
  catch {
    return fail("<entry>", "invalid_entry");
  }
}
/** Already normalized files only: assets become decoded ImageBitmaps inside the trusted frame. */
export function effectRasterAssets(entry: CheckedWebEffect): Array<{
  name: string;
  mime: string;
  bytes: Uint8Array;
}> {
  const assets: Array<{
    name: string;
    mime: string;
    bytes: Uint8Array;
  }> = [];
  for (const [name, bytes] of entry.files)
    if (assetPath.test(name)) {
      const kind = sniffMedia(bytes);
      if (!kind || kind === "woff2")
        throw Error("Invalid normalized raster");
      assets.push({ name, mime: MEDIA_MIME[kind], bytes: Uint8Array.from(bytes) });
    }
  return assets;
}
