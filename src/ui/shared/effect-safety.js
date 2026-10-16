/** #1629: synchronous browser probation/history participant. No product startup or frame creation. */
import { newEffectPauseHistory, recordEffectPause } from "./effect-profiler.js";

const PREFIX = "agend_effect_safety_v1:", MAX_KEYS = 4096, MAX_RECORDS = 2048, MAX_BYTES = 512 * 1024;
const plain = o => !!o && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
const idOK = x => typeof x === "string" && /^[a-f0-9]{32}$/.test(x);
const deviceOK = x => x === "standard" || x === "constrained";
const wallOK = x => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const fields = (o, expected) => plain(o) && Object.keys(o).sort().join(",") === expected.split(",").sort().join(",");
const keyFor = r => `${PREFIX}${r.kind}:${r.id}:${r.device}:${r.token}`;
function valid(r) {
  if (!plain(r) || r.v !== 1 || !idOK(r.id) || !deviceOK(r.device) || !idOK(r.token)) return false;
  if (r.kind === "probation") return fields(r, "v,kind,id,device,token,owner,at") && idOK(r.owner) && wallOK(r.at);
  if (r.kind === "pause") return fields(r, "v,kind,id,device,token,at") && wallOK(r.at);
  return r.kind === "resume" && fields(r, "v,kind,id,device,token");
}

/**
 * Storage is local to this browser/origin. Append-only pause receipts avoid read/modify/write lost updates
 * between tabs. Explicit human Resume acknowledges exact pause ids; it never deletes history or sticky off.
 * Any unreadable/unknown receipt, quota failure or incomplete cleanup latches this participant closed.
 */
export function createEffectSafety({ storage, crypto, wall = () => Date.now() } = {}) {
  let fault = false, owner = null;
  const owned = new Map();
  const fail = () => { fault = true; return null; };
  const nonce = () => {
    try {
      const bytes = new Uint8Array(16); if (crypto.getRandomValues(bytes) !== bytes) return fail();
      return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
    } catch { return fail(); }
  };
  try {
    if (!storage || ["key", "getItem", "setItem", "removeItem"].some(k => typeof storage[k] !== "function") || typeof crypto?.getRandomValues !== "function" || typeof wall !== "function") fault = true;
    else owner = nonce();
  } catch { fault = true; }
  function read() {
    if (fault) return null;
    try {
      const length = storage.length;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_KEYS) return fail();
      const rows = new Map(), seen = new Set(); let bytes = 0;
      for (let i = 0; i < length; i++) {
        const key = storage.key(i);
        if (typeof key !== "string" || seen.has(key)) return fail();
        seen.add(key);
        if (!key.startsWith(PREFIX)) continue;
        const text = storage.getItem(key);
        if (typeof text !== "string" || text.length > 1024) return fail();
        bytes += (key.length + text.length) * 2;
        if (bytes > MAX_BYTES || rows.size >= MAX_RECORDS) return fail();
        const value = JSON.parse(text);
        if (!valid(value) || keyFor(value) !== key) return fail();
        rows.set(key, { value, text });
      }
      if (storage.length !== length) return fail();
      // A still-owned probation receipt cannot disappear or change beneath a live page. Another tab's
      // explicit Resume may remove it; that page must stop rather than silently treating the loss as healthy.
      for (const item of owned.values()) if (rows.get(item.key)?.text !== item.text) return fail();
      for (const { value: r } of rows.values()) if (r.kind === "resume" && !rows.has(keyFor({ ...r, kind: "pause" }))) return fail();
      return rows;
    } catch { return fail(); }
  }
  function inspect(rows, id, device) {
    const relevant = [...rows.values()].map(x => x.value).filter(r => r.id === id && r.device === device);
    const pauses = relevant.filter(r => r.kind === "pause").sort((a, b) => a.at - b.at || a.token.localeCompare(b.token));
    let history = newEffectPauseHistory(id, device, 0);
    for (const r of pauses) { const next = recordEffectPause(history, r.at); if (!next.ok) return fail(); history = next.history; }
    const interrupted = relevant.some(r => r.kind === "probation" && r.owner !== owner);
    const paused = pauses.some(r => !rows.has(keyFor({ ...r, kind: "resume" })));
    return { state: history.off ? "off" : interrupted ? "interrupted" : paused ? "paused" : "ok", history };
  }
  function put(record, rows) {
    try {
      const key = keyFor(record), text = JSON.stringify(record), previous = storage.getItem(key);
      if (previous !== null) { if (previous === text) return true; return !!fail(); }
      if (rows.size >= MAX_RECORDS || [...rows].reduce((n, [k, r]) => n + (k.length + r.text.length) * 2, (key.length + text.length) * 2) > MAX_BYTES) return !!fail();
      storage.setItem(key, text);
      if (storage.getItem(key) !== text) return !!fail();
      return true;
    } catch { return !!fail(); }
  }
  function remove(key, text) {
    try {
      if (storage.getItem(key) !== text) return !!fail();
      storage.removeItem(key);
      if (storage.getItem(key) !== null) return !!fail();
      return true;
    } catch { return !!fail(); }
  }
  function stamp(rows, id, device) {
    try {
      const now = wall(); if (!wallOK(now)) return fail();
      return Math.max(now, ...[...rows.values()].map(x => x.value).filter(r => r.id === id && r.device === device && "at" in r).map(r => r.at));
    } catch { return fail(); }
  }
  const status = (id, device) => {
    if (!idOK(id) || !deviceOK(device)) return { state: "unknown" };
    const rows = read(), result = rows && inspect(rows, id, device);
    return result ? { state: result.state, history: { ...result.history, pauses: [...result.history.pauses] } } : { state: "unknown" };
  };
  return {
    status,
    allowed(id, device) { return status(id, device).state === "ok"; },
    begin(spec) {
      if (!plain(spec) || !idOK(spec.id) || !deviceOK(spec.device) || typeof spec.key !== "string" || spec.key.length < 1 || spec.key.length > 256) return null;
      const rows = read(), state = rows && inspect(rows, spec.id, spec.device);
      if (!state || state.state !== "ok") return null;
      const token = nonce(), at = stamp(rows, spec.id, spec.device);
      if (token === null || at === null) return null;
      const record = { v: 1, kind: "probation", id: spec.id, device: spec.device, token, owner, at };
      // Never overwrite a colliding marker, even one this page already owns.
      if (rows.has(keyFor(record))) return fail();
      if (!put(record, rows)) return null;
      const fresh = read(), verified = fresh && inspect(fresh, spec.id, spec.device);
      if (!verified || verified.state !== "ok" || fresh.get(keyFor(record))?.text !== JSON.stringify(record)) { if (!fault) remove(keyFor(record), JSON.stringify(record)); return null; }
      owned.set(token, { key: keyFor(record), text: JSON.stringify(record) });
      return token;
    },
    finish(token, reason) {
      if (fault || !idOK(token) || typeof reason !== "string" || reason.length < 1 || reason.length > 128) return false;
      const item = owned.get(token); if (!item) return false;
      if (!remove(item.key, item.text)) return false;
      owned.delete(token); return true;
    },
    pause(record) {
      if (!plain(record) || !idOK(record.id) || !deviceOK(record.device) || record.reason !== "host_budget") return false;
      const rows = read(); if (!rows) return false;
      const token = nonce(), at = stamp(rows, record.id, record.device);
      if (token === null || at === null) return false;
      const value = { v: 1, kind: "pause", id: record.id, device: record.device, token, at };
      if (rows.has(keyFor(value))) return !!fail();
      return put(value, rows);
    },
    /** Human action only: acknowledges the observed pauses, leaving every immutable history receipt intact. */
    resume(id, device) {
      if (!idOK(id) || !deviceOK(device)) return false;
      const rows = read(), state = rows && inspect(rows, id, device);
      if (!state || state.state === "off") return false;
      for (const [key, { value: r, text }] of rows) {
        if (r.id !== id || r.device !== device) continue;
        if (r.kind === "probation" && r.owner !== owner && !remove(key, text)) return false;
        if (r.kind === "pause" && !rows.has(keyFor({ ...r, kind: "resume" }))) {
          const ack = { v: 1, kind: "resume", id, device, token: r.token };
          if (!put(ack, rows)) return false;
          rows.set(keyFor(ack), { value: ack, text: JSON.stringify(ack) });
        }
      }
      const fresh = read(), verified = fresh && inspect(fresh, id, device);
      return verified?.state === "ok";
    },
  };
}
