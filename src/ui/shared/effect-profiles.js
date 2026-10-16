/** #1629: bounded host-window quantiles; not a frame message handler or admission verdict. */
const plain = o => !!o && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
const finite = x => typeof x === "number" && Number.isFinite(x);
const bounded = (x, max) => finite(x) && x >= 0 && x <= max;
const reasons = [null, "host_budget", "clock_unavailable", "gates_unknown", "hidden", "reduced_motion", "save_data", "viewer_off"];
const keys = ["key", "id", "device", "verdict", "reason", "remove", "forward", "quality", "pointerHz", "badWindows", "loadMs", "metrics"];
const metricKeys = ["at", "hostFps", "hostLongTaskMsPerSecond", "attributedLongTaskMsPerSecond", "attribution", "fpsFloor", "windowMs"];
const exact = (o, allowed) => plain(o) && Object.keys(o).sort().join(",") === [...allowed].sort().join(",");
const quantile = (values, q) => { if (!values.length) return null; const a = [...values].sort((x, y) => x - y); return a[Math.max(0, Math.ceil(q * a.length) - 1)]; };

/** A new collector belongs to one exact registry key/id/class mount. It never reads message content or child data. */
export function createEffectProfileCollector(options = {}) {
  let key, id, device, clock;
  try { if (!exact(options, ["key", "id", "device", "clock"])) return { ok: false }; ({ key, id, device, clock } = options); } catch { return { ok: false }; }
  if (typeof key !== "string" || key.length < 1 || key.length > 256 || typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id) || !["standard", "constrained"].includes(device) || typeof clock !== "function") return { ok: false };
  let dead = false, previous = null, lastSample = null, floor = null, last = null;
  const samples = [];
  const time = () => {
    let n; try { n = clock(); } catch { dead = true; return null; }
    if (!finite(n) || n < 0 || previous !== null && n < previous) { dead = true; return null; }
    previous = n; return n;
  };
  if (time() === null) return { ok: false };
  return { ok: true,
    add(raw) {
      if (dead) return false;
      try {
        // Reject unknown keys without reading their values or accessors.
        if (!exact(raw, keys) || raw.key !== key || raw.id !== id || raw.device !== device || !["ok", "degraded", "paused"].includes(raw.verdict) || !reasons.includes(raw.reason)
          || typeof raw.remove !== "boolean" || typeof raw.forward !== "boolean" || raw.remove !== (raw.verdict === "paused") || raw.remove && raw.forward
          || raw.quality !== (raw.verdict === "ok" ? "normal" : "low") || raw.pointerHz !== (raw.verdict === "ok" ? 60 : 30)
          || !Number.isInteger(raw.badWindows) || raw.badWindows < 0 || raw.badWindows > 3 || raw.loadMs !== null && !bounded(raw.loadMs, 600000)) { dead = true; return false; }
        const n = time(); if (n === null) return false;
        // Warmup is not an observed window and never turns missing measurements into zero cost.
        if (raw.metrics === null) return false;
        const m = raw.metrics;
        if (!exact(m, metricKeys) || !finite(m.at) || m.at < 0 || m.at > n || !bounded(m.hostFps, 1000) || !finite(m.fpsFloor) || m.fpsFloor <= 0 || m.fpsFloor > 1000 || m.windowMs !== 2000
          || m.hostLongTaskMsPerSecond !== null && !bounded(m.hostLongTaskMsPerSecond, 256000)
          || m.attributedLongTaskMsPerSecond !== null && (!bounded(m.attributedLongTaskMsPerSecond, 256000) || m.hostLongTaskMsPerSecond === null || m.attributedLongTaskMsPerSecond > m.hostLongTaskMsPerSecond)
          || m.attribution !== (m.attributedLongTaskMsPerSecond === null ? "unknown" : "observed") || floor !== null && m.fpsFloor !== floor) { dead = true; return false; }
        // Only poll() creates a window. rAF/gates/load/stop snapshots retain its immutable host timestamp.
        // A paused duplicate may describe the last verdict, but cannot renew the observation or add a sample.
        if (lastSample !== null && m.at === lastSample && last) last = { verdict: raw.verdict, reason: raw.reason, loadMs: raw.loadMs };
        if (n - m.at > 5000 || lastSample !== null && m.at - lastSample < 1000) return false;
        floor = m.fpsFloor; lastSample = m.at;
        samples.push({ fps: m.hostFps, task: m.hostLongTaskMsPerSecond, own: m.attributedLongTaskMsPerSecond });
        if (samples.length > 120) samples.shift();
        last = { verdict: raw.verdict, reason: raw.reason, loadMs: raw.loadMs };
        return true;
      } catch { dead = true; return false; }
    },
    report(options = {}) {
      let off;
      try { if (!plain(options) || Object.keys(options).some(k => k !== "off")) return null; off = options.off ?? false; } catch { dead = true; return null; }
      if (dead || typeof off !== "boolean" || lastSample === null || !last) return null;
      const n = time(); if (n === null || n - lastSample > 5000) return null;
      const host = samples.filter(s => s.task !== null).map(s => s.task), own = samples.filter(s => s.own !== null).map(s => s.own), fps = samples.map(s => s.fps);
      return { id, profile: { v: 1, device, verdict: off ? "off" : last.verdict, reason: last.reason, samples: samples.length,
        fps_p50: quantile(fps, 0.5), fps_p10: quantile(fps, 0.1), fps_floor: floor,
        long_task_p95: quantile(host, 0.95), long_task_samples: host.length,
        attributed_long_task_p95: quantile(own, 0.95), attributed_samples: own.length, attribution: own.length ? "observed" : "unknown", load_ms: last.loadMs } };
    },
    dispose() { dead = true; samples.length = 0; last = null; },
  };
}
