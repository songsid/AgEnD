/** #1629: one private Trial contribution. No frame, pool, Start/Stop HTTP or durable profile writes. */
import { checkEffectTrialStart } from "./effect-runtime-loader.js";
import { effectTrialStageIdentity, effectTrialStage, watchEffectTrialStage, disposeEffectTrialStage, constrainEffectTrialStage } from "./effect-trial-stage.js";
const safe = fn => { try { return fn(); } catch { return null; } };
const plain = x => !!x && [Object.prototype, null].includes(Object.getPrototypeOf(x));
function fields(value, required, optional = []) {
  try {
    if (!plain(value)) return null;
    const keys = Reflect.ownKeys(value), out = Object.create(null);
    if (keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k)) || required.some(k => !keys.includes(k))) return null;
    for (const k of keys) { const d = Object.getOwnPropertyDescriptor(value, k); if (!d || !("value" in d) || !d.enumerable) return null; out[k] = d.value; }
    return out;
  } catch { return null; }
}
const canonical = x => JSON.stringify(x, function(_key, value) {
  return value && !Array.isArray(value) && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value;
});
export function createEffectTrialSource({ window: host, current, ownerCurrent, stock, readResource, onChange = () => {} }) {
  let dead = false, active = null, previous = null, clockBroken = false, clockBusy = false;
  const used = new WeakSet();
  function now() {
    if (clockBroken || clockBusy) { clockBroken = true; return null; }
    clockBusy = true; let value; try { value = host.performance.now(); } catch { value = null; } finally { clockBusy = false; }
    if (clockBroken || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || previous !== null && value < previous) { clockBroken = true; return null; }
    previous = value; return value;
  }
  function stop(lease, reason = "stopped") {
    if (!lease || lease.dead) return false;
    lease.dead = true; if (active === lease) active = null;
    safe(() => host.clearTimeout(lease.timer)); safe(() => lease.off?.()); lease.off = null;
    for (const controller of lease.pending) safe(() => controller.abort());
    safe(() => disposeEffectTrialStage(lease.stage.receipt)); // Remove physical paint before callbacks can replace this contribution.
    safe(onChange); safe(() => lease.onStop(reason)); return true;
  }
  function valid(lease) {
    if (dead || !lease || active !== lease || lease.dead || lease.checking) return false;
    lease.checking = true; let yes = false;
    try {
      const time = now();
      yes = time !== null && time >= lease.startedAt && time < lease.until && current() === true && ownerCurrent(lease.owner, lease.identity.instance) === true && lease.current() === true;
      const accepted = now(); yes = yes && accepted !== null && accepted >= lease.startedAt && accepted < lease.until;
    } catch { /* unknown is not a lease */ } finally { lease.checking = false; }
    return !dead && active === lease && !lease.dead && yes;
  }
  const checked = lease => { if (valid(lease)) return true; stop(lease, "trial_ended"); return false; };
  function arm(lease) {
    if (!checked(lease)) return;
    const time = now(); if (time === null || time >= lease.until) { stop(lease, "trial_expired"); return; }
    lease.timer = host.setTimeout(() => { if (active === lease && !lease.dead) arm(lease); }, Math.max(1, Math.ceil(lease.until - time)));
  }
  function attach(input, owner) {
    if (dead || clockBroken) return null;
    const x = fields(input, ["reply", "offer", "startedAt", "stage", "current", "onStop"]), stage = x && fields(x.stage, ["receipt", "dispose", "hide"]);
    const identity = stage && effectTrialStageIdentity(stage.receipt), reply = identity && checkEffectTrialStart(x.reply, x.offer, identity.id);
    const time = now(), until = reply && typeof x.startedAt === "number" ? x.startedAt + reply.remainingMs : null;
    if (dead || !x || !stage || !identity || !reply || used.has(stage.receipt) || typeof stage.dispose !== "function" || typeof stage.hide !== "function"
      || typeof x.current !== "function" || typeof x.onStop !== "function" || typeof x.startedAt !== "number" || !Number.isFinite(x.startedAt) || x.startedAt < 0
      || time === null || x.startedAt > time || typeof until !== "number" || !Number.isFinite(until) || until > Number.MAX_SAFE_INTEGER || time >= until) return null;
    const candidate = active;
    if (safe(() => current() === true && ownerCurrent(owner, identity.instance) === true && x.current() === true) !== true || active !== candidate || dead) return null;
    stop(candidate, "replaced");
    // A stop callback may have installed a newer contribution. Never replace it from this older operation.
    if (dead || active !== null) return null;
    const lease = { identity, reply, stage, owner, current: x.current, onStop: x.onStop, startedAt: x.startedAt, until, dead: false, checking: false, pending: new Set(), timer: null, off: null, binding: null };
    lease.binding = Object.freeze({ kind: "trial", key: identity.key, id: identity.id, source: lease, generation: identity.generation });
    active = lease; used.add(stage.receipt);
    lease.off = watchEffectTrialStage(stage.receipt, () => stop(lease, "stage_ended"));
    if (typeof lease.off !== "function" || constrainEffectTrialStage(stage.receipt, () => checked(lease)) !== true || !checked(lease)) { stop(lease, "stage_unavailable"); return null; }
    try { arm(lease); } catch { stop(lease, "trial_unavailable"); return null; }
    if (!checked(lease)) return null;
    safe(onChange);
    return checked(lease) ? Object.freeze({ current: () => checked(lease), stop: () => stop(lease), snapshot: () => { if (!checked(lease)) return null; const t = now(); return t !== null && t < lease.until && active === lease ? { id: identity.id, key: identity.key, trial: reply.trial, remainingMs: lease.until - t } : null; } }) : null;
  }
  function descriptor() {
    const lease = active; if (!lease || !checked(lease)) return [];
    const proof = safe(stock), local = safe(() => effectTrialStage(lease.stage.receipt, lease.identity, proof));
    if (!checked(lease)) return [];
    if (!local?.root || local.root.isConnected !== true) { stop(lease, "stage_unavailable"); return []; }
    return [{ key: lease.identity.key, id: lease.identity.id, by: "agent", region: "chat", layer: lease.reply.manifest.layer, order: 0, paused: false, visible: true,
      instance: lease.identity.instance, generation: lease.identity.generation, trialStage: lease.stage.receipt, params: lease.reply.params, element: local.root }];
  }
  function binding(key, id) { const lease = active; return lease && lease.binding.key === key && lease.binding.id === id && checked(lease) ? lease.binding : null; }
  function bindingCurrent(b) { return !!b && active?.binding === b && checked(b.source); }
  async function load(b, signal) {
    if (!bindingCurrent(b) || signal?.aborted) return null;
    const lease = b.source; if (lease.pending.size) return null;
    const controller = new host.AbortController(), abort = () => controller.abort(); lease.pending.add(controller);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (!bindingCurrent(b) || signal?.aborted) { abort(); return null; }
      const value = await readResource({ trial: lease.reply.trial, id: b.id, instance: lease.identity.instance }, controller.signal);
      if (!bindingCurrent(b) || signal?.aborted || controller.signal.aborted) return null;
      if (!value || value.id !== b.id || canonical(value.manifest) !== canonical(lease.reply.manifest) || canonical(value.params) !== canonical(lease.reply.params)) { stop(lease, "resource_unavailable"); return null; }
      return bindingCurrent(b) && !signal?.aborted && !controller.signal.aborted ? value : null;
    } catch { if (active === lease) stop(lease, "resource_unavailable"); return null; }
    finally { signal?.removeEventListener("abort", abort); lease.pending.delete(controller); }
  }
  return Object.freeze({ attach, descriptors: descriptor, binding, current: bindingCurrent, load,
    stopFor(owner) { const lease = active; return lease?.owner === owner ? stop(lease, "chat_ended") : false; },
    stop() { return stop(active); },
    dispose() { if (dead) return; dead = true; stop(active, "disposed"); },
  });
}
