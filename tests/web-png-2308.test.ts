/**
 * #2308: the app icon's PNG (src/web-png.ts) — decoding every colour type and bit depth the spec allows (each row filter
 * too), refusing what is malformed with a reason (never a crash, never an unbounded inflate), resampling, flattening,
 * and packing an ICO of PNGs.
 *
 * Isolation: pure functions over bytes built here (zlib and a CRC of the test's own).
 */
import { describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";

// The decoder's inflate, observed: what output limit it asks zlib for (a bomb must stop there, not after inflating).
const inflateLimits = vi.hoisted(() => [] as Array<number | undefined>);
vi.mock("node:zlib", async (original) => {
  const z = await original<typeof import("node:zlib")>();
  return { ...z, inflateSync: (buf: Buffer, opts?: { maxOutputLength?: number }) => { inflateLimits.push(opts?.maxOutputLength); return z.inflateSync(buf, opts); } };
});
import { decodePng, encodeIco, encodePng, flatten, PngError, resize, type Rgba } from "../src/web-png.js";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = TABLE[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(name: string, data: Buffer, badCrc = false): Buffer {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(name, "latin1"), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE((crc(body) ^ (badCrc ? 1 : 0)) >>> 0);
  return Buffer.concat([head, body, c]);
}
function ihdr(w: number, h: number, depth: number, type: number, interlace = 0): Buffer {
  const d = Buffer.alloc(13); d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = depth; d[9] = type; d[12] = interlace; return d;
}
/** A PNG from raw scanlines (each row already starts with its filter byte). */
function png(opts: { w: number; h: number; depth: number; type: number; rows: Buffer; plte?: Buffer; trns?: Buffer; extra?: Buffer[]; interlace?: number; idat?: Buffer; noEnd?: boolean }): Buffer {
  return Buffer.concat([SIG, chunk("IHDR", ihdr(opts.w, opts.h, opts.depth, opts.type, opts.interlace)), ...(opts.extra ?? []),
    ...(opts.plte ? [chunk("PLTE", opts.plte)] : []), ...(opts.trns ? [chunk("tRNS", opts.trns)] : []),
    chunk("IDAT", opts.idat ?? deflateSync(opts.rows)), ...(opts.noEnd ? [] : [chunk("IEND", Buffer.alloc(0))])]);
}
/** Rows of bytes, filter 0. */
const rows0 = (lines: number[][]) => Buffer.concat(lines.map((l) => Buffer.from([0, ...l])));
const px = (img: Rgba, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const LIM = { maxSide: 2048 };

describe("decoding every colour type and bit depth", () => {
  it("RGBA 8 round-trips through the encoder", () => {
    const img: Rgba = { width: 3, height: 2, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 1, 2, 3, 4, 250, 251, 252, 253, 9, 8, 7, 6]) };
    const back = decodePng(encodePng(img), LIM);
    expect([back.width, back.height, [...back.data]]).toEqual([3, 2, [...img.data]]);
  });

  it("RGB 8 and 16 (16-bit keeps the high byte), grey 8 and 16, grey+alpha 8 and 16", () => {
    expect(px(decodePng(png({ w: 1, h: 1, depth: 8, type: 2, rows: rows0([[10, 20, 30]]) }), LIM), 0, 0)).toEqual([10, 20, 30, 255]);
    expect(px(decodePng(png({ w: 1, h: 1, depth: 16, type: 2, rows: rows0([[0x12, 0xff, 0x34, 0x00, 0x56, 0x01]]) }), LIM), 0, 0)).toEqual([0x12, 0x34, 0x56, 255]);
    expect(px(decodePng(png({ w: 1, h: 1, depth: 8, type: 0, rows: rows0([[77]]) }), LIM), 0, 0)).toEqual([77, 77, 77, 255]);
    expect(px(decodePng(png({ w: 1, h: 1, depth: 16, type: 0, rows: rows0([[0x80, 0x01]]) }), LIM), 0, 0)).toEqual([0x80, 0x80, 0x80, 255]);
    expect(px(decodePng(png({ w: 1, h: 1, depth: 8, type: 4, rows: rows0([[90, 40]]) }), LIM), 0, 0)).toEqual([90, 90, 90, 40]);
    expect(px(decodePng(png({ w: 1, h: 1, depth: 16, type: 4, rows: rows0([[90, 0, 40, 0]]) }), LIM), 0, 0)).toEqual([90, 90, 90, 40]);
  });

  it("grey at 1, 2 and 4 bits is scaled to 0–255, packed several to a byte", () => {
    const one = decodePng(png({ w: 3, h: 1, depth: 1, type: 0, rows: rows0([[0b10100000]]) }), LIM);
    expect([0, 1, 2].map((x) => px(one, x, 0)[0])).toEqual([255, 0, 255]);
    const two = decodePng(png({ w: 4, h: 1, depth: 2, type: 0, rows: rows0([[0b00011011]]) }), LIM);
    expect([0, 1, 2, 3].map((x) => px(two, x, 0)[0])).toEqual([0, 85, 170, 255]);
    const four = decodePng(png({ w: 2, h: 1, depth: 4, type: 0, rows: rows0([[0xf3]]) }), LIM);
    expect([0, 1].map((x) => px(four, x, 0)[0])).toEqual([255, 51]);
  });

  it("palette at 1, 2, 4 and 8 bits, with tRNS alpha for the entries it lists", () => {
    const plte = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    const trns = Buffer.from([0, 128]);
    const p8 = decodePng(png({ w: 3, h: 1, depth: 8, type: 3, rows: rows0([[0, 1, 2]]), plte, trns }), LIM);
    expect([px(p8, 0, 0), px(p8, 1, 0), px(p8, 2, 0)]).toEqual([[255, 0, 0, 0], [0, 255, 0, 128], [0, 0, 255, 255]]);
    const p4 = decodePng(png({ w: 2, h: 1, depth: 4, type: 3, rows: rows0([[0x32]]), plte }), LIM);
    expect([px(p4, 0, 0), px(p4, 1, 0)]).toEqual([[9, 9, 9, 255], [0, 0, 255, 255]]);
    const p2 = decodePng(png({ w: 2, h: 1, depth: 2, type: 3, rows: rows0([[0b01100000]]), plte }), LIM);
    expect([px(p2, 0, 0), px(p2, 1, 0)]).toEqual([[0, 255, 0, 255], [0, 0, 255, 255]]);
    const p1 = decodePng(png({ w: 2, h: 1, depth: 1, type: 3, rows: rows0([[0b01000000]]), plte }), LIM);
    expect([px(p1, 0, 0), px(p1, 1, 0)]).toEqual([[255, 0, 0, 255], [0, 255, 0, 255]]);
  });

  it("tRNS on grey and RGB makes the one colour it names transparent (16-bit compared in full)", () => {
    const g = decodePng(png({ w: 2, h: 1, depth: 8, type: 0, rows: rows0([[5, 6]]), trns: Buffer.from([0, 5]) }), LIM);
    expect([px(g, 0, 0)[3], px(g, 1, 0)[3]]).toEqual([0, 255]);
    const g2 = decodePng(png({ w: 2, h: 1, depth: 2, type: 0, rows: rows0([[0b01100000]]), trns: Buffer.from([0, 2]) }), LIM);
    expect([px(g2, 0, 0)[3], px(g2, 1, 0)[3]]).toEqual([255, 0]);
    const rgb = decodePng(png({ w: 2, h: 1, depth: 8, type: 2, rows: rows0([[1, 2, 3, 1, 2, 4]]), trns: Buffer.from([0, 1, 0, 2, 0, 3]) }), LIM);
    expect([px(rgb, 0, 0)[3], px(rgb, 1, 0)[3]]).toEqual([0, 255]);
    const rgb16 = decodePng(png({ w: 2, h: 1, depth: 16, type: 2, rows: rows0([[1, 1, 2, 2, 3, 3, 1, 1, 2, 2, 3, 4]]), trns: Buffer.from([1, 1, 2, 2, 3, 3]) }), LIM);
    expect([px(rgb16, 0, 0)[3], px(rgb16, 1, 0)[3]]).toEqual([0, 255]);
  });

  it("every row filter (none, sub, up, average, Paeth) unfilters to the same pixels", () => {
    // Two RGB rows; each encoded with filter f, decoded must give the same picture.
    const raw = [[10, 20, 30, 40, 50, 60], [70, 80, 90, 15, 25, 35]];
    const bpp = 3;
    const paeth = (a: number, b: number, c: number) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
    const filtered = (f: number) => Buffer.concat(raw.map((row, y) => Buffer.from([f, ...row.map((v, x) => {
      const a = x >= bpp ? row[x - bpp]! : 0, b = y ? raw[y - 1]![x]! : 0, c = x >= bpp && y ? raw[y - 1]![x - bpp]! : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]!;
      return (v - pred) & 0xff;
    })])));
    const want = [...decodePng(png({ w: 2, h: 2, depth: 8, type: 2, rows: filtered(0) }), LIM).data];
    for (const f of [1, 2, 3, 4]) expect([...decodePng(png({ w: 2, h: 2, depth: 8, type: 2, rows: filtered(f) }), LIM).data], `filter ${f}`).toEqual(want);
  });

  it("Paeth breaks a tie the spec's way (up before upper-left)", () => {
    // Row 0: 5, 15. Row 1: 0, then 77 under Paeth — left 0, up 15, upper-left 5: |p-up| ties |p-upper-left| (5), so up.
    const rows = Buffer.from([0, 5, 15, 4, (0 - 5) & 0xff, (77 - 15) & 0xff]);     // the first pixel: Paeth picks up (5)
    expect([...decodePng(png({ w: 2, h: 2, depth: 8, type: 0, rows }), LIM).data].filter((_, i) => i % 4 === 0)).toEqual([5, 15, 0, 77]);
  });

  it("ancillary chunks are skipped; IDAT may be split", () => {
    const rows = rows0([[1, 2, 3, 4]]);
    const z = deflateSync(rows);
    const split = Buffer.concat([SIG, chunk("IHDR", ihdr(1, 1, 8, 6)), chunk("tEXt", Buffer.from("Comment\0hi")), chunk("IDAT", z.subarray(0, 3)), chunk("IDAT", z.subarray(3)), chunk("IEND", Buffer.alloc(0))]);
    expect(px(decodePng(split, LIM), 0, 0)).toEqual([1, 2, 3, 4]);
  });
});

describe("refusing what is malformed, with a reason", () => {
  const ok = { w: 1, h: 1, depth: 8, type: 6, rows: rows0([[1, 2, 3, 4]]) };
  const reason = (bytes: Buffer, limits = LIM) => { try { decodePng(bytes, limits); return "decoded"; } catch (e) { expect(e).toBeInstanceOf(PngError); return (e as Error).message; } };

  it("not a PNG, truncated, a bad CRC, IHDR not first, no IHDR / IDAT / IEND", () => {
    expect(reason(Buffer.from("\xff\xd8\xff\xe0JFIF", "latin1"))).toBe("not a PNG");
    expect(reason(png(ok).subarray(0, 30))).toBe("truncated chunk");
    expect(reason(Buffer.concat([SIG, chunk("IHDR", ihdr(1, 1, 8, 6), true)]))).toBe("bad chunk CRC");
    expect(reason(Buffer.concat([SIG, chunk("IDAT", deflateSync(ok.rows)), chunk("IHDR", ihdr(1, 1, 8, 6))]))).toBe("IHDR must come first");
    expect(reason(SIG)).toBe("no IHDR");
    expect(reason(Buffer.concat([SIG, chunk("IHDR", ihdr(1, 1, 8, 6)), chunk("IEND", Buffer.alloc(0))]))).toBe("no image data");
    expect(reason(png({ ...ok, noEnd: true }))).toBe("no IEND");
  });

  it("a bad IHDR: empty, too large, an unknown type or depth, interlaced, unknown methods; an unknown critical chunk", () => {
    expect(reason(png({ ...ok, w: 0 }))).toBe("empty image");
    expect(reason(png({ ...ok, w: 4096, h: 4096 }))).toBe("larger than 2048×2048");
    expect(reason(png({ ...ok, w: 3000, h: 10 }))).toBe("larger than 2048×2048");
    expect(reason(png({ ...ok, type: 5 }))).toBe("unknown colour type or bit depth");
    expect(reason(png({ ...ok, type: 2, depth: 4 }))).toBe("unknown colour type or bit depth");
    expect(reason(png({ ...ok, interlace: 1 }))).toBe("interlaced PNGs are not supported");
    expect(reason(png({ ...ok, interlace: 2 }))).toBe("unknown interlace method");
    const badMethod = ihdr(1, 1, 8, 6); badMethod[10] = 1;
    expect(reason(Buffer.concat([SIG, chunk("IHDR", badMethod), chunk("IDAT", deflateSync(ok.rows)), chunk("IEND", Buffer.alloc(0))]))).toBe("unknown compression or filter method");
    expect(reason(png({ ...ok, extra: [chunk("ZZZZ", Buffer.alloc(1))] }))).toBe("unknown critical chunk ZZZZ");
    expect(reason(Buffer.concat([SIG, chunk("IHDR", Buffer.alloc(12))]))).toBe("bad IHDR");
  });

  it("image data that does not inflate to exactly its size — a bomb stops at the expected size; short or corrupt data too", () => {
    const bomb = deflateSync(Buffer.alloc(50 * 1024 * 1024));       // 50 MB of zeros for a 1×1 image
    inflateLimits.length = 0;
    expect(reason(png({ ...ok, idat: bomb }))).toBe("image data does not inflate to its size");
    expect(inflateLimits).toEqual([5]);                              // 1 row: its filter byte + 4 bytes of RGBA, no more
    expect(reason(png({ ...ok, rows: Buffer.from([0, 1, 2]) }))).toBe("image data does not inflate to its size");
    expect(reason(png({ ...ok, idat: Buffer.from("not zlib at all") }))).toBe("image data does not inflate to its size");
  });

  it("a bad filter byte, a palette image without a palette or with an index past it, a bad palette", () => {
    expect(reason(png({ ...ok, rows: Buffer.from([5, 1, 2, 3, 4]) }))).toBe("bad filter type");
    expect(reason(png({ w: 1, h: 1, depth: 8, type: 3, rows: rows0([[0]]) }))).toBe("palette image without a palette");
    expect(reason(png({ w: 1, h: 1, depth: 8, type: 3, rows: rows0([[7]]), plte: Buffer.from([1, 2, 3]) }))).toBe("palette index out of range");
    expect(reason(png({ w: 1, h: 1, depth: 8, type: 3, rows: rows0([[0]]), plte: Buffer.from([1, 2]) }))).toBe("bad palette");
  });
});

describe("resampling, flattening, the ICO", () => {
  it("an area average: quadrants of a 4×4 become a 2×2 exactly", () => {
    const d = new Uint8Array(4 * 4 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) d.set(x < 2 ? (y < 2 ? [200, 0, 0, 255] : [0, 0, 200, 255]) : [0, 200, 0, 255], (y * 4 + x) * 4);
    const out = resize({ width: 4, height: 4, data: d }, 2, 2);
    expect([px(out, 0, 0), px(out, 1, 0), px(out, 0, 1), px(out, 1, 1)]).toEqual([[200, 0, 0, 255], [0, 200, 0, 255], [0, 0, 200, 255], [0, 200, 0, 255]]);
    const half = resize({ width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]) }, 1, 1);
    expect(px(half, 0, 0)).toEqual([128, 128, 128, 255]);
  });

  it("alpha is premultiplied: a transparent neighbour does not darken the colour", () => {
    const out = resize({ width: 2, height: 1, data: new Uint8Array([0, 0, 0, 0, 0, 0, 255, 255]) }, 1, 1);
    expect(px(out, 0, 0)).toEqual([0, 0, 255, 128]);
    expect(px(resize({ width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]) }, 1, 1), 0, 0)).toEqual([255, 0, 0, 128]);   // not 128 red
    expect(px(resize({ width: 1, height: 1, data: new Uint8Array([9, 9, 9, 0]) }, 1, 1), 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("enlarging stays within the source's colours; flattening puts it over a solid colour", () => {
    const up = resize({ width: 1, height: 1, data: new Uint8Array([10, 20, 30, 255]) }, 3, 3);
    expect(px(up, 2, 2)).toEqual([10, 20, 30, 255]);
    const flat = flatten({ width: 2, height: 1, data: new Uint8Array([0, 0, 0, 0, 100, 0, 0, 128]) }, [255, 255, 255]);
    expect([px(flat, 0, 0), px(flat, 1, 0)]).toEqual([[255, 255, 255, 255], [177, 127, 127, 255]]);
  });

  it("an ICO of PNG entries: header, one 16-byte entry each with its size and offset, the PNGs after", () => {
    const a = encodePng(resize({ width: 1, height: 1, data: new Uint8Array([1, 2, 3, 255]) }, 32, 32));
    const b = encodePng(resize({ width: 1, height: 1, data: new Uint8Array([1, 2, 3, 255]) }, 48, 48));
    const ico = encodeIco([{ size: 32, png: a }, { size: 48, png: b }]);
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 2]);
    const entry = (i: number) => ({ w: ico[6 + 16 * i], h: ico[7 + 16 * i], planes: ico.readUInt16LE(10 + 16 * i), bpp: ico.readUInt16LE(12 + 16 * i), len: ico.readUInt32LE(14 + 16 * i), at: ico.readUInt32LE(18 + 16 * i) });
    expect(entry(0)).toEqual({ w: 32, h: 32, planes: 1, bpp: 32, len: a.length, at: 38 });
    expect(entry(1)).toEqual({ w: 48, h: 48, planes: 1, bpp: 32, len: b.length, at: 38 + a.length });
    expect(decodePng(ico.subarray(entry(1).at, entry(1).at + entry(1).len), LIM).width).toBe(48);
    expect(encodeIco([{ size: 256, png: a }])[6]).toBe(0);              // 256 is written as 0
  });
});
