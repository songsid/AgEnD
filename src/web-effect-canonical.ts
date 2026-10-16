/** #1629: identity of an already validated, normalized bundle, including every file.
* This is not an upload validator. The bundle preparer owns paths, media stripping,
* UTF-8, entry format and the normalized byte limit. */
import { createHash } from "node:crypto";
import type { WebEffectManifest } from "./web-effect.js";
export function effectBundleIdentity(manifest: WebEffectManifest, files: ReadonlyMap<string, Uint8Array>): {
  id: string;
  sha256: string;
  canonical: string;
} {
  const entries = [...files].map(([path, bytes]) => [path, createHash("sha256").update(bytes).digest("hex")] as const);
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const canonical = JSON.stringify({ manifest: JSON.parse(effectManifestJson(manifest)), files: entries });
  const sha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
  return { id: sha256.slice(0, 32), sha256, canonical };
}
/** Stable JSON for the validated manifest; array order is part of its value. */
export function effectManifestJson(manifest: WebEffectManifest): string {
  const normalized = (value: unknown): unknown => {
    if (Array.isArray(value))
      return value.map(normalized);
    if (value !== null && typeof value === "object") {
      const object: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(value).sort())
        object[key] = normalized((value as Record<string, unknown>)[key]);
      return object;
    }
    return value;
  };
  return JSON.stringify(normalized(manifest));
}
