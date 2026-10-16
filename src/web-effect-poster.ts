/** #1629: a bounded static projection of an already-normalized CW1 PNG, never its author code. */
import { imageSize, sniffMedia } from "./web-image-meta.js";
import { WEB_EFFECT_MAX_BYTES } from "./web-effect-bundle.js";

const ANIMATION = new Set(["acTL", "fcTL", "fdAT"]);
/**
 * Retain the PNG default image, not APNG animation. This does not change stored CW1 bytes/identity.
 * Input comes from the revalidated library (metadata already stripped). Chunk/size checks are not
 * a complete image decoder or CRC validator; a browser may still refuse an invalid default image.
 */
export function staticEffectPoster(bytes: Uint8Array): Uint8Array | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > WEB_EFFECT_MAX_BYTES || sniffMedia(bytes) !== "png") return null;
  const size = imageSize(bytes, "png");
  if (!size || size.width < 1 || size.height < 1 || size.width > 4096 || size.height > 4096 || size.width * size.height > 8388608) return null;
  const parts = [bytes.subarray(0, 8)];
  let offset = 8, chunks = 0, data = false;
  while (offset + 12 <= bytes.length && ++chunks <= 4096) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (chunks === 1 ? type !== "IHDR" || length !== 13 : type === "IHDR") return null;
    if (type === "IDAT" && length > 0) data = true;
    if (!ANIMATION.has(type)) parts.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") {
      if (length !== 0 || !data || offset !== bytes.length) return null;
      const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
      let at = 0; for (const part of parts) { result.set(part, at); at += part.length; }
      return result;
    }
  }
  return null;
}

/** Cursor output keeps the default PNG image and the CW1 32-KiB / square 64-pixel limit. */
export function staticEffectCursor(bytes: Uint8Array): Uint8Array | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 32768) return null;
  const size = imageSize(bytes, "png");
  return size && size.width >= 1 && size.width <= 64 && size.height === size.width ? staticEffectPoster(bytes) : null;
}
