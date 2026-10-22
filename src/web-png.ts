/**
 * #2308: just enough PNG for the app icon, on Node's zlib (no image library). Decode a PNG the person uploaded — every
 * chunk's CRC, the IHDR, the image data inflating to exactly its expected size (a decompression bomb cannot grow),
 * each row's filter — into RGBA; resample it (area average, alpha premultiplied); encode PNGs; pack an ICO of PNGs.
 * Anything malformed is a PngError with a short reason, never a crash.
 */
import { deflateSync, inflateSync } from "node:zlib";

/** A short English reason; `key`/`args` name it for a page that says it in its own language (#2390). */
export class PngError extends Error {
  constructor(message: string, readonly key = "corrupt", readonly args: Array<string | number> = []) { super(message); }
}

export interface Rgba {
  width: number;
  height: number;
  /** width × height × 4 bytes, RGBA, not premultiplied. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(...parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.equals(Buffer.from(bytes.buffer, bytes.byteOffset, 8));
}

/** Channels per colour type, and the bit depths each allows (PNG spec, table 11.1). */
const COLOR: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

export interface DecodeLimits {
  /** Largest width or height accepted. */
  maxSide: number;
}

/** A PNG's pixels as RGBA, or a PngError naming what is wrong. Interlaced images are refused (the page never sends one). */
export function decodePng(bytes: Uint8Array, limits: DecodeLimits): Rgba {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!isPng(buf)) throw new PngError("not a PNG");
  let pos = 8;
  let ihdr: { width: number; height: number; depth: number; type: number } | null = null;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  let ended = false;
  while (pos < buf.length) {
    if (pos + 12 > buf.length) throw new PngError("truncated chunk");
    const len = buf.readUInt32BE(pos);
    if (len > 0x7fffffff || pos + 12 + len > buf.length) throw new PngError("truncated chunk");
    const type = buf.subarray(pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (crc32(type, data) !== buf.readUInt32BE(pos + 8 + len)) throw new PngError("bad chunk CRC");
    const name = type.toString("latin1");
    pos += 12 + len;
    if (!ihdr && name !== "IHDR") throw new PngError("IHDR must come first");
    if (name === "IHDR") {
      if (ihdr || len !== 13) throw new PngError("bad IHDR");
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4), depth = data[8]!, colorType = data[9]!;
      if (!width || !height) throw new PngError("empty image");
      if (width > limits.maxSide || height > limits.maxSide) throw new PngError(`larger than ${limits.maxSide}×${limits.maxSide}`, "too_big", [limits.maxSide]);
      const spec = COLOR[colorType];
      if (!spec || !spec.depths.includes(depth)) throw new PngError("unknown colour type or bit depth");
      if (data[10] !== 0 || data[11] !== 0) throw new PngError("unknown compression or filter method");
      if (data[12] === 1) throw new PngError("interlaced PNGs are not supported", "interlaced");
      if (data[12] !== 0) throw new PngError("unknown interlace method");
      ihdr = { width, height, depth, type: colorType };
    } else if (name === "PLTE") {
      if (len % 3 || len === 0 || len > 768) throw new PngError("bad palette");
      palette = data;
    } else if (name === "tRNS") {
      trns = data;
    } else if (name === "IDAT") {
      idat.push(data);
    } else if (name === "IEND") {
      ended = true;
      break;
    } else if (type[0]! & 0x20) {
      // Ancillary chunk (lower-case first letter): skipped.
    } else {
      throw new PngError(`unknown critical chunk ${name}`);
    }
  }
  if (!ihdr) throw new PngError("no IHDR");
  if (!ended) throw new PngError("no IEND");
  if (!idat.length) throw new PngError("no image data");
  if (ihdr.type === 3 && !palette) throw new PngError("palette image without a palette");

  const { width, height, depth, type } = ihdr;
  const channels = COLOR[type]!.channels;
  const bitsPerPixel = channels * depth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const expected = height * (rowBytes + 1);
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    throw new PngError("image data does not inflate to its size");
  }
  if (raw.length !== expected) throw new PngError("image data does not inflate to its size");

  // Unfilter in place, row by row (filter byte, then the row).
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const pixels = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (rowBytes + 1)]!;
    const src = y * (rowBytes + 1) + 1;
    const out = y * rowBytes;
    const prev = y > 0 ? out - rowBytes : -1;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? pixels[out + x - bpp]! : 0;
      const b = prev >= 0 ? pixels[prev + x]! : 0;
      const c = x >= bpp && prev >= 0 ? pixels[prev + x - bpp]! : 0;
      const v = raw[src + x]!;
      let r: number;
      switch (f) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new PngError("bad filter type");
      }
      pixels[out + x] = r & 0xff;
    }
  }

  // To RGBA, 8 bits.
  const rgba = new Uint8Array(width * height * 4);
  const sample = (row: number, i: number): number => {
    // The i-th sample of a row, scaled to 0–255.
    const base = row * rowBytes;
    if (depth === 8) return pixels[base + i]!;
    if (depth === 16) return pixels[base + i * 2]!;            // the high byte
    const bit = i * depth;
    const v = (pixels[base + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    return type === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  const raw16 = (row: number, i: number) => pixels.readUInt16BE(row * rowBytes + i * 2);
  const trnsKey = trns && (type === 0 || type === 2) ? (type === 0 ? [trns.length >= 2 ? trns.readUInt16BE(0) : -1] : trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null) : null;
  const rawGray = (row: number, x: number) => (depth === 16 ? raw16(row, x) : depth === 8 ? pixels[row * rowBytes + x]! : (pixels[row * rowBytes + ((x * depth) >> 3)]! >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r: number, g: number, b: number, a = 255;
      if (type === 0) {
        r = g = b = sample(y, x);
        if (trnsKey && rawGray(y, x) === trnsKey[0]) a = 0;
      } else if (type === 2) {
        r = sample(y, x * 3); g = sample(y, x * 3 + 1); b = sample(y, x * 3 + 2);
        if (trnsKey) {
          const k = depth === 16 ? [raw16(y, x * 3), raw16(y, x * 3 + 1), raw16(y, x * 3 + 2)] : [r, g, b];
          if (k[0] === trnsKey[0] && k[1] === trnsKey[1] && k[2] === trnsKey[2]) a = 0;
        }
      } else if (type === 3) {
        const i = sample(y, x);
        if (i * 3 + 2 >= palette!.length) throw new PngError("palette index out of range");
        r = palette![i * 3]!; g = palette![i * 3 + 1]!; b = palette![i * 3 + 2]!;
        if (trns && i < trns.length) a = trns[i]!;
      } else if (type === 4) {
        r = g = b = sample(y, x * 2); a = sample(y, x * 2 + 1);
      } else {
        r = sample(y, x * 4); g = sample(y, x * 4 + 1); b = sample(y, x * 4 + 2); a = sample(y, x * 4 + 3);
      }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    }
  }
  return { width, height, data: rgba };
}

function chunk(name: string, data: Uint8Array): Buffer {
  const type = Buffer.from(name, "latin1");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(type, data));
  return Buffer.concat([head, type, data, crc]);
}

/** An RGBA image as a PNG (colour type 6, 8 bits, filter 0 per row — small icons, size does not matter much). */
export function encodePng(img: Rgba): Buffer {
  const { width, height, data } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))]);
}

/**
 * Resize by area average: each target pixel is the coverage-weighted mean of the source pixels under it, with alpha
 * premultiplied so transparent edges do not darken. Good for shrinking (the icon's case); enlarging stays smooth enough.
 */
export function resize(src: Rgba, width: number, height: number): Rgba {
  const out = new Uint8Array(width * height * 4);
  const sx = src.width / width, sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * sy, y1 = y0 + sy;
    for (let x = 0; x < width; x++) {
      const x0 = x * sx, x1 = x0 + sx;
      let r = 0, g = 0, b = 0, a = 0, w = 0;
      for (let yy = Math.floor(y0); yy < Math.min(src.height, Math.ceil(y1)); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.min(src.width, Math.ceil(x1)); xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          const k = wx * wy;
          const i = (yy * src.width + xx) * 4;
          const al = src.data[i + 3]! / 255;
          r += src.data[i]! * al * k; g += src.data[i + 1]! * al * k; b += src.data[i + 2]! * al * k; a += al * k;
          w += k;
        }
      }
      const o = (y * width + x) * 4;
      const alpha = w ? a / w : 0;
      out[o] = alpha ? Math.round(r / a) : 0;
      out[o + 1] = alpha ? Math.round(g / a) : 0;
      out[o + 2] = alpha ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  return { width, height, data: out };
}

/** The image over a solid colour (iOS shows a touch icon's transparency as black). */
export function flatten(img: Rgba, rgb: [number, number, number]): Rgba {
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3]! / 255;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(img.data[i + c]! * a + rgb[c]! * (1 - a));
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

/** An ICO of PNG entries (Vista and every browser since): a 6-byte header, a 16-byte entry each, then the PNGs. */
export function encodeIco(pngs: Array<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);                 // 1 = icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header[e] = size >= 256 ? 0 : size;       // 0 means 256
    header[e + 1] = size >= 256 ? 0 : size;
    header[e + 2] = 0; header[e + 3] = 0;     // no palette, reserved
    header.writeUInt16LE(1, e + 4);           // planes
    header.writeUInt16LE(32, e + 6);          // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.png)]);
}
