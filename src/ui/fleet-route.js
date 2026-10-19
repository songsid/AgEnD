// #2182: the page's side of the traffic router — one worker (fleet-route-worker.js), started the first time Live
// traffic is drawn, fed the libavoid.wasm bytes the page fetched. One scene at a time: a newer one replaces any still
// waiting (the older one's answer would be stale anyway). A worker that fails, or takes longer than TIMEOUT_MS, is
// ended; after FAIL_LIMIT failures in a row this page stops asking, and every line keeps its lane route (the caller's
// fallback for a null answer).
import { routeOk } from "./fleet-route-scene.js";

export const WORKER_URL = "/ui/js/fleet-route-worker.js";
export const WASM_URL = "/ui/vendor/libavoid-0.4.5/libavoid.wasm";
export const TIMEOUT_MS = 4000;
const FAIL_LIMIT = 2;

/**
 * A client: route(scene) → a Promise of a Map (connection key → points, checked against the scene) or null (not
 * routed: superseded, failed, unavailable). `deps` replaces Worker, fetch and the clock in tests.
 */
export function createRouteClient(deps = {}) {
  const W = deps.Worker ?? (typeof Worker === "function" ? Worker : null);
  const get = deps.fetch ?? ((...a) => fetch(...a));
  const timers = deps.timers ?? { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) };
  let worker = null, wasm = null, fails = 0, nextId = 1;
  let busy = null, waiting = null;          // { id, scene, resolve, timer }
  const end = () => { try { worker?.terminate(); } catch { /* gone */ } worker = null; };
  const fail = () => {
    fails++;
    end();
    if (busy) { timers.clear(busy.timer); busy.resolve(null); busy = null; }
    if (fails >= FAIL_LIMIT && waiting) { waiting.resolve(null); waiting = null; }
    pump();
  };
  async function start(job) {
    if (!wasm) {
      const res = await get(WASM_URL, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`libavoid.wasm: ${res.status}`);
      wasm = await res.arrayBuffer();
    }
    // #2194 review: closed, timed out or replaced while the .wasm was on its way — start nothing (a worker made now
    // would be nobody's, and a later start would make another).
    if (busy !== job || worker) return;
    const w = new W(WORKER_URL, { type: "module" });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (!m || typeof m !== "object" || w !== worker) return;
      if (m.type === "failed") { fail(); return; }
      if (m.type !== "routes" || !busy || m.id !== busy.id) return;
      const { scene, resolve, timer } = busy;
      busy = null;
      timers.clear(timer);
      if (!Array.isArray(m.routes)) { fail(); resolve(null); return; }
      fails = 0;
      const out = new Map();
      for (const pair of m.routes.slice(0, scene.conns.length)) {
        if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
        const c = scene.conns.find((x) => x.key === pair[0]);
        const pts = c && routeOk(pair[1], scene, c);
        if (pts) out.set(c.key, pts);
      }
      resolve(out);
      pump();
    };
    w.onerror = (e) => { e?.preventDefault?.(); if (w === worker) fail(); };
    worker = w;
    w.postMessage({ type: "init", wasm: wasm.slice(0) });
  }
  function pump() {
    if (busy || !waiting) return;
    if (fails >= FAIL_LIMIT || !W) { waiting.resolve(null); waiting = null; return; }
    busy = waiting; waiting = null;
    const job = busy;
    job.timer = timers.set(() => { if (busy === job) fail(); }, TIMEOUT_MS);
    (worker ? Promise.resolve() : start(job)).then(() => {
      if (busy === job) worker.postMessage({ type: "route", id: job.id, scene: job.scene });
    }, () => { if (busy === job) fail(); });
  }
  return {
    route(scene) {
      if (waiting) waiting.resolve(null);
      return new Promise((resolve) => { waiting = { id: nextId++, scene, resolve, timer: null }; pump(); });
    },
    /** Off: the worker ended; what was waiting gets null. */
    close() {
      if (waiting) { waiting.resolve(null); waiting = null; }
      if (busy) { timers.clear(busy.timer); busy.resolve(null); busy = null; }
      end();
    },
    get available() { return !!W && fails < FAIL_LIMIT; },
  };
}
