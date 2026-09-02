import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchCodexUsage } from "../src/usage/providers.js";

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

  afterAll(() => {
    rmSync(codexHome, { recursive: true, force: true });
  });
});
