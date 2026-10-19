/** #1629: host-only personal contribution model. No fetch, timer, DOM creation, registry or playback. */
import { checkEffectOwnerSlots } from "./effect-runtime-loader.js";
import { effectStockSnapshot } from "./effect-stock-snapshot.js";
const SLOTS = ["fx.page", "fx.header", "fx.sidebar", "fx.box"], ALL_SLOTS = [...SLOTS, "fx.cursor"];

/** The app supplies its one loader/metadata scheduler, lifetime and fixed stock target resolver. */
export function createOwnerEffectSource({ current, readMetadata, readResource, resolveTarget, stock, onChange = () => {}, onUnavailable = () => {} } = {}) {
  let dead = false, generation = 0, serial = 0, metadata = null, error = null, active = null, rev = -1, checking = false, cursor = null;
  const bySlot = new Map(), byKey = new Map(), paused = new Map(), failed = new Map();
  const safe = fn => { try { return fn(); } catch { return null; } };
  function alive() {
    if (dead || checking) return false;
    const before = generation; checking = true;
    let value; try { value = current() === true; } catch { value = false; } finally { checking = false; }
    return !dead && before === generation && value;
  }
  const fresh = (body, gen) => alive() && generation === gen && metadata === body;
  function drop(slot) { const b = bySlot.get(slot); if (b) byKey.delete(b.key); bySlot.delete(slot); }
  function clear() { bySlot.clear(); byKey.clear(); }
  const notify = () => { if (alive()) safe(onChange); };
  function dispose() { if (dead) return; dead = true; generation++; metadata = null; cursor = null; clear(); paused.clear(); failed.clear(); }
  const unavailable = { ok: false, dispose };
  if (![current, readMetadata, readResource, resolveTarget, stock, onChange, onUnavailable].every(x => typeof x === "function")) return unavailable;
  function row(slot) { return alive() && SLOTS.includes(slot) ? metadata?.slots[slot] ?? null : null; }
  function bindingCurrent(b) {
    if (!b || !alive() || generation !== b.generation || bySlot.get(b.slot) !== b || byKey.get(b.key) !== b || failed.get(b.slot) === b.id) return false;
    const selected = metadata?.slots[b.slot];
    return selected?.status === "available" && selected.id === b.id && b.element.isConnected === true && !dead && generation === b.generation;
  }
  function cursorSelection() {
    const body = metadata, gen = generation;
    if (!alive() || !body || error) return null;
    const selected = body.slots["fx.cursor"];
    if (selected.status !== "available" || failed.get("fx.cursor") === selected.id || !selected.manifest.cursor) return null;
    if (!cursor || cursor.id !== selected.id || cursor.generation !== gen) cursor = Object.freeze({ id: selected.id, generation: gen, hotspot: Object.freeze([...selected.manifest.cursor.hotspot]) });
    return fresh(body, gen) && failed.get("fx.cursor") !== selected.id ? cursor : null;
  }
  function cursorCurrent(value) {
    try {
      const expected = cursorSelection(); if (!expected || !value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
      const d = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(d).length !== 3 || !["id", "generation", "hotspot"].every(k => d[k] && Object.hasOwn(d[k], "value")) || d.id.value !== expected.id || d.generation.value !== expected.generation) return false;
      const a = d.hotspot.value; if (!Array.isArray(a) || Object.getPrototypeOf(a) !== Array.prototype) return false;
      const h = Object.getOwnPropertyDescriptors(a);
      return Reflect.ownKeys(h).length === 3 && h.length.value === 2 && [0, 1].every(k => h[k] && Object.hasOwn(h[k], "value") && h[k].value === expected.hotspot[k]) && cursorSelection() === expected;
    } catch { return false; }
  }
  function refuse(b) {
    if (!bindingCurrent(b)) return;
    failed.set(b.slot, b.id); drop(b.slot); notify();
    if (!dead && generation === b.generation && failed.get(b.slot) === b.id && metadata?.slots[b.slot]?.id === b.id) safe(() => onUnavailable(b.slot, b.id));
  }
  return { ok: true, cursorSelection, cursorCurrent,
    refuseCursor(value) {
      const own = cursorSelection(); if (!own || !cursorCurrent(value)) return;
      failed.set("fx.cursor", own.id); notify();
      if (!dead && generation === own.generation && failed.get("fx.cursor") === own.id && metadata?.slots["fx.cursor"]?.id === own.id) safe(() => onUnavailable("fx.cursor", own.id));
    },
    needsMetadata() { return alive() && metadata === null && error === null; },
    invalidate() { if (dead) return; generation++; metadata = null; cursor = null; error = null; clear(); failed.clear(); notify(); },
    async read(signal) {
      if (!alive() || metadata !== null || error !== null || active || signal?.aborted) return false;
      const op = { generation }; active = op;
      const valid = () => alive() && generation === op.generation && active === op && !signal?.aborted;
      try {
        const answer = await readMetadata(signal); if (!valid()) return false;
        const next = checkEffectOwnerSlots(answer);
        if (!next || next.rev < rev) { error = next ? "stale" : "unreadable"; clear(); notify(); return false; }
        rev = next.rev; metadata = next;
        for (const [slot, id] of paused) if (next.slots[slot]?.id !== id) paused.delete(slot);
        notify(); return valid() && metadata === next;
      } catch { if (valid()) { error = "unreadable"; clear(); notify(); } return false; }
      finally { if (active === op) active = null; }
    },
    descriptors() {
      if (!alive() || !metadata || error) return [];
      const body = metadata, gen = generation;
      // #2188: the stock snapshot walks the whole page (thousands of computed styles). With no slot holding an effect
      // that could play, there is nothing for it to admit: skipped — every page change (a status, a chat switch) ran it.
      if (!SLOTS.some(slot => body.slots[slot]?.status === "available" && failed.get(slot) !== body.slots[slot].id)) {
        for (const slot of SLOTS) drop(slot);
        return [];
      }
      const proof = safe(() => effectStockSnapshot(stock()));
      if (!fresh(body, gen)) return [];
      if (!proof) { clear(); return []; }
      const result = [];
      for (const slot of SLOTS) {
        const selected = body.slots[slot];
        if (selected.status !== "available" || failed.get(slot) === selected.id) { drop(slot); continue; }
        const element = safe(() => resolveTarget(slot, selected.manifest, proof));
        if (!fresh(body, gen)) return [];
        if (!element || element.isConnected !== true) { drop(slot); continue; }
        let b = bySlot.get(slot);
        if (!b || b.id !== selected.id || b.element !== element || b.generation !== gen) {
          drop(slot); b = Object.freeze({ kind: "owner", slot, id: selected.id, key: `owner:${++serial}:${slot}:${selected.id}`, generation: gen, element });
          bySlot.set(slot, b); byKey.set(b.key, b);
        }
        result.push({ key: b.key, id: b.id, by: "human", region: slot.slice(3), layer: selected.manifest.layer, order: 0, paused: paused.get(slot) === b.id, visible: true, instance: null, element });
      }
      return fresh(body, gen) ? result : [];
    },
    binding(key, id) { const b = byKey.get(key); return b?.id === id && bindingCurrent(b) ? b : null; },
    slotBinding(slot) { const b = bySlot.get(slot); return bindingCurrent(b) ? b : null; },
    current: bindingCurrent,
    async load(b, signal) {
      if (!bindingCurrent(b) || signal?.aborted) return null;
      let value; try { value = await readResource({ id: b.id, slot: b.slot }, signal); } catch { value = null; }
      if (!bindingCurrent(b) || signal?.aborted) return null;
      if (!value) { refuse(b); return null; }
      return value;
    },
    pause(slot) { const selected = row(slot); if (selected?.status !== "available") return false; paused.set(slot, selected.id); notify(); return true; },
    unpause(slot) { const selected = row(slot); if (selected?.status !== "available") return false; paused.delete(slot); notify(); return true; },
    snapshot() {
      const live = alive();
      return { error: live ? error : null, rev, loading: live && metadata === null && error === null,
        slots: Object.fromEntries(ALL_SLOTS.map(slot => { const selected = live ? metadata?.slots[slot] : null; return [slot, selected ? failed.get(slot) === selected.id ? { status: "unavailable", id: selected.id } : selected : { status: "unknown", id: null }]; })) };
    },
    dispose,
  };
}
