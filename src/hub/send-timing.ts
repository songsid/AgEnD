/** Opt-in mount-local diagnostics. Labels and durations only; never request metadata. */
export type HubSendPhase = "submit" | "relay" | "authorize.resolve" | "authorize.admit" | "authorize.begin"
  | "authorize.tool" | "authorize.release-answer" | "answer" | "sse.project" | "authorize.asker-directory" | "authorize.owner-directory" | "authorize.grant" | "relay.sign" | "audit" | "receipt" | "agent.state";
const PHASES = new Set<HubSendPhase>(["submit", "relay", "authorize.resolve", "authorize.admit", "authorize.begin",
  "authorize.tool", "authorize.release-answer", "answer", "sse.project", "authorize.asker-directory", "authorize.owner-directory", "authorize.grant", "relay.sign", "audit", "receipt", "agent.state"]);
export interface HubSendTiming { start(phase: HubSendPhase): () => void }
export function createHubSendTiming(
  log: ((level: "info" | "warn", message: string, meta?: Record<string, unknown>) => void) | undefined,
  enabled = process.env.AGEND_HUB_SEND_TIMING === "1",
  now: () => number = () => performance.now(),
  cpuClock?: () => number,
): HubSendTiming | undefined {
  if (!enabled || !log) return undefined;
  const threadCpuUsage = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;
  const cpuNow = cpuClock ?? (typeof threadCpuUsage === "function" ? () => {
    const cpu = threadCpuUsage.call(process); return (cpu.user + cpu.system) / 1000;
  } : undefined);
  return { start(phase) {
    if (!PHASES.has(phase)) return () => {};
    let began: number, cpuBegan: number | undefined;
    try { began = now(); cpuBegan = cpuNow?.(); } catch { return () => {}; }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      try {
        const durationMs = now() - began, cpuMs = cpuBegan === undefined ? NaN : cpuNow!() - cpuBegan;
        if (!Number.isFinite(durationMs) || durationMs < 0) return;
        // Async intervals overlap: this is CPU used by the thread during the interval, not exclusive phase CPU.
        log("info", "Hub send phase timing", { phase, durationMs: Math.round(durationMs * 1000) / 1000,
          ...(Number.isFinite(cpuMs) && cpuMs >= 0 ? { threadCpuIntervalMs: Math.round(cpuMs * 1000) / 1000 } : {}) });
      }
      catch { /* Diagnostics cannot change delivery, authority or the response. */ }
    };
  } };
}
