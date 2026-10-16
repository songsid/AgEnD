/** #1629: host cadence before ANY effect frame; never learns a baseline from an active effect. */
const finite = n => typeof n === "number" && Number.isFinite(n);
export function captureEffectBaseline({ window: host, empty, clock = () => host.performance.now() } = {}) {
  let finish, settled = false, raf = null, timer = null, last = null, first = null, count = 0;
  const promise = new Promise(resolve => { finish = resolve; });
  const end = value => {
    if (settled) return;
    settled = true;
    if (raf !== null) host.cancelAnimationFrame(raf);
    if (timer !== null) host.clearTimeout(timer);
    host.document.removeEventListener("visibilitychange", visibility);
    finish(value);
  };
  const fail = reason => end({ ok: false, reason });
  const gates = () => {
    try { return host.document.visibilityState === "visible" && empty() === true; } catch { return false; }
  };
  const time = () => {
    let now; try { now = clock(); } catch { return null; }
    if (!finite(now) || now < 0 || last !== null && now < last) return null;
    last = now; return now;
  };
  const visibility = () => { if (!gates()) fail("baseline_unavailable"); };
  const step = () => {
    if (settled) return;
    raf = null;
    if (!gates()) { fail("baseline_unavailable"); return; }
    const now = time();
    if (now === null) { fail("clock_unavailable"); return; }
    if (now - began >= 10000) { fail("baseline_timeout"); return; }
    if (first === null) { first = now; count = 1; }
    else if (now > sample) count++;
    sample = now;
    if (now - first >= 2000) {
      const fps = (count - 1) * 1000 / (now - first);
      if (!finite(fps) || fps <= 0 || fps > 1000 || !gates()) fail("baseline_unavailable");
      else end({ ok: true, baselineFps: fps });
      return;
    }
    raf = host.requestAnimationFrame(step);
  };
  let began = null, sample = null;
  if (!host || !host.document || typeof empty !== "function" || typeof clock !== "function" || ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"].some(k => typeof host[k] !== "function") || typeof host.document.addEventListener !== "function" || typeof host.document.removeEventListener !== "function") {
    settled = true; finish({ ok: false, reason: "baseline_unsupported" });
    return { promise, cancel() {} };
  }
  began = time();
  if (began === null) fail("clock_unavailable");
  else if (!gates()) fail("baseline_unavailable");
  else {
    host.document.addEventListener("visibilitychange", visibility);
    const deadline = () => {
      if (settled) return;
      if (!gates()) { fail("baseline_unavailable"); return; }
      const now = time();
      if (now === null) fail("clock_unavailable");
      else if (now - began >= 10000) fail("baseline_timeout");
      else timer = host.setTimeout(deadline, Math.max(1, 10000 - (now - began)));
    };
    timer = host.setTimeout(deadline, 10000);
    raf = host.requestAnimationFrame(step);
  }
  return { promise, cancel() { fail("baseline_cancelled"); } };
}
