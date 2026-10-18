/** #1629: app-owned pool; Chat contributes a lease, never another registry/loader. */
import { effectPlaybackReason, EFFECT_BLOCK_REASONS } from "./effect-policy.js";
import { createEffectTrialSource } from "./effect-trial-source.js";
import { createOwnerEffectSource } from "./effect-owner-source.js";
import { createEffectRuntimeLoader } from "./effect-runtime-loader.js";
import { createEffectRegistry } from "./effect-registry.js";
import { createEffectSafety } from "./effect-safety.js";
import { stockEffectTrust } from "./effect-stock-trust.js";
import { createEffectProfileCollector } from "./effect-profiles.js";
import { effectPlaybackIdentity, createEffectWriter } from "./effect-chat-runtime.js";

const episodes = new WeakSet();

/** `current` belongs to the page/session episode. Route cleanup only releases its contribution. */
export function createAppEffectRuntime({ window: host, current, observe, onChange = () => {}, onDispose = () => {}, resolveOwnerTarget = null, onOwnerUnavailable = () => {}, factories = {} }) {
  let dead = false, error = null, loader = null, registry = null, writer = null, source = null, personal = null, trial = null, pending = null, lastMetadata = null, serial = 0, revision = 0, stamp = null, syncing = false, queued = false;
  const bindings = new Map(), profiles = new Map();
  let lastContext = null, playbackUnavailable = null;
  const identity = effectPlaybackIdentity(host), auth = host?.AgendAuth;
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
  const snapshot = s => {
    const effects = s?.metadata?.effects ?? [], known = registry?.snapshot?.() ?? [];
    const rows = effects.map(p => {
      const b = s.bindings.get(p.id), row = known.find(r => b && r.key === b.key && r.id === p.id);
      if (row && !s.error && !playbackUnavailable) return row.reason == null && row.phase == null ? { ...row, phase: "loading" } : row;
      return { id: p.id, key: b?.key ?? null, verdict: "off", phase: null, quality: null,
        reason: s.error ?? playbackUnavailable ?? effectPlaybackReason(lastContext) ?? (!p.manifest.regions.includes("chat") ? "region_unavailable" : "runtime_unavailable") };
    });
    return { error: error ?? s?.error ?? null, rows, effects, loading: !!s && !s.dead && s.metadata === null && !s.error };
  };
  function tell() {
    const s = source, value = snapshot(s); if (dead) return;
    if (sourceAlive(s)) {
      const next = JSON.stringify(value);
      if (next !== s.lastSnapshot) { s.lastSnapshot = next; safe(() => s.onChange(value)); }
    }
    if (!dead) safe(() => onChange(snapshot(source)));
  }
  function reportPlayback(s) {
    if (!sourceAlive(s) || identity.scope !== "owner") return;
    const now = safe(clock);
    if (!Number.isFinite(now) || now < 0 || s.reportClock !== null && now < s.reportClock) { s.reporter.dispose(); return; }
    s.reportClock = now;
    const value = snapshot(s);
    for (const id of s.reported.keys()) if (!value.effects.some(p => p.id === id)) s.reported.delete(id);
    for (const row of value.rows) {
      if (!sourceAlive(s)) return;
      const status = row.phase === "running" && row.reason == null ? "playing" : "blocked";
      const reason = status === "playing" ? null : EFFECT_BLOCK_REASONS.includes(row.reason) ? row.reason : "unknown";
      const device = lastContext?.constrained === true ? "constrained" : "standard";
      const next = JSON.stringify([status, reason, device]), last = s.reported.get(row.id);
      if (last && (now - last.at < 10000 || next === last.value && now - last.at < 60000)) continue;
      s.reported.set(row.id, { at: now, value: next });
      void s.reporter.post(`/ui/effects/profile/${row.id}?instance=${encodeURIComponent(s.name)}&ownerEpoch=${identity.epoch}`,
        { v: 1, kind: "playback", device, status, reason });
    }
    // No server polling or unbounded retries: at most one observation per effect / 10s, a 60s heartbeat.
    if (sourceAlive(s)) s.reportTimer = host.setTimeout(() => reportPlayback(s), 10000);
  }
  function discard(s) {
    if (!s || s.dead) return;
    s.dead = true; s.generation++; s.metadata = null;
    safe(() => host.clearTimeout(s.reportTimer)); safe(() => s.reporter?.dispose());
    if (source === s) source = null;
    safe(() => trial?.stopFor(s));
    for (const b of s.bindings.values()) bindings.delete(b.key); s.bindings.clear();
    if (pending?.source === s) safe(() => pending.controller.abort());
    revision++; stamp = null;
  }
  function dispose() {
    if (dead) return; dead = true; discard(source);
    safe(() => trial?.dispose()); safe(() => pending?.controller.abort()); safe(() => registry?.dispose?.()); safe(() => loader?.dispose?.()); safe(() => personal?.dispose()); safe(() => writer?.dispose()); safe(() => offAuth?.());
    safe(() => host?.removeEventListener?.("pagehide", dispose));
    for (const row of profiles.values()) safe(() => row.collector.dispose()); profiles.clear(); bindings.clear(); safe(() => onDispose({ error }));
  }
  function fail(reason) { if (dead) return; error = reason; dispose(); safe(() => onChange({ error, rows: [], effects: [], loading: false })); }
  const unavailable = { ok: false, sync() {}, changedChat() {}, reply() {}, detachChat() {}, attachChat() { return null; }, attachTrial() { return null; }, stopTrial() {}, trialSnapshot: () => ({ rows: [] }), snapshot: () => snapshot(null), dispose };
  if (!host || typeof host !== "object" || episodes.has(host) || !identity || typeof current !== "function" || typeof observe !== "function" || typeof auth?.onSessionEnd !== "function" || typeof auth?.sessionEnded !== "function") return unavailable;
  episodes.add(host); // Claim before invoking current/auth callbacks: one attempt per Window episode.
  if (!alive()) { dispose(); return unavailable; }
  try {
    offAuth = auth.onSessionEnd(dispose);
    if (!alive()) { dispose(); safe(() => offAuth?.()); return unavailable; }
    host.addEventListener?.("pagehide", dispose);
  } catch { fail("runtime_unavailable"); return unavailable; }
  const make = (key, fn) => factories[key] ?? fn;
  function bindingAlive(b) { if (b?.kind === "trial") return trial?.current(b) === true; if (b?.kind === "owner") return personal?.current(b) === true; return !!b && sourceAlive(b.source) && b.source.generation === b.generation && bindings.get(b.key) === b && b.source.bindings.get(b.id) === b; }
  const bindingFor = (key, id) => { const b = bindings.get(key) ?? trial?.binding(key, id) ?? personal?.binding(key, id); return b?.id === id && bindingAlive(b) ? b : null; };
  try {
    writer = createEffectWriter(host, alive);
    loader = make("loader", createEffectRuntimeLoader)({ window: host, ownerEpoch: identity.epoch, current: alive, onRevoke: () => fail("runtime_unavailable") });
    if (!loader.ok || typeof loader.placementsSettled !== "function" || typeof loader.resourceSettled !== "function") throw Error("runtime_unavailable");
    registry = make("registry", createEffectRegistry)({ window: host, origin: host.location?.origin, boot: host.document.body.dataset.effectBoot,
      load: async (descriptor, signal) => {
        const b = bindingFor(descriptor.key, descriptor.id);
        if (!bindingAlive(b) || descriptor.id !== b.id || signal.aborted) return null;
        if (b.kind === "trial") return trial.load(b, signal);
        if (b.kind === "owner") return personal.load(b, signal);
        const value = await loader.resourceSettled({ id: b.id, instance: b.source.name }, signal);
        if (!bindingAlive(b) || signal.aborted) return null;
        if (!value) { refuseSource(b.source); return null; }
        return value;
      },
      safety: make("safety", createEffectSafety)({ storage: host.localStorage, crypto: host.crypto }),
      stockSnapshot: ({ frameRoot }) => make("stock", stockEffectTrust)(host, { frameRoot, ownerCss: observe().ownerCss }),
      onChange() { try { tell(); emit(); } catch { fail("runtime_unavailable"); } },
      onMount(owner) {
        const b = bindingFor(owner.key, owner.id); if (identity.scope !== "owner" || !bindingAlive(b) || b.id !== owner.id || !owner.current()) return;
        const collector = make("collector", createEffectProfileCollector)({ key: owner.key, id: owner.id, device: owner.device, clock });
        const began = safe(clock);
        if (collector.ok && Number.isFinite(began) && began >= 0 && bindingAlive(b) && owner.current()) profiles.set(owner, { binding: b, collector, began, attempted: null }); else collector.dispose?.();
      },
      onRetire(owner) { profiles.get(owner)?.collector.dispose(); profiles.delete(owner); },
      onProfile(raw, owner) {
        const row = profiles.get(owner); if (!row || !bindingAlive(row.binding) || !owner.current()) return;
        row.collector.add(raw); if (row.binding.kind === "trial") return; // Diagnostic samples stay transient; shared safety still runs in registry.
        const now = clock();
        if (!Number.isFinite(now) || now < row.began || now - row.began < 10000 && raw.verdict !== "paused" || row.attempted !== null && now - row.attempted < 10000) return;
        const report = row.collector.report(); if (!report || !bindingAlive(row.binding) || !owner.current()) return;
        row.attempted = now;
        const query = row.binding.kind === "owner" ? "" : `instance=${encodeURIComponent(row.binding.source.name)}&`;
        void writer.post(`/ui/effects/profile/${owner.id}?${query}ownerEpoch=${identity.epoch}`, report.profile);
      }, clock,
    });
    if (!registry.ok) {
      // Keep authenticated placement metadata available for explanations. This inert adapter cannot create,
      // load, resume, send to, or authorize a frame; a failed paint subsystem is never permission.
      playbackUnavailable = "unsupported_host";
      safe(() => registry?.dispose?.());
      registry = { ok: true, frameRoot: null, update() {}, snapshot: () => [], publish() {}, resume: () => false, dispose() {} };
    }
    if (identity.scope === "owner") trial = make("trialSource", createEffectTrialSource)({ window: host, current: () => {
      if (!alive()) return false; const v = observe(), c = v.context;
      return alive() && c.enabled === true && c.show === true && c.transportReady === true
        && c.safe === false && c.publicLink === false && c.reducedMotion === false && c.hidden === false;
    }, ownerCurrent: (s, name) => sourceAlive(s) && s.name === name,
      stock: () => registry.frameRoot ? make("stock", stockEffectTrust)(host, { frameRoot: registry.frameRoot, ownerCss: observe().ownerCss }) : null,
      readResource: (spec, signal) => typeof loader.trialResourceSettled === "function" ? loader.trialResourceSettled(spec, signal) : Promise.resolve(null),
      onChange() { revision++; stamp = null; sync(); tell(); },
    });
    if (identity.scope === "owner" && typeof resolveOwnerTarget === "function") {
      if (typeof loader.ownerSettled !== "function") throw Error("runtime_unavailable");
      personal = createOwnerEffectSource({ current: alive,
        readMetadata: signal => loader.ownerSettled(signal), readResource: (spec, signal) => loader.resourceSettled(spec, signal), resolveTarget: resolveOwnerTarget,
        stock: () => registry.frameRoot ? make("stock", stockEffectTrust)(host, { frameRoot: registry.frameRoot, ownerCss: observe().ownerCss }) : null,
        onChange() { revision++; stamp = null; sync(); tell(); }, onUnavailable: (slot, id) => safe(() => onOwnerUnavailable(slot, id)),
      });
      if (!personal.ok) throw Error("runtime_unavailable");
    }
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
    s.error = "resource_unavailable"; s.generation++;
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
      const candidate = source;
      if (candidate && !sourceAlive(candidate)) discard(candidate);
      const before = revision, value = observation(), s = source;
      if (!alive() || revision !== before || s !== source) { if (alive()) queueSync(); return; }
      const entries = [...(personal?.descriptors() ?? []), ...(trial?.descriptors() ?? []), ...descriptors(s)];
      if (!alive() || revision !== before || s !== source) { stamp = null; if (alive()) queueSync(); return; }
      lastContext = { ...value.context };
      const next = JSON.stringify([revision, value.context, entries.map(d => [d.key, d.paused])]);
      if (stamp !== next) {
        if (!alive() || revision !== before || s !== source) { stamp = null; if (alive()) queueSync(); return; }
        stamp = next; registry.update(entries, value.context);
      }
      if (!alive() || revision !== before || s !== source) { stamp = null; if (alive()) queueSync(); return; }
      emit();
      const c = value.context;
      // Metadata describes placements, not executable resources. Its existing session/epoch/current and
      // shared settled-lane fences apply even when this viewer has declined playback. No code is fetched here.
      if (!pending) {
        const ownerNeeds = identity.scope === "owner" && !c.publicLink && c.enabled && c.show && c.transportReady && !c.safe && !c.reducedMotion && !c.hidden && personal?.needsMetadata() === true, chatNeeds = sourceAlive(s) && !s.error && !s.metadata;
        if (!alive() || revision !== before || s !== source) { if (alive()) queueSync(); return; }
        if (ownerNeeds && (!chatNeeds || lastMetadata !== "owner")) void readPersonal();
        else if (chatNeeds) void read(s);
      }
      tell();
    } catch { fail("runtime_unavailable"); }
    finally { syncing = false; }
  }
  async function readPersonal() {
    if (!personal || pending || !personal.needsMetadata() || !alive()) return;
    const op = { source: personal, controller: new host.AbortController() }; pending = op; lastMetadata = "owner";
    try { await personal.read(op.controller.signal); }
    catch { fail("runtime_unavailable"); }
    finally { if (pending === op) { pending = null; if (alive()) sync(); } }
  }
  function changedOwner() {
    if (!personal || !alive()) return;
    if (pending?.source === personal) safe(() => pending.controller.abort());
    personal.invalidate();
  }
  function ownerSnapshot() {
    return { ...(personal?.snapshot() ?? { error: null, rev: -1, loading: false, slots: {} }),
      rows: registry?.snapshot().flatMap(row => { const b = personal?.binding(row.key, row.id); return b ? [{ ...row, slot: b.slot }] : []; }) ?? [] };
  }
  async function cursorImageSettled(selection, signal) {
    const own = personal?.cursorSelection();
    if (!alive() || !own || !personal.cursorCurrent(selection) || signal?.aborted) return null;
    let value; try { value = await loader.cursorImageSettled(own.id, signal); } catch { value = null; }
    if (!alive() || !personal.cursorCurrent(own) || !personal.cursorCurrent(selection) || signal?.aborted) return null;
    if (!value) { personal.refuseCursor(own); return null; }
    return value;
  }
  async function read(s) {
    if (!sourceAlive(s) || pending || s.error) return;
    const op = { source: s, generation: s.generation, controller: new host.AbortController() }; pending = op; lastMetadata = "chat";
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
  function publishReply(s, event) { if (host.document.body.dataset.webTransport !== "poll" && sourceAlive(s) && !s.error && event.instance === s.name) registry.publish("reply", {}, s.name); }
  function attachChat(options) {
    discard(source); const expected = revision; sync();
    if (!alive() || revision !== expected || source !== null) return null;
    const { name, element, current: ownCurrent, observe: ownObserve, onChange: ownChange = () => {} } = options ?? {};
    if (!alive() || typeof name !== "string" || name.length < 1 || name.length > 128 || !element || element.isConnected !== true || typeof ownCurrent !== "function" || typeof ownObserve !== "function" || safe(() => ownCurrent() === true) !== true || revision !== expected || source !== null) return null;
    const s = { name, element, current: ownCurrent, observe: ownObserve, onChange: ownChange, serial: ++serial, generation: 0, dead: false, error: null, metadata: null, bindings: new Map(), paused: new Map() };
    source = s;
    s.reporter = createEffectWriter(host, () => sourceAlive(s)); s.reported = new Map(); s.reportClock = null;
    s.reportTimer = host.setTimeout(() => reportPlayback(s), 10000);
    revision++; stamp = null;
    const placement = id => sourceAlive(s) && !s.error ? s.metadata?.effects.find(p => p.id === id) : null;
    const changed = () => changedSource(s);
    const api = { ok: true, sync,
      changed,
      reply(event) { publishReply(s, event); },
      pause(id) { const p = placement(id); if (!p) return false; s.paused.set(id, placementIdentity(p)); revision++; sync(); return true; },
      resume(id) { const p = placement(id); if (!p) return false; s.paused.delete(id); revision++; sync(); const b = s.bindings.get(id); return bindingAlive(b) && registry.resume(b.key); },
      async remove(id) { const p = placement(id); if (identity.scope !== "owner" || !p) return false; const generation = s.generation; const ok = await writer.post("/ui/effects/remove", { instance: s.name, id }); if (!sourceAlive(s) || generation !== s.generation) return false; if (ok) changed(); return ok; },
      snapshot: () => sourceAlive(s) ? snapshot(s) : { error: null, rows: [], effects: [], loading: false },
      dispose() { if (source !== s) return; discard(s); sync(); },
    };
    sync(); tell(); return sourceAlive(s) ? api : null;
  }
  return { ok: true, playbackAvailable: playbackUnavailable === null, sync, attachChat, changedOwner, ownerSnapshot,
    attachTrial(options) { const s = source; return trial && !playbackUnavailable && sourceAlive(s) ? trial.attach(options, s) : null; },
    stopTrial() { trial?.stop(); },
    trialSnapshot() { return { rows: registry?.snapshot().filter(row => trial?.binding(row.key, row.id)) ?? [] }; },
    cursorSelection: () => personal?.cursorSelection() ?? null, cursorImageSettled,
    pauseOwner(slot) { return personal?.pause(slot) === true; },
    resumeOwner(slot) { if (!personal?.unpause(slot)) return false; const b = personal.slotBinding(slot); return bindingAlive(b) && registry.resume(b.key); },
    changedChat() { changedSource(source); }, reply(event) { publishReply(source, event); }, detachChat() { discard(source); sync(); }, snapshot: () => snapshot(source), dispose };
}
