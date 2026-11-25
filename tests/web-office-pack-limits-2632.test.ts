/**
 * #2632: a skin pack can hold a whole fleet — SKIN_LIMITS (src/web-office-skins.ts) 220 files and 42 MiB a pack (was 64, then 160;
 * 6, then 20 MiB); 4 MiB a file (was 2), the side cap unchanged.
 * - Files: a pack of 220 named files passes checkSkinUpload; 221 is skin_too_many_files.
 * - Bytes: kept pictures of exactly 42 MiB in all pass; one byte more is skin_too_large (each file still within 4 MiB).
 * - The wire: SKIN_WIRE_BYTES (the POST /ui/office-skins body cap, web-api.ts) admits a full 42 MiB pack's base64 plus a
 *   manifest at its cap, and both packs above are kept end to end through the route.
 * Pictures are tiny synthetic PNGs (a 1×1 padded with a private chunk for the byte case), never decoded by the host.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => { throw new Error(`pack limits: no child process may start (${name})`); };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});

const { FleetManager } = await import("../src/fleet-manager.js");
const { SKIN_LIMITS, SKIN_WIRE_BYTES, checkSkinPicture, checkSkinUpload } = await import("../src/web-office-skins.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");

const MiB = 1024 * 1024;
const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const fixture = (f: string) => readFileSync(join(FIXTURE, f));

/** A tiny valid PNG of w×h (one IDAT; the bytes are never decoded by the host, only walked). */
function png(w: number, h: number, extra: Buffer[] = []): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra, chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** A 1×1 PNG of exactly `bytes`, padded with a private chunk (kept by the host: only text/time/Exif chunks are stripped). */
function sized(bytes: number, fill: number): Buffer {
  const p = png(1, 1), body = Buffer.alloc(bytes - p.length - 12, fill), len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const out = Buffer.concat([p.subarray(0, 33), len, Buffer.from("prIv"), body, Buffer.alloc(4), p.subarray(33)]);
  expect(out.length).toBe(bytes);
  return out;
}
const FURNITURE = (i: number) => ({ id: `f${i}`, sprite: { src: `f${i}.png`, frames: 1, w: 1, h: 1 }, x: 10, y: 10 });

const POSES = ["working", "idle", "paused", "needs", "walk", "walkDown", "walkUp", "walkSide"];
/** The clinic pack grown to `n` files: furniture strips (at most 128) first, then character sets of up to 8 poses each. */
function manyFiles(n: number) {
  const m = MANIFEST(), files: Record<string, string> = { "office_bg.png": fixture("office_bg.png").toString("base64"), "fox_idle.png": fixture("fox_idle.png").toString("base64") };
  const dot = png(1, 1).toString("base64"), strip = png(128, 48).toString("base64"), furniture = Math.min(n - 2, 128);
  m.furniture = [...Array(furniture).keys()].map(FURNITURE);
  for (let i = 0; i < furniture; i++) files[`f${i}.png`] = dot;
  for (let i = 0; i < n - 2 - furniture; i++) {
    const set = `set${Math.floor(i / POSES.length)}`, pose = POSES[i % POSES.length]!;
    (m.characters[set] ??= {})[pose] = { ...m.characters.fox.idle, src: `${set}_${pose}.png` }; files[`${set}_${pose}.png`] = strip;
  }
  expect(Object.keys(files)).toHaveLength(n);
  return { manifest: m, files };
}
/** The clinic pack with furniture strips filling it to exactly `total` kept bytes, each strip within the per-file cap. */
function manyBytes(total: number) {
  const bg = fixture("office_bg.png"), fox = fixture("fox_idle.png");
  const kept = [bg, fox].reduce((sum, b) => { const r = checkSkinPicture("x.png", b); if (!r.ok) throw new Error(r.error); return sum + r.kept.length; }, 0);
  const m = MANIFEST(), files: Record<string, string> = { "office_bg.png": bg.toString("base64"), "fox_idle.png": fox.toString("base64") };
  let left = total - kept;
  for (let i = 0; left > 0; i++) {
    const bytes = Math.min(left, SKIN_LIMITS.fileBytes);
    (m.furniture ??= []).push(FURNITURE(i)); files[`f${i}.png`] = sized(bytes, i).toString("base64");
    left -= bytes;
  }
  return { manifest: m, files };
}

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("SKIN_LIMITS: a pack for a whole fleet (#2632)", () => {
  it("the limits: 220 files and 42 MiB a pack; 4 MiB a file, 5120 px a side, 16 Mpx a picture, 64 Mpx a pack (unchanged: #4383 keeps the proven cap)", () => {
    expect(SKIN_LIMITS).toMatchObject({ files: 220, packBytes: 42 * MiB, fileBytes: 4 * MiB, side: 5120, pixels: 16 * MiB, packPixels: 64 * MiB });
  });
  it("files: 220 pass; 221 are skin_too_many_files", () => {
    const r = checkSkinUpload(manyFiles(SKIN_LIMITS.files), "me", 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.record.files)).toHaveLength(220);
    expect(checkSkinUpload(manyFiles(SKIN_LIMITS.files + 1), "me", 1)).toMatchObject({ ok: false, status: 400, error: "skin_too_many_files", detail: "at most 220" });
  });
  it("bytes: exactly 42 MiB kept passes; one byte more is skin_too_large", () => {
    const r = checkSkinUpload(manyBytes(SKIN_LIMITS.packBytes), "me", 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.values(r.record.files).reduce((sum, f) => sum + f.bytes, 0)).toBe(42 * MiB);
    expect(checkSkinUpload(manyBytes(SKIN_LIMITS.packBytes + 1), "me", 1)).toMatchObject({ ok: false, status: 413, error: "skin_too_large", detail: "at most 42 MiB in all" });
  });
  it("the wire cap admits a full pack's base64 and a manifest at its cap", () => {
    expect(SKIN_WIRE_BYTES).toBeGreaterThanOrEqual(Math.ceil((SKIN_LIMITS.packBytes * 4) / 3) + SKIN_LIMITS.manifestBytes);
    expect(SKIN_WIRE_BYTES).toBeGreaterThan(Buffer.byteLength(JSON.stringify(manyBytes(SKIN_LIMITS.packBytes))));
  });
});

interface Res { status: number; body: Buffer }
function raw(port: number, method: string, path: string, headers: Record<string, string>, body: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    r.on("error", reject); r.end(body);
  });
}
async function fleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-pack-limits-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  vi.spyOn(fm, "emitSseEvent").mockImplementation(() => {});
  fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {} };
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const { sessionId } = fm.webSessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken) });
  const admin = { cookie: `agend_session=${sessionId}`, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" };
  const stop = () => new Promise<void>(r => (fm.healthServer as Server).close(() => r()));
  return { fm, port, admin, stop };
}

describe("POST /ui/office-skins: the route keeps a full pack (#2632)", () => {
  it("a 42 MiB pack and a 220-file pack, each kept whole through the body cap", async () => {
    const f = await fleet();
    try {
      const big = manyBytes(SKIN_LIMITS.packBytes);
      big.manifest.id = "full-bytes";
      const sentBig = JSON.stringify(big);
      expect(Buffer.byteLength(sentBig)).toBeGreaterThan(26 * MiB);                     // over the old 6 MiB cap many times
      const a = await raw(f.port, "POST", "/ui/office-skins", f.admin, sentBig);
      expect([a.status, JSON.parse(a.body.toString("utf8")).pack?.id]).toEqual([200, "full-bytes"]);
      const many = manyFiles(SKIN_LIMITS.files);
      many.manifest.id = "full-files";
      const b = await raw(f.port, "POST", "/ui/office-skins", f.admin, JSON.stringify(many));
      expect([b.status, JSON.parse(b.body.toString("utf8")).pack?.files]).toEqual([200, 220]);
      expect(f.fm.officeSkins.list().packs.map((p: any) => [p.id, p.bytes]).sort()).toEqual([["full-bytes", 42 * MiB], ["full-files", expect.any(Number)]]);
    } finally { await f.stop(); }
  }, 60_000);
});
