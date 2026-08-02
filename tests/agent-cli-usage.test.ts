import { describe, expect, it, vi, afterEach } from "vitest";
import { dispatchAgentOperation } from "../src/agent-endpoint.js";
import { setUsageFetcherForTests, type UsagePayload } from "../src/usage/usage-api.js";

/**
 * `agend-agent usage` — the CLI-mode counterpart of the get_usage MCP tool, for
 * backends (agy) that talk to the fleet over HTTP instead of MCP. Same snapshot,
 * same cache; the response carries a pre-rendered `formatted` block so the CLI
 * prints something readable without owning the formatting.
 */

const PAYLOAD: UsagePayload = {
  fetchedAt: "2026-08-02T12:00:00Z",
  providers: [
    {
      id: "claude", name: "Claude", status: "ok", plan: "Team 5x",
      metrics: [{ label: "Weekly", type: "percent", used: 15 }],
    },
    { id: "codex", name: "Codex", status: "no-credentials", hint: "log in", metrics: [] },
  ],
};

afterEach(() => setUsageFetcherForTests(null));

describe("agend-agent usage", () => {
  it("returns the shared snapshot with a readable formatted block", async () => {
    setUsageFetcherForTests(vi.fn().mockResolvedValue(PAYLOAD));

    const result = await dispatchAgentOperation({} as never, "alpha", "usage", {}) as {
      formatted: string; providers: UsagePayload["providers"];
    };

    // The formatted block is what the CLI prints to stdout.
    expect(result.formatted).toContain("AI subscription usage");
    expect(result.formatted).toContain("Claude (Team 5x): Weekly 15%");
    // The raw payload rides along for callers that want structure.
    expect(result.providers[0].metrics[0].used).toBe(15);
  });

  it("goes through the shared cache — a second call does not re-fetch", async () => {
    const fetcher = vi.fn().mockResolvedValue(PAYLOAD);
    setUsageFetcherForTests(fetcher);

    await dispatchAgentOperation({} as never, "alpha", "usage", {});
    await dispatchAgentOperation({} as never, "alpha", "usage", {});

    // The 5-minute cache protects vendor rate limits; a CLI entry point that
    // bypassed it would defeat that (same rule as slash and MCP).
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
