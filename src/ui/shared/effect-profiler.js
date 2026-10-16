/** #1629: host observations only. This pure module mounts nothing and accepts no frame/Worker messages. */
const finite = v => typeof v === "number" && Number.isFinite(v);
const plain = v => !!v && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const DAY = 86400000;
export const EFFECT_BUDGETS = Object.freeze({
  standard: Object.freeze({ fps: 55, longTaskMsPerSecond: 50 }),
  constrained: Object.freeze({ fps: 50, longTaskMsPerSecond: 25 }),
});
const deviceClass = v => v === "standard" || v === "constrained";
const id = v => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);

/** One host-owned mount. The registry must remove the frame when remove is true, never merely hide it. */
export class EffectBudget {
  constructor({ device, baselineFps, clock = () => performance.now(), longTasksSupported = false } = {}) {
    if (!deviceClass(device) || !finite(baselineFps) || baselineFps <= 0 || baselineFps > 1000 || typeof clock !== "function" || typeof longTasksSupported !== "boolean") throw new TypeError("effect budget options");
    this.device = device;
    // Measured by the host while NO effects are mounted; never author-supplied or learned from a running effect.
    this.fpsFloor = Math.min(EFFECT_BUDGETS[device].fps, baselineFps * 0.9);
    this.clock = clock;
    this.longTasksSupported = longTasksSupported;
    this.last = null;
    this.epoch = this.time();
    this.lastWindow = null;
    this.frames = [];
    this.tasks = [];
    this.overflow = false;
    this.hiddenAt = null;
    this.verdict = "ok";
    this.reason = null;
    this.badWindows = 0;
    this.metrics = null;
    this.loadMs = null;
    if (this.epoch === null) this.stop("clock_unavailable");
  }
  time() {
    let now;
    try { now = this.clock(); } catch { return null; }
    if (!finite(now) || now < 0 || this.last !== null && now < this.last) return null;
    this.last = now;
    return now;
  }
  stop(reason = "stopped") {
    if (this.verdict === "paused") return this.snapshot();
    this.verdict = "paused";
    this.reason = reason;
    this.frames = [];
    this.tasks = [];
    return this.snapshot();
  }
  /** Invoke on host-observed load, not on child-provided timing. First load only. */
  loaded() {
    const now = this.time();
    if (now === null) return this.stop("clock_unavailable");
    if (this.verdict !== "paused" && this.loadMs === null) this.loadMs = now - this.epoch;
    return this.snapshot();
  }
  /** Invoke from the host's rAF callback; elapsed time always comes from the host clock. */
  frame() {
    const now = this.time();
    if (now === null) return this.stop("clock_unavailable");
    if (this.verdict === "paused" || this.hiddenAt !== null || now < this.epoch + 1000) return this.snapshot();
    this.trim(now);
    if (this.frames.at(-1) !== now) {
      if (this.frames.length >= 2048) this.overflow = true;
      else this.frames.push(now);
    }
    return this.snapshot();
  }
  /** Only the host observer calls this. `attributed` means it matched THIS host-owned container. */
  longTask(start, duration, attributed = false) {
    const now = this.time();
    if (now === null) return this.stop("clock_unavailable");
    if (this.verdict === "paused" || this.hiddenAt !== null || !this.longTasksSupported) return false;
    if (!finite(start) || start < 0 || !finite(duration) || duration < 50 || duration > 60000 || start + duration > now || typeof attributed !== "boolean") return false;
    const from = Math.max(start, this.epoch + 1000, now - 2000), to = start + duration;
    if (from >= to) return false;
    this.trim(now);
    if (this.tasks.length >= 256) { this.overflow = true; return false; }
    this.tasks.push({ from, to, attributed });
    return true;
  }
  trim(now) {
    this.frames = this.frames.filter(t => t > now - 2000);
    this.tasks = this.tasks.filter(t => t.to > now - 2000);
  }
  /** Strict booleans: unknown page gates fail closed. No setting can revive a paused mount. */
  gates(raw = {}) {
    const now = this.time();
    if (now === null) return this.stop("clock_unavailable");
    if (!plain(raw)) return this.stop("gates_unknown");
    const { hidden, reducedMotion, saveData, show } = raw;
    if ([hidden, reducedMotion, saveData, show].some(v => typeof v !== "boolean")) return this.stop("gates_unknown");
    if (this.verdict === "paused") return this.snapshot();
    if (reducedMotion || saveData || !show) return this.stop(reducedMotion ? "reduced_motion" : saveData ? "save_data" : "viewer_off");
    if (hidden && this.hiddenAt === null) this.hiddenAt = now;
    if (hidden && now - this.hiddenAt >= 10000) return this.stop("hidden");
    if (!hidden && this.hiddenAt !== null) {
      // A delayed visibility callback must not revive a frame whose removal deadline already passed.
      if (now - this.hiddenAt >= 10000) return this.stop("hidden");
      this.hiddenAt = null;
      this.epoch = now;
      this.lastWindow = null;
      this.frames = [];
      this.tasks = [];
      this.overflow = false;
      this.badWindows = 0;
      this.metrics = null;
    }
    return this.snapshot();
  }
  /** Poll no faster than once per second; a delayed callback never fabricates missed windows. */
  poll() {
    const now = this.time();
    if (now === null) return this.stop("clock_unavailable");
    if (this.verdict === "paused") return this.snapshot();
    if (this.hiddenAt !== null) return now - this.hiddenAt >= 10000 ? this.stop("hidden") : this.snapshot();
    if (now < this.epoch + 3000 || this.lastWindow !== null && now - this.lastWindow < 1000) return this.snapshot();
    this.lastWindow = now;
    this.trim(now);
    const sum = attributed => this.tasks.filter(t => attributed === null || t.attributed === attributed)
      .reduce((n, t) => n + Math.max(0, t.to - Math.max(t.from, now - 2000)), 0) / 2;
    const fps = this.frames.length / 2;
    const hostMs = this.longTasksSupported ? sum(null) : null;
    const ownMs = this.longTasksSupported && this.tasks.some(t => t.attributed) ? sum(true) : null;
    const limits = EFFECT_BUDGETS[this.device];
    const bad = this.overflow || fps < this.fpsFloor || hostMs !== null && hostMs > limits.longTaskMsPerSecond;
    this.metrics = { at: now, hostFps: fps, hostLongTaskMsPerSecond: hostMs, attributedLongTaskMsPerSecond: ownMs,
      attribution: ownMs === null ? "unknown" : "observed", fpsFloor: this.fpsFloor, windowMs: 2000 };
    this.overflow = false;
    if (bad) {
      this.badWindows++;
      this.verdict = "degraded";
      this.reason = "host_budget";
      if (this.badWindows >= 3) return this.stop("host_budget");
    } else this.badWindows = 0;
    return this.snapshot();
  }
  snapshot() {
    const remove = this.verdict === "paused";
    return { verdict: this.verdict, reason: this.reason, remove, forward: !remove && this.hiddenAt === null,
      quality: this.verdict === "ok" ? "normal" : "low", pointerHz: this.verdict === "ok" ? 60 : 30,
      badWindows: this.badWindows, loadMs: this.loadMs, metrics: this.metrics ? { ...this.metrics } : null };
  }
}

/** Persisted calendar policy is separate from monotonic measurement. No storage is opened by this module. */
export function newEffectPauseHistory(effectId, device, wall) {
  if (!id(effectId) || !deviceClass(device) || !finite(wall) || wall < 0) return null;
  return { v: 1, id: effectId, device, pauses: [], off: false, lastWall: wall };
}
export function recordEffectPause(history, wall) {
  if (!plain(history) || Object.keys(history).sort().join(",") !== "device,id,lastWall,off,pauses,v" || history.v !== 1 || !id(history.id) || !deviceClass(history.device) || typeof history.off !== "boolean" || !finite(history.lastWall) || history.lastWall < 0 || !finite(wall) || wall < 0 || !Array.isArray(history.pauses) || history.pauses.length > 3) return { ok: false, error: "pause_history_unknown" };
  let previous = -1;
  for (const at of history.pauses) {
    if (!finite(at) || at < 0 || at < previous || at > history.lastWall) return { ok: false, error: "pause_history_unknown" };
    previous = at;
  }
  // A wall-clock rollback cannot age out pauses. A forward jump can; off remains sticky for this content id.
  const now = Math.max(wall, history.lastWall);
  const pauses = [...history.pauses.filter(t => t > now - DAY), now].slice(-3);
  return { ok: true, history: { ...history, pauses, lastWall: now, off: history.off || pauses.length >= 3 } };
}
