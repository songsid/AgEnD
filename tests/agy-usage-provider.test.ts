import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { agyPoolMetrics, agyQuotaBuckets, readAgyToken } from "../src/usage/providers.js";

const grouped = JSON.parse(readFileSync(new URL("./fixtures/agy-quota-summary-grouped-2026-10.json", import.meta.url), "utf8"));

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
    expect(metrics).toMatchObject([
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
    expect(metrics).toMatchObject([
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

describe("agy grouped quota summary (#1898)", () => {
  it("shows Gemini and Claude & others, session and weekly, when only the Claude group keeps the pooled ids", () => {
    const metrics = agyPoolMetrics(agyQuotaBuckets(grouped));
    expect(metrics.map(m => m.label)).toEqual([
      "Gemini (session)", "Gemini (weekly)", "Claude & others (session)", "Claude & others (weekly)",
    ]);
    expect(metrics[0]).toMatchObject({ used: expect.closeTo(4.15, 2), resetsAt: "2026-10-16T04:21:00Z" });
    expect(metrics[1]).toMatchObject({ used: expect.closeTo(1.82, 2), resetsAt: "2026-10-23T03:00:00Z" });
    expect(metrics[2]).toMatchObject({ used: 0 });
    expect(metrics[0].note).toBeUndefined(); // one bucket per limit: no "busiest of" note
  });

  it("takes the pool from the group and the limit from the bucket when no id is a known one", () => {
    const body = structuredClone(grouped);
    body.groups[1].buckets = [
      { bucketId: "q1", displayName: "Weekly Limit", remainingFraction: 0.5 },
      { bucketId: "q2", displayName: "Five Hour Limit", remainingFraction: 0.25 },
    ];
    body.groups[0].buckets = [{ bucketId: "q3", window: "5h", remainingFraction: 0.9 }];
    expect(agyPoolMetrics(agyQuotaBuckets(body)).map(m => [m.label, Math.round(m.used!)])).toEqual([
      ["Gemini (session)", 10], ["Claude & others (session)", 75], ["Claude & others (weekly)", 50],
    ]);
  });

  it("leaves disabled buckets out and uses the deprecated top-level list only without grouped buckets", () => {
    const body = structuredClone(grouped);
    body.groups[0].buckets[0].disabled = true;
    expect(agyPoolMetrics(agyQuotaBuckets(body)).map(m => m.label)).not.toContain("Gemini (weekly)");
    expect(agyQuotaBuckets({ groups: [], buckets: [{ bucketId: "gemini-5h", remainingFraction: 1 }] })).toHaveLength(1);
    expect(agyQuotaBuckets({ ...grouped, buckets: [{ bucketId: "gemini-5h", remainingFraction: 1 }] })).toHaveLength(4);
  });

  it("never lets the Claude group's pooled ids hide a Gemini group of per-model buckets", () => {
    const body = structuredClone(grouped);
    body.groups[0].buckets = [
      { bucketId: "gemini-3.6-flash", remainingFraction: 0.7 },
      { bucketId: "gemini-3.1-pro", remainingFraction: 0.4 },
    ];
    expect(agyPoolMetrics(agyQuotaBuckets(body))).toMatchObject([
      { label: "Gemini", used: expect.closeTo(60, 5), note: "busiest of 2 models" },
      { label: "Claude & others (session)" }, { label: "Claude & others (weekly)" },
    ]);
  });

  // Prism's witnesses on r1 (synthetic; the live ids and window values are not known).
  it.each(["5-hour", "5_hour", "5 hours", "5h"])("reads a five-hour limit written %j next to the weekly one", (form) => {
    const metrics = agyPoolMetrics(agyQuotaBuckets({ groups: [{ displayName: "Gemini Models", buckets: [
      { bucketId: "q-a", window: form, displayName: `${form} limit`, remainingFraction: 0.25 },
      { bucketId: "q-b", window: "weekly", displayName: "Weekly Limit", remainingFraction: 0.75 },
    ] }] }));
    expect(metrics.map(m => [m.label, m.used])).toEqual([["Gemini (session)", 75], ["Gemini (weekly)", 25]]);
  });

  it("reads the five-hour limit from the display name alone when window and id say nothing", () => {
    const metrics = agyPoolMetrics(agyQuotaBuckets({ groups: [{ displayName: "Gemini Models", buckets: [
      { bucketId: "q-a", displayName: "5-hour limit", remainingFraction: 0.25 },
      { bucketId: "q-b", displayName: "Weekly Limit", remainingFraction: 0.75 },
    ] }] }));
    expect(metrics.map(m => m.label)).toEqual(["Gemini (session)", "Gemini (weekly)"]);
  });

  it("a bucket's stated window wins over a word in an opaque id", () => {
    const metrics = agyPoolMetrics(agyQuotaBuckets({ groups: [{ displayName: "Gemini Models", buckets: [
      { bucketId: "opaque-session-quota", window: "WEEKLY", displayName: "Weekly Limit", remainingFraction: 0.75 },
      { bucketId: "q-a", window: "5h", displayName: "Five Hour Limit", remainingFraction: 0.25 },
    ] }] }));
    expect(metrics.map(m => [m.label, m.used, m.note])).toEqual([["Gemini (session)", 75, undefined], ["Gemini (weekly)", 25, undefined]]);
  });

  it("a per-model id or name with a 5 or 7 in it is no limit", () => {
    const metrics = agyPoolMetrics([
      { bucketId: "gemini-2.5-high", displayName: "Gemini 2.5 High", remainingFraction: 0.5 },
      { bucketId: "claude-opus-4-5-haiku", remainingFraction: 0.5 },
      { bucketId: "gpt-5-high", remainingFraction: 0.5 },
      { bucketId: "gemini-2.5h-preview", remainingFraction: 0.5 },   // 2.5 h, 15 h: not a five-hour limit
      { bucketId: "claude-15h", remainingFraction: 0.5 },
    ]);
    expect(metrics.map(m => m.label)).toEqual(["Gemini", "Claude & others"]);
  });

  it("names an unknown group by its own display name", () => {
    const metrics = agyPoolMetrics(agyQuotaBuckets({ groups: [{ displayName: "Imagen", buckets: [{ bucketId: "x", window: "weekly", remainingFraction: 0.5 }] }] }));
    expect(metrics).toMatchObject([{ label: "Imagen (weekly)", used: 50 }]);
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
