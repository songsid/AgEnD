/** M-3533 R2b: one agent picture reduced (hub-picture-reduce.ts), off the fleet's event loop. One PNG in, the small PNG or nothing out. */
import { parentPort, workerData } from "node:worker_threads";
import { reducePicture } from "./hub-picture-reduce.js";

try {
  const { source, slot } = workerData as { source: ArrayBuffer; slot: "disc" | "portrait" };
  parentPort!.postMessage({ ok: true, png: reducePicture(new Uint8Array(source), slot) });
} catch {
  parentPort!.postMessage({ ok: false });
}
