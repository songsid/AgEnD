/** The member's only quota export. Uses the fleet's cached usage provider, never an independent vendor poll. */
import { randomUUID } from "node:crypto";
import type { ProviderUsage } from "../../usage/providers.js";
import type { HubQuota } from "../types.js";
import type { HubMemberLink } from "../client.js";

export const HUB_QUOTA_INTERVAL_MS = 30_000;
export const HUB_QUOTA_CAPABILITY = "quota-band-v1";
const ROUND_MS = 5 * 60_000;

/** Never trusts last-good fallback as current capacity. A known quota pause wins even when usage cannot be read. */
export function quotaBand(provider: ProviderUsage | undefined, paused = false, now = Date.now()): HubQuota {
  const usable = provider?.status === "ok" && !provider.stale;
  const windows = usable ? provider.metrics.filter(m => m.type === "percent" && m.resetKind !== "expiry" && !m.resetPassed
    && typeof m.used === "number" && Number.isFinite(m.used) && m.used >= 0
    && !(m.resetsAt && Date.parse(m.resetsAt) <= now)) : [];
  if (paused || windows.some(m => m.used! >= 100)) {
    const resets = windows.filter(m => m.resetKind !== "expiry").map(m => Date.parse(m.resetsAt ?? ""))
      .filter(n => Number.isFinite(n) && n > now && n <= 8.64e15);
    return { band: "exhausted", ...(resets.length ? { resetsAt: Math.round(Math.min(...resets) / ROUND_MS) * ROUND_MS } : {}) };
  }
  if (!usable) return { band: "unknown" };
  if (provider.unlimited) return { band: "available" };
  if (!windows.length) return { band: "unknown" };
  return { band: windows.some(m => m.used! >= 80) ? "near_limit" : "available" };
}

/** One bounded, coalesced pass per interval; repeated readings in a band send nothing. A new link gets a baseline. */
export function createQuotaPublisher(deps: {
  exposures(): readonly { exposureId: string; agent: string }[];
  read(agent: string): Promise<HubQuota>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let link: HubMemberLink | null = null, running: Promise<void> | null = null;
  let lastRead = -Infinity;
  const sent = new Map<string, HubQuota["band"]>();
  let timer: NodeJS.Timeout | null = null;
  async function pass(captured: HubMemberLink): Promise<void> {
    if (link !== captured || !captured.current() || !captured.features?.has(HUB_QUOTA_CAPABILITY)) return;
    const at = now();
    if (at >= lastRead && at - lastRead < HUB_QUOTA_INTERVAL_MS) return;
    lastRead = at;
    const entries = deps.exposures();
    const ids = new Set(entries.map(e => e.exposureId));
    for (const id of sent.keys()) if (!ids.has(id)) sent.delete(id);
    for (const entry of entries) {
      let quota: HubQuota;
      try { quota = await deps.read(entry.agent); } catch { quota = { band: "unknown" }; }
      if (link !== captured || !captured.current()) return;
      // A withdrawal during the provider await must never export that agent's reading.
      if (!deps.exposures().some(e => e.exposureId === entry.exposureId && e.agent === entry.agent)) continue;
      if (sent.get(entry.exposureId) === quota.band) continue;
      await captured.send({ v: 1, type: "exposure.quota", requestId: randomUUID(), linkEpoch: captured.linkEpoch,
        payload: { exposureId: entry.exposureId, quota } });
      if (link !== captured || !captured.current()) return;
      sent.set(entry.exposureId, quota.band);
    }
  }
  function refresh(): Promise<void> {
    if (running) return running;
    if (!link) return Promise.resolve();
    const work = pass(link);
    running = work;
    void work.finally(() => { if (running === work) running = null; }).catch(() => {});
    return work;
  }
  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null; link = null; sent.clear(); lastRead = -Infinity;
  }
  return {
    refresh,
    start(l: HubMemberLink): void {
      stop(); link = l;
      // Queue after the reconciliation response, so the server has marked the link ready.
      timer = setInterval(() => { void refresh().catch(() => {}); }, HUB_QUOTA_INTERVAL_MS);
      timer.unref?.();
      void refresh().catch(() => {});
    },
    stop,
  };
}
