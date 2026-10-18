/** #1629 B2: one host-owned Canvas Worker pool. Product adapters are deliberately separate. */
import { allocateEffectFrames, effectEvent, effectPlaybackReason } from "./effect-policy.js";
import { createOpaqueEffectFrame } from "./effect-frame.js";
import { createEffectGeometry, hostEffectRect } from "./effect-geometry.js";
import { effectStockSnapshot, effectStockAllows } from "./effect-stock-snapshot.js";
import { effectTrialStage, effectTrialStageIdentity, watchEffectTrialStage } from "./effect-trial-stage.js";
import { EffectBudget } from "./effect-profiler.js";

const registries = new WeakMap();
const plain = o => !!o && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
const finite = v => typeof v === "number" && Number.isFinite(v);
const FLAGS = ["safe", "publicLink", "reducedMotion", "hidden", "enabled", "show", "transportReady", "constrained", "modal"];
const TYPES = ["state", "reply", "theme"];
function unsafeSnapshotDescriptor(d) {
  if (!plain(d) || !plain(d.params ?? {})) return null;
  const params = Object.create(null), keys = Object.keys(d.params ?? {}).sort();
  if (keys.length > 16) return null;
  for (const k of keys) {
    const v = d.params[k];
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(k) || !(typeof v === "boolean" || finite(v) || typeof v === "string" && v.length <= 128)) return null;
    params[k] = v;
  }
  const trialIdentity = d.trialStage == null ? null : effectTrialStageIdentity(d.trialStage);
  if (d.trialStage != null && (!trialIdentity || d.region !== "chat" || trialIdentity.key !== d.key || trialIdentity.id !== d.id || trialIdentity.instance !== d.instance || trialIdentity.generation !== d.generation)) return null;
  const out = { trialStage: d.trialStage ?? null, generation: trialIdentity?.generation ?? null, key: d.key, id: d.id, region: d.region, layer: d.layer, by: !trialIdentity && d.by === "human" ? "human" : "agent", order: d.order,
    paused: d.paused, visible: d.visible, instance: d.region === "chat" ? d.instance : null, params, element: d.element };
  const identity = [out.id, out.region, out.layer, out.by, out.instance, params];
  if (trialIdentity) identity.push([trialIdentity.serial, trialIdentity.generation]);
  out.identity = JSON.stringify(identity);
  return out;
}

function snapshotDescriptor(d) { try { return unsafeSnapshotDescriptor(d); } catch { return null; } }

/**
 * `load` is an authenticated, bounded host loader, never a Worker callback. It returns {id,code,params,assets,wants}.
 * Safety is mandatory and synchronous: allowed(id,device), begin({key,id,device}), finish(token,reason), pause(record), resume(id,device). Pause persists a soft latch and history; human resume never clears sticky off.
 * stockSnapshot({frameRoot}) supplies current closed stock paint evidence synchronously; it must not reenter a mutation API.
 * Unknown receipts, roots, trust coverage or gates mount nothing. No storage, network, content or product imports here.
 */
export function createEffectRegistry({ window: host, origin, boot, load, safety, stockSnapshot, onChange = () => {}, onProfile = () => {}, onMount = () => {}, onRetire = () => {}, clock = () => host.performance.now() } = {}) {
  try { if (!host?.document || !host.document.body || registries.has(host) || typeof load !== "function" || typeof stockSnapshot !== "function" || typeof onChange !== "function" || typeof onProfile !== "function" || typeof onMount !== "function" || typeof onRetire !== "function" || typeof clock !== "function" || !safety || ["allowed", "begin", "finish", "pause", "resume"].some(k => typeof safety[k] !== "function") || ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "MutationObserver", "ResizeObserver", "AbortController"].some(k => typeof host[k] !== "function")) return { ok: false, reason: "registry_unsupported" }; } catch { return { ok: false, reason: "registry_unsupported" }; }
  let dead = false, blocked = null, revision = 0, last = null, lastView = null, frameSerial = 0, context = null, descriptors = [], raf = null, timer = null;
  const slots = new Map(), loads = new Set(), paused = new Map(), offs = [], observed = new Set(), failures = new Map(), results = new Map();
  let readingStock = false;
  let root, geometry, observer, resize, longTasks = null, longTasksSupported = false;
  const time = () => {
    let n; try { n = clock(); } catch { return null; }
    if (!finite(n) || n < 0 || last !== null && n < last) return null;
    last = n; return n;
  };
  const nativeClock = () => { const n = time(); if (n === null) throw Error("clock unavailable"); return n; };
  const device = () => context?.constrained === true ? "constrained" : "standard";
  const dpr = device => Math.min(device === "constrained" ? 1.5 : 3, Math.max(0.5, host.devicePixelRatio || 1));
  // The provider is synchronous and observational. Reentrant mutation revokes this pool, rather than
  // allowing an old admission to act on newer descriptors or scheduling unbounded callback retries.
  const readingStages = new Set();
  // A local receipt may synchronously invalidate and notify its owner. Fence its result by revision;
  // recursion on the same receipt is unknown, while an independently issued replacement may proceed.
  const localStage = (d, proof) => {
    if (!d?.trialStage || dead || blocked || readingStages.has(d.trialStage)) return null;
    const before = revision; let stage = null; readingStages.add(d.trialStage);
    try { stage = effectTrialStage(d.trialStage, d, proof); } catch { /* unknown is never permission */ }
    finally { readingStages.delete(d.trialStage); }
    return !dead && !blocked && revision === before && stage?.root === d.element ? stage : null;
  };
  const permits = (d, proof) => eligible(d) && (d.trialStage ? !!localStage(d, proof) : effectStockAllows(proof, d));
  const coverage = (d = null) => {
    if (dead || blocked || readingStock) return null;
    const before = revision; let proof = null; readingStock = true;
    try { proof = effectStockSnapshot(stockSnapshot(Object.freeze({ frameRoot: root }))); }
    catch { /* unknown is never permission */ }
    finally { readingStock = false; }
    if (dead || blocked || before !== revision) return null;
    return d === null || permits(d, proof) ? proof : null;
  };
  const position = (d, proof) => d.trialStage ? localStage(d, proof)?.rect ?? null : hostEffectRect(d.element);
  const syncGeometry = (s, proof) => {
    const before = revision, rect = position(s.d, proof);
    if (!rect || !current(s) || before !== revision) return null;
    const ok = s.d.trialStage ? s.geometry.sync(proof) : s.geometry.sync(rect, proof);
    return ok && current(s) && before === revision ? rect : null;
  };
  const hideGeometry = () => { geometry?.hide(); for (const s of slots.values()) if (s.d.trialStage) s.geometry?.hide(); };
  function reentrantStock() {
    if (!readingStock) return false;
    if (blocked) return true;
    revision++; blocked = "stock_reentrant"; hideGeometry(); stopAll(blocked); tell(); return true;
  }
  const current = s => !dead && !blocked && slots.get(s.d.key) === s && s.live;
  const tell = () => { if (dead) return; const state = view(), stamp = JSON.stringify(state); if (stamp === lastView) return; lastView = stamp; try { onChange(state); } catch { /* a display callback cannot admit code */ } };
  const receipt = (fn, ...args) => { try { return Reflect.apply(fn, safety, args); } catch { return null; } };
  // #2055: the history's own read names a denial; any other answer stays unknown (and denied).
  const SAFETY_REASON = Object.freeze({ __proto__: null, off: "safety_off", paused: "paused", interrupted: "interrupted" });
  // Display only: the sticky history state per descriptor, which outranks a waiting reason (a queue, a dialog, typing)
  // because it is what Resume must answer. Admission, caps, latches and safety policy never read it.
  const named = new Map();
  // The read can re-enter (an update from a callback): only a pass still current, for the same device, may write.
  const nameSafety = (d, dev = device()) => {
    const proposed = revision;
    const reason = d.trialStage ? null : SAFETY_REASON[receipt(safety.status, d.id, dev)?.state];
    if (dead || proposed !== revision || dev !== device()) return false;
    if (reason) named.set(d.key, { identity: signature(d), reason }); else named.delete(d.key);
    return true;
  };
  // Display only: the closed global gate a row is waiting on, when the host knows it (else the caller's unknown).
  const gateReason = () => effectPlaybackReason(context);
  const clearMarker = (s, why) => {
    if (!s.token) return true;
    const token = s.token; s.token = null;
    if (receipt(safety.finish, token, why) === true) return true;
    blocked = "safety_unknown"; return false;
  };
  function retire(s, why, count = false) {
    if (!s.live) return;
    s.live = false;
    if (slots.get(s.d.key) === s) slots.delete(s.d.key);
    if (s.request) { s.request.controller.abort(); if (s.request.timer !== null) host.clearTimeout(s.request.timer); }
    // A closed/unknown viewer gate revokes paint, not the effect identity. Fresh known gates
    // may admit it again; resource failures and actual safety pauses retain their latches.
    if (!["disposed", "superseded", "hidden", "human_resume", "geometry_changed", "gates_unknown"].includes(why)) failures.set(s.d.key, { identity: signature(s.d), reason: why });
    s.stageOff?.(); s.stageOff = null;
    s.frame?.remove(why); s.geometry?.remove();
    if (s.loadOff) s.loadOff();
    if (count) {
      paused.set(s.d.key, signature(s.d));
      if (receipt(safety.pause, { id: s.d.id, device: s.device, reason: why, metrics: s.budget?.snapshot().metrics ?? null }) !== true) blocked = "safety_unknown";
    }
    if (count || why === "safety_revoked") nameSafety(s.d, s.device);   // #2055: the third pause, or another tab's, says off now
    clearMarker(s, why);
    if (s.owner) { try { onRetire(s.owner, why); } catch { /* an observation cannot prevent physical cleanup */ } }
    if (blocked) for (const other of [...slots.values()]) retire(other, blocked);
  }
  function stopAll(why) {
    const proposed = revision, wasDead = dead;
    for (const s of [...slots.values()]) {
      retire(s, why);
      if (revision !== proposed || dead !== wasDead) return false;
    }
    return true;
  }
  function gatesKnown() { return context && FLAGS.every(k => typeof context[k] === "boolean") && (context.openInstance === null || typeof context.openInstance === "string" && context.openInstance.length >= 1 && context.openInstance.length <= 128); }
  function eligible(d = null) {
    return gatesKnown() && !context.safe && !context.reducedMotion && context.enabled && context.show && context.transportReady
      && (!d || !context.publicLink || d.region === "chat" && !d.trialStage);
  }
  const globalAllowed = (d = null) => eligible(d) && host.document.visibilityState === "visible";
  const signature = d => d.identity;
  // A frame stopped because its gates closed is recorded as gates_unknown; when the host knows which gate, say it.
  const shown = why => (why === "gates_unknown" && !eligible() && gateReason()) || why;
  function view() {
    return descriptors.map(d => {
      const r = results.get(d.key) ?? { verdict: "off", reason: blocked ?? (!eligible() && gateReason()) ?? "unknown", queuePos: null }, s = slots.get(d.key);
      // #2055 one display precedence: a global latch, then the sticky safety history, then this page's own pause/failure.
      const n = named.get(d.key), sticky = n && n.identity === signature(d) ? n.reason : null;
      return { key: d.key, id: d.id, ...r, ...(sticky && r.verdict === "queued" ? { verdict: "off", queuePos: null } : {}), phase: s?.frame ? s.ready ? "running" : "starting" : s ? "loading" : null,
        quality: s?.budget?.snapshot().quality ?? null, reason: blocked ?? sticky ?? ((paused.get(d.key) === signature(d)) ? "paused" : failures.get(d.key)?.identity === signature(d) ? shown(failures.get(d.key).reason) : s && context?.hidden ? "hidden" : r.reason) };
    });
  }
  function schedule() {
    if (dead || blocked || !slots.size) return;
    if (raf === null && host.document.visibilityState === "visible" && context?.hidden === false) raf = host.requestAnimationFrame(tick);
    if (timer === null) {
      const waits = [...slots.values()].filter(s => s.hiddenSince !== null).map(s => Math.max(1, 10000 - (last - s.hiddenSince)));
      timer = host.setTimeout(heartbeat, Math.min(1000, ...waits));
    }
  }
  const invalidate = () => {
    if (dead || reentrantStock()) return;
    hideGeometry(); for (const s of slots.values()) s.pointer = null;
    if (time() === null) { blocked = "clock_unavailable"; stopAll(blocked); tell(); return; }
    reconcile();
  };
  function observe() {
    const nodes = host.document.querySelectorAll("[data-trust]");
    if (nodes.length > 128) throw Error("trust coverage unavailable");
    const wanted = new Set([host.document.documentElement, ...nodes]);
    for (const d of descriptors) if (d.element?.ownerDocument === host.document && d.element.isConnected === true) wanted.add(d.element);
    for (const n of observed) if (!wanted.has(n)) { resize.unobserve(n); observed.delete(n); }
    for (const n of wanted) if (!observed.has(n)) { resize.observe(n); observed.add(n); }

  }
  function reconcile() {
    if (dead || reentrantStock()) return;
    const proposal = revision;
    if (time() === null) blocked = "clock_unavailable";
    const hidden = context?.hidden === true || host.document.visibilityState !== "visible";
    const stock = eligible() ? coverage() : null;
    if (blocked || !eligible() || !stock) {
      if (!stopAll(blocked ?? "gates_unknown")) return;
      results.clear();
      if (!blocked) for (const d of descriptors) if (!nameSafety(d) || dead || proposal !== revision) return;
      tell(); return;
    }
    // Hidden frames already owned may survive for <=10 s, but no new frame or load is admitted while hidden.
    const ctx = { ...context, hidden: false };
    const ds = [];
    for (const d of descriptors) {
      if (dead || proposal !== revision) return;
      const allowed = permits(d, stock);
      if (dead || proposal !== revision) return;
      ds.push({ ...d, paused: !allowed || d.paused === true || paused.get(d.key) === signature(d) || failures.get(d.key)?.identity === signature(d) });
    }
    for (const d of descriptors) if (!nameSafety(d) || dead || proposal !== revision) return;
    const allocation = allocateEffectFrames(ds, ctx); results.clear();
    for (const r of allocation) {
      const d = descriptors.find(d => d.key === r.key);
      if (r.reason === "paused" && d && d.paused !== true && paused.get(d.key) !== signature(d) && failures.get(d.key)?.identity !== signature(d)) {
        const allowed = permits(d, stock);
        if (dead || proposal !== revision) return;
        if (!allowed) r.reason = d.trialStage ? "trial_ended" : stock.front ? "owner_css" : "stock_overlay";
      }
      results.set(r.key, r);
    }
    if (dead || proposal !== revision) return;
    const chosen = new Set(allocation.filter(r => r.verdict === "active").map(r => r.key));
    for (const s of [...slots.values()]) {
      const d = descriptors.find(x => x.key === s.d.key);
      if (!chosen.has(s.d.key) || !d || signature(d) !== signature(s.d) || d.element !== s.d.element || s.device !== device()) retire(s, "superseded");
      if (dead || proposal !== revision) return;
    }
    if (chosen.size === 0) { tell(); return; }
    if (hidden) {
      hideGeometry();
      for (const s of [...slots.values()]) {
        if (!s.frame) retire(s, "hidden");
        else { if (s.hiddenSince === null) { s.hiddenSince = last; s.healthySince = null; } if (s.budget.gates({ hidden: true, reducedMotion: false, saveData: false, show: true }).remove) retire(s, "hidden"); }
        if (dead || proposal !== revision) return;
      }
      schedule(); tell(); return;
    }
    if (!globalAllowed()) { stopAll("gates_unknown"); tell(); return; }
    for (const s of [...slots.values()]) {
      if (s.frame && s.hiddenSince !== null) { s.hiddenSince = null; s.healthySince = last; if (s.budget.gates({ hidden: false, reducedMotion: false, saveData: false, show: true }).remove) retire(s, "hidden"); }
      if (dead || proposal !== revision) return;
    }
    try { observe(); } catch { stopAll("trust_geometry_unknown"); tell(); return; }
    const max = context.constrained ? 1 : 3;
    for (const d of descriptors) {
      if (!chosen.has(d.key) || slots.has(d.key)) continue;
      if (slots.size >= max || loads.size >= max) break;
      const permitted = receipt(safety.allowed, d.id, device());
      if (proposal !== revision) return;
      if (permitted !== true) {
        // #2055: say which denial it is. Only the safety history's own read names it; anything else stays unknown (still denied).
        const st = receipt(safety.status, d.id, device());
        if (proposal !== revision) return;
        const why = SAFETY_REASON[st?.state] ?? "safety_unknown";
        results.set(d.key, { verdict: "off", reason: why, queuePos: null }); continue;
      }
      if (slots.has(d.key) || slots.size >= max || loads.size >= max || !globalAllowed(d) || context.hidden || !coverage(d) || proposal !== revision || !descriptors.some(x => x.key === d.key && signature(x) === signature(d) && x.element === d.element)) break;
      const rect = position(d, coverage(d));
      if (dead || proposal !== revision) return;
      if (!rect || d.element.ownerDocument !== host.document) { results.set(d.key, { verdict: "off", reason: "geometry_unknown", queuePos: null }); continue; }
      const s = { d, device: device(), owner: null, live: true, stageOff: null, ready: false, readyAt: null, frame: null, geometry: null, budget: null, token: null, request: null, loadOff: null, rect: null, pointer: null, lastPointer: null, hiddenSince: null, healthySince: null };
      slots.set(d.key, s);
      if (d.trialStage) {
        s.stageOff = watchEffectTrialStage(d.trialStage, () => {
          if (!current(s)) return;
          const before = revision; retire(s, "trial_ended");
          if (!dead && before === revision) { reconcile(); tell(); }
        });
        if (!s.stageOff || !current(s)) { retire(s, "trial_ended"); continue; }
      }
      const request = { controller: new host.AbortController(), slot: s, timer: null, began: time() }; s.request = request; loads.add(request);
      const withinDeadline = () => {
        const n = time();
        if (n === null || request.began === null || n - request.began >= 10000) { retire(s, n === null || request.began === null ? "clock_unavailable" : "resource_timeout"); return false; }
        return true;
      };
      const acceptCompletion = () => {
        if (!current(s)) { clearMarker(s, "superseded"); return false; }
        if (!withinDeadline()) return false;
        if (request.controller.signal.aborted || !globalAllowed(d) || context.hidden || !coverage(d)) {
          if (current(s)) retire(s, "admission_revoked"); else clearMarker(s, "superseded");
          return false;
        }
        return withinDeadline();
      };
      const deadline = () => {
        if (!current(s)) return;
        const n = time();
        if (n === null || n - request.began >= 10000) { retire(s, n === null ? "clock_unavailable" : "resource_timeout"); tell(); return; }
        request.timer = host.setTimeout(deadline, Math.max(1, 10000 - (n - request.began)));
      };
      request.timer = host.setTimeout(deadline, 10000);
      // Keep a physical read reservation until its promise settles, including after abort/revocation.
      Promise.resolve().then(() => {
        if (!current(s) || request.controller.signal.aborted) return null;
        return load({ key: d.key, id: d.id, params: { ...d.params } }, request.controller.signal);
      }).then(resource => {
        if (!acceptCompletion()) return;
        if (!plain(resource) || resource.id !== d.id || !plain(resource.params) || Object.keys(d.params).some(k => resource.params[k] !== d.params[k])) { retire(s, "resource_unknown"); return; }
        let fresh = position(d, coverage(d));
        if (!fresh || receipt(safety.allowed, d.id, s.device) !== true) { retire(s, "safety_unknown"); return; }
        if (!acceptCompletion()) return;
        const token = receipt(safety.begin, { key: d.key, id: d.id, device: s.device });
        if (typeof token !== "string" || token.length < 1 || token.length > 128) { retire(s, "safety_unknown"); return; }
        s.token = token;
        if (!acceptCompletion()) return;
        // Obtain local geometry BEFORE the factory appends its temporarily unknown iframe. bind() is
        // the very next local-stage operation and registers that frame before checking its topology.
        const local = d.trialStage ? localStage(d, coverage(d)) : null;
        if (d.trialStage && !local || !current(s)) { if (current(s)) retire(s, "admission_revoked"); return; }
        if (local) fresh = local.rect;
        s.rect = fresh;
        s.budget = new EffectBudget({ device: s.device, clock: nativeClock, longTasksSupported });
        const frame = createOpaqueEffectFrame({ window: host, root: local?.root ?? root, origin, boot, clock: nativeClock,
          render: { code: resource.code, params: resource.params, assets: resource.assets, wants: resource.wants, instance: d.instance, width: fresh.width, height: fresh.height, dpr: dpr(s.device) },
          onReady() { if (!current(s)) return; if (!globalAllowed(d) || context.hidden || !coverage(d)) { retire(s, "hidden"); tell(); return; } const n = time(); if (n === null) { blocked = "clock_unavailable"; stopAll(blocked); tell(); return; } s.ready = true; s.readyAt = n; s.healthySince = n; publishEnv(s); schedule(); tell(); },
          onRemove(why) { if (current(s)) { retire(s, why); tell(); } },
        });
        s.frame = frame;
        if (!current(s) || !frame.ok || frame.state().removed) { frame.remove?.("stale_mount"); retire(s, "mount_failed"); return; }
        frame.element.id = `agend-effect-${boot}-${++frameSerial}`;
        s.geometry = local ? local.bind(frame.element, { layer: d.layer }, coverage()) : geometry.bind(frame.element, { layer: d.layer, by: d.by });
        if (!s.geometry.ok) { retire(s, "geometry_unknown"); return; }
        const loaded = () => { if (current(s)) s.budget.loaded(); };
        frame.element.addEventListener("load", loaded); s.loadOff = () => frame.element.removeEventListener("load", loaded);
        const paint = coverage(d);
        if (!current(s) || !paint || !syncGeometry(s, paint)) { retire(s, "geometry_unknown"); return; }
        // One non-serializable host receipt per actual admitted frame. Never append it to a Worker event.
        const owner = Object.freeze({ key: d.key, id: d.id, device: s.device, current: () => current(s) && s.owner === owner });
        s.owner = owner;
        try { onMount(owner); } catch { /* diagnostics/display failure cannot authorize or mutate a mount */ }
        schedule();
      }).catch(() => { if (current(s)) retire(s, "resource_unavailable"); }).finally(() => {
        if (request.timer !== null) host.clearTimeout(request.timer);
        loads.delete(request); if (s.request === request) s.request = null;
        if (!dead) reconcile(); else if (loads.size === 0 && registries.get(host) === api) registries.delete(host);
      });
    }
    schedule(); tell();
  }
  function publishEnv(s, proof = coverage(s.d)) {
    if (!s.ready || !current(s) || context.hidden || !globalAllowed(s.d) || !permits(s.d, proof)) return;
    const e = effectEvent("env", { width: s.rect.width, height: s.rect.height, dpr: dpr(s.device), quality: s.budget.snapshot().quality }, null, time());
    if (e) s.frame.send(e);
  }
  function tick() {
    raf = null;
    if (dead) return;
    const paint = coverage();
    if (!globalAllowed() || context.hidden || !paint) { invalidate(); return; }
    const proposal = revision; let policyChanged = false;
    for (const s of [...slots.values()]) {
      if (dead || proposal !== revision) return;
      if (!s.frame) continue;
      if (!permits(s.d, paint)) { retire(s, "superseded"); policyChanged = true; continue; }
      if (dead || proposal !== revision) return;
      const rect = syncGeometry(s, paint);
      if (!current(s)) continue;
      if (!rect) { retire(s, "geometry_unknown"); continue; }
      // The host owns the CSS viewport. A bounded env signal lets Worker code redraw its own bitmap if desired.
      const changed = rect.width !== s.rect.width || rect.height !== s.rect.height; s.rect = rect;
      if (changed) publishEnv(s, paint);
      if (s.ready) s.budget.frame();
      if (s.pointer) {
        const packet = s.pointer;
        const n = time(), b = s.budget.snapshot();
        if (n === null || n - packet.at > 100 || !permits(s.d, paint) || !pointerGate(paint) || !current(s) || !b.forward) {
          if (s.pointer === packet) s.pointer = null;
        } else if (s.lastPointer === null || n - s.lastPointer >= 1000 / b.pointerHz) {
          if (s.pointer === packet) s.pointer = null;
          const event = effectEvent("pointer", packet.fields, s.d.instance, packet.at);
          if (event && s.frame.send(event)) s.lastPointer = n;
        }
        // Keep the latest fresh sample until the next eligible frame. An early rAF must
        // not consume a click just because the preceding move used this rate interval.
      }
    }
    if (dead || proposal !== revision) return;
    if (policyChanged) reconcile(); else schedule();
  }
  function heartbeat() {
    timer = null;
    if (dead) return;
    if (time() === null) { blocked = "clock_unavailable"; stopAll(blocked); tell(); return; }
    const proposal = revision, activeBeforeSafety = slots.size;
    if (!checkSafety()) { tell(); return; }
    if (slots.size !== activeBeforeSafety) reconcile();
    if (dead || proposal !== revision) return;
    if (!globalAllowed() || context.hidden || !coverage()) { invalidate(); return; }
    const budgetPauses = new Set();
    for (const s of [...slots.values()]) {
      if (dead || proposal !== revision) return;
      if (!current(s) || !s.frame || !s.ready) continue;
      if (s.d.trialStage && !coverage(s.d)) { if (dead || proposal !== revision) return; if (current(s)) retire(s, "trial_ended"); continue; }
      if (dead || proposal !== revision) return;
      const r = s.budget.gates({ hidden: false, reducedMotion: context.reducedMotion, saveData: context.saveData, show: context.show });
      const state = r.remove ? r : s.readyAt !== null && last - s.readyAt >= 3000 ? s.budget.poll() : r;
      try { onProfile({ key: s.d.key, id: s.d.id, device: s.device, ...state }, s.owner); } catch { /* metrics never authorize a mount */ }
      if (dead || proposal !== revision) return;
      if (!current(s)) continue;
      if (s.d.trialStage && !coverage(s.d)) { if (dead || proposal !== revision) return; if (current(s)) retire(s, "trial_ended"); continue; }
      if (dead || proposal !== revision) return;
      if (state.remove) { const key = s.d.id + ":" + s.device; const count = state.reason === "host_budget" && !budgetPauses.has(key); if (count) budgetPauses.add(key); retire(s, state.reason, count); continue; }
      if (state.badWindows > 0) s.healthySince = null; else if (s.healthySince === null) s.healthySince = last;
      if (s.token && s.healthySince !== null && last - s.healthySince >= 5000 && state.badWindows === 0 && state.metrics !== null && !clearMarker(s, "healthy")) { stopAll("safety_unknown"); break; }
      publishEnv(s);
    }
    if (dead || proposal !== revision) return;
    schedule(); tell();
  }
  function checkSafety() {
    if (dead || blocked) return false;
    const proposed = revision;
    for (const s of [...slots.values()]) {
      if (!current(s)) continue;
      const allowed = receipt(safety.allowed, s.d.id, s.device);
      if (dead || proposed !== revision) return false;
      if (current(s) && allowed !== true) retire(s, "safety_revoked");
      if (dead || blocked || proposed !== revision) return false;
    }
    return !dead && !blocked;
  }
  function revalidateSafety() {
    if (dead || reentrantStock()) return view();
    if (checkSafety()) reconcile(); else tell();
    return view();
  }
  function pointerGate(proof = coverage()) {
    if (!globalAllowed() || context.hidden || context.modal || !proof || proof.front !== true) return false;
    try {
      const focused = host.document.activeElement;
      // Native clicks on ordinary stock content focus its tabindex=-1 main ancestor.
      // Recognize only that unique host root; unknown/editor focus remains a refusal.
      const mains = focused?.tagName === "MAIN" ? host.document.querySelectorAll("#app > .shell > main#main.main[tabindex='-1']") : [];
      const stockMain = focused?.isConnected === true && focused.ownerDocument === host.document && mains.length === 1 && mains[0] === focused;
      return host.document.designMode !== "on" && !!focused && (["BODY", "BUTTON", "A"].includes(focused.tagName) || stockMain) && focused.isContentEditable === false && typeof focused.matches === "function" && !focused.matches("input,textarea,select,[contenteditable]:not([contenteditable='false'])");
    } catch { return false; }
  }
  function pointer(event) {
    if (dead || blocked || !pointerGate() || event.isTrusted !== true) return;
    const kinds = { pointermove: "move", pointerdown: "down", pointerup: "up", click: "click", wheel: "wheel" }, kind = kinds[event.type];
    if (!kind || !finite(event.clientX) || !finite(event.clientY) || Math.abs(event.clientX) > 1e7 || Math.abs(event.clientY) > 1e7 || !Number.isInteger(event.buttons) || event.buttons < 0 || event.buttons > 31) return;
    try { const target = host.document.elementFromPoint(event.clientX, event.clientY); if (!target || typeof target.closest !== "function" || target.closest("[data-trust]")) return; } catch { return; }
    const at = time(); if (at === null) { blocked = "clock_unavailable"; stopAll(blocked); tell(); return; }
    for (const s of slots.values()) {
      if (!s.ready || !s.frame || !s.budget.snapshot().forward || !coverage(s.d) || !current(s)) continue;
      const r = hostEffectRect(s.d.element); if (!r) continue;
      const fields = { kind, x: event.clientX - r.x, y: event.clientY - r.y, buttons: event.buttons };
      if (fields.x < 0 || fields.y < 0 || fields.x > r.width || fields.y > r.height) continue;
      if (kind === "wheel") { fields.dx = event.deltaX; fields.dy = event.deltaY; }
      if (effectEvent("pointer", fields, s.d.instance, at)) {
        // One slot, with discrete input ahead of motion. A later move must not erase
        // a waiting click; down/up/click may still coalesce to the latest discrete event.
        if (kind !== "move" || !s.pointer || s.pointer.fields.kind === "move" || at - s.pointer.at > 100) s.pointer = { fields, at };
      }
    }
    schedule();
  }
  try {
    if (time() === null) throw Error("clock unavailable");
    root = host.document.createElement("div"); root.className = "agend-effect-layer"; host.document.body.append(root);
    geometry = createEffectGeometry({ window: host }); if (!geometry.ok) throw Error("geometry unsupported");
    observer = new host.MutationObserver(invalidate); observer.observe(host.document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    resize = new host.ResizeObserver(invalidate);
    for (const type of ["scroll", "resize", "orientationchange", "focusin", "focusout"]) { host.addEventListener(type, invalidate, true); offs.push(() => host.removeEventListener(type, invalidate, true)); }
    for (const type of ["pointermove", "pointerdown", "pointerup", "click", "wheel"]) { host.addEventListener(type, pointer, { passive: true }); offs.push(() => host.removeEventListener(type, pointer)); }
    host.addEventListener("storage", revalidateSafety); offs.push(() => host.removeEventListener("storage", revalidateSafety));
    const visibility = () => { revalidateSafety(); invalidate(); };
    host.document.addEventListener("visibilitychange", visibility); offs.push(() => host.document.removeEventListener("visibilitychange", visibility));
    if (typeof host.PerformanceObserver === "function" && host.PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      try {
        longTasks = new host.PerformanceObserver(list => {
          for (const entry of list.getEntries()) for (const s of slots.values()) if (s.ready && s.budget) {
            // No URL, container name, content or private Worker timing is read. Missing attribution stays unknown.
            const attributed = Array.isArray(entry.attribution) && entry.attribution.some(a => a.containerId === s.frame.element.id && typeof a.containerId === "string" && a.containerId.length > 0);
            s.budget.longTask(entry.startTime, entry.duration, attributed);
          }
        }); longTasks.observe({ type: "longtask", buffered: false }); longTasksSupported = true;
      } catch { longTasks?.disconnect(); longTasks = null; }
    }
  } catch {
    dead = true;
    for (const release of [() => observer?.disconnect(), () => resize?.disconnect(), () => longTasks?.disconnect(), ...offs, () => geometry?.dispose(), () => root?.remove()]) { try { release(); } catch { /* continue releasing other host resources */ } }
    return { ok: false, reason: "registry_unsupported" };
  }
  const api = { ok: true,
    update(ds, ctx) {
      if (dead || reentrantStock()) return view();
      hideGeometry();
      revision++;
      if (!Array.isArray(ds) || ds.length > 128 || !plain(ctx)) { descriptors = []; context = null; results.clear(); stopAll("gates_unknown"); return []; }
      descriptors = ds.map(snapshotDescriptor).filter(Boolean);
      for (const [key, identity] of paused) if (!descriptors.some(d => d.key === key && signature(d) === identity)) paused.delete(key);
      for (const [key, f] of failures) if (!descriptors.some(d => d.key === key && signature(d) === f.identity)) failures.delete(key);
      context = Object.fromEntries([...FLAGS, "openInstance"].map(k => [k, ctx[k]]));
      reconcile(); return view();
    },
    snapshot: view,
    /** Host storage/foreground observation only, never called from a frame message. */
    revalidateSafety,
    /** Called only by the host's explicit human Resume UI. A descriptor update never clears this latch. */
    resume(key) {
      if (dead || reentrantStock() || blocked || typeof key !== "string") return false;
      const proposed = revision, d = descriptors.find(d => d.key === key); if (!d || d.trialStage && !coverage(d) || revision !== proposed || receipt(safety.resume, d.id, device()) !== true || revision !== proposed) return false;
      revision++;
      if (!stopAll("human_resume")) return false;
      if (blocked) return false; paused.delete(key); failures.delete(key); reconcile(); return true;
    },
    /** Host-only content-free signal API. Raw pointer publishing is refused; native pointer metadata is coalesced here. */
    publish(type, fields, instance = null) {
      if (dead || blocked || !globalAllowed() || context.hidden || !coverage() || !TYPES.includes(type)) return 0;
      const ts = time(); if (ts === null) { blocked = "clock_unavailable"; stopAll(blocked); tell(); return 0; }
      let sent = 0; const proposal = revision;
      for (const s of [...slots.values()]) {
        if (dead || proposal !== revision) return sent;
        if (!s.ready || !s.frame || !s.budget.snapshot().forward || !coverage(s.d) || !current(s)) continue;
        if (["state", "reply", "mention"].includes(type) && (s.d.instance !== null ? instance !== s.d.instance : instance !== context.openInstance)) continue;
        const e = effectEvent(type, fields, s.d.instance, ts); if (e && s.frame.send(e)) sent++;
      }
      return sent;
    },
    dispose() {
      if (dead) return; dead = true; revision++; stopAll("disposed");
      if (raf !== null) host.cancelAnimationFrame(raf); if (timer !== null) host.clearTimeout(timer);
      observer.disconnect(); resize.disconnect(); longTasks?.disconnect(); for (const off of offs) off();
      geometry.dispose(); root.remove(); observed.clear(); if (loads.size === 0 && registries.get(host) === api) registries.delete(host);
    },
  };
  // Read-only host geometry seam; no selector guessing among poster and live roots.
  Object.defineProperty(api, "frameRoot", { get: () => dead ? null : root });
  registries.set(host, api); return api;
}
