import { describe, expect, it } from "vitest";
import { agyPoolMetrics, readAgyToken } from "../src/usage/providers.js";

/**
 * Antigravity quota pooling. Two payload shapes exist for
 * `retrieveUserQuotaSummary`; both were seen in the wild:
 * - pooled bucket ids (gemini-5h / 3p-weekly …) — OpenUsage's documented shape
 * - per-model buckets (gemini-3.6-flash-high, claude-sonnet-4-6, …) — what this
 *   machine's live account returned on 2026-08-02
 */

describe("agyPoolMetrics", () => {
  it("maps pooled bucket ids directly", () => {
    const metrics = agyPoolMetrics([
      { bucketId: "gemini-5h", remainingFraction: 0.66, resetTime: "2026-08-02T10:00:00Z" },
      { bucketId: "3p-weekly", remainingFraction: 0.9, resetTime: "2026-08-08T10:00:00Z" },
    ]);
    expect(metrics).toEqual([
      { label: "Gemini (session)", type: "percent", used: expect.closeTo(34, 5), resetsAt: "2026-08-02T10:00:00Z" },
      { label: "Claude & others (weekly)", type: "percent", used: expect.closeTo(10, 5), resetsAt: "2026-08-08T10:00:00Z" },
    ]);
  });

  it("aggregates per-model buckets into two pools, keeping the worst fraction", () => {
    // Verbatim ids from the live 2026-08-02 response (fractions varied for the test).
    const metrics = agyPoolMetrics([
      { bucketId: "gemini-3.6-flash-high", remainingFraction: 1, resetTime: "2026-08-08T16:12:24Z" },
      { bucketId: "gemini-3.1-pro-low", remainingFraction: 0.4, resetTime: "2026-08-08T16:12:24Z" },
      { bucketId: "claude-sonnet-4-6", remainingFraction: 0.75, resetTime: "2026-08-08T16:12:24Z" },
      { bucketId: "gpt-oss-120b-medium", remainingFraction: 0.5, resetTime: "2026-08-08T16:12:24Z" },
    ]);

    // The binding constraint is the model that runs out first — eleven per-model
    // meters would be noise; the worst per pool is the honest single number.
    expect(metrics).toEqual([
      { label: "Gemini", type: "percent", used: expect.closeTo(60, 5), resetsAt: "2026-08-08T16:12:24Z", note: "busiest of 2 models" },
      { label: "Claude & others", type: "percent", used: expect.closeTo(50, 5), resetsAt: "2026-08-08T16:12:24Z", note: "busiest of 2 models" },
    ]);
  });

  it("drops buckets without a usable fraction instead of fabricating 0% or 100%", () => {
    const metrics = agyPoolMetrics([
      { bucketId: "gemini-3.6-flash-high" },                       // no fraction
      { bucketId: "claude-sonnet-4-6", remainingFraction: NaN },   // unusable
      { displayName: "no id", remainingFraction: 0.5 },            // no bucket id
    ]);
    expect(metrics).toEqual([]);
  });

  it("prefers pooled ids over per-model aggregation when both appear", () => {
    const metrics = agyPoolMetrics([
      { bucketId: "gemini-weekly", remainingFraction: 0.8, resetTime: null as unknown as string },
      { bucketId: "gemini-3.6-flash-high", remainingFraction: 0.1 },
    ]);
    // The pooled id is the authoritative merged number; a per-model bucket must
    // not out-vote it.
    expect(metrics).toHaveLength(1);
    expect(metrics[0].label).toBe("Gemini (weekly)");
  });
});

describe("readAgyToken", () => {
  it("reads the nested shape this machine writes", () => {
    // { token: {...}, id_token, auth_method } — the shape agy actually stores.
    expect(readAgyToken({
      token: { access_token: "ya29.a", refresh_token: "1//r", expiry: "2026-08-02T10:00:00Z" },
      id_token: "eyJ", auth_method: "consumer",
    })).toEqual({ access_token: "ya29.a", refresh_token: "1//r", expiry: "2026-08-02T10:00:00Z" });
  });

  it("reads a flat shape too", () => {
    expect(readAgyToken({ access_token: "ya29.b", refresh_token: "1//s", expiry: "x" }))
      .toMatchObject({ access_token: "ya29.b", refresh_token: "1//s" });
  });

  it("falls back to the outer object when `token` holds no credentials", () => {
    // A nested key that is present but useless must not shadow a flat token.
    expect(readAgyToken({ token: { expiry: "x" }, access_token: "ya29.c" }))
      .toMatchObject({ access_token: "ya29.c" });
  });

  it("survives junk without throwing", () => {
    expect(readAgyToken(null)).toEqual({});
    expect(readAgyToken({})).toEqual({});
  });
});
