/** #1629: unmounted app-owned pool; Chat contributes a lease, never another registry/loader. */
import { createEffectRuntimeLoader } from "./effect-runtime-loader.js";
import { createEffectRegistry } from "./effect-registry.js";
import { createEffectSafety } from "./effect-safety.js";
import { stockEffectTrust } from "./effect-stock-trust.js";
import { createEffectProfileCollector } from "./effect-profiles.js";
import { chatEffectIdentity, createEffectWriter } from "./effect-chat-runtime.js";

const episodes = new WeakSet();

/** `current` belongs to the page/session episode. Route cleanup only releases its contribution. */
export function createAppEffectRuntime({ window: host, current, observe, onChange = () => {}, factories = {} }) {
  let dead = false, error = null, loader = null, registry = null, writer = null, source = null, pending = null, serial = 0, revision = 0, stamp = null, syncing = false, queued = false;
  const bindings = new Map(), profiles = new Map();
  const identity = chatEffectIdentity(host), auth = host?.AgendAuth;
  const safe = fn => { try { return fn(); } catch { return null; } };
  const alive = () => { if (dead) return false; const value = safe(() => current() === true && !auth.sessionEnded()); return !dead && value === true; };
  const sourceAlive = s => {
    if (!s || !alive() || s !== source || s.dead) return false;
    const value = safe(() => s.current() === true && s.element.isConnected === true);
    return !dead && s === source && !s.dead && value === true;
  };
  const placementIdentity = p => JSON.stringify([p.by, p.manifest.layer, p.params]);
  const clock = () => host.performance.now();
  let offAuth = null;
  const snapshot = s => ({ error: error ?? s?.error ?? null, rows: registry?.snapshot().filter(row => s?.bindings.get(row.id)?.key === row.key) ?? [], effects: s?.metadata?.effects ?? [], loading: !!s && !s.dead && s.metadata === null && !s.error });
  function tell() {
    const s = source, value = snapshot(s); if (dead) return;
    if (sourceAlive(s)) safe(() => s.onChange(value));
    if (!dead) safe(() => onChange(snapshot(source)));
  }
  function discard(s) {
    if (!s || s.dead) return;
    s.dead = true; s.generation++; s.metadata = null;
    if (source === s) source = null;
    for (const b of s.bindings.values()) bindings.delete(b.key); s.bindings.clear();
    if (pending?.source === s) safe(() => pending.controller.abort());
    revision++; stamp = null;
  }
  function dispose() {
    if (dead) return; dead = true; discard(source);
    safe(() => pending?.controller.abort()); safe(() => registry?.dispose?.()); safe(() => loader?.dispose?.()); safe(() => writer?.dispose()); safe(() => offAuth?.());
    safe(() => host?.removeEventListener?.("pagehide", dispose));
    for (const row of profiles.values()) safe(() => row.collector.dispose()); profiles.clear(); bindings.clear();
  }
  function fail(reason) { if (dead) return; error = reason; dispose(); safe(() => onChange({ error, rows: [], effects: [], loading: false })); }
  const unavailable = { ok: false, sync() {}, changedChat() {}, reply() {}, detachChat() {}, attachChat() { return null; }, snapshot: () => snapshot(null), dispose };
  if (!host || typeof host !== "object" || episodes.has(host) || !identity || typeof current !== "function" || typeof observe !== "function" || typeof auth?.onSessionEnd !== "function" || typeof auth?.sessionEnded !== "function") return unavailable;
  episodes.add(host); // Claim before invoking current/auth callbacks: one attempt per Window episode.
  if (!alive()) { dispose(); return unavailable; }
  try {
    offAuth = auth.onSessionEnd(dispose);
    if (!alive()) { dispose(); safe(() => offAuth?.()); return unavailable; }
    host.addEventListener?.("pagehide", dispose);
  } catch { fail("runtime_unavailable"); return unavailable; }
  const make = (key, fn) => factories[key] ?? fn;
  function bindingAlive(b) { return !!b && sourceAlive(b.source) && b.source.generation === b.generation && bindings.get(b.key) === b && b.source.bindings.get(b.id) === b; }
  try {
    writer = createEffectWriter(host, alive);
    loader = make("loader", createEffectRuntimeLoader)({ window: host, ownerEpoch: identity.epoch, current: alive });
    if (!loader.ok || typeof loader.placementsSettled !== "function" || typeof loader.resourceSettled !== "function") throw Error("runtime_unavailable");
    registry = make("registry", createEffectRegistry)({ window: host, origin: host.document.body.dataset.previewOrigin, boot: host.document.body.dataset.previewBoot,
      load: async (descriptor, signal) => {
        const b = bindings.get(descriptor.key);
        if (!bindingAlive(b) || descriptor.id !== b.id || signal.aborted) return null;
        const value = await loader.resourceSettled({ id: b.id, instance: b.source.name }, signal);
        if (!bindingAlive(b) || signal.aborted) return null;
        if (!value) { refuseSource(b.source); return null; }
        return value;
      },
      safety: make("safety", createEffectSafety)({ storage: host.localStorage, crypto: host.crypto }),
      stockSnapshot: ({ frameRoot }) => make("stock", stockEffectTrust)(host, { frameRoot, ownerCss: observe().ownerCss }),
      onChange() { try { tell(); emit(); } catch { fail("runtime_unavailable"); } },
      onMount(owner) {
        const b = bindings.get(owner.key); if (!bindingAlive(b) || b.id !== owner.id || !owner.current()) return;
        const collector = make("collector", createEffectProfileCollector)({ key: owner.key, id: owner.id, device: owner.device, clock });
        const began = safe(clock);
        if (collector.ok && Number.isFinite(began) && began >= 0 && bindingAlive(b) && owner.current()) profiles.set(owner, { binding: b, collector, began, attempted: null }); else collector.dispose?.();
      },
      onRetire(owner) { profiles.get(owner)?.collector.dispose(); profiles.delete(owner); },
      onProfile(raw, owner) {
        const row = profiles.get(owner); if (!row || !bindingAlive(row.binding) || !owner.current()) return;
        row.collector.add(raw); const now = clock();
        if (!Number.isFinite(now) || now < row.began || now - row.began < 10000 && raw.verdict !== "paused" || row.attempted !== null && now - row.attempted < 10000) return;
        const report = row.collector.report(); if (!report || !bindingAlive(row.binding) || !owner.current()) return;
        row.attempted = now;
        void writer.post(`/ui/effects/profile/${owner.id}?instance=${encodeURIComponent(row.binding.source.name)}&ownerEpoch=${identity.epoch}`, report.profile);
      }, clock,
    });
    if (!registry.ok) throw Error("runtime_unavailable");
  } catch { fail("runtime_unavailable"); return unavailable; }
  function descriptors(s) {
    if (!sourceAlive(s) || s.error) return [];
    return (s.metadata?.effects ?? []).filter(p => p.manifest.regions.includes("chat")).map((p, order) => {
      let b = s.bindings.get(p.id); const identity = placementIdentity(p);
      if (!b || b.identity !== identity) {
        if (b) bindings.delete(b.key);
        b = Object.freeze({ key: `chat:${s.serial}:${p.id}`, id: p.id, source: s, generation: s.generation, identity });
        s.bindings.set(p.id, b); bindings.set(b.key, b);
      }
      return { key: b.key, id: p.id, by: p.by, region: "chat", layer: p.manifest.layer, order, paused: s.paused.get(p.id) === identity, visible: true, instance: s.name, params: p.params, element: s.element };
    });
  }
  function observation() {
    const value = observe();
    return { ...value, context: { ...value.context, openInstance: sourceAlive(source) ? source.name : null } };
  }
  function emit() {
    if (!alive() || !registry?.ok) return;
    const s = source, value = observation();
    if (sourceAlive(s)) { const state = safe(() => s.observe().state); if (sourceAlive(s) && ["idle", "working", "needs_you", "stopped"].includes(state)) registry.publish("state", { state }, s.name); }
    if (alive() && ["light", "dark"].includes(value.mode)) registry.publish("theme", { mode: value.mode });
  }
  function refuseSource(s) {
    if (!sourceAlive(s)) return;
    s.error = "resource_unavailable"; s.metadata = null; s.generation++;
    for (const b of s.bindings.values()) bindings.delete(b.key); s.bindings.clear(); revision++; stamp = null; sync(); tell();
  }
  function queueSync() {
    if (queued || dead) return; queued = true;
    Promise.resolve().then(() => { queued = false; if (alive()) sync(); else dispose(); });
  }
  function sync() {
    if (!alive()) { dispose(); return; } if (syncing) { queueSync(); return; }
    syncing = true;
    try {
      if (source && !sourceAlive(source)) discard(source);
      const before = revision, value = observation(), s = source;
      if (!alive() || revision !== before || s !== source) { if (alive()) queueSync(); return; }
      const next = JSON.stringify([revision, value.context]);
      if (stamp !== next) {
        const entries = descriptors(s);
        if (!alive() || revision !== before || s !== source) { stamp = null; if (alive()) queueSync(); return; }
        stamp = next; registry.update(entries, value.context);
      }
      if (!alive() || revision !== before || s !== source) { stamp = null; if (alive()) queueSync(); return; }
      emit();
      const c = value.context;
      if (sourceAlive(s) && !s.error && !s.metadata && !pending && c.enabled && c.show && c.previewReady && c.optIn && !c.safe && !c.publicLink && !c.reducedMotion && !c.saveData && !c.hidden) void read(s);
    } catch { fail("runtime_unavailable"); }
    finally { syncing = false; }
  }
  async function read(s) {
    if (!sourceAlive(s) || pending || s.error) return;
    const op = { source: s, generation: s.generation, controller: new host.AbortController() }; pending = op;
    try {
      const answer = await loader.placementsSettled(s.name, op.controller.signal);
      if (!sourceAlive(s) || op.generation !== s.generation || pending !== op || op.controller.signal.aborted) return;
      if (!answer) { refuseSource(s); return; }
      s.metadata = answer;
      for (const [id, identity] of s.paused) if (!answer.effects.some(p => p.id === id && placementIdentity(p) === identity)) s.paused.delete(id);
      revision++; stamp = null; sync(); tell();
    } catch { if (sourceAlive(s) && op.generation === s.generation) refuseSource(s); }
    finally { if (pending === op) { pending = null; if (alive()) sync(); } }
  }
  function changedSource(s) {
    if (!sourceAlive(s) || s.error) return;
    s.generation++; s.metadata = null;
    for (const b of s.bindings.values()) bindings.delete(b.key); s.bindings.clear();
    if (pending?.source === s) safe(() => pending.controller.abort()); revision++; stamp = null; sync(); tell();
  }
  function publishReply(s, event) { if (sourceAlive(s) && !s.error && event.instance === s.name) registry.publish("reply", {}, s.name); }
  function attachChat(options) {
    discard(source); const expected = revision; sync();
    if (!alive() || revision !== expected || source !== null) return null;
    const { name, element, current: ownCurrent, observe: ownObserve, onChange: ownChange = () => {} } = options ?? {};
    if (!alive() || typeof name !== "string" || name.length < 1 || name.length > 128 || !element || element.isConnected !== true || typeof ownCurrent !== "function" || typeof ownObserve !== "function" || safe(() => ownCurrent() === true) !== true || revision !== expected || source !== null) return null;
    const s = { name, element, current: ownCurrent, observe: ownObserve, onChange: ownChange, serial: ++serial, generation: 0, dead: false, error: null, metadata: null, bindings: new Map(), paused: new Map() };
    source = s; revision++; stamp = null;
    const placement = id => sourceAlive(s) && !s.error ? s.metadata?.effects.find(p => p.id === id) : null;
    const changed = () => changedSource(s);
    const api = { ok: true, sync,
      changed,
      reply(event) { publishReply(s, event); },
      pause(id) { const p = placement(id); if (!p) return false; s.paused.set(id, placementIdentity(p)); revision++; sync(); return true; },
      resume(id) { const p = placement(id); if (!p) return false; s.paused.delete(id); revision++; sync(); const b = s.bindings.get(id); return bindingAlive(b) && registry.resume(b.key); },
      async remove(id) { const p = placement(id); if (!p) return false; const generation = s.generation; const ok = await writer.post("/ui/effects/remove", { instance: s.name, id }); if (!sourceAlive(s) || generation !== s.generation) return false; if (ok) changed(); return ok; },
      snapshot: () => sourceAlive(s) ? snapshot(s) : { error: null, rows: [], effects: [], loading: false },
      dispose() { if (source !== s) return; discard(s); sync(); },
    };
    sync(); tell(); return sourceAlive(s) ? api : null;
  }
  return { ok: true, sync, attachChat, changedChat() { changedSource(source); }, reply(event) { publishReply(source, event); }, detachChat() { discard(source); sync(); }, snapshot: () => snapshot(source), dispose };
}
