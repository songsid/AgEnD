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
/** In a one-off worker thread with its own heap and a deadline: never the fleet's event loop. null: not reduced. */
export const reduceInWorker: PictureReduce = (bytes, slot) => new Promise((resolve) => {
  const source = new Uint8Array(bytes).buffer;
  const worker = import.meta.url.endsWith(".ts")
    ? new Worker(`const { workerData } = require("node:worker_threads"); import("tsx/esm/api").then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));`,
      { eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: REDUCE_HEAP_MB }, workerData: { entry: new URL("./hub-picture-worker.ts", import.meta.url).href, source, slot } })
    : new Worker(new URL("./hub-picture-worker.js", import.meta.url), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: REDUCE_HEAP_MB }, workerData: { source, slot }, transferList: [source] });
  let done = false;
  const finish = (out: Buffer | null) => { if (done) return; done = true; clearTimeout(timer); void worker.terminate().catch(() => { /* gone */ }); resolve(out); };
  const timer = setTimeout(() => finish(null), PICTURE_REDUCE_MS);
  worker.on("message", (m: { ok: boolean; png?: Uint8Array }) => finish(m?.ok && m.png ? Buffer.from(m.png.buffer, m.png.byteOffset, m.png.byteLength) : null));
  worker.on("error", () => finish(null));
  worker.on("exit", () => finish(null));
});
/** The same on this thread (tests). */
export const reduceInProcess: PictureReduce = async (bytes, slot) => { try { return reducePicture(bytes, slot); } catch { return null; } };
