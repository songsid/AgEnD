/**
 * M-3533 R2b: one agent picture reduced (hub-picture-reduce.ts), off the fleet's event loop. One PNG in, the small PNG or nothing out.
 * R2c: or an agent's own character cut out of its pack's pictures (cropCharacter): a PNG a pose, or nothing.
 */
import { parentPort, workerData } from "node:worker_threads";
import { cropCharacter, reducePicture, type CharacterCut } from "./hub-picture-reduce.js";

try {
  const data = workerData as { source: ArrayBuffer; slot: "disc" | "portrait" } | { crop: { files: Record<string, ArrayBuffer>; cuts: CharacterCut[] } };
  if ("crop" in data) {
    const pngs = cropCharacter(new Map(Object.entries(data.crop.files).map(([k, v]) => [k, new Uint8Array(v)])), data.crop.cuts);
    parentPort!.postMessage({ ok: true, pngs: Object.fromEntries(pngs) });
  } else parentPort!.postMessage({ ok: true, png: reducePicture(new Uint8Array(data.source), data.slot) });
} catch {
  parentPort!.postMessage({ ok: false });
}
