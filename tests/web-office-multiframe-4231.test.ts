/**
 * M-3394 (#4231): multi-sheet and frame-list animations in Office skin packs.
 * - Pack format (fleet-office-pack.js): single-image strips stay unchanged; multi-sheet `src: [...]` (with uniform
 *   per-sheet `frames` or per-sheet `[n1, n2, …]`), frame-list `frames: [{ src, ms? }]`, per-frame `durations`, `once`,
 *   and `loopFrom` (intro + loop) are checked strictly with sheet/frame/duration caps.
 * - Playback (stripFrameAt, stripCell, createClipClocks, spriteSkin): seamless across sheet boundaries, supports 5–10 s+
 *   (300+ frames at 30 FPS), variable durations, once/loopFrom clip starts, reduced motion (ms = 0 always frame 0),
 *   and fallback if any sheet fails to load.
 * - Host validation, storage, agent folder reader & share-link pruning (web-office-skins.ts, web-office-pack-read.ts,
 *   office-share.ts): per-sheet PNG dimension checks, total decoded pixel cap (SKIN_LIMITS.packPixels), disk reload,
 *   and share pruning of unused character sets' sheets.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as PK from "../src/ui/fleet-office-pack.js";
// @ts-expect-error fleet-office-skin.js is plain browser JS without a .d.ts
import * as K from "../src/ui/fleet-office-skin.js";
import { OfficeSkinStore, SKIN_LIMITS, checkSkinUpload } from "../src/web-office-skins.js";
import { readPackSources } from "../src/web-office-pack-read.js";
import { OfficeShareView } from "../src/office-share.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const BASE_MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const BG_PNG = readFileSync(join(FIXTURE, "office_bg.png"));
const FOX_PNG = readFileSync(join(FIXTURE, "fox_idle.png"));

/** A minimal valid RGBA PNG of w×h (dimensions only; tiny IDAT). */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), c = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-m3394-")); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("checkStrip: single-sheet compat, multi-sheet (#4231), frame-list & durations (M-3394)", () => {
  it("keeps classic single-sheet checked output shape unchanged", () => {
    const st = PK.checkStrip({ src: "idle.png", frames: 4, w: 32, h: 48, fps: 4 });
    expect(st).toEqual({ src: "idle.png", frames: 4, w: 32, h: 48, fps: 4, ax: 16, ay: 48, dw: 64, dh: 96 });
    expect("sheets" in st).toBe(false);
    expect("durations" in st).toBe(false);
    expect("once" in st).toBe(false);
    expect("loopFrom" in st).toBe(false);
  });

  it("accepts multi-sheet src arrays with uniform per-sheet frames (300 frames = 10 s at 30 FPS) and per-sheet counts", () => {
    const srcs = Array.from({ length: 10 }, (_, i) => `work_${i + 1}.png`);
    const uniform = PK.checkStrip({ src: srcs, frames: 30, w: 32, h: 48, fps: 30 });
    expect(uniform.frames).toBe(300);
    expect(uniform.src).toBe("work_1.png");
    expect(uniform.sheets).toHaveLength(10);
    expect(uniform.sheets![9]).toEqual({ src: "work_10.png", frames: 30 });
    expect(PK.stripImages(uniform)).toEqual(srcs);

    const ragged = PK.checkStrip({ src: ["a.png", "b.png", "c.png"], frames: [32, 32, 12], w: 32, h: 48, fps: 12, loopFrom: 32 });
    expect(ragged.frames).toBe(76);
    expect(ragged.loopFrom).toBe(32);
    expect(ragged.sheets).toEqual([{ src: "a.png", frames: 32 }, { src: "b.png", frames: 32 }, { src: "c.png", frames: 12 }]);
  });

  it("accepts frame-list [{ src, ms? }] with repeated src reuse and optional fallback fps", () => {
    const st = PK.checkStrip({
      w: 32, h: 48, fps: 5,
      frames: [
        { src: "sit.png", ms: 2000 },
        { src: "blink.png", ms: 120 },
        { src: "sit.png" }, // falls back to 1000 / 5 = 200 ms
        { src: "sip.png", ms: 450 },
      ],
    });
    expect(st.src).toBe("sit.png");
    expect(st.frames).toBe(4);
    expect(st.durations).toEqual([2000, 120, 200, 450]);
    expect(PK.stripImages(st)).toEqual(["sit.png", "blink.png", "sip.png"]);

    // Without any ms, uses fps directly (no durations array).
    const fixed = PK.checkStrip({ w: 32, h: 48, fps: 8, frames: [{ src: "a.png" }, { src: "b.png" }] });
    expect(fixed.durations).toBeUndefined();
    expect(fixed.fps).toBe(8);
  });

  it("accepts durations, once, and loopFrom on single-sheet and multi-sheet strips", () => {
    const d1 = PK.checkStrip({ src: "idle.png", frames: 3, durations: [1500, 100, 400], w: 32, h: 48, once: true });
    expect(d1.durations).toEqual([1500, 100, 400]);
    expect(d1.once).toBe(true);

    const d2 = PK.checkStrip({ src: ["a.png", "b.png"], frames: [2, 2], durations: [500, 500, 100, 100], w: 32, h: 48, loopFrom: 2 });
    expect(d2.durations).toEqual([500, 500, 100, 100]);
    expect(d2.loopFrom).toBe(2);
  });

  it.each([
    ["empty src array", { src: [], frames: 1, w: 32, h: 48 }, "strip.src: at least 1 file"],
    ["too many sheets", { src: Array.from({ length: 33 }, (_, i) => `s${i}.png`), frames: 1, w: 32, h: 48 }, "strip.src: at most 32"],
    ["bad path in src array", { src: ["ok.png", "../bad.png"], frames: 2, w: 32, h: 48 }, "strip.src[1]: a file name in the pack"],
    ["frames array length mismatch", { src: ["a.png", "b.png"], frames: [4], w: 32, h: 48 }, "strip.frames: must have 2 entries"],
    ["per-sheet frames > 32", { src: ["a.png", "b.png"], frames: [33, 1], w: 32, h: 48 }, "strip.frames[0]: a whole number from 1 to 32"],
    ["total frames > 600", { src: Array.from({ length: 20 }, (_, i) => `s${i}.png`), frames: 31, w: 32, h: 48 }, "strip.frames: at most 600 frames in all"],
    ["single-sheet frames > 32", { src: "a.png", frames: 33, w: 32, h: 48 }, "strip.frames: a whole number from 1 to 32"],
    ["durations with fps", { src: "a.png", frames: 2, fps: 4, durations: [100, 100], w: 32, h: 48 }, "strip.durations: cannot be used with fps"],
    ["durations length mismatch", { src: "a.png", frames: 3, durations: [100, 100], w: 32, h: 48 }, "strip.durations: must have 3 entries"],
    ["duration below minMs (33)", { src: "a.png", frames: 2, durations: [32, 100], w: 32, h: 48 }, "strip.durations[0]: a whole number from 33 to 60000"],
    ["duration above maxMs (60000)", { src: "a.png", frames: 2, durations: [100, 60001], w: 32, h: 48 }, "strip.durations[1]: a whole number from 33 to 60000"],
    ["frame list empty", { frames: [], w: 32, h: 48 }, "strip.frames: at least 1 frame"],
    ["frame list > 600", { frames: Array.from({ length: 601 }, () => ({ src: "a.png" })), w: 32, h: 48 }, "strip.frames: at most 600"],
    ["frame list with durations", { frames: [{ src: "a.png" }], durations: [100], w: 32, h: 48 }, "strip.durations: use ms on each entry in frames"],
    ["frame list with fps: 0 and ms", { frames: [{ src: "a.png", ms: 100 }], fps: 0, w: 32, h: 48 }, "strip.fps: 0 cannot be used with frame ms"],
    ["frame entry unknown key", { frames: [{ src: "a.png", delay: 100 }], w: 32, h: 48 }, 'strip.frames[0]: unknown key "delay"'],
    ["frame entry ms too small", { frames: [{ src: "a.png", ms: 10 }], w: 32, h: 48 }, "strip.frames[0].ms: a whole number from 33 to 60000"],
    ["once not boolean", { src: "a.png", frames: 2, once: "yes", w: 32, h: 48 }, "strip.once: true or false"],
    ["loopFrom with once", { src: "a.png", frames: 4, once: true, loopFrom: 1, w: 32, h: 48 }, "strip.loopFrom: cannot be used with once"],
    ["loopFrom out of range", { src: "a.png", frames: 4, loopFrom: 4, w: 32, h: 48 }, "strip.loopFrom: a whole number from 0 to 3"],
    ["unknown strip key (loop)", { src: "a.png", frames: 4, loop: true, w: 32, h: 48 }, 'strip: unknown key "loop"'],
  ])("refuses %s", (_what, raw, expected) => {
    expect(() => PK.checkStrip(raw)).toThrow(expected);
  });
});

describe("playback math: stripFrameAt, stripCell, stripMaxFps, createClipClocks", () => {
  it("plays 300-frame 30 FPS multi-sheet strip seamlessly across all 10 sheets and wraps cleanly", () => {
    const srcs = Array.from({ length: 10 }, (_, i) => `s${i}.png`);
    const st = PK.checkStrip({ src: srcs, frames: 30, w: 32, h: 48, fps: 30 });
    expect(PK.stripFrameAt(st, 0)).toBe(0);
    expect(PK.stripCell(st, 0)).toEqual({ src: "s0.png", col: 0 });
    // Exact sheet boundary: frame 29 is last col of s0.png, frame 30 is col 0 of s1.png.
    expect(PK.stripCell(st, 29)).toEqual({ src: "s0.png", col: 29 });
    expect(PK.stripCell(st, 30)).toEqual({ src: "s1.png", col: 0 });
    // Mid-way (5.0 s = frame 150 → s5.png col 0) and last frame (9.98 s = frame 299 → s9.png col 29).
    const mid = PK.stripFrameAt(st, 5000);
    expect(mid).toBe(150);
    expect(PK.stripCell(st, mid)).toEqual({ src: "s5.png", col: 0 });
    const end = PK.stripFrameAt(st, 9980);
    expect(end).toBe(299);
    expect(PK.stripCell(st, end)).toEqual({ src: "s9.png", col: 29 });
    // Wrap at 10.0 s back to s0.png col 0.
    const wrap = PK.stripFrameAt(st, 10000);
    expect(wrap).toBe(0);
    expect(PK.stripCell(st, wrap)).toEqual({ src: "s0.png", col: 0 });
  });

  it("handles variable durations, once, loopFrom, and reduced motion (ms <= 0 always frame 0)", () => {
    const loopDur = PK.checkStrip({ src: "a.png", frames: 3, durations: [100, 200, 300], w: 32, h: 48 });
    expect([0, 1, 99, 100, 299, 300, 599, 600, 700].map((t) => PK.stripFrameAt(loopDur, t))).toEqual([0, 0, 0, 1, 1, 2, 2, 0, 1]);

    const onceDur = PK.checkStrip({ src: "a.png", frames: 3, durations: [100, 200, 300], w: 32, h: 48, once: true });
    expect([0, 99, 100, 599, 600, 99999].map((t) => PK.stripFrameAt(onceDur, t))).toEqual([0, 0, 1, 2, 2, 2]);
    expect(PK.stripFrameAt(onceDur, -50)).toBe(0); // reduced motion / non-positive always 0

    // Intro [frame 0: 100ms], then loop [frame 1: 200ms, frame 2: 300ms] (span 500ms).
    const introDur = PK.checkStrip({ src: "a.png", frames: 3, durations: [100, 200, 300], w: 32, h: 48, loopFrom: 1 });
    expect([0, 50, 100, 299, 300, 599, 600, 799, 800, 1100].map((t) => PK.stripFrameAt(introDur, t))).toEqual([0, 0, 1, 1, 2, 2, 1, 1, 2, 1]);

    // Fixed fps with once and loopFrom.
    const onceFps = PK.checkStrip({ src: ["a.png", "b.png"], frames: [2, 2], w: 32, h: 48, fps: 10, once: true });
    expect([0, 50, 100, 250, 350, 10000].map((t) => PK.stripFrameAt(onceFps, t))).toEqual([0, 0, 1, 2, 3, 3]);

    const introFps = PK.checkStrip({ src: ["a.png", "b.png"], frames: [2, 3], w: 32, h: 48, fps: 10, loopFrom: 2 });
    // Frames 0,1 are intro (0..199ms), frames 2,3,4 loop forever (200ms+).
    expect([0, 100, 200, 300, 400, 500, 600, 700].map((t) => PK.stripFrameAt(introFps, t))).toEqual([0, 1, 2, 3, 4, 2, 3, 4]);
  });

  it("computes stripMaxFps / packMaxFps accurately and manages clip clocks per strip reference", () => {
    const sSlow = PK.checkStrip({ src: "a.png", frames: 4, w: 32, h: 48, fps: 4 });
    const sFast = PK.checkStrip({ src: ["a.png", "b.png"], frames: [10, 10], w: 32, h: 48, fps: 30 });
    const sVar = PK.checkStrip({ frames: [{ src: "a.png", ms: 2000 }, { src: "b.png", ms: 50 }], w: 32, h: 48 });
    expect(PK.stripMaxFps(sSlow)).toBe(4);
    expect(PK.stripMaxFps(sFast)).toBe(30);
    expect(PK.stripMaxFps(sVar)).toBe(20);
    expect(PK.stripMaxFps(PK.checkStrip({ src: "a.png", frames: 1, w: 32, h: 48, fps: 30 }))).toBe(0);

    const m = BASE_MANIFEST();
    m.characters.default.working = { src: ["w1.png", "w2.png"], frames: [30, 30], w: 32, h: 48, fps: 24 };
    const checked = PK.checkSkinPack(m);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(PK.packMaxFps(checked.pack)).toBe(24);

    const clocks = PK.createClipClocks();
    expect(clocks.elapsed("c:atlas", sSlow, 1000)).toBe(0);
    expect(clocks.elapsed("c:atlas", sSlow, 1250)).toBe(250);
    // Changing strip resets elapsed to 0 cleanly.
    expect(clocks.elapsed("c:atlas", sFast, 1300)).toBe(0);
    expect(clocks.elapsed("c:atlas", sFast, 1500)).toBe(200);
    // Prune drops absent keys; re-entering starts from 0.
    clocks.prune(new Set(["c:other"]));
    expect(clocks.elapsed("c:atlas", sFast, 1600)).toBe(0);
    // ms <= 0 returns 0 without mutating clock.
    expect(clocks.elapsed("c:atlas", sFast, 0)).toBe(0);
  });
});

describe("host upload, storage, folder reader & share-link pruning", () => {
  it("validates every sheet's PNG dimensions, persists to OfficeSkinStore, and reloads cleanly", () => {
    const m = BASE_MANIFEST();
    m.id = "multi-anim";
    m.characters.default = {
      idle: m.characters.default.idle, // classic single-sheet mixed with new formats
      working: { src: ["work_1.png", "work_2.png"], frames: [4, 2], w: 32, h: 48, fps: 24, loopFrom: 2 },
      needs: { w: 32, h: 48, frames: [{ src: "n_a.png", ms: 500 }, { src: "n_b.png", ms: 200 }, { src: "n_a.png", ms: 500 }] },
    };
    const files: Record<string, string> = {
      "office_bg.png": BG_PNG.toString("base64"),
      "fox_idle.png": FOX_PNG.toString("base64"),
      "work_1.png": png(4 * 32, 48).toString("base64"),
      "work_2.png": png(2 * 32, 48).toString("base64"),
      "n_a.png": png(32, 48).toString("base64"),
      "n_b.png": png(32, 48).toString("base64"),
    };
    const ok = checkSkinUpload({ manifest: m, files }, "tester", 100);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(Object.keys(ok.record.files).sort()).toEqual(["fox_idle.png", "n_a.png", "n_b.png", "office_bg.png", "work_1.png", "work_2.png"]);

    // Wrong dimensions on sheet 2 is refused.
    const badSheet = checkSkinUpload({ manifest: m, files: { ...files, "work_2.png": png(3 * 32, 48).toString("base64") } }, "tester", 100);
    expect(badSheet).toMatchObject({ ok: false, status: 400, error: "skin_strip_dimensions" });
    if (!badSheet.ok) expect(badSheet.detail).toContain("work_2.png");

    // Wrong dimensions on frame-list image is refused.
    const badFrame = checkSkinUpload({ manifest: m, files: { ...files, "n_b.png": png(64, 48).toString("base64") } }, "tester", 100);
    expect(badFrame).toMatchObject({ ok: false, status: 400, error: "skin_strip_dimensions" });
    if (!badFrame.ok) expect(badFrame.detail).toContain("n_b.png");

    // Missing sheet 2 is refused.
    const { "work_2.png": _drop, ...missingFiles } = files;
    expect(checkSkinUpload({ manifest: m, files: missingFiles }, "tester", 100)).toMatchObject({ ok: false, status: 400, error: "skin_file_missing", detail: "work_2.png: named by the manifest, not sent" });

    // Round-trip save and reload from disk.
    const dataDir = scratch();
    const store1 = new OfficeSkinStore(dataDir);
    expect(store1.add({ manifest: m, files }, "tester").ok).toBe(true);
    const store2 = new OfficeSkinStore(dataDir);
    const reloaded = store2.pack("multi-anim");
    expect(reloaded?.characters.default?.working?.frames).toBe(6);
    expect(reloaded?.characters.default?.working?.sheets).toHaveLength(2);
    expect(reloaded?.characters.default?.needs?.durations).toEqual([500, 200, 500]);
  });

  it("enforces SKIN_LIMITS.packPixels (96 Mpx decoded pixel cap)", () => {
    const m = BASE_MANIFEST();
    m.id = "huge-pixels";
    // 5 furniture items each referencing a 4096×3584 PNG (14.68 Mpx each → 5 × 14.68 = 73.4 Mpx > 64 Mpx),
    // while each single PNG is <= 16 Mpx and tiny compressed bytes.
    const big = png(4096, 3584).toString("base64"); // 14,680,064 px < 16 Mpx; 8 frames of 512×3584? No, h max is 512!
    // Use 4096×512 = 2,097,152 px (2 Mpx) × 49 files = 98 Mpx > 96 Mpx!
    const strip2M = png(4096, 512).toString("base64");
    const files: Record<string, string> = { "office_bg.png": BG_PNG.toString("base64"), "fox_idle.png": FOX_PNG.toString("base64") };
    m.furniture = [];
    for (let i = 0; i < 49; i++) {
      const f = `big_${i}.png`;
      m.furniture.push({ id: `f${i}`, sprite: { src: f, frames: 8, w: 512, h: 512 }, x: 10, y: 10 });
      files[f] = strip2M;
    }
    expect(big.length).toBeGreaterThan(0);
    const refused = checkSkinUpload({ manifest: m, files }, "tester", 1);
    expect(refused).toMatchObject({ ok: false, status: 400, error: "skin_too_many_pixels" });

    // 47 × 2 Mpx = 94 Mpx (+ bg/fox < 0.3 Mpx) <= 96 Mpx passes.
    m.furniture = m.furniture.slice(0, 47);
    for (let i = 47; i < 49; i++) delete files[`big_${i}.png`];
    expect(SKIN_LIMITS.packPixels).toBe(96 * 1024 * 1024);
    expect(checkSkinUpload({ manifest: m, files }, "tester", 1).ok).toBe(true);
  });

  it("readPackSources reads all sheets & frame-list images from a pack folder", async () => {
    const ws = scratch(), packDir = join(ws, "my-pack");
    mkdirSync(packDir, { recursive: true });
    const m = BASE_MANIFEST();
    m.id = "folder-multi";
    m.characters.default.working = { src: ["w1.png", "w2.png"], frames: [2, 2], w: 32, h: 48, fps: 12 };
    m.characters.default.needs = { w: 32, h: 48, frames: [{ src: "n1.png", ms: 200 }, { src: "n2.png", ms: 300 }] };
    writeFileSync(join(packDir, "manifest.json"), JSON.stringify(m));
    writeFileSync(join(packDir, "office_bg.png"), BG_PNG);
    writeFileSync(join(packDir, "fox_idle.png"), FOX_PNG);
    writeFileSync(join(packDir, "w1.png"), png(64, 48));
    writeFileSync(join(packDir, "w2.png"), png(64, 48));
    writeFileSync(join(packDir, "n1.png"), png(32, 48));
    writeFileSync(join(packDir, "n2.png"), png(32, 48));

    const res = await readPackSources({ dir: packDir }, { workspace: ws, stateDir: join(ws, ".state") });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect([...res.packs[0]!.files.keys()].sort()).toEqual(["fox_idle.png", "n1.png", "n2.png", "office_bg.png", "w1.png", "w2.png"]);
  });

  it("OfficeShareView.pack keeps worn multi-sheet files and prunes unworn character sets' sheets", () => {
    const m = BASE_MANIFEST();
    m.characters.default.working = { src: ["def_w1.png", "def_w2.png"], frames: [2, 2], w: 32, h: 48, fps: 12 };
    m.characters.hiddenSet = { idle: { src: ["hid_1.png", "hid_2.png"], frames: [2, 2], w: 32, h: 48, fps: 12 } };
    m.byInstance = { alpha: "default", ghost: "hiddenSet" };
    const answer = {
      id: m.id, name: m.id, sha: "a".repeat(32), manifest: m,
      files: { "office_bg.png": "1", "fox_idle.png": "2", "def_w1.png": "3", "def_w2.png": "4", "hid_1.png": "5", "hid_2.png": "6" },
    };
    const view = new OfficeShareView({ office: "o1", text: false }, {
      status: () => ({ instances: [{ name: "alpha", status: "running" }, { name: "ghost", status: "running" }] }),
      org: () => ({ general: ["alpha"], teams: [] }),
      offices: () => ({ rev: 1, offices: [{ id: "o1", name: "Main", skin: m.id, members: ["alpha"] }] }),
      acts: () => [],
      traffic: () => ({ now: "", items: [] }),
      needs: () => [],
      hidden: () => false,
    });
    const cut = view.pack(answer) as { files: Record<string, string>; manifest: any };
    expect(Object.keys(cut.files).sort()).toEqual(["def_w1.png", "def_w2.png", "fox_idle.png", "office_bg.png"]);
    expect(cut.manifest.characters).not.toHaveProperty("hiddenSet");
  });
});

describe("spriteSkin & loadPackSkin: rendering across sheets, clip clocks, reduced motion, fallback", () => {
  const mkCtx = () => {
    const draws: Array<{ im: any; sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number; mirrored: boolean }> = [];
    let scaleX = 1;
    const stack: number[] = [];
    const ctx: any = {
      imageSmoothingEnabled: true,
      globalAlpha: 1,
      save() { stack.push(scaleX); },
      restore() { scaleX = stack.pop() ?? 1; },
      translate() {},
      scale(x: number) { scaleX *= x; },
      drawImage(im: any, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) {
        draws.push({ im, sx, sy, sw, sh, dx, dy, dw, dh, mirrored: scaleX < 0 });
      },
      fillRect() {}, strokeRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, fillText() {},
      measureText: (s: string) => ({ width: s.length * 6 }),
    };
    return { ctx, draws };
  };

  it("draws the right sheet and column across sheet boundaries, respects once/loopFrom via env.clock, and freezes at frame 0 when ms=0", () => {
    const m = BASE_MANIFEST();
    m.characters.default.working = { src: ["s0.png", "s1.png"], frames: [2, 2], w: 32, h: 48, fps: 10, loopFrom: 1 };
    m.characters.default.needs = { w: 32, h: 48, once: true, frames: [{ src: "n0.png", ms: 100 }, { src: "n1.png", ms: 100 }] };
    const checked = PK.checkSkinPack(m);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    const imgs = new Map<string, any>([
      ["office_bg.png", { tag: "bg" }], ["fox_idle.png", { tag: "idle" }],
      ["s0.png", { tag: "s0" }], ["s1.png", { tag: "s1" }],
      ["n0.png", { tag: "n0" }], ["n1.png", { tag: "n1" }],
    ]);
    const skin = K.spriteSkin(checked.pack, imgs);
    const clocks = PK.createClipClocks();
    const env = { pal: K.DEFAULT_PAL, mode: "dark", clock: (k: string, st: any, t: number) => clocks.elapsed(k, st, t) };
    const desk = { key: "zone/a", seat: { x: 200, y: 200 }, x: 176, y: 148, w: 48, h: 66 };
    const workingLook = { name: "a", label: "A", state: "working", pose: "working", coat: "#fff", free: true };

    const { ctx, draws } = mkCtx();
    // Clip starts at wall time 5000 ms → elapsed 0 → s0 col 0.
    skin.drawCharacter(ctx, desk, workingLook, 5000, env);
    // +100 ms → frame 1 → s0 col 1 (loop start).
    skin.drawCharacter(ctx, desk, workingLook, 5100, env);
    // +200 ms → frame 2 → s1 col 0 (crossed sheet boundary!).
    skin.drawCharacter(ctx, desk, workingLook, 5200, env);
    // +300 ms → frame 3 → s1 col 1.
    skin.drawCharacter(ctx, desk, workingLook, 5300, env);
    // +400 ms → wraps to loopFrom=1 → s0 col 1 (intro frame 0 skipped!).
    skin.drawCharacter(ctx, desk, workingLook, 5400, env);
    // Reduced motion (ms = 0) → always s0 col 0.
    skin.drawCharacter(ctx, desk, workingLook, 0, env);

    expect(draws.map((d) => [d.im.tag, d.sx])).toEqual([
      ["s0", 0], ["s0", 32], ["s1", 0], ["s1", 32], ["s0", 32], ["s0", 0],
    ]);

    // Switch pose to `needs` (once: true) at t = 6000 ms → plays n0 (0..99ms), then holds n1 forever.
    draws.length = 0;
    const needsLook = { ...workingLook, state: "needs", pose: "needs" };
    skin.drawCharacter(ctx, desk, needsLook, 6000, env);
    skin.drawCharacter(ctx, desk, needsLook, 6150, env);
    skin.drawCharacter(ctx, desk, needsLook, 99999, env);
    expect(draws.map((d) => [d.im.tag, d.sx])).toEqual([["n0", 0], ["n1", 0], ["n1", 0]]);
  });

  it("falls back to base skin if any sheet of a multi-sheet strip is missing (no partial flicker)", () => {
    const m = BASE_MANIFEST();
    m.characters.default.working = { src: ["s0.png", "s1.png"], frames: [2, 2], w: 32, h: 48, fps: 10 };
    const checked = PK.checkSkinPack(m);
    if (!checked.ok) throw new Error(checked.error);
    const imgs = new Map<string, any>([["office_bg.png", { tag: "bg" }], ["fox_idle.png", { tag: "idle" }], ["s0.png", { tag: "s0" }]]); // s1 missing!
    const baseDraw = vi.fn();
    const skin = K.spriteSkin(checked.pack, imgs, { ...K.pixelSkin, drawCharacter: baseDraw });
    const { ctx, draws } = mkCtx();
    skin.drawCharacter(ctx, { key: "k", seat: { x: 100, y: 100 } }, { name: "a", pose: "working", coat: "#fff", free: true }, 50, { pal: K.DEFAULT_PAL, mode: "dark" });
    expect(draws).toHaveLength(0);
    expect(baseDraw).toHaveBeenCalledTimes(1);
  });

  it("loadPackSkin fetches every sheet in a multi-sheet pack", async () => {
    const m = BASE_MANIFEST();
    m.id = "load-multi";
    m.characters.default.working = { src: ["s0.png", "s1.png"], frames: [2, 2], w: 32, h: 48, fps: 12 };
    const files = { "office_bg.png": "1".repeat(32), "fox_idle.png": "2".repeat(32), "s0.png": "3".repeat(32), "s1.png": "4".repeat(32) };
    const loadedUrls: string[] = [];
    const sk = await K.loadPackSkin("load-multi", "sha1", {
      fetch: async () => ({ ok: true, json: async () => ({ manifest: m, files }) }) as any,
      image: async (url: string) => { loadedUrls.push(url); return { url }; },
    });
    expect(sk).not.toBeNull();
    expect(loadedUrls.sort()).toEqual([
      `/ui/office-skins/load-multi/img/${"1".repeat(32)}.png`,
      `/ui/office-skins/load-multi/img/${"2".repeat(32)}.png`,
      `/ui/office-skins/load-multi/img/${"3".repeat(32)}.png`,
      `/ui/office-skins/load-multi/img/${"4".repeat(32)}.png`,
    ]);
  });
});
