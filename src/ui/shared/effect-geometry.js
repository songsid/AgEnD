/** #1629: host-only fixed viewport geometry and trust holes through a constructed CSSOM sheet. No inline attributes. */
import { effectTrustClip } from "./effect-policy.js";
let serial = 0;
// Native CSSOM canonicalizes SVG command whitespace. Compare bounded tokens, never whitespace-stripped digits.
function sameClip(expected, written) {
  if (expected === "none") return written === "none";
  const tokens = value => {
    if (typeof value !== "string" || value.length > 100000) return null;
    const m = /^path\(\s*evenodd\s*,\s*["']([^"']*)["']\s*\)$/.exec(value);
    if (!m) return null;
    const out = [], rest = m[1].replace(/[MHVZ]|-?\d+(?:\.\d+)?/g, token => { out.push(/[MHVZ]/.test(token) ? token : Number(token)); return ""; });
    return /^[\s,]*$/.test(rest) ? JSON.stringify(out) : null;
  };
  const a = tokens(expected), b = tokens(written);
  return a !== null && a === b;
}
const number = n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e7;
/** A fixed frame must share viewport axes. Unknown transformed/filter/contained ancestors fail closed. */
export function hostEffectSpace(host, element) {
  try {
    if (element?.ownerDocument !== host.document || element.isConnected !== true || typeof host.getComputedStyle !== "function") return false;
    let el = element, seen = 0;
    while (el) {
      if (++seen > 128 || el.ownerDocument !== host.document) return false;
      const s = host.getComputedStyle(el);
      for (const key of ["transform", "perspective", "filter", "backdropFilter", "rotate", "scale", "translate", "offsetPath"]) if (s[key] !== undefined && s[key] !== "" && s[key] !== "none") return false;
      if (s.contain !== "none" || s.willChange !== "auto" || s.contentVisibility !== undefined && s.contentVisibility !== "" && s.contentVisibility !== "visible" || s.zoom !== undefined && !["", "normal", "1"].includes(s.zoom)) return false;
      if (el === host.document.documentElement) return true;
      el = el.parentElement;
    }
    return false;
  } catch { return false; }
}
export function hostEffectRect(element) {
  try {
    if (element?.isConnected !== true) return null;
    const r = element.getBoundingClientRect();
    if (![r.x, r.y, r.width, r.height].every(number) || r.width < 1 || r.height < 1) return null;
    const x = Math.floor(r.x), y = Math.floor(r.y), width = Math.ceil(r.x + r.width) - x, height = Math.ceil(r.y + r.height) - y;
    return width <= 4096 && height <= 4096 && width * height <= 8388608 ? { x, y, width, height } : null;
  } catch { return null; }
}
export function createEffectGeometry({ window: host, trustRoot } = {}) {
  let sheet, old;
  try {
    if (!host?.document || !trustRoot || typeof trustRoot.querySelectorAll !== "function" || typeof host.CSSStyleSheet !== "function" || !Array.isArray(host.document.adoptedStyleSheets) || host.CSS?.supports("clip-path", 'path(evenodd, "M0 0H1V1H0Z")') !== true) return { ok: false, reason: "geometry_unsupported" };
    old = host.document.adoptedStyleSheets;
    sheet = new host.CSSStyleSheet();
    host.document.adoptedStyleSheets = [...old, sheet];
    if (!host.document.adoptedStyleSheets.includes(sheet)) throw Error("sheet unavailable");
  } catch { return { ok: false, reason: "geometry_unsupported" }; }
  const bound = new Set(); let disposed = false;
  function bind(frame, { layer, by } = {}) {
    if (disposed || !hostEffectSpace(host, frame) || !["front", "behind"].includes(layer) || !frame.classList) return { ok: false, reason: "geometry_unknown" };
    const token = `agend-effect-geometry-${++serial}`;
    let rule;
    try {
      const at = sheet.insertRule(`.${token}{}`, sheet.cssRules.length); rule = sheet.cssRules[at];
      if (!rule?.style) throw Error("rule unavailable");
      for (const [key, value] of Object.entries({ position: "fixed", border: "0px", margin: "0px", padding: "0px", "pointer-events": "none", "z-index": layer === "front" ? "20" : "0", opacity: layer === "front" && by !== "human" ? "0.85" : "1", visibility: "hidden", "background-color": "transparent", "box-sizing": "border-box", "box-shadow": "none", outline: "none", transition: "none", animation: "none", "min-width": "0px", "min-height": "0px", "max-width": "none", "max-height": "none" })) rule.style.setProperty(key, value, "important");
      frame.classList.add(token);
    } catch {
      try { const at = [...sheet.cssRules].indexOf(rule); if (at >= 0) sheet.deleteRule(at); frame.remove(); } catch { /* no readable rule to retain */ }
      return { ok: false, reason: "geometry_unknown" };
    }
    let dead = false;
    const hide = () => {
      try {
        rule.style.setProperty("visibility", "hidden", "important");
        if (frame.isConnected === true && host.getComputedStyle(frame).visibility !== "hidden") frame.remove();
      } catch { frame.remove(); }
    };
    const handle = { ok: true, hide,
      /** Call before revealing, in the same host rAF as geometry observation. */
      sync(rect) {
        if (dead || disposed || !hostEffectSpace(host, frame) || !rect || ![rect.x, rect.y, rect.width, rect.height].every(number) || ![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) || rect.width < 1 || rect.height < 1 || rect.width > 4096 || rect.height > 4096 || rect.width * rect.height > 8388608) { hide(); return false; }
        hide();
        let path = "none";
        if (layer === "front" && by !== "human") {
          try {
            const nodes = trustRoot.querySelectorAll("[data-trust]");
            if (nodes.length > 128) return false;
            const rects = [];
            for (const el of nodes) {
              if (el.isConnected !== true) return false;
              const r = el.getBoundingClientRect();
              // Copy only numeric DOMRect fields. Native DOMRect prototypes are not policy input.
              rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
            }
            const clipped = effectTrustClip(rect, rects);
            if (!clipped.ok) return false;
            path = clipped.path;
          } catch { return false; }
        }
        try {
          for (const key of ["x", "y", "width", "height"]) rule.style.setProperty(key === "x" ? "left" : key === "y" ? "top" : key, `${rect[key]}px`, "important");
          rule.style.setProperty("clip-path", path, "important");
          if (!sameClip(path, rule.style.getPropertyValue("clip-path"))) return false;
          // The stylesheet can lose the cascade to another host rule. Verify the actual viewport and clip
          // before revealing: holes expressed in planned coordinates cannot protect a transformed frame.
          const style = host.getComputedStyle(frame), actual = frame.getBoundingClientRect();
          if (style.position !== "fixed" || style.pointerEvents !== "none" || style.visibility !== "hidden" || style.opacity !== (layer === "front" && by !== "human" ? "0.85" : "1") || style.zIndex !== (layer === "front" ? "20" : "0") || !sameClip(path, style.clipPath) || !["x", "y", "width", "height"].every(key => number(actual[key]) && Math.abs(actual[key] - rect[key]) < 0.02)) return false;
          rule.style.setProperty("visibility", "visible", "important");
          return true;
        } catch { hide(); return false; }
      },
      remove() {
        if (dead) return; dead = true; hide(); bound.delete(handle);
        if (frame.isConnected === true) frame.remove();
        try { frame.classList.remove(token); const at = [...sheet.cssRules].indexOf(rule); if (at >= 0) sheet.deleteRule(at); } catch { frame.remove(); }
      },
    };
    bound.add(handle); return handle;
  }
  return { ok: true, bind,
    hide() { for (const h of bound) h.hide(); },
    dispose() {
      if (disposed) return; disposed = true;
      for (const h of [...bound]) h.remove();
      try { host.document.adoptedStyleSheets = host.document.adoptedStyleSheets.filter(s => s !== sheet); } catch { /* all owned frames must already be removed by the registry */ }
    },
  };
}
