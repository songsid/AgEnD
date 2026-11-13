import { agentUsage } from "../src/usage/agent-output.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { dispatchAgentOperation } from "../src/agent-endpoint.js";
import { GetUsageArgs, GetUsageReportArgs } from "../src/outbound-schemas.js";
import { getUsageSnapshot, setUsageFetcherForTests, formatUsageSummary, type UsagePayload } from "../src/usage/usage-api.js";

const now = Date.parse("2026-11-13T05:00:00Z");
const payload: UsagePayload = { fetchedAt: new Date(now).toISOString(), providers: [{
  id: "codex:work", name: "Codex (work)", profile: "work", status: "ok", plan: "Pro",
  metrics: [
    { label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, type: "percent", used: 78.123456789, resetsAt: "2026-11-14T05:00:00Z", windowMs: 604800000, observedAt: new Date(now).toISOString(), note: "binding", capacity: { status: "ok", median: 123456789.123, line: { text: "100% ≈ 123M tokens", i18n: {} }, notes: [{ text: "Counts only this fleet's agents; use of the same account elsewhere makes this low.", i18n: {} }] } } as any,
    { label: "Rate limit resets", type: "count", value: 3, unit: "available", expiresAt: "2026-12-01T00:00:00Z" },
    { label: "Credits", type: "count", value: 0, unit: "credits", note: "≈ $0.00" },
  ],
} ] };
const ask = (args: Record<string, unknown>) => new Promise<any>(resolve => {
  void outboundHandlers.get("get_usage")!({} as any, args, (result, error) => resolve(error ? { error } : result), { instanceName: "worker", requestId: undefined, fleetRequestId: undefined, senderSessionName: undefined });
});
afterEach(() => { setUsageFetcherForTests(null); vi.useRealTimers(); });

describe("agent-only usage projection", () => {
  it.each([{}, { detail: false }])("default is compact, including resets, binding and counts: %j", async args => {
    vi.useFakeTimers({ now }); setUsageFetcherForTests(async () => structuredClone(payload));
    const result = await ask(args);
    expect(result.providers[0]).toEqual({ name: "Codex (work)", profile: "work", plan: "Pro", windows: ["Weekly 78.1% (reset 1d)", "Rate limit resets 3 available (expires 17d19h)", "Credits 0 credits · ≈ $0.00"], binding: ["Weekly"] });
    expect(result.note).toContain("Counts only this fleet");
    expect(JSON.stringify(result)).not.toMatch(/"(?:labelI18n|windowMs|observedAt|capacity|median|pool)":/);
    expect(await dispatchAgentOperation({} as any, "a", "usage", args)).toEqual(result);
  });
  it("detail returns exactly the full snapshot and preserves the CLI full response", async () => {
    vi.useFakeTimers({ now }); setUsageFetcherForTests(async () => structuredClone(payload));
    const full = await getUsageSnapshot();
    expect(await ask({ detail: true })).toEqual(full);
    expect(await dispatchAgentOperation({} as any, "a", "usage", { detail: true })).toEqual({ formatted: formatUsageSummary(full), ...full });
    expect(full.providers[0]!.metrics[0]).toHaveProperty("capacity.median", 123456789.123);
  });
  it("retains shared snapshot and chat formatter after a compact read", async () => {
    vi.useFakeTimers({ now }); setUsageFetcherForTests(async () => structuredClone(payload));
    await ask({});
    expect(await getUsageSnapshot()).toEqual(payload);
    expect(formatUsageSummary(await getUsageSnapshot())).toContain("Weekly 78%");
  });
  it("keeps stale, reset-passed, unknown, pool, error and unlimited evidence without inventing a number", () => {
    const source: UsagePayload = { fetchedAt: payload.fetchedAt, refreshing: true, providers: [
      { id: "antigravity", name: "Antigravity", status: "ok", stale: true, staleCause: "transient", cachedAt: payload.fetchedAt, metrics: [
        { label: "Weekly", type: "percent", resetPassed: true, pool: { label: "Gemini" }, resetsAt: "2026-11-12T00:00:00Z" },
        { label: "Weekly", type: "percent", pool: { label: "Claude" } },
        { label: "Bonus", type: "dollars", used: 1.25, limit: 5, resetsAt: "2026-11-14T05:00:00Z", resetKind: "expiry" },
      ] },
      { id: "codex", name: "Codex", status: "error", error: "sign in again", hint: "sign in again", metrics: [] },
      { id: "grok", name: "Grok", status: "ok", unlimited: true, metrics: [] },
    ] };
    const result = agentUsage(source, false, now);
    expect(result).toMatchObject({ refreshing: true, providers: [
      { status: `stale (transient); cached ${payload.fetchedAt}`, windows: ["Gemini / Weekly unknown (previous window reset) (reset due)", "Claude / Weekly unknown", "Bonus $1.25/$5.00 (expires 1d)"] },
      { status: "error; sign in again", windows: [] }, { unlimited: true, windows: [] },
    ] });
    expect(result.providers[0]).not.toHaveProperty("binding");
    expect(source.providers[0]!.metrics[0]).toHaveProperty("pool.label", "Gemini");
  });
  it("does not drop fractional quota, overage, zero counts or malformed reset evidence", () => {
    const p = structuredClone(payload); p.providers[0]!.metrics = [
      { label: "Session", type: "percent", used: 105.123, resetsAt: "bad" },
      { label: "Tickets", type: "count", value: 0, expiresAt: "2026-11-12T00:00:00Z" },
    ];
    expect(agentUsage(p, false, now).providers[0]).toHaveProperty("windows", ["Session 105.1% (reset unknown)", "Tickets 0 (expired)"]);
  });
  it("detail is boolean on both MCP schemas", () => {
    for (const schema of [GetUsageArgs, GetUsageReportArgs]) {
      expect(schema.safeParse({ detail: true }).success).toBe(true);
      expect(schema.safeParse({ detail: "true" }).success).toBe(false);
    }
  });
});
