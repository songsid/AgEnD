/**
 * #2308 review: the app icon's conversion (decode, five resizes, PNG/ICO encoding) runs here, off the fleet's event
 * loop — a 2048 px 16-bit source takes about a second. One source in (workerData), the made files or a reason out.
 */
import { parentPort, workerData } from "node:worker_threads";
import { appIconSet } from "./web-app-icon.js";
import { PngError } from "./web-png.js";

try {
  const files = appIconSet(new Uint8Array((workerData as { source: ArrayBuffer }).source));
  parentPort!.postMessage({ ok: true, files });
} catch (err) {
  parentPort!.postMessage({ ok: false, detail: err instanceof PngError ? err.message : "the image could not be read" });
}
