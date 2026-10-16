/** #1629: static current-chat posters. No Worker, preview frame, events, profile write or personal-slot authority. */
import { createEffectPosterReader, checkEffectPosters } from "./effect-poster-reader.js";
import { createEffectGeometry, hostEffectRect } from "./effect-geometry.js";
import { stockEffectTrust } from "./effect-stock-trust.js";
import { effectStockSnapshot } from "./effect-stock-snapshot.js";
const decoding = new WeakMap();
export function createChatPosters({ window: host, name, element, current, observe, factories = {} } = {}) {
  let dead = false, failed = false, generation = 0, allowed = false, metadata = null, request = null, queued = false, raf = null;
  let root = null, geometry = null, reader = null, mutation = null, resize = null, offAuth = null;
  const rows = new Map(), offs = [];
  const alive = () => !dead && current() === true && element?.isConnected === true && element.ownerDocument === host.document && host.document.body.dataset.mode === "full" && !host.AgendAuth.sessionEnded();
  const make = (key, fallback) => factories[key] ?? fallback;
  const gate = () => {
    try {
      const x = observe();
      if (!alive() || x.shown !== true || x.fallback !== true || host.document.visibilityState !== "visible") return null;
      const rect = hostEffectRect(element), proof = effectStockSnapshot(make("stock", stockEffectTrust)(host, { frameRoot: root, ownerCss: x.ownerCss }));
      if (!rect || !proof || rect.x + rect.width <= 0 || rect.y + rect.height <= 0 || rect.x >= host.innerWidth || rect.y >= host.innerHeight) return null;
      return { rect, proof };
    } catch { return null; }
  };
  function clear() {
    for (const row of rows.values()) {
      row.controller.abort(); row.binding?.remove?.(); row.image.remove();
      if (row.url) host.URL.revokeObjectURL(row.url);
    }
    rows.clear(); geometry?.hide?.();
  }
  function cancel() { generation++; request?.controller.abort(); clear(); metadata = null; }
  function fail() { if (dead) return; failed = true; cancel(); }
  function dispose() {
    if (dead) return; dead = true; cancel(); reader?.dispose?.();
    if (raf !== null) host.cancelAnimationFrame(raf); raf = null;
    for (const off of offs) { try { off(); } catch { /* release all */ } }
    offAuth?.(); mutation?.disconnect(); resize?.disconnect(); geometry?.dispose?.(); root?.remove();
  }
  const unavailable = () => ({ ok: false, dispose });
  try {
    if (!host?.document || typeof current !== "function" || typeof observe !== "function" || typeof name !== "string" || !name.length || name.length > 128 || host.document.body.dataset.mode !== "full" ||
      ![host.MutationObserver, host.ResizeObserver, host.requestAnimationFrame, host.cancelAnimationFrame, host.URL?.createObjectURL, host.URL?.revokeObjectURL, host.Blob, host.AbortController, host.setTimeout, host.clearTimeout, host.performance?.now, host.AgendAuth?.onSessionEnd, host.AgendAuth?.sessionEnded].every(x => typeof x === "function")) return unavailable();
    offAuth = host.AgendAuth.onSessionEnd(dispose);
    if (!alive()) { dispose(); return unavailable(); }
    root = host.document.createElement("div"); root.className = "agend-effect-layer"; host.document.body.append(root);
    geometry = make("geometry", createEffectGeometry)({ window: host }); if (!geometry.ok) throw Error("geometry unavailable");
    reader = make("reader", createEffectPosterReader)({ window: host, current: alive }); if (!reader.ok) throw Error("reader unavailable");
    if (!decoding.has(host)) decoding.set(host, new Set());
    mutation = new host.MutationObserver(invalidate); mutation.observe(host.document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    resize = new host.ResizeObserver(invalidate); resize.observe(host.document.documentElement); resize.observe(element);
    for (const type of ["scroll", "resize", "orientationchange"]) { host.addEventListener(type, invalidate, true); offs.push(() => host.removeEventListener(type, invalidate, true)); }
    const visibility = () => { if (host.document.visibilityState !== "visible") { cancel(); allowed = false; } invalidate(); };
    host.document.addEventListener("visibilitychange", visibility); offs.push(() => host.document.removeEventListener("visibilitychange", visibility));
    host.addEventListener("pagehide", dispose); offs.push(() => host.removeEventListener("pagehide", dispose));
  } catch { dispose(); return unavailable(); }
  function schedule() { if (alive() && raf === null) raf = host.requestAnimationFrame(() => { raf = null; sync(); }); }
  function invalidate() { if (dead) return; geometry.hide(); schedule(); }
  function valid(mine) { return alive() && generation === mine && !failed && !!gate(); }
  async function loadImage(row, mine) {
    try {
      const bytes = await reader.image(name, row.id, row.controller.signal);
      if (!valid(mine) || rows.get(row.id) !== row) return;
      if (!bytes) { fail(); return; }
      const pending = decoding.get(host); if (pending.size >= 2) { fail(); return; }
      const token = {}; pending.add(token);
      let timer = null, aborted = false;
      const abort = () => { aborted = true; row.controller.abort(); if (rows.get(row.id) === row) fail(); };
      try {
        const began = host.performance.now();
        if (!Number.isFinite(began) || began < 0) { fail(); return; }
        timer = host.setTimeout(abort, 10000);
        row.url = host.URL.createObjectURL(new host.Blob([bytes], { type: "image/png" }));
        row.image.src = row.url;
        await row.image.decode();
        if (aborted || !valid(mine) || rows.get(row.id) !== row) return;
        const ended = host.performance.now();
        if (!Number.isFinite(ended) || ended < began || ended - began >= 10000) { fail(); return; }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (row.image.naturalWidth !== view.getUint32(16) || row.image.naturalHeight !== view.getUint32(20)) { fail(); return; }
        row.ready = true; sync();
      } finally { host.clearTimeout(timer); pending.delete(token); }
    } catch { if (alive() && generation === mine) fail(); }
  }
  async function read() {
    const op = { controller: new host.AbortController(), generation }; request = op;
    try {
      const result = await reader.summary(name, op.controller.signal);
      if (!valid(op.generation) || request !== op) return;
      const checked = checkEffectPosters(result);
      if (!checked) { fail(); return; }
      metadata = checked;
      for (const p of checked.posters) {
        const image = host.document.createElement("img"); image.className = "agend-effect-poster"; image.setAttribute("alt", ""); image.setAttribute("aria-hidden", "true"); image.decoding = "async";
        root.append(image);
        const binding = geometry.bind(image, { layer: "behind", by: "agent" });
        if (!binding.ok || typeof image.decode !== "function") { binding.remove?.(); image.remove(); fail(); return; }
        const row = { id: p.id, image, binding, controller: new host.AbortController(), url: null, ready: false }; rows.set(p.id, row);
        // The IMG is proved hidden synchronously before any source is assigned or control yields.
        void loadImage(row, op.generation);
      }
    } catch { if (alive() && generation === op.generation) fail(); }
    finally { if (request === op) request = null; if (queued && alive()) { queued = false; sync(); } }
  }
  function sync() {
    if (!alive()) { dispose(); return; }
    geometry.hide();
    const evidence = gate();
    if (!evidence) { if (allowed) cancel(); allowed = false; return; }
    allowed = true;
    if (failed) return;
    for (const row of rows.values()) if (row.ready && !row.binding.sync(evidence.rect, evidence.proof)) { fail(); return; }
    if (!metadata && !request) void read();
    if (rows.size) schedule();
  }
  return { ok: true, sync,
    changed() { if (!alive()) return; cancel(); failed = false; if (request) queued = true; else sync(); },
    dispose, snapshot: () => ({ failed, count: rows.size, ready: [...rows.values()].filter(r => r.ready).length }),
  };
}
