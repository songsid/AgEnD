/** #1629: explicit-click control lane. Responses never grant authority; Start reauthorizes on the server. */
import { effectTrialMessage } from "./effect-trial-offer.js";
import { checkEffectTrialStart } from "/assets/effect-runtime-loader.js";
import { chatEffectIdentity } from "/assets/effect-chat-runtime.js";
const owners = new WeakSet(), safe = fn => { try { return fn(); } catch { return null; } };
const LIMIT = 128 * 1024;
export function createEffectTrialController({ window: host, current, allowed, onStart, onChange = () => {} }) {
  let dead = false, active = null, physical = null, previous = null, broken = false, clockBusy = false, endedReason = null, endedOffer = null;
  const cleanup = [], releases = [], identity = safe(() => chatEffectIdentity(host));
  const tell = () => { if (!dead) safe(onChange); };
  function clock() {
    if (broken || clockBusy) { broken = true; return null; }
    clockBusy = true; const t = safe(() => host.performance.now()); clockBusy = false;
    if (broken || typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > Number.MAX_SAFE_INTEGER || previous !== null && t < previous) { broken = true; return null; }
    return previous = t;
  }
  function eligible(op) {
    if (dead || broken || !op || active !== op || op.dead || op.checking || host.AgendAuth?.sessionEnded?.() !== false) return false;
    op.checking = true;
    try {
      const t = clock();
      if (t === null || t < op.began || t >= op.until || safe(() => current(op.instance) === true && allowed() === true) !== true) return false;
      const after = clock();
      return !dead && !op.dead && active === op && after !== null && after >= op.began && after < op.until;
    } finally { op.checking = false; }
  }
  function end(op, reason = "stopped") {
    if (!op || op.dead) return false;
    op.dead = true; if (active === op) active = null;
    endedReason = typeof reason === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(reason) ? reason : "trial_failed";
    endedOffer = op.offer.offer;
    safe(() => op.resolve?.(false));
    safe(() => host.clearTimeout(op.timer)); safe(() => op.controller.abort());
    if (op.reply && !op.stopQueued) { op.stopQueued = true; cleanup.push(op); }
    // Physical paint is removed before callbacks, cleanup I/O or another explicit click.
    safe(() => op.dispose?.()); op.dispose = null;
    if (!["stopped", "replaced"].includes(endedReason)) safe(() => host.console?.warn("[AgEnD effects] Try stopped:", endedReason));
    tell(); drain(); return true;
  }
  function arm(op) {
    safe(() => host.clearTimeout(op.timer));
    if (!eligible(op)) { end(op, "trial_ended"); return; }
    const t = clock(); if (t === null || t >= op.until) { end(op, "trial_expired"); return; }
    op.timer = host.setTimeout(() => { if (!op.dead) arm(op); }, Math.max(1, Math.ceil(op.until - t)));
  }
  async function read(response) {
    let reader = null;
    try {
      if (!response || response.redirected || response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) return null;
      const length = response.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMIT)) return null;
      reader = response.body?.getReader(); if (!reader) return null;
      const chunks = []; let size = 0;
      for (;;) { const r = await reader.read(); if (r.done) break; if (!(r.value instanceof Uint8Array) || (size += r.value.byteLength) > LIMIT) return null; chunks.push(r.value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch { return null; }
    finally { try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch { /* retained until cancellation settles */ } }
  }
  function drain() {
    if (physical || !cleanup.length) return;
    const op = cleanup.shift(), token = {}; physical = token; const controller = new host.AbortController();
    const timer = host.setTimeout(() => controller.abort(), 10000);
    // Stop remains permitted after CSS/gate/session changes. It cannot mount or mutate appearance.
    Promise.resolve().then(async () => {
      const response = await host.fetch(`/ui/effect-trials/${op.reply.trial}/stop?ownerEpoch=${identity.epoch}`, {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" }, body: "{}", signal: controller.signal,
      });
      try { await response.body?.cancel(); } catch { /* no response fields are consumed */ }
    }).catch(() => {}).finally(() => { safe(() => host.clearTimeout(timer)); if (physical === token) physical = null; tell(); drain(); });
  }
  function dispose() {
    if (dead) return; dead = true; end(active); for (const off of releases.splice(0)) safe(off); tell();
  }
  const api = { ok: false, start: async () => false, stop: () => end(active), sync() { const op = active; if (op && !eligible(op)) end(op, "trial_ended"); },
    snapshot: () => Object.freeze({ busy: !!physical || cleanup.length > 0, phase: active ? active.reply ? "running" : "starting" : "idle", reason: active ? null : endedReason, offer: active ? active.offer.offer : endedOffer }), dispose };
  if (!identity || owners.has(host) || typeof current !== "function" || typeof allowed !== "function" || typeof onStart !== "function"
    || typeof host.AgendAuth?.trialSession !== "function" || typeof host.AgendAuth?.onSessionEnd !== "function") return Object.freeze(api);
  owners.add(host);
  try {
    const off = host.AgendAuth.onSessionEnd(dispose);
    if (dead) { safe(off); return Object.freeze(api); }
    releases.push(off);
    for (const [target, type, fn] of [[host, "blur", () => end(active, "trial_window_blur")], [host, "pagehide", dispose], [host.document, "visibilitychange", () => { if (host.document.visibilityState !== "visible") end(active, "hidden"); }]]) {
      target.addEventListener(type, fn); releases.push(() => target.removeEventListener(type, fn));
    }
  } catch { dispose(); return Object.freeze(api); }
  if (dead) return Object.freeze(api);
  api.ok = true;
  api.start = async message => {
    if (dead || active || physical || cleanup.length) return false;
    const offer = safe(() => effectTrialMessage(message)), instance = safe(() => message.instance), began = clock();
    if (!offer || began === null || began + 10000 > Number.MAX_SAFE_INTEGER || safe(() => host.Date.now() < offer.expiresAt) !== true) return false;
    const op = { instance, offer, began, until: began + 10000, controller: new host.AbortController(), timer: null, reply: null, dead: false, stopQueued: false, dispose: null };
    endedReason = null; endedOffer = null; active = op; const token = {}; physical = token;
    const cancelled = new Promise(resolve => { op.resolve = resolve; });
    const work = Promise.resolve().then(async () => {
      if (!eligible(op)) return false;
      arm(op); const session = await host.AgendAuth.trialSession();
      if (!eligible(op) || !session || session.localAdmin !== true || session.epoch !== identity.epoch) return false;
      const response = await host.fetch(`/ui/effect-trials/start?ownerEpoch=${identity.epoch}`, {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer: offer.offer, instance }), signal: op.controller.signal,
      });
      const reply = checkEffectTrialStart(await read(response), offer.offer, offer.id);
      if (!reply) return false;
      op.reply = reply;
      if (op.dead && !op.stopQueued) { op.stopQueued = true; cleanup.push(op); }
      if (reply.offer.title !== offer.title || reply.offer.expiresAt !== offer.expiresAt) return false;
      if (!eligible(op)) { if (!op.stopQueued) { op.stopQueued = true; cleanup.push(op); } return false; }
      op.until = began + reply.remainingMs;
      if (op.until > Number.MAX_SAFE_INTEGER || !eligible(op)) return false;
      arm(op);
      const handle = Object.freeze({ reply, startedAt: began, instance, current: () => eligible(op), stop: (reason = "stopped") => end(op, reason), });
      const disposer = onStart(handle);
      if (typeof disposer !== "function") return false;
      if (!eligible(op)) { safe(disposer); return false; }
      op.dispose = disposer; tell(); return eligible(op);
    }).catch(() => false).then(ok => { if (!ok) end(op, "trial_start_failed"); return ok; }).finally(() => { if (physical === token) physical = null; tell(); drain(); });
    // The logical caller may stop immediately, while the physical request/cancel still owns the lane.
    tell();
    return Promise.race([work, cancelled]);
  };
  return Object.freeze(api);
}
