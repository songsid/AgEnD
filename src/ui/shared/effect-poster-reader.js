/** #1629: closed static-poster reads only. No epoch, library/runtime route, code, or response-derived URL. */
const pools = new WeakMap(), ID = /^[0-9a-f]{32}$/;
const plain = x => !!x && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const exact = (x, keys) => plain(x) && Reflect.ownKeys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k) && Object.hasOwn(Object.getOwnPropertyDescriptor(x, k), "value"));
const instanceOK = x => typeof x === "string" && x.length >= 1 && x.length <= 128;
export function checkEffectPosters(value) {
  if (!exact(value, ["rev", "posters"]) || !Number.isSafeInteger(value.rev) || value.rev < 0 || !Array.isArray(value.posters) || value.posters.length > 2) return null;
  const out = [], ids = new Set(), descriptors = Object.getOwnPropertyDescriptors(value.posters);
  if (Reflect.ownKeys(descriptors).length !== value.posters.length + 1) return null;
  for (let n = 0; n < value.posters.length; n++) {
    const descriptor = descriptors[n]; if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    const p = descriptor.value;
    // Titles are display-only, never selectors/URLs/CSS. The server's normalized UTF-16 input bound is 400.
    if (!exact(p, ["id", "title"]) || typeof p.id !== "string" || !ID.test(p.id) || ids.has(p.id) || typeof p.title !== "string" || p.title.length < 1 || p.title.length > 400) return null;
    ids.add(p.id); out.push(Object.freeze({ id: p.id, title: p.title }));
  }
  return Object.freeze({ rev: value.rev, posters: Object.freeze(out) });
}
/** Refuse animation/non-PNG/oversized images before DOM decode. This is not a CRC or compressed-data decoder. */
export function checkStaticEffectPoster(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 45 || bytes.length > 1048576 || [137, 80, 78, 71, 13, 10, 26, 10].some((b, n) => bytes[n] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 8388608) return null;
  let offset = 8, count = 0, data = false;
  while (offset + 12 <= bytes.length && ++count <= 4096) {
    const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset + length + 12 > bytes.length || ["acTL", "fcTL", "fdAT"].includes(type) || (count === 1 ? type !== "IHDR" || length !== 13 : type === "IHDR")) return null;
    if (type === "IDAT" && length) data = true;
    offset += length + 12;
    if (type === "IEND") return !length && data && offset === bytes.length ? new Uint8Array(bytes) : null;
  }
  return null;
}
/** Two physical requests per Window, across canceled/replaced readers; cancellation does not release early. */
export function createEffectPosterReader({ window: host, current } = {}) {
  const unavailable = { ok: false, dispose() {} };
  if (!host || typeof current !== "function" || ![host.fetch, host.AbortController, host.setTimeout, host.clearTimeout, host.performance?.now].every(x => typeof x === "function")) return unavailable;
  if (!pools.has(host)) pools.set(host, new Set());
  const all = pools.get(host), own = new Set(); let dead = false, revoked = false, previous = null;
  const alive = () => !dead && !revoked && current() === true;
  function stop() { if (dead) return; dead = true; for (const op of own) op.abort(); }
  function now() {
    let n; try { n = host.performance.now(); } catch { stop(); return null; }
    if (!Number.isFinite(n) || n < 0 || previous !== null && n < previous) { stop(); return null; }
    previous = n; return n;
  }
  function read(path, mime, limit, project, signal) {
    if (!alive() || signal?.aborted || all.size >= 2) return Promise.resolve(null);
    const began = now(); if (began === null) return Promise.resolve(null);
    const controller = new host.AbortController(), op = {}; all.add(op); own.add(op);
    let reader = null, body = null, cancellation = null, timer, release;
    const cancelled = new Promise(resolve => { release = resolve; });
    const cancelBody = () => {
      if (cancellation) return cancellation;
      try { cancellation = Promise.resolve(reader ? reader.cancel() : body?.cancel?.()).catch(() => {}); }
      catch { cancellation = Promise.resolve(); }
      return cancellation;
    };
    op.abort = () => { controller.abort(); if (body) void cancelBody(); release(null); };
    const valid = () => {
      const t = now();
      if (!alive() || controller.signal.aborted || t === null || t < began || t - began >= 10000) { op.abort(); return false; }
      return true;
    };
    const work = Promise.resolve().then(async () => {
      if (!valid()) return null;
      const response = await host.fetch(path, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal }); body = response.body;
      if (!valid()) return null;
      if ([401, 403, 409].includes(response.status)) { revoked = true; for (const pending of own) pending.abort(); return null; }
      if (!response.ok || response.redirected || (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() !== mime) return null;
      const length = response.headers.get("content-length");
      if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit) || typeof body?.getReader !== "function") return null;
      reader = body.getReader(); const chunks = []; let size = 0;
      for (;;) {
        const part = await reader.read(); if (!valid()) return null;
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || (size += part.value.length) > limit) return null;
        chunks.push(new Uint8Array(part.value));
      }
      const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
      if (!valid()) return null; const answer = project(bytes); return valid() ? answer : null;
    }).catch(() => null).finally(async () => {
      controller.abort(); await cancelBody(); all.delete(op); own.delete(op); host.clearTimeout(timer); signal?.removeEventListener("abort", op.abort);
    });
    timer = host.setTimeout(op.abort, 10000); signal?.addEventListener("abort", op.abort, { once: true });
    return Promise.race([work, cancelled]);
  }
  return { ok: true,
    summary(instance, signal) {
      return instanceOK(instance) ? read(`/ui/effect-posters?instance=${encodeURIComponent(instance)}`, "application/json", 8192, bytes => {
        try { return checkEffectPosters(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch { return null; }
      }, signal) : Promise.resolve(null);
    },
    image(instance, id, signal) {
      return instanceOK(instance) && typeof id === "string" && ID.test(id) ? read(`/ui/effect-posters/${id}.png?instance=${encodeURIComponent(instance)}`, "image/png", 1048576, checkStaticEffectPoster, signal) : Promise.resolve(null);
    }, dispose: stop,
  };
}
