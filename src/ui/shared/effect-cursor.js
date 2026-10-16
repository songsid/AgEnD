/** #1629: host-owned static cursor controller; no product startup, metadata reader, Worker or frame. */
import { effectHostStyle } from "./effect-host-style.js";
import { checkStaticEffectCursor } from "./effect-runtime-loader.js";
const owners = new WeakMap(), ATTRIBUTE = "data-agend-effect-cursor";
let serial = 0;
const finite = n => typeof n === "number" && Number.isFinite(n) && n >= 0;
function selection(value) {
  try {
    if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(fields).length !== 3 || !["id", "generation", "hotspot"].every(k => fields[k] && Object.hasOwn(fields[k], "value"))) return null;
    const { id, generation, hotspot } = value;
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id) || !Number.isSafeInteger(generation) || generation < 0 || !Array.isArray(hotspot) || Object.getPrototypeOf(hotspot) !== Array.prototype) return null;
    const entries = Object.getOwnPropertyDescriptors(hotspot);
    if (Reflect.ownKeys(entries).length !== 3 || entries.length?.value !== 2 || ![0, 1].every(k => entries[k] && Object.hasOwn(entries[k], "value") && Number.isInteger(entries[k].value) && entries[k].value >= 0 && entries[k].value <= 63)) return null;
    return Object.freeze({ id, generation, hotspot: Object.freeze([entries[0].value, entries[1].value]) });
  } catch { return null; }
}
function cursorMatches(value, url, hotspot) {
  const m = typeof value === "string" && /^url\((["']?)(blob:[^"'()\s]+)\1\)\s+(\d+)\s+(\d+),\s*auto$/.exec(value);
  return !!m && m[2] === url && Number(m[3]) === hotspot[0] && Number(m[4]) === hotspot[1];
}
/** readImage must be the existing shared loader's settled cursor operation. enabled is a host gate, never effect data. */
export function createEffectCursor({ window: host, current, readImage, onChange = () => {} } = {}) {
  const unavailable = { ok: false, update() {}, snapshot: () => ({ status: "unavailable", id: null }), dispose() {} };
  if (!host?.document || owners.has(host) || ![current, readImage, onChange, host.getComputedStyle, host.Blob, host.URL?.createObjectURL, host.URL?.revokeObjectURL, host.AbortController, host.setTimeout, host.clearTimeout, host.performance?.now].every(x => typeof x === "function")) return unavailable;
  const token = {}; owners.set(host, token);
  const doc = host.document; let dead = false, previous = null, wanted = null, pending = null, active = null, blocked = null, generation = 0, checking = false, notifying = false, status = "off";
  const safe = fn => { try { return fn(); } catch { return null; } };
  const release = () => { if (dead && !pending && owners.get(host) === token) owners.delete(host); };
  function alive() {
    if (dead || checking) return false;
    checking = true; const value = safe(() => current() === true && host.document === doc); checking = false;
    return !dead && value === true;
  }
  function now() {
    const value = safe(() => host.performance.now());
    if (!finite(value) || previous !== null && value < previous) { dispose(); return null; }
    previous = value; return value;
  }
  function target() {
    const all = doc.querySelectorAll("#app > .shell"), el = all.length === 1 ? all[0] : null;
    return el?.ownerDocument === doc && el.isConnected === true ? el : null;
  }
  function remove(row) {
    if (!row) return;
    // Removing our exact attribute disarms even a stylesheet whose CSSOM has become unreadable.
    safe(() => { if (row.element.getAttribute(ATTRIBUTE) === row.token) row.element.removeAttribute(ATTRIBUTE); });
    safe(() => row.rule?.style.removeProperty("cursor"));
    safe(() => { const at = [...row.sheet.cssRules].indexOf(row.rule); if (at >= 0) row.sheet.deleteRule(at); });
    if (row.url) { safe(() => host.URL.revokeObjectURL(row.url)); row.url = null; }
  }
  function clear() { const old = active; active = null; remove(old); }
  function tell() { if (dead || notifying) return; notifying = true; try { safe(() => onChange(snapshot())); } finally { notifying = false; } }
  function snapshot() { return Object.freeze({ status: dead ? "unavailable" : status, id: wanted?.selection.id ?? null }); }
  function dispose() {
    if (dead) return; dead = true; generation++; wanted = null; clear();
    if (pending) { safe(() => pending.controller.abort()); remove(pending); }
    safe(() => host.removeEventListener?.("pagehide", dispose)); release();
  }
  if (!alive() || now() === null || !effectHostStyle(host)) { dispose(); return unavailable; }
  safe(() => host.addEventListener?.("pagehide", dispose));
  function valid(op) {
    if (!alive() || pending !== op || op.generation !== generation || op.controller.signal.aborted || wanted !== op.wanted) return false;
    const t = now();
    return t !== null && t >= op.began && t - op.began < 10000 && target() === op.element && effectHostStyle(host) === op.sheet;
  }
  function fail(op) {
    if (!dead && pending === op && generation === op.generation && wanted === op.wanted) { blocked = wanted; status = "unavailable"; tell(); }
  }
  async function load(op) {
    try {
      if (!valid(op)) return;
      const bytes = await readImage(op.wanted.selection, op.controller.signal);
      if (!valid(op)) return;
      const checked = checkStaticEffectCursor(bytes); if (!checked) { fail(op); return; }
      const view = new DataView(checked.buffer, checked.byteOffset, checked.byteLength), width = view.getUint32(16), height = view.getUint32(20);
      if (op.wanted.selection.hotspot.some((v, n) => v >= (n === 0 ? width : height))) { fail(op); return; }
      op.url = host.URL.createObjectURL(new host.Blob([checked], { type: "image/png" }));
      const url = new URL(op.url); if (url.protocol !== "blob:" || url.origin !== host.location.origin || !/^blob:[^"'()\s\\]+$/.test(op.url)) { fail(op); return; }
      const image = doc.createElement("img"); image.alt = ""; image.src = op.url; op.image = image;
      if (typeof image.decode !== "function") { fail(op); return; }
      await image.decode();
      if (!valid(op)) return;
      if (image.naturalWidth !== width || image.naturalHeight !== height) { fail(op); return; }
      if (op.element.hasAttribute(ATTRIBUTE)) { fail(op); return; }
      op.token = `agend-effect-cursor-${++serial}`;
      const index = op.sheet.insertRule(`#app > .shell[${ATTRIBUTE}="${op.token}"]{}`, op.sheet.cssRules.length); op.rule = op.sheet.cssRules[index];
      const hotspot = op.wanted.selection.hotspot, value = `url("${op.url}") ${hotspot[0]} ${hotspot[1]}, auto`;
      op.rule.style.setProperty("cursor", value); op.element.setAttribute(ATTRIBUTE, op.token);
      if (!valid(op) || !cursorMatches(op.rule.style.getPropertyValue("cursor"), op.url, hotspot) || !cursorMatches(host.getComputedStyle(op.element).cursor, op.url, hotspot)) { fail(op); return; }
      active = op; status = "running"; tell();
    } catch { fail(op); }
    finally {
      safe(() => host.clearTimeout(op.timer));
      if (active !== op) remove(op);
      if (pending === op) { pending = null; if (!dead && wanted === op.wanted && !active && blocked !== wanted) { blocked = wanted; status = "unavailable"; tell(); } }
      release(); if (!dead) start();
    }
  }
  function start() {
    if (!alive() || pending || active || !wanted || blocked === wanted) return;
    const began = now(), element = safe(target), sheet = effectHostStyle(host);
    if (began === null || !element || !sheet || element.hasAttribute(ATTRIBUTE)) { blocked = wanted; status = "unavailable"; tell(); return; }
    const op = { wanted, generation, began, element, sheet, controller: new host.AbortController(), url: null, rule: null, token: null, timer: null }; pending = op; status = "loading";
    op.timer = host.setTimeout(() => { if (pending !== op) return; op.controller.abort(); remove(op); fail(op); }, 10000);
    tell(); void load(op);
  }
  function update(value, enabled) {
    if (!alive() || now() === null) { dispose(); return; }
    const next = enabled === true ? selection(value) : null;
    const same = !!next && wanted && next.id === wanted.selection.id && next.generation === wanted.selection.generation && next.hotspot.every((n, i) => n === wanted.selection.hotspot[i]);
    if (!same) {
      generation++; wanted = next ? { selection: next } : null; blocked = null; clear();
      if (pending) { safe(() => pending.controller.abort()); remove(pending); }
      status = next ? "loading" : "off";
    }
    if (active) {
      const row = active;
      if (safe(target) !== row.element || effectHostStyle(host) !== row.sheet || row.element.getAttribute(ATTRIBUTE) !== row.token || !cursorMatches(safe(() => host.getComputedStyle(row.element).cursor), row.url, row.wanted.selection.hotspot)) { clear(); blocked = wanted; status = "unavailable"; }
    }
    start(); tell();
  }
  return { ok: true, update, snapshot, dispose };
}
