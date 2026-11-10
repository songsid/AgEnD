/**
 * M-2815: the Claude cards carry the per-model weekly again ("Fable (weekly)") even at 0%, and the card no longer
 * shows the measured capacity footnote (it stays in get_usage and the report).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderUsageMarkdown } from "../src/usage/format-rich.js";
import { formatUsageSummary, getUsageSnapshot, isVisibleUsageMetric, setUsageFetcherForTests, type UsagePayload } from "../src/usage/usage-api.js";
import type { ProviderUsage, UsageMetric } from "../src/usage/providers.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const WEEK = 7 * 24 * 3_600_000;
const fable: UsageMetric = { label: "Fable (weekly)", labelI18n: { key: "usage.metric.named_weekly", args: ["Fable"] }, scope: "model", type: "percent", used: 0, windowMs: WEEK };
const spark: UsageMetric = { label: "GPT-5.3-Codex-Spark", scope: "model", type: "percent", used: 0 };
const weekly: UsageMetric = { label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, type: "percent", used: 35, windowMs: WEEK };
const rows = (): ProviderUsage[] => [
  { id: "claude", name: "Claude (default)", status: "ok", metrics: [weekly, fable] },
  { id: "claude:Han2", name: "Claude (Han2)", profile: "Han2", status: "ok", metrics: [weekly, fable] },
  { id: "codex", name: "Codex", status: "ok", metrics: [weekly, spark] },
];

afterEach(() => setUsageFetcherForTests(null));

describe("M-2815: Claude's per-model weekly is shown at 0%", () => {
  it("the snapshot (web card, get_usage) keeps a Claude row's Fable (weekly) at 0%, for every profile", async () => {
    setUsageFetcherForTests(async () => ({ fetchedAt: "2026-11-10T00:00:00.000Z", providers: rows() }));
    const snap = await getUsageSnapshot();
    const labels = (id: string) => snap.providers.find((p) => p.id === id)!.metrics.map((m) => m.label);
    expect(labels("claude")).toEqual(["Weekly", "Fable (weekly)"]);
    expect(labels("claude:Han2")).toEqual(["Weekly", "Fable (weekly)"]);
    // The 09-02 trim still holds for another vendor's unused per-model quota.
    expect(labels("codex")).toEqual(["Weekly"]);
  });

  it("chat /usage and the plain summary say it too", () => {
    const payload: UsagePayload = { fetchedAt: new Date().toISOString(), providers: rows() };
    for (const text of [renderUsageMarkdown(payload), formatUsageSummary(payload)]) {
      expect(text).toMatch(/Fable \(weekly\)/);
      expect(text).not.toContain("GPT-5.3-Codex-Spark");
    }
  });

  it("the rule by row: Claude keeps it, another vendor or an unnamed caller does not", () => {
    expect(isVisibleUsageMetric(fable, { id: "claude" })).toBe(true);
    expect(isVisibleUsageMetric(fable, { id: "claude:jefflin" })).toBe(true);
    expect(isVisibleUsageMetric(spark, { id: "codex" })).toBe(false);
    expect(isVisibleUsageMetric(fable, { id: "claudette" })).toBe(false);
    expect(isVisibleUsageMetric(fable)).toBe(false);
  });
});

describe("M-2815: the card drops the capacity footnote", () => {
  let p: AppPage, D: any;
  beforeAll(async () => { p = page({ url: "http://127.0.0.1:19280/ui/fleet" }); D = await import("/assets/usage-dialog.js"); });
  afterAll(() => p.restore());
  const capacity = { status: "ok",
    line: { text: "100% ≈ 4.2B tokens (3.6B–4.9B) · from 2 weeks", i18n: { key: "usage.capacity.line_tokens", args: ["4.2B", "3.6B", "4.9B", 2] } },
    notes: [{ text: "Counts only this fleet's agents; use of the same account elsewhere makes this low.", i18n: { key: "usage.capacity.only_agend", args: [] } }] };
  it("a weekly bar that carries capacity shows the bar and its reset, never the 100% line or the fleet-only note", async () => {
    await p.mount(h(D.UsageMetric, { m: { ...weekly, capacity } })); await settle(2);
    expect(p.root.querySelector(".u-meter")).not.toBeNull();
    expect(p.root.querySelector(".u-cap")).toBeNull();
    expect(p.root.textContent).not.toContain("100% ≈");
    expect(p.root.textContent).not.toContain("this fleet's agents");
    await p.unmount();
  });
});
