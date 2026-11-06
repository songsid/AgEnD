import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createQuotaPublisher, HUB_QUOTA_INTERVAL_MS, quotaBand } from "../src/hub/member/quota.js";
import { parseMemberFrame } from "../src/hub/protocol.js";
import type { HubMemberLink } from "../src/hub/client.js";
import type { HubMemberFrame, HubQuota } from "../src/hub/types.js";
import type { ProviderUsage } from "../src/usage/providers.js";

const NOW = Date.parse("2026-11-06T10:00:00Z");
const provider = (used: number, extra: Partial<ProviderUsage> = {}): ProviderUsage => ({ id: "codex:agent-profile", name: "private account", status: "ok",
  metrics: [{ type: "percent", label: "5h", used, resetsAt: "2026-11-06T12:13:29Z" }], ...extra });
const publishers: ReturnType<typeof createQuotaPublisher>[] = [];
afterEach(() => { publishers.splice(0).forEach(p => p.stop()); });

describe("the member derives only coarse quota", () => {
  it.each([[0, "available"], [79.999, "available"], [80, "near_limit"], [99.999, "near_limit"], [100, "exhausted"], [125, "exhausted"]] as const)("maps %s to %s", (used, band) => {
    expect(quotaBand(provider(used), false, NOW).band).toBe(band);
  });
  it("uses any window, chooses the nearest genuine reset and rounds to five minutes", () => {
    const p = provider(10);
    p.metrics.push({ type: "percent", label: "weekly", used: 100, resetsAt: "2026-11-08T10:00:00Z" },
      { type: "percent", label: "bonus", used: 100, resetsAt: "2026-11-06T10:20:00Z", resetKind: "expiry" });
    expect(quotaBand(p, false, NOW)).toEqual({ band: "exhausted", resetsAt: Date.parse("2026-11-06T12:15:00Z") });
    p.metrics[0]!.resetsAt = "2026-11-06T12:12:29Z";
    expect(quotaBand(p, false, NOW).resetsAt).toBe(Date.parse("2026-11-06T12:10:00Z"));
    p.metrics[1]!.used = 80; p.metrics.pop();
    expect(quotaBand(p, false, NOW)).toEqual({ band: "near_limit" });
  });
  it("does not claim capacity from stale, invalid or reset windows, or an unreadable provider", () => {
    expect(quotaBand(undefined, false, NOW)).toEqual({ band: "unknown" });
    expect(quotaBand(provider(2, { status: "error" }), false, NOW)).toEqual({ band: "unknown" });
    expect(quotaBand(provider(2, { stale: true }), false, NOW)).toEqual({ band: "unknown" });
    for (const metric of [{ used: NaN }, { used: -1 }, { used: 0, resetPassed: true as const }, { used: 100, resetsAt: "2026-11-05T12:00:00Z" }]) {
      expect(quotaBand(provider(0, { metrics: [{ type: "percent", label: "window", ...metric }] }), false, NOW)).toEqual({ band: "unknown" });
    }
    expect(quotaBand(provider(0, { metrics: [], unlimited: true }), false, NOW)).toEqual({ band: "available" });
  });
  it("quota pause wins over available or missing usage without inventing a reset", () => {
    expect(quotaBand(provider(5), true, NOW)).toEqual({ band: "exhausted", resetsAt: Date.parse("2026-11-06T12:15:00Z") });
    expect(quotaBand(undefined, true, NOW)).toEqual({ band: "exhausted" });
  });
  it("strict wire schema refuses percentages, account identifiers and precise or irrelevant reset times", () => {
    const wire = (quota: unknown) => JSON.stringify({ v: 1, type: "exposure.quota", requestId: randomUUID(), linkEpoch: 1,
      payload: { exposureId: randomUUID(), quota } });
    expect(parseMemberFrame(wire({ band: "near_limit" })).type).toBe("exposure.quota");
    for (const quota of [{ band: "near_limit", percent: 81 }, { band: "exhausted", profile: "private" }, { band: "exhausted", resetsAt: NOW + 1 },
      { band: "available", resetsAt: NOW }, { band: "exhausted", resetsAt: "12:15" }, { band: "other" }]) expect(() => parseMemberFrame(wire(quota))).toThrow();
  });
});

describe("quota updates are negotiated, coalesced and change-only", () => {
  function setup(features = ["welcome-caps-v1", "quota-band-v1"]) {
    let now = NOW, alive = true, entries = [{ exposureId: randomUUID(), agent: "representative" }];
    let quota: HubQuota = { band: "available" };
    const frames: HubMemberFrame[] = [], read = vi.fn(async () => quota);
    const link = { features: new Set(features), linkEpoch: 1, current: () => alive,
      send: async (f: HubMemberFrame) => { frames.push(f); } } as unknown as HubMemberLink;
    const p = createQuotaPublisher({ exposures: () => entries, read, now: () => now }); publishers.push(p);
    return { p, link, frames, read, change: (q: HubQuota) => { quota = q; }, advance: () => { now += HUB_QUOTA_INTERVAL_MS; },
      withdraw: () => { entries = []; }, retire: () => { alive = false; } };
  }
  it("sends a baseline, only a changed band after the rate limit, never same-band reset changes", async () => {
    const w = setup(); w.p.start(w.link); await w.p.refresh();
    expect(w.frames).toHaveLength(1);
    w.change({ band: "near_limit" }); await w.p.refresh(); expect(w.frames).toHaveLength(1);
    w.advance(); await w.p.refresh(); expect(w.frames).toHaveLength(2);
    w.change({ band: "exhausted", resetsAt: NOW + 300_000 }); w.advance(); await w.p.refresh(); expect(w.frames).toHaveLength(3);
    w.change({ band: "exhausted", resetsAt: NOW + 600_000 }); w.advance(); await w.p.refresh(); expect(w.frames).toHaveLength(3);
    expect(JSON.stringify(w.frames)).not.toMatch(/percent|profile|private account|used/);
    w.p.stop(); w.p.start({ ...w.link, linkEpoch: 2 }); await w.p.refresh(); expect(w.frames).toHaveLength(4);
  });
  it("does no reading or sending when the old peer did not negotiate the feature", async () => {
    const w = setup([]); w.p.start(w.link); await w.p.refresh();
    expect(w.read).not.toHaveBeenCalled(); expect(w.frames).toEqual([]);
  });
  it("coalesces concurrent refreshes and fences a withdrawal or retired link across the read", async () => {
    for (const action of ["withdraw", "retire"] as const) {
      const w = setup(); let release!: (q: HubQuota) => void;
      w.read.mockImplementation(() => new Promise(resolve => { release = resolve; }));
      w.p.start(w.link); const a = w.p.refresh(), b = w.p.refresh();
      expect(a).toBe(b); expect(w.read).toHaveBeenCalledTimes(1);
      w[action](); release({ band: "near_limit" }); await a;
      expect(w.frames).toEqual([]);
    }
  });
  it("publishes unknown after provider failure and stops reading after teardown", async () => {
    const w = setup(); w.read.mockRejectedValueOnce(new Error("private token path"));
    w.p.start(w.link); await w.p.refresh();
    expect(w.frames[0]).toMatchObject({ payload: { quota: { band: "unknown" } } });
    w.p.stop(); w.advance(); await w.p.refresh(); expect(w.read).toHaveBeenCalledTimes(1);
  });
});
