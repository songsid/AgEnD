import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handleUsageRequest,
  getUsageSnapshot,
  isUsagePath,
  setUsageFetcherForTests,
  type UsageApiContext,
} from "../src/usage/usage-api.js";
import type { ProviderUsage } from "../src/usage/providers.js";

function fakeCtx(overrides: Partial<UsageApiContext> = {}): UsageApiContext {
  return {
    fleetConfig: { defaults: {}, instances: {} } as unknown as UsageApiContext["fleetConfig"],
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as UsageApiContext["logger"],
    ...overrides,
  };
}

function fakeRes() {
  const out = { code: 0, headers: {} as Record<string, string>, body: "", done: Promise.resolve() };
  let resolve!: () => void;
  out.done = new Promise<void>(r => { resolve = r; });
  const res = {
    writeHead(code: number, headers?: Record<string, string>) { out.code = code; Object.assign(out.headers, headers ?? {}); return res; },
    end(body?: string) { out.body = body ?? ""; resolve(); },
  } as unknown as ServerResponse;
  return { res, out };
}

const fakeReq = (method = "GET") => ({ method } as unknown as IncomingMessage);
const urlFor = (path: string) => new URL(path, "http://localhost:19280");

afterEach(() => setUsageFetcherForTests(null));

describe("isUsagePath", () => {
  it("claims only /api/ai-usage", () => {
    expect(isUsagePath("/api/ai-usage")).toBe(true);
    expect(isUsagePath("/api/ai-usage/extra")).toBe(false);
    expect(isUsagePath("/api/profiles")).toBe(false);
    expect(isUsagePath("/view")).toBe(false);
  });
});

describe("GET /api/ai-usage", () => {
  it("returns the fetched payload and caches it", async () => {
    vi.useFakeTimers();
    let calls = 0;
    setUsageFetcherForTests(async () => {
      calls++;
      return {
        fetchedAt: "2026-01-01T00:00:00.000Z",
        providers: [{ id: "claude", name: "Claude", status: "ok" as const, plan: "Team 5x", metrics: [] }],
      };
    });

    const first = fakeRes();
    expect(handleUsageRequest(fakeReq(), first.res, urlFor("/api/ai-usage"), fakeCtx())).toBe(true);
    await first.out.done;
    expect(first.out.code).toBe(200);
    const body = JSON.parse(first.out.body);
    expect(body.providers[0].plan).toBe("Team 5x");

    // Second request within the TTL is served from cache — the fetcher runs once.
    const second = fakeRes();
    handleUsageRequest(fakeReq(), second.res, urlFor("/api/ai-usage"), fakeCtx());
    await second.out.done;
    expect(second.out.code).toBe(200);
    expect(calls).toBe(1);

    // The first explicit force always bypasses an automatic cached fetch.
    const forced = fakeRes();
    handleUsageRequest(fakeReq(), forced.res, urlFor("/api/ai-usage?force=1"), fakeCtx());
    await forced.out.done;
    expect(calls).toBe(2);

    // Only repeated force requests are floored, preventing refresh spam.
    const floored = fakeRes();
    handleUsageRequest(fakeReq(), floored.res, urlFor("/api/ai-usage?force=1"), fakeCtx());
    await floored.out.done;
    expect(calls).toBe(2);

    vi.advanceTimersByTime(31_000);
    const third = fakeRes();
    handleUsageRequest(fakeReq(), third.res, urlFor("/api/ai-usage?force=1"), fakeCtx());
    await third.out.done;
    expect(calls).toBe(3);
    vi.useRealTimers();
  });

  it("filters the web panel to providers used by running or paused instances", async () => {
    setUsageFetcherForTests(async () => ({
      fetchedAt: "2026-01-01T00:00:00.000Z",
      providers: [
        { id: "claude", name: "Claude", status: "ok" as const, metrics: [] },
        { id: "codex", name: "Codex", status: "ok" as const, metrics: [] },
        { id: "antigravity", name: "Antigravity", status: "ok" as const, metrics: [] },
      ],
    }));
    const { res, out } = fakeRes();
    const ctx = fakeCtx({ getActiveUsageProviderIds: () => new Set(["codex"]) });

    handleUsageRequest(fakeReq(), res, urlFor("/api/ai-usage"), ctx);
    await out.done;

    expect(out.code).toBe(200);
    expect(JSON.parse(out.body).providers.map((provider: { id: string }) => provider.id)).toEqual(["codex"]);
  });

  it("filters unused model-scoped metrics from the shared web/chat/MCP snapshot", async () => {
    const rawMetrics = [
      { label: "Session", type: "percent" as const, used: 0 },
      { label: "Weekly", type: "percent" as const, used: 0 },
      { label: "GPT-5.3-Codex-Spark", scope: "model" as const, type: "percent" as const, used: 0 },
      { label: "Fable (weekly)", scope: "model" as const, type: "percent" as const, used: 17 },
      { label: "Tiny scoped", scope: "model" as const, type: "percent" as const, used: 0.4 },
      { label: "Rate limit resets", type: "count" as const, value: 0 },
      { label: "Credits", type: "count" as const, value: 0 },
    ];
    setUsageFetcherForTests(async () => ({
      fetchedAt: "2026-01-01T00:00:00.000Z",
      providers: [{ id: "codex", name: "Codex", status: "ok" as const, metrics: rawMetrics }],
    }));

    const snapshot = await getUsageSnapshot();
    expect(snapshot.providers[0].metrics.map(metric => metric.label)).toEqual([
      "Session", "Weekly", "Fable (weekly)", "Tiny scoped", "Rate limit resets", "Credits",
    ]);
    // Filtering clones the presentation payload; the cached vendor data remains intact.
    expect(rawMetrics).toHaveLength(7);

    const { res, out } = fakeRes();
    handleUsageRequest(fakeReq(), res, urlFor("/api/ai-usage"), fakeCtx());
    await out.done;
    expect(JSON.parse(out.body).providers[0].metrics.map((metric: { label: string }) => metric.label))
      .toEqual(snapshot.providers[0].metrics.map(metric => metric.label));
  });

  it("keeps last-good Kiro data during rollover and refreshes after 30 seconds", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      setUsageFetcherForTests(async () => {
        calls++;
        if (calls === 2) {
          return {
            fetchedAt: "2026-01-01T00:00:01.000Z",
            providers: [{
              id: "kiro", name: "Kiro", status: "ok" as const, plan: "Kiro",
              hint: "Token refreshing — try again in a moment.", metrics: [],
            }],
          };
        }
        return {
          fetchedAt: "2026-01-01T00:00:00.000Z",
          providers: [{
            id: "kiro", name: "Kiro", status: "ok" as const, plan: "Kiro Free",
            metrics: [{ label: "Credits", type: "percent" as const, used: calls === 1 ? 10 : 11 }],
          }],
        };
      });

      const good = await getUsageSnapshot();
      expect(good.providers[0].metrics[0].used).toBe(10);

      const rollover = await getUsageSnapshot(true);
      expect(rollover.providers[0].metrics[0].used).toBe(10);
      expect(rollover.providers[0].hint).toContain("Token refreshing");

      vi.advanceTimersByTime(30_001);
      const refreshed = await getUsageSnapshot();
      expect(calls).toBe(3);
      expect(refreshed.providers[0].metrics[0].used).toBe(11);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores paths that are not ours", () => {
    const { res } = fakeRes();
    expect(handleUsageRequest(fakeReq(), res, urlFor("/api/profiles"), fakeCtx())).toBe(false);
  });

  it("rejects non-GET methods", async () => {
    const { res, out } = fakeRes();
    expect(handleUsageRequest(fakeReq("POST"), res, urlFor("/api/ai-usage"), fakeCtx())).toBe(true);
    await out.done;
    expect(out.code).toBe(405);
  });

  it("returns 404 when web.usage_panel is false", async () => {
    const ctx = fakeCtx({
      fleetConfig: { defaults: {}, instances: {}, web: { usage_panel: false } } as unknown as UsageApiContext["fleetConfig"],
    });
    const { res, out } = fakeRes();
    expect(handleUsageRequest(fakeReq(), res, urlFor("/api/ai-usage"), ctx)).toBe(true);
    await out.done;
    expect(out.code).toBe(404);
  });

  it("reports fetcher failures as 500 with an error body", async () => {
    setUsageFetcherForTests(async () => { throw new Error("boom"); });
    const { res, out } = fakeRes();
    handleUsageRequest(fakeReq(), res, urlFor("/api/ai-usage"), fakeCtx());
    await out.done;
    expect(out.code).toBe(500);
    expect(JSON.parse(out.body).error).toContain("boom");
  });
});

describe("stale fallback for transient fetch failures", () => {
  const okRow = (used: number) => ({
    id: "codex", name: "Codex", status: "ok" as const,
    metrics: [{ label: "Weekly", type: "percent" as const, used }],
  });
  const errRow = (error: string) => ({
    id: "codex", name: "Codex", status: "error" as const, error, metrics: [] as never[],
  });
  const payloadWith = (row: ReturnType<typeof okRow> | ReturnType<typeof errRow>) => ({
    fetchedAt: new Date().toISOString(), providers: [row],
  });

  // One stub fetcher whose payload flips mid-test: re-setting the fetcher
  // would clear lastGood (by design), so expiry past the 5-minute snapshot
  // TTL is what forces the refetch while keeping memory.
  async function fetchAfterJitter(makeError: () => string): Promise<ProviderUsage> {
    let failed = false;
    setUsageFetcherForTests(async () => payloadWith(failed ? errRow(makeError()) : okRow(12)));
    vi.useFakeTimers();
    try {
      const seeded = await getUsageSnapshot();
      expect(seeded.providers[0].status).toBe("ok");
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      failed = true;
      const snap = await getUsageSnapshot();
      return snap.providers[0];
    } finally {
      vi.useRealTimers();
    }
  }

  it.each([
    "Could not reach Codex.",
    "The operation was aborted due to timeout",
    "read ECONNRESET",
    "vendor responded 503",
  ])("softens a jitter (%s) with cached numbers", async error => {
    const row = await fetchAfterJitter(() => error);

    expect(row.status, "a jitter shows old numbers, not red").toBe("ok");
    expect(row.metrics[0]).toMatchObject({ used: 12 });
    expect(row.hint).toMatch(/^cached \d+m ago/);
  });

  it("keeps auth failures loud even with last good numbers", async () => {
    const row = await fetchAfterJitter(() => "Invalid API key (401)");

    expect(row.status).toBe("error");
    expect(row.error).toBe("Invalid API key (401)");
    expect(row.hint).toBeUndefined();
  });

  it("keeps schema errors loud even with last good numbers", async () => {
    const row = await fetchAfterJitter(() => "Invalid response from usage endpoint.");

    expect(row.status).toBe("error");
    expect(row.hint).toBeUndefined();
  });

  it("stays loud when nothing good was ever fetched", async () => {
    // Fresh process (e.g. right after a restart): no last-good to fall back
    // to, so even a transient failure must stay visible, not vanish.
    setUsageFetcherForTests(async () => payloadWith(errRow("Could not reach Codex.")));
    const snap = await getUsageSnapshot();

    const row = snap.providers[0];
    expect(row.status).toBe("error");
    expect(row.error).toBe("Could not reach Codex.");
  });
});
