import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { getUsageSnapshot, setUsageFetcherForTests, formatUsageSummary, type UsagePayload } from "../src/usage/usage-api.js";
import { renderUsageMarkdown } from "../src/usage/format-rich.js";

/**
 * The user's panel showed 🔴 "Rate limited by Anthropic" where numbers stood
 * minutes earlier. A vendor 429 on OUR usage query says nothing about the
 * subscription — and the Anthropic endpoint is shared with every claude-code
 * CLI on the account, which polls it for its own statusline, so 429s there are
 * a fact of life rather than a fault.
 */

const OK: UsagePayload = {
  fetchedAt: "2026-08-02T12:00:00Z",
  providers: [{
    id: "claude", name: "Claude", status: "ok", plan: "Team 5x",
    metrics: [{ label: "Weekly", type: "percent", used: 15 }],
  }],
};

const RATE_LIMITED: UsagePayload = {
  fetchedAt: "2026-08-02T12:05:00Z",
  providers: [{
    id: "claude", name: "Claude", status: "error",
    error: "Rate limited by Anthropic — try again later.", metrics: [],
  }],
};

const AUTH_FAILED: UsagePayload = {
  fetchedAt: "2026-08-02T12:05:00Z",
  providers: [{
    id: "claude", name: "Claude", status: "error",
    error: "Token rejected. Run `claude` once to refresh the login.", metrics: [],
  }],
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  setUsageFetcherForTests(null);
  vi.useRealTimers();
});

/** A second force only fetches once the 30s floor has passed. */
async function forceAfterFloor(): ReturnType<typeof getUsageSnapshot> {
  vi.advanceTimersByTime(31_000);
  return getUsageSnapshot(true);
}

describe("stale-while-rate-limited", () => {
  it("serves the last good numbers, labelled with their age, with yellow/neutral dot", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce(RATE_LIMITED);
    setUsageFetcherForTests(fetcher);

    await getUsageSnapshot();            // caches the good row
    const result = await forceAfterFloor(); // rate-limited fetch

    const claude = result.providers[0];
    expect(claude.status).toBe("ok");                 // numbers, not a red row
    expect(claude.metrics[0].used).toBe(15);          // the last good values
    expect(claude.stale).toBe(true);                  // stale flag set
    expect(claude.hint).toMatch(/cached \d+m ago/);   // honest about age
    expect(claude.hintI18n?.key).toBe("usage.stale_rate_limited"); // i18n key
    // format-rich must show 🟡 (not 🔴 even if stale metrics are ≥90%)
    const { renderUsageMarkdown } = await import("../src/usage/format-rich.js");
    const md = renderUsageMarkdown(result);
    expect(md).toContain("🟡");
    expect(md).not.toContain("🔴");
  });

  it("keeps a genuine auth error loud — stale data must not hide it", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce(AUTH_FAILED);
    setUsageFetcherForTests(fetcher);

    await getUsageSnapshot();
    const result = await forceAfterFloor();

    expect(result.providers[0].status).toBe("error");
    expect(result.providers[0].error).toContain("Token rejected");
  });

  it("shows a gentler error when there is nothing good to fall back on (no-data 429)", async () => {
    // Reverse mutation: removing the errorI18n swap for 429-without-stale makes
    // this test fail because the alarming "usage.error.rate_limited" key is used.
    setUsageFetcherForTests(vi.fn().mockResolvedValue(RATE_LIMITED));
    const result = await getUsageSnapshot();
    const claude = result.providers[0];
    expect(claude.status).toBe("error");
    // errorI18n must use the "transient" key — not the alarming rate_limited key
    expect(claude.errorI18n?.key).toBe("usage.error.rate_limited_transient");
    // The format must not show a red alarm — it still says "error" so formatters
    // can choose a gentler style, but the EN message is the gentler one
    const plain = formatUsageSummary(result);
    expect(plain).not.toContain("try again later");
    expect(plain).toContain("Claude");
  });

  it("renders the staleness under the metrics, not instead of them", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce(RATE_LIMITED);
    setUsageFetcherForTests(fetcher);
    await getUsageSnapshot();
    const result = await forceAfterFloor();

    const md = renderUsageMarkdown(result);
    expect(md).toContain("15% Weekly");
    expect(md).toMatch(/> data from \d+ min ago/);  // hintI18n renders the i18n string
    const plain = formatUsageSummary(result);
    expect(plain).toContain("Weekly 15%");
    expect(plain).toMatch(/data from \d+ min ago/);
  });
});

describe("force floor", () => {
  it("turns a rapid second force into a cached read", async () => {
    const fetcher = vi.fn().mockResolvedValue(OK);
    setUsageFetcherForTests(fetcher);

    await getUsageSnapshot(true);
    await getUsageSnapshot(true); // within the 30s floor
    await getUsageSnapshot(true);

    // Refresh-button spam must not become API-call spam.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

const RATE_LIMITED_WITH_RETRY_AFTER: UsagePayload = {
  fetchedAt: "2026-08-02T12:05:00Z",
  providers: [{
    id: "claude", name: "Claude", status: "error",
    error: "Rate limited by Anthropic — try again later.",
    hint: "retry-after:120",   // 2-minute Retry-After header
    metrics: [],
  }],
};

describe("Retry-After backoff", () => {
  // Reverse mutation: removing the maxRetryAfterMs cache extension makes
  // this test fail because the cache TTL stays at 5 minutes, not 2 minutes
  // (but we can't distinguish 5m from 2m easily). The stronger test: without
  // the backoff, the fetcher is called a second time within the Retry-After
  // window when force=true is used.

  it("extends cache TTL to Retry-After window; repeated force within window uses cache", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce(RATE_LIMITED_WITH_RETRY_AFTER);
    setUsageFetcherForTests(fetcher);

    await getUsageSnapshot();          // caches good row
    vi.advanceTimersByTime(31_000);    // past force floor
    await getUsageSnapshot(true);      // gets 429 with retry-after:120
    // Within 2-minute Retry-After, force refresh should NOT call fetcher again
    vi.advanceTimersByTime(60_000);    // 60s later, still within 2m window
    vi.advanceTimersByTime(31_000);    // past force floor again
    await getUsageSnapshot(true);      // should serve cache

    // fetcher called only twice (initial OK + 429), not a third time
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("Retry-After cap: 86400 does not lock /usage for a day", () => {
  // Reverse mutation: removing the `Math.min(..., RETRY_AFTER_MAX_MS)` cap in
  // withStaleFallback makes this test fail because the 86400-second backoff
  // keeps the force-refresh blocked well past the 15-minute cap.

  it("force refresh fires again after 15 min even with retry-after:86400", async () => {
    const LARGE_RETRY: UsagePayload = {
      fetchedAt: "2026-08-02T12:05:00Z",
      providers: [{
        id: "claude", name: "Claude", status: "error",
        error: "Rate limited by Anthropic — try again later.",
        hint: "retry-after:86400",   // 24 hours — must be capped
        metrics: [],
      }],
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce(LARGE_RETRY)
      .mockResolvedValueOnce(OK);
    setUsageFetcherForTests(fetcher);

    await getUsageSnapshot();             // 1: OK
    vi.advanceTimersByTime(31_000);       // past force floor
    await getUsageSnapshot(true);         // 2: 429 with retry-after:86400 (capped to 15 min)
    // Within 1 minute: still blocked
    vi.advanceTimersByTime(31_000);
    await getUsageSnapshot(true);
    expect(fetcher).toHaveBeenCalledTimes(2); // still using cache

    // After 15 minutes + force floor: backoff expired, fetcher should fire again
    vi.advanceTimersByTime(15 * 60 * 1000);   // 15 min
    vi.advanceTimersByTime(31_000);            // past force floor
    await getUsageSnapshot(true);             // 3: fetcher called again
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

const OK_HIGH: UsagePayload = {
  fetchedAt: "2026-08-02T12:00:00Z",
  providers: [{
    id: "claude", name: "Claude", status: "ok", plan: "Team 5x",
    metrics: [{ label: "Weekly", type: "percent", used: 95 }],
  }],
};

describe("stale data at high usage — must not show 🔴", () => {
  // Reverse mutation: removing `if (p.stale) return "🟡"` from statusDot makes
  // this test fail because the 95% metric produces 🔴 from the old hottest logic.

  it("stale 95% usage row shows 🟡, not 🔴", async () => {
    const { renderUsageMarkdown } = await import("../src/usage/format-rich.js");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(OK_HIGH)
      .mockResolvedValueOnce(RATE_LIMITED);
    setUsageFetcherForTests(fetcher);

    await getUsageSnapshot();
    const result = await forceAfterFloor();

    const claude = result.providers[0];
    expect(claude.stale).toBe(true);
    expect(claude.metrics[0].used).toBe(95); // high — would be 🔴 without stale check

    const md = renderUsageMarkdown(result);
    expect(md).toContain("🟡");
    expect(md).not.toContain("🔴");
  });
});
