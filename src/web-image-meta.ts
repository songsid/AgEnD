/**
 * #1629 r4 §1: what an uploaded picture or font is, how large it is, and the same file without its metadata — all
 * from the bytes, never decoding an image. Used by owner-CSS assets (r4 §3) and the identity card (r4 §1).
 *
 * Metadata is removed by byte surgery:
 * - JPEG: the APP1–APP15 and COM segments go (EXIF, GPS, XMP, ICC, comments) wherever they are — before the first
 *   scan or between the scans of a progressive file; APP0 (JFIF) and the image stay. Every scan's entropy-coded data
 *   is walked to its end, and the file must end with EOI (what follows it is dropped).
 * - PNG: the tEXt, zTXt, iTXt, eXIf and tIME chunks go.
 * - WebP: the EXIF and "XMP " chunks go, and VP8X's EXIF/XMP flags are cleared to match. A file shorter than its
 *   RIFF header says is refused; bytes after the RIFF end are dropped.
 * A file this module cannot walk to its end is refused, never passed through.
 */

export type MediaKind = "png" | "jpeg" | "webp" | "gif" | "woff2";
export const MEDIA_MIME: Record<MediaKind, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", woff2: "font/woff2" };
export const MEDIA_EXT: Record<MediaKind, string> = { png: "png", jpeg: "jpg", webp: "webp", gif: "gif", woff2: "woff2" };

/** The kind by magic bytes, or null. */
export function sniffMedia(b: Uint8Array): MediaKind | null {
  const at = (k: number, ...v: number[]) => v.every((x, j) => b[k + j] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return "gif";
  if (b.length >= 4 && at(0, 0x77, 0x4f, 0x46, 0x32)) return "woff2";
  return null;
}

const u16be = (b: Uint8Array, k: number) => (b[k]! << 8) | b[k + 1]!;
const u32be = (b: Uint8Array, k: number) => ((b[k]! << 24) >>> 0) + (b[k + 1]! << 16) + (b[k + 2]! << 8) + b[k + 3]!;
const u16le = (b: Uint8Array, k: number) => b[k]! | (b[k + 1]! << 8);
const u24le = (b: Uint8Array, k: number) => b[k]! | (b[k + 1]! << 8) | (b[k + 2]! << 16);
const u32le = (b: Uint8Array, k: number) => (b[k]! | (b[k + 1]! << 8) | (b[k + 2]! << 16) | (b[k + 3]! << 24)) >>> 0;

/** Width and height from the headers, or null when the file does not say (or is not an image). */
export function imageSize(b: Uint8Array, kind: MediaKind): { width: number; height: number } | null {
  if (kind === "png") return b.length >= 24 && String.fromCharCode(...b.subarray(12, 16)) === "IHDR" ? { width: u32be(b, 16), height: u32be(b, 20) } : null;
  if (kind === "gif") return b.length >= 10 ? { width: u16le(b, 6), height: u16le(b, 8) } : null;
  if (kind === "jpeg") {
    let k = 2;
    while (k + 4 <= b.length) {
      if (b[k] !== 0xff) return null;
      const m = b[k + 1]!;
      if (m === 0xff) { k++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { k += 2; continue; }
      const len = u16be(b, k + 2);
      // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return k + 9 <= b.length ? { height: u16be(b, k + 5), width: u16be(b, k + 7) } : null;
      if (m === 0xda || m === 0xd9) return null;
      k += 2 + len;
    }
    return null;
  }
  if (kind === "webp") {
    if (b.length < 30) return null;
    const fourcc = String.fromCharCode(...b.subarray(12, 16));
    if (fourcc === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    if (fourcc === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (fourcc === "VP8L" && b[20] === 0x2f) {
      const bits = u32le(b, 21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  return null;
}

const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
const WEBP_DROP = new Set(["EXIF", "XMP "]);

/** The file without its metadata (see the module comment), or null when it cannot be walked safely. */
export function stripMetadata(b: Uint8Array, kind: MediaKind): Uint8Array | null {
  if (kind === "png") {
    const parts: Uint8Array[] = [b.subarray(0, 8)];
    let k = 8, sawEnd = false;
    while (k + 12 <= b.length) {
      const len = u32be(b, k), type = String.fromCharCode(...b.subarray(k + 4, k + 8)), end = k + 12 + len;
      if (end > b.length) return null;
      if (!PNG_DROP.has(type)) parts.push(b.subarray(k, end));
      k = end;
      if (type === "IEND") { sawEnd = true; break; }
    }
    return sawEnd ? concat(parts) : null;
  }
  if (kind === "jpeg") {
    const parts: Uint8Array[] = [b.subarray(0, 2)];
    let k = 2;
    for (;;) {
      if (k + 2 > b.length || b[k] !== 0xff) return null;              // no EOI: truncated, or not a marker
      const m = b[k + 1]!;
      if (m === 0xff) { k++; continue; }                                 // fill byte before a marker
      if (m === 0xd9) { parts.push(b.subarray(k, k + 2)); return concat(parts); }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { parts.push(b.subarray(k, k + 2)); k += 2; continue; }   // standalone
      if (k + 4 > b.length) return null;
      const len = u16be(b, k + 2), end = k + 2 + len;
      if (len < 2 || end > b.length) return null;
      const drop = (m >= 0xe1 && m <= 0xef) || m === 0xfe;
      if (!drop) parts.push(b.subarray(k, end));
      k = end;
      if (m !== 0xda) continue;
      // A scan: its entropy-coded data runs to the next marker that is neither a stuffed 0xFF00 nor a restart marker.
      let j = k;
      for (;;) {
        if (j + 1 >= b.length) return null;                              // the data never ends: truncated
        if (b[j] === 0xff) {
          const n = b[j + 1]!;
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { j += 2; continue; }
          if (n === 0xff) { j++; continue; }
          break;
        }
        j++;
      }
      parts.push(b.subarray(k, j));
      k = j;
    }
  }
  if (kind === "webp") {
    const parts: Uint8Array[] = [];
    let k = 12;
    const riffEnd = 8 + u32le(b, 4);
    if (riffEnd > b.length || riffEnd < 12) return null;                  // shorter than it says: truncated
    while (k + 8 <= riffEnd) {
      const type = String.fromCharCode(...b.subarray(k, k + 4)), len = u32le(b, k + 4), end = k + 8 + len + (len & 1);
      if (k + 8 + len > riffEnd) return null;
      if (!WEBP_DROP.has(type)) {
        const chunk = Uint8Array.from(b.subarray(k, Math.min(end, riffEnd)));
        if (type === "VP8X" && chunk.length >= 9) chunk[8] = chunk[8]! & ~0x0c;      // its EXIF (0x08) and XMP (0x04) flags
        parts.push(chunk);
      }
      k = end;
    }
    if (k < riffEnd) return null;
    const body = concat(parts);
    const out = new Uint8Array(12 + body.length);
    out.set(b.subarray(0, 4), 0);
    const size = 4 + body.length;
    out[4] = size & 0xff; out[5] = (size >>> 8) & 0xff; out[6] = (size >>> 16) & 0xff; out[7] = (size >>> 24) & 0xff;
    out.set(b.subarray(8, 12), 8);
    out.set(body, 12);
    return out;
  }
  return b;                                                              // gif, woff2: carried as they are
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}
