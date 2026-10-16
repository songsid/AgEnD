// #1629: transient host notifications, never message content or replay/history authority.
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function fields(value, keys, closed = false) {
  try {
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    if (closed && Reflect.ownKeys(value).length !== keys.length) return null;
    const out = {};
    for (const k of keys) { const d = Object.getOwnPropertyDescriptor(value, k); if (!d || !own(d, "value")) return null; out[k] = d.value; }
    return out;
  } catch { return null; }
}
const identity = x => !!x && typeof x.boot === "string" && /^[0-9a-f]{1,32}$/.test(x.boot)
  && Number.isSafeInteger(x.id) && x.id > 0 && typeof x.instance === "string" && x.instance.length >= 1 && x.instance.length <= 128;
const MAX_AGE = 5000, MAX_BOOTS = 64, MAX_PENDING = 64;
export function createLiveAgentReplies(now) {
  const seen = new Map(), pending = new Map(), listeners = new Set();
  let last = null, revoked = false;
  function time() {
    if (revoked) return null;
    let t; try { t = now(); } catch { t = null; }
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || last !== null && t < last) { revoked = true; pending.clear(); return null; }
    last = t;
    for (const [key, item] of pending) if (t - item.at > MAX_AGE) pending.delete(key);
    return t;
  }
  function ingress(extra, t) {
    const e = fields(extra, ["source", "receivedAt"], true);
    return e && e.source === "sse" && typeof e.receivedAt === "number" && Number.isFinite(e.receivedAt) && e.receivedAt >= 0 && e.receivedAt <= t && t - e.receivedAt <= MAX_AGE ? e.receivedAt : null;
  }
  return {
    // Record every accepted ingress, including history/poll, before its message-array merge/eviction.
    message(value, extra) {
      const m = fields(value, ["boot", "id", "instance"]); if (!identity(m)) return;
      const role = fields(value, ["role"])?.role;
      const t = time(); if (t === null) return;
      const key = `${m.boot}:${m.id}`, previous = seen.get(m.boot) || 0;
      pending.delete(key);
      if (!seen.has(m.boot) && seen.size >= MAX_BOOTS) { revoked = true; pending.clear(); return; }
      seen.set(m.boot, Math.max(previous, m.id));
      const at = ingress(extra, t);
      if (m.id <= previous || role !== "agent" || at === null) return;
      // Reconnect replay has no receipts: discard old candidates, never the durable-in-page watermark.
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
      pending.set(key, { instance: m.instance, at });
    },
    receipt(value, extra) {
      const r = fields(value, ["v", "boot", "id", "instance"], true); if (!identity(r) || r.v !== 1) return false;
      const t = time(); if (t === null) return false;
      const at = ingress(extra, t); if (at === null) return false;
      const key = `${r.boot}:${r.id}`, candidate = pending.get(key); pending.delete(key);
      if (!candidate || candidate.instance !== r.instance || at < candidate.at || t - candidate.at > MAX_AGE) return false;
      const event = Object.freeze({ v: 1, boot: r.boot, id: r.id, instance: r.instance });
      for (const fn of [...listeners]) { try { fn(event); } catch { /* one host observer cannot suppress another */ } }
      return true;
    },
    subscribe(fn) { if (typeof fn !== "function") return () => {}; listeners.add(fn); return () => listeners.delete(fn); },
  };
}
