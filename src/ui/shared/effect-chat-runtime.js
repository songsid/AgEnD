/** #1629: one committed local Chat lease joins the reviewed host-only effect primitives. */
import { createEffectRuntimeLoader } from "./effect-runtime-loader.js";
import { createEffectRegistry } from "./effect-registry.js";
import { createEffectSafety } from "./effect-safety.js";
import { stockEffectTrust } from "./effect-stock-trust.js";
import { createEffectProfileCollector } from "./effect-profiles.js";

const writers = new WeakMap();
/** Physical write reservations outlive a canceled caller. Responses never supply runtime authority. */
export function createEffectWriter(host, current) {
  let dead = false;
  const own = new Set();
  if (!writers.has(host)) writers.set(host, new Set());
  const all = writers.get(host);
  let previous = null;
  function stop() { if (dead) return; dead = true; for (const op of own) op.cancel(); }
  function time() {
    let now; try { now = host.performance.now(); } catch { stop(); return null; }
    if (!Number.isFinite(now) || now < 0 || previous !== null && now < previous) { stop(); return null; }
    previous = now; return now;
  }
  return {
    async post(path, body) {
      if (dead || !current() || all.size >= 3) return false;
      const began = time(); if (began === null) return false;
      const text = JSON.stringify(body); if (new TextEncoder().encode(text).length > 16384) return false;
      const controller = new host.AbortController(), op = { controller }; own.add(op); all.add(op);
      let timer, cancel;
      const aborted = new Promise(resolve => { cancel = () => { controller.abort(); resolve(false); }; }); op.cancel = cancel;
      const work = Promise.resolve().then(async () => {
        if (dead || !current() || controller.signal.aborted) return false;
        const r = await host.fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" }, body: text, signal: controller.signal });
        // Settle the body before returning the physical reservation, even if the caller already timed out.
        try { await r.body?.cancel(); } catch { /* no data is consumed */ }
        const now = time();
        return !dead && current() && !controller.signal.aborted && Number.isFinite(began) && began >= 0 && now !== null && now >= began && now - began < 10000 && r.ok && !r.redirected;
      }).catch(() => false).finally(() => { host.clearTimeout(timer); controller.abort(); own.delete(op); all.delete(op); });
      timer = host.setTimeout(cancel, 10000);
      return Promise.race([work, aborted]);
    },
    dispose: stop,
  };
}

/** Frozen, server-rendered session identity only. A header-token/public/View load has no identity. */
export function chatEffectIdentity(host) {
  try {
    const b = host.document.body.dataset, x = JSON.parse(host.document.documentElement.getAttribute("data-prefs") || "null");
    if (b.mode !== "full" || b.tier === "guest" || b.publicLink === "1" || b.webTransport === "poll" || !["person", "operator"].includes(x?.ownerScope) || x.unreadable === true || typeof x.ownerEpoch !== "string" || !/^[a-f0-9]{16}$/.test(x.ownerEpoch)) return null;
    return Object.freeze({ epoch: x.ownerEpoch, scope: x.ownerScope });
  } catch { return null; }
}
/** Chat-only public/guest capability stays separate from personal preferences and management. */
export function effectPlaybackIdentity(host) {
  try {
    const b = host.document.body.dataset;
    if (b.mode !== "full" || typeof b.effectEpoch !== "string" || !/^[a-f0-9]{16}$/.test(b.effectEpoch)) return null;
    if (b.effectScope === "owner") {
      const own = chatEffectIdentity(host);
      return own?.epoch === b.effectEpoch ? Object.freeze({ epoch: b.effectEpoch, scope: "owner" }) : null;
    }
    if (b.effectScope === "chat" && (b.publicLink === "1" && b.webTransport === "poll" || b.tier === "guest")) return Object.freeze({ epoch: b.effectEpoch, scope: "chat" });
  } catch { /* no session capability */ }
  return null;
}
export function chatEffectState(state, name) {
  const inst = state.instances?.find(i => i.name === name);
  if (!inst) return null;
  if (["stopped", "paused"].includes(inst.status)) return "stopped";
  if (Object.hasOwn(state.awaiting ?? {}, name)) return "needs_you";
  return ["working", "stuck"].includes(state.exec?.[name]) ? "working" : state.exec?.[name] === "idle" ? "idle" : null;
}

/** `observe` supplies closed host gates, never event/message content. No timers poll server state. */
export function createChatEffectRuntime({ window: host, name, element, current, observe, onChange = () => {}, factories = {} }) {
  let dead = false, error = null, loader = null, registry = null, writer = null, active = null, queued = false, generation = 0, metadata = null, ctx = null, lastContext = null;
  const paused = new Map(), owners = new Map();
  const placementIdentity = p => JSON.stringify([p.by, p.manifest.layer, p.params]);
  const identity = chatEffectIdentity(host), auth = host.AgendAuth;
  const alive = () => !dead && current() === true && element.isConnected === true && !auth.sessionEnded();
  const tell = () => { if (!dead && current()) onChange({ error, rows: registry?.snapshot() ?? [], effects: metadata?.effects ?? [], loading: metadata === null && !error }); };
  const fail = reason => { if (dead) return; error = reason; generation++; metadata = null; active?.controller.abort(); registry?.dispose?.(); registry = null; loader?.dispose?.(); loader = null; writer?.dispose(); tell(); };
  function dispose() {
    if (dead) return; dead = true; generation++; active?.controller.abort(); registry?.dispose?.(); loader?.dispose?.(); writer?.dispose(); offAuth?.();
    for (const value of owners.values()) value.collector.dispose(); owners.clear();
  }
  let offAuth = null;
  if (!identity || typeof auth?.onSessionEnd !== "function" || typeof auth?.sessionEnded !== "function" || typeof name !== "string" || name.length < 1 || name.length > 128 || !current()) return { ok: false, dispose };
  offAuth = auth.onSessionEnd(dispose); // May synchronously replay an already-ended episode.
  if (dead || !alive()) { dispose(); return { ok: false, dispose }; }
  const clock = () => host.performance.now();
  try {
    const make = (key, fn) => factories[key] ?? fn;
    writer = createEffectWriter(host, alive);
    loader = make("loader", createEffectRuntimeLoader)({ window: host, ownerEpoch: identity.epoch, current: alive });
    if (!loader.ok) throw Error("runtime_unavailable");
    registry = make("registry", createEffectRegistry)({ window: host, origin: host.location?.origin, boot: host.document.body.dataset.effectBoot,
      load: async (d, signal) => {
        const mine = generation, value = await loader.resource({ id: d.id, instance: name }, signal);
        if (!alive() || mine !== generation || signal.aborted) return null;
        if (!value) { fail("resource_unavailable"); return null; }
        return value;
      },
      safety: make("safety", createEffectSafety)({ storage: host.localStorage, crypto: host.crypto }),
      stockSnapshot: ({ frameRoot }) => make("stock", stockEffectTrust)(host, { frameRoot, ownerCss: observe().ownerCss }),
      onChange() { tell(); emit(); },
      onMount(owner) {
        if (!alive() || !owner.current()) return;
        const collector = make("collector", createEffectProfileCollector)({ key: owner.key, id: owner.id, device: owner.device, clock });
        if (collector.ok) owners.set(owner, { collector, began: clock(), attempted: null });
      },
      onRetire(owner) { const row = owners.get(owner); row?.collector.dispose(); owners.delete(owner); },
      onProfile(raw, owner) {
        const row = owners.get(owner); if (!row || !alive() || !owner.current()) return;
        row.collector.add(raw);
        const now = clock();
        if (now - row.began < 10000 && raw.verdict !== "paused" || row.attempted !== null && now - row.attempted < 10000) return;
        const report = row.collector.report(); if (!report || !owner.current()) return;
        row.attempted = now;
        void writer.post(`/ui/effects/profile/${owner.id}?instance=${encodeURIComponent(name)}&ownerEpoch=${identity.epoch}`, report.profile);
      }, clock,
    });
    if (!registry.ok) throw Error("runtime_unavailable");
  } catch { fail("runtime_unavailable"); }
  function descriptors() {
    return (metadata?.effects ?? []).filter(p => p.manifest.regions.includes("chat")).map((p, order) => ({ key: `chat:${p.id}`, id: p.id, by: p.by, region: "chat", layer: p.manifest.layer,
      order, paused: paused.get(p.id) === placementIdentity(p), visible: true, instance: name, params: p.params, element }));
  }
  function emit() {
    if (!alive() || error || !registry?.ok) return;
    const value = observe();
    if (["idle", "working", "needs_you", "stopped"].includes(value.state)) registry.publish("state", { state: value.state }, name);
    if (["light", "dark"].includes(value.mode)) registry.publish("theme", { mode: value.mode });
  }
  function sync() {
    if (!alive()) { dispose(); return; } if (error) return;
    const value = observe(); ctx = value.context;
    const stamp = JSON.stringify(ctx);
    if (stamp !== lastContext) { lastContext = stamp; registry.update(descriptors(), ctx); }
    emit();
    if (!metadata && !active && ctx.enabled && ctx.show && ctx.transportReady && !ctx.safe && !ctx.publicLink && !ctx.reducedMotion && !ctx.saveData && !ctx.hidden) void read();
  }
  async function read() {
    if (!alive() || error || active) return;
    const op = { controller: new host.AbortController(), generation }; active = op;
    try {
      const answer = await loader.placements(name, op.controller.signal);
      if (!alive() || active !== op) return;
      if (op.generation !== generation) return;
      if (!answer) { fail("resource_unavailable"); return; }
      metadata = answer;
      for (const [id, stamp] of paused) if (!answer.effects.some(p => p.id === id && placementIdentity(p) === stamp)) paused.delete(id);
      lastContext = null; sync(); tell();
    } finally {
      if (active === op) active = null;
      if (queued && alive() && !error) { queued = false; sync(); }
    }
  }
  return { ok: !error && !dead, sync,
    changed() { if (!alive() || error) return; generation++; metadata = null; registry.update([], observe().context); lastContext = null; if (active) queued = true; else sync(); tell(); },
    reply(event) { if (alive() && !error && event.instance === name) registry.publish("reply", {}, name); },
    pause(id) { if (!alive() || !metadata?.effects.some(p => p.id === id)) return false; paused.set(id, placementIdentity(metadata.effects.find(p => p.id === id))); lastContext = null; sync(); return true; },
    resume(id) { if (!alive() || error || !metadata?.effects.some(p => p.id === id)) return false; paused.delete(id); lastContext = null; sync(); return registry.resume(`chat:${id}`); },
    async remove(id) { if (!alive() || error || !metadata?.effects.some(p => p.id === id)) return false; const mine = generation; const ok = await writer.post("/ui/effects/remove", { instance: name, id }); if (!alive() || mine !== generation) return false; if (ok) this.changed(); return ok; },
    snapshot: () => ({ error, rows: registry?.snapshot() ?? [], effects: metadata?.effects ?? [], loading: metadata === null && !error }), dispose,
  };
}
