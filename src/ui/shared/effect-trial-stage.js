/** #1629: host-issued LOCAL trial paint receipt. No authority, loader, frame factory or pool is created here. */
import { effectTrialShadow } from "./effect-trial-shadow.js";
import { effectHostStyle } from "./effect-host-style.js";
import { effectStockSnapshot, effectStockRefusal } from "./effect-stock-snapshot.js";
import { STOCK_EFFECT_BARRIERS } from "./effect-stock-trust.js";
const receipts = new WeakMap(), owners = new WeakMap();
let serial = 0;
const none = v => v === undefined || v === "" || v === "none";
const number = n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e7;
function binding(raw) {
  try {
    if (!raw || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return null;
    const fields = ["key", "id", "run", "instance", "generation"], keys = Reflect.ownKeys(raw), out = {};
    if (keys.length !== fields.length || keys.some(k => typeof k !== "string" || !fields.includes(k))) return null;
    for (const k of fields) { const d = Object.getOwnPropertyDescriptor(raw, k); if (!d || !Object.hasOwn(d, "value") || !d.enumerable) return null; out[k] = d.value; }
    if (typeof out.key !== "string" || !out.key.length || out.key.length > 256 || typeof out.id !== "string" || !/^[0-9a-f]{32}$/.test(out.id)
      || typeof out.run !== "string" || !/^[0-9a-f]{32}$/.test(out.run) || typeof out.instance !== "string" || !out.instance.length || out.instance.length > 128
      || !Number.isSafeInteger(out.generation) || out.generation < 1) return null;
    return Object.freeze(out);
  } catch { return null; }
}
function rect(el) {
  try { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].every(number) && r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; } catch { return null; }
}
function visible(host, el) { const s = host.getComputedStyle(el); return s.display !== "none" && s.visibility === "visible" && !!rect(el); }
function neutral(s) {
  return ["transform", "perspective", "filter", "backdropFilter", "rotate", "scale", "translate", "offsetPath", "clipPath", "maskImage"].every(k => none(s[k]))
    && s.isolation === "auto" && s.mixBlendMode === "normal" && s.willChange === "auto" && (s.zoom === undefined || ["", "normal", "1"].includes(s.zoom)) && [undefined, "", "visible"].includes(s.contentVisibility);
}
/** Inspect immutable identity only; this is NOT current paint permission or a serialized grant. */
export function effectTrialStageIdentity(receipt) { return receipts.get(receipt)?.identity ?? null; }
/** Host-only lifetime observation. Physical removal precedes notification; subscribers never grant paint. */
export function watchEffectTrialStage(receipt, listener) {
  const owner = receipts.get(receipt);
  if (!owner || typeof listener !== "function") return null;
  owner.listeners.add(listener);
  return () => owner.listeners.delete(listener);
}
/** Add one host lease veto before a frame exists. It can only reduce the original owner's permission. */
export function constrainEffectTrialStage(receipt, current) {
  const owner = receipts.get(receipt); return !!owner && owner.constrain(current) === true;
}
/** Retire through the issued owner; caller-supplied cleanup functions are never the physical boundary. */
export function disposeEffectTrialStage(receipt) {
  const owner = receipts.get(receipt); if (!owner) return false;
  owner.invalidate("stopped"); return true;
}
/** Missing/forged/old receipts never turn the ordinary stock front flag on. */
export function effectTrialStage(receipt, expected, stock) {
  try {
    const owner = receipts.get(receipt);
    if (!owner || !expected || ![Object.prototype, null].includes(Object.getPrototypeOf(expected))) return null;
    for (const key of ["key", "id", "instance", "generation"]) {
      const d = Object.getOwnPropertyDescriptor(expected, key);
      if (!d || !Object.hasOwn(d, "value") || d.value !== owner.identity[key]) return null;
    }
    return owner.project(stock);
  } catch { return null; }
}

/** Only the fixed host TrialPanel supplies these elements and a current server-run lease. Not an agent manifest. */
export function createEffectTrialStage({ window: host, panel, stage, binding: raw, current, onStop = () => {} } = {}) {
  const own = binding(raw);
  if (!own || typeof current !== "function" || typeof onStop !== "function" || !host?.document || !panel || !stage || owners.has(stage)) return null;
  const shell = effectTrialShadow(host, panel), hostSheet = effectHostStyle(host);
  let sheet; try { sheet = shell?.sheet; if (!shell || shell.stage !== stage || !hostSheet || !sheet || host.CSS?.supports("contain", "paint") !== true || host.CSS.supports("overflow", "clip") !== true) return null; } catch { return null; }
  const receipt = Object.freeze(Object.create(null)), frames = new Set(), listeners = new Set(); let dead = false, constraint = null, failure = "stage_unavailable";
  const reject = reason => { failure = reason; return null; };
  const identity = Object.freeze({ key: own.key, id: own.id, instance: own.instance, generation: own.generation, serial: ++serial });
  const invalidate = reason => {
    if (dead) return; dead = true; receipts.delete(receipt); if (owners.get(stage) === receipt) owners.delete(stage);
    try { host.removeEventListener("blur", blur); } catch { /* no revival */ }
    for (const f of [...frames]) f.remove();
    const notify = [...listeners]; listeners.clear();
    for (const fn of notify) { try { fn(reason); } catch { /* one host owner cannot block another cleanup */ } }
    try { onStop(reason); } catch { /* cleanup already won */ }
  };
  const blur = event => { if (event.target === host) invalidate("blur"); };
  function check(stock) {
    failure = "trial_layout_unverified";
    try {
      // This callback may reenter disposal or replace the owner. Recheck identity after it returns.
      if (dead || current(own) !== true || constraint !== null && constraint() !== true || dead || owners.get(stage) !== receipt || dead) return reject("trial_current_changed");
      const proof = effectStockSnapshot(stock), doc = host.document;
      if (!proof) return reject(effectStockRefusal(stock));
      if (effectHostStyle(host) !== hostSheet || effectTrialShadow(host, panel) !== shell) return reject("trial_style_unavailable");
      // The own panel MUST still suppress ordinary foreground effects. Never synthesize front:true.
      if (doc.hasFocus?.() !== true) return reject("trial_window_unfocused");
      if (doc.visibilityState !== "visible") return reject("hidden");
      if (proof.front !== false || doc.fullscreenElement || doc.pictureInPictureElement) return reject("trial_overlay_unverified");
      const split = doc.querySelector(".main > .p-chat > .chat-split");
      if (!split || doc.querySelectorAll(".main > .p-chat").length !== 1 || doc.querySelectorAll(".chat-split > .pv-panel").length !== 1
        || panel.parentElement !== split || panel.ownerDocument !== doc || panel.isConnected !== true || panel.className !== "pv-panel effect-trial-panel" || panel.getAttribute("data-trust") !== "preview") return reject("trial_panel_unavailable");
      const children = [...shell.root.children], names = ["effect-trial-style", "effect-trial-head", "effect-trial-controls", "effect-trial-body", "effect-trial-note"];
      if (panel.children.length !== 0 || children.length !== names.length || children.some((el, i) => el.className !== names[i]) || children[3].children.length !== 1 || children[3].firstElementChild !== stage
        || stage.className !== "effect-trial-stage" || stage.ownerDocument !== doc || stage.isConnected !== true || stage.hasAttribute("tabindex") || stage.hasAttribute("contenteditable")) return reject("trial_shadow_unverified");
      for (const control of [shell.head, shell.controls, shell.close, shell.stop, shell.note]) {
        const style = host.getComputedStyle(control);
        if (style.display === "none" || style.visibility !== "visible" || style.opacity !== "1" || !rect(control)) return reject("trial_controls_unavailable");
      }
      if ([...doc.querySelectorAll(STOCK_EFFECT_BARRIERS)].some(el => el !== panel && visible(host, el))
        || [...doc.querySelectorAll(".pv-panel")].some(el => el !== panel && visible(host, el))) return reject("trial_other_overlay");
      const active = doc.activeElement;
      if (active && active !== doc.body && active !== doc.documentElement && (active.matches("input,select,textarea,[contenteditable]") || active.isContentEditable)) return reject("trial_editable_focus");
      let el = stage, depth = 0;
      while (el) { const s = host.getComputedStyle(el); if (++depth > 128 || el.ownerDocument !== doc || !neutral(s) || s.opacity !== "1" || s.visibility !== "visible" || s.display === "none" || s.contain !== (el === stage ? "paint" : "none")) return reject("trial_ancestor_paint"); if (el === doc.documentElement) break; el = el.parentElement ?? (el.getRootNode?.() === shell.root ? panel : null); }
      if (el !== doc.documentElement) return reject("trial_ancestor_paint");
      const s = host.getComputedStyle(stage), r = rect(stage), p = rect(panel);
      if (!r || !p || s.position !== "relative" || s.zIndex !== "0" || s.overflowX !== "clip" || s.overflowY !== "clip"
        || s.paddingLeft !== "0px" || s.paddingRight !== "0px" || s.paddingTop !== "0px" || s.paddingBottom !== "0px"
        || ["borderLeftWidth", "borderRightWidth", "borderTopWidth", "borderBottomWidth"].some(k => s[k] !== "0px") || !none(s.boxShadow) || s.outlineStyle !== "none"
        || r.x < p.x || r.y < p.y || r.x + r.width > p.x + p.width || r.y + r.height > p.y + p.height
        || r.x < 0 || r.y < 0 || r.x + r.width > host.innerWidth || r.y + r.height > host.innerHeight) return reject("trial_clip_unverified");
      if ([...stage.children].some(child => ![...frames].some(f => f.element === child))) return reject("trial_frame_unknown");
      const width = Math.floor(r.width), height = Math.floor(r.height);
      if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 8388608 || dead || owners.get(stage) !== receipt) return reject("trial_size_limit");
      if (current(own) !== true || constraint !== null && constraint() !== true || dead || owners.get(stage) !== receipt || dead || stage.isConnected !== true || panel.parentElement !== split) return reject("trial_current_changed");
      return { x: r.x, y: r.y, width, height };
    } catch { return reject("trial_check_failed"); }
  }
  function project(stock) {
    const r = check(stock); if (!r) { invalidate(failure); return null; }
    return Object.freeze({ root: stage, rect: Object.freeze(r), identity, bind });
  }
  function bind(frame, { layer } = {}, stock) {
    if (frames.size || !["front", "behind"].includes(layer) || frame?.ownerDocument !== host.document || frame.parentElement !== stage || frame.tagName !== "IFRAME") { frame?.remove?.(); return { ok: false }; }
    // The new frame is temporarily known to this owner before the topology check; it remains hidden until sync.
    const token = `agend-effect-trial-${identity.serial}`; let rule, removed = false, shown = false;
    const remove = () => {
      if (removed) return; removed = true; frame.remove(); frames.delete(handle);
      try { frame.classList.remove(token); const i = [...sheet.cssRules].indexOf(rule); if (i >= 0) sheet.deleteRule(i); } catch { /* physically removed first */ }
    };
    const hide = () => {
      shown = false;
      try { rule.style.setProperty("visibility", "hidden", "important"); if (frame.isConnected && host.getComputedStyle(frame).visibility !== "hidden") { remove(); return false; } return !removed; } catch { remove(); return false; }
    };
    const handle = { ok: true, element: frame, remove, hide,
      sync(proof) {
        const r = check(proof); if (!r || removed) { invalidate(failure); return false; }
        try {
          const matches = visibility => {
            const s = host.getComputedStyle(frame), actual = rect(frame);
            return !!actual && s.position === "absolute" && s.visibility === visibility && s.pointerEvents === "none" && s.zIndex === "0" && s.opacity === (layer === "front" ? "0.85" : "1") && neutral(s)
              && ["x", "y", "width", "height"].every(k => Math.abs(actual[k] - r[k]) < 0.02) && actual.x >= r.x && actual.y >= r.y && actual.x + actual.width <= r.x + r.width && actual.y + actual.height <= r.y + r.height
              && frame.isConnected === true && frame.ownerDocument === host.document && frame.parentElement === stage && !dead && !removed && owners.get(stage) === receipt;
          };
          // Reprove the current stage, clipping and actual frame every tick. Hiding/revealing an
          // unchanged iframe each rAF can starve Firefox's OffscreenCanvas presentation.
          if (shown && matches("visible")) return true;
          if (!hide()) throw Error("local hiding lost");
          for (const [k, v] of Object.entries({ left: "0px", top: "0px", width: `${r.width}px`, height: `${r.height}px` })) rule.style.setProperty(k, v, "important");
          if (!matches("hidden")) throw Error("local geometry lost");
          rule.style.setProperty("visibility", "visible", "important"); shown = true; return true;
        } catch { invalidate("trial_frame_geometry"); return false; }
      },
    };
    frames.add(handle);
    try {
      const i = sheet.insertRule(`.${token}{}`, sheet.cssRules.length); rule = sheet.cssRules[i];
      for (const [k, v] of Object.entries({ position: "absolute", visibility: "hidden", "pointer-events": "none", "z-index": "0", opacity: layer === "front" ? "0.85" : "1", border: "0px", margin: "0px", padding: "0px", "box-sizing": "border-box", "min-width": "0px", "min-height": "0px", "max-width": "none", "max-height": "none", outline: "none", "box-shadow": "none", "background-color": "transparent", animation: "none", transition: "none" })) rule.style.setProperty(k, v, "important");
      frame.classList.add(token);
      if (host.getComputedStyle(frame).visibility !== "hidden") throw Error("initial local hiding lost");
      if (!check(stock)) { remove(); invalidate(failure); return { ok: false }; }
    } catch { remove(); invalidate("stage_unavailable"); return { ok: false }; }
    return handle;
  }
  receipts.set(receipt, { identity, project, listeners, invalidate, constrain(fn) { if (dead || frames.size || constraint !== null || typeof fn !== "function") return false; constraint = fn; return true; } }); owners.set(stage, receipt);
  try { host.addEventListener("blur", blur); } catch { invalidate("unsupported"); return null; }
  return Object.freeze({ receipt, dispose: () => invalidate("stopped"), hide: () => { for (const f of frames) f.hide(); } });
}
