import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchCodexUsage } from "../src/usage/providers.js";
import { formatUsageSummary } from "../src/usage/usage-api.js";
import { renderUsageHtml, renderUsageMarkdown } from "../src/usage/format-rich.js";

describe("Codex usage metric scopes", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "agend-codex-usage-scope-"));
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    process.env.CODEX_HOME = codexHome;
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: ["test", "payload", "value"].join("."), account_id: "account" },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  it("marks only additional per-model limits as model-scoped", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        rate_limit: {
          primary_window: { used_percent: 0, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: 0, limit_window_seconds: 604_800 },
        },
        additional_rate_limits: [{
          limit_name: "GPT-5.3-Codex-Spark",
          rate_limit: {
            primary_window: { used_percent: 0, limit_window_seconds: 18_000 },
            secondary_window: { used_percent: 0, limit_window_seconds: 604_800 },
          },
        }],
        rate_limit_reset_credits: { available_count: 0 },
        credits: { balance: 0 },
      }),
    }));

    const result = await fetchCodexUsage();
    const primary = result.metrics.filter(metric => metric.label === "Session" || metric.label === "Weekly");
    const scoped = result.metrics.filter(metric => metric.label.includes("GPT-5.3-Codex-Spark"));
    expect(primary).toHaveLength(2);
    expect(primary.every(metric => metric.scope === undefined)).toBe(true);
    expect(scoped).toHaveLength(2);
    expect(scoped.every(metric => metric.scope === "model")).toBe(true);
    expect(result.metrics.find(metric => metric.label === "Rate limit resets")?.scope).toBeUndefined();
    expect(result.metrics.find(metric => metric.label === "Credits")?.scope).toBeUndefined();
  });

  /**
   * #936: /usage showed one weekly line and no reserve. The live API sends the
   * reserve as an additional limit named only `gpt-reserve`, with the model it
   * backs in `normal_model_slug` — captured shape below. As a model-scoped
   * limit it was hidden whenever it read 0%.
   */
  function stubReserve(reservePercent: number) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        rate_limit: { secondary_window: { used_percent: 100, limit_window_seconds: 604_800 } },
        additional_rate_limits: [{
          limit_name: "gpt-reserve",
          metered_feature: "base_model_inference",
          normal_model_slug: "gpt-5.6-luna",
          rate_limit: { secondary_window: { used_percent: reservePercent, limit_window_seconds: 604_800 } },
        }],
      }),
    }));
  }

  it("names the reserve after the model it backs, as the Codex TUI does", async () => {
    stubReserve(4);
    const reserve = (await fetchCodexUsage()).metrics.find(m => m.label.startsWith("Luna Reserve"));
    expect(reserve).toMatchObject({ label: "Luna Reserve (weekly)", used: 4, note: "gpt-reserve" });
  });

  it("shows the reserve in every /usage rendering, even at 0%", async () => {
    // 0% is the case that used to vanish: an untouched reserve is the one
    // worth seeing.
    stubReserve(0);
    const result = await fetchCodexUsage();
    const payload = { fetchedAt: new Date().toISOString(), providers: [{ id: "codex", name: "Codex", ...result }] } as never;
    for (const [surface, text] of [
      ["plain", formatUsageSummary(payload)],
      ["Discord", renderUsageMarkdown(payload)],
      ["Telegram", renderUsageHtml(payload)],
    ] as const) {
      expect(text, `${surface} /usage must list the reserve`).toContain("Luna Reserve (weekly)");
      expect(text, `${surface} /usage keeps the raw name findable`).toContain("gpt-reserve");
    }
  });

  it("leaves other additional limits model-scoped and named as before", async () => {
    stubReserve(4);
    const body = { additional_rate_limits: [{ limit_name: "GPT-5.3-Codex-Spark",
      rate_limit: { secondary_window: { used_percent: 0, limit_window_seconds: 604_800 } } }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }));
    const spark = (await fetchCodexUsage()).metrics.find(m => m.label.includes("Spark"));
    expect(spark).toMatchObject({ label: "GPT-5.3-Codex-Spark (weekly)", scope: "model" });
  });

  afterAll(() => {
    rmSync(codexHome, { recursive: true, force: true });
  });
});
