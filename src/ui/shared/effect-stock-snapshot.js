/** #1629: a bounded copy of host stock paint evidence. Never reads an accessor or a DOMRect. */
const snapshots = new WeakSet();
const plain = value => !!value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const finite = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e7;
function fields(value, required, optional = []) {
  if (!plain(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key) || !Object.hasOwn(descriptors[key], "value")) || required.some(key => !Object.hasOwn(descriptors, key))) return null;
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
export function effectStockSnapshot(value) {
  try {
    if (snapshots.has(value)) return value;
    const data = fields(value, ["ok", "front", "agentFront", "rects"], ["reason", "agentReason", "settingsHref"]);
    if (!data || data.ok !== true || typeof data.front !== "boolean" || typeof data.agentFront !== "boolean" || data.agentFront && !data.front || !Array.isArray(data.rects) || data.rects.length > 128) return null;
    // Optional host display metadata is not copied into the paint evidence.
    for (const key of ["reason", "agentReason", "settingsHref"]) if (Object.hasOwn(data, key) && data[key] !== null && (typeof data[key] !== "string" || data[key].length > 256)) return null;
    const entries = Object.getOwnPropertyDescriptors(data.rects), keys = Reflect.ownKeys(entries);
    if (keys.length !== data.rects.length + 1 || keys.some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= data.rects.length || !Object.hasOwn(entries[key], "value")))) return null;
    const rects = [];
    for (let i = 0; i < data.rects.length; i++) {
      const r = fields(entries[i].value, ["x", "y", "width", "height"]);
      if (!r || ![r.x, r.y, r.width, r.height].every(finite) || r.width < 0 || r.height < 0) return null;
      rects.push(Object.freeze(r));
    }
    const result = Object.freeze({ ok: true, front: data.front, agentFront: data.agentFront, rects: Object.freeze(rects) });
    snapshots.add(result); return result;
  } catch { return null; }
}
/** Missing provenance receives the agent rule. Behind still requires proven stock ordering. */
export function effectStockAllows(snapshot, { layer, by } = {}) {
  const proof = effectStockSnapshot(snapshot);
  return !!proof && (layer === "behind" || layer === "front" && proof.front && (by === "human" || proof.agentFront));
}

/** Display only. Refused provider metadata never becomes paint evidence or authority. */
export function effectStockRefusal(value) {
  try {
    if (!plain(value)) return "stock_evidence_invalid";
    const d = Object.getOwnPropertyDescriptor(value, "reason");
    return d && Object.hasOwn(d, "value") && typeof d.value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(d.value) ? d.value : "stock_evidence_invalid";
  } catch { return "stock_evidence_invalid"; }
}
