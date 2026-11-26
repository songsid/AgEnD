import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

// The installer and runtime enforce the same root policy before writing credentials or operator sockets.
// Loaded on first use, not at module load (M-3770 2.5): a bundle that imports this module transitively (the update
// recovery kit's recover.cjs, through fleet-lock) has no `import.meta.url` and no launcher beside it, and never calls it.
type PrivateHome = { ensurePrivateHome(dir: string, options?: { create?: boolean; label?: string; log?: (line: string) => void }): void };
let privateHome: PrivateHome | null = null;
export function ensureAgendHome(dir: string, options?: { create?: boolean; label?: string; log?: (line: string) => void }): void {
  privateHome ??= createRequire(import.meta.url)("../launcher/private-home.cjs") as PrivateHome;
  privateHome.ensurePrivateHome(dir, options);
}

/** #3009: how long the off-thread home check may take before the caller is told it could not be done. */
export const AGEND_HOME_CHECK_MS = 10_000;
const privateHomeModule = (): string => createRequire(import.meta.url).resolve("../launcher/private-home.cjs");

/**
 * #3009 (#3017 review, Prism P1): ensureAgendHome — the very same checks (ownership, symlink and descriptor fences) —
 * run on a short-lived worker thread, so a home filesystem that stops answering stalls that worker, never the fleet's
 * event loop and its systemd watchdog. Bounded: past `timeoutMs` it rejects (the worker, possibly stuck in the kernel,
 * is let go — unref'd, it never holds the process open). Only for paths that may write on a user's request (a login's
 * tunnel lease); startup keeps the synchronous call.
 */
export function ensureAgendHomeOffThread(dir: string, options: { create?: boolean; label?: string } = {}, timeoutMs = AGEND_HOME_CHECK_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (err) reject(err); else resolve(); };
    let worker: Worker;
    try {
      worker = new Worker(`const { parentPort, workerData } = require("node:worker_threads");
try { require(workerData.module).ensurePrivateHome(workerData.dir, workerData.options); parentPort.postMessage({ ok: true }); }
catch (e) { parentPort.postMessage({ ok: false, message: e && e.message ? String(e.message) : String(e), code: e && e.code }); }`,
        { eval: true, workerData: { module: privateHomeModule(), dir, options } });
    } catch (err) {
      reject(err as Error);
      return;
    }
    worker.unref();
    const timer = setTimeout(() => {
      done(Object.assign(new Error(`the AgEnD home could not be checked in time (${dir}): its filesystem did not answer`), { code: "ETIMEDOUT" }));
      void worker.terminate().catch(() => { /* stuck in the kernel: let go */ });
    }, timeoutMs);
    timer.unref?.();
    worker.once("message", (m: { ok: boolean; message?: string; code?: string }) => {
      done(m.ok ? undefined : Object.assign(new Error(m.message ?? "AgEnD home check failed"), m.code ? { code: m.code } : {}));
      void worker.terminate().catch(() => { /* done */ });
    });
    worker.once("error", (err: unknown) => done(err instanceof Error ? err : new Error(String(err))));
  });
}
