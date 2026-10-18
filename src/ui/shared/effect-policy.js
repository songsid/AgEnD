/** #1629 r3: pure host policy. No frame creation, DOM reads, content reads or network. */
import { effectTrialStageIdentity } from "./effect-trial-stage.js";
const OWN = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const plain = o => !!o && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
const finite = v => typeof v === "number" && Number.isFinite(v);
const instanceName = v => typeof v === "string" && v.length >= 1 && v.length <= 128;
const TYPES = Object.freeze({ state: ["state"], reply: [], mention: [], theme: ["mode"], env: ["width", "height", "dpr", "quality"], pointer: ["kind", "x", "y", "buttons"] });
/** Reserved for host-drawn widgets, never exposed to a Canvas Worker. */
export const WIDGET_SIGNAL_KINDS = Object.freeze(["status", "usage", "fleet"]);

/** Build a fresh content-free signal. Unknown fields are never copied or read. */
export function effectEvent(type, fields, instance, ts) {
  if (!OWN(TYPES, type) || !plain(fields) || !finite(ts) || ts < 0 || instance !== null && !instanceName(instance)) return null;
  const out = { v: 1, type, ts };
  if (["state", "reply", "mention"].includes(type)) {
    if (OWN(fields, "instance") && fields.instance !== instance) return null;
    if (instance !== null) out.instance = instance;
  }
  for (const key of TYPES[type]) out[key] = fields[key];
  if (type === "pointer") for (const key of ["dx", "dy"]) if (OWN(fields, key)) out[key] = fields[key];
  return validEffectEvent(out, instance) ? out : null;
}

/** Independent send fence: exact keys, enums, numeric bounds and the current region's own instance. */
export function validEffectEvent(d, instance) {
  if (instance !== null && !instanceName(instance)) return false;
  if (!plain(d) || d.v !== 1 || !OWN(TYPES, d.type) || !finite(d.ts) || d.ts < 0) return false;
  const keys = ["v", "type", "ts", ...TYPES[d.type]];
  if (["state", "reply", "mention"].includes(d.type) && OWN(d, "instance")) {
    if (!instanceName(instance) || d.instance !== instance) return false;
    keys.push("instance");
  }
  if (d.type === "pointer") for (const key of ["dx", "dy"]) if (OWN(d, key)) {
    if (!finite(d[key]) || Math.abs(d[key]) > 10000) return false;
    keys.push(key);
  }
  if (Object.keys(d).sort().join(",") !== keys.sort().join(",")) return false;
  switch (d.type) {
    case "state": return ["idle", "working", "needs_you", "stopped"].includes(d.state);
    case "reply": case "mention": return true;
    case "theme": return ["light", "dark"].includes(d.mode);
    case "env": return Number.isInteger(d.width) && d.width >= 1 && d.width <= 4096 && Number.isInteger(d.height) && d.height >= 1 && d.height <= 4096 && d.width * d.height <= 8388608 && finite(d.dpr) && d.dpr >= 0.5 && d.dpr <= 3 && ["normal", "low"].includes(d.quality);
    case "pointer": return ["move", "down", "up", "click", "wheel"].includes(d.kind) && finite(d.x) && d.x >= 0 && d.x <= 4096 && finite(d.y) && d.y >= 0 && d.y <= 4096 && Number.isInteger(d.buttons) && d.buttons >= 0 && d.buttons <= 31;
  }
  return false;
}

/** Least privilege at the final send; the instance is the host's binding, never taken from event data. */
export function maySendEffectEvent(event, binding) {
  if (!plain(binding) || !validEffectEvent(event, binding.instance) || !Array.isArray(binding.wants) || event.type === "mention") return false;
  if (["state", "reply", "mention"].includes(event.type)) {
    if (binding.instance === null ? OWN(event, "instance") : !OWN(event, "instance") || event.instance !== binding.instance) return false;
  }
  return event.type === "env" || binding.wants.includes(event.type);
}

export function constrainedDevice(signals) {
  return !!signals && (finite(signals.memory) && signals.memory > 0 && signals.memory <= 4 || finite(signals.cores) && signals.cores > 0 && signals.cores <= 4 || signals.coarse === true && finite(signals.width) && signals.width > 0 && signals.width <= 900);
}

export const EFFECT_BLOCK_REASONS = Object.freeze([
  "preview_unavailable", "preview_not_consented", "unsupported_host", "safe_mode", "reduced_motion", "save_data", "hidden", "disabled", "public_link",
  "baseline_unsupported", "baseline_unavailable", "baseline_timeout", "calibrating", "clock_unavailable", "gates_unknown", "owner_css", "stock_overlay", "modal",
  "safety_off", "safety_unknown", "interrupted", "paused", "host_budget", "frame_limit", "front_limit", "offscreen", "region_unavailable", "resource_unavailable", "resource_timeout", "runtime_unavailable", "unknown",
]);

/** Diagnostic names only; the admission policy below still validates every required flag. */
export function effectPlaybackReason(c) {
  if (!c || ["safe", "publicLink", "reducedMotion", "saveData", "hidden", "enabled", "show", "previewReady", "optIn"].some(k => typeof c[k] !== "boolean")) return "gates_unknown";
  return c.safe ? "safe_mode" : c.publicLink ? "public_link" : c.reducedMotion ? "reduced_motion" : c.saveData ? "save_data"
    : c.hidden ? "hidden" : !c.enabled ? "unsupported_host" : !c.show ? "disabled" : !c.previewReady ? "preview_unavailable" : !c.optIn ? "preview_not_consented" : null;
}

const OWNER_ORDER = Object.freeze({ page: 0, header: 1, sidebar: 2, box: 3 });
/** Recomputed from host descriptors; queued/off/unknown descriptors never get a frame reservation. */
export function allocateEffectFrames(descriptors, context) {
  if (!Array.isArray(descriptors) || descriptors.length > 128 || !plain(context)) return [];
  const keys = new Set(), duplicate = new Set();
  for (const d of descriptors) if (d && typeof d.key === "string") { if (keys.has(d.key)) duplicate.add(d.key); keys.add(d.key); }
  const result = descriptors.map(d => ({ key: d?.key, verdict: "off", reason: "unknown", queuePos: null }));
  const gates = ["safe", "publicLink", "reducedMotion", "saveData", "hidden", "enabled", "show", "previewReady", "optIn", "constrained", "modal"];
  if (gates.some(k => typeof context[k] !== "boolean") || context.openInstance !== null && !instanceName(context.openInstance)) return result;
  let global = null;
  if (context.safe === true) global = "safe_mode";
  else if (context.publicLink === true) global = "public_link";
  else if (context.reducedMotion === true) global = "reduced_motion";
  else if (context.saveData === true) global = "save_data";
  else if (context.hidden === true) global = "hidden";
  else if (context.enabled !== true) global = "unsupported_host";
  else if (context.show !== true) global = "disabled";

  const candidates = [];
  for (let i = 0; i < descriptors.length; i++) {
    const d = descriptors[i], r = result[i];
    if (!plain(d) || typeof d.key !== "string" || d.key.length < 1 || d.key.length > 256 || duplicate.has(d.key) || !/^[0-9a-f]{32}$/.test(d.id) || !["chat", "page", "header", "sidebar", "box"].includes(d.region) || !["front", "behind"].includes(d.layer) || !Number.isSafeInteger(d.order) || d.order < 0 || typeof d.paused !== "boolean") continue;
    // Missing/unknown provenance always receives the agent restrictions.
    const trialIdentity = d.trialStage === undefined || d.trialStage === null ? null : effectTrialStageIdentity(d.trialStage);
    const trial = !!trialIdentity && d.region === "chat" && trialIdentity.key === d.key && trialIdentity.id === d.id && trialIdentity.instance === d.instance && trialIdentity.generation === d.generation;
    if (d.trialStage != null && !trial) { r.reason = "trial_unknown"; continue; }
    const owner = !trial && d.by === "human";
    if (!owner && d.region !== "chat") { r.reason = "scope"; continue; }
    if (d.region === "chat" && (!instanceName(d.instance) || d.instance !== context.openInstance)) { r.reason = "closed_chat"; continue; }
    if (global) { r.reason = global; continue; }
    if (trial ? context.trialReady !== true : context.previewReady !== true) { r.reason = "preview_unavailable"; continue; }
    if (!trial && context.optIn !== true) { r.reason = "preview_not_consented"; continue; }
    if (d.paused === true) { r.reason = "paused"; continue; }
    if (d.visible !== true) { r.reason = "offscreen"; continue; }
    if (d.layer === "front" && context.modal === true && !trial) { r.reason = "modal"; continue; }
    candidates.push({ i, d, priority: owner && OWN(OWNER_ORDER, d.region) ? OWNER_ORDER[d.region] : 4 });
  }
  candidates.sort((a, b) => a.priority - b.priority || a.d.order - b.d.order || a.i - b.i);
  const max = context.constrained === true ? 1 : 3, frontMax = context.constrained === true ? 1 : 2;
  let active = 0, front = 0, queued = 0;
  for (const { i, d } of candidates) {
    const r = result[i];
    if (active >= max || d.layer === "front" && front >= frontMax) {
      r.verdict = "queued"; r.reason = active >= max ? "frame_limit" : "front_limit"; r.queuePos = ++queued;
    } else {
      r.verdict = "active"; r.reason = null; active++; if (d.layer === "front") front++;
    }
  }
  return result;
}

const finiteRect = r => plain(r) && ["x", "y", "width", "height"].every(k => finite(r[k]) && Math.abs(r[k]) <= 1e7) && r.width >= 0 && r.height >= 0;
/**
 * Integer padded holes are unioned before evenodd: overlapping holes must never repaint trusted pixels.
 * Input is the host's viewport rects, not mod geometry. Unknown/overflow means hide, never an unclipped fallback.
 */
export function effectTrustClip(frame, trusted) {
  const unknown = { ok: false, reason: "trust_geometry_unknown" };
  if (!finiteRect(frame) || frame.width < 1 || frame.height < 1 || frame.width > 4096 || frame.height > 4096 || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || !Array.isArray(trusted) || trusted.length > 128) return unknown;
  const rects = [];
  for (const r of trusted) {
    if (!finiteRect(r)) return unknown;
    const x1 = Math.max(0, Math.floor(r.x - frame.x - 8)), y1 = Math.max(0, Math.floor(r.y - frame.y - 8));
    const x2 = Math.min(frame.width, Math.ceil(r.x + r.width - frame.x + 8)), y2 = Math.min(frame.height, Math.ceil(r.y + r.height - frame.y + 8));
    if (x2 > x1 && y2 > y1) rects.push({ x1, y1, x2, y2 });
  }
  const ys = [...new Set(rects.flatMap(r => [r.y1, r.y2]))].sort((a, b) => a - b), holes = [];
  for (let i = 0; i + 1 < ys.length; i++) {
    const y1 = ys[i], y2 = ys[i + 1], spans = rects.filter(r => r.y1 <= y1 && r.y2 >= y2).map(r => [r.x1, r.x2]).sort((a, b) => a[0] - b[0]);
    let span = null;
    for (const next of spans) {
      if (span && next[0] <= span[1]) span[1] = Math.max(span[1], next[1]);
      else { if (span) holes.push({ x: span[0], y: y1, width: span[1] - span[0], height: y2 - y1 }); span = [...next]; }
    }
    if (span) holes.push({ x: span[0], y: y1, width: span[1] - span[0], height: y2 - y1 });
    if (holes.length > 512) return { ok: false, reason: "trust_geometry_limit" };
  }
  const rectPath = r => `M${r.x} ${r.y}H${r.x + r.width}V${r.y + r.height}H${r.x}Z`;
  return { ok: true, holes, path: `path(evenodd, "${rectPath({ x: 0, y: 0, width: frame.width, height: frame.height })}${holes.map(rectPath).join("")}")` };
}
