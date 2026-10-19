/**
 * #2184: text jittered right after switching to a chat that was not kept. Measured (scripts/manual/smoke/
 * smoke-switch-jitter.mts): a photo near the bottom grew from 0 to its size as it decoded (168–195 px), and each time
 * older messages were drawn above, the pinned bottom moved by the change in the thread's sub-pixel height (0.64 px).
 * Fixed by giving photos their size before they load (read from the file's headers on the server, EXIF orientation
 * applied) and keeping the thread's height whole. These tests pin each piece.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { displaySize, jpegOrientation } from "../src/web-image-meta.js";
import { publicAttachment, sniffUpload, WebFileLedger } from "../src/web-upload.js";
import { WebChatHistory } from "../src/web-chat-history.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-2184-")); dirs.push(d); return d; };

const u16 = (v: number, le: boolean) => le ? [v & 255, v >> 8] : [v >> 8, v & 255];
const u32 = (v: number, le: boolean) => le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];
/** A JPEG's header: SOI, an optional APP1 Exif with IFD0's orientation, SOF0 with the size, EOI. */
function jpeg(w: number, h: number, orientation?: number, le = true): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (orientation !== undefined) {
    const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42, le), ...u32(8, le), ...u16(1, le),
      ...u16(0x0112, le), ...u16(3, le), ...u32(1, le), ...u16(orientation, le), 0, 0, ...u32(0, le)];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    parts.push(0xff, 0xe1, ...u16(body.length + 2, false), ...body);
  }
  parts.push(0xff, 0xc0, 0, 17, 8, ...u16(h, false), ...u16(w, false), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9);
  return Uint8Array.from(parts);
}
const png = (w: number, h: number) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...u32(w, false), ...u32(h, false), 8, 6, 0, 0, 0]);

describe("#2184: a photo's drawn size from its headers", () => {
  it("PNG, GIF, WebP and JPEG sizes; a JPEG turned by its EXIF orientation (5–8) is swapped, in either byte order", () => {
    expect(displaySize(png(1280, 960))).toEqual({ width: 1280, height: 960 });
    expect(displaySize(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...u16(64, true), ...u16(32, true)]))).toEqual({ width: 64, height: 32 });
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, ...[199, 0, 0], ...[99, 0, 0]]);
    expect(displaySize(webp)).toEqual({ width: 200, height: 100 });
    expect(displaySize(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 });
    for (const o of [1, 2, 3, 4]) expect(displaySize(jpeg(4032, 3024, o)), `orientation ${o}`).toEqual({ width: 4032, height: 3024 });
    for (const o of [5, 6, 7, 8]) for (const le of [true, false]) expect(displaySize(jpeg(4032, 3024, o, le)), `orientation ${o} ${le ? "II" : "MM"}`).toEqual({ width: 3024, height: 4032 });
    expect(jpegOrientation(jpeg(10, 10, 6, false))).toBe(6);
    expect(jpegOrientation(jpeg(10, 10, 9))).toBe(1);                       // out of range: as if none
  });
  it("not an image, a font, a size of 0, or a header cut short: no size", () => {
    expect(displaySize(Buffer.from("hello"))).toBeNull();
    expect(displaySize(Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]))).toBeNull();
    expect(displaySize(png(0, 960))).toBeNull();
    expect(displaySize(png(1280, 960).subarray(0, 20))).toBeNull();
    expect(displaySize(jpeg(4032, 3024, 6).subarray(0, 30))).toBeNull();
  });
});

describe("#2184: the size reaches the page", () => {
  it("a served photo carries it, read once from the file; a document does not; publicAttachment passes it on", () => {
    const d = scratch();
    const photo = join(d, "p.jpg"); writeFileSync(photo, jpeg(1280, 960, 6));
    const doc = join(d, "n.txt"); writeFileSync(doc, "hello");
    const ledger = new WebFileLedger();
    const p = ledger.registerServed({ path: photo, instance: "w", kind: "photo" })!;
    expect([p.width, p.height]).toEqual([960, 1280]);
    expect(publicAttachment(p)).toMatchObject({ width: 960, height: 1280 });
    const n = ledger.registerServed({ path: doc, instance: "w" })!;
    expect("width" in n || "width" in publicAttachment(n)).toBe(false);
    const bad = join(d, "bad.jpg"); writeFileSync(bad, "not a picture");
    expect("width" in publicAttachment(ledger.registerServed({ path: bad, instance: "w", kind: "photo" })!)).toBe(false);
  });
  it("one header buffer for every photo (not 256 KB each); a shorter file after a longer one reads only its own bytes", () => {
    const d = scratch();
    const ledger = new WebFileLedger();
    const big = join(d, "big.png"); writeFileSync(big, Buffer.concat([Buffer.from(png(1280, 960)), Buffer.alloc(300 * 1024, 7)]));
    const cut = join(d, "cut.png"); writeFileSync(cut, png(64, 32).subarray(0, 20));      // no room for the size
    const small = join(d, "small.gif"); writeFileSync(small, Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...u16(64, true), ...u16(32, true)]));
    const spy = vi.spyOn(Buffer, "allocUnsafe"), spyAlloc = vi.spyOn(Buffer, "alloc");
    try {
      const sizes = [big, cut, small, big].map((p) => { const f = ledger.registerServed({ path: p, instance: "w", kind: "photo" })!; return f.width ? [f.width, f.height] : null; });
      expect(sizes).toEqual([[1280, 960], null, [64, 32], [1280, 960]]);
      const heads = (fn: typeof spy) => fn.mock.calls.filter(([n]) => n === 256 * 1024).length;
      expect(heads(spy) + heads(spyAlloc as any), "at most one head buffer is made, and only once").toBeLessThanOrEqual(1);
    } finally { spy.mockRestore(); spyAlloc.mockRestore(); }
  });
  it("an upload the person sends carries it too (the message they see is drawn from it)", () => {
    const d = scratch();
    const bytes = png(300, 1000);
    const ledger = new WebFileLedger();
    const e = ledger.storeUpload({ instance: "w", inboxDir: join(d, "inbox"), bytes, name: "a.png", type: sniffUpload(bytes, "a.png")! });
    expect(publicAttachment(e)).toMatchObject({ kind: "photo", width: 300, height: 1000 });
  });
  it("the history keeps a valid size with the message and drops anything else; a restored file is measured again", () => {
    const h = new WebChatHistory();
    const base = { id: "a".repeat(32), kind: "photo" as const, name: "p.png", size: 10, mime: "image/png" };
    const m = h.record({ instance: "w", sender: "w", role: "agent", text: "", ts: new Date().toISOString(), attachments: [
      { ...base, width: 260, height: 195 }, { ...base, id: "b".repeat(32), width: 0, height: 5 }, { ...base, id: "c".repeat(32), width: 1.5 as any, height: 5 },
      { ...base, id: "d".repeat(32), width: "260" as any, height: 195 }] });
    expect(m.attachments!.map((a: any) => [a.width, a.height])).toEqual([[260, 195], [undefined, undefined], [undefined, undefined], [undefined, undefined]]);
  });
});

describe("#2184: after a restart", () => {
  it("a restored message's photo is measured again from its file (the size is never kept on disk)", () => {
    const h = new WebChatHistory({ boot: "bb" });
    h.setFiles({
      storablePath: () => null, drop: () => {},
      restore: (e) => ({ id: e.id, kind: "photo", size: 10, mime: "image/jpeg", width: 960, height: 1280 }),
    });
    const id = "e".repeat(32);
    h.restore("w", [{ boot: "aa", id: 1, instance: "w", role: "agent", sender: "w", text: "", ts: "2026-10-19T00:00:00.000Z",
      attachments: [{ id, path: "/x/p.jpg", kind: "photo", name: "p.jpg", size: 10, mime: "image/jpeg", width: 1, height: 1 }] }]);
    expect(h.list("w")[0]!.attachments).toEqual([{ id, kind: "photo", name: "p.jpg", size: 10, mime: "image/jpeg", width: 960, height: 1280 }]);
  });
});

describe("#2184: chat-render draws a photo in its box before it loads", () => {
  const c = vm.createContext({}); vm.runInContext(readFileSync(join(process.cwd(), "src", "ui", "chat-render.js"), "utf8"), c);
  const R = (c as any).AgendChatRender;
  const att = (o: Record<string, unknown>) => R.attachmentsHtml([{ id: "a".repeat(32), kind: "photo", name: "p", size: 1, mime: "image/png", ...o }], {});
  const box = (o: Record<string, unknown>) => { const m = /<img [^>]*?(?: width="(\d+)" height="(\d+)")?(?= loading)/.exec(att(o)); return m && m[1] ? [Number(m[1]), Number(m[2])] : null; };
  it("scaled down into 260 × 220 as the stylesheet draws it; a small one at its own size", () => {
    expect(box({ width: 1280, height: 960 })).toEqual([260, 195]);
    expect(box({ width: 300, height: 1000 })).toEqual([66, 220]);
    expect(box({ width: 100, height: 50 })).toEqual([100, 50]);
    expect(box({ width: 3024, height: 4032 })).toEqual([165, 220]);
  });
  it("no size, or one that is not two whole numbers in range: drawn as before (no box)", () => {
    for (const o of [{}, { width: 0, height: 10 }, { width: 10.5, height: 10 }, { width: "10", height: 10 }, { width: 70000, height: 10 }, { width: 10 }]) expect(box(o), JSON.stringify(o)).toBeNull();
    expect(att({})).toContain('loading="lazy"');
  });
  it("the stylesheet still bounds the box (260 × 220) — the attributes only reserve it", () => {
    const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
    expect(css).toMatch(/\.msg \.att-img img \{ max-width: 260px; max-height: 220px;/);
  });
});
