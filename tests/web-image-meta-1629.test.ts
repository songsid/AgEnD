/**
 * #1629 r4 §1 / §7.1: kinds by magic bytes, sizes from headers, and metadata removed by byte surgery — EXIF, GPS and
 * PNG tEXt are gone from what is kept, the image data is untouched, and a file that cannot be walked is refused.
 */
import { describe, expect, it } from "vitest";
import { imageSize, sniffMedia, stripMetadata } from "../src/web-image-meta.js";

const b = (...parts: Array<number[] | string | Uint8Array>) => Uint8Array.from(parts.flatMap(p => typeof p === "string" ? [...Buffer.from(p, "latin1")] : [...p]));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const png = (...chunks: Array<[string, Uint8Array | number[]]>) => b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ...chunks.flatMap(([t, d]) => [be32(d.length), t, Uint8Array.from(d), [0, 0, 0, 0]]));
const IHDR: [string, number[]] = ["IHDR", [...be32(640), ...be32(480), 8, 6, 0, 0, 0]];
const has = (hay: Uint8Array, needle: string) => Buffer.from(hay).includes(Buffer.from(needle, "latin1"));

describe("kinds by magic bytes", () => {
  it.each([
    ["png", png(IHDR, ["IEND", []])], ["jpeg", b([0xff, 0xd8, 0xff, 0xe0])], ["webp", b("RIFF", le32(4), "WEBP")],
    ["gif", b("GIF89a", [1, 0, 1, 0])], ["woff2", b("wOF2", [0, 0])],
  ])("%s", (kind, bytes) => expect(sniffMedia(bytes)).toBe(kind));
  it("SVG, HTML and text are none of them", () => {
    for (const s of ["<svg xmlns='http://www.w3.org/2000/svg'/>", "<html>", "GIF8", "RIFFxxxxWAVE"]) expect(sniffMedia(b(s))).toBeNull();
  });
});

describe("PNG", () => {
  it("tEXt, zTXt, iTXt, eXIf and tIME go; IHDR, IDAT and IEND stay; size from IHDR", () => {
    const file = png(IHDR, ["tEXt", [...Buffer.from("GPS\0 24.1,121.5")]], ["eXIf", [1, 2]], ["zTXt", [3]], ["iTXt", [4]], ["tIME", [5]], ["IDAT", [9, 9, 9]], ["IEND", []]);
    const out = stripMetadata(file, "png")!;
    expect([has(out, "tEXt"), has(out, "GPS"), has(out, "eXIf"), has(out, "zTXt"), has(out, "iTXt"), has(out, "tIME")]).toEqual([false, false, false, false, false, false]);
    expect(out).toEqual(png(IHDR, ["IDAT", [9, 9, 9]], ["IEND", []]));
    expect(imageSize(out, "png")).toEqual({ width: 640, height: 480 });
  });
  it("a truncated chunk, or no IEND, is refused", () => {
    const file = png(IHDR, ["IDAT", [9, 9, 9]], ["IEND", []]);
    expect(stripMetadata(file.subarray(0, file.length - 6), "png")).toBeNull();
    expect(stripMetadata(png(IHDR, ["IDAT", [1]]), "png")).toBeNull();
  });
});

describe("JPEG", () => {
  const seg = (m: number, data: number[] | string) => { const d = typeof data === "string" ? [...Buffer.from(data, "latin1")] : data; return [0xff, m, ((d.length + 2) >> 8) & 255, (d.length + 2) & 255, ...d]; };
  const SOF0 = seg(0xc0, [8, ...[0x01, 0xe0], ...[0x02, 0x80], 3]);   // 480 × 640
  it("APP1 (EXIF/GPS) … APP15 and COM go; APP0, SOF and the scan stay; size from SOF", () => {
    const file = b([0xff, 0xd8], seg(0xe0, "JFIF\0"), seg(0xe1, "Exif\0\0GPSLatitude"), seg(0xe2, "ICC_PROFILE"), seg(0xed, "Photoshop"), seg(0xfe, "a comment"), SOF0, seg(0xda, [1, 2]), [7, 7, 7, 0xff, 0xd9]);
    const out = stripMetadata(file, "jpeg")!;
    expect([has(out, "Exif"), has(out, "GPS"), has(out, "ICC"), has(out, "Photoshop"), has(out, "comment"), has(out, "JFIF")]).toEqual([false, false, false, false, false, true]);
    expect(out).toEqual(b([0xff, 0xd8], seg(0xe0, "JFIF\0"), SOF0, seg(0xda, [1, 2]), [7, 7, 7, 0xff, 0xd9]));
    expect(imageSize(out, "jpeg")).toEqual({ width: 640, height: 480 });
  });
  it("a segment running past the end is refused", () => {
    expect(stripMetadata(b([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2]), "jpeg")).toBeNull();
  });
  // #1883 review r1 (P2-4): a progressive file has several scans, with tables (and possibly comments) between them.
  const SOF2 = seg(0xc2, [8, ...[0x00, 0x04], ...[0x00, 0x04], 1, 1, 0x11, 0]);
  const DHT = seg(0xc4, [0, ...new Array(16).fill(0)]);
  const scan = (data: number[]) => [...seg(0xda, [1, 1, 0, 0, 63, 0]), ...data];
  it("metadata BETWEEN scans goes too; the scans' data (stuffed FF00, restart markers) is kept byte for byte", () => {
    const first = scan([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]), second = scan([0x78, 0x9a]);
    const file = b([0xff, 0xd8], seg(0xe0, "JFIF\0"), SOF2, DHT, first, seg(0xfe, "GPSLatitude 24.1"), DHT, seg(0xe1, "Exif\0\0x"), second, [0xff, 0xd9]);
    const out = stripMetadata(file, "jpeg")!;
    expect([has(out, "GPS"), has(out, "Exif")]).toEqual([false, false]);
    expect(out).toEqual(b([0xff, 0xd8], seg(0xe0, "JFIF\0"), SOF2, DHT, first, DHT, second, [0xff, 0xd9]));
  });
  it("a scan that never ends (no EOI) is refused; bytes after EOI are dropped", () => {
    expect(stripMetadata(b([0xff, 0xd8], SOF2, DHT, scan([1, 2, 3])), "jpeg")).toBeNull();
    expect(stripMetadata(b([0xff, 0xd8], SOF2, DHT, scan([1, 2, 3]), [0xff, 0xd9, 0x41, 0x42]), "jpeg")).toEqual(b([0xff, 0xd8], SOF2, DHT, scan([1, 2, 3]), [0xff, 0xd9]));
  });
});

describe("WebP", () => {
  const chunk = (t: string, d: number[]) => [...Buffer.from(t, "latin1"), ...le32(d.length), ...d, ...(d.length & 1 ? [0] : [])];
  const riff = (...chunks: number[][]) => { const body = chunks.flat(); return b("RIFF", le32(4 + body.length), "WEBP", body); };
  const VP8X = (flags: number) => chunk("VP8X", [flags, 0, 0, 0, ...[0x7f, 0x02, 0x00], ...[0xdf, 0x01, 0x00]]);   // 640 × 480
  it("EXIF and XMP chunks go, VP8X's flags follow, the RIFF size is rewritten; size from VP8X", () => {
    const file = riff(VP8X(0x0c | 0x10), chunk("EXIF", [...Buffer.from("GPS!!")]), chunk("XMP ", [...Buffer.from("<x:xmpmeta>")]), chunk("VP8L", [0x2f, 1, 2, 3, 4]));
    const out = stripMetadata(file, "webp")!;
    expect([has(out, "EXIF"), has(out, "GPS"), has(out, "XMP "), has(out, "xmpmeta")]).toEqual([false, false, false, false]);
    expect(out).toEqual(riff(VP8X(0x10), chunk("VP8L", [0x2f, 1, 2, 3, 4])));
    expect(imageSize(out, "webp")).toEqual({ width: 640, height: 480 });
  });
  it("a chunk longer than the file is refused", () => {
    expect(stripMetadata(b("RIFF", le32(40), "WEBP", "EXIF", le32(1000), [1, 2]), "webp")).toBeNull();
  });
  it("#1883 r1 (P2-4): a file shorter than its RIFF size says is refused, not cut to fit", () => {
    const whole = riff(VP8X(0x10), chunk("VP8L", [0x2f, 1, 2, 3, 4]));
    expect(stripMetadata(whole, "webp")).toEqual(whole);
    const claims = Uint8Array.from(whole); claims.set(le32(whole.length - 8 + 64), 4);   // says 64 bytes more than it has
    expect(stripMetadata(claims, "webp")).toBeNull();
  });
});
