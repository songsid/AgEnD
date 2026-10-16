/** #1629: host-only personal region targets on the currently proven stock shell. No selection, code or frame authority. */
import { createEffectGeometry, hostEffectRect, hostEffectSpace } from "./effect-geometry.js";
import { effectStockSnapshot } from "./effect-stock-snapshot.js";
const finite = n => typeof n === "number" && Number.isFinite(n);
function viewport(host) {
  const width = host.innerWidth, height = host.innerHeight;
  return [width, height].every(n => Number.isInteger(n) && n >= 1 && n <= 4096) && width * height <= 8388608 ? { x: 0, y: 0, width, height } : null;
}
/** An anchored box uses edge padding; center ignores the offset. Oversized boxes shrink within that padding. */
export function ownerEffectBoxRect(box, size) {
  try {
    if (!box || ![Object.prototype, null].includes(Object.getPrototypeOf(box))) return null;
    const fields = Object.getOwnPropertyDescriptors(box), keys = Reflect.ownKeys(fields);
    if (keys.length !== 4 || !["anchor", "width", "height", "offset"].every(k => fields[k] && Object.hasOwn(fields[k], "value"))) return null;
    const b = Object.fromEntries(Object.entries(fields).map(([k, d]) => [k, d.value]));
    if (!["top-left", "top-right", "bottom-left", "bottom-right", "center"].includes(b.anchor) || ![b.width, b.height].every(n => Number.isInteger(n) && n >= 32 && n <= 480) || !Number.isInteger(b.offset) || b.offset < 0 || b.offset > 64 || !size || ![size.width, size.height].every(n => Number.isInteger(n) && n >= 1 && n <= 4096) || size.width * size.height > 8388608) return null;
    const pad = b.anchor === "center" ? 0 : b.offset, width = Math.min(b.width, size.width - pad * 2), height = Math.min(b.height, size.height - pad * 2);
    if (width < 1 || height < 1) return null;
    const x = b.anchor === "center" ? Math.floor((size.width - width) / 2) : b.anchor.endsWith("right") ? size.width - pad - width : pad;
    const y = b.anchor === "center" ? Math.floor((size.height - height) / 2) : b.anchor.startsWith("bottom") ? size.height - pad - height : pad;
    return { x, y, width, height };
  } catch { return null; }
}
/** Caller supplies the authenticated lease and fresh stock proof. Header/sidebar are real stock elements;
 * page/box are empty hidden host DOM references, never author DOM. They consume no frame/cap slot.
 * A null result requires removing that descriptor; this primitive cannot retire a caller-owned effect frame. */
export function createOwnerEffectRegions({ window: host, current, factories = {} } = {}) {
  let dead = false, root = null, geometry = null;
  const targets = new Map();
  const dispose = () => { if (dead) return; dead = true; geometry?.dispose?.(); root?.remove(); targets.clear(); };
  const refuse = () => { for (const row of targets.values()) row.binding.hide(); return null; };
  const unavailable = () => ({ ok: false, dispose });
  const alive = () => { if (dead) return false; const valid = current() === true; return !dead && valid && host.document.body.dataset.mode === "full"; };
  try {
    if (!host?.document || typeof current !== "function" || typeof host.getComputedStyle !== "function" || !alive()) return unavailable();
    root = host.document.createElement("div"); root.className = "agend-effect-layer"; host.document.body.append(root);
    geometry = (factories.geometry ?? createEffectGeometry)({ window: host }); if (!geometry.ok) { dispose(); return unavailable(); }
  } catch { dispose(); return unavailable(); }
  function panel() {
    const nodes = host.document.querySelectorAll(".main > .panel"); if (nodes.length !== 1) return null;
    const el = nodes[0], kind = el.getAttribute("data-effect-panel");
    return kind === null ? el.classList.contains("p-chat") ? el : null
      : ["fleet", "needs", "settings", "view", "log", "details"].includes(kind) && el.classList.contains(`p-${kind}`) ? el : null;
  }
  function resolve(slot, box, stock) {
    try {
      if (!alive() || !effectStockSnapshot(stock)) return refuse();
      const surface = panel(), size = viewport(host); if (!surface || !size) return refuse();
      if (slot === "fx.header" || slot === "fx.sidebar") {
        const selector = slot === "fx.header" ? ".main > .panel > .panel-head[data-trust=header]" : ".shell > .sidebar";
        const nodes = host.document.querySelectorAll(selector); if (nodes.length !== 1) return null;
        const el = nodes[0], s = host.getComputedStyle(el), rect = hostEffectRect(el);
        return alive() && panel() === surface && s.display !== "none" && s.visibility === "visible" && hostEffectSpace(host, el) && rect && rect.x + rect.width > 0 && rect.y + rect.height > 0 && rect.x < size.width && rect.y < size.height ? el : null;
      }
      if (!["fx.page", "fx.box"].includes(slot)) return null;
      const rect = slot === "fx.page" ? size : ownerEffectBoxRect(box, size); if (!rect) return refuse();
      let row = targets.get(slot);
      if (!row) {
        const element = host.document.createElement("div"); element.className = "agend-owner-effect-target"; element.setAttribute("aria-hidden", "true"); root.append(element);
        const binding = geometry.bind(element, { layer: "behind", by: "human" });
        if (!binding.ok) { element.remove(); return null; }
        row = { element, binding }; targets.set(slot, row);
      }
      // Empty reference only: the synchronous existing hidden-first verification is followed by hide before yielding.
      // The future registry owns the actual effect's layer/provenance/caps and independent fresh paint check.
      if (!row.binding.sync(rect, stock)) { row.binding.remove(); targets.delete(slot); return null; }
      row.binding.hide();
      const actual = hostEffectRect(row.element);
      if (!alive() || panel() !== surface || row.element.isConnected !== true || host.getComputedStyle(row.element).visibility !== "hidden" || !actual || !["x", "y", "width", "height"].every(k => finite(actual[k]) && actual[k] === rect[k])) { row.binding.remove(); targets.delete(slot); return null; }
      return row.element;
    } catch { return refuse(); }
  }
  return { ok: true, root, resolve, dispose };
}
