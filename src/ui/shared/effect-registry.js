/** #1629 B2: one host-owned Canvas Worker pool. Product adapters are deliberately separate. */
import { allocateEffectFrames, effectEvent } from "./effect-policy.js";
import { captureEffectBaseline } from "./effect-baseline.js";
import { createEffectFrame } from "./effect-frame.js";
import { createEffectGeometry, hostEffectRect } from "./effect-geometry.js";
import { EffectBudget } from "./effect-profiler.js";

const registries = new WeakMap();
const plain = o => !!o && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
const finite = v => typeof v === "number" && Number.isFinite(v);
const FLAGS = ["safe", "publicLink", "reducedMotion", "saveData", "hidden", "enabled", "show", "previewReady", "optIn", "constrained", "modal"];
const TYPES = ["state", "reply", "mention", "theme"];
function unsafeSnapshotDescriptor(d) {
  if (!plain(d) || !plain(d.params ?? {})) return null;
  const params = Object.create(null), keys = Object.keys(d.params ?? {}).sort();
  if (keys.length > 16) return null;
  for (const k of keys) {
    const v = d.params[k];
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(k) || !(typeof v === "boolean" || finite(v) || typeof v === "string" && v.length <= 128)) return null;
    params[k] = v;
  }
  const out = { key: d.key, id: d.id, region: d.region, layer: d.layer, by: d.by === "human" ? "human" : "agent", order: d.order,
    paused: d.paused, visible: d.visible, instance: d.region === "chat" ? d.instance : null, params, element: d.element };
  out.identity = JSON.stringify([out.id, out.region, out.layer, out.by, out.instance, params]);
  return out;
}

function snapshotDescriptor(d) { try { return unsafeSnapshotDescriptor(d); } catch { return null; } }

/**
 * `load` is an authenticated, bounded host loader, never a Worker callback. It returns {id,code,params,assets,wants}.
 * Safety is mandatory and synchronous: allowed(id,device), begin({key,id,device}), finish(token,reason), pause(record), resume(id,device). Pause persists a soft latch and history; human resume never clears sticky off.
 * Unknown receipts, roots, trust coverage or gates mount nothing. No storage, network, content or product imports here.
 */
export function createEffectRegistry({ window: host, origin, boot, load, safety, trustComplete, onChange = () => {}, onProfile = () => {}, clock = () => host.performance.now() } = {}) {
  try { if (!host?.document || !host.document.body || registries.has(host) || typeof load !== "function" || typeof trustComplete !== "function" || typeof onChange !== "function" || typeof onProfile !== "function" || typeof clock !== "function" || !safety || ["allowed", "begin", "finish", "pause", "resume"].some(k => typeof safety[k] !== "function") || ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "MutationObserver", "ResizeObserver", "AbortController"].some(k => typeof host[k] !== "function")) return { ok: false, reason: "registry_unsupported" }; } catch { return { ok: false, reason: "registry_unsupported" }; }
  let dead = false, blocked = null, revision = 0, last = null, lastView = null, frameSerial = 0, context = null, descriptors = [], calibration = null, baseline = null, baselineDevice = null, serial = 0, raf = null, timer = null;
  const slots = new Map(), loads = new Set(), paused = new Map(), offs = [], observed = new Set(), failures = new Map(), results = new Map();
  let root, geometry, observer, resize, longTasks = null, longTasksSupported = false;
  const time = () => {
    let n; try { n = clock(); } catch { return null; }
    if (!finite(n) || n < 0 || last !== null && n < last) return null;
    last = n; return n;
  };
  const nativeClock = () => { const n = time(); if (n === null) throw Error("clock unavailable"); return n; };
  const device = () => context?.constrained === true ? "constrained" : "standard";
  const coverage = () => { const before = revision; try { return trustComplete() === true && before === revision; } catch { return false; } };
  const current = s => !dead && !blocked && slots.get(s.d.key) === s && s.live;
  const tell = () => { if (dead) return; const state = view(), stamp = JSON.stringify(state); if (stamp === lastView) return; lastView = stamp; try { onChange(state); } catch { /* a display callback cannot admit code */ } };
  const receipt = (fn, ...args) => { try { return Reflect.apply(fn, safety, args); } catch { return null; } };
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
    if (!["disposed", "superseded", "hidden", "human_resume", "calibrating", "geometry_changed"].includes(why)) failures.set(s.d.key, { identity: signature(s.d), reason: why });
    s.frame?.remove(why); s.geometry?.remove();
    if (s.loadOff) s.loadOff();
    if (count) {
      paused.set(s.d.key, signature(s.d));
      if (receipt(safety.pause, { id: s.d.id, device: s.device, reason: why, metrics: s.budget?.snapshot().metrics ?? null }) !== true) blocked = "safety_unknown";
    }
    clearMarker(s, why);
    if (blocked) for (const other of [...slots.values()]) retire(other, blocked);
  }
  function stopAll(why) {
    for (const s of [...slots.values()]) retire(s, why);
    if (calibration) { calibration.cancel(); calibration = null; }
  }
  function gatesKnown() { return context && FLAGS.every(k => typeof context[k] === "boolean") && (context.openInstance === null || typeof context.openInstance === "string" && context.openInstance.length >= 1 && context.openInstance.length <= 128); }
  function eligible() { return gatesKnown() && !context.safe && !context.publicLink && !context.reducedMotion && !context.saveData && context.enabled && context.show && context.previewReady && context.optIn; }
  const globalAllowed = () => eligible() && host.document.visibilityState === "visible";
  const signature = d => d.identity;
  function view() {
    return descriptors.map(d => {
      const r = results.get(d.key) ?? { verdict: "off", reason: blocked ?? "unknown", queuePos: null }, s = slots.get(d.key);
      return { key: d.key, id: d.id, ...r, phase: s?.frame ? s.ready ? "running" : "starting" : s ? "loading" : null,
        quality: s?.budget?.snapshot().quality ?? null, reason: blocked ?? ((paused.get(d.key) === signature(d)) ? "paused" : failures.get(d.key)?.identity === signature(d) ? failures.get(d.key).reason : s && context?.hidden ? "hidden" : r.reason) };
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
    if (dead) return;
    geometry?.hide(); for (const s of slots.values()) s.pointer = null;
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
    if (dead) return;
    const proposal = revision;
    if (time() === null) blocked = "clock_unavailable";
    const hidden = context?.hidden === true || host.document.visibilityState !== "visible";
    if (blocked || !eligible() || !coverage()) {
      stopAll(blocked ?? "gates_unknown"); results.clear(); tell(); return;
    }
    // Hidden frames already owned may survive for <=10 s, but no new frame or load is admitted while hidden.
    const ctx = { ...context, hidden: false };
    const ds = descriptors.map(d => ({ ...d, paused: d.paused === true || paused.get(d.key) === signature(d) || failures.get(d.key)?.identity === signature(d) }));
    const allocation = allocateEffectFrames(ds, ctx); results.clear();
    for (const r of allocation) results.set(r.key, r);
    const chosen = new Set(allocation.filter(r => r.verdict === "active").map(r => r.key));
    for (const s of [...slots.values()]) {
      const d = descriptors.find(x => x.key === s.d.key);
      if (!chosen.has(s.d.key) || !d || signature(d) !== signature(s.d) || d.element !== s.d.element || s.device !== device()) retire(s, "superseded");
    }
    if (chosen.size === 0) { if (calibration) { calibration.cancel(); calibration = null; } baseline = null; baselineDevice = null; tell(); return; }
    if (hidden) {
      geometry.hide();
      if (calibration) { calibration.cancel(); calibration = null; }
      for (const s of [...slots.values()]) {
        if (!s.frame) retire(s, "hidden");
        else { if (s.hiddenSince === null) { s.hiddenSince = last; s.healthySince = null; } if (s.budget.gates({ hidden: true, reducedMotion: false, saveData: false, show: true }).remove) retire(s, "hidden"); }
      }
      schedule(); tell(); return;
    }
    if (!globalAllowed()) { stopAll("gates_unknown"); tell(); return; }
    for (const s of slots.values()) if (s.frame && s.hiddenSince !== null) { s.hiddenSince = null; s.healthySince = last; if (s.budget.gates({ hidden: false, reducedMotion: false, saveData: false, show: true }).remove) retire(s, "hidden"); }
    try { observe(); } catch { stopAll("trust_geometry_unknown"); tell(); return; }
    if (baseline === null || baselineDevice !== device()) {
      if (calibration && baselineDevice === device()) { tell(); return; }
      stopAll("calibrating");
      const epoch = ++serial;
      const job = captureEffectBaseline({ window: host, empty: () => !dead && slots.size === 0 && host.document.querySelectorAll("iframe.agend-effect-frame").length === 0 && globalAllowed() && !context.hidden && coverage(), clock: nativeClock });
      calibration = job; baselineDevice = device();
      job.promise.then(r => {
        if (dead || calibration !== job || epoch !== serial) return;
        calibration = null;
        if (!r.ok) { blocked = r.reason; tell(); return; }
        baseline = r.baselineFps; reconcile();
      });
      tell(); return;
    }
    const max = context.constrained ? 1 : 3;
    for (const d of descriptors) {
      if (!chosen.has(d.key) || slots.has(d.key)) continue;
      if (slots.size >= max || loads.size >= max) break;
      const permitted = receipt(safety.allowed, d.id, device());
      if (proposal !== revision) return;
      if (permitted !== true) { results.set(d.key, { verdict: "off", reason: "safety_unknown", queuePos: null }); continue; }
      if (slots.has(d.key) || slots.size >= max || loads.size >= max || !globalAllowed() || context.hidden || !coverage() || proposal !== revision || !descriptors.some(x => x.key === d.key && signature(x) === signature(d) && x.element === d.element)) break;
      const rect = hostEffectRect(d.element);
      if (!rect || d.element.ownerDocument !== host.document) { results.set(d.key, { verdict: "off", reason: "geometry_unknown", queuePos: null }); continue; }
      const s = { d, device: device(), live: true, ready: false, readyAt: null, frame: null, geometry: null, budget: null, token: null, request: null, loadOff: null, rect: null, pointer: null, lastPointer: null, hiddenSince: null, healthySince: null };
      slots.set(d.key, s);
      const request = { controller: new host.AbortController(), slot: s, timer: null, began: time() }; s.request = request; loads.add(request);
      const withinDeadline = () => {
        const n = time();
        if (n === null || request.began === null || n - request.began >= 10000) { retire(s, n === null || request.began === null ? "clock_unavailable" : "resource_timeout"); return false; }
        return true;
      };
      const acceptCompletion = () => {
        if (!current(s)) { clearMarker(s, "superseded"); return false; }
        if (!withinDeadline()) return false;
        if (request.controller.signal.aborted || !globalAllowed() || context.hidden || !coverage()) {
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
        const fresh = hostEffectRect(d.element);
        if (!fresh || receipt(safety.allowed, d.id, s.device) !== true) { retire(s, "safety_unknown"); return; }
        if (!acceptCompletion()) return;
        const token = receipt(safety.begin, { key: d.key, id: d.id, device: s.device });
        if (typeof token !== "string" || token.length < 1 || token.length > 128) { retire(s, "safety_unknown"); return; }
        s.token = token;
        if (!acceptCompletion()) return;
        s.rect = fresh;
        s.budget = new EffectBudget({ device: s.device, baselineFps: baseline, clock: nativeClock, longTasksSupported });
        const frame = createEffectFrame({ window: host, root, origin, boot, clock: nativeClock,
          render: { code: resource.code, params: resource.params, assets: resource.assets, wants: resource.wants, instance: d.instance, width: fresh.width, height: fresh.height, dpr: Math.min(3, Math.max(0.5, host.devicePixelRatio || 1)) },
          onReady() { if (!current(s)) return; if (!globalAllowed() || context.hidden || !coverage()) { retire(s, "hidden"); tell(); return; } const n = time(); if (n === null) { blocked = "clock_unavailable"; stopAll(blocked); tell(); return; } s.ready = true; s.readyAt = n; s.healthySince = n; publishEnv(s); schedule(); tell(); },
          onRemove(why) { if (current(s)) { retire(s, why); tell(); } },
        });
        s.frame = frame;
        if (!current(s) || !frame.ok || frame.state().removed) { frame.remove?.("stale_mount"); retire(s, "mount_failed"); return; }
        frame.element.id = `agend-effect-${boot}-${++frameSerial}`;
        s.geometry = geometry.bind(frame.element, { layer: d.layer, by: d.by });
        if (!s.geometry.ok) { retire(s, "geometry_unknown"); return; }
        const loaded = () => { if (current(s)) s.budget.loaded(); };
        frame.element.addEventListener("load", loaded); s.loadOff = () => frame.element.removeEventListener("load", loaded);
        if (!s.geometry.sync(fresh)) retire(s, "geometry_unknown");
        schedule();
      }).catch(() => { if (current(s)) retire(s, "resource_unavailable"); }).finally(() => {
        if (request.timer !== null) host.clearTimeout(request.timer);
        loads.delete(request); if (s.request === request) s.request = null;
        if (!dead) reconcile(); else if (loads.size === 0 && registries.get(host) === api) registries.delete(host);
      });
    }
    schedule(); tell();
  }
  function publishEnv(s) {
    if (!s.ready || !current(s) || context.hidden || !globalAllowed() || !coverage()) return;
    const e = effectEvent("env", { width: s.rect.width, height: s.rect.height, dpr: Math.min(3, Math.max(0.5, host.devicePixelRatio || 1)), quality: s.budget.snapshot().quality }, null, time());
    if (e) s.frame.send(e);
  }
  function tick() {
    raf = null;
    if (dead) return;
    if (!globalAllowed() || context.hidden || !coverage()) { invalidate(); return; }
    for (const s of [...slots.values()]) {
      if (!s.frame) continue;
      const rect = hostEffectRect(s.d.element);
      if (!rect || !s.geometry.sync(rect)) { retire(s, "geometry_unknown"); continue; }
      // The host owns the CSS viewport. A bounded env signal lets Worker code redraw its own bitmap if desired.
      const changed = rect.width !== s.rect.width || rect.height !== s.rect.height; s.rect = rect;
      if (changed) publishEnv(s);
      if (s.ready) s.budget.frame();
      if (s.pointer) {
        const packet = s.pointer; s.pointer = null;
        const n = time(), b = s.budget.snapshot();
        if (n !== null && n - packet.at <= 100 && pointerGate() && b.forward && (s.lastPointer === null || n - s.lastPointer >= 1000 / b.pointerHz)) {
          const event = effectEvent("pointer", packet.fields, s.d.instance, packet.at);
          if (event && s.frame.send(event)) s.lastPointer = n;
        }
      }
    }
    schedule();
  }
  function heartbeat() {
    timer = null;
    if (dead) return;
    if (time() === null) { blocked = "clock_unavailable"; stopAll(blocked); tell(); return; }
    if (!globalAllowed() || context.hidden || !coverage()) { invalidate(); return; }
    const budgetPauses = new Set();
    for (const s of [...slots.values()]) {
      if (!current(s) || !s.frame || !s.ready) continue;
      const r = s.budget.gates({ hidden: false, reducedMotion: context.reducedMotion, saveData: context.saveData, show: context.show });
      const state = r.remove ? r : s.readyAt !== null && last - s.readyAt >= 3000 ? s.budget.poll() : r;
      try { onProfile({ key: s.d.key, id: s.d.id, device: s.device, ...state }); } catch { /* metrics never authorize a mount */ }
      if (!current(s)) continue;
      if (state.remove) { const key = s.d.id + ":" + s.device; const count = state.reason === "host_budget" && !budgetPauses.has(key); if (count) budgetPauses.add(key); retire(s, state.reason, count); continue; }
      if (state.badWindows > 0) s.healthySince = null; else if (s.healthySince === null) s.healthySince = last;
      if (s.token && s.healthySince !== null && last - s.healthySince >= 5000 && state.badWindows === 0 && state.metrics !== null && !clearMarker(s, "healthy")) { stopAll("safety_unknown"); break; }
      publishEnv(s);
    }
    schedule(); tell();
  }
  function pointerGate() {
    if (!globalAllowed() || context.hidden || context.modal || !coverage()) return false;
    try {
      const focused = host.document.activeElement;
      return host.document.designMode !== "on" && !!focused && ["BODY", "BUTTON", "A"].includes(focused.tagName) && focused.isContentEditable === false && typeof focused.matches === "function" && !focused.matches("input,textarea,select,[contenteditable]:not([contenteditable='false'])");
    } catch { return false; }
  }
  function pointer(event) {
    if (dead || blocked || !pointerGate() || event.isTrusted !== true) return;
    const kinds = { pointermove: "move", pointerdown: "down", pointerup: "up", click: "click", wheel: "wheel" }, kind = kinds[event.type];
    if (!kind || !finite(event.clientX) || !finite(event.clientY) || Math.abs(event.clientX) > 1e7 || Math.abs(event.clientY) > 1e7 || !Number.isInteger(event.buttons) || event.buttons < 0 || event.buttons > 31) return;
    try { const target = host.document.elementFromPoint(event.clientX, event.clientY); if (!target || typeof target.closest !== "function" || target.closest("[data-trust]")) return; } catch { return; }
    const at = time(); if (at === null) { blocked = "clock_unavailable"; stopAll(blocked); tell(); return; }
    for (const s of slots.values()) {
      if (!s.ready || !s.frame || !s.budget.snapshot().forward) continue;
      const r = hostEffectRect(s.d.element); if (!r) continue;
      const fields = { kind, x: event.clientX - r.x, y: event.clientY - r.y, buttons: event.buttons };
      if (fields.x < 0 || fields.y < 0 || fields.x > r.width || fields.y > r.height) continue;
      if (kind === "wheel") { fields.dx = event.deltaX; fields.dy = event.deltaY; }
      if (effectEvent("pointer", fields, s.d.instance, at)) s.pointer = { fields, at };
    }
    schedule();
  }
  try {
    if (time() === null) throw Error("clock unavailable");
    root = host.document.createElement("div"); root.className = "agend-effect-layer"; host.document.body.append(root);
    geometry = createEffectGeometry({ window: host, trustRoot: host.document }); if (!geometry.ok) throw Error("geometry unsupported");
    observer = new host.MutationObserver(invalidate); observer.observe(host.document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    resize = new host.ResizeObserver(invalidate);
    for (const type of ["scroll", "resize", "orientationchange"]) { host.addEventListener(type, invalidate, true); offs.push(() => host.removeEventListener(type, invalidate, true)); }
    for (const type of ["pointermove", "pointerdown", "pointerup", "click", "wheel"]) { host.addEventListener(type, pointer, { passive: true }); offs.push(() => host.removeEventListener(type, pointer)); }
    host.document.addEventListener("visibilitychange", invalidate); offs.push(() => host.document.removeEventListener("visibilitychange", invalidate));
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
      if (dead) return view();
      revision++;
      if (!Array.isArray(ds) || ds.length > 128 || !plain(ctx)) { descriptors = []; context = null; results.clear(); stopAll("gates_unknown"); return []; }
      descriptors = ds.map(snapshotDescriptor).filter(Boolean);
      for (const [key, identity] of paused) if (!descriptors.some(d => d.key === key && signature(d) === identity)) paused.delete(key);
      for (const [key, f] of failures) if (!descriptors.some(d => d.key === key && signature(d) === f.identity)) failures.delete(key);
      context = Object.fromEntries([...FLAGS, "openInstance"].map(k => [k, ctx[k]]));
      reconcile(); return view();
    },
    snapshot: view,
    /** Called only by the host's explicit human Resume UI. A descriptor update never clears this latch. */
    resume(key) {
      if (dead || blocked && !blocked.startsWith("baseline_") || typeof key !== "string") return false;
      const proposed = revision, d = descriptors.find(d => d.key === key); if (!d || receipt(safety.resume, d.id, device()) !== true || revision !== proposed) return false;
      revision++;
      stopAll("human_resume"); if (blocked && !blocked.startsWith("baseline_")) return false; blocked = null; paused.delete(key); failures.delete(key); baseline = null; serial++; reconcile(); return true;
    },
    /** Host-only content-free signal API. Raw pointer publishing is refused; native pointer metadata is coalesced here. */
    publish(type, fields, instance = null) {
      if (dead || blocked || !globalAllowed() || context.hidden || !coverage() || !TYPES.includes(type)) return 0;
      const ts = time(); if (ts === null) { blocked = "clock_unavailable"; stopAll(blocked); tell(); return 0; }
      let sent = 0;
      for (const s of slots.values()) {
        if (!s.ready || !s.frame || !s.budget.snapshot().forward) continue;
        if (["state", "reply", "mention"].includes(type) && (s.d.instance !== null ? instance !== s.d.instance : instance !== context.openInstance)) continue;
        const e = effectEvent(type, fields, s.d.instance, ts); if (e && s.frame.send(e)) sent++;
      }
      return sent;
    },
    dispose() {
      if (dead) return; dead = true; revision++; serial++; stopAll("disposed");
      if (raf !== null) host.cancelAnimationFrame(raf); if (timer !== null) host.clearTimeout(timer);
      observer.disconnect(); resize.disconnect(); longTasks?.disconnect(); for (const off of offs) off();
      geometry.dispose(); root.remove(); observed.clear(); if (loads.size === 0 && registries.get(host) === api) registries.delete(host);
    },
  };
  registries.set(host, api); return api;
}
