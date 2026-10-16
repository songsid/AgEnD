/** #1629: bounded host HTTP projection. No product startup, frame, content event or retry. */
const loaders = new WeakMap();
const ID = /^[a-f0-9]{32}$/, EPOCH = /^[a-f0-9]{16}$/, PARAM = /^[a-z][a-z0-9_]{0,31}$/;
const REGIONS = ["chat", "sidebar", "header", "page", "box"], WANTS = ["pointer", "state", "reply", "mention", "theme"];
const SLOTS = ["fx.sidebar", "fx.header", "fx.page", "fx.box"];
const MIB = 1048576, WIRE = 8 * MIB;
const plain = x => !!x && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const finite = x => typeof x === "number" && Number.isFinite(x);
const integer = (x, lo, hi) => Number.isSafeInteger(x) && x >= lo && x <= hi;
const exact = (o, keys) => plain(o) && Object.keys(o).sort().join(",") === [...keys].sort().join(",");
const subset = (o, keys) => plain(o) && Object.keys(o).every(k => keys.includes(k));
const instanceOK = x => typeof x === "string" && x.length >= 1 && x.length <= 128;
const enumeration = (x, values, min = 0) => Array.isArray(x) && x.length >= min && x.length <= values.length && new Set(x).size === x.length && x.every(v => values.includes(v));
/** Copy own data before inspecting it. Refuse accessors/symbols, non-finite values and unbounded trees. */
function data(value) {
  let nodes = 0;
  function copy(x, depth) {
    if (++nodes > 1024 || depth > 8) throw Error("shape");
    if (x === null || typeof x === "string" || typeof x === "boolean" || finite(x)) return x;
    const array = Array.isArray(x);
    if (array ? Object.getPrototypeOf(x) !== Array.prototype || x.length > 32 : !plain(x)) throw Error("shape");
    const out = array ? [] : Object.create(null), keys = Reflect.ownKeys(x);
    if (keys.length > 33) throw Error("shape");
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || array && (!/^(0|[1-9][0-9]*)$/.test(key) || !Number.isSafeInteger(Number(key)) || Number(key) >= x.length)) throw Error("shape");
      const d = Object.getOwnPropertyDescriptor(x, key); if (!d || !("value" in d)) throw Error("shape");
      out[key] = copy(d.value, depth + 1);
    }
    if (array && Object.keys(out).length !== x.length) throw Error("shape");
    return Object.freeze(out);
  }
  try { return copy(value, 0); } catch { return null; }
}
// Same normalized one-line contract as web-effect.ts text()/web-theme.ts canonicalText.
const FORBIDDEN_TEXT = /(?!\u200d)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const VISIBLE_TEXT = /[^\p{M}\p{C}\p{Z}\u115f\u1160\u3164\uffa0\u2800]/u;
let graphemes = null;
function displayText(s, max, min = 1) {
  if (typeof s !== "string" || s.length > max * 10) return false;
  if (min === 0 && s === "") return true;
  if (s.normalize("NFC") !== s || FORBIDDEN_TEXT.test(s) || s.trim() !== s || !VISIBLE_TEXT.test(s)) return false;
  try {
    graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let count = 0; for (const _part of graphemes.segment(s)) if (++count > max) return false;
    return count >= min;
  } catch { return false; }
}
function manifest(x) {
  if (!subset(x, ["v", "kind", "runtime", "worker", "name", "title", "description", "poster", "regions", "layer", "box", "cursor", "wants", "params"]) || x.v !== 1 || x.kind !== "effect" || x.runtime !== "canvas-worker-v1" || x.worker !== "worker.js"
    || typeof x.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(x.name) || !displayText(x.title, 40)
    || x.description !== undefined && !displayText(x.description, 200, 0) || x.poster !== undefined && x.poster !== "poster.png"
    || !enumeration(x.regions, REGIONS, 1) || !["behind", "front"].includes(x.layer) || !enumeration(x.wants, WANTS)) return false;
  if (x.box !== undefined && (!exact(x.box, ["anchor", "width", "height", "offset"]) || !["top-left", "top-right", "bottom-left", "bottom-right", "center"].includes(x.box.anchor) || !integer(x.box.width, 32, 480) || !integer(x.box.height, 32, 480) || !integer(x.box.offset, 0, 64))) return false;
  if (x.cursor !== undefined && (!exact(x.cursor, ["hotspot"]) || !Array.isArray(x.cursor.hotspot) || x.cursor.hotspot.length !== 2 || !x.cursor.hotspot.every(v => integer(v, 0, 63)))) return false;
  if (x.params === undefined) return true;
  if (!plain(x.params) || Object.keys(x.params).length > 16) return false;
  return Object.entries(x.params).every(([k, d]) => {
    if (!PARAM.test(k) || !plain(d)) return false;
    if (d.type === "number" || d.type === "int") return subset(d, ["type", "min", "max", "default", ...(d.type === "number" ? ["step"] : [])]) && [d.min, d.max, d.default].every(v => finite(v) && Math.abs(v) <= 1e9 && (d.type !== "int" || Number.isInteger(v)))
      && d.min <= d.max && d.default >= d.min && d.default <= d.max && (d.step === undefined || finite(d.step) && d.step > 0 && d.step <= 2e9 && aligned(d.default, d));
    if (d.type === "bool") return exact(d, ["type", "default"]) && typeof d.default === "boolean";
    if (d.type === "color") return exact(d, ["type", "default"]) && typeof d.default === "string" && /^#[0-9a-f]{6}$/.test(d.default);
    return d.type === "enum" && exact(d, ["type", "default", "values"]) && Array.isArray(d.values) && d.values.length >= 1 && d.values.length <= 16 && new Set(d.values).size === d.values.length && d.values.every(v => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(v)) && d.values.includes(d.default);
  });
}
function aligned(v, d) { const n = (v - d.min) / d.step; return Number.isFinite(n) && Math.abs(n - Math.round(n)) <= 1e-8; }
function params(m, values) {
  const defs = m.params ?? {};
  return plain(values) && Object.keys(values).sort().join(",") === Object.keys(defs).sort().join(",") && Object.entries(defs).every(([key, d]) => {
    const v = values[key];
    if (d.type === "number" || d.type === "int") return finite(v) && v >= d.min && v <= d.max && (d.type !== "int" || Number.isSafeInteger(v)) && (d.step === undefined || aligned(v, d));
    if (d.type === "bool") return typeof v === "boolean";
    return d.type === "enum" ? d.values.includes(v) : typeof v === "string" && /^#[0-9a-f]{6}$/.test(v);
  });
}
/** HTTP data only: authoritative provenance comes from the host's persisted placement, never a manifest. */
export function checkEffectPlacements(input) {
  const x = data(input); if (!exact(x, ["rev", "effects"]) || !integer(x.rev, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(x.effects) || x.effects.length > 2) return null;
  const ids = new Set();
  for (const p of x.effects) {
    if (!exact(p, ["id", "by", "at", "manifest", "params"]) || typeof p.id !== "string" || !ID.test(p.id) || ids.has(p.id) || !["human", "agent"].includes(p.by) || !integer(p.at, 0, Number.MAX_SAFE_INTEGER) || !manifest(p.manifest) || !params(p.manifest, p.params)) return null;
    ids.add(p.id);
  }
  return x;
}
/** Never include host poster/cursor bytes in the Worker asset list. The factory snapshots again. */
export function checkEffectResource(input, expectedId) {
  const x = data(input); if (!exact(x, ["id", "manifest", "params", "wants", "code", "assets"]) || typeof expectedId !== "string" || !ID.test(expectedId) || x.id !== expectedId || !manifest(x.manifest) || !params(x.manifest, x.params)
    || !enumeration(x.wants, WANTS) || JSON.stringify(x.wants) !== JSON.stringify(x.manifest.wants) || typeof x.code !== "string" || x.code.length > MIB || !Array.isArray(x.assets) || x.assets.length > 16) return null;
  const encoder = new TextEncoder(), code = encoder.encode(x.code); let bytes = code.length + encoder.encode(JSON.stringify(x.params)).length;
  if (bytes > MIB || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(code) !== x.code) return null;
  const names = new Set(), assets = [];
  for (const a of x.assets) {
    if (!exact(a, ["name", "mime", "data_b64"]) || typeof a.name !== "string" || !/^assets\/[a-z0-9][a-z0-9_-]{0,63}\.(png|jpe?g|webp|gif)$/.test(a.name) || names.has(a.name) || typeof a.data_b64 !== "string" || a.data_b64.length > Math.ceil(MIB / 3) * 4 || a.data_b64.length % 4 !== 0) return null;
    const ext = a.name.slice(a.name.lastIndexOf(".") + 1), mime = ["jpg", "jpeg"].includes(ext) ? "image/jpeg" : `image/${ext}`;
    if (a.mime !== mime) return null;
    let raw; try { raw = atob(a.data_b64); if (btoa(raw) !== a.data_b64) return null; } catch { return null; }
    if (!raw.length || (bytes += raw.length) > MIB) return null;
    names.add(a.name); assets.push({ name: a.name, mime, bytes: Uint8Array.from(raw, c => c.charCodeAt(0)) });
  }
  return { id: x.id, manifest: x.manifest, params: x.params, wants: x.wants, code: x.code, assets };
}

/** The host freezes ownerEpoch/current at page creation; neither is taken from a response or an effect. */
export function createEffectRuntimeLoader({ window: host, ownerEpoch, current } = {}) {
  if (!host || typeof host !== "object" || loaders.has(host) || typeof host.fetch !== "function" || typeof host.AbortController !== "function" || typeof host.setTimeout !== "function" || typeof host.clearTimeout !== "function" || typeof ownerEpoch !== "string" || !EPOCH.test(ownerEpoch) || typeof current !== "function") return { ok: false };
  const reservation = {}; loaders.set(host, reservation);
  let dead = false, revoked = false, previous = null; const pending = new Set();
  const releaseWindow = () => { if (dead && pending.size === 0 && loaders.get(host) === reservation) loaders.delete(host); };
  const now = () => { let t; try { t = host.performance.now(); } catch { revoked = true; return null; } if (!finite(t) || t < 0 || previous !== null && t < previous) { revoked = true; return null; } previous = t; return t; };
  const alive = () => { try { if (!dead && !revoked && current() === true) return true; } catch { /* unknown */ } revoked = true; return false; };
  if (!alive() || now() === null) { dead = true; releaseWindow(); return { ok: false }; }
  function run(kind, path, project, signal) {
    if (dead || revoked) return Promise.resolve(null);
    const began = now(); if (began === null) return Promise.resolve(null);
    if (!alive() || signal?.aborted || [...pending].filter(p => p.kind === kind).length >= (kind === "resource" ? 3 : 1)) return Promise.resolve(null);
    const controller = new host.AbortController(), op = { kind, controller, abort: null }, limit = kind === "placements" ? 256 * 1024 : WIRE; pending.add(op);
    let release, reader = null, timer = null;
    const cancelled = new Promise(resolve => { release = resolve; });
    const abort = () => { controller.abort(); try { const result = reader?.cancel(); result?.catch?.(() => {}); } catch { /* no retry */ } release(null); };
    op.abort = abort;
    const valid = () => { if (!alive() || controller.signal.aborted) { abort(); return false; } const t = now(); if (t === null || t < began || t - began >= 10000) { abort(); return false; } return true; };
    const work = Promise.resolve().then(async () => {
      if (!valid()) return null;
      const response = await host.fetch(path, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
      if (!valid()) return null;
      if ([401, 403, 409].includes(response.status)) { revoked = true; return null; }
      if (!response.ok || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) return null;
      const length = response.headers.get("content-length");
      if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !integer(Number(length), 0, limit))) return null;
      if (!response.body || typeof response.body.getReader !== "function") return null;
      reader = response.body.getReader(); const chunks = []; let size = 0;
      for (;;) {
        const part = await reader.read(); if (!valid()) return null;
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || (size += part.value.length) > limit) { abort(); return null; }
        chunks.push(part.value.slice());
      }
      const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
      let value; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return null; }
      if (!valid()) return null;
      const answer = project(value); return valid() ? answer : null;
    }).catch(() => null).finally(() => { controller.abort(); pending.delete(op); releaseWindow(); host.clearTimeout(timer); signal?.removeEventListener("abort", abort); try { const r = reader?.cancel(); r?.catch?.(() => {}); } catch { /* no retry */ } });
    timer = host.setTimeout(abort, 10000); signal?.addEventListener("abort", abort, { once: true });
    return Promise.race([work, cancelled]);
  }
  return { ok: true,
    placements(instance, signal) { return instanceOK(instance) ? run("placements", `/ui/effects/placements?instance=${encodeURIComponent(instance)}&ownerEpoch=${ownerEpoch}`, checkEffectPlacements, signal) : Promise.resolve(null); },
    resource(input, signal) {
      const spec = data(input);
      if (!subset(spec, ["id", "instance", "slot"]) || typeof spec.id !== "string" || !ID.test(spec.id) || (spec.instance !== undefined) === (spec.slot !== undefined) || spec.instance !== undefined && !instanceOK(spec.instance) || spec.slot !== undefined && !SLOTS.includes(spec.slot)) return Promise.resolve(null);
      const id = spec.id, scope = spec.instance !== undefined ? `instance=${encodeURIComponent(spec.instance)}` : `slot=${encodeURIComponent(spec.slot)}`;
      return run("resource", `/ui/effects/resource/${id}?${scope}&ownerEpoch=${ownerEpoch}`, value => checkEffectResource(value, id), signal);
    },
    dispose() { if (dead) return; dead = true; for (const p of pending) p.abort(); releaseWindow(); },
  };
}
