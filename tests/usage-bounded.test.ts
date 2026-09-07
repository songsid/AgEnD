import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchAllUsage, setUsageProviderDeadlineForTests, setUsageProvidersForTests,
  DEFAULT_PROVIDER_DEADLINE_MS, LONGEST_SINGLE_FETCH_MS } from "../src/usage/providers.js";
import { getUsageSnapshot, setUsageFetcherForTests } from "../src/usage/usage-api.js";

/**
 * Every individual usage fetch already had an AbortSignal timeout, but a
 * provider's *chain* of them was unbounded (grok: refresh → query → re-refresh →
 * re-query; antigravity: refresh then each Cloud Code base). fetchAllUsage waits
 * for the slowest provider, and usage-api shares one in-flight promise across
 * /api/ai-usage, the /usage command and the get_usage tool — so one slow vendor
 * stalled all three at once, and a provider that never settled stalled them for
 * good, because the in-flight promise was only cleared in `finally`.
 */
describe("usage collection is bounded and fails soft", () => {
  afterEach(() => {
    setUsageProviderDeadlineForTests(null);
    setUsageProvidersForTests(null);
    setUsageFetcherForTests(null);
    vi.useRealTimers();
  });

  it("returns within the deadline even when a provider never settles", async () => {
    setUsageProviderDeadlineForTests(150);
    const started = Date.now();
    const snapshot = await fetchAllUsage();
    const elapsed = Date.now() - started;
    // Real providers here have no credentials on a test machine and answer
    // immediately; the point is that the call is bounded regardless.
    expect(elapsed).toBeLessThan(5_000);
    expect(snapshot.fetchedAt).toBeTruthy();
  });

  it("a hanging provider yields an unreachable row while the others still answer", async () => {
    setUsageProviderDeadlineForTests(120);
    let hangEntered = false;
    setUsageProvidersForTests([
      { id: "slowvendor", name: "SlowVendor", fetch: async () => {
        hangEntered = true;
        await new Promise(() => { /* never settles, like an unbounded vendor chain */ });
        return { status: "ok", metrics: [] } as any;
      } },
      { id: "fastvendor", name: "FastVendor", fetch: async () => ({
        status: "ok", metrics: [{ label: "Session", type: "percent", used: 12 }],
      } as any) },
    ]);

    const started = Date.now();
    const snapshot = await fetchAllUsage();
    const elapsed = Date.now() - started;

    expect(hangEntered, "the hanging provider really was entered").toBe(true);
    expect(elapsed, "the deadline bounds the snapshot").toBeLessThan(2_000);
    expect(elapsed, "and it did wait for the deadline rather than skipping").toBeGreaterThanOrEqual(100);

    const slow = snapshot.providers.find(p => p.id === "slowvendor");
    const fast = snapshot.providers.find(p => p.id === "fastvendor");
    expect(slow?.status, "the hanging row fails soft").toBe("error");
    expect(slow?.error).toContain("Could not reach SlowVendor");
    expect(fast?.status, "the other provider still answers").toBe("ok");
    expect(fast?.metrics.length, "and keeps its numbers").toBe(1);
  });

  it("deadlines run concurrently, so the bound does not accumulate per provider", async () => {
    // Promise.all creates every provider promise eagerly, so five hanging
    // providers cost one deadline, not five.
    setUsageProviderDeadlineForTests(200);
    setUsageProvidersForTests(["a", "b", "c", "d", "e"].map(id => ({
      id, name: id.toUpperCase(),
      fetch: async () => { await new Promise(() => {}); return { status: "ok", metrics: [] } as any; },
    })));

    const started = Date.now();
    const snapshot = await fetchAllUsage();
    const elapsed = Date.now() - started;

    expect(snapshot.providers).toHaveLength(5);
    expect(snapshot.providers.every(p => p.status === "error"), "all five fail soft").toBe(true);
    // Serial accumulation would be ~1000ms; concurrent is ~200ms.
    expect(elapsed, `expected ~200ms concurrent, not ~1000ms serial (was ${elapsed}ms)`).toBeLessThan(600);
  });

  it("the default deadline sits above the longest legitimate single operation", async () => {
    // A token refresh carries a 15s AbortSignal timeout. A deadline tighter
    // than that would report a slow-but-healthy refresh as unreachable — a
    // manufactured failure rather than a protection. Asserted as a relationship
    // so tuning either number keeps them consistent.
    expect(DEFAULT_PROVIDER_DEADLINE_MS).toBeGreaterThan(LONGEST_SINGLE_FETCH_MS);
  });

  it("keeps a provider that resolves inside the inner timeout, errors one past the deadline", async () => {
    // The behavioural half of the constants guard above, on fake timers so it
    // costs no wall-clock time: 15s is inside a legitimate token refresh and
    // must survive; a chain that runs past the deadline must fail soft.
    vi.useFakeTimers();
    setUsageProviderDeadlineForTests(null);          // the shipped 16s default
    setUsageProvidersForTests([
      { id: "slow", name: "Slow", fetch: async () => {
        await new Promise(r => setTimeout(r, 15_000));
        return { status: "ok", metrics: [{ label: "Session", type: "percent", used: 7 }] } as any;
      } },
      { id: "hung", name: "Hung", fetch: async () => {
        await new Promise(r => setTimeout(r, 60_000));
        return { status: "ok", metrics: [] } as any;
      } },
    ]);

    const pending = fetchAllUsage();
    await vi.advanceTimersByTimeAsync(16_500);
    const snapshot = await pending;

    const slow = snapshot.providers.find(p => p.id === "slow");
    const hung = snapshot.providers.find(p => p.id === "hung");
    expect(slow?.status, "a 15s success is inside the budget and must be kept").toBe("ok");
    expect(slow?.metrics.length, "and keeps its numbers").toBe(1);
    expect(hung?.status, "a chain past the deadline fails soft").toBe("error");
    expect(hung?.error).toContain("Could not reach Hung");
  });

  it("a provider that rejects does not take the snapshot down", async () => {
    setUsageProvidersForTests([
      { id: "boom", name: "Boom", fetch: async () => { throw new Error("vendor exploded"); } },
      { id: "ok", name: "Ok", fetch: async () => ({ status: "ok", metrics: [] } as any) },
    ]);
    const snapshot = await fetchAllUsage();
    expect(snapshot.providers.find(p => p.id === "boom")?.error).toContain("vendor exploded");
    expect(snapshot.providers.find(p => p.id === "ok")?.status).toBe("ok");
  });

  it("all three surfaces share one snapshot, so one bounded fetch serves them", async () => {
    let calls = 0;
    setUsageFetcherForTests(async () => {
      calls++;
      return { fetchedAt: new Date().toISOString(), providers: [] };
    });
    await Promise.all([getUsageSnapshot(), getUsageSnapshot(), getUsageSnapshot()]);
    expect(calls, "in-flight dedup still collapses concurrent callers").toBe(1);
  });

  it("a rejected collection clears the in-flight promise so the next call retries", async () => {
    let calls = 0;
    setUsageFetcherForTests(async () => {
      calls++;
      throw new Error("vendor exploded");
    });
    await expect(getUsageSnapshot(true)).rejects.toThrow("vendor exploded");
    await expect(getUsageSnapshot(true)).rejects.toThrow("vendor exploded");
    expect(calls, "a stuck in-flight promise would have made this 1").toBe(2);
  });
});
