/**
 * M-3533 R2b: an agent's picture made small for the Hub, on Node's zlib (web-png.ts; no image library). Only a PNG can be
 * reduced; any other type goes as it is, within its cap (hub/member/agent-pictures.ts). What is kept is the square the Fleet
 * itself shows: the sidebar's disc is centred (CSS object-fit: cover), the office card's portrait is taken 18% down
 * (fleet-office-card.js drawPortraitAvatar). So a member sees on the Hub what the owner sees on the Fleet.
 */
import { Worker } from "node:worker_threads";
import { decodePng, encodePng, resize, type Rgba } from "./web-png.js";
import { HUB_PICTURE_DISC_SIDE, HUB_PICTURE_PORTRAIT_SIDE, type HubPictureSlot } from "./hub/agent-pictures-model.js";

/** The portrait limits allow 2048×3072; a larger PNG is refused before it is inflated. */
export const PICTURE_DECODE_MAX_SIDE = 4096;
export const PICTURE_REDUCE_MS = 10_000;
const REDUCE_HEAP_MB = 256;

/** The square of `img` the Fleet shows: as wide as its shorter side, centred across, `top` of the spare height down. */
export function squareOf(img: Rgba, top: number): Rgba {
  const side = Math.min(img.width, img.height), sx = Math.round((img.width - side) / 2), sy = Math.round((img.height - side) * top);
  const data = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) data.set(img.data.subarray(((sy + y) * img.width + sx) * 4, ((sy + y) * img.width + sx + side) * 4), y * side * 4);
  return { width: side, height: side, data };
}
/** A PNG as the Hub keeps it: the square shown, at most 64 px (disc) or 256 px (portrait). Throws on a PNG it cannot read. */
export function reducePicture(bytes: Uint8Array, slot: HubPictureSlot): Buffer {
  const square = squareOf(decodePng(bytes, { maxSide: PICTURE_DECODE_MAX_SIDE }), slot === "disc" ? 0.5 : 0.18);
  const side = slot === "disc" ? HUB_PICTURE_DISC_SIDE : HUB_PICTURE_PORTRAIT_SIDE;
  return encodePng(square.width > side ? resize(square, side, side) : square);
}

export type PictureReduce = (bytes: Uint8Array, slot: HubPictureSlot) => Promise<Buffer | null>;
/**
 * In a one-off worker thread with its own heap and a deadline: never the fleet's event loop. Answers the worker's
 * message, or null (it failed, ran out of time or exited).
 */
function inWorker<T>(data: Record<string, unknown>, transfer: ArrayBuffer[], read: (m: any) => T | null): Promise<T | null> {
  return new Promise((resolve) => {
    const worker = import.meta.url.endsWith(".ts")
      ? new Worker(`const { workerData } = require("node:worker_threads"); import("tsx/esm/api").then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));`,
        { eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: REDUCE_HEAP_MB }, workerData: { entry: new URL("./hub-picture-worker.ts", import.meta.url).href, ...data } })
      : new Worker(new URL("./hub-picture-worker.js", import.meta.url), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: REDUCE_HEAP_MB }, workerData: data, transferList: transfer });
    let done = false;
    const finish = (out: T | null) => { if (done) return; done = true; clearTimeout(timer); void worker.terminate().catch(() => { /* gone */ }); resolve(out); };
    const timer = setTimeout(() => finish(null), PICTURE_REDUCE_MS);
    worker.on("message", (m: unknown) => { try { finish(read(m)); } catch { finish(null); } });
    worker.on("error", () => finish(null));
    worker.on("exit", () => finish(null));
  });
}
const asBuffer = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);
export const reduceInWorker: PictureReduce = (bytes, slot) => {
  const source = new Uint8Array(bytes).buffer;
  return inWorker({ source, slot }, [source], (m: { ok: boolean; png?: Uint8Array }) => (m?.ok && m.png ? asBuffer(m.png) : null));
};

/**
 * M-3533 R2c: an agent's own character cut out of its skin pack — each pose a PNG of its `frames` cells side by side (a
 * cell `{ file, col, row }` of w × h in that pack picture), so nothing else on a shared sheet crosses. Each picture is
 * decoded once. Throws on a picture it cannot read (then the whole set is not sent).
 */
export interface CharacterCut { pose: string; w: number; h: number; cells: Array<{ file: string; col: number; row: number }> }
export function cropCharacter(files: ReadonlyMap<string, Uint8Array>, cuts: readonly CharacterCut[]): Map<string, Buffer> {
  const decoded = new Map<string, Rgba>(), out = new Map<string, Buffer>();
  const sheet = (file: string): Rgba => {
    let img = decoded.get(file);
    if (!img) { const bytes = files.get(file); if (!bytes) throw new Error("missing picture"); img = decodePng(bytes, { maxSide: PICTURE_DECODE_MAX_SIDE }); decoded.set(file, img); }
    return img;
  };
  for (const cut of cuts) {
    const width = cut.w * cut.cells.length, data = new Uint8Array(width * cut.h * 4);
    cut.cells.forEach((cell, i) => {
      const img = sheet(cell.file), sx = cell.col * cut.w, sy = cell.row * cut.h;
      if (sx + cut.w > img.width || sy + cut.h > img.height) throw new Error("cell outside its picture");
      for (let y = 0; y < cut.h; y++) data.set(img.data.subarray(((sy + y) * img.width + sx) * 4, ((sy + y) * img.width + sx + cut.w) * 4), (y * width + i * cut.w) * 4);
    });
    out.set(cut.pose, encodePng({ width, height: cut.h, data }));
  }
  return out;
}
export type CharacterCrop = (files: ReadonlyMap<string, Uint8Array>, cuts: readonly CharacterCut[]) => Promise<Map<string, Buffer> | null>;
/** In a one-off worker (as reduceInWorker); null: not cut — the set is not sent. */
export const cropInWorker: CharacterCrop = (files, cuts) => {
  const sources = [...files].map(([k, v]) => [k, new Uint8Array(v).buffer] as const);
  return inWorker({ crop: { files: Object.fromEntries(sources), cuts } }, sources.map(([, b]) => b),
    (m: { ok: boolean; pngs?: Record<string, Uint8Array> }) => (m?.ok && m.pngs ? new Map(Object.entries(m.pngs).map(([k, v]) => [k, asBuffer(v)])) : null));
};
/** The same on this thread (tests). */
export const cropInProcess: CharacterCrop = async (files, cuts) => { try { return cropCharacter(files, cuts); } catch { return null; } };
/** The same on this thread (tests). */
export const reduceInProcess: PictureReduce = async (bytes, slot) => { try { return reducePicture(bytes, slot); } catch { return null; } };
