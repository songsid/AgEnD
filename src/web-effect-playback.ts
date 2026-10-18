/** #2115: untrusted, volatile playback observations. Never a safety/admission input or measured profile. */
export const EFFECT_BLOCK_REASONS = Object.freeze([
  "preview_unavailable", "preview_not_consented", "unsupported_host", "safe_mode", "reduced_motion", "save_data", "hidden", "disabled", "public_link",
  "baseline_unsupported", "baseline_unavailable", "baseline_timeout", "calibrating", "clock_unavailable", "gates_unknown", "owner_css", "stock_overlay", "modal",
  "safety_off", "safety_unknown", "interrupted", "paused", "host_budget", "frame_limit", "front_limit", "offscreen", "region_unavailable", "resource_unavailable", "resource_timeout", "runtime_unavailable", "unknown",
] as const);
export type EffectBlockReason = typeof EFFECT_BLOCK_REASONS[number];
type Observation = { v: 1; kind: "playback"; device: "standard" | "constrained"; status: "blocked" | "playing"; reason: EffectBlockReason | null };
export function checkPlaybackObservation(value: unknown): Observation | null {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const ds = Object.getOwnPropertyDescriptors(value), keys = ["v", "kind", "device", "status", "reason"];
  if (Reflect.ownKeys(ds).length !== keys.length || keys.some(k => !ds[k]?.enumerable || !("value" in ds[k]!))) return null;
  const v = Object.fromEntries(keys.map(k => [k, ds[k]!.value]));
  if (v.v !== 1 || v.kind !== "playback" || !["standard", "constrained"].includes(v.device)) return null;
  if (v.status === "playing" ? v.reason !== null : v.status !== "blocked" || !EFFECT_BLOCK_REASONS.includes(v.reason)) return null;
  return Object.freeze(v as Observation);
}
export class WebEffectPlayback {
  private readonly rows = new Map<string, { instance: string; id: string; at: number; reason: EffectBlockReason | null }>();
  private previous: number | null = null;
  private broken = false;
  constructor(private readonly clock: () => number = () => performance.now()) {}
  private now(): number | null {
    if (this.broken) return null;
    let n: number; try { n = this.clock(); } catch { this.broken = true; return null; }
    if (!Number.isFinite(n) || n < 0 || this.previous !== null && n < this.previous) { this.broken = true; this.rows.clear(); return null; }
    this.previous = n;
    for (const [key, row] of this.rows) if (n - row.at >= 300_000) this.rows.delete(key);
    return n;
  }
  record(reporter: string, instance: string, id: string, value: unknown): { ok: true } | { error: string } {
    const observation = checkPlaybackObservation(value);
    if (!observation || !/^[a-f0-9]{64}$/.test(reporter)) return { error: "playback_report" };
    const now = this.now(); if (now === null) return { error: "profile_clock" };
    const key = JSON.stringify([reporter, instance, id]), old = this.rows.get(key);
    if (old && now - old.at < 10_000 || !old && this.rows.size >= 1024) return { error: "profile_rate_limited" };
    this.rows.set(key, { instance, id, at: now, reason: observation.reason });
    return { ok: true };
  }
  /** Current placement IDs are supplied by the host; never export identifiers, counts, times or device classes. */
  summary(instance: string, id: string): { status: "reported_blocked" | "unknown"; reasons: EffectBlockReason[] } {
    if (this.now() === null) return { status: "unknown", reasons: [] };
    const reasons = EFFECT_BLOCK_REASONS.filter(reason => [...this.rows.values()].some(r => r.instance === instance && r.id === id && r.reason === reason));
    return { status: reasons.length ? "reported_blocked" : "unknown", reasons };
  }
}
